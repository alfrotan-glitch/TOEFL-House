<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Authoritative general ledger.
 *
 * The student accounts-receivable subledger (obligations, discounts,
 * payments, refunds, fund allocations) and the payroll/expense payables are
 * operational detail records. Accounting truth lives in the double-entry
 * journal: every money fact is now journalized automatically and exactly
 * once, and its posting is anchored to the source fact's organization so the
 * ledger is tenant-isolated and directly reportable.
 *
 * This is the journal-source authority for the cash/AR money facts that were
 * previously subledger-only (no GL). It is one-way: restoring an older state
 * would strip accounting history, so it is not rolled back.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('journals', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable()->after('period_id');
            $table->foreign('organization_id')->references('id')->on('organizations');
        });

        DB::statement('ALTER TABLE journals DROP CONSTRAINT IF EXISTS journals_source_type_check');
        DB::statement("ALTER TABLE journals ADD CONSTRAINT journals_source_type_check CHECK (source_type IN ('obligation','payroll_result','payroll_liability','expense','payment','discount','refund','fund_allocation','journal','other'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_finance_source_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.source_type = 'payroll_result' THEN
                    RAISE EXCEPTION 'new payroll disbursement journals must reference a Finance payroll liability fact, not a Payroll result directly'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.source_type = 'payroll_liability' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM payroll_liability_facts WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'a payroll liability journal requires an existing Finance payroll liability fact'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'obligation' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM obligations WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'an obligation journal requires an existing obligation source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'expense' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM expenses WHERE id = NEW.source_id AND lifecycle_state = 'approved') THEN
                        RAISE EXCEPTION 'an expense journal requires an existing approved expense source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'payment' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM payments WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'a payment journal requires an existing payment source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'discount' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM discounts WHERE id = NEW.source_id AND lifecycle_state = 'approved') THEN
                        RAISE EXCEPTION 'a discount journal requires an existing approved discount source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'refund' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM refunds WHERE id = NEW.source_id AND lifecycle_state = 'recorded') THEN
                        RAISE EXCEPTION 'a refund journal requires an existing recorded refund source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'fund_allocation' THEN
                    IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM fund_allocations WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'a fund allocation journal requires an existing fund allocation source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS journals_finance_source_guard_trigger ON journals');
        DB::statement('CREATE TRIGGER journals_finance_source_guard_trigger BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION journals_finance_source_guard()');

        // Exactly-once posting per source fact. Obligation joins the existing
        // one-per-fact invariants previously defined only for payroll liability
        // and expense; the cash/AR facts gain their own.
        foreach ([
            'obligation' => 'journals_one_per_obligation',
            'payment' => 'journals_one_per_payment',
            'discount' => 'journals_one_per_discount',
            'refund' => 'journals_one_per_refund',
            'fund_allocation' => 'journals_one_per_fund_allocation',
        ] as $sourceType => $indexName) {
            DB::statement("DROP INDEX IF EXISTS {$indexName}");
            DB::statement("CREATE UNIQUE INDEX {$indexName} ON journals (source_id) WHERE source_type = '{$sourceType}' AND source_id IS NOT NULL");
        }

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_completion_and_source_amount_guard() RETURNS trigger AS $fn$
            DECLARE
                line_count bigint;
                total_debit numeric;
                total_credit numeric;
                source_amount numeric;
                original_line_count bigint;
            BEGIN
                SELECT COUNT(*),
                       COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'debit'), 0),
                       COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'credit'), 0)
                  INTO line_count, total_debit, total_credit
                  FROM journal_lines jl
                 WHERE jl.journal_id = NEW.id;

                IF line_count = 0 THEN
                    RAISE EXCEPTION 'journal % has no lines', NEW.id
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.source_type = 'payroll_liability' THEN
                    SELECT amount INTO source_amount FROM payroll_liability_facts WHERE id = NEW.source_id;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'a payroll liability journal requires an existing Finance payroll liability fact'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    source_amount := abs(source_amount);
                ELSIF NEW.source_type = 'obligation' THEN
                    SELECT original_amount INTO source_amount FROM obligations WHERE id = NEW.source_id;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'an obligation journal requires an existing obligation source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'expense' THEN
                    SELECT amount INTO source_amount FROM expenses WHERE id = NEW.source_id AND lifecycle_state = 'approved';
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'an expense journal requires an existing approved expense source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'payment' THEN
                    SELECT amount INTO source_amount FROM payments WHERE id = NEW.source_id;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'a payment journal requires an existing payment source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'discount' THEN
                    SELECT amount INTO source_amount FROM discounts WHERE id = NEW.source_id AND lifecycle_state = 'approved';
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'a discount journal requires an existing approved discount source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'refund' THEN
                    SELECT amount INTO source_amount FROM refunds WHERE id = NEW.source_id AND lifecycle_state = 'recorded';
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'a refund journal requires an existing recorded refund source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'fund_allocation' THEN
                    SELECT amount INTO source_amount FROM fund_allocations WHERE id = NEW.source_id;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'a fund allocation journal requires an existing fund allocation source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                END IF;

                IF source_amount IS NOT NULL THEN
                    IF total_debit <> source_amount OR total_credit <> source_amount THEN
                        RAISE EXCEPTION 'a % journal must equal the amount of its source fact (debit %, credit %, source %)',
                            NEW.source_type, total_debit, total_credit, source_amount
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.reversal_of_id IS NOT NULL THEN
                    SELECT COUNT(*) INTO original_line_count
                      FROM journal_lines
                     WHERE journal_id = NEW.reversal_of_id;
                    IF original_line_count = 0 THEN
                        RAISE EXCEPTION 'a reversal journal requires an original journal with complete lines'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF EXISTS (
                        WITH expected AS (
                            SELECT jl.account_id,
                                   CASE jl.direction WHEN 'debit' THEN 'credit' ELSE 'debit' END AS direction,
                                   SUM(jl.amount) AS amount
                              FROM journal_lines jl
                             WHERE jl.journal_id = NEW.reversal_of_id
                             GROUP BY jl.account_id, jl.direction
                        ), actual AS (
                            SELECT jl.account_id,
                                   jl.direction,
                                   SUM(jl.amount) AS amount
                              FROM journal_lines jl
                             WHERE jl.journal_id = NEW.id
                             GROUP BY jl.account_id, jl.direction
                        )
                        SELECT 1
                          FROM expected e
                          FULL OUTER JOIN actual a
                            ON a.account_id = e.account_id
                           AND a.direction = e.direction
                         WHERE e.account_id IS NULL
                            OR a.account_id IS NULL
                            OR e.amount <> a.amount
                    ) THEN
                        RAISE EXCEPTION 'a reversal journal must be an exact inverse of its original journal lines'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS journals_completion_and_source_amount_guard_trigger ON journals');
        DB::statement(<<<'SQL'
            CREATE CONSTRAINT TRIGGER journals_completion_and_source_amount_guard_trigger
                AFTER INSERT ON journals
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION journals_completion_and_source_amount_guard()
            SQL);
    }

    public function down(): void
    {
        // One-way convergence: removing source types or their exactly-once
        // indexes would allow a money fact to be re-posted or to exist without
        // an accounting entry. Restore from a reviewed pre-convergence baseline.
        throw new \RuntimeException('Authoritative general-ledger convergence is one-way; restore from a reviewed pre-convergence baseline rather than weakening accounting history.');
    }
};
