/**
 * Branch access comes from an assignment, and from nothing else.
 *
 * `canAccessBranch()` used to end with:
 *
 *     return ctx.branchId === branchId;
 *
 * so a principal always "matched" their own `users.branch_id` even when every
 * RBAC grant had expired or been deleted. It was defended as a row filter
 * rather than a grant, on the grounds that a permission guard always runs
 * first — which was true of every call site, but made the function itself
 * answer the authorization question wrongly and left the system one
 * unguarded call site away from a cross-branch read.
 *
 * `users.branch_id` is an IDENTITY attribute: it records which branch a person
 * belongs to. It is not an authorization grant, so it no longer behaves like
 * one. Access is derived from `user_roles` scope alone, which is what makes
 * revocation and expiry actually revoke.
 *
 * This suite locks that in at both levels: the resolver returns the right
 * answer on its own, AND the guarded endpoint still denies.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  bootstrapRbacCatalog,
  buildRbacContext,
  canAccessBranch,
  isGlobalOwner,
} from '../core/rbac/rbac-service.js';

const HOME = 'hbi_home';
const PAST = '2020-01-01 00:00:00';

const userRow = (id: string) =>
  db.prepare('SELECT id, username, full_name, role, branch_id FROM users WHERE id = ?').get(id) as {
    id: string; username: string; full_name: string; role: string; branch_id: string;
  };
const ctxOf = (id: string) => buildRbacContext(db, userRow(id));
const roleId = (code: string) => (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: string }).id;

function setGrant(userId: string, expiresAt: string | null) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, assigned_by, expires_at)
     VALUES (?, ?, ?, 'branch', ?, 'test', ?)`,
  ).run(randomUUID(), userId, roleId('general_manager'), HOME, expiresAt);
}

let app: express.Express;
const bearer = (id: string) => {
  const u = userRow(id);
  const payload = {
    userId: u.id, username: u.username, role: u.role, branchId: u.branch_id,
    fullName: u.full_name, sessionVersion: 1,
  } as unknown as TokenPayload;
  return { Authorization: `Bearer ${signToken(payload)}` };
};

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare("INSERT OR IGNORE INTO organizations (id, name) VALUES ('hbi_org', 'Org')").run();
  db.prepare("INSERT OR IGNORE INTO campuses (id, organization_id, name, code) VALUES ('hbi_cp', 'hbi_org', 'Campus', 'HBIC')").run();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(HOME, 'Home Branch', 'Kabul', 'hbi_cp');

  const pw = await hashPassword('pw');
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('hbi_mgr', 'hbi_mgr', 'HBI Manager', 'manager', ?, ?, 1, 0)`,
  ).run(HOME, pw);

  // The real guard shape used across the codebase: permission gate first, then
  // the branch row-scoping check.
  app = express();
  app.use(express.json());
  app.get('/guarded', authenticate, requirePermission('Student.View'), (req, res) => {
    if (!canAccessBranch(db, req.rbac!, HOME)) return res.status(403).json({ error: 'branch' });
    res.json({ ok: true });
  });
  app.use(errorHandler);
});

beforeEach(() => setGrant('hbi_mgr', null));

describe('branch access derives from assignment scope only', () => {
  it('an ACTIVE branch grant reaches the guarded home-branch endpoint', async () => {
    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(200);
  });

  it('an EXPIRED grant revokes at the resolver AND at the endpoint', async () => {
    setGrant('hbi_mgr', PAST);

    const ctx = ctxOf('hbi_mgr');
    // The resolver itself now says no — including for the home branch.
    expect(canAccessBranch(db, ctx, HOME)).toBe(false);
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toHaveLength(0);
    expect(isGlobalOwner(ctx)).toBe(false);

    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(403);
  });

  it('DELETING every assignment actually revokes', async () => {
    // This is the defect that made revocation a no-op: with user_roles empty
    // the resolver re-granted the whole role from the users.role string, so
    // removing a person's assignments left their access untouched.
    db.prepare("DELETE FROM user_roles WHERE user_id = 'hbi_mgr'").run();
    const ctx = ctxOf('hbi_mgr');
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toHaveLength(0);
    expect(canAccessBranch(db, ctx, HOME)).toBe(false);

    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(403);
  });

  it('never grants a FOREIGN branch, active or expired', async () => {
    db.prepare("INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES ('hbi_other', 'Other', 'Kabul', NULL)").run();
    const active = ctxOf('hbi_mgr');
    expect(canAccessBranch(db, active, 'hbi_other')).toBe(false);

    setGrant('hbi_mgr', PAST);
    const expired = ctxOf('hbi_mgr');
    expect(canAccessBranch(db, expired, 'hbi_other')).toBe(false);
  });
});
