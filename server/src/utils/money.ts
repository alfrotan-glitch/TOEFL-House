import { HttpError } from '../middleware/errorHandler.js';

/**
 * THE money boundary for this system.
 * ============================================================================
 * CANONICAL REPRESENTATION: a whole number of Afghani, held as a JavaScript
 * integer. AFN is the only currency (decision D-11) and there is no exchange
 * rate, no second currency and no sub-unit anywhere in the domain.
 *
 * WHY WHOLE AFN, not two decimal places or minor units. This is not a
 * preference; it is what the system already does, established from three
 * independent places:
 *
 *   1. Every amount is DISPLAYED with no decimals — `formatAFN` in
 *      src/utils/format.ts uses maximumFractionDigits: 0, so a sub-unit has
 *      never been visible to any user.
 *   2. Every computation that PRODUCES money already rounds to a whole
 *      afghani before storing it: percentage discounts
 *      (`Math.round((fee * percent) / 100)`), payroll
 *      (`Math.round(baseSalary * perfMultiplier)`), the BOS withdrawal
 *      allowance, and book purchase pricing.
 *   3. Nothing in the schema, the routes or the UI refers to the pul
 *      sub-unit.
 *
 * The old two-decimal storage was therefore a representation the business
 * never used, and holding it in a REAL made every total a floating-point sum.
 * A displayed total could differ from the sum of its displayed parts while
 * both were "correct" — the defect tracked as TR-2, now closed.
 *
 * TWO DISTINCT OPERATIONS, deliberately not merged:
 *
 *   assertMoney()         validates OPERATOR INPUT. A fractional amount is
 *                         REJECTED, never silently rounded. Quietly turning a
 *                         typed 24000.50 into 24001 stores a figure nobody
 *                         entered, which is the silent-substitution failure
 *                         LAW 6 forbids. This extends the policy the fee and
 *                         invoice writers already applied ("reject rather than
 *                         silently round") to every money boundary.
 *
 *   assertComputedMoney() canonicalises a value the SYSTEM derived — a
 *                         percentage discount, a payroll multiple, a profit
 *                         share. Those are genuinely fractional before they
 *                         are settled, so they round, half away from zero,
 *                         exactly once, here.
 *
 * Rounding therefore has exactly one implementation and one legitimate
 * trigger. A caller that rounds money itself is creating a second authority.
 *
 * Throws HttpError(400): a malformed amount is INVALID CLIENT INPUT, not a
 * server fault.
 *
 * TYPE DISCIPLINE
 * ---------------
 * `Number(value)` is a coercion, not a parse, and quietly accepts values that
 * are not amounts:
 *
 *     Number('')      === 0        Number(null) === 0
 *     Number('   ')   === 0        Number([])   === 0
 *     Number([5])     === 5        Number(true) === 1
 *     Number('0x10')  === 16
 *
 * Every one of those turns a client mistake into a silent, plausible-looking
 * charge — an empty form field becoming a legitimate 0 AFN is exactly how a
 * free enrolment gets written without anyone deciding to grant one.
 *
 * Accepted: a finite `number`, or a `string` that is a plain decimal numeral
 * (optionally signed, optional single decimal point, surrounding whitespace
 * tolerated). Everything else is refused, `undefined`/`null` included: a
 * caller that wants "missing means zero" must say so with `?? 0`, which is
 * visible at the call site.
 */

/** A plain decimal numeral: 42, -42, 42.5, .5, 42. — no hex, no exponent, no separators. */
const DECIMAL_NUMERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The largest single amount this system will accept.
 *
 * The hard technical limit is Number.MAX_SAFE_INTEGER, beyond which integer
 * arithmetic silently stops being exact — and for money, silently wrong. A
 * single amount is capped two orders of magnitude below that so AGGREGATES
 * stay exact too: totals, balances and reconciliation sums add many rows
 * together, and a ceiling equal to the per-value limit would make the very
 * first SUM() unsafe. The factor of 100 leaves room for a hundred
 * maximum-valued rows to sum exactly.
 *
 * This is deliberately the same effective ceiling the two-decimal
 * representation had (it capped values at MAX_SAFE_INTEGER/100 as a
 * side-effect of scaling by 100). Keeping it means the change of
 * representation removes no protection that existed before.
 */
