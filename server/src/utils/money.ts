import { HttpError } from '../middleware/errorHandler.js';

/** High-assurance monetary boundary validation while preserving current AFN
 *  schema compatibility.
 *
 *  Throws HttpError(400): a malformed amount is INVALID CLIENT INPUT, not a
 *  server fault. Previously this threw a plain Error, so posting an invoice
 *  line without unitPrice returned 500 — which hides a user-correctable
 *  mistake behind an alarming "server error" and pollutes error monitoring.
 */
export function assertMoney(value: unknown, field = 'amount', opts: { allowNegative?: boolean } = {}): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a finite number.`);
  if (!opts.allowNegative && n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (!Number.isSafeInteger(Math.round(Math.abs(rounded) * 100))) throw new HttpError(400, `${field} exceeds supported monetary precision.`);
  return Object.is(rounded, -0) ? 0 : rounded;
}
