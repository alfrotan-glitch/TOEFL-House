<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Finance journal-source convergence.
 *
 * Payroll produces calculation/result evidence, while Finance recognizes the
 * monetary liability. Older journal code could source a balanced payment
 * directly from `payroll_results`, bypassing the recognized Finance fact and
 * its independent-recognition/provenance controls. A journal row could also
 * be inserted with no lines because the old deferred balance trigger existed
 * only on `journal_lines`.
 *
 * Preserve historical payroll_result journals, but prohibit new ones and make
 * the Finance payroll-liability fact the only new payroll disbursement source.
 * The deferred journal guard sees the completed transaction, so commands can
 * create a header and its lines atomically while raw DML cannot commit an
 * orphan, a wrong-amount payroll disbursement, or a non-inverse reversal.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE journals DROP CONSTRAINT IF EXISTS journals_source_type_check');
        DB::statement("ALTER TABLE journals ADD CONSTRAINT journals_source_type_check CHECK (source_type IN ('obligation','payroll_result','payroll_liability','journal','other'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_finance_source_guard() RETURNS trigger AS $fn$
            BEGIN
                -- Existing rows are immutable historical records. New payroll
                -- settlements must begin from Finance recognition, never from
                -- Payroll calculation/result evidence directly.
                IF NEW.source_type = 'payroll_result' THEN
                    RAISE EXCEPTION 'new payroll disbursement journals must reference a Finance payroll liability fact, not a Payroll result directly'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.source_type = 'payroll_liability' THEN
                    IF NEW.source_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM payroll_liability_facts WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'a payroll liability journal requires an existing Finance payroll liability fact'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                ELSIF NEW.source_type = 'obligation' THEN
                    IF NEW.source_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM obligations WHERE id = NEW.source_id) THEN
                        RAISE EXCEPTION 'an obligation journal requires an existing obligation source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS journals_finance_source_guard_trigger ON journals');
        DB::statement('CREATE TRIGGER journals_finance_source_guard_trigger BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION journals_finance_source_guard()');

        // This index is deliberately separate from the historical
        // payroll-result index in 000120. The old source remains indexed for
        // audit continuity; new Finance-owned liability facts gain their own
        // concurrency-safe one-disbursement invariant.
        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX journals_one_disbursement_per_payroll_liability
                ON journals (source_id)
                WHERE source_type = 'payroll_liability' AND source_id IS NOT NULL
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_completion_and_source_amount_guard() RETURNS trigger AS $fn$
            DECLARE
                line_count bigint;
                total_debit numeric;
                total_credit numeric;
                liability_amount numeric;
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
                    SELECT amount INTO liability_amount
                      FROM payroll_liability_facts
                     WHERE id = NEW.source_id;
                    IF liability_amount IS NULL THEN
                        RAISE EXCEPTION 'a payroll liability journal requires an existing Finance payroll liability fact'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF total_debit <> abs(liability_amount) OR total_credit <> abs(liability_amount) THEN
                        RAISE EXCEPTION 'a payroll liability journal must equal the absolute amount of its Finance liability fact'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.reversal_of_id IS NOT NULL THEN
                    -- Historic data can contain an orphan header created
                    -- before this convergence. A reversal is never allowed to
                    -- turn such a header into apparent accounting history.
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
        // A down migration would have to either delete Finance-owned payroll
        // liability journals or reintroduce direct Payroll-result authority.
        // Neither is a safe rollback of accounting history.
        throw new \RuntimeException('Finance journal-source convergence is one-way; restore from a reviewed pre-convergence baseline rather than weakening or deleting accounting history.');
    }
};
