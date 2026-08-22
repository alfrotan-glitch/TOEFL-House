import { Router, type Request } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import {
  buildRbacContext,
  canAccessBranchForRequirement,
  canAdministerUser,
  resolveUserPermissions,
  isGlobalOwner,
  effectivePermissionCodes,
  effectiveTabAccess,
} from '../core/rbac/rbac-service.js';
import {
  TAB_PERMISSION_MAP,
  ROLE_CODES,
  type PermissionScope,
} from '../core/rbac/permission-catalog.js';
import { id } from '../utils/ids.js';

export const securityRouter = Router();
securityRouter.use(authenticate);

const PERMISSION_SCOPES: readonly PermissionScope[] = [
  'organization', 'campus', 'branch', 'department', 'program', 'class', 'own',
];
const ASSIGNMENT_SCOPES: readonly PermissionScope[] = ['organization', 'campus', 'branch'];

const stmtGetAllPermissions = db.prepare(
  `SELECT id, code, resource, action, description, category
     FROM permissions
    ORDER BY category, resource, action`,
);
const stmtGetAllRoles = db.prepare(
  `SELECT id, code, name, description, is_system AS isSystem, is_active AS isActive,
          sort_order AS sortOrder
     FROM roles
    ORDER BY sort_order, name`,
);
const stmtGetAllRolePermissions = db.prepare(
  `SELECT rp.role_id, p.id AS permissionId, p.code, p.resource, p.action, p.description,
          rp.default_scope AS scope
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
    ORDER BY p.category, p.code`,
);
const stmtGetRoleById = db.prepare(
  `SELECT id, code, name, description, is_system AS isSystem, is_active AS isActive
     FROM roles WHERE id = ?`,
);
const stmtUpdateRole = db.prepare(
  `UPDATE roles
      SET name = COALESCE(?, name), description = ?, is_active = COALESCE(?, is_active),
          updated_at = datetime('now')
    WHERE id = ?`,
);
const stmtGetMaxRoleSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM roles');
const stmtGetPermissionsByRoleId = db.prepare(
  `SELECT p.id AS permissionId, p.code, p.resource, p.action, p.description, p.category,
          rp.default_scope AS scope
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?`,
);
const stmtGetRoleWithSystemFlag = db.prepare(
  'SELECT id, code, name, is_system AS isSystem, is_active AS isActive FROM roles WHERE id = ?',
);
const stmtDeleteRolePermissions = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
const stmtInsertRolePermission = db.prepare(
  'INSERT INTO role_permissions (id, role_id, permission_id, default_scope) VALUES (?, ?, ?, ?)',
);
const stmtGetRolePermissionCodes = db.prepare(
  `SELECT p.code
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?`,
);
const stmtGetRoleAssignments = db.prepare(
  `SELECT scope_type AS scopeType, scope_id AS scopeId
     FROM user_roles
    WHERE role_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
);

const stmtGetUserRoles = db.prepare(
  `SELECT ur.id, ur.role_id AS roleId, r.code AS roleCode, r.name AS roleName,
          ur.scope_type AS scopeType, ur.scope_id AS scopeId, ur.is_primary AS isPrimary,
          ur.assigned_at AS assignedAt, ur.expires_at AS expiresAt
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
    ORDER BY ur.is_primary DESC, r.sort_order`,
);
const stmtGetUserById = db.prepare(
  `SELECT id, username, full_name AS fullName, branch_id AS branchId,
          linked_student_id AS linkedStudentId
     FROM users WHERE id = ?`,
);
const stmtInsertUserRole = db.prepare(
  `INSERT INTO user_roles
     (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, assigned_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
);
const stmtDeleteUserRole = db.prepare('DELETE FROM user_roles WHERE id = ? AND user_id = ?');

const stmtGetPermIdById = db.prepare('SELECT id, code FROM permissions WHERE id = ?');
const stmtGetUserOverrides = db.prepare(
  `SELECT o.id, o.permission_id AS permissionId, p.code AS permissionCode, o.effect,
          o.scope_type AS scopeType, o.scope_id AS scopeId, o.reason,
          o.created_at AS createdAt, o.expires_at AS expiresAt
     FROM permission_overrides o
     JOIN permissions p ON p.id = o.permission_id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC`,
);
const stmtInsertUserOverride = db.prepare(
  `INSERT INTO permission_overrides
     (id, user_id, permission_id, effect, scope_type, scope_id, reason, granted_by, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
);
const stmtGetOverrideById = db.prepare(
  `SELECT o.id, o.user_id AS userId, o.effect, o.scope_type AS scopeType,
          o.scope_id AS scopeId, p.code AS permissionCode
     FROM permission_overrides o
     JOIN permissions p ON p.id = o.permission_id
    WHERE o.id = ?`,
);
const stmtDeleteUserOverride = db.prepare('DELETE FROM permission_overrides WHERE id = ?');

interface TargetUser {
  id: string;
  username: string;
  fullName: string;
  branchId: string;
  linkedStudentId: string | null;
}

function callerIsGlobalOwner(req: Request): boolean {
  return !!req.rbac && isGlobalOwner(req.rbac);
}

function getUserContext(req: Request) {
  if (!req.user?.userId) throw new HttpError(403, 'User context is missing for security operation.');
  return req.user;
}

function targetRbac(target: TargetUser) {
  return buildRbacContext(db, {
    id: target.id,
    username: target.username,
    full_name: target.fullName,
    branch_id: target.branchId,
  });
}

function requireTargetReadAccess(req: Request, userId: string): TargetUser {
  const target = stmtGetUserById.get(userId) as TargetUser | undefined;
  if (!target) throw new HttpError(404, 'User not found.');
  if (!canAccessBranchResource(req, target.branchId)) throw new HttpError(403, 'User belongs to another branch.');
  return target;
}

function requireTargetMutationAccess(req: Request, userId: string): TargetUser {
  const target = requireTargetReadAccess(req, userId);
  if (!req.rbac || !canAdministerUser(db, req.rbac, targetRbac(target))) {
    throw new HttpError(403, 'You cannot administer a user with greater or wider authority than your own.');
  }
  return target;
}

function requirePermissionAtBranch(req: Request, permissionCode: string, branchId: string): void {
  if (!req.rbac) throw new HttpError(403, 'Authorization context is unavailable.');
  if (callerIsGlobalOwner(req)) return;
  // The former `!hasPermission(req.rbac, permissionCode) ||` leg was removed as
  // redundant (Owner-approved simplification, TR-4 M7 disposition, 2026-08-22):
  // canAccessBranchForRequirement(…, {permissionCodes:[code]}) resolves from the
  // same post-deny ctx.permissions with strictly stronger conditions
  // (hasPermissionForBranchWithActionScopes), so it implies the set-membership
  // test. Keeping both expressed one rule twice and made the weaker leg look
  // independently load-bearing.
  if (!canAccessBranchForRequirement(
    db,
    req.rbac,
    branchId,
    { permissionCodes: [permissionCode] },
  )) {
    throw new HttpError(403, `${permissionCode} authority is required in the target branch.`);
  }
}

function requireRoleEditAtBranch(req: Request, branchId: string): void {
  requirePermissionAtBranch(req, 'Role.Edit', branchId);
}

function normalizeScope(value: unknown, allowed: readonly PermissionScope[], fallback: PermissionScope): PermissionScope {
  const scope = value === undefined ? fallback : value;
  if (typeof scope !== 'string' || !allowed.includes(scope as PermissionScope)) {
    throw new HttpError(400, 'Invalid permission scope.');
  }
  return scope as PermissionScope;
}

function normalizeScopeId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'scopeId must be a string or null.');
  return value.trim();
}

function normalizeFutureExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new HttpError(400, 'expiresAt must be a valid date-time.');
  if (Date.parse(value) <= Date.now()) throw new HttpError(400, 'expiresAt must be in the future.');
  return value;
}

function requireAssignmentScope(req: Request, scopeType: PermissionScope, scopeId: string | null, permissionCode: string): void {
  if (scopeType === 'organization') {
    if (scopeId !== null) throw new HttpError(400, 'Organization scope must not carry a scopeId.');
    if (!callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant organization-scoped access.');
    return;
  }
  if (!scopeId) throw new HttpError(400, `${scopeType} scope requires a scopeId.`);
  if (scopeType === 'campus') {
    if (!callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant campus-scoped access.');
    if (!db.prepare('SELECT id FROM campuses WHERE id = ?').get(scopeId)) throw new HttpError(404, 'Target campus not found.');
    return;
  }
  if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(scopeId)) throw new HttpError(404, 'Target branch not found.');
  requirePermissionAtBranch(req, permissionCode, scopeId);
}

function requireRolePermissionSubset(
  req: Request,
  roleId: string,
  scopeType: PermissionScope,
  scopeId: string | null,
): void {
  if (callerIsGlobalOwner(req)) return;
  if (!req.rbac || scopeType !== 'branch' || !scopeId) throw new HttpError(403, 'Authorization context is unavailable.');
  const missing = (stmtGetRolePermissionCodes.all(roleId) as { code: string }[])
    .map((row) => row.code)
    .filter((code) => !canAccessBranchForRequirement(
      db,
      req.rbac!,
      scopeId,
      { permissionCodes: [code] },
    ));
  if (missing.length > 0) throw new HttpError(403, 'You cannot assign a role containing permissions you do not hold in that scope.');
}

function requireRoleDefinitionReach(req: Request, role: { id: string; isSystem: number }): void {
  if (callerIsGlobalOwner(req)) return;
  if (role.isSystem) throw new HttpError(403, 'Only a global owner may change a system role.');
  if (!req.rbac) throw new HttpError(403, 'Authorization context is unavailable.');
  const assignments = stmtGetRoleAssignments.all(role.id) as Array<{ scopeType: PermissionScope; scopeId: string | null }>;
  const outsideReach = assignments.some((assignment) => assignment.scopeType !== 'branch'
    || !assignment.scopeId
    || !canAccessBranchForRequirement(db, req.rbac!, assignment.scopeId, { permissionCodes: ['Role.Edit'] }));
  if (outsideReach) throw new HttpError(403, 'This position has assignments outside your administration scope.');
}

function requireRolePermissionSetReach(
  req: Request,
  roleId: string,
  permissions: readonly NormalizedPermissionInput[],
): void {
  if (callerIsGlobalOwner(req)) return;
  if (!req.rbac) throw new HttpError(403, 'Authorization context is unavailable.');
  const assignments = stmtGetRoleAssignments.all(roleId) as Array<{ scopeType: PermissionScope; scopeId: string | null }>;
  const outsideCeiling = assignments.some((assignment) => assignment.scopeType !== 'branch'
    || !assignment.scopeId
    || permissions.some((permission) => !canAccessBranchForRequirement(
      db,
      req.rbac!,
      assignment.scopeId!,
      { permissionCodes: [permission.permissionCode] },
    )));
  if (outsideCeiling) throw new HttpError(403, 'You cannot grant these permissions in every active assignment scope.');
}

interface NormalizedPermissionInput {
  permissionId: string;
  permissionCode: string;
  scope: PermissionScope;
}

function normalizePermissionList(req: Request, value: unknown): NormalizedPermissionInput[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'permissions array is required.');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new HttpError(400, 'Each permission must be an object.');
    const candidate = entry as { permissionId?: unknown; scope?: unknown };
    if (typeof candidate.permissionId !== 'string' || !candidate.permissionId) {
      throw new HttpError(400, 'Each permission needs a permissionId.');
    }
    if (seen.has(candidate.permissionId)) throw new HttpError(400, 'Duplicate permissionId values are not allowed.');
    seen.add(candidate.permissionId);
    const permission = stmtGetPermIdById.get(candidate.permissionId) as { id: string; code: string } | undefined;
    if (!permission) throw new HttpError(400, 'Unknown permissionId.');
    const scope = normalizeScope(candidate.scope, PERMISSION_SCOPES, 'branch');
    if (!callerIsGlobalOwner(req)) {
      if (scope !== 'branch') throw new HttpError(403, 'Only a global owner may define permissions wider or narrower than branch scope.');
      if (!req.rbac?.permissionCodes.has(permission.code)) {
        throw new HttpError(403, 'You cannot grant a permission you do not hold.');
      }
    }
    return { permissionId: permission.id, permissionCode: permission.code, scope };
  });
}

securityRouter.get('/permissions', requirePermission('Permission.View', 'Role.View'), ah(async (_req, res) => {
  res.json(stmtGetAllPermissions.all());
}));

securityRouter.get('/roles', requirePermission('Role.View'), ah(async (_req, res) => {
  const roles = stmtGetAllRoles.all() as any[];
  const allRolePerms = stmtGetAllRolePermissions.all() as any[];
  const permMap = new Map<string, any[]>();
  for (const permission of allRolePerms) {
    if (!permMap.has(permission.role_id)) permMap.set(permission.role_id, []);
    permMap.get(permission.role_id)!.push({
      permissionId: permission.permissionId,
      code: permission.code,
      resource: permission.resource,
      action: permission.action,
      description: permission.description,
      scope: permission.scope,
    });
  }
  res.json(roles.map((role) => ({
    ...role,
    isSystem: !!role.isSystem,
    isActive: !!role.isActive,
    permissions: permMap.get(role.id) || [],
  })));
}));

securityRouter.get('/roles/:id', requirePermission('Role.View'), ah(async (req, res) => {
  const role = stmtGetRoleById.get(req.params.id) as any;
  if (!role) throw new HttpError(404, 'Role not found.');
  res.json({
    ...role,
    isSystem: !!role.isSystem,
    isActive: !!role.isActive,
    permissions: stmtGetPermissionsByRoleId.all(role.id),
  });
}));

securityRouter.put('/roles/:id/permissions', requirePermission('Role.Edit'), ah(async (req, res) => {
  const role = stmtGetRoleWithSystemFlag.get(req.params.id) as { id: string; code: string; isSystem: number } | undefined;
  if (!role) throw new HttpError(404, 'Role not found.');
  requireRoleDefinitionReach(req, role);
  const permissions = normalizePermissionList(req, (req.body as { permissions?: unknown } | undefined)?.permissions);
  requireRolePermissionSetReach(req, role.id, permissions);

  const tx = db.transaction(() => {
    stmtDeleteRolePermissions.run(role.id);
    for (const permission of permissions) {
      stmtInsertRolePermission.run(id('rp'), role.id, permission.permissionId, permission.scope);
    }
  });
  tx();

  writeAudit(req, `Updated permissions for role ${role.code}`, { newValue: `${permissions.length} permissions` });
  res.json({ ok: true, count: permissions.length });
}));

securityRouter.post('/roles', requirePermission('Role.Edit'), ah(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; permissions?: unknown };
  if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Position name is required.');
  const name = body.name.trim();
  if (name.length > 60) throw new HttpError(400, 'Position name is too long.');
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    throw new HttpError(400, 'Position description must be a string.');
  }
  if (db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(name)) {
    throw new HttpError(409, 'A position with this name already exists.');
  }
  const code = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'position'}`;
  if (db.prepare('SELECT id FROM roles WHERE code = ?').get(code)) throw new HttpError(409, 'A position with this code already exists.');
  const permissions = normalizePermissionList(req, body.permissions ?? []);

  const maxSort = (stmtGetMaxRoleSort.get() as { m: number }).m;
  const roleId = id('role');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO roles
      (id, code, name, description, is_system, is_active, sort_order, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?, datetime('now'))`)
      .run(roleId, code, name, typeof body.description === 'string' ? body.description.trim() || null : null, maxSort + 1);
    for (const permission of permissions) {
      stmtInsertRolePermission.run(id('rp'), roleId, permission.permissionId, permission.scope);
    }
  });
  tx();

  writeAudit(req, `Created position ${name} (${code}) with ${permissions.length} permissions`);
  const role = stmtGetRoleById.get(roleId) as any;
  res.status(201).json({ id: roleId, code, name: role.name, description: role.description, isSystem: false, isActive: true });
}));

securityRouter.patch('/roles/:id', requirePermission('Role.Edit'), ah(async (req, res) => {
  const role = stmtGetRoleWithSystemFlag.get(req.params.id) as { id: string; code: string; name: string; isSystem: number } | undefined;
  if (!role) throw new HttpError(404, 'Position not found.');
  requireRoleDefinitionReach(req, role);
  const body = (req.body ?? {}) as { name?: unknown; description?: unknown; isActive?: unknown };
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60)) {
    throw new HttpError(400, 'Position name must be 1–60 characters.');
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    throw new HttpError(400, 'Position description must be a string or null.');
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') throw new HttpError(400, 'isActive must be a boolean.');
  if (body.isActive === false && role.code === 'owner') throw new HttpError(409, 'The Owner position cannot be deactivated.');
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  if (name && db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE AND id != ?').get(name, role.id)) {
    throw new HttpError(409, 'A position with this name already exists.');
  }

  stmtUpdateRole.run(
    name ?? null,
    body.description === undefined ? (stmtGetRoleById.get(role.id) as { description: string | null }).description : typeof body.description === 'string' ? body.description.trim() || null : null,
    body.isActive === undefined ? null : body.isActive ? 1 : 0,
    role.id,
  );
  writeAudit(req, `${body.isActive === false ? 'Deactivated' : body.isActive === true ? 'Activated' : 'Updated'} position ${role.code}`, {
    oldValue: JSON.stringify({ name: role.name }),
    newValue: JSON.stringify({ name, description: body.description, isActive: body.isActive }),
  });
  res.json({ ok: true });
}));

securityRouter.get('/users/:userId/roles', requirePermission('User.View', 'Role.View'), ah(async (req, res) => {
  requireTargetReadAccess(req, req.params.userId);
  const rows = stmtGetUserRoles.all(req.params.userId) as any[];
  res.json(rows.map((row) => ({ ...row, isPrimary: !!row.isPrimary })));
}));

securityRouter.post('/users/:userId/roles', requirePermission('User.Edit'), ah(async (req, res) => {
  const actor = getUserContext(req);
  const target = requireTargetMutationAccess(req, req.params.userId);
  requireRoleEditAtBranch(req, target.branchId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.roleId !== 'string' || !body.roleId) throw new HttpError(400, 'roleId is required.');
  if (body.isPrimary !== undefined && typeof body.isPrimary !== 'boolean') throw new HttpError(400, 'isPrimary must be a boolean.');
  const isPrimary = body.isPrimary === true;
  const scopeType = normalizeScope(body.scopeType, ASSIGNMENT_SCOPES, 'branch');
  const scopeId = normalizeScopeId(body.scopeId);
  const expiresAt = normalizeFutureExpiry(body.expiresAt);
  requireAssignmentScope(req, scopeType, scopeId, 'Role.Edit');

  const role = stmtGetRoleWithSystemFlag.get(body.roleId) as { id: string; code: string; isSystem: number; isActive: number } | undefined;
  if (!role) throw new HttpError(404, 'Role not found.');
  if (!role.isActive) throw new HttpError(409, 'Inactive roles cannot be assigned.');
  if (role.code === 'owner' && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant the owner role.');
  requireRolePermissionSubset(req, role.id, scopeType, scopeId);

  if (target.linkedStudentId && role.code !== 'student') {
    throw new HttpError(409, 'A student portal account cannot receive a staff position.');
  }
  if (!target.linkedStudentId && role.code === 'student') {
    throw new HttpError(409, 'The student role requires a linked student profile.');
  }
  if (isPrimary) {
    if (!(ROLE_CODES as readonly string[]).includes(role.code)) {
      throw new HttpError(400, 'Only canonical identity roles can be assigned as primary.');
    }
    if (scopeType !== (role.code === 'owner' ? 'organization' : 'branch')) {
      throw new HttpError(400, 'Primary role scope must match the identity role scope.');
    }
    if (expiresAt) throw new HttpError(400, 'Primary identity roles cannot expire.');
  }

  const tx = db.transaction(() => {
    if (isPrimary) {
      db.prepare('UPDATE user_roles SET is_primary = 0 WHERE user_id = ?').run(target.id);
      db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(target.id);
    }
    const assignmentId = id('ur');
    stmtInsertUserRole.run(assignmentId, target.id, role.id, scopeType, scopeId, isPrimary ? 1 : 0, actor.userId, expiresAt);
    return assignmentId;
  });
  let assignmentId: string;
  try {
    assignmentId = tx();
  } catch (error) {
    if ((error as { code?: string } | null)?.code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new HttpError(409, 'This role assignment already exists or conflicts with the primary role.');
    }
    throw error;
  }

  writeAudit(req, `Assigned role ${role.code} to user ${target.id}`, { branchId: target.branchId });
  res.status(201).json({ id: assignmentId });
}));

securityRouter.delete('/users/:userId/roles/:assignmentId', requirePermission('User.Edit'), ah(async (req, res) => {
  const target = requireTargetMutationAccess(req, req.params.userId);
  requireRoleEditAtBranch(req, target.branchId);
  const assignments = stmtGetUserRoles.all(target.id) as any[];
  const assignment = assignments.find((row) => row.id === req.params.assignmentId);
  if (!assignment) throw new HttpError(404, 'Assignment not found.');
  if (assignment.isPrimary) throw new HttpError(409, 'The primary identity role cannot be removed. Change the user primary role instead.');
  if (assignment.roleCode === 'owner' && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may remove an owner assignment.');
  const result = stmtDeleteUserRole.run(req.params.assignmentId, target.id);
  if (result.changes !== 1) throw new HttpError(404, 'Assignment not found.');

  writeAudit(req, `Removed role assignment ${req.params.assignmentId}`, { branchId: target.branchId });
  res.json({ ok: true });
}));

securityRouter.get('/users/:userId/effective-permissions', requirePermission('User.View', 'Permission.View'), ah(async (req, res) => {
  requireTargetReadAccess(req, req.params.userId);
  res.json(resolveUserPermissions(db, req.params.userId));
}));

securityRouter.get('/users/:userId/overrides', requirePermission('Permission.View'), ah(async (req, res) => {
  requireTargetReadAccess(req, req.params.userId);
  res.json(stmtGetUserOverrides.all(req.params.userId));
}));

securityRouter.post('/users/:userId/overrides', requirePermission('Permission.Override'), ah(async (req, res) => {
  const actor = getUserContext(req);
  const target = requireTargetMutationAccess(req, req.params.userId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.permissionId !== 'string' || !body.permissionId) throw new HttpError(400, 'permissionId is required.');
  if (body.effect !== 'grant' && body.effect !== 'deny') throw new HttpError(400, 'effect must be grant or deny.');
  const permission = stmtGetPermIdById.get(body.permissionId) as { id: string; code: string } | undefined;
  if (!permission) throw new HttpError(400, 'Unknown permissionId.');
  const scopeType = normalizeScope(body.scopeType, ASSIGNMENT_SCOPES, 'branch');
  const scopeId = normalizeScopeId(body.scopeId);
  const expiresAt = normalizeFutureExpiry(body.expiresAt);
  requireAssignmentScope(req, scopeType, scopeId, 'Permission.Override');
  if (body.effect === 'grant' && !callerIsGlobalOwner(req) && (!req.rbac || !scopeId || !canAccessBranchForRequirement(
    db,
    req.rbac,
    scopeId,
    { permissionCodes: [permission.code] },
  ))) {
    throw new HttpError(403, 'You cannot grant a permission you do not hold in that scope.');
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'reason must be a string.');
  }

  const overrideId = id('po');
  stmtInsertUserOverride.run(
    overrideId,
    target.id,
    permission.id,
    body.effect,
    scopeType,
    scopeId,
    typeof body.reason === 'string' ? body.reason.trim() || null : null,
    actor.userId,
    expiresAt,
  );

  writeAudit(req, `Permission override ${body.effect} for user ${target.id}`, {
    newValue: permission.code,
    branchId: target.branchId,
  });
  res.status(201).json({ id: overrideId });
}));

securityRouter.delete('/overrides/:id', requirePermission('Permission.Override'), ah(async (req, res) => {
  const override = stmtGetOverrideById.get(req.params.id) as {
    id: string;
    userId: string;
    effect: 'grant' | 'deny';
    scopeType: PermissionScope;
    scopeId: string | null;
    permissionCode: string;
  } | undefined;
  if (!override) throw new HttpError(404, 'Override not found.');
  const target = requireTargetMutationAccess(req, override.userId);
  requireAssignmentScope(req, override.scopeType, override.scopeId, 'Permission.Override');
  if (override.effect === 'deny' && !callerIsGlobalOwner(req) && (!req.rbac || !override.scopeId
    || !canAccessBranchForRequirement(
      db,
      req.rbac,
      override.scopeId,
      { permissionCodes: [override.permissionCode] },
    ))) {
    throw new HttpError(403, 'Removing this deny would restore a permission you do not hold in that scope.');
  }
  const result = stmtDeleteUserOverride.run(override.id);
  if (result.changes !== 1) throw new HttpError(404, 'Override not found.');

  writeAudit(req, `Removed permission override ${override.id} from user ${override.userId}`, { branchId: target.branchId });
  res.json({ ok: true });
}));

securityRouter.get('/tab-permissions', ah(async (_req, res) => {
  res.json(TAB_PERMISSION_MAP);
}));

securityRouter.get('/me/permissions', ah(async (req, res) => {
  if (!req.rbac) return res.json({ permissions: [], permissionCodes: [], roles: [], tabAccess: {} });
  res.json({
    permissions: req.rbac.permissions,
    permissionCodes: effectivePermissionCodes(req.rbac),
    roles: req.rbac.roles,
    tabAccess: effectiveTabAccess(req.rbac),
  });
}));

export default securityRouter;
