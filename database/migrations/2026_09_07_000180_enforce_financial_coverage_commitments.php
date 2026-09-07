<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Materialize approved enrollment-gate coverage against concrete obligations.
 *
 * A credit, installment plan, or gate exception previously approved against
 * the same derived student balance independently. The read-side clamp in the
 * financial gate hid that overlap instead of making it attributable. These
 * immutable commitments reserve exact obligation remainder, preserve source
 * scope, and give PostgreSQL an authoritative direct-SQL/concurrency backstop
 * without adding a cached monetary balance.
 *
 * Existing approved gate instruments are deliberately not backfilled: no
 * historical source records which obligation it covered, and fabricating that
 * provenance would rewrite Finance history. New approvals must materialize a
 * complete source-total commitment set in their transaction; unmaterialized
 * historical instruments remain preserved but cannot become gate authority.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('financial_coverage_commitments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('coverage_source_type');
            $table->char('coverage_source_id', 36);
            $table->char('obligation_id', 36);
            $table->decimal('amount', 14, 2);
            $table->timestamps();

            $table->foreign('obligation_id')->references('id')->on('obligations');
        });
        DB::statement("ALTER TABLE financial_coverage_commitments ADD CONSTRAINT financial_coverage_commitments_source_type_check CHECK (coverage_source_type IN ('financial_credit', 'enrollment_installment_plan', 'financial_gate_exception'))");
        DB::statement('ALTER TABLE financial_coverage_commitments ADD CONSTRAINT financial_coverage_commitments_amount_check CHECK (amount > 0)');
        DB::statement('CREATE UNIQUE INDEX financial_coverage_commitment_source_obligation_unique ON financial_coverage_commitments (coverage_source_type, coverage_source_id, obligation_id)');
        DB::statement('CREATE INDEX financial_coverage_commitment_obligation_index ON financial_coverage_commitments (obligation_id)');
        DB::statement('CREATE INDEX financial_coverage_commitment_source_index ON financial_coverage_commitments (coverage_source_type, coverage_source_id)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_source_is_active(source_type text, source_id text, as_of date) RETURNS boolean AS $fn$
            BEGIN
                IF source_type = 'financial_credit' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_credits
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'enrollment_installment_plan' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM enrollment_installment_plans
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'financial_gate_exception' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_gate_exceptions
                         WHERE id = source_id
                           AND lifecycle_state = 'approved'
                           AND effective_from <= as_of
                           AND (effective_to IS NULL OR effective_to >= as_of)
                    );
                END IF;

                RETURN FALSE;
            END;
            $fn$ LANGUAGE plpgsql STABLE;
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_commitments_guard() RETURNS trigger AS $fn$
            DECLARE
                source_student char(36);
                source_amount numeric;
                source_offering char(36);
                source_class char(36);
                source_effective_from date;
                source_effective_to date;
                class_offering char(36);
                obligation_student char(36);
                obligation_offering char(36);
                obligation_amount numeric;
                allocated_amount numeric;
                reversed_allocations numeric;
                funded_amount numeric;
                reversed_funding numeric;
                discounted_amount numeric;
                decreased_amount numeric;
                increased_amount numeric;
                obligation_remaining numeric;
                active_committed numeric;
                source_committed numeric;
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'financial coverage commitments are immutable Finance authorization history'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- A polymorphic source is intentionally resolved here rather
                -- than trusted from application input. Only a currently
                -- approved source may create coverage authority.
                IF NEW.coverage_source_type = 'financial_credit' THEN
                    SELECT student_id, amount
                      INTO source_student, source_amount
                      FROM financial_credits
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                ELSIF NEW.coverage_source_type = 'enrollment_installment_plan' THEN
                    SELECT student_id, amount, offering_id
                      INTO source_student, source_amount, source_offering
                      FROM enrollment_installment_plans
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                ELSIF NEW.coverage_source_type = 'financial_gate_exception' THEN
                    SELECT student_id, amount, offering_id, class_id, effective_from, effective_to
                      INTO source_student, source_amount, source_offering, source_class, source_effective_from, source_effective_to
                      FROM financial_gate_exceptions
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                    IF source_effective_from IS NULL
                       OR source_effective_from > CURRENT_DATE
                       OR (source_effective_to IS NOT NULL AND source_effective_to < CURRENT_DATE) THEN
                        RAISE EXCEPTION 'a coverage commitment requires a currently effective approved gate exception'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'coverage commitment source type is unsupported'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF source_amount IS NULL THEN
                    RAISE EXCEPTION 'coverage commitment references an unknown or unapproved Finance gate source'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                -- Migration 000181 extends this predicate to reject new
                -- commitment rows for a recorded-revoked source too. History
                -- remains readable, but cannot be appended after correction.
                IF NOT financial_coverage_source_is_active(
                    NEW.coverage_source_type,
                    NEW.coverage_source_id,
                    CURRENT_DATE
                ) THEN
                    RAISE EXCEPTION 'coverage commitment references an inactive or revoked Finance gate source'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT student_id, offering_id, original_amount
                  INTO obligation_student, obligation_offering, obligation_amount
                  FROM obligations
                 WHERE id = NEW.obligation_id
                 FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'coverage commitment references an unknown obligation'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF source_student IS DISTINCT FROM obligation_student THEN
                    RAISE EXCEPTION 'coverage commitment source and obligation must belong to the same student'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF source_offering IS NOT NULL AND obligation_offering IS DISTINCT FROM source_offering THEN
                    RAISE EXCEPTION 'scoped coverage commitment must remain within its source offering obligations'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.coverage_source_type = 'financial_gate_exception' AND source_class IS NOT NULL THEN
                    SELECT offering_id INTO class_offering FROM classes WHERE id = source_class;
                    IF source_offering IS NULL OR class_offering IS NULL OR class_offering IS DISTINCT FROM source_offering THEN
                        RAISE EXCEPTION 'class-scoped gate exception must retain its class offering scope'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                -- No source can be over-materialized, including a direct SQL
                -- attempt made after a legitimate approval has committed.
                SELECT COALESCE(SUM(amount), 0)
                  INTO source_committed
                  FROM financial_coverage_commitments
                 WHERE coverage_source_type = NEW.coverage_source_type
                   AND coverage_source_id = NEW.coverage_source_id;
                IF source_committed + NEW.amount > source_amount THEN
                    RAISE EXCEPTION 'coverage commitments exceed their immutable approved Finance source amount'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- Mirror the authoritative source-fact derivation just for
                -- the database backstop. FinancialBalanceQuery remains the
                -- application balance authority; this prevents raw SQL and
                -- concurrent writers from reserving more than its remainder.
                SELECT COALESCE(SUM(pa.amount), 0)
                  INTO allocated_amount
                  FROM payment_allocations pa
                 WHERE pa.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fc.amount), 0)
                  INTO reversed_allocations
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'allocation_reversal'
                   AND fc.lifecycle_state = 'recorded'
                   AND fc.payment_allocation_id IN (
                       SELECT pa.id FROM payment_allocations pa WHERE pa.obligation_id = NEW.obligation_id
                   );
                SELECT COALESCE(SUM(fa.amount), 0)
                  INTO funded_amount
                  FROM fund_allocations fa
                  JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                 WHERE ol.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fc.amount), 0)
                  INTO reversed_funding
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'fund_allocation_reversal'
                   AND fc.lifecycle_state = 'recorded'
                   AND fc.fund_allocation_id IN (
                       SELECT fa.id
                         FROM fund_allocations fa
                         JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                        WHERE ol.obligation_id = NEW.obligation_id
                   );
                SELECT COALESCE(SUM(d.amount), 0)
                  INTO discounted_amount
                  FROM discounts d
                 WHERE d.obligation_id = NEW.obligation_id
                   AND d.lifecycle_state = 'approved';
                SELECT COALESCE(SUM(fc.amount), 0)
                  INTO decreased_amount
                  FROM financial_corrections fc
                 WHERE fc.obligation_id = NEW.obligation_id
                   AND fc.correction_type = 'obligation_adjustment'
                   AND fc.direction = 'decrease'
                   AND fc.lifecycle_state = 'recorded';
                SELECT COALESCE(SUM(fc.amount), 0)
                  INTO increased_amount
                  FROM financial_corrections fc
                 WHERE fc.obligation_id = NEW.obligation_id
                   AND fc.correction_type = 'obligation_adjustment'
                   AND fc.direction = 'increase'
                   AND fc.lifecycle_state = 'recorded';
                obligation_remaining := obligation_amount - funded_amount + reversed_funding
                    - allocated_amount + reversed_allocations - discounted_amount
                    - decreased_amount + increased_amount;
                IF obligation_remaining < 0 THEN
                    RAISE EXCEPTION 'coverage commitment cannot use an over-settled obligation'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- Expired exceptions no longer consume today's gate capacity.
                -- Migration 000181 extends the shared predicate so recorded
                -- append-only revocations also release only future capacity.
                SELECT COALESCE(SUM(fcc.amount), 0)
                  INTO active_committed
                  FROM financial_coverage_commitments fcc
                 WHERE fcc.obligation_id = NEW.obligation_id
                   AND financial_coverage_source_is_active(
                       fcc.coverage_source_type,
                       fcc.coverage_source_id,
                       CURRENT_DATE
                   );
                IF active_committed + NEW.amount > obligation_remaining THEN
                    RAISE EXCEPTION 'coverage commitments exceed the authoritative uncommitted obligation remainder'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_coverage_commitments_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_coverage_commitments FOR EACH ROW EXECUTE FUNCTION financial_coverage_commitments_guard()');

        // A class scope is meaningful only within its exact offering. Enforce
        // it at the source row as well as on the eventual commitment, so a
        // malformed proposed exception cannot wait for a future approval path.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_gate_exceptions_scope_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.class_id IS NOT NULL
                   AND (NEW.offering_id IS NULL
                        OR NOT EXISTS (
                            SELECT 1 FROM classes c
                             WHERE c.id = NEW.class_id
                               AND c.offering_id = NEW.offering_id
                        )) THEN
                    RAISE EXCEPTION 'a class-scoped financial gate exception must name its class exact offering'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS financial_gate_exceptions_scope_guard_trigger ON financial_gate_exceptions');
        DB::statement('CREATE TRIGGER financial_gate_exceptions_scope_guard_trigger BEFORE INSERT OR UPDATE ON financial_gate_exceptions FOR EACH ROW EXECUTE FUNCTION financial_gate_exceptions_scope_guard()');

        // The lifecycle guard proves independence/provenance; this deferred
        // completion guard proves that approval and attributed commitments are
        // atomic. It intentionally fires at transaction end so the command
        // can transition a source to approved and then insert its immutable
        // commitment rows in the same transaction.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_source_complete_guard() RETURNS trigger AS $fn$
            DECLARE
                source_type text;
                committed_amount numeric;
            BEGIN
                IF TG_TABLE_NAME = 'financial_credits' THEN
                    source_type := 'financial_credit';
                ELSIF TG_TABLE_NAME = 'enrollment_installment_plans' THEN
                    source_type := 'enrollment_installment_plan';
                ELSIF TG_TABLE_NAME = 'financial_gate_exceptions' THEN
                    source_type := 'financial_gate_exception';
                ELSE
                    RAISE EXCEPTION 'unknown Finance coverage source table %', TG_TABLE_NAME
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state <> 'approved' THEN
                    RETURN NEW;
                END IF;
                SELECT COALESCE(SUM(amount), 0)
                  INTO committed_amount
                  FROM financial_coverage_commitments
                 WHERE coverage_source_type = source_type
                   AND coverage_source_id = NEW.id;
                IF committed_amount <> NEW.amount THEN
                    RAISE EXCEPTION 'an approved Finance coverage source requires exact immutable obligation commitments'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS financial_credits_coverage_complete_trigger ON financial_credits');
        DB::statement('CREATE CONSTRAINT TRIGGER financial_credits_coverage_complete_trigger AFTER INSERT OR UPDATE ON financial_credits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_coverage_source_complete_guard()');
        DB::statement('DROP TRIGGER IF EXISTS installment_plans_coverage_complete_trigger ON enrollment_installment_plans');
        DB::statement('CREATE CONSTRAINT TRIGGER installment_plans_coverage_complete_trigger AFTER INSERT OR UPDATE ON enrollment_installment_plans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_coverage_source_complete_guard()');
        DB::statement('DROP TRIGGER IF EXISTS gate_exceptions_coverage_complete_trigger ON financial_gate_exceptions');
        DB::statement('CREATE CONSTRAINT TRIGGER gate_exceptions_coverage_complete_trigger AFTER INSERT OR UPDATE ON financial_gate_exceptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION financial_coverage_source_complete_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS financial_credits_coverage_complete_trigger ON financial_credits');
        DB::statement('DROP TRIGGER IF EXISTS installment_plans_coverage_complete_trigger ON enrollment_installment_plans');
        DB::statement('DROP TRIGGER IF EXISTS gate_exceptions_coverage_complete_trigger ON financial_gate_exceptions');
        DB::statement('DROP FUNCTION IF EXISTS financial_coverage_source_complete_guard()');
        DB::statement('DROP TRIGGER IF EXISTS financial_gate_exceptions_scope_guard_trigger ON financial_gate_exceptions');
        DB::statement('DROP FUNCTION IF EXISTS financial_gate_exceptions_scope_guard()');
        DB::statement('DROP TRIGGER IF EXISTS financial_coverage_commitments_guard_trigger ON financial_coverage_commitments');
        DB::statement('DROP FUNCTION IF EXISTS financial_coverage_commitments_guard()');
        DB::statement('DROP FUNCTION IF EXISTS financial_coverage_source_is_active(text, text, date)');
        Schema::dropIfExists('financial_coverage_commitments');
    }
};
