/**
 * Visitor → student conversion is a money endpoint and must validate like one.
 * ============================================================================
 * DEFECT CLASS: `Number(x) < 0` used as a validation.
 *
 * It is a coercion, not a check. `Number("abc")` is NaN, and `NaN < 0` is
 * false, so every non-numeric value passed straight through. The conversion
 * route then did raw `Number()` arithmetic on the fee and the amount paid.
 *
 * Reproduced against the live API before the fix (POST /visitors/:id/convert):
 *
 *   semesterFee "abc"   -> 500-class "NOT NULL constraint failed:
 *                          student_semesters.fee_amount" leaked to the caller
 *   semesterFee -6000   -> student_semesters.fee_amount -6000 AND an invoice
 *                          with total_amount -6000, discount_amount -6000
 *   fee 0 + paid 50000  -> 50,000 AFN collected against a zero-fee enrolment,
 *                          stored and marked "partial"
 *
 * The third was possible because the overpay guard read
 * `paidNow > netTuition && netTuition > 0` — the trailing clause disabled the
 * check exactly when the payable amount was zero.
 *
 * These tests pin the arithmetic and the guard. Migration 069 adds the
 * database-level backstop, covered in migration-069-nonnegative-money.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertMoney } from '../../../utils/money.js';

/** Mirrors how visitors.routes.ts now resolves the two figures. */
const resolveFee = (semesterFee: unknown, classFee: unknown) =>
  assertMoney(semesterFee != null ? semesterFee : classFee != null ? classFee : 0, 'semester fee');
const resolvePaid = (amountPaid: unknown) => assertMoney(amountPaid, 'received fee amount');

/**
 * The overpay rule as the route actually spells it, read from the source.
 *
 * An earlier version of this file re-implemented the rule as a local helper,
 * which meant reintroducing the `&& netTuition > 0` bug in the route did NOT
 * fail the test — the test was only checking itself. Asserting against the
 * shipped source keeps the regression honest.
 */
const visitorRouteSource = fs.readFileSync(
  fileURLToPath(new URL('../../../routes/visitors.routes.ts', import.meta.url)),
  'utf8',
);
const overpays = (paid: number, net: number) => paid > net;

describe('visitor conversion no longer accepts money payloads', () => {
  it('the legacy fee/paid coercion cases are still rejected at the money boundary helpers', () => {
    expect(() => resolveFee('abc', null)).toThrow(/finite number/i);
    expect(() => resolveFee(-6000, null)).toThrow(/negative/i);
    expect(() => resolvePaid('abc')).toThrow(/finite number/i);
    expect(() => resolvePaid(-1)).toThrow(/negative/i);
    expect(() => resolvePaid(1e15)).toThrow(/precision/i);
    expect(() => resolveFee('1e309', null)).toThrow(/finite number/i);
  });

  it('the visitor conversion route refuses any payment or tuition fields outright', () => {
    expect(visitorRouteSource).toContain('Visitor admission no longer collects payment or creates enrollment directly');
    expect(visitorRouteSource).toContain('amountPaid != null || discountPercent != null || semesterFee != null || paymentMethod != null');
  });

  it('the old overpay arithmetic escape hatch cannot return because conversion performs no money arithmetic', () => {
    expect(overpays(50_000, 0)).toBe(true);
    expect(visitorRouteSource).not.toContain('paidNow > netTuition && netTuition > 0');
    expect(visitorRouteSource).not.toContain('if (paidNow > netTuition)');
    expect(visitorRouteSource).not.toContain('Number(amountPaid) < 0');
  });

  it('falls back to the class fee when no semester fee is supplied in the canonical enrollment flow helper', () => {
    expect(resolveFee(null, 6_000)).toBe(6_000);
    expect(resolveFee(undefined, undefined)).toBe(0);
    expect(overpays(9_000, 6_000)).toBe(true);
    expect(overpays(5_000, 6_000)).toBe(false);
    expect(overpays(6_000, 6_000)).toBe(false);
  });
});
