import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import {
  resolveUserPermissions,
  isGlobalOwner,
  effectivePermissionCodes,
  effectiveTabAccess,
} from '../core/rbac/rbac-service.js';
import { TAB_PERMISSION_MAP, ROLE_CODES } from '../core/rbac/permission-catalog.js';
import { id } from '../utils/ids.js';

export const securityRouter = Router();
securityRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllPermissions = db.prepare(`SELECT id, code, resource, action, description, category FROM permissions ORDER BY category, resource, action`);
const stmtGetAllRoles = db.prepare(`SELECT id, code, name, description, is_system AS isSystem, is_active AS isActive, sort_order AS sortOrder FROM roles ORDER BY sort_order, name`);
const stmtGetAllRolePermissions = db.prepare(`SELECT rp.role_id, p.code, p.resource, p.action, p.description, rp.default_scope AS scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id ORDER BY p.category, p.code`);

const stmtGetRoleById = db.prepare(`SELECT id, code, name, description, is_system AS isSystem, is_active AS isActive FROM roles WHERE id = ?`);
const stmtUpdateRole = db.prepare(`UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), is_active = COALESCE(?, is_active), updated_at = datetime('now') WHERE id = ?`);
const stmtGetRoleByName = db.prepare('SELECT id FROM roles WHERE name = ?');
const stmtGetMaxRoleSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM roles');
const stmtGetPermissionsByRoleId = db.prepare(`SELECT p.id AS permissionId, p.code, p.resource, p.action, p.description, p.category, rp.default_scope AS scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`);
const stmtGetRoleCodeById = db.prepare('SELECT id, code FROM roles WHERE id = ?');
const stmtGetRoleWithSystemFlag = db.prepare('SELECT id, code, is_system AS isSystem FROM roles WHERE id = ?');
const stmtDeleteRolePermissions = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
const stmtInsertRolePermission = db.prepare('INSERT INTO role_permissions (id, role_id, permission_id, default_scope) VALUES (?, ?, ?, ?)');

