/**
 * TOEFL House ERP — RBAC Resolution Engine
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PERMISSION_CATALOG,
  ROLE_DEFINITIONS,
  TAB_PERMISSION_MAP,
  type PermissionScope,
  type RoleCode,
} from './permission-catalog.js';

export interface EffectivePermission {
  code: string; 
  scope: PermissionScope; 
  source: 'role' | 'override' | 'delegation';
  scopeId: string | null;
}

export interface RbacUserContext {
  userId: string;
  username: string;
  fullName: string;
  branchId: string;
  permissions: EffectivePermission[];
  permissionCodes: Set<string>; // O(1) lookup performance
  roles: {
    roleId: string;
    roleCode: string;
    roleName: string;
    scopeType: PermissionScope;
    scopeId: string | null;
    isPrimary?: number;
  }[];
  /**
   * The principal's primary position, for display and for audit attribution.
   * Derived from the assignments — it is a label, never an authorization
   * input. Null when the principal holds no live assignment.
   */
  primaryRole: string | null;
}

// ── Performance: Schema Existence Memoization ──────────────────────────────
// Checking sqlite_master on every API request is a massive performance killer.
// Cache schema detection per database connection. A process can own multiple
// SQLite connections in tests, workers, migrations, or tooling; a single global
// boolean would let a failed check on one DB poison every later DB.
const rbacSchemaCache = new WeakMap<Database.Database, boolean>();

function rbacSchemaExists(db: Database.Database): boolean {
  const cached = rbacSchemaCache.get(db);
  if (cached !== undefined) return cached;

  const tableCount = db.prepare(
    `SELECT COUNT(*) as c FROM sqlite_master 
     WHERE type='table' AND name IN ('roles', 'permissions', 'user_roles', 'role_permissions', 'role_delegations', 'permission_overrides')`
  ).get() as { c: number };
  
  const exists = tableCount.c === 6;
  rbacSchemaCache.set(db, exists);
  return exists;
}

