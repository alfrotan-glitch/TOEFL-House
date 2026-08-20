/**
 * core/students/student-lifecycle.ts
 * ============================================================================
 * THE single authority for the Student profile lifecycle.
 *
 * It exists because the lifecycle previously had more than one writer:
 *
 *  - STU-C1: `students.status` had TWO writers. `PATCH /students/:id/status`
 *    enforced a (partial) rule set while `POST /students/:id/journey/events`
 *    wrote the same column with no transition validation at all, and — unlike
 *    the real suspend/resume workflow — left enrollments and semesters active.
 *    A student could be `suspended` in every list and report while still
 *    holding an active enrollment, an active fee obligation and a class seat.
 *
 *  - STU-C2: there was no transition matrix anywhere. `graduated → inactive →
 *    active` all returned 200, so a terminal state meant nothing, and a
 *    graduated student could still be enrolled, transferred and charged.
 *
 * Design notes
 * ------------
 * This module deliberately mirrors `core/academic/lifecycle-engine.ts`: a
 * declarative transition table plus `assertTransition()`, the primitive the
 * Class and Enrollment engines already use. Reusing that primitive keeps one
 * auditable "reject invalid transitions" guarantee across the product rather
 * than adding a second, differently-shaped guard.
 *
 * Like `lifecycle-engine.ts`, nothing here touches the database — it is pure
 * transition-graph logic so it is trivially unit-testable.
 *
 * The status vocabulary is fixed by the database CHECK constraint on
 * `students.status` (migration-era schema):
 *     CHECK (status IN ('active','inactive','graduated','suspended'))
 * This module does not widen it. `STUDENT_STATUSES` is exported so routes and
 * the journey path stop hard-coding their own private copies of the list
 * (audit STU-M2 — the vocabulary was duplicated in four places with two
 * different value sets).
 * ============================================================================
 */
import { assertTransition } from '../academic/lifecycle-engine.js';
import { HttpError } from '../../middleware/errorHandler.js';

/** Exactly the values permitted by the `students.status` CHECK constraint. */
export const STUDENT_STATUSES = ['active', 'inactive', 'graduated', 'suspended'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export function isStudentStatus(value: unknown): value is StudentStatus {
  return typeof value === 'string' && (STUDENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The minimum coherent transition matrix supported by the existing product.
 *
 * Derived from behaviour already in the codebase, not invented:
 *
 *  - `active → suspended` and `suspended → active` are the suspend/resume
 *    workflow (`EnrollmentService.suspend()` / `.resume()`), which also defers
 *    and re-activates enrollments. Those two edges are therefore real.
 *  - `active → inactive` and `inactive → active` are ordinary de/re-activation
 *    already offered by `PATCH /students/:id/status`. `auth.routes.ts:229`
 *    treats `inactive` (like `suspended`) as "cannot use the student portal",
 *    confirming both are non-terminal, reversible administrative states.
 *  - `active → graduated` is the end of the happy path (journey
 *    `GRADUATED` event, `EnrollmentService.complete()`).
 *  - `graduated` is TERMINAL. `ENROLLMENT_TRANSITIONS` already models its own
 *    `graduated: []` as terminal; the student profile now agrees. This is the
 *    edge that closes STU-C2: `graduated → inactive → active` laundering is
 *    no longer reachable.
 *  - `inactive → graduated` is permitted: a student who lapsed and later
 *    completed their programme (or whose graduation is back-filled) is a real
 *    registrar workflow, and it does not launder a terminal state.
 *  - `suspended → graduated` is NOT permitted: a suspended student has a
 *    deferred enrollment, so they must be resumed (`suspended → active`)
 *    before they can complete. This keeps the profile consistent with
 *    `ENROLLMENT_TRANSITIONS`, where a suspended enrollment must go through
 *    `active` before `completed → graduated`.
 *  - `suspended → inactive` is permitted: abandoning a suspended student to
 *    the inactive roster is administratively normal and loses no money.
 *
 * Self-transitions are intentionally listed where they are harmless no-ops the
 * UI may re-send (idempotent re-save). `assertTransition` does not auto-allow
 * them, matching the documented behaviour of the shared primitive.
 */
export const STUDENT_TRANSITIONS: Readonly<Record<StudentStatus, readonly StudentStatus[]>> = {
  active: ['active', 'inactive', 'suspended', 'graduated'],
  inactive: ['inactive', 'active', 'graduated'],
  suspended: ['suspended', 'active', 'inactive'],
  graduated: ['graduated'],
};

/** Terminal states — no onward transition other than an idempotent no-op. */
export const TERMINAL_STUDENT_STATUSES: readonly StudentStatus[] = ['graduated'];

export function isTerminalStudentStatus(status: string): boolean {
  return (TERMINAL_STUDENT_STATUSES as readonly string[]).includes(status);
}

/**
 * Throws HttpError(409) when `from → to` is not a legal student transition.
 * Uses the same shared primitive as the Class and Enrollment engines, so the
 * error shape and wording are consistent across the product.
 */
export function assertStudentTransition(from: StudentStatus, to: StudentStatus): void {
  assertTransition('student', STUDENT_TRANSITIONS, from, to);
}

/**
 * Guard for operations that only make sense on a student who is still with the
 * academy: new enrollments, transfers, and chargeable services such as ID
 * cards.
 *
 * This is the STU-C2 half that a transition table alone cannot express — the
 * defect was not only that `graduated → active` was allowed, but that a
 * student *left* in `graduated` could still be enrolled, transferred and
 * charged. Those routes now call this.
 *
 * Deliberately NOT applied to fee payments: settling arrears after graduation
 * is legitimate business (the audit called this out explicitly and declined to
 * classify it as a defect). Money owed before graduation must remain
 * collectable.
 */
export function assertStudentOperable(
  student: { status?: string | null; full_name?: string | null },
  operation: string,
): void {
  const status = String(student.status ?? 'active');
  if (isTerminalStudentStatus(status)) {
    throw new HttpError(
      409,
      `Cannot ${operation}: this student has graduated. ` +
        'Graduation is a final state — re-register the student to continue.',
    );
  }
  if (status === 'suspended') {
    throw new HttpError(
      409,
      `Cannot ${operation}: this student is suspended. Resume the student first.`,
    );
  }
}