const stmtGetUserRoles = db.prepare(`SELECT ur.id, ur.role_id AS roleId, r.code AS roleCode, r.name AS roleName, ur.scope_type AS scopeType, ur.scope_id AS scopeId, ur.is_primary AS isPrimary, ur.assigned_at AS assignedAt, ur.expires_at AS expiresAt FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY ur.is_primary DESC, r.sort_order`);
const stmtGetUserByIdSimple = db.prepare('SELECT id, branch_id AS branchId FROM users WHERE id = ?');
const stmtInsertUserRole = db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, assigned_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`);
const stmtDeleteUserRole = db.prepare('DELETE FROM user_roles WHERE id = ? AND user_id = ?');

const stmtGetPermId = db.prepare('SELECT id FROM permissions WHERE code = ?');
const stmtGetPermIdById = db.prepare('SELECT id, code FROM permissions WHERE id = ?');
const stmtGetUserOverrides = db.prepare(`SELECT o.id, o.permission_id AS permissionId, p.code AS permissionCode, o.effect, o.scope_type AS scopeType, o.scope_id AS scopeId, o.reason, o.created_at AS createdAt, o.expires_at AS expiresAt FROM permission_overrides o JOIN permissions p ON p.id = o.permission_id WHERE o.user_id = ? ORDER BY o.created_at DESC`);
const stmtInsertUserOverride = db.prepare(`INSERT INTO permission_overrides (id, user_id, permission_id, effect, scope_type, scope_id, reason, granted_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`);
const stmtGetOverrideById = db.prepare('SELECT id, user_id AS userId, scope_type AS scopeType, scope_id AS scopeId FROM permission_overrides WHERE id = ?');
const stmtDeleteUserOverride = db.prepare('DELETE FROM permission_overrides WHERE id = ?');

/** Safely extracts user context required for mutations */
function requireTargetUserAccess(req: import('express').Request, userId: string) {
  const target = stmtGetUserByIdSimple.get(userId) as { id: string; branchId: string | null } | undefined;
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.branchId && !canAccessBranchResource(req, target.branchId)) {
    throw new HttpError(403, 'User belongs to another branch.');
  }
  return target;
}

/** Is the caller a global owner? Only they may act beyond a single branch. */
function callerIsGlobalOwner(req: import('express').Request): boolean {
  return !!req.rbac && isGlobalOwner(req.rbac);
}

/**
 * A grant may never widen scope beyond the granter's own reach.
 *
 * Validating only `scopeType === 'branch'` lets 'organization' and 'campus'
 * sail past: a branch manager with delegated Role.Edit can then grant an
 * ORGANIZATION-scoped assignment (HTTP 201), which canAccessAllBranches reads
 * as access to every branch. Anything wider than a branch the caller can
 * already reach is now owner-only.
 */
function requireScopedAssignment(req: import('express').Request, scopeType: string | undefined, scopeId: string | null | undefined) {
  const scope = scopeType || 'branch';
  if (scope === 'branch') {
    if (scopeId && !canAccessBranchResource(req, scopeId)) {
      throw new HttpError(403, 'Role scope targets a branch outside your access.');
    }
    return;
  }
  if (!callerIsGlobalOwner(req)) {
    throw new HttpError(403, `Only a global owner may grant ${scope}-scoped access.`);
  }
}

function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId) {
    throw new HttpError(403, 'User context is missing for security operation.');
  }
  return user;
}

securityRouter.get('/permissions', requirePermission('Permission.View', 'Role.View'), ah(async (_req, res) => {
  res.json(stmtGetAllPermissions.all());
}));

securityRouter.get('/roles', requirePermission('Role.View'), ah(async (_req, res) => {
  const roles = stmtGetAllRoles.all() as any[];
  const allRolePerms = stmtGetAllRolePermissions.all() as any[];
  const permMap = new Map<string, any[]>();
  for (const p of allRolePerms) {
    if (!permMap.has(p.role_id)) permMap.set(p.role_id, []);
    permMap.get(p.role_id)!.push({ code: p.code, resource: p.resource, action: p.action, description: p.description, scope: p.scope });
  }

  res.json(roles.map((r) => ({ 
    ...r, 
    isSystem: !!r.isSystem, 
    isActive: !!r.isActive, 
    permissions: permMap.get(r.id) || [] 
  })));
}));

securityRouter.get('/roles/:id', requirePermission('Role.View'), ah(async (req, res) => {
  const role = stmtGetRoleById.get(req.params.id) as any;
  if (!role) throw new HttpError(404, 'Role not found.');
  
  const permissions = stmtGetPermissionsByRoleId.all(role.id);
  res.json({ ...role, isSystem: !!role.isSystem, isActive: !!role.isActive, permissions });
}));

securityRouter.put('/roles/:id/permissions', requirePermission('Role.Edit'), ah(async (req, res) => {
  const role = stmtGetRoleWithSystemFlag.get(req.params.id) as { id: string; code: string; isSystem: number } | undefined;
  if (!role) throw new HttpError(404, 'Role not found.');
  // System roles are the identity model the whole RBAC evaluator rests on. This
  // handler deletes every row then re-inserts the body, so an unguarded call
  // rewrites a system role wholesale. Reproduced live: a branch manager with
  // delegated Role.Edit cut the OWNER role's permission set down to 3 entries
  // and got {"ok":true,"count":3} — a denial of service against the owner.
  if (role.isSystem && !callerIsGlobalOwner(req)) {
    throw new HttpError(403, 'Only a global owner may change the permissions of a system role.');
  }

  const body = req.body as { permissions?: { permissionId: string; scope?: string }[] };
  if (!Array.isArray(body.permissions)) throw new HttpError(400, 'permissions array is required.');
  // A grant may not widen scope beyond the granter's reach.
  for (const p of body.permissions) requireScopedAssignment(req, p.scope || 'branch', null);
  
  const tx = db.transaction(() => {
    stmtDeleteRolePermissions.run(role.id);
    for (const p of body.permissions!) {
      stmtInsertRolePermission.run(id('rp'), role.id, p.permissionId, p.scope || 'branch');
    }
  });
  tx();
  
  writeAudit(req, `Updated permissions for role ${role.code}`, { newValue: `${body.permissions.length} permissions` });
  res.json({ ok: true, count: body.permissions.length });
}));

/**
 * POST /api/security/roles — create a custom position (data-driven).
 * A position is a role row with a name, description, active flag and a
 * permission set with per-permission scope. Custom positions are never
 * "identity" roles (is_system = 0), so they cannot replace a user's primary
 * identity role, but they can be assigned to any user as an additional
 * position with campus/branch scope.
 */
securityRouter.post('/roles', requirePermission('Role.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { name, description, permissions } = req.body as {
    name?: string; description?: string;
    permissions?: { permissionId: string; scope?: string }[];
  };
  if (!name || !String(name).trim()) throw new HttpError(400, 'Position name is required.');
  if (String(name).trim().length > 60) throw new HttpError(400, 'Position name is too long.');
  if (db.prepare('SELECT id FROM roles WHERE name = ?').get(String(name).trim())) {
    throw new HttpError(409, 'A position with this name already exists.');
  }
  const code = 'custom_' + String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'custom_position';
  if (db.prepare('SELECT id FROM roles WHERE code = ?').get(code)) {
    throw new HttpError(409, 'A position with this code already exists.');
  }
  const permList = Array.isArray(permissions) ? permissions : [];
  for (const p of permList) {
    if (!p.permissionId) throw new HttpError(400, 'Each permission needs a permissionId.');
    if (p.scope && !['organization', 'campus', 'branch', 'department', 'program', 'class', 'own'].includes(p.scope)) {
      throw new HttpError(400, `Invalid scope '${p.scope}' on a permission.`);
    }
    // A new position may not carry scope the creator cannot themselves grant.
    if (p.scope) requireScopedAssignment(req, p.scope, null);
  }
  const maxSort = (stmtGetMaxRoleSort.get() as { m: number }).m;
  const roleId = id('role');
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO roles (id, code, name, description, is_system, is_active, sort_order, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?, datetime('now'))`).run(roleId, code, String(name).trim(), description?.trim() || null, maxSort + 1);
    for (const p of permList) {
      const permRow = stmtGetPermIdById.get(p.permissionId) as { id: string } | undefined;
      if (permRow) stmtInsertRolePermission.run(id('rp'), roleId, permRow.id, p.scope || 'branch');
    }
  });
  tx();
  writeAudit(req, `Created position ${String(name).trim()} (${code}) with ${permList.length} permissions`);
  const role = stmtGetRoleById.get(roleId) as any;
  res.status(201).json({ id: roleId, code, name: role.name, description: role.description, isSystem: false, isActive: true });
}));

