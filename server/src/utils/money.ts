import { HttpError } from '../middleware/errorHandler.js';

/** High-assurance monetary boundary validation while preserving current AFN
 *  schema compatibility.
 *
 *  Throws HttpError(400): a malformed amount is INVALID CLIENT INPUT, not a
 *  server fault. Previously this threw a plain Error, so posting an invoice
 *  line without unitPrice returned 500 — which hides a user-correctable
 *  mistake behind an alarming "server error" and pollutes error monitoring.
 *
 *  TYPE DISCIPLINE (added after auditing the boundary itself)
 *  ---------------------------------------------------------
 *  The original implementation delegated straight to `Number(value)`, which is
 *  a coercion, not a parse, and quietly accepted values that are not amounts:
 *
 *      assertMoney('')      -> 0        Number('')     === 0
 *      assertMoney('   ')   -> 0        whitespace     === 0
 *      assertMoney(null)    -> 0        Number(null)   === 0
 *      assertMoney([])      -> 0        Number([])     === 0
 *      assertMoney([5])     -> 5        single-element array unwraps
 *      assertMoney(true)    -> 1        booleans are numeric in JS
 *      assertMoney('0x10')  -> 16       hex literals parse
 *
 *  Every one of those turns a client mistake into a silent, plausible-looking
 *  charge — an empty form field becoming a legitimate 0 AFN is exactly how a
 *  free enrolment gets written without anyone deciding to grant one. This is
 *  the same fail-open class as the `NaN < 0` guards found in the routes, just
 *  one layer deeper, so it is fixed here rather than in each caller.
 *
 *  Accepted now: a finite `number`, or a `string` that is a plain decimal
 *  numeral (optionally signed, optional single decimal point, surrounding
 *  whitespace tolerated). Everything else is refused. `undefined`/`null` are
 *  refused too: a caller that wants "missing means zero" must say so
 *  explicitly with `?? 0`, which is visible at the call site.
 */

/** A plain decimal numeral: 42, -42, 42.5, .5, 42. — no hex, no exponent, no separators. */
const DECIMAL_NUMERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

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
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (!Number.isSafeInteger(Math.round(Math.abs(rounded) * 100))) throw new HttpError(400, `${field} exceeds supported monetary precision.`);
  return Object.is(rounded, -0) ? 0 : rounded;
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
 * Deliberately separate from assertMoney: money allows two decimal places,
 * a seat does not. Zero remains legal and keeps its established meaning
 * throughout this codebase — "no configured limit" (every capacity gate is
 * written `capacity > 0 && ...`), which is why zero is not rejected here.
 */
const MAX_SEAT_COUNT = 100000;

/**
 * Performance-score boundary (teacher audit T-2).
 *
 * `PUT /api/teachers/:id` previously did
 * `Math.max(0, Math.min(100, Number(performanceScore)))`, which is a CLAMP, not
 * a validation. Three consequences, all reproduced live:
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
  if (n > 100) throw new HttpError(400, `${field} cannot exceed 100.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (!allowZero && n === 0) throw new HttpError(400, `${field} must be greater than zero.`);
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
 * A whole number of days used to offset a date (finding INV-1).
 *
 * `invoice_due_days` previously accepted anything passing `Number(x) >= 0`, so
 * 1e20 was stored happily and then broke every invoice creation and issue with
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
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number of seats.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (n > MAX_SEAT_COUNT) throw new HttpError(400, `${field} exceeds the maximum supported value (${MAX_SEAT_COUNT}).`);
  return n;
}
