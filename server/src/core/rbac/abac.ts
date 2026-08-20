/**
 * Attribute-Based Access Control helpers
 * Complements RBAC: e.g. Teacher may edit attendance only for own classes.
 */
import type { Request } from 'express';
import { db } from '../../db/connection.js';
import { canAccessBranch, getPermissionScope } from './rbac-service.js';
import { requestHasRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';

// ── Performance: Module-level Prepared Statements ──────────────────────────
// Checks if the logged-in user is linked to the teacher of the given class.
const stmtIsUserClassTeacher = db.prepare(
  `SELECT 1 FROM classes c
   JOIN users u ON u.linked_teacher_id = c.teacher_id
   WHERE c.id = ? AND u.id = ?`
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