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
