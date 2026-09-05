/**
 * Academic Hold — the single enrollment gate for student debt.
 *
 * THE RULE (as the feature has always documented itself): a student with
 * outstanding debt from previous terms may not open a NEW term until it is
 * settled; owner / general manager / finance_manager may override.
 *
 * Two properties this module guarantees:
 *
 * 1. The hold sums the FULL lifetime balance. Every path that moves a term
 *    out of 'active' (drop → deferred, completion, graduation) must still
 *    count that term's debt at the gate, because "debt from previous
 *    semesters" means lifetime receivable, not active-scope receivable.
 *
 * 2. Only two of the three enrollment surfaces applied the gate. The journey
 *    enrollment route never called it, so any student blocked at the class or
 *    semester desk could enroll through the journey surface. All three
 *    surfaces now call this one function.
 *
 * THE RESUME EXCEPTION: a request naming a term the student already holds in
 * that class is not a new seat — it either re-opens the existing term (whose
 * debt is exactly what the student is trying to finish) or is refused by the
 * duplicate-seat authority. Blocking resumption would trap a student who owes
 * money in the term they are trying to complete, so such requests pass; every
 * enrollment that would create a NEW term while in debt is refused.
 */
import type { Request } from 'express';
import { db } from '../../db/connection.js';
import { getStudentBalance } from '../../utils/studentBalance.js';
import { canAccessBranchForRequirement } from '../rbac/rbac-service.js';
import { HttpError } from '../../middleware/errorHandler.js';

export interface AcademicHoldTarget {
  studentId: string;
  branchId: string;
  /** The class the new enrollment names, when there is one. */
  classId?: string | null;
  /** The term name the new enrollment names, when there is one. */
  semesterName?: string | null;
}

export function assertEnrollmentNotOnHold(req: Request, target: AcademicHoldTarget): void {
  const canOverride = !!req.rbac && canAccessBranchForRequirement(
    db,
    req.rbac,
    target.branchId,
    { roleCodes: ['owner', 'general_manager', 'finance_manager'] },
  );
  if (canOverride) return;

  // Full lifetime outstanding — tuition from every term the student has ever
  // held plus every required non-tuition invoice — so no status change can
  // disarm the gate. This is the same authoritative balance the profile,
  // roster, portal and dashboard show.
  const totalDebt = getStudentBalance(db, target.studentId, 'all').totalOutstanding;
  if (totalDebt <= 0) return;

  // Resume exception: the request names a term the student already holds in
  // this class (any status). Such a request is not a NEW seat: it either
  // re-opens the existing term (deferred/completed) or is refused by the
  // enrollment service's own duplicate-seat authority (active). Neither
  // outcome adds receivable, so the debt gate has nothing to protect.
  if (target.classId && target.semesterName) {
    const held = db.prepare(
      `SELECT 1 FROM student_semesters
        WHERE student_id = ? AND class_id = ? AND semester_name = ?
        LIMIT 1`,
    ).get(target.studentId, target.classId, target.semesterName);
    if (held) return;
  }

  throw new HttpError(
    403,
    `Academic Hold: Student has an outstanding debt of ${totalDebt} AFN. Please clear the balance before new enrollment.`,
  );
}