/**
 * PATCH /api/security/roles/:id — rename, re-describe or activate/deactivate
 * a position. Deactivating a position immediately stops it from contributing
 * permissions to every assigned user (resolved at request time). The owner
 * identity role cannot be deactivated (Owner model protection).
 */
securityRouter.patch('/roles/:id', requirePermission('Role.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const role = stmtGetRoleCodeById.get(req.params.id) as { id: string; code: string } | undefined;
  if (!role) throw new HttpError(404, 'Position not found.');
  const { name, description, isActive } = req.body as { name?: string; description?: string; isActive?: boolean };
  if (name !== undefined && (!String(name).trim() || String(name).trim().length > 60)) {
    throw new HttpError(400, 'Position name must be 1–60 characters.');
  }
  if (isActive === false && role.code === 'owner') {
    throw new HttpError(409, 'The Owner position cannot be deactivated.');
  }
  if (name !== undefined && String(name).trim() !== role.code) {
    const clash = db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(String(name).trim(), role.id);
    if (clash) throw new HttpError(409, 'A position with this name already exists.');
  }
  stmtUpdateRole.run(name !== undefined ? String(name).trim() : null, description !== undefined ? (description?.trim() || null) : null, isActive !== undefined ? (isActive ? 1 : 0) : null, role.id);
  writeAudit(req, `${isActive === false ? 'Deactivated' : isActive === true ? 'Activated' : 'Updated'} position ${role.code}`, {
    oldValue: 'role:' + role.code,
    newValue: JSON.stringify({ name, description, isActive }),
  });
  res.json({ ok: true });
}));

securityRouter.get('/users/:userId/roles', requirePermission('User.View', 'Role.View'), ah(async (req, res) => {
  requireTargetUserAccess(req, req.params.userId);
  const rows = stmtGetUserRoles.all(req.params.userId);
  res.json((rows as any[]).map((r) => ({ ...r, isPrimary: !!r.isPrimary })));
}));

securityRouter.post('/users/:userId/roles', requirePermission('User.Edit', 'Role.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { roleId, scopeType, scopeId, isPrimary, expiresAt } = req.body as any;
  
  if (!roleId) throw new HttpError(400, 'roleId is required.');
  const target = requireTargetUserAccess(req, req.params.userId);
  requireScopedAssignment(req, scopeType || 'branch', scopeId ?? null);
  
  const role = stmtGetRoleCodeById.get(roleId) as { id: string; code: string } | undefined;
  if (!role) throw new HttpError(404, 'Role not found.');
  // A principal may never grant privilege it does not itself hold. `owner` is
  // not an ordinary role: isGlobalOwner() short-circuits requirePermission() in
  // middleware/auth.ts, so holding it bypasses every permission check in every
  // branch. Reproduced live: a branch manager with delegated Role.Edit assigned
  // the owner role to an ordinary receptionist (HTTP 201) and that victim's
  // rebuilt context reported isGlobalOwner = true, canAccessAllBranches = true.
  if (role.code === 'owner' && !callerIsGlobalOwner(req)) {
    throw new HttpError(403, 'Only a global owner may grant the owner role.');
  }
  if (isPrimary) {
    if (!(ROLE_CODES as readonly string[]).includes(role.code)) {
      throw new HttpError(400, 'Only canonical identity roles can be assigned as primary.');
    }
    if ((scopeType || 'branch') !== (role.code === 'owner' ? 'organization' : 'branch')) {
      throw new HttpError(400, 'Primary role scope must match the identity role scope.');
    }
    if (expiresAt) throw new HttpError(400, 'Primary identity roles cannot expire.');
  }
  const tx = db.transaction(() => {
    if (isPrimary) {
      db.prepare('UPDATE user_roles SET is_primary = 0 WHERE user_id = ?').run(req.params.userId);
      // Changing someone's primary position must invalidate their live
      // sessions, or the old context keeps answering until the token expires.
      db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(req.params.userId);
    }
    const newId = id('ur');
    stmtInsertUserRole.run(newId, req.params.userId, roleId, scopeType || 'branch', scopeId ?? null, isPrimary ? 1 : 0, user.userId, expiresAt ?? null);
    return newId;
  });
  const newId = tx();

  writeAudit(req, `Assigned role ${role.code} to user ${req.params.userId}`);
  res.status(201).json({ id: newId });
}));