// ── Performance: Prepared Statement Cache (WeakMap) ────────────────────────
interface RbacStatements {
  insertRole: Database.Statement;
  insertPerm: Database.Statement;
  insertRolePerm: Database.Statement;
  getRoleId: Database.Statement;
  getRolePerms: Database.Statement;
  deleteRolePerm: Database.Statement;
  getPermId: Database.Statement;
  insertUserRole: Database.Statement;
  getPrimaryUserRole: Database.Statement;
  getUserRbacPerms: Database.Statement;
  getDelegations: Database.Statement;
  getOverrides: Database.Statement;
  getUserRoles: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, RbacStatements>();

function getStmts(db: Database.Database): RbacStatements {
  if (stmtCache.has(db)) return stmtCache.get(db)!;
  
  const stmts: RbacStatements = {
    insertRole: db.prepare(`INSERT INTO roles (id, code, name, description, is_system, is_active, sort_order, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, datetime('now')) ON CONFLICT(code) DO UPDATE SET name=excluded.name, description=excluded.description, is_system=1, sort_order=excluded.sort_order, updated_at=datetime('now')`),
    insertPerm: db.prepare(`INSERT INTO permissions (id, code, resource, action, description, category, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(code) DO UPDATE SET resource=excluded.resource, action=excluded.action, description=excluded.description, category=excluded.category, is_system=1`),
    insertRolePerm: db.prepare(`INSERT INTO role_permissions (id, role_id, permission_id, default_scope) VALUES (?, ?, ?, ?) ON CONFLICT(role_id, permission_id) DO UPDATE SET default_scope=excluded.default_scope`),
    getRoleId: db.prepare('SELECT id FROM roles WHERE code = ?'),
    getRolePerms: db.prepare(`SELECT rp.id AS id, p.code AS code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`),
    deleteRolePerm: db.prepare('DELETE FROM role_permissions WHERE id = ?'),
    getPermId: db.prepare('SELECT id FROM permissions WHERE code = ?'),
    
    insertUserRole: db.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`),
    getPrimaryUserRole: db.prepare(`SELECT ur.id, r.code AS roleCode, ur.scope_type AS scopeType, ur.scope_id AS scopeId FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND ur.is_primary = 1 LIMIT 1`),
    
    getUserRbacPerms: db.prepare(`
      SELECT p.code AS code, rp.default_scope AS scope, ur.scope_type AS user_scope, ur.scope_id AS user_scope_id
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    `),
    getDelegations: db.prepare(`
      SELECT p.code AS code, rp.default_scope AS scope, d.scope_type AS delegation_scope, d.scope_id AS delegation_scope_id FROM role_delegations d
      JOIN role_permissions rp ON rp.role_id = d.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE d.to_user_id = ? AND d.is_active = 1 AND d.starts_at <= datetime('now') AND d.ends_at >= datetime('now')
    `),
    getOverrides: db.prepare(`
      SELECT p.code AS code, o.effect AS effect, o.scope_type AS scope, o.scope_id AS scope_id FROM permission_overrides o
      JOIN permissions p ON p.id = o.permission_id
      WHERE o.user_id = ? AND (o.expires_at IS NULL OR o.expires_at > datetime('now'))
    `),
    getUserRoles: db.prepare(`
      SELECT ur.role_id AS roleId, r.code AS roleCode, r.name AS roleName, ur.scope_type AS scopeType,
             ur.scope_id AS scopeId, ur.is_primary AS isPrimary
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
      ORDER BY ur.is_primary DESC
    `),
  };
  
  stmtCache.set(db, stmts);
  return stmts;
}

// ============================================================================
// §1 — BOOTSTRAP & SYNC
// ============================================================================

export function bootstrapRbacCatalog(db: Database.Database): void {
  if (!rbacSchemaExists(db)) return;
  const stmts = getStmts(db);
  
  const tx = db.transaction(() => {
    for (const p of PERMISSION_CATALOG) {
      stmts.insertPerm.run(randomUUID(), p.code, p.resource, p.action, p.description, p.category);
    }
    
    for (const r of ROLE_DEFINITIONS) {
      stmts.insertRole.run(randomUUID(), r.code, r.name, r.description, r.sortOrder);
      const roleRow = stmts.getRoleId.get(r.code) as { id: string } | undefined;
      if (!roleRow) continue;
      
      const allowed = new Set(Object.keys(r.permissions).filter((c) => !!r.permissions[c]));
      const existing = stmts.getRolePerms.all(roleRow.id) as { id: string; code: string }[];
      
      // Prune permissions that are no longer in the definition
      for (const row of existing) {
        if (!allowed.has(row.code)) stmts.deleteRolePerm.run(row.id);
      }
      
      // Insert current permissions
      for (const [permCode, scope] of Object.entries(r.permissions)) {
        if (!scope) continue;
        const permRow = stmts.getPermId.get(permCode) as { id: string } | undefined;
        if (!permRow) continue;
        stmts.insertRolePerm.run(randomUUID(), roleRow.id, permRow.id, scope);
      }
    }
  });
  
  tx();
}

/**
 * Assigns a principal's PRIMARY position.
 *
 * This is the only way a role is granted outside the security API. It is an
 * explicit command taking a canonical role code — there is no derivation from
 * any column on the user record, because a person's positions live in
 * `user_roles` and nowhere else.
 *
 * Secondary assignments are left untouched: holding several positions is a
 * supported arrangement, and re-stating someone's primary posting must not
 * quietly strip the others.
 */
export function assignPrimaryRole(
  db: Database.Database,
  userId: string,
  roleCode: RoleCode,
  branchId: string | null,
  assignedBy = 'system',
): void {
  const stmts = getStmts(db);
  const role = stmts.getRoleId.get(roleCode) as { id: string } | undefined;
  if (!role) throw new Error(`RBAC role '${roleCode}' is not configured.`);

  // The owner is an organization-wide position; every other role is scoped to
  // a branch, and a branch-scoped assignment without a branch is meaningless.
  const scopeType: PermissionScope = roleCode === 'owner' ? 'organization' : 'branch';
  const scopeId = roleCode === 'owner' ? null : branchId;
  if (scopeType === 'branch' && !scopeId) {
    throw new Error(`Role '${roleCode}' is branch-scoped and requires a branch.`);
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE user_roles SET is_primary = 0 WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, role.id);
    stmts.insertUserRole.run(randomUUID(), userId, role.id, scopeType, scopeId, assignedBy);
    db.prepare('UPDATE user_roles SET is_primary = 1 WHERE user_id = ? AND role_id = ?').run(userId, role.id);
  });
  tx();
}

// ============================================================================
// §2 — PERMISSION RESOLUTION
// ============================================================================

const SCOPE_RANK: Record<PermissionScope, number> = {
  organization: 6, campus: 5, branch: 4, department: 3, program: 2, class: 1, own: 0,
};

function narrowerScope(a: PermissionScope, b: PermissionScope): PermissionScope {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

export function resolveUserPermissions(db: Database.Database, userId: string): EffectivePermission[] {
  const grants: EffectivePermission[] = [];
  const stmts = getStmts(db);
  const schemaExists = rbacSchemaExists(db);

  if (schemaExists) {
    const rows = stmts.getUserRbacPerms.all(userId) as {
      code: string; scope: PermissionScope; user_scope: PermissionScope; user_scope_id: string | null;
    }[];
    for (const row of rows) {
      grants.push({ code: row.code, scope: narrowerScope(row.scope, row.user_scope), source: 'role', scopeId: row.user_scope_id });
    }

    const dels = stmts.getDelegations.all(userId) as {
      code: string; scope: PermissionScope; delegation_scope: PermissionScope; delegation_scope_id: string | null;
    }[];
    for (const d of dels) {
      grants.push({ code: d.code, scope: narrowerScope(d.scope, d.delegation_scope), source: 'delegation', scopeId: d.delegation_scope_id });
    }

    const overs = stmts.getOverrides.all(userId) as {
      code: string; effect: 'grant' | 'deny'; scope: PermissionScope; scope_id?: string | null;
    }[];
    for (const o of overs) {
      if (o.effect === 'deny') {
        for (let i = grants.length - 1; i >= 0; i--) if (grants[i].code === o.code) grants.splice(i, 1);
      } else {
        grants.push({ code: o.code, scope: o.scope, source: 'override', scopeId: o.scope_id ?? null });
      }
    }
    return grants;
  }

  return grants;
}

export function buildRbacContext(db: Database.Database, user: {
  id: string; username: string; full_name: string; branch_id: string;
}): RbacUserContext {
  const stmts = getStmts(db);
  const permissions = resolveUserPermissions(db, user.id);
  let roles: RbacUserContext['roles'] = [];
  
  if (rbacSchemaExists(db)) {
    roles = stmts.getUserRoles.all(user.id) as RbacUserContext['roles'];
  }
  
  const primaryRole = roles.find((r) => r.isPrimary)?.roleCode ?? roles[0]?.roleCode ?? null;

  return {
    primaryRole,
    userId: user.id, 
    username: user.username, 
    fullName: user.full_name, 
    branchId: user.branch_id, 
    permissions, 
    permissionCodes: new Set(permissions.map((p) => p.code)), 
    roles,
  };
}

// ============================================================================
// §3 — HELPER METHODS
// ============================================================================


export function hasRole(ctx: RbacUserContext, roleCode: string): boolean {
  return ctx.roles.some((r) => r.roleCode === roleCode);
}

/**
 * True only for a GLOBAL owner — the application superuser.
 *
 * `hasRole(ctx, 'owner')` ignores scope, and every superuser short-circuit in
 * the codebase used it. Granting someone the owner role scoped to a single
 * campus therefore produced a FULL owner: proven live, a user holding
 * owner@campus_kbl read students and finance belonging to a different campus,
 * listed all users, and created branches. Scoping the grant did nothing.
 *
 * The owner model itself is intentional (documented in the permission catalog
 * and in middleware/auth.ts) — it is the *scoped* grant that must not confer
 * it. Both the real seeded owner and the legacy-role fallback are
 * organization-scoped, so requiring organization scope preserves every
 * legitimate owner while closing the escalation.
 */
export function isGlobalOwner(ctx: RbacUserContext): boolean {
  return ctx.roles.some((r) => r.roleCode === 'owner' && r.scopeType === 'organization');
}

export function hasAnyRole(ctx: RbacUserContext, roleCodes: string[]): boolean {
  return roleCodes.some((role) => hasRole(ctx, role));
}

export function hasPermission(ctx: RbacUserContext, code: string): boolean {
  return ctx.permissionCodes.has(code);
}

export function hasAnyPermission(ctx: RbacUserContext, codes: string[]): boolean {
  return codes.some((c) => ctx.permissionCodes.has(c));
}

/**
 * What this principal may actually do, as the API reports it to a client.
 *
 * This differs from `ctx.permissionCodes` for exactly one principal. The
 * catalog withholds four destructive codes from the owner's stored grant
 * (`Attendance.Edit`, `Grade.Edit`, `Student.Delete`, `Payment.Delete`) so the
 * audit record shows them as a deliberate omission — but `authorize()` and
 * `requirePermission()` both bypass a global owner outright, so the owner can
 * perform them. Reporting the stored set would tell the UI something the server
 * does not believe, and the UI would hide controls the API accepts.
 *
 * Effective access is therefore resolved here, once. Callers serialize the
 * result; they do not re-apply the owner rule themselves.
 */
export function effectivePermissionCodes(ctx: RbacUserContext): string[] {
  if (isGlobalOwner(ctx)) return PERMISSION_CATALOG.map((p) => p.code);
  return Array.from(ctx.permissionCodes);
}

/**
 * Which top-level screens this principal may open.
 *
 * Derived from `effectivePermissionCodes` rather than from `permissionCodes`,
 * so tab visibility cannot disagree with the permission list shipped beside it
 * in the same response. A tab absent from `TAB_PERMISSION_MAP` would be absent
 * here too and would read as `undefined` — false — at every call site, so
 * `tab-access-authority.test.ts` requires every routed tab to be mapped.
 */
export function effectiveTabAccess(ctx: RbacUserContext): Record<string, boolean> {
  const granted = new Set(effectivePermissionCodes(ctx));
  return Object.fromEntries(
    Object.entries(TAB_PERMISSION_MAP).map(([tab, perm]) => [tab, granted.has(perm)]),
  );
}

export function getPermissionScope(ctx: RbacUserContext, code: string): PermissionScope | null {
  const matches = ctx.permissions.filter((p) => p.code === code);
  if (matches.length === 0) return null;
  // Effective authorization is deny-by-default. When several grants exist for
  // the same permission, resolve to the narrowest scope instead of depending
  // on database row order. Resource-specific scope IDs are enforced by the
  // caller's branch/resource checks.
  return matches.reduce((effective, grant) => narrowerScope(effective, grant.scope), matches[0].scope);
}
/**
 * Central branch-resource authorization. A role name never grants cross-branch
 * access by itself. Access is derived from the user's actual RBAC assignment.
 */
export function canAccessBranch(db: Database.Database, ctx: RbacUserContext, branchId: string): boolean {
  // Only an organization-scoped owner sees everything. A campus- or
  // branch-scoped owner falls through to the scope checks below, exactly like
  // any other role.
  if (isGlobalOwner(ctx)) return true;

  const branch = db.prepare('SELECT campus_id AS campusId FROM branches WHERE id = ?').get(branchId) as
    | { campusId: string | null }
    | undefined;
  if (!branch) return false;

  for (const role of ctx.roles) {
    if (role.scopeType === 'organization') return true;
    if (role.scopeType === 'branch' && role.scopeId === branchId) return true;
    if (role.scopeType === 'campus' && role.scopeId && role.scopeId === branch.campusId) return true;
  }

  // No home-branch fallback. `users.branch_id` records where a person is
  // based; it does not authorize anything. Access comes from an assignment
  // and nowhere else, so revoking the assignment revokes the access.
  return false;
}

export function canAccessAllBranches(ctx: RbacUserContext): boolean {
  return isGlobalOwner(ctx) || ctx.roles.some((r) => r.scopeType === 'organization');
}