export const MAX_MONEY = Math.floor(Number.MAX_SAFE_INTEGER / 100);

/**
 * Rounds to the canonical unit: a whole afghani, half away from zero.
 *
 * Half away from zero rather than JavaScript's `Math.round` (which is half
 * UP, so -0.5 becomes -0) keeps a refund of 0.5 and a charge of 0.5 the same
 * magnitude. Symmetry matters when a contra entry must exactly reverse an
 * original.
 */
export function roundMoney(n: number): number {
  const r = n < 0 ? -Math.round(-n) : Math.round(n);
  return Object.is(r, -0) ? 0 : r;
}

export function assertMoney(value: unknown, field = 'amount', opts: { allowNegative?: boolean } = {}): number {
  let n: number;

  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // An empty or whitespace-only string is a missing value, not zero.
    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {
      throw new HttpError(400, `${field} must be a finite number.`);
    }
    n = Number(trimmed);
  } else {
    // Booleans, arrays, objects, null and undefined are never amounts.
    throw new HttpError(400, `${field} must be a finite number.`);
  }

  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a finite number.`);
  if (!opts.allowNegative && n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number of AFN.`);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_MONEY) {
    throw new HttpError(400, `${field} exceeds supported monetary precision.`);
  }
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Settles a value the SYSTEM computed into the canonical unit.
 *
 * Use only where the fractional part is an artifact of arithmetic the domain
 * legitimately performs (percentages, multipliers, shares) — never to accept a
 * fractional figure a person typed.
 */
export function assertComputedMoney(value: number, field = 'amount', opts: { allowNegative?: boolean } = {}): number {
  if (!Number.isFinite(value)) throw new HttpError(400, `${field} must be a finite number.`);
  if (!opts.allowNegative && value < 0) throw new HttpError(400, `${field} cannot be negative.`);
  const whole = roundMoney(value);
  if (!Number.isSafeInteger(whole) || Math.abs(whole) > MAX_MONEY) {
    throw new HttpError(400, `${field} exceeds supported monetary precision.`);
  }
  return whole;
}

/**
 * Seat-count boundary (class audit C-3).
 *
 * Capacity and minimum-viable-size are COUNTS OF PEOPLE, not money: they must
 * be whole, non-negative and small enough to be meaningful. This lived nowhere
 * before, so `PUT /api/classes/:id` stored `capacity: 7.5` verbatim — and a
 * fractional capacity is not a harmless cosmetic value: `activeCount >= 7.5`
 * admits 8 students to a "7.5-seat" class, and `capacity: 2.5` was observed
 * admitting 3. `1e15` was equally accepted, making the capacity gate
 * meaningless.
 *
 * Deliberately a separate rule from assertMoney: money is whole-AFN only but
 * unbounded, a seat is a small whole count. Zero remains legal and keeps its
 * established meaning
 * throughout this codebase — "no configured limit" (every capacity gate is
 * written `capacity > 0 && ...`), which is why zero is not rejected here.
 */
const MAX_SEAT_COUNT = 100000;

/**
 * Performance-score boundary (teacher audit T-2).
 *
 * `Math.max(0, Math.min(100, Number(performanceScore)))` is a CLAMP, not a
 * validation. Applied at `PUT /api/teachers/:id` it has three consequences,
 * all reproduced live:
 *   - `5000` returned 200 and silently stored 100
 *   - `-20`  returned 200 and silently stored 0
 *   - `'abc'` became NaN and reached the database, surfacing as HTTP 500
 * A clamp answers 200 while storing something the caller never sent, so the
 * caller believes a value was accepted that was in fact rewritten.
 *
 * RANGE: 0..100. The upper bound is the 100-point evaluation scale used by
 * `POST /:id/evaluation`. Zero is the established "not yet evaluated" sentinel:
 * `POST /api/teachers` hardcodes `performance_score = 0` for every new teacher
 * precisely so that no half-appraisal is fabricated. Zero is therefore a legal
 * stored state and is accepted here.
 *
 * `allowZero: false` expresses the stricter rule an evaluation EVENT needs — a
 * recorded appraisal of zero is not the same thing as "never appraised". That
 * option exists so the two rules can share one type-discipline implementation;
 * the evaluation endpoint itself is deliberately left unchanged (finding T-3).
 *
 * Deliberately separate from assertMoney: a score has no currency precision and
 * a hard upper bound, neither of which money has.
 */
