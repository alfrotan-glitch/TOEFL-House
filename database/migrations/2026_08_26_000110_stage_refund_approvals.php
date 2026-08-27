<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged refunds (PHASE_3) — the refund workflow becomes two-session,
 * matching the staged SoD pattern the architecture already uses for
 * discounts (proposed -> approved) and contract versions
 * (prepared -> submitted -> approved):
 *
 *   - a refund is BORN proposed (a REQUESTER session proposes it against
 *     an open period, within the refundable remainder);
 *   - an APPROVER session (a different person, holding
 *     finance.refund_approve) records it — the only path by which a
 *     refund becomes recorded financial history.
 *
 * The transport previously fabricated the approver from request input
 * (a single session typed any person id), which voided the SoD the
 * command and schema enforce on the stored identities. With staging,
 * each signature is captured in its own authenticated session.
 *
 * Schema: refunds gains lifecycle_state ('proposed' | 'recorded');
 * approved_by becomes nullable until approval. The two overlapping
 * triggers (000065 refunds_immutable: no UPDATE/DELETE at all; 000101
 * refunds_balance_guard: balance cap on INSERT) are consolidated into a
 * single refunds_lifecycle_guard:
 *
 *   - INSERT: a refund is born proposed; allocated + recorded refunds
 *     never exceed the amount received (row-locked on the payment);
 *   - UPDATE: only proposed -> recorded, and only the lifecycle state
 *     and approved_by may change; the balance cap is re-checked under
 *     the payment lock (a concurrent allocation can consume the
 *     remainder after the proposal);
 *   - DELETE: never (refunds are financial history).
 *
 * Recorded refunds remain exactly as immutable as before.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement("ALTER TABLE refunds ADD COLUMN IF NOT EXISTS lifecycle_state character varying NOT NULL DEFAULT 'recorded'");
        DB::statement('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_lifecycle_state_check');
        DB::statement("ALTER TABLE refunds ADD CONSTRAINT refunds_lifecycle_state_check CHECK (lifecycle_state IN ('proposed', 'recorded'))");
        DB::statement('ALTER TABLE refunds ALTER COLUMN approved_by DROP NOT NULL');

        DB::statement('DROP TRIGGER IF EXISTS refunds_immutable_trigger ON refunds');
        DB::statement('DROP FUNCTION IF EXISTS refunds_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS refunds_balance_guard_trigger ON refunds');
        DB::statement('DROP FUNCTION IF EXISTS refunds_balance_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION refunds_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                payment_amount numeric;
                allocated_payment numeric;
                recorded_refunds numeric;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'refunds are immutable financial history'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'a refund is born proposed; only approval records it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT amount INTO payment_amount
                      FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                    IF payment_amount IS NULL THEN
                        RAISE EXCEPTION 'refund references missing payment %', NEW.payment_id
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;

                    SELECT COALESCE(SUM(amount), 0) INTO allocated_payment
                      FROM payment_allocations WHERE payment_id = NEW.payment_id;
                    SELECT COALESCE(SUM(amount), 0) INTO recorded_refunds
                      FROM refunds WHERE payment_id = NEW.payment_id AND lifecycle_state = 'recorded';
                    IF allocated_payment + recorded_refunds + NEW.amount > payment_amount THEN
                        RAISE EXCEPTION 'payment %: allocations + recorded refunds + this proposal (% + % + %) exceed the amount received (%)',
                            NEW.payment_id, allocated_payment, recorded_refunds, NEW.amount, payment_amount
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'recorded' THEN
                    RAISE EXCEPTION 'a recorded refund is immutable financial history'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state IS DISTINCT FROM 'recorded' THEN
                    RAISE EXCEPTION 'a proposed refund may only become recorded (state: %)', NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.payment_id IS DISTINCT FROM NEW.payment_id
                   OR OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
                    RAISE EXCEPTION 'a proposed refund may only change lifecycle state and approved_by'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT amount INTO payment_amount
                  FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                IF payment_amount IS NULL THEN
                    RAISE EXCEPTION 'refund references missing payment %', NEW.payment_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT COALESCE(SUM(amount), 0) INTO allocated_payment
                  FROM payment_allocations WHERE payment_id = NEW.payment_id;
                SELECT COALESCE(SUM(amount), 0) INTO recorded_refunds
                  FROM refunds WHERE payment_id = NEW.payment_id AND lifecycle_state = 'recorded';
                IF allocated_payment + recorded_refunds + NEW.amount > payment_amount THEN
                    RAISE EXCEPTION 'payment %: allocations + recorded refunds + this approval (% + % + %) exceed the amount received (%)',
                        NEW.payment_id, allocated_payment, recorded_refunds, NEW.amount, payment_amount
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS refunds_lifecycle_guard_trigger ON refunds');
        DB::statement('CREATE TRIGGER refunds_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_lifecycle_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS refunds_lifecycle_guard_trigger ON refunds');
        DB::statement('DROP FUNCTION IF EXISTS refunds_lifecycle_guard()');

        // Fill approved_by before the immutable trigger is restored.
        DB::statement('UPDATE refunds SET approved_by = requested_by WHERE approved_by IS NULL');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION refunds_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                payment_amount numeric;
                allocated_payment numeric;
                refunded_payment numeric;
            BEGIN
                SELECT amount INTO payment_amount
                  FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                IF payment_amount IS NULL THEN
                    RAISE EXCEPTION 'refund references missing payment %', NEW.payment_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT COALESCE(SUM(amount), 0) INTO allocated_payment
                  FROM payment_allocations WHERE payment_id = NEW.payment_id;
                SELECT COALESCE(SUM(amount), 0) INTO refunded_payment
                  FROM refunds WHERE payment_id = NEW.payment_id;
                IF allocated_payment + refunded_payment > payment_amount THEN
                    RAISE EXCEPTION 'payment %: allocations + refunds (% + %) exceed the amount received (%)',
                        NEW.payment_id, allocated_payment, refunded_payment, payment_amount
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER refunds_balance_guard_trigger AFTER INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_balance_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION refunds_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'refunds are immutable financial history';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER refunds_immutable_trigger BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_immutable()');

        DB::statement('UPDATE refunds SET approved_by = requested_by WHERE approved_by IS NULL');
        DB::statement('ALTER TABLE refunds ALTER COLUMN approved_by SET NOT NULL');
        DB::statement('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_lifecycle_state_check');
        DB::statement('ALTER TABLE refunds DROP COLUMN IF EXISTS lifecycle_state');
    }
};
