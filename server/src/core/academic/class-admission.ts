/**
 * Class admission rules — the single domain authority for "may this student
 * occupy a seat in this class?" checks that are not capacity and not placement.
 *
 * Why this module exists (enrollment audit E-1): the gender policy is a domain
 * rule, so it lives with the domain rather than in `classes.routes.ts`. Route-level enforcement meant every
 * new write path had to remember to repeat it, and one did not — the
 * transfer-request approval path (`POST /api/enrollments/:id/transfer-requests`)
 * called `EnrollmentService.transfer()` directly and therefore admitted a male
 * student into a female-only class (HTTP 201, proven live).
 *
 * The rule now lives here, in the domain layer, so the service can enforce it
 * for every path. `classes.routes.ts` keeps its historical
 * `assertClassGenderAllowsStudent` export but delegates to this function, so
 * there is exactly ONE implementation of the rule.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { ACTIVE_ENROLLMENT_STATUSES } from './class-capacity.js';

export interface ClassGenderRow {
  gender_policy?: string | null;
  name: string;
}

/**
 * Reject admission when the student's gender conflicts with the class
 * `gender_policy`. A 'mixed' policy (the default) admits everyone.
 */
export function assertClassGenderAllows(
  cls: ClassGenderRow | undefined,
  studentGender: string | null | undefined,
): void {
  if (!cls) throw new HttpError(404, 'Class not found.');

  const policy = cls.gender_policy || 'mixed';
  if (policy === 'mixed') return;

  const g = (studentGender || '').toLowerCase();
  if (policy === 'female' && g !== 'female') {
    throw new HttpError(400, `Class "${cls.name}" is for female students only.`);
  }
  if (policy === 'male' && g !== 'male') {
    throw new HttpError(400, `Class "${cls.name}" is for male students only.`);
  }
}

/**
 * DUPLICATE ENROLLMENT RULE (audit E-2) — the single definition.
 *
 * THE UNIQUENESS DIMENSION, established from behaviour rather than from the
 * pre-existing index. A student may hold at most ONE seat-consuming enrollment
 * in a given class FOR A GIVEN SEMESTER.
 *
 * Why the key includes the semester and is not simply (student, class):
 * enrolling the same student in the same class for consecutive terms is a
 * supported, financially material flow. `POST /students/:id/enroll-semester`
 * exists precisely to do it, and `balance-single-source-of-truth.test.ts`
 * pins the resulting money — 'Term One' 20,000 + 'Term Two' 30,000 in one
 * class must produce a 50,000 lifetime tuition. A (student, class) key
 * rejects that second term with a 409 and silently destroys 30,000 AFN of
 * billable revenue. Keying on (student, class, semester) blocks true
 * duplicates while leaving sequential terms legal.
 *
 * "Seat-consuming" is the same status set the capacity predicate counts
 * (`ACTIVE_ENROLLMENT_STATUSES`): if a row counts against class capacity it is
 * a seat. Closed rows (transferred / dropped / withdrawn / completed /
 * graduated) are history and are deliberately not constrained, so repeating a
 * class the student left earlier stays legal.
 *
 * Backed by the partial UNIQUE index in migration 074 so the invariant holds
 * under a race; this function turns that constraint into a clean 409 instead of
 * a raw SQLITE_CONSTRAINT error.
 */
export function assertNoDuplicateSeatEnrollment(
  db: BetterSqlite3.Database,
  studentId: string,
  classId: string | null | undefined,
  semesterName: string | null | undefined,
): void {
  if (!classId) return;
  const existing = db
    .prepare(
      `SELECT id FROM enrollments
        WHERE student_id = ? AND class_id = ?
          AND IFNULL(semester_name, '') = IFNULL(?, '')
          AND status IN (${ACTIVE_ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(', ')})
        LIMIT 1`,
    )
    .get(studentId, classId, semesterName ?? null) as { id: string } | undefined;
  if (existing) throw new HttpError(409, 'Already enrolled in this class.');
}

/**
 * Stricter companion to {@link assertNoDuplicateSeatEnrollment}: reject when the
 * student already occupies ANY seat in this class, whatever the semester.
 *
 * This is the admission rule for operations that add a student to a class they
 * are not currently attending — the extra-class ("concurrent enrollment") route
 * and transfer. Sitting in a class you are already actively enrolled in is
 * meaningless for both, so the semester is not part of the question.
 *
 * It is deliberately NOT the universal invariant: `enroll-semester` legitimately
 * re-enrolls a student into the same class for a following term, which is why
 * the DB-level constraint is keyed on (student, class, semester) instead. Both
 * rules live here so the scopes stay visible side by side rather than drifting
 * apart in separate route files.
 */
export function assertNotAlreadySeatedInClass(
  db: BetterSqlite3.Database,
  studentId: string,
  classId: string | null | undefined,
): void {
  if (!classId) return;
  const existing = db
    .prepare(
      `SELECT id FROM enrollments
        WHERE student_id = ? AND class_id = ?
          AND status IN (${ACTIVE_ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(', ')})
        LIMIT 1`,
    )
    .get(studentId, classId) as { id: string } | undefined;
  if (existing) throw new HttpError(409, 'Already enrolled in this class.');
}

/** Database-reading convenience wrapper around {@link assertClassGenderAllows}. */
export function assertClassGenderAllowsById(
  db: BetterSqlite3.Database,
  classId: string,
  studentGender: string | null | undefined,
): void {
  const cls = db
    .prepare('SELECT gender_policy, name FROM classes WHERE id = ?')
    .get(classId) as ClassGenderRow | undefined;
  assertClassGenderAllows(cls, studentGender);
}
