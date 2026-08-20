/**
 * `user_roles` is the only authority for what a principal may do.
 * ============================================================================
 * The system carries a denormalized `users.role` string alongside the
 * `user_roles` / `roles` / `permissions` tables. Until this suite existed, that
 * string was not merely denormalized — it was a second authority, and two
 * authorities for one concept is a defect by definition.
 *
 * Both failures below were reproduced before they were fixed:
 *
 *   REVOCATION WAS A NO-OP
 *     DELETE FROM user_roles WHERE user_id = 'x'   -> principal keeps 74 permissions
 *     The resolver treated an empty assignment set as "legacy user not yet
 *     synchronized" and re-granted the entire role from users.role.
 *
 *   A STRING COLUMN GRANTED SUPERUSER
 *     UPDATE users SET role = 'owner' WHERE id = 'x'  (assignments empty)
 *     -> isGlobalOwner() true, every branch readable
 *     The resolver synthesized an organization-scoped owner role out of the
 *     column.
 *
 * The rule these tests pin: a permission exists because an assignment grants
 * it. `users.role` is a profile attribute and `users.branch_id` is an identity
 * attribute; neither authorizes anything.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import {
  bootstrapRbacCatalog,
  buildRbacContext,
  canAccessBranch,
  canAccessAllBranches,
  isGlobalOwner,
  resolveUserPermissions,
} from '../core/rbac/rbac-service.js';

const HOME = 'auth_home';
const FOREIGN = 'auth_foreign';
const USER = 'auth_probe';

const roleId = (code: string) =>
  (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: string }).id;

const ctxOf = () =>
  buildRbacContext(db, {
    id: USER,
    username: USER,
    full_name: 'Authority Probe',
    role: (db.prepare('SELECT role FROM users WHERE id = ?').get(USER) as { role: string }).role,
    branch_id: HOME,
  });

/**
 * A person may hold several postings, but exactly one is primary — the
 * database enforces that with a trigger, so the helper makes the caller say
 * which one it is rather than quietly defaulting.
 */
function assign(code: string, scopeType: string, scopeId: string | null, isPrimary = true) {
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
     VALUES (?, ?, ?, ?, ?, ?, 'test')`,
  ).run(randomUUID(), USER, roleId(code), scopeType, scopeId, isPrimary ? 1 : 0);
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare(
    'INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)',
  ).run('auth_campus', FIXED_ORG_ID, 'Authority Campus', 'AUTHC');
  for (const b of [HOME, FOREIGN]) {
    db.prepare(
      'INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)',
    ).run(b, b, 'Kabul', 'auth_campus');
  }
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, 'Authority Probe', 'manager', ?, 'test-hash', 1, 0)`,
  ).run(USER, USER, HOME);
});

beforeEach(() => {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(USER);
  db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(USER);
});

describe('user_roles is the sole authority', () => {
  it('an assignment is what grants permissions', () => {
    assign('general_manager', 'branch', HOME);
    const ctx = ctxOf();
    expect(ctx.permissionCodes.size).toBeGreaterThan(0);
    expect(ctx.roles).toHaveLength(1);
    expect(ctx.permissions.every((p) => p.source === 'role')).toBe(true);
  });

  it('removing every assignment removes every permission', () => {
    assign('general_manager', 'branch', HOME);
    expect(ctxOf().permissionCodes.size).toBeGreaterThan(0);

    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(USER);

    const ctx = ctxOf();
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toEqual([]);
    expect(resolveUserPermissions(db, USER)).toEqual([]);
  });

  it('users.role cannot grant a permission on its own', () => {
    // No assignment at all; the column claims the most privileged position.
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(USER);

    const ctx = ctxOf();
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toEqual([]);
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, HOME)).toBe(false);
    expect(canAccessBranch(db, ctx, FOREIGN)).toBe(false);
  });

  it('users.role cannot widen an assignment that already exists', () => {
    assign('general_manager', 'branch', HOME);
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(USER);

    const ctx = ctxOf();
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, FOREIGN)).toBe(false);
    expect(ctx.roles.map((r) => r.roleCode)).toEqual(['general_manager']);
  });

  it('users.branch_id does not authorize its own branch', () => {
    // The principal is based in HOME but holds a grant only for FOREIGN.
    assign('general_manager', 'branch', FOREIGN);

    const ctx = ctxOf();
    expect(canAccessBranch(db, ctx, FOREIGN)).toBe(true);
    expect(canAccessBranch(db, ctx, HOME)).toBe(false);
  });

  it('an expired assignment grants nothing', () => {
    db.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, expires_at)
       VALUES (?, ?, ?, 'branch', ?, 1, 'test', '2020-01-01 00:00:00')`,
    ).run(randomUUID(), USER, roleId('general_manager'), HOME);

    const ctx = ctxOf();
    expect(ctx.permissionCodes.size).toBe(0);
    expect(canAccessBranch(db, ctx, HOME)).toBe(false);
  });

  it('multiple simultaneous assignments union their reach', () => {
    // The multi-position requirement: one person, two postings, both honoured.
    assign('general_manager', 'branch', HOME);
    assign('receptionist', 'branch', FOREIGN, false);

    const ctx = ctxOf();
    expect(ctx.roles).toHaveLength(2);
    expect(canAccessBranch(db, ctx, HOME)).toBe(true);
    expect(canAccessBranch(db, ctx, FOREIGN)).toBe(true);
    expect(canAccessAllBranches(ctx)).toBe(false);
  });
});
