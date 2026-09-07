<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Finance settlement-guard convergence.
 *
 * Migration 000141 deliberately changed the allocation guard functions from
 * AFTER-INSERT semantics to BEFORE-INSERT semantics so they can account for
 * recorded compensating corrections. The original AFTER triggers remained
 * installed, however. PostgreSQL invoked the new function twice: once before
 * the row existed (correctly adding NEW.amount) and once after it existed
 * (adding NEW.amount a second time). A valid full allocation could therefore
 * be rejected as an apparent over-settlement.
 *
 * Keep exactly one BEFORE trigger for each current Finance lifecycle/balance
 * guard. The correction guard also closes the inverse bypass: an obligation
 * decrease may not lower the effective charge below immutable payment,
 * funding, and approved-discount settlement already recorded against it.
 * Allocation reversals must be recorded first when a decrease needs to undo
 * a settlement; source facts themselves are never rewritten.
 */
return new class extends Migration
{
    public function up(): void
    {
        // 000141 replaced these function bodies with BEFORE-INSERT semantics
        // but left 000101/000102's AFTER triggers in place. Remove both
        // historical names and install one deterministic trigger per fact.
        DB::statement('DROP TRIGGER IF EXISTS payment_allocations_balance_guard_trigger ON payment_allocations');
        DB::statement('DROP TRIGGER IF EXISTS payment_allocations_balance_hardened_trigger ON payment_allocations');
        DB::statement('CREATE TRIGGER finance_payment_allocations_balance_guard_trigger BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_balance_guard()');

        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_balance_guard_trigger ON fund_allocations');
        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_balance_hardened_trigger ON fund_allocations');
        DB::statement('CREATE TRIGGER finance_fund_allocations_balance_guard_trigger BEFORE INSERT ON fund_allocations FOR EACH ROW EXECUTE FUNCTION fund_allocations_balance_guard()');

        // Both 000110 and 000141 installed the same lifecycle function under
        // different trigger names. It did not double-count rows, but made a
        // single authority depend on accidental duplicate trigger ordering.
        DB::statement('DROP TRIGGER IF EXISTS refunds_lifecycle_guard_trigger ON refunds');
        DB::statement('DROP TRIGGER IF EXISTS refunds_lifecycle_guard_hardened_trigger ON refunds');
        DB::statement('CREATE TRIGGER finance_refunds_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_corrections_settlement_guard() RETURNS trigger AS $fn$
            DECLARE
                obligation_amount numeric;
                allocated_amount numeric;
                reversed_allocations numeric;
                funded_amount numeric;
                reversed_funding numeric;
                approved_discounts numeric;
                decreased_amount numeric;
                increased_amount numeric;
                effective_amount numeric;
                settled_amount numeric;
            BEGIN
                -- A proposed correction is not a monetary fact yet. At the
                -- sole proposed -> recorded transition, protect the same
                -- derived remaining balance that Finance commands expose.
                IF OLD.lifecycle_state <> 'proposed'
                   OR NEW.lifecycle_state <> 'recorded'
                   OR NEW.correction_type <> 'obligation_adjustment'
                   OR NEW.direction <> 'decrease' THEN
                    RETURN NEW;
                END IF;

                SELECT original_amount
                  INTO obligation_amount
                  FROM obligations
                 WHERE id = NEW.obligation_id
                 FOR UPDATE;
                IF obligation_amount IS NULL THEN
                    RAISE EXCEPTION 'obligation decrease references an unknown obligation'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

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
                       SELECT pa.id
                         FROM payment_allocations pa
                        WHERE pa.obligation_id = NEW.obligation_id
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
                  INTO approved_discounts
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

                effective_amount := obligation_amount + increased_amount - decreased_amount - NEW.amount;
                settled_amount := allocated_amount - reversed_allocations
                    + funded_amount - reversed_funding
                    + approved_discounts;
                IF settled_amount > effective_amount THEN
                    RAISE EXCEPTION 'an obligation decrease cannot reduce the effective charge below already recorded settlement; reverse settlement first'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS financial_corrections_settlement_guard_trigger ON financial_corrections');
        DB::statement('CREATE TRIGGER financial_corrections_settlement_guard_trigger BEFORE UPDATE OF lifecycle_state ON financial_corrections FOR EACH ROW EXECUTE FUNCTION financial_corrections_settlement_guard()');
    }

    public function down(): void
    {
        // Restoring 000141's paired AFTER/BEFORE allocation topology would
        // knowingly reintroduce its double-counting settlement defect. Like
        // 000141, this convergence is one-way until a reviewed historical
        // baseline exists; never make rollback silently weaken Finance facts.
        throw new \RuntimeException('Finance settlement-guard convergence is one-way; restore from the reviewed pre-convergence baseline rather than reintroducing stacked triggers.');
    }
};
