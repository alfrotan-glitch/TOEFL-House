/**
 * Canonical transition graph for the Student profile lifecycle.
 *
 * This module is pure policy: database effects remain in the guarded status,
 * suspension, resume and graduation workflows. Suspension cannot transition
 * directly to another profile status because its enrollments and captured
 * semesters must first be restored by the resume workflow. Graduation is
 * terminal. The vocabulary matches the students.status CHECK constraint.
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
 * Active/inactive are reversible administrative states. Graduation is
 * terminal. Suspension has only its idempotent edge and the dedicated resume
 * edge; ordinary status changes cannot strand suspended enrollments or deferred
 * semesters behind a different profile status.
 */
export const STUDENT_TRANSITIONS: Readonly<Record<StudentStatus, readonly StudentStatus[]>> = {
  active: ['active', 'inactive', 'suspended', 'graduated'],
  inactive: ['inactive', 'active', 'graduated'],
  suspended: ['suspended', 'active'],
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