export function assertPerformanceScore(
  value: unknown,
  field = 'Performance score',
  opts: { allowZero?: boolean } = {},
): number {
  const { allowZero = true } = opts;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // Same type discipline as assertMoney: '' is a missing value, not zero,
    // and booleans/arrays/objects/null are never scores.
    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {
      throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);
    }
    n = Number(trimmed);
  } else {
    throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);
  }
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (n > 100) throw new HttpError(400, `${field} cannot exceed 100.`);
  if (!allowZero && n === 0) throw new HttpError(400, `${field} must be greater than zero.`);
  return n;
}

/**
 * Percentage boundary.
 *
 * A percentage is not money (it has no currency precision) and not a score (it
 * has no fixed 100-point scale — a category ceiling may be lower). It is its
 * own boundary, and it exists once so the savings rate, a discount grant and
 * any future rate cannot each decide what `[10]`, `true`, `''` or `null` mean.
 * `Number()` reads those as 10, 1, 0 and 0 respectively, which is how a value
 * nobody entered becomes a rate that moves money.
 *
 * Fractional percentages are accepted: a 2.5% sweep and a 12.5% discount are
 * both legitimate, and the values they produce are settled by
 * `assertComputedMoney` at the point money is derived.
 */
export function assertPercent(value: unknown, field = 'Percentage', opts: { max?: number } = {}): number {
  const max = opts.max ?? 100;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {
      throw new HttpError(400, `${field} must be a number between 0 and ${max}.`);
    }
    n = Number(trimmed);
  } else {
    throw new HttpError(400, `${field} must be a number between 0 and ${max}.`);
  }
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new HttpError(400, `${field} must be a number between 0 and ${max}.`);
  }
  return n;
}

/**
 * The largest day offset that still produces a valid JavaScript Date.
 *
 * ECMAScript clamps a time value to +/-8.64e15 ms (about 100,000,000 days
 * either side of the epoch); anything beyond that is an Invalid Date. This is a
 * TECHNICAL ceiling derived from the language, deliberately NOT an invented
 * business maximum for how long an invoice may remain payable.
 */
const MAX_DAY_OFFSET = 100_000_000;

/**
 * A whole number of days, for offsetting a date (finding INV-1).
 *
 * `invoice_due_days` accepting anything that passes `Number(x) >= 0` stores
 * 1e20 happily and then breaks every invoice creation and issue with
 * HTTP 500 "Invalid time value" — a persistent denial of service that only an
 * owner/manager could clear. Rejecting at the write keeps the failure visible
 * and local.
 *
 * Same type discipline as assertMoney and assertSeatCount: '' is a missing
 * value rather than zero, and booleans/arrays/objects/null are never day
 * counts. Deliberately separate from assertMoney — a day count has no currency
 * precision — and separate from assertSeatCount, whose ceiling and wording are
 * about seats.
 */
export function assertDayOffset(value: unknown, field = 'Days'): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {
      throw new HttpError(400, `${field} must be a whole number of days.`);
    }
    n = Number(trimmed);
  } else {
    throw new HttpError(400, `${field} must be a whole number of days.`);
  }
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a whole number of days.`);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number of days.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (n > MAX_DAY_OFFSET) {
    throw new HttpError(400, `${field} exceeds the maximum supported value (${MAX_DAY_OFFSET}).`);
  }
  return n;
}

export function assertSeatCount(value: unknown, field = 'Count'): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {
      throw new HttpError(400, `${field} must be a whole number.`);
    }
    n = Number(trimmed);
  } else {
    throw new HttpError(400, `${field} must be a whole number.`);
  }
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a whole number.`);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (n > MAX_SEAT_COUNT) throw new HttpError(400, `${field} exceeds the maximum supported value (${MAX_SEAT_COUNT}).`);
  return n;
}
