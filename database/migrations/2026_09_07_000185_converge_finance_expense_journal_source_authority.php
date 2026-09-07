<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Finance expense journal-source authority.
 *
 * An approved Expense is a Finance source fact. Its accounting entry must be
 * journalized through PostJournal with source_type 'expense', source-linked to
 * that immutable expense, and each expense may be journalized exactly once.
 * This mirrors the payroll-liability rule and closes the gap where an expense
 * could only be entered as an ad-hoc 'other' journal (no source authority).
 *
 * Entry is one-way to preserve the source-authority invariant; rollback would
 * weaken accounting history rather than restore it.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE journals DROP CONSTRAINT IF EXISTS journals_source_type_check');
        DB::statement("ALTER TABLE journals ADD CONSTRAINT journals_source_type_check CHECK (source_type IN ('obligation','payroll_result','payroll_liability','expense','journal','other'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_finance_source_guard() RETURNS trigger AS $fn$
            BEGIN
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
                ELSIF NEW.source_type = 'expense' THEN
                    IF NEW.source_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM expenses WHERE id = NEW.source_id AND lifecycle_state = 'approved') THEN
                        RAISE EXCEPTION 'an expense journal requires an existing approved expense source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS journals_finance_source_guard_trigger ON journals');
        DB::statement('CREATE TRIGGER journals_finance_source_guard_trigger BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION journals_finance_source_guard()');

        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX journals_one_disbursement_per_expense
                ON journals (source_id)
                WHERE source_type = 'expense' AND source_id IS NOT NULL
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
                ELSIF NEW.source_type = 'expense' THEN
                    SELECT amount INTO liability_amount
                      FROM expenses
                     WHERE id = NEW.source_id AND lifecycle_state = 'approved';
                    IF liability_amount IS NULL THEN
                        RAISE EXCEPTION 'an expense journal requires an existing approved expense source'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF total_debit <> liability_amount OR total_credit <> liability_amount THEN
                        RAISE EXCEPTION 'an expense journal must equal the approved expense amount'
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
        throw new \RuntimeException('Finance expense journal-source authority is one-way; restore from a reviewed pre-convergence baseline rather than weakening accounting history.');
    }
};
