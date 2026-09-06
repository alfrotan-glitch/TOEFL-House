<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Period-window invariants (PHASE_2, part two) — enforced at the
 * authoritative database boundary so a direct SQL INSERT (bypassing the
 * application) can never write into a period that is no longer open:
 *
 *   (1) an obligation posted into a CLOSED financial period
 *       (finance.period_not_open — fabricates a liability after closure);
 *   (2) a journal posted into a CLOSED financial period (fabricated
 *       accounting entries inside a closed period; the 000102 guards
 *       balance journals, they do not gate the window);
 *   (3) a payment recorded into a CLOSED financial period (fabricated
 *       receipts inside a closed period);
 *   (4) a refund recorded into a CLOSED financial period;
 *   (5) a discount attached into a CLOSED financial period;
 *   (6) a payroll calculation prepared into a payroll period that is not
 *       open or calculating (CalculatePayroll::prepare rejects otherwise);
 *   (7) a payroll calculation SNAPSHOT rewritten — period, employment,
 *       base amount, snapshot, held reason and preparer are write-once;
 *       only the lifecycle state may change. A forged base amount here is
 *       a forged payable: the 000103 derivation guard accepts any result
 *       whose amount equals the calculation's base amount.
 *
 * The existing immutability triggers on obligations/journals/payments/
 * refunds protect UPDATE/DELETE; the window is the missing half of the
 * same invariant. These constraints mirror — not replace — the domain
 * commands (PostObligation, PostJournal, RecordPayment, RefundPayment,
 * MaintainDiscount, CalculatePayroll), which remain the single
 * authoritative implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION assert_financial_period_open(period_id text, what text) RETURNS void AS $fn$
            DECLARE
                period_state text;
            BEGIN
                SELECT fp.lifecycle_state INTO period_state
                  FROM financial_periods fp
                 WHERE fp.id = period_id
                 FOR UPDATE;

                IF period_state IS NULL THEN
                    RAISE EXCEPTION 'the % references a missing financial period %', what, period_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF period_state <> 'open' THEN
                    RAISE EXCEPTION '% requires an open financial period (period % is %)', what, period_id, period_state
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        foreach ([
            'obligations' => 'a new obligation',
            'journals' => 'a new journal',
            'payments' => 'a new payment',
            'refunds' => 'a new refund',
            'discounts' => 'a new discount',
        ] as $table => $what) {
            $whatEscaped = str_replace("'", "''", $what);
            DB::statement(<<<SQL
                CREATE OR REPLACE FUNCTION {$table}_period_window_guard() RETURNS trigger AS \$fn\$
                BEGIN
                    PERFORM assert_financial_period_open(NEW.period_id, '{$whatEscaped}');
                    RETURN NEW;
                END;
                \$fn\$ LANGUAGE plpgsql;
                SQL);
            DB::statement("DROP TRIGGER IF EXISTS {$table}_period_window_trigger ON {$table}");
            DB::statement("CREATE TRIGGER {$table}_period_window_trigger BEFORE INSERT ON {$table} FOR EACH ROW EXECUTE FUNCTION {$table}_period_window_guard()");
        }

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_calculations_period_window_guard() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
            BEGIN
                SELECT pp.lifecycle_state INTO period_state
                  FROM payroll_periods pp
                 WHERE pp.id = NEW.period_id
                 FOR UPDATE;

                IF period_state IS NULL THEN
                    RAISE EXCEPTION 'a new payroll calculation references a missing payroll period %', NEW.period_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF period_state NOT IN ('open', 'calculating') THEN
                    RAISE EXCEPTION 'a payroll calculation requires an open or calculating payroll period (period % is %)', NEW.period_id, period_state
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_period_window_trigger ON payroll_calculations');
        DB::statement('CREATE TRIGGER payroll_calculations_period_window_trigger BEFORE INSERT ON payroll_calculations FOR EACH ROW EXECUTE FUNCTION payroll_calculations_period_window_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_calculations_snapshot_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.employment_id IS DISTINCT FROM NEW.employment_id
                   OR OLD.base_amount IS DISTINCT FROM NEW.base_amount
                   OR OLD.snapshot IS DISTINCT FROM NEW.snapshot
                   OR OLD.held_reason IS DISTINCT FROM NEW.held_reason
                   OR OLD.prepared_by IS DISTINCT FROM NEW.prepared_by THEN
                    RAISE EXCEPTION 'a payroll calculation snapshot is write-once (period, employment, base amount, snapshot, held reason and preparer never change); only its lifecycle state may change'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_snapshot_trigger ON payroll_calculations');
        DB::statement('CREATE TRIGGER payroll_calculations_snapshot_trigger BEFORE UPDATE ON payroll_calculations FOR EACH ROW EXECUTE FUNCTION payroll_calculations_snapshot_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_snapshot_trigger ON payroll_calculations');
        DB::statement('DROP FUNCTION IF EXISTS payroll_calculations_snapshot_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_period_window_trigger ON payroll_calculations');
        DB::statement('DROP FUNCTION IF EXISTS payroll_calculations_period_window_guard()');

        foreach (['discounts', 'refunds', 'payments', 'journals', 'obligations'] as $table) {
            DB::statement("DROP TRIGGER IF EXISTS {$table}_period_window_trigger ON {$table}");
            DB::statement("DROP FUNCTION IF EXISTS {$table}_period_window_guard()");
        }
        DB::statement('DROP FUNCTION IF EXISTS assert_financial_period_open(text, text)');
    }
};
