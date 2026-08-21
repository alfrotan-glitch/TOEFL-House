/**
 * Attribute-Based Access Control helpers
 * Complements RBAC: e.g. Teacher may edit attendance only for own classes.
 */
import type { Request } from 'express';
import { db } from '../../db/connection.js';
import {
  canAccessBranch,
  getPermissionScope,
  hasPermissionForBranchWithActionScopes,
} from './rbac-service.js';
import { requestHasRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';

// ── Performance: Module-level Prepared Statements ──────────────────────────
// Checks if the logged-in user is linked to the teacher of the given class.
const stmtIsUserClassTeacher = db.prepare(
  `SELECT 1 FROM classes c
   JOIN users u ON u.linked_teacher_id = c.teacher_id
   WHERE c.id = ? AND u.id = ?`
);
const stmtGetStudentBranch = db.prepare('SELECT branch_id AS branchId FROM students WHERE id = ?');
const stmtIsUserStudentTeacher = db.prepare(`
  SELECT 1
    FROM users u
    JOIN classes c ON c.teacher_id = u.linked_teacher_id
    JOIN (
      SELECT student_id, class_id FROM student_semesters WHERE status IN ('active','deferred')
      UNION
      SELECT student_id, class_id FROM enrollments WHERE status IN ('active','confirmed','pending')
    ) membership ON membership.class_id = c.id
   WHERE u.id = ? AND membership.student_id = ?
   LIMIT 1
`);
const stmtIsLinkedStudent = db.prepare(
  'SELECT 1 FROM users WHERE id = ? AND linked_student_id = ?',
);

/**
 * True when the caller's authority over classes is limited to the classes they
 * personally teach, rather than to a whole branch. Callers in this bucket must
 * pass an ownership check on every class they touch — a branch check alone lets
 * one teacher act on a colleague's class.
 */
export function isClassTeacherScoped(req: Request): boolean {
  if (!req.rbac) return false;
  const scope = getPermissionScope(req.rbac, 'Class.View');
  return scope === 'own' || scope === 'class' || requestHasRole(req, 'teacher');
}

export function canAccessClass(req: Request, classId: string): boolean {
  if (!req.user || !req.rbac) return false;

  const row = db.prepare(
    'SELECT id, branch_id AS branchId FROM classes WHERE id = ?'
  ).get(classId) as { id: string; branchId: string | null } | undefined;
  if (!row) return false;

  if (isClassTeacherScoped(req)) {
    return !!stmtIsUserClassTeacher.get(classId, req.user.userId);
  }

  return !!row.branchId && canAccessBranch(db, req.rbac, row.branchId);
}

export function assertClassAccess(req: Request, classId: string): void {
  if (!canAccessClass(req, classId)) {
    throw new HttpError(403, 'You can only access your own classes.');
  }
}

/** Student.View:class is satisfied only by live membership in a class whose
 * primary teacher is linked to this account. Student.View:own is reserved for
 * the account's own linked student identity. */
export function canAccessStudent(req: Request, studentId: string): boolean {
  if (!req.user || !req.rbac) return false;
  const student = stmtGetStudentBranch.get(studentId) as { branchId: string } | undefined;
  if (!student) return false;

  if (hasPermissionForBranchWithActionScopes(
    db,
    req.rbac,
    student.branchId,
    ['Student.View'],
    ['organization', 'campus', 'branch', 'department'],
  )) return true;

  if (hasPermissionForBranchWithActionScopes(
    db, req.rbac, student.branchId, ['Student.View'], ['class'],
  ) && stmtIsUserStudentTeacher.get(req.user.userId, studentId)) return true;

  return hasPermissionForBranchWithActionScopes(
    db, req.rbac, student.branchId, ['Student.View'], ['own'],
  ) && !!stmtIsLinkedStudent.get(req.user.userId, studentId);
}

export function assertStudentAccess(req: Request, studentId: string): void {
  if (!canAccessStudent(req, studentId)) {
    throw new HttpError(403, 'You can only access students within your authorized scope.');
  }
}