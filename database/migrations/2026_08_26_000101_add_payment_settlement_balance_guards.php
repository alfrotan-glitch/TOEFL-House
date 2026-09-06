<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level settlement balance guards (Finance, BR-FIN-001/002 boundary).
 *
 * The domain commands (AllocatePayment, RefundPayment) enforce the balance
 * caps under row locks. These AFTER INSERT triggers enforce the SAME
 * invariants at the authoritative database boundary, so a direct SQL INSERT
 * (bypassing the application) can never fabricate settlement:
 *
 *   (1) A payment can never be allocated + refunded for more than the amount
 *       actually received.
 *   (2) An obligation can never be allocated for more than its uncovered
 *       remainder (original amount - funded - approved discounts).
 *
 * The triggers take FOR UPDATE locks on the source payment/obligation rows,
 * which serializes concurrent direct INSERTs so the re-check is race-free
 * under READ COMMITTED. They mirror — not replace — the domain calculation;
 * the domain command remains the single authoritative implementation.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payment_allocations_balance_guard() RETURNS trigger AS $fn$
            DECLARE
                payment_amount numeric;
                obligation_amount numeric;
                allocated_payment numeric;
                refunded_payment numeric;
                allocated_obligation numeric;
                funded_obligation numeric;
                approved_discounts numeric;
            BEGIN
                SELECT amount INTO payment_amount
                  FROM payments WHERE id = NEW.payment_id FOR UPDATE;
                IF payment_amount IS NULL THEN
                    RAISE EXCEPTION 'payment allocation references missing payment %', NEW.payment_id
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

                SELECT original_amount INTO obligation_amount
                  FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'payment allocation references missing obligation %', NEW.obligation_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT COALESCE(SUM(amount), 0) INTO allocated_obligation
                  FROM payment_allocations WHERE obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(fa.amount), 0) INTO funded_obligation
                  FROM fund_allocations fa
                  JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                 WHERE ol.obligation_id = NEW.obligation_id;
                SELECT COALESCE(SUM(amount), 0) INTO approved_discounts
                  FROM discounts
                 WHERE obligation_id = NEW.obligation_id AND lifecycle_state = 'approved';
                IF allocated_obligation > obligation_amount - funded_obligation - approved_discounts THEN
                    RAISE EXCEPTION 'obligation %: allocations (%) exceed the uncovered remainder (original % - funded % - approved discounts %)',
                        NEW.obligation_id, allocated_obligation, obligation_amount, funded_obligation, approved_discounts
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payment_allocations_balance_guard_trigger ON payment_allocations');
        DB::statement('CREATE TRIGGER payment_allocations_balance_guard_trigger AFTER INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_balance_guard()');

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
        DB::statement('DROP TRIGGER IF EXISTS refunds_balance_guard_trigger ON refunds');
        DB::statement('CREATE TRIGGER refunds_balance_guard_trigger AFTER INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_balance_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS refunds_balance_guard_trigger ON refunds');
        DB::statement('DROP FUNCTION IF EXISTS refunds_balance_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payment_allocations_balance_guard_trigger ON payment_allocations');
        DB::statement('DROP FUNCTION IF EXISTS payment_allocations_balance_guard()');
    }
};
