/**
 * Text field bounds — shared input hardening.
 * ============================================================================
 * S16: no route bounded the LENGTH of a free-text field. `POST /students/manual`
 * accepted a 1,000,000-character `fullName` and stored it verbatim; the only
 * thing that ever refused was Express's own body-size limit at ~5 MB, and it
 * answered 500 "request entity too large" rather than a 400.
 *
 * That is three problems in one:
 *   - a roster page of 2,000 such rows is gigabytes of JSON, so a single
 *     malicious record degrades every list endpoint that returns it;
 *   - SQLite stores it happily, so the damage persists;
 *   - the failure mode at the outer boundary is a server error, which hides a
 *     client mistake and pollutes error monitoring.
 *
 * These helpers give every text field an explicit, documented ceiling and
 * always fail as HTTP 400.
 */
import { HttpError } from '../middleware/errorHandler.js';

/** Ceilings chosen to be generous for real Afghan/English data, yet bounded. */
export const TEXT_LIMITS = {
  /** Person and entity names. */
  name: 200,
  /** Phone numbers, codes, identifiers. */
  short: 60,
  /** Email addresses. */
  email: 254,
  /** Addresses, single-line descriptive fields. */
  line: 500,
  /** Notes, descriptions, reasons — multi-line free text. */
  notes: 5000,
} as const;

/**
 * Validate and normalise an optional text field.
 * Returns the trimmed value, or null when absent/blank.
 */
export function optionalText(
  value: unknown,
  field: string,
  maxLength: number = TEXT_LIMITS.line,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be text.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Validate and normalise a required text field.
 * Throws 400 when missing, blank, non-string, or over the ceiling.
 */
export function requiredText(
  value: unknown,
  field: string,
  maxLength: number = TEXT_LIMITS.name,
): string {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new HttpError(400, `${field} is required.`);
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Bound a batch of already-extracted optional fields in one call.
 * Each entry is [value, fieldLabel, maxLength].
 * Returns nothing — it is a guard, used for its throw.
 */
export function assertTextLengths(
  fields: Array<[unknown, string, number?]>,
): void {
  for (const [value, field, maxLength] of fields) {
    optionalText(value, field, maxLength ?? TEXT_LIMITS.line);
  }
}
