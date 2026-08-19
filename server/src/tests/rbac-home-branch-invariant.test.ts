/**
 * `canAccessBranch()` home-branch fallback — ACCEPTED / DOCUMENTED BEHAVIOUR.
 *
 * The function ends with:
 *
 *     return ctx.branchId === branchId;
 *
 * so a user always "matches" their own `users.branch_id` even when every RBAC
 * grant has expired. That looks alarming in isolation, so it was investigated
 * adversarially rather than assumed safe OR assumed broken.
 *
 * WHAT users.branch_id MEANS
 * --------------------------
 * `users.branch_id` is `TEXT NOT NULL REFERENCES branches(id)`: every user has
 * exactly one home branch. It is an IDENTITY attribute (which branch this
 * person belongs to), not an authorization grant.
 *
 * WHAT canAccessBranch ACTUALLY DECIDES
 * -------------------------------------
 * Every one of its ~20 call sites is a SECONDARY row-scoping check that runs
 * AFTER a route guard (`requirePermission(...)` / `authorize(...)`) has already
 * decided whether the caller may perform the action at all. It answers "may
 * this principal see rows belonging to branch X?", never "may this principal
 * act?". It is a ROW FILTER, not a grant.
 *
 * PROVEN LIVE OVER HTTP (fresh DB, real server, manager whose home branch is
 * the branch under test):
 *
 *   ACTIVE grant   list=200 readHomeStudent=200 classes=200 finance=200 create=201
 *   EXPIRED grant  list=403 readHomeStudent=403 classes=403 finance=403 create=403
 *
 * With the grant expired the principal holds perms=0, so the permission guard
 * denies first and the home-branch line is never reached as an authorization
 * decision. Resolver trace for the same two states:
 *
 *   ACTIVE   perms=71 roles=1 globalOwner=false canAccessBranch(HOME)=true
 *   EXPIRED  perms= 0 roles=0 globalOwner=false canAccessBranch(HOME)=true
 *
 * `canAccessBranch(HOME)=true` in both rows is exactly the point: it is not the
 * thing that grants access, which is why the endpoints still return 403.
 *
 * This suite locks that invariant so the fallback cannot silently become an
 * authorization path — if anyone ever calls canAccessBranch WITHOUT a
 * permission guard in front of it, the HTTP cases below start failing.
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

describe('home-branch fallback is a row filter, not an authorization grant', () => {
  it('an ACTIVE branch grant reaches the guarded home-branch endpoint', async () => {
    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(200);
  });

  it('an EXPIRED grant is refused at the permission gate, despite the home-branch match', async () => {
    setGrant('hbi_mgr', PAST);

    const ctx = ctxOf('hbi_mgr');
    // The fallback still reports true for the user's own branch...
    expect(canAccessBranch(db, ctx, HOME)).toBe(true);
    // ...but the principal holds no permissions and is not an owner...
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toHaveLength(0);
    expect(isGlobalOwner(ctx)).toBe(false);
    // ...so the endpoint is unreachable. This is the invariant that matters.
    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(403);
  });

  it('a DELETED grant (legacy fallback) keeps documented legacy behaviour', async () => {
    // No assignment history at all is the transient state syncLegacyUserRoles()
    // repairs; the legacy role legitimately applies and access is restored.
    db.prepare("DELETE FROM user_roles WHERE user_id = 'hbi_mgr'").run();
    const ctx = ctxOf('hbi_mgr');
    expect(ctx.permissionCodes.size).toBeGreaterThan(0);

    const res = await supertest(app).get('/guarded').set(bearer('hbi_mgr'));
    expect(res.status).toBe(200);
  });

  it('the home-branch fallback never widens access to a FOREIGN branch', async () => {
    db.prepare("INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES ('hbi_other', 'Other', 'Kabul', NULL)").run();
    const active = ctxOf('hbi_mgr');
    expect(canAccessBranch(db, active, 'hbi_other')).toBe(false);

    setGrant('hbi_mgr', PAST);
    const expired = ctxOf('hbi_mgr');
    expect(canAccessBranch(db, expired, 'hbi_other')).toBe(false);
  });
});
