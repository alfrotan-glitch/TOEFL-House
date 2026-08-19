/**
 * Canonical calendar-date validation for stored Gregorian `YYYY-MM-DD` values.
 * ============================================================================
 * The database stores Gregorian ISO dates as TEXT because 77+ SQL queries rely
 * on those strings sorting chronologically (see `utils/jalali.ts`). A malformed
 * value ("9999-99-99", "not-a-date", "") stored verbatim therefore silently
 * loses every subsequent date comparison it takes part in.
 *
 * This module is the single authority for that check. It deliberately does NOT
 * introduce a second calendar system: Shamsi/Jalali conversion stays in
 * `utils/jalali.ts` on the client edge, and what reaches the API is already the
 * Gregorian ISO string the database expects.
 */
import { HttpError } from '../middleware/errorHandler.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an optional calendar date.
 *
 * Returns `null` for absent values (`undefined`, `null`, `''`) so callers can
 * distinguish "not supplied" from a real date. Throws `HttpError(400)` when a
 * value is supplied but is not a real calendar date — rejecting both bad shapes
 * ("not-a-date") and impossible days ("2026-02-30").
 */
export function assertOptionalIsoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) {
    throw new HttpError(400, `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  const iso = value.trim();
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new HttpError(400, `${field} is not a real calendar date.`);
  }
  return iso;
}

/**
 * Enforce that a period's end is not before its start.
 *
 * Equal dates are ACCEPTED. That is not a stylistic choice: session generation
 * compares `date < termFrom` / `date > termTo` (sessions.routes.ts), so the
 * stored range is inclusive on both ends and `start === end` denotes a valid
 * single-day term. Rejecting it would forbid a range the engines handle
 * correctly. Only `end < start` is impossible, and it yields a term that can
 * never produce a session.
 */
export function assertDateRange(
  startDate: string | null,
  endDate: string | null,
  startField = 'startDate',
  endField = 'endDate'
): void {
  if (startDate && endDate && endDate < startDate) {
    throw new HttpError(400, `${endField} cannot be earlier than ${startField}.`);
  }
}
