<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Completes the database boundary for the append-only Finance instruments.
 *
 * The application commands provide friendly validation and authorization;
 * these guards prevent direct SQL, stale workers, and concurrent approval
 * races from bypassing lifecycle, SoD, source-period, provenance, or
 * derived-balance invariants. Existing facts are preserved; only future
 * writes are guarded. This is a one-way pre-production consolidation because
 * it replaces several prior trigger function bodies; a reviewed baseline is
 * required before rollback is offered.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE financial_corrections DROP CONSTRAINT IF EXISTS financial_corrections_type_check');
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_type_check CHECK (correction_type IN ('obligation_adjustment','allocation_reversal','fund_allocation_reversal'))");
        DB::statement('ALTER TABLE financial_corrections DROP CONSTRAINT IF EXISTS financial_corrections_source_shape_check');
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_source_shape_check CHECK ((correction_type = 'obligation_adjustment' AND obligation_id IS NOT NULL AND payment_allocation_id IS NULL AND fund_allocation_id IS NULL) OR (correction_type = 'allocation_reversal' AND obligation_id IS NULL AND payment_allocation_id IS NOT NULL AND fund_allocation_id IS NULL) OR (correction_type = 'fund_allocation_reversal' AND obligation_id IS NULL AND payment_allocation_id IS NULL AND fund_allocation_id IS NOT NULL))");
        // Replace the first-pass correction trigger rather than stacking two
        // independent guards over the same fact. The earlier function remains
        // available for a clean rollback to migration 140.
        DB::statement('DROP TRIGGER IF EXISTS financial_corrections_guard_trigger ON financial_corrections');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_corrections_hardened_guard() RETURNS trigger AS $fn$
            DECLARE
                source_amount numeric;
                source_period char(36);
                prior_amount numeric;
                source_branch char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'financial corrections are immutable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'proposed' THEN
                    RAISE EXCEPTION 'a financial correction is born proposed and requires independent approval'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM financial_periods WHERE id = NEW.period_id AND lifecycle_state = 'open') THEN
                    RAISE EXCEPTION 'financial corrections require an open financial period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'recorded' THEN
                        RAISE EXCEPTION 'recorded financial corrections are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.correction_type IS DISTINCT FROM NEW.correction_type
                       OR OLD.obligation_id IS DISTINCT FROM NEW.obligation_id
                       OR OLD.payment_allocation_id IS DISTINCT FROM NEW.payment_allocation_id
                       OR OLD.fund_allocation_id IS DISTINCT FROM NEW.fund_allocation_id
                       OR OLD.amount IS DISTINCT FROM NEW.amount
                       OR OLD.direction IS DISTINCT FROM NEW.direction
                       OR OLD.period_id IS DISTINCT FROM NEW.period_id
                       OR OLD.reason IS DISTINCT FROM NEW.reason
                       OR OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
                        RAISE EXCEPTION 'correction source and terms are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'recorded' THEN
                        RAISE EXCEPTION 'a correction may transition only proposed to recorded'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                        RAISE EXCEPTION 'a correction requires an independent approval identity and timestamp'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.correction_type = 'obligation_adjustment' THEN
                    SELECT original_amount, period_id INTO source_amount, source_period
                      FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                    IF source_amount IS NULL OR NEW.period_id <> source_period OR NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'obligation correction source or period is invalid'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE obligation_id = NEW.obligation_id
                       AND correction_type = 'obligation_adjustment'
                       AND direction = NEW.direction
                       AND lifecycle_state = 'recorded';
                ELSIF NEW.correction_type = 'allocation_reversal' THEN
                    SELECT pa.amount, o.period_id INTO source_amount, source_period
                      FROM payment_allocations pa
                      JOIN obligations o ON o.id = pa.obligation_id
                     WHERE pa.id = NEW.payment_allocation_id FOR UPDATE;
                    IF source_amount IS NULL OR NEW.direction <> 'decrease' OR NEW.period_id <> source_period THEN
                        RAISE EXCEPTION 'payment allocation reversal source or period is invalid'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE payment_allocation_id = NEW.payment_allocation_id
                       AND correction_type = 'allocation_reversal'
                       AND lifecycle_state = 'recorded';
                ELSE
                    SELECT fa.amount, o.period_id INTO source_amount, source_period
                      FROM fund_allocations fa
                      JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                      JOIN obligations o ON o.id = ol.obligation_id
                     WHERE fa.id = NEW.fund_allocation_id FOR UPDATE;
                    IF source_amount IS NULL OR NEW.direction <> 'decrease' OR NEW.period_id <> source_period THEN
                        RAISE EXCEPTION 'fund allocation reversal source or period is invalid'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE fund_allocation_id = NEW.fund_allocation_id
                       AND correction_type = 'fund_allocation_reversal'
                       AND lifecycle_state = 'recorded';
                END IF;
                IF NEW.correction_type = 'obligation_adjustment' THEN
                    SELECT COALESCE(current_home_branch_id, originating_branch_id) INTO source_branch
                      FROM obligations WHERE id = NEW.obligation_id;
                ELSIF NEW.correction_type = 'allocation_reversal' THEN
                    SELECT COALESCE(o.current_home_branch_id, o.originating_branch_id) INTO source_branch
                      FROM payment_allocations pa JOIN obligations o ON o.id = pa.obligation_id
                     WHERE pa.id = NEW.payment_allocation_id;
                ELSE
                    SELECT COALESCE(o.current_home_branch_id, o.originating_branch_id) INTO source_branch
                      FROM fund_allocations fa
                      JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                      JOIN obligations o ON o.id = ol.obligation_id
                     WHERE fa.id = NEW.fund_allocation_id;
                END IF;
                IF source_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = source_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'source-linked corrections require known active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF prior_amount + NEW.amount > source_amount THEN
                    RAISE EXCEPTION 'source-linked corrections exceed their immutable source amount'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_corrections_hardened_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_corrections FOR EACH ROW EXECUTE FUNCTION financial_corrections_hardened_guard()');

        // Consolidate the pre-staging immutability trigger into the lifecycle
        // guard below. Leaving both installed would make one Finance fact
        // boundary depend on trigger ordering and duplicate the policy.
        DB::statement('DROP TRIGGER IF EXISTS discounts_approved_immutable_trigger ON discounts');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION discounts_finance_guard() RETURNS trigger AS $fn$
            DECLARE
                source_amount numeric;
                source_period char(36);
                source_branch char(36);
                allocated_amount numeric;
                funded_amount numeric;
                existing_discounts numeric;
                decreased_amount numeric;
                increased_amount numeric;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'discounts are immutable financial facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT original_amount, period_id, COALESCE(current_home_branch_id, originating_branch_id)
                  INTO source_amount, source_period, source_branch
                  FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                IF source_amount IS NULL OR NEW.period_id <> source_period THEN
                    RAISE EXCEPTION 'discount must reference its obligation and financial period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF source_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = source_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'discounts require known active obligation branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM financial_periods WHERE id = NEW.period_id AND lifecycle_state = 'open') THEN
                    RAISE EXCEPTION 'discounts require an open financial period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' OR NEW.approved_by IS NOT NULL THEN
                        RAISE EXCEPTION 'a discount is born proposed and requires independent approval'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'discount exceeds its obligation source amount'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'approved' THEN
                    RAISE EXCEPTION 'a discount may transition only proposed to approved'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.obligation_id IS DISTINCT FROM NEW.obligation_id
                   OR OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.eligibility IS DISTINCT FROM NEW.eligibility
                   OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
                   OR OLD.effective_to IS DISTINCT FROM NEW.effective_to
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
                   OR NEW.approved_by IS NULL
                   OR trim(NEW.approved_by) = trim(NEW.proposed_by) THEN
                    RAISE EXCEPTION 'approved discount terms are immutable and require an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(SUM(pa.amount), 0) - COALESCE((
                    SELECT SUM(fc.amount) FROM financial_corrections fc
                     WHERE fc.correction_type = 'allocation_reversal'
                       AND fc.payment_allocation_id IN (SELECT id FROM payment_allocations WHERE obligation_id = NEW.obligation_id)
                       AND fc.lifecycle_state = 'recorded'
                ), 0) INTO allocated_amount
                  FROM payment_allocations pa WHERE pa.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fa.amount), 0) - COALESCE((
                    SELECT SUM(fc.amount) FROM financial_corrections fc
                     WHERE fc.correction_type = 'fund_allocation_reversal'
                       AND fc.fund_allocation_id IN (
                           SELECT fa2.id FROM fund_allocations fa2
                           JOIN obligation_lines ol2 ON ol2.id = fa2.obligation_line_id
                           WHERE ol2.obligation_id = NEW.obligation_id
                       )
                       AND fc.lifecycle_state = 'recorded'
                ), 0) INTO funded_amount
                  FROM fund_allocations fa
                  JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                 WHERE ol.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(d.amount), 0) INTO existing_discounts
                  FROM discounts d
                 WHERE d.obligation_id = NEW.obligation_id
                   AND d.lifecycle_state = 'approved'
                   AND d.id <> NEW.id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO decreased_amount
                  FROM financial_corrections fc
                 WHERE fc.obligation_id = NEW.obligation_id
                   AND fc.correction_type = 'obligation_adjustment'
                   AND fc.direction = 'decrease'
                   AND fc.lifecycle_state = 'recorded';
                SELECT COALESCE(SUM(fc.amount), 0) INTO increased_amount
                  FROM financial_corrections fc
                 WHERE fc.obligation_id = NEW.obligation_id
                   AND fc.correction_type = 'obligation_adjustment'
                   AND fc.direction = 'increase'
                   AND fc.lifecycle_state = 'recorded';
                IF NEW.amount > source_amount + increased_amount - decreased_amount - allocated_amount - funded_amount - existing_discounts THEN
                    RAISE EXCEPTION 'approved discounts exceed the current obligation remainder'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS discounts_finance_guard_trigger ON discounts');
        DB::statement('CREATE TRIGGER discounts_finance_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON discounts FOR EACH ROW EXECUTE FUNCTION discounts_finance_guard()');

        DB::statement('DROP TRIGGER IF EXISTS financial_credits_approved_immutable_trigger ON financial_credits');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_credit_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'financial credits are append-only facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM students s
                    JOIN branches b ON b.id = COALESCE(s.current_home_branch_id, s.originating_branch_id)
                    WHERE s.id = NEW.student_id AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'financial credits require a student with known active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
                        RAISE EXCEPTION 'a financial credit is born proposed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'approved'
                   OR OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.source_ref IS DISTINCT FROM NEW.source_ref
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
                   OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'a credit may only transition proposed to approved with immutable terms and an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_credits_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_credits FOR EACH ROW EXECUTE FUNCTION financial_credit_lifecycle_guard()');

        DB::statement('DROP TRIGGER IF EXISTS enrollment_installment_plans_approved_immutable_trigger ON enrollment_installment_plans');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollment_installment_plans_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'installment plans are append-only facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM students s
                    JOIN branches b ON b.id = COALESCE(s.current_home_branch_id, s.originating_branch_id)
                    WHERE s.id = NEW.student_id AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'installment plans require a student with known active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
                        RAISE EXCEPTION 'an installment plan is born proposed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'approved'
                   OR OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.offering_id IS DISTINCT FROM NEW.offering_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.installments_count IS DISTINCT FROM NEW.installments_count
                   OR OLD.first_due_on IS DISTINCT FROM NEW.first_due_on
                   OR OLD.schedule_ref IS DISTINCT FROM NEW.schedule_ref
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
                   OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'an installment plan may only transition proposed to approved with immutable terms and an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER enrollment_installment_plans_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON enrollment_installment_plans FOR EACH ROW EXECUTE FUNCTION enrollment_installment_plans_lifecycle_guard()');

        DB::statement('DROP TRIGGER IF EXISTS financial_gate_exceptions_approved_immutable_trigger ON financial_gate_exceptions');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_gate_exceptions_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'financial gate exceptions are append-only facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM students s
                    JOIN branches b ON b.id = COALESCE(s.current_home_branch_id, s.originating_branch_id)
                    WHERE s.id = NEW.student_id AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'financial gate exceptions require a student with known active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
                        RAISE EXCEPTION 'a gate exception is born proposed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'approved'
                   OR OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.offering_id IS DISTINCT FROM NEW.offering_id
                   OR OLD.class_id IS DISTINCT FROM NEW.class_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
                   OR OLD.effective_to IS DISTINCT FROM NEW.effective_to
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
                   OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'a gate exception may only transition proposed to approved with immutable terms and an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_gate_exceptions_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_gate_exceptions FOR EACH ROW EXECUTE FUNCTION financial_gate_exceptions_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION refunds_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                payment_amount numeric;
                payment_period char(36);
                payment_branch char(36);
                payment_origin char(36);
                payment_home char(36);
                allocated_payment numeric;
                reversed_allocations numeric;
                recorded_refunds numeric;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'refunds are immutable financial history'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT amount, period_id, originating_branch_id, current_home_branch_id, COALESCE(current_home_branch_id, originating_branch_id)
                  INTO payment_amount, payment_period, payment_origin, payment_home, payment_branch
                  FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                IF payment_amount IS NULL THEN
                    RAISE EXCEPTION 'refund references missing payment %', NEW.payment_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF NEW.period_id IS DISTINCT FROM payment_period THEN
                    RAISE EXCEPTION 'refund period must match its payment period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF payment_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = payment_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'refunds require known active payment branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.originating_branch_id IS DISTINCT FROM payment_origin
                   OR NEW.current_home_branch_id IS DISTINCT FROM payment_home THEN
                    RAISE EXCEPTION 'refund branch provenance must match its immutable payment provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT COALESCE(SUM(amount), 0) INTO allocated_payment
                  FROM payment_allocations WHERE payment_id = NEW.payment_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO reversed_allocations
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'allocation_reversal'
                   AND fc.lifecycle_state = 'recorded'
                   AND fc.payment_allocation_id IN (SELECT id FROM payment_allocations WHERE payment_id = NEW.payment_id);
                allocated_payment := allocated_payment - reversed_allocations;
                SELECT COALESCE(SUM(amount), 0) INTO recorded_refunds
                  FROM refunds WHERE payment_id = NEW.payment_id AND lifecycle_state = 'recorded';
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'a refund is born proposed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF allocated_payment + recorded_refunds + NEW.amount > payment_amount THEN
                        RAISE EXCEPTION 'refund proposal exceeds the payment remainder'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'recorded'
                   OR OLD.payment_id IS DISTINCT FROM NEW.payment_id
                   OR OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id
                   OR OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id
                   OR NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'a refund may only transition proposed to recorded with immutable terms and an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF allocated_payment + recorded_refunds + NEW.amount > payment_amount THEN
                    RAISE EXCEPTION 'refund approval exceeds the payment remainder'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS refunds_immutable_trigger ON refunds');
        DB::statement('CREATE TRIGGER refunds_lifecycle_guard_hardened_trigger BEFORE INSERT OR UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payment_allocations_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                payment_amount numeric;
                payment_branch char(36);
                payment_student char(36);
                allocated_payment numeric;
                reversed_payment numeric;
                refunded_payment numeric;
                obligation_amount numeric;
                obligation_branch char(36);
                obligation_student char(36);
                allocated_obligation numeric;
                reversed_obligation numeric;
                funded_obligation numeric;
                reversed_funding numeric;
                approved_discounts numeric;
                decreased_amount numeric;
                increased_amount numeric;
            BEGIN
                SELECT amount, COALESCE(current_home_branch_id, originating_branch_id), student_id
                  INTO payment_amount, payment_branch, payment_student
                  FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                IF payment_amount IS NULL THEN
                    RAISE EXCEPTION 'payment allocation references missing payment %', NEW.payment_id USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF payment_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = payment_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'payment allocations require known active payment branch provenance' USING ERRCODE = 'check_violation';
                END IF;
                SELECT original_amount, COALESCE(current_home_branch_id, originating_branch_id), student_id
                  INTO obligation_amount, obligation_branch, obligation_student
                  FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'payment allocation references missing obligation %', NEW.obligation_id USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF obligation_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = obligation_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'payment allocations require known active obligation branch provenance' USING ERRCODE = 'check_violation';
                END IF;
                IF payment_student IS DISTINCT FROM obligation_student THEN
                    RAISE EXCEPTION 'payment allocations must match the payment and obligation student' USING ERRCODE = 'check_violation';
                END IF;
                SELECT COALESCE(SUM(amount), 0) INTO allocated_payment FROM payment_allocations WHERE payment_id = NEW.payment_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO reversed_payment
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'allocation_reversal' AND fc.lifecycle_state = 'recorded'
                   AND fc.payment_allocation_id IN (SELECT id FROM payment_allocations WHERE payment_id = NEW.payment_id);
                SELECT COALESCE(SUM(amount), 0) INTO refunded_payment FROM refunds WHERE payment_id = NEW.payment_id AND lifecycle_state = 'recorded';
                IF allocated_payment - reversed_payment + refunded_payment + NEW.amount > payment_amount THEN
                    RAISE EXCEPTION 'payment settlement exceeds the received amount' USING ERRCODE = 'check_violation';
                END IF;

                SELECT original_amount INTO obligation_amount FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'payment allocation references missing obligation %', NEW.obligation_id USING ERRCODE = 'foreign_key_violation';
                END IF;
                SELECT COALESCE(SUM(amount), 0) INTO allocated_obligation FROM payment_allocations WHERE obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO reversed_obligation
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'allocation_reversal' AND fc.lifecycle_state = 'recorded'
                   AND fc.payment_allocation_id IN (SELECT id FROM payment_allocations WHERE obligation_id = NEW.obligation_id);
                SELECT COALESCE(SUM(fa.amount), 0) INTO funded_obligation
                  FROM fund_allocations fa JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                 WHERE ol.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO reversed_funding
                  FROM financial_corrections fc
                 WHERE fc.correction_type = 'fund_allocation_reversal' AND fc.lifecycle_state = 'recorded'
                   AND fc.fund_allocation_id IN (SELECT fa.id FROM fund_allocations fa JOIN obligation_lines ol ON ol.id = fa.obligation_line_id WHERE ol.obligation_id = NEW.obligation_id);
                SELECT COALESCE(SUM(amount), 0) INTO approved_discounts FROM discounts WHERE obligation_id = NEW.obligation_id AND lifecycle_state = 'approved';
                SELECT COALESCE(SUM(amount), 0) INTO decreased_amount FROM financial_corrections WHERE obligation_id = NEW.obligation_id AND correction_type = 'obligation_adjustment' AND direction = 'decrease' AND lifecycle_state = 'recorded';
                SELECT COALESCE(SUM(amount), 0) INTO increased_amount FROM financial_corrections WHERE obligation_id = NEW.obligation_id AND correction_type = 'obligation_adjustment' AND direction = 'increase' AND lifecycle_state = 'recorded';
                IF allocated_obligation - reversed_obligation + funded_obligation - reversed_funding + approved_discounts + NEW.amount > obligation_amount + increased_amount - decreased_amount THEN
                    RAISE EXCEPTION 'obligation settlement exceeds the current obligation remainder' USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payment_allocations_balance_hardened_trigger BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_balance_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION fund_allocations_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_committed numeric;
                fund_restriction text;
                fund_utilized numeric;
                fund_reversed numeric;
                line_amount numeric;
                line_funded numeric;
                line_reversed numeric;
                target_obligation char(36);
                obligation_amount numeric;
                obligation_branch char(36);
                obligation_origin char(36);
                obligation_home char(36);
                obligation_funded numeric;
                obligation_fund_reversed numeric;
                obligation_allocated numeric;
                obligation_allocation_reversed numeric;
                approved_discounts numeric;
                decreased_amount numeric;
                increased_amount numeric;
            BEGIN
                SELECT fs.committed_amount, trim(fs.restricted_category) INTO fund_committed, fund_restriction
                  FROM funding_sources fs WHERE fs.id = NEW.fund_id FOR UPDATE;
                IF fund_committed IS NULL THEN
                    RAISE EXCEPTION 'fund allocation references missing funding source %' USING ERRCODE = 'foreign_key_violation';
                END IF;
                SELECT ol.amount, ol.obligation_id INTO line_amount, target_obligation
                  FROM obligation_lines ol WHERE ol.id = NEW.obligation_line_id FOR UPDATE;
                IF line_amount IS NULL THEN
                    RAISE EXCEPTION 'fund allocation references missing obligation line %' USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF fund_restriction <> '' AND fund_restriction <> trim((SELECT category FROM obligation_lines WHERE id = NEW.obligation_line_id)) THEN
                    RAISE EXCEPTION 'fund restriction does not match obligation line' USING ERRCODE = 'check_violation';
                END IF;
                SELECT COALESCE(SUM(fa.amount), 0) INTO fund_utilized FROM fund_allocations fa WHERE fa.fund_id = NEW.fund_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO fund_reversed FROM financial_corrections fc WHERE fc.correction_type = 'fund_allocation_reversal' AND fc.lifecycle_state = 'recorded' AND fc.fund_allocation_id IN (SELECT id FROM fund_allocations WHERE fund_id = NEW.fund_id);
                IF fund_utilized - fund_reversed + NEW.amount > fund_committed THEN
                    RAISE EXCEPTION 'fund utilization exceeds the committed pool' USING ERRCODE = 'check_violation';
                END IF;
                SELECT COALESCE(SUM(fa.amount), 0) INTO line_funded FROM fund_allocations fa WHERE fa.obligation_line_id = NEW.obligation_line_id;
                SELECT COALESCE(SUM(fc.amount), 0) INTO line_reversed FROM financial_corrections fc WHERE fc.correction_type = 'fund_allocation_reversal' AND fc.lifecycle_state = 'recorded' AND fc.fund_allocation_id IN (SELECT id FROM fund_allocations WHERE obligation_line_id = NEW.obligation_line_id);
                IF line_funded - line_reversed + NEW.amount > line_amount THEN
                    RAISE EXCEPTION 'funded amount exceeds the obligation line' USING ERRCODE = 'check_violation';
                END IF;
                SELECT original_amount, originating_branch_id, current_home_branch_id, COALESCE(current_home_branch_id, originating_branch_id)
                  INTO obligation_amount, obligation_origin, obligation_home, obligation_branch
                  FROM obligations WHERE id = target_obligation FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'fund allocation references missing obligation %', target_obligation USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF obligation_branch IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = obligation_branch AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'fund allocations require known active obligation branch provenance' USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.originating_branch_id IS DISTINCT FROM obligation_origin
                   OR NEW.current_home_branch_id IS DISTINCT FROM obligation_home THEN
                    RAISE EXCEPTION 'fund allocation branch provenance must match its immutable obligation provenance' USING ERRCODE = 'check_violation';
                END IF;
                SELECT COALESCE(SUM(fa.amount), 0) INTO obligation_funded FROM fund_allocations fa JOIN obligation_lines ol ON ol.id = fa.obligation_line_id WHERE ol.obligation_id = target_obligation;
                SELECT COALESCE(SUM(fc.amount), 0) INTO obligation_fund_reversed FROM financial_corrections fc WHERE fc.correction_type = 'fund_allocation_reversal' AND fc.lifecycle_state = 'recorded' AND fc.fund_allocation_id IN (SELECT fa.id FROM fund_allocations fa JOIN obligation_lines ol ON ol.id = fa.obligation_line_id WHERE ol.obligation_id = target_obligation);
                SELECT COALESCE(SUM(pa.amount), 0) INTO obligation_allocated FROM payment_allocations pa WHERE pa.obligation_id = target_obligation;
                SELECT COALESCE(SUM(fc.amount), 0) INTO obligation_allocation_reversed FROM financial_corrections fc WHERE fc.correction_type = 'allocation_reversal' AND fc.lifecycle_state = 'recorded' AND fc.payment_allocation_id IN (SELECT id FROM payment_allocations WHERE obligation_id = target_obligation);
                SELECT COALESCE(SUM(d.amount), 0) INTO approved_discounts FROM discounts d WHERE d.obligation_id = target_obligation AND d.lifecycle_state = 'approved';
                SELECT COALESCE(SUM(fc.amount), 0) INTO decreased_amount FROM financial_corrections fc WHERE fc.obligation_id = target_obligation AND fc.correction_type = 'obligation_adjustment' AND fc.direction = 'decrease' AND fc.lifecycle_state = 'recorded';
                SELECT COALESCE(SUM(fc.amount), 0) INTO increased_amount FROM financial_corrections fc WHERE fc.obligation_id = target_obligation AND fc.correction_type = 'obligation_adjustment' AND fc.direction = 'increase' AND fc.lifecycle_state = 'recorded';
                IF obligation_allocated - obligation_allocation_reversed + obligation_funded - obligation_fund_reversed + approved_discounts + NEW.amount > obligation_amount + increased_amount - decreased_amount THEN
                    RAISE EXCEPTION 'obligation settlement exceeds the current obligation remainder' USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER fund_allocations_balance_hardened_trigger BEFORE INSERT ON fund_allocations FOR EACH ROW EXECUTE FUNCTION fund_allocations_balance_guard()');
    }

    public function down(): void
    {
        // This migration replaces several function bodies (refund and
        // allocation balance semantics included). Do not perform a partial
        // rollback that leaves an earlier trigger name executing a hardened
        // body; rollback requires a reviewed baseline migration instead.
        throw new \RuntimeException('Finance guard hardening is a one-way pre-production consolidation; restore from the reviewed baseline rather than partially rolling back.');
    }
};
