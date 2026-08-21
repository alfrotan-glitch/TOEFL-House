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

describe('visitor conversion validates money', () => {
  it('rejects a non-numeric semester fee instead of leaking a DB constraint error', () => {
    expect(() => resolveFee('abc', null)).toThrow(/finite number/i);
  });

  it('rejects a negative semester fee that would create a negative invoice', () => {
    expect(() => resolveFee(-6000, null)).toThrow(/negative/i);
  });

  it('rejects a non-numeric amount paid', () => {
    // NaN < 0 is false, which is exactly why the old guard let this through.
    expect(Number.isNaN(Number('abc'))).toBe(true);
    expect(Number('abc') < 0).toBe(false);
    expect(() => resolvePaid('abc')).toThrow(/finite number/i);
  });

  it('rejects a negative amount paid', () => {
    expect(() => resolvePaid(-1)).toThrow(/negative/i);
  });

  it('rejects amounts beyond supported monetary precision', () => {
    expect(() => resolvePaid(1e15)).toThrow(/precision/i);
    expect(() => resolveFee('1e309', null)).toThrow(/finite number/i);
  });

  it('refuses payment collected against a zero-fee enrolment', () => {
    // The old guard was `paid > net && net > 0`, so a 0 fee accepted any sum.
    expect(overpays(50_000, 0)).toBe(true);
    // And the shipped route must not carry that escape hatch back.
    expect(visitorRouteSource).toContain('if (paidNow > netTuition)');
    expect(visitorRouteSource).not.toContain('paidNow > netTuition && netTuition > 0');
  });

  it('the route runs both money figures through assertMoney', () => {
    expect(visitorRouteSource).toContain("assertMoney(amountPaid, 'received fee amount')");
    expect(visitorRouteSource).toContain("'semester fee')");
    // The coercion that started all of this must not return.
    expect(visitorRouteSource).not.toContain('Number(amountPaid) < 0');
  });

  it('still refuses ordinary overpayment', () => {
    expect(overpays(9_000, 6_000)).toBe(true);
  });

  it('allows a legitimate partial payment and an exact payment', () => {
    expect(overpays(5_000, 6_000)).toBe(false);
    expect(overpays(6_000, 6_000)).toBe(false);
  });

  it('falls back to the class fee when no semester fee is supplied', () => {
    expect(resolveFee(null, 6_000)).toBe(6_000);
    expect(resolveFee(undefined, undefined)).toBe(0);
  });
});
