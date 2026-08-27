<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level accounting guards (Finance) — the remaining BR-FIN invariants
 * enforced at the authoritative database boundary so a direct SQL INSERT
 * (bypassing the application) can never corrupt the books:
 *
 *   (1) fund_allocations: a fund allocation can never exceed the fund's
 *       unutilized pool, the obligation line's uncovered remainder, the
 *       obligation's uncovered remainder, or the fund's category
 *       restriction.
 *   (2) journal_lines: every journal balances exactly — total debits equal
 *       total credits and at least one line exists. Enforced as a DEFERRABLE
 *       INITIALLY DEFERRED constraint trigger: a journal is built from
 *       several lines inserted in one transaction, so the balance is only
 *       checkable at commit (the app's real transactions and plain
 *       autocommit statements both fire it).
 *   (3) obligation_lines: the atomic lines of an obligation sum exactly to
 *       the obligation amount, checked at commit for the same reason.
 *
 * These triggers mirror — not replace — the domain commands (AllocateFunds,
 * PostJournal, PostObligation), which remain the single authoritative
 * implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION fund_allocations_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_committed numeric;
                fund_restriction text;
                fund_utilized numeric;
                line_amount numeric;
                line_category text;
                line_funded numeric;
                target_obligation char(36);
                obligation_amount numeric;
                obligation_funded numeric;
                obligation_allocated numeric;
                approved_discounts numeric;
            BEGIN
                SELECT fs.committed_amount, trim(fs.restricted_category)
                  INTO fund_committed, fund_restriction
                  FROM funding_sources fs WHERE fs.id = NEW.fund_id FOR UPDATE;
                IF fund_committed IS NULL THEN
                    RAISE EXCEPTION 'fund allocation references missing funding source %', NEW.fund_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT ol.amount, ol.category INTO line_amount, line_category
                  FROM obligation_lines ol WHERE ol.id = NEW.obligation_line_id FOR UPDATE;
                IF line_amount IS NULL THEN
                    RAISE EXCEPTION 'fund allocation references missing obligation line %', NEW.obligation_line_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF fund_restriction <> '' AND fund_restriction <> trim(line_category) THEN
                    RAISE EXCEPTION 'fund % is restricted to %; obligation line % is %',
                        NEW.fund_id, fund_restriction, NEW.obligation_line_id, line_category
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(SUM(fa.amount), 0) INTO fund_utilized
                  FROM fund_allocations fa WHERE fa.fund_id = NEW.fund_id;
                IF fund_utilized > fund_committed THEN
                    RAISE EXCEPTION 'fund %: utilization (%) exceeds the committed pool (%)',
                        NEW.fund_id, fund_utilized, fund_committed
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(SUM(fa.amount), 0) INTO line_funded
                  FROM fund_allocations fa WHERE fa.obligation_line_id = NEW.obligation_line_id;
                IF line_funded > line_amount THEN
                    RAISE EXCEPTION 'obligation line %: funded (%) exceeds the line amount (%)',
                        NEW.obligation_line_id, line_funded, line_amount
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT ol2.obligation_id INTO target_obligation
                  FROM obligation_lines ol2 WHERE ol2.id = NEW.obligation_line_id;
                SELECT o.original_amount INTO obligation_amount
                  FROM obligations o WHERE o.id = target_obligation FOR UPDATE;
                SELECT COALESCE(SUM(fa.amount), 0) INTO obligation_funded
                  FROM fund_allocations fa
                  JOIN obligation_lines ol3 ON ol3.id = fa.obligation_line_id
                 WHERE ol3.obligation_id = target_obligation;
                SELECT COALESCE(SUM(pa.amount), 0) INTO obligation_allocated
                  FROM payment_allocations pa WHERE pa.obligation_id = target_obligation;
                SELECT COALESCE(SUM(d.amount), 0) INTO approved_discounts
                  FROM discounts d WHERE d.obligation_id = target_obligation AND d.lifecycle_state = 'approved';
                IF obligation_allocated + obligation_funded + approved_discounts > obligation_amount THEN
                    RAISE EXCEPTION 'obligation %: funded + allocated + approved discounts (%) exceed the original amount (%)',
                        target_obligation,
                        obligation_allocated + obligation_funded + approved_discounts,
                        obligation_amount
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_balance_guard_trigger ON fund_allocations');
        DB::statement('CREATE TRIGGER fund_allocations_balance_guard_trigger AFTER INSERT ON fund_allocations FOR EACH ROW EXECUTE FUNCTION fund_allocations_balance_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journal_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                target_journal char(36);
                line_count bigint;
                total_debit numeric;
                total_credit numeric;
            BEGIN
                FOR target_journal IN
                    SELECT CASE WHEN NEW IS NOT NULL THEN NEW.journal_id ELSE OLD.journal_id END
                LOOP
                    SELECT COUNT(*),
                           COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'debit'), 0),
                           COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = 'credit'), 0)
                      INTO line_count, total_debit, total_credit
                      FROM journal_lines jl WHERE jl.journal_id = target_journal;
                    IF line_count = 0 THEN
                        RAISE EXCEPTION 'journal % has no lines', target_journal
                            USING ERRCODE = 'check_violation';
                    ELSIF total_debit <> total_credit THEN
                        RAISE EXCEPTION 'journal % does not balance: debits (%) <> credits (%)',
                            target_journal, total_debit, total_credit
                            USING ERRCODE = 'check_violation';
                    END IF;
                END LOOP;

                RETURN COALESCE(NEW, OLD);
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS journal_lines_balance_guard ON journal_lines');
        DB::statement(<<<'SQL'
            CREATE CONSTRAINT TRIGGER journal_lines_balance_guard
                AFTER INSERT OR DELETE ON journal_lines
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION journal_balance_guard();
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION obligation_lines_total_guard() RETURNS trigger AS $fn$
            DECLARE
                target_obligation char(36);
                original_amount numeric;
                lines_total numeric;
            BEGIN
                FOR target_obligation IN
                    SELECT CASE WHEN NEW IS NOT NULL THEN NEW.obligation_id ELSE OLD.obligation_id END
                LOOP
                    SELECT o.original_amount INTO original_amount
                      FROM obligations o WHERE o.id = target_obligation;
                    SELECT COALESCE(SUM(ol.amount), 0) INTO lines_total
                      FROM obligation_lines ol WHERE ol.obligation_id = target_obligation;
                    IF lines_total <> original_amount THEN
                        RAISE EXCEPTION 'obligation %: lines sum to % but the obligation amount is %',
                            target_obligation, lines_total, original_amount
                            USING ERRCODE = 'check_violation';
                    END IF;
                END LOOP;

                RETURN COALESCE(NEW, OLD);
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS obligation_lines_total_guard ON obligation_lines');
        DB::statement(<<<'SQL'
            CREATE CONSTRAINT TRIGGER obligation_lines_total_guard
                AFTER INSERT OR DELETE ON obligation_lines
                DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW EXECUTE FUNCTION obligation_lines_total_guard();
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS obligation_lines_total_guard ON obligation_lines');
        DB::statement('DROP FUNCTION IF EXISTS obligation_lines_total_guard()');
        DB::statement('DROP TRIGGER IF EXISTS journal_lines_balance_guard ON journal_lines');
        DB::statement('DROP FUNCTION IF EXISTS journal_balance_guard()');
        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_balance_guard_trigger ON fund_allocations');
        DB::statement('DROP FUNCTION IF EXISTS fund_allocations_balance_guard()');
    }
};
