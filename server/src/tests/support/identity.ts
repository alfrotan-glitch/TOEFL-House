/**
 * Canonical identity fixtures.
 * ============================================================================
 * A principal's authority comes from a `user_roles` assignment and nothing
 * else. Tests must therefore create users the way the product does: insert the
 * person, then assign the position.
 *
 * Before this module, fixtures wrote a `role` string onto the user row and
 * relied on the resolver to infer permissions from it. That inference was a
 * second authority and has been removed, so a user created without an
 * assignment is genuinely permissionless — which is correct, and which is why
 * every fixture must go through here.
 */
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { db as defaultDb } from '../../db/connection.js';
import { bootstrapRbacCatalog } from '../../core/rbac/rbac-service.js';
import type { RoleCode } from '../../core/rbac/permission-catalog.js';
import type { PermissionScope } from '../../core/rbac/permission-catalog.js';
import { signToken, type TokenPayload } from '../../utils/auth.js';

type Db = BetterSqlite3.Database;

/** Role codes still referred to by their pre-canonical names in older fixtures. */
const RENAMED: Record<string, RoleCode> = {
  manager: 'general_manager',
  finance: 'finance_manager',
  registrar: 'receptionist',
  staff: 'data_entry',
  partner: 'donor_manager',
};

/**
 * Accepts either a canonical role code or one of the pre-canonical names, so a
 * fixture reading `'manager'` keeps meaning what its author intended.
 */
export function toRoleCode(role: string): RoleCode {
  return (RENAMED[role] ?? role) as RoleCode;
}

const catalogReady = new WeakSet<object>();
function ensureCatalog(db: Db): void {
  if (catalogReady.has(db)) return;
  const count = db.prepare('SELECT COUNT(*) c FROM roles').get() as { c: number };
  if (count.c === 0) bootstrapRbacCatalog(db);
  catalogReady.add(db);
}

export interface AssignRoleOptions {
  scopeType?: PermissionScope;
  scopeId?: string | null;
  isPrimary?: boolean;
  expiresAt?: string | null;
  db?: Db;
}

/**
 * Grants a position. `owner` is organization-wide; everything else is scoped
 * to a branch, matching how the product assigns roles.
 */
export function assignRole(userId: string, role: string, branchId: string | null, opts: AssignRoleOptions = {}): void {
  const db = opts.db ?? defaultDb;
  ensureCatalog(db);
  const code = toRoleCode(role);
  const roleRow = db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: string } | undefined;
  if (!roleRow) throw new Error(`Test fixture requested role '${code}', which is not in the catalog.`);

  const scopeType: PermissionScope = opts.scopeType ?? (code === 'owner' ? 'organization' : 'branch');
  const scopeId = opts.scopeId !== undefined ? opts.scopeId : (code === 'owner' ? null : branchId);
  const isPrimary = opts.isPrimary ?? true;

  if (isPrimary) db.prepare('UPDATE user_roles SET is_primary = 0 WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, roleRow.id);
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`,
  ).run(randomUUID(), userId, roleRow.id, scopeType, scopeId, isPrimary ? 1 : 0, opts.expiresAt ?? null);
}

export interface SeedUserOptions {
  id: string;
  role: string;
  branchId: string;
  username?: string;
  fullName?: string;
  passwordHash?: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
  sessionVersion?: number;
  linkedStudentId?: string | null;
  linkedTeacherId?: string | null;
  email?: string | null;
  scopeType?: PermissionScope;
  scopeId?: string | null;
  db?: Db;
}

/** Creates a user and grants their primary position in one step. */
export function seedUser(opts: SeedUserOptions): string {
  const db = opts.db ?? defaultDb;
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, username, full_name, email, branch_id, password_hash, is_active, must_change_password,
        session_version, linked_student_id, linked_teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.username ?? opts.id,
    opts.fullName ?? opts.id,
    opts.email ?? null,
    opts.branchId,
    opts.passwordHash ?? 'test-hash',
    opts.isActive === false ? 0 : 1,
    opts.mustChangePassword ? 1 : 0,
    opts.sessionVersion ?? 1,
    opts.linkedStudentId ?? null,
    opts.linkedTeacherId ?? null,
  );
  assignRole(opts.id, opts.role, opts.branchId, {
    db,
    scopeType: opts.scopeType,
    scopeId: opts.scopeId,
  });
  return opts.id;
}

/** A signed token for an existing user. The token carries no role by design. */
export function tokenFor(userId: string, db: Db = defaultDb): string {
  const row = db
    .prepare('SELECT id, username, full_name, branch_id, session_version FROM users WHERE id = ?')
    .get(userId) as
    | { id: string; username: string; full_name: string; branch_id: string; session_version: number }
    | undefined;
  if (!row) throw new Error(`Test fixture asked for a token for unknown user '${userId}'.`);
  return signToken({
    userId: row.id,
    username: row.username,
    fullName: row.full_name,
    branchId: row.branch_id,
    sessionVersion: row.session_version,
  } as TokenPayload);
}

/** Authorization header for an existing user. */
export function bearerFor(userId: string, db: Db = defaultDb): { Authorization: string } {
  return { Authorization: `Bearer ${tokenFor(userId, db)}` };
}
