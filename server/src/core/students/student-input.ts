/**
 * core/students/student-input.ts
 * ============================================================================
 * THE single normalization/validation authority for Student profile input.
 *
 * It exists because validation was previously split and inconsistent:
 *
 *  - STU-H1: `POST /students/manual` validated text lengths, gender and class
 *    references; `PATCH /students/:id` validated essentially nothing and
 *    merged raw body fields straight into the UPDATE. Measured live, PATCH
 *    accepted and PERSISTED values CREATE rejected with 400:
 *        gender "martian", a 5,000-character full_name, phone as an array.
 *    `gender` is load-bearing — `assertClassGenderAllowsStudent()` enforces
 *    gender-segregated classes, so a male student was refused entry to a
 *    female-only class, then admitted after a one-line PATCH. Gender-split
 *    reports also stopped reconciling (total 26 = male 24 + female 1).
 *
 *  - STU-H3: student phone uniqueness compared raw trimmed strings, so
 *    "0700-111-001" and "+93700111001" both created new students alongside an
 *    existing "0700111001". The correct normalizer already existed —
 *    `phoneMatchKey()` in core/visitors/duplicate-lookup.ts — but only the
 *    Visitor subsystem used it.
 *
 * Design notes
 * ------------
 * This mirrors the pattern the Visitor subsystem already proved:
 * `normalizeVisitorText()` is called from BOTH the POST and PATCH handlers in
 * visitors.routes.ts. Students now get the same treatment through this module,
 * so there is exactly one place where a Student field's rules live.
 *
 * Phone identity reuses `phoneMatchKey()` rather than reimplementing it —
 * constraint 3 of the remediation brief ("establish one domain authority for
 * phone identity normalization"). Importing the visitor module here is
 * deliberate: it is the existing authority, and duplicating its 9-digit-suffix
 * rule would recreate exactly the drift class this remediation is closing.
 * ============================================================================
 */
import { HttpError } from '../../middleware/errorHandler.js';
import { TEXT_LIMITS, assertTextLengths } from '../../utils/textInput.js';
import { phoneMatchKey } from '../visitors/duplicate-lookup.js';

export { phoneMatchKey };

/** Gender values the product supports. Matches the CREATE-path rule that
 *  already existed (`['male','female']`) and the gender-policy engine in
 *  classes.routes.ts (`assertClassGenderAllowsStudent`). */
export const STUDENT_GENDERS = ['male', 'female'] as const;
export type StudentGender = (typeof STUDENT_GENDERS)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an optional ISO date, rejecting both malformed strings and
 * impossible calendar dates such as "9999-99-99" (which PATCH persisted).
 * Same semantics as the visitor route's private helper.
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

/** Reject a non-string where a string is required — `phone: ["x"]` must not be
 *  coerced into the string "x" (CREATE rejected this; PATCH did not). */
function assertStringy(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be text.`);
  }
  return value;
}

export function assertStudentGender(value: unknown): StudentGender {
  if (typeof value !== 'string' || !(STUDENT_GENDERS as readonly string[]).includes(value)) {
    throw new HttpError(400, 'Invalid gender.');
  }
  return value as StudentGender;
}

/**
 * The full field list shared by CREATE and PATCH, with its length budget.
 * Keeping this as data (rather than an inline array in each route) is what
 * makes the two paths provably symmetric.
 */
const TEXT_FIELDS: ReadonlyArray<readonly [key: string, label: string, limit: number]> = [
  ['fullName', 'Full name', TEXT_LIMITS.name],
  ['fatherName', "Father's name", TEXT_LIMITS.name],
  ['phone', 'Phone', TEXT_LIMITS.short],
  ['whatsapp', 'WhatsApp', TEXT_LIMITS.short],
  ['tazkiraNo', 'Tazkira number', TEXT_LIMITS.short],
  ['email', 'Email', TEXT_LIMITS.email],
  ['addressRegion', 'Address', TEXT_LIMITS.line],
  ['schoolOrUniversity', 'School or university', TEXT_LIMITS.line],
  ['emergencyContactName', 'Emergency contact name', TEXT_LIMITS.name],
  ['emergencyContactPhone', 'Emergency contact phone', TEXT_LIMITS.short],
  ['notes', 'Notes', TEXT_LIMITS.notes],
];

export interface NormalizedStudentInput {
  /** Only the keys actually present in the payload, trimmed. */
  text: Record<string, string | null>;
  gender?: StudentGender;
  dob?: string | null;
}

/**
 * Normalize and validate a Student payload.
 *
 * `mode: 'create'` enforces the required fields; `mode: 'patch'` validates
 * only what was supplied but applies the IDENTICAL rules to those fields.
 * That asymmetry-of-presence (not of rules) is the whole point: PATCH must
 * never accept a value CREATE would reject.
 */
export function normalizeStudentInput(
  body: Record<string, unknown>,
  mode: 'create' | 'patch',
): NormalizedStudentInput {
  const out: NormalizedStudentInput = { text: {} };

  // 1. Type-check every supplied text field before anything else, so a
  //    non-string can never be coerced downstream.
  const lengthChecks: Array<[unknown, string, number]> = [];
  for (const [key, label, limit] of TEXT_FIELDS) {
    if (body[key] === undefined) continue;
    const raw = assertStringy(body[key], label);
    const trimmed = raw === null ? null : raw.trim();
    out.text[key] = trimmed === '' ? null : trimmed;
    lengthChecks.push([trimmed, label, limit]);
  }

  // 2. Bound them. Reuses the existing shared helper so the 400 wording is
  //    identical to every other subsystem's.
  assertTextLengths(lengthChecks as Parameters<typeof assertTextLengths>[0]);

  // 3. Required fields — CREATE only.
  if (mode === 'create') {
    const name = out.text.fullName;
    if (!name) throw new HttpError(400, 'Full name and gender are required.');
    if (body.gender === undefined || body.gender === null || body.gender === '') {
      throw new HttpError(400, 'Full name and gender are required.');
    }
    if (!out.text.phone) throw new HttpError(400, 'Phone is required.');
  } else {
    // A PATCH may not blank a required field either.
    if (body.fullName !== undefined && !out.text.fullName) {
      throw new HttpError(400, 'Full name cannot be empty.');
    }
    if (body.phone !== undefined && !out.text.phone) {
      throw new HttpError(400, 'Phone cannot be empty.');
    }
  }

  // 4. Gender — same rule both ways. This is the edge that let a male student
  //    into a female-only class and that broke gender-split reporting.
  if (body.gender !== undefined) {
    out.gender = assertStudentGender(body.gender);
  }

  // 5. Date of birth — real calendar dates only, both ways.
  if (body.dob !== undefined) {
    out.dob = assertOptionalIsoDate(body.dob, 'Date of birth');
  }

  return out;
}

/**
 * Canonical identity key for a student phone number.
 *
 * Delegates to the existing `phoneMatchKey()` authority (digits only, last 9,
 * so the national leading zero and the +93 country code compare equal).
 * Returns null when there is nothing comparable, in which case callers must
 * NOT treat it as a uniqueness match — a missing key is not a collision.
 */
export function studentPhoneKey(phone: string | null | undefined): string | null {
  return phoneMatchKey(phone);
}
