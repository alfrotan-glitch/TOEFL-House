import { Router, type Request } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { hashPassword } from '../utils/auth.js';
import {
  assignPrimaryRole,
  buildRbacContext,
  canAccessBranchForRequirement,
  canAdministerUser,
  isGlobalOwner,
} from '../core/rbac/rbac-service.js';
import { ROLE_CODES, type RoleCode } from '../core/rbac/permission-catalog.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

const NOT_ASSIGNABLE: ReadonlySet<RoleCode> = new Set<RoleCode>(['data_entry']);
const ALLOWED_ROLES: RoleCode[] = ROLE_CODES.filter((role) => !NOT_ASSIGNABLE.has(role));

interface UserTarget {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  branch_id: string;
  is_active: number;
  role: RoleCode | null;
  linked_student_id: string | null;
  linked_teacher_id: string | null;
  linked_employee_id: string | null;
}

const stmtGetAllUsers = db.prepare(
  `SELECT u.id, u.username, u.full_name, u.email, u.branch_id, u.is_active, u.must_change_password,
          u.created_at, u.last_login_at, r.code AS role
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_primary = 1
     LEFT JOIN roles r ON r.id = ur.role_id
    ORDER BY u.created_at DESC`,
);
const stmtGetUserById = db.prepare(
  `SELECT u.id, u.username, u.full_name, u.email, u.branch_id, u.is_active,
          u.linked_student_id, u.linked_teacher_id, u.linked_employee_id,
          r.code AS role
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.is_primary = 1
     LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.id = ?`,
);
const stmtCheckUsernameExists = db.prepare('SELECT id FROM users WHERE username = ?');
const stmtGetBranch = db.prepare('SELECT id, campus_id AS campusId FROM branches WHERE id = ?');
const stmtGetStudent = db.prepare('SELECT id, full_name AS fullName, branch_id AS branchId FROM students WHERE id = ?');
const stmtGetTeacherIdentity = db.prepare('SELECT id, branch_id AS branchId FROM teachers WHERE id = ?');
const stmtGetEmployeeIdentity = db.prepare('SELECT id, branch_id AS branchId FROM employees WHERE id = ?');
const stmtGetPartnerIdentity = db.prepare('SELECT id FROM partners WHERE id = ?');
const stmtGetRole = db.prepare('SELECT id, code, is_active AS isActive FROM roles WHERE code = ?');
const stmtGetRolePermissionCodes = db.prepare(
  `SELECT p.code
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id
    WHERE r.code = ?`,
);
const stmtInsertUser = db.prepare(
  `INSERT INTO users
     (id, username, password_hash, full_name, email, branch_id, campus_id,
      linked_teacher_id, linked_employee_id, linked_partner_id, linked_student_id,
      is_active, must_change_password)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
);
const stmtUpdateUser = db.prepare(
  `UPDATE users
      SET full_name = ?, email = ?, branch_id = ?, campus_id = ?, is_active = ?
    WHERE id = ?`,
);
const stmtResetPassword = db.prepare(
  `UPDATE users
      SET password_hash = ?, must_change_password = 1, session_version = session_version + 1
    WHERE id = ?`,
);

function requiredString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength = 254): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return normalized || null;
}

function requiredSecret(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `${field} is required.`);
  if (value.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return value;
}

function sqliteConstraint(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function targetContext(target: UserTarget) {
  return buildRbacContext(db, {
    id: target.id,
    username: target.username,
    full_name: target.full_name,
    branch_id: target.branch_id,
  });
}

function requireTargetMutationAccess(req: Request, target: UserTarget): void {
  if (!canAccessBranchResource(req, target.branch_id)) {
    throw new HttpError(403, 'User belongs to a branch outside your authorized scope.');
  }
  if (!req.rbac || !canAdministerUser(db, req.rbac, targetContext(target))) {
    throw new HttpError(403, 'You cannot administer a user with greater or wider authority than your own.');
  }
}

function requireRoleAssignmentAuthority(req: Request, role: RoleCode, branchId: string): void {
  const configuredRole = stmtGetRole.get(role) as { id: string; code: string; isActive: number } | undefined;
  if (!configuredRole || !configuredRole.isActive) throw new HttpError(409, 'The selected role is not active.');
  if (!req.rbac) throw new HttpError(403, 'Authorization context is unavailable.');
  if (isGlobalOwner(req.rbac)) return;
  if (role === 'owner') throw new HttpError(403, 'Only a global owner may grant the owner role.');
  // The former `!hasPermission(req.rbac, 'Role.Edit') ||` leg was removed as
  // redundant (Owner-approved simplification, TR-4 M7 disposition, 2026-08-22):
  // canAccessBranchForRequirement(…, {permissionCodes:['Role.Edit']}) resolves
  // from the same post-deny ctx.permissions with strictly stronger conditions,
  // so it implies the set-membership test. See the matching note in
  // security.routes.ts (requirePermissionAtBranch).
  if (!canAccessBranchForRequirement(
    db,
    req.rbac,
    branchId,
    { permissionCodes: ['Role.Edit'] },
  )) {
    throw new HttpError(403, 'Role assignment authority is required in the target branch.');
  }
  const missing = (stmtGetRolePermissionCodes.all(role) as { code: string }[])
    .map((row) => row.code)
    .filter((code) => !canAccessBranchForRequirement(db, req.rbac!, branchId, { permissionCodes: [code] }));
  if (missing.length > 0) {
    throw new HttpError(403, 'You cannot assign a role containing permissions you do not hold in that branch.');
  }
}

usersRouter.get(
  '/',
  requirePermission('User.View'),
  ah(async (req, res) => {
    const rows = stmtGetAllUsers.all() as Array<{ branch_id: string }>;
    res.json(rows.filter((row) => canAccessBranchResource(req, row.branch_id)));
  }),
);

usersRouter.post(
  '/',
  requirePermission('User.Create'),
  ah(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = requiredString(body.username, 'Username', 64);
    const requestedFullName = requiredString(body.fullName, 'Full name');
    const tempPassword = requiredSecret(body.tempPassword, 'Temporary password');
    const branchId = requiredString(body.branchId, 'Branch', 128);
    const email = optionalString(body.email, 'Email');
    const role = body.role;
    if (typeof role !== 'string' || !ALLOWED_ROLES.includes(role as RoleCode)) {
      throw new HttpError(400, 'Invalid role specified.');
    }
    const roleCode = role as RoleCode;
    if (!canAccessBranchResource(req, branchId)) {
      throw new HttpError(403, 'Target branch is outside your authorized scope.');
    }
    const branch = stmtGetBranch.get(branchId) as { id: string; campusId: string | null } | undefined;
    if (!branch) throw new HttpError(404, 'Target branch not found.');
    requireRoleAssignmentAuthority(req, roleCode, branchId);

    if (stmtCheckUsernameExists.get(username)) throw new HttpError(409, 'This username is already in use.');

    const linkedStudentId = optionalString(body.linkedStudentId, 'Linked student id', 128);
    let fullName = requestedFullName;
    if (roleCode === 'student') {
      if (!linkedStudentId) throw new HttpError(400, 'A student portal account must be linked to a student.');
      const student = stmtGetStudent.get(linkedStudentId) as { id: string; fullName: string; branchId: string } | undefined;
      if (!student) throw new HttpError(404, 'Linked student not found.');
      if (student.branchId !== branchId) throw new HttpError(400, 'Linked student must belong to the same branch.');
      if (requestedFullName !== student.fullName) throw new HttpError(400, 'Portal account name must match the linked student.');
      if (tempPassword !== student.fullName) throw new HttpError(400, 'A student initial password must be exactly the student name.');
      fullName = student.fullName;
    } else if (linkedStudentId) {
      throw new HttpError(400, 'Only a student role may be linked to a student portal profile.');
    }

    if (roleCode !== 'student' && tempPassword.length < 12) {
      throw new HttpError(400, 'Temporary password must be at least 12 characters.');
    }

    const linkedTeacherId = optionalString(body.linkedTeacherId, 'Linked teacher id', 128);
    const linkedEmployeeId = optionalString(body.linkedEmployeeId, 'Linked employee id', 128);
    const linkedPartnerId = optionalString(body.linkedPartnerId, 'Linked partner id', 128);
    if (linkedTeacherId) {
      const teacher = stmtGetTeacherIdentity.get(linkedTeacherId) as { id: string; branchId: string } | undefined;
      if (!teacher) throw new HttpError(404, 'Linked teacher not found.');
      if (teacher.branchId !== branchId) throw new HttpError(400, 'Linked teacher must belong to the same branch.');
    }
    if (linkedEmployeeId) {
      const employee = stmtGetEmployeeIdentity.get(linkedEmployeeId) as { id: string; branchId: string } | undefined;
      if (!employee) throw new HttpError(404, 'Linked employee not found.');
      if (employee.branchId !== branchId) throw new HttpError(400, 'Linked employee must belong to the same branch.');
    }
    if (linkedPartnerId && !stmtGetPartnerIdentity.get(linkedPartnerId)) {
      throw new HttpError(404, 'Linked partner not found.');
    }
    const passwordHash = await hashPassword(tempPassword);
    const newId = id('usr');
    const mustChangePassword = roleCode === 'student' ? 0 : 1;

    const createTx = db.transaction(() => {
      stmtInsertUser.run(
        newId,
        username,
        passwordHash,
        fullName,
        email ?? null,
        branchId,
        branch.campusId,
        linkedTeacherId ?? null,
        linkedEmployeeId ?? null,
        linkedPartnerId ?? null,
        linkedStudentId ?? null,
        mustChangePassword,
      );
      assignPrimaryRole(db, newId, roleCode, branchId, req.user!.userId);
    });
    try {
      createTx();
    } catch (error) {
      if (sqliteConstraint(error)) throw new HttpError(409, 'The account conflicts with an existing identity record.');
      throw error;
    }

    writeAudit(req, `Created user account: ${fullName} (${username})`, { branchId });
    res.status(201).json({ id: newId });
  }),
);

usersRouter.patch(
  '/:id',
  requirePermission('User.Edit'),
  ah(async (req, res) => {
    const target = stmtGetUserById.get(req.params.id) as UserTarget | undefined;
    if (!target) throw new HttpError(404, 'User not found.');
    requireTargetMutationAccess(req, target);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = body.fullName === undefined ? target.full_name : requiredString(body.fullName, 'Full name');
    const email = body.email === undefined ? target.email : optionalString(body.email, 'Email') ?? null;
    const branchId = body.branchId === undefined ? target.branch_id : requiredString(body.branchId, 'Branch', 128);
    const isActive = body.isActive === undefined
      ? !!target.is_active
      : typeof body.isActive === 'boolean'
        ? body.isActive
        : (() => { throw new HttpError(400, 'isActive must be a boolean.'); })();
    const role = body.role === undefined ? target.role : body.role;
    if (role !== null && (typeof role !== 'string' || !ALLOWED_ROLES.includes(role as RoleCode))) {
      throw new HttpError(400, 'Invalid role specified.');
    }
    const nextRole = role as RoleCode | null;

    if (target.id === req.user!.userId && ((nextRole && nextRole !== 'owner') || !isActive)) {
      throw new HttpError(409, 'You cannot deactivate or demote your own administrative account.');
    }

    if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
    const branch = stmtGetBranch.get(branchId) as { id: string; campusId: string | null } | undefined;
    if (!branch) throw new HttpError(404, 'Target branch not found.');

    if (target.linked_student_id) {
      const student = stmtGetStudent.get(target.linked_student_id) as { id: string; fullName: string; branchId: string } | undefined;
      if (!student) throw new HttpError(409, 'The linked student profile no longer exists.');
      if (nextRole !== 'student') throw new HttpError(409, 'A linked portal account must keep the student role.');
      if (branchId !== student.branchId) throw new HttpError(409, 'A portal account must stay in the linked student branch.');
      if (fullName !== student.fullName) throw new HttpError(409, 'Portal account name must match the linked student.');
    } else if (nextRole === 'student') {
      throw new HttpError(409, 'A student role requires a linked student profile.');
    }
    if (target.linked_teacher_id) {
      const teacher = stmtGetTeacherIdentity.get(target.linked_teacher_id) as { branchId: string } | undefined;
      if (!teacher || teacher.branchId !== branchId) {
        throw new HttpError(409, 'A linked teacher account must stay in the teacher branch.');
      }
    }
    if (target.linked_employee_id) {
      const employee = stmtGetEmployeeIdentity.get(target.linked_employee_id) as { branchId: string } | undefined;
      if (!employee || employee.branchId !== branchId) {
        throw new HttpError(409, 'A linked employee account must stay in the employee branch.');
      }
    }

    if ((body.role !== undefined || body.branchId !== undefined) && nextRole) {
      requireRoleAssignmentAuthority(req, nextRole, branchId);
    }

    const updateTx = db.transaction(() => {
      const result = stmtUpdateUser.run(fullName, email, branchId, branch.campusId, isActive ? 1 : 0, target.id);
      if (result.changes !== 1) throw new HttpError(409, 'User update was not applied.');
      if ((body.role !== undefined || body.branchId !== undefined) && nextRole) {
        assignPrimaryRole(db, target.id, nextRole, branchId, req.user!.userId);
      }
      if (body.role !== undefined || body.branchId !== undefined || body.isActive !== undefined) {
        db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(target.id);
      }
    });
    updateTx();

    writeAudit(req, `Updated user account: ${target.full_name}`, {
      oldValue: JSON.stringify({ fullName: target.full_name, branchId: target.branch_id, role: target.role, isActive: !!target.is_active }),
      newValue: JSON.stringify({ fullName, branchId, role: nextRole, isActive }),
      branchId,
    });
    res.json({ ok: true });
  }),
);

usersRouter.post(
  '/:id/reset-password',
  requirePermission('User.Edit'),
  ah(async (req, res) => {
    const tempPassword = requiredSecret((req.body as { tempPassword?: unknown } | undefined)?.tempPassword, 'Temporary password');
    if (tempPassword.length < 12) throw new HttpError(400, 'Temporary password must be at least 12 characters.');

    const target = stmtGetUserById.get(req.params.id) as UserTarget | undefined;
    if (!target) throw new HttpError(404, 'User not found.');
    requireTargetMutationAccess(req, target);

    const passwordHash = await hashPassword(tempPassword);
    const result = stmtResetPassword.run(passwordHash, target.id);
    if (result.changes !== 1) throw new HttpError(409, 'Password reset was not applied.');

    writeAudit(req, `Reset password for: ${target.full_name}`, { branchId: target.branch_id });
    res.json({ ok: true });
  }),
);

export default usersRouter;