securityRouter.delete('/users/:userId/roles/:assignmentId', requirePermission('User.Edit', 'Role.Edit'), ah(async (req, res) => {
  requireTargetUserAccess(req, req.params.userId);
  const assignment = stmtGetUserRoles.all(req.params.userId) as any[];
  const targetAssignment = assignment.find((r: any) => r.id === req.params.assignmentId);
  if (!targetAssignment) throw new HttpError(404, 'Assignment not found.');
  if (targetAssignment.isPrimary) throw new HttpError(409, 'The primary identity role cannot be removed. Change the user primary role instead.');
  const result = stmtDeleteUserRole.run(req.params.assignmentId, req.params.userId);
  if (result.changes === 0) throw new HttpError(404, 'Assignment not found.');
  
  writeAudit(req, `Removed role assignment ${req.params.assignmentId}`);
  res.json({ ok: true });
}));

securityRouter.get('/users/:userId/effective-permissions', requirePermission('User.View', 'Permission.View'), ah(async (req, res) => {
  requireTargetUserAccess(req, req.params.userId);
  res.json(resolveUserPermissions(db, req.params.userId));
}));

securityRouter.get('/users/:userId/overrides', requirePermission('Permission.View'), ah(async (req, res) => {
  requireTargetUserAccess(req, req.params.userId);
  res.json(stmtGetUserOverrides.all(req.params.userId));
}));

securityRouter.post('/users/:userId/overrides', requirePermission('Permission.Override'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { permissionId, effect, scopeType, scopeId, reason, expiresAt } = req.body as any;
  requireTargetUserAccess(req, req.params.userId);
  requireScopedAssignment(req, scopeType || 'branch', scopeId ?? null);
  
  if (!permissionId || !effect) throw new HttpError(400, 'permissionId and effect are required.');
  if (effect !== 'grant' && effect !== 'deny') throw new HttpError(400, 'effect must be grant or deny.');
  
  const newId = id('po');
  stmtInsertUserOverride.run(newId, req.params.userId, permissionId, effect, scopeType || 'branch', scopeId ?? null, reason ?? null, user.userId, expiresAt ?? null);
  
  writeAudit(req, `Permission override ${effect} for user ${req.params.userId}`, { newValue: permissionId });
  res.status(201).json({ id: newId });
}));

securityRouter.delete('/overrides/:id', requirePermission('Permission.Override'), ah(async (req, res) => {
  const override = stmtGetOverrideById.get(req.params.id) as { id: string; userId: string; scopeType: string; scopeId: string | null } | undefined;
  if (!override) throw new HttpError(404, 'Override not found.');
  requireTargetUserAccess(req, override.userId);
  requireScopedAssignment(req, override.scopeType, override.scopeId);
  const result = stmtDeleteUserOverride.run(req.params.id);
  if (result.changes === 0) throw new HttpError(404, 'Override not found.');
  writeAudit(req, `Removed permission override ${req.params.id} from user ${override.userId}`);
  res.json({ ok: true });
}));

securityRouter.get('/tab-permissions', ah(async (_req, res) => { 
  res.json(TAB_PERMISSION_MAP); 
}));

securityRouter.get('/me/permissions', ah(async (req, res) => {
  if (req.rbac) {
    return res.json({
      permissions: req.rbac.permissions,
      permissionCodes: effectivePermissionCodes(req.rbac),
      roles: req.rbac.roles,
      tabAccess: effectiveTabAccess(req.rbac),
    });
  }
  res.json({ permissions: [], permissionCodes: [], roles: [], tabAccess: {} });
}));

export default securityRouter;