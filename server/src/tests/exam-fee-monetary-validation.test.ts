/**
 * Exam fees are money and must clear the same validation bar as every other
 * monetary input in the system.
 * ============================================================================
 * DEFECT CLASS: silent financial coercion — a money field that skips the
 * shared `assertMoney` invariant and hand-rolls `Math.max(0, Number(x ?? 0))`.
 *
 * Reproduced against the live API before the fix (POST /api/exams):
 *
 *     fee "abc"    -> 500-class "NOT NULL constraint failed: exams.fee"
 *                     (a raw SQLite error leaked to the caller)
 *     fee 1e309    -> stored as NULL
 *     fee -500     -> silently stored as 0, i.e. a free exam
 *     fee 0.001    -> accepted as a sub-cent fee
 *
 * None of these raised a validation error, because the route coerced instead
 * of asserting. The fix routes both the create and update handlers through
 * `assertMoney`, which is what the payment, refund, and treasury paths already
 * use. These tests call the exported validator directly so they pin the
 * invariant itself rather than one route's wiring.
 */
import { describe, it, expect } from 'vitest';
import { assertMoney } from '../utils/money.js';

/** Mirrors how exams.routes.ts now resolves a submitted fee. */
const resolveExamFee = (fee: unknown) => assertMoney(fee ?? 0, 'exam fee');

describe('exam fee monetary validation', () => {
  it('rejects non-numeric text instead of leaking a database constraint error', () => {
    expect(() => resolveExamFee('abc')).toThrow(/finite number/i);
  });

  it('rejects values beyond the float range instead of storing NULL', () => {
    expect(() => resolveExamFee('1e309')).toThrow(/finite number/i);
    expect(() => resolveExamFee(Infinity)).toThrow(/finite number/i);
  });

  it('rejects a negative fee instead of silently making the exam free', () => {
    expect(() => resolveExamFee(-500)).toThrow(/negative/i);
  });

  it('rejects amounts beyond supported monetary precision', () => {
    expect(() => resolveExamFee(1e15)).toThrow(/precision/i);
  });

  it('accepts a normal fee unchanged', () => {
    expect(resolveExamFee(1500)).toBe(1500);
    expect(() => resolveExamFee('750.25')).toThrow(/whole number/i);
  });

  it('treats a missing fee as zero rather than throwing', () => {
    // A free exam is legitimate; only invalid input is refused.
    expect(resolveExamFee(undefined)).toBe(0);
    expect(resolveExamFee(null)).toBe(0);
  });

  it('refuses sub-unit input rather than charging a different amount', () => {
    // Consistent with every other money path: a fractional fee is not a
    // representable amount, so it is refused rather than quietly charged as a
    // different figure.
    expect(() => resolveExamFee(0.001)).toThrow(/whole number/i);
    expect(() => resolveExamFee(10.006)).toThrow(/whole number/i);
  });
});
