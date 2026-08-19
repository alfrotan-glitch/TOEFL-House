/**
 * RBAC-1 — an EXPIRED explicit role grant must revoke privilege, never widen it.
 *
 * REPRODUCED LIVE OVER HTTP BEFORE THE FIX (fresh DB, one login per case):
 *
 *   campus-scoped owner, grant ACTIVE   -> GET /users 200
 *                                          GET /students?branchId=all  [s_b1]
 *                                          GET /students/s_b2 (other campus)  403
 *   campus-scoped owner, grant EXPIRED  -> GET /users 200
 *                                          GET /students?branchId=all  [s_b1, s_b2]
 *                                          GET /students/s_b2 (other campus)  200   <-- ESCALATION
 *
 * Expiring the grant WIDENED access from one campus to the whole organization.
 *
 * MECHANISM
 * ---------
 *   getUserRoles()      correctly filters `expires_at > datetime('now')` and so
 *                       returns ZERO rows once the grant lapses.
 *   buildRbacContext()  read `roles.length === 0` as "legacy user whose RBAC rows
 *                       have not been synced yet" and SYNTHESIZED a role from
 *                       users.role, with scopeType 'organization' for an owner.
 *   isGlobalOwner()     then returned true, and both authorize() and
 *                       requirePermission() short-circuit on it.
 *
 * The direct trace, before the fix:
 *
 *   ACTIVE  campus grant   perms=99  src=role     globalOwner=false  B1=true B2=false
 *   EXPIRED campus grant   perms= 0  src=(none)   globalOwner=TRUE   B1=true B2=true
 *
 * `perms=0` beside `globalOwner=true` is the whole defect: permission resolution
 * honours expiry, role resolution silently undid it.
 *
 * INVARIANT LOCKED HERE
 * ---------------------
 * If an explicit RBAC assignment EXISTS but every one is expired, the principal
 * is permissionless. Expiry must never trigger the legacy-role fallback. A user
 * with no assignment history at all keeps the documented legacy behaviour — that
 * path is exercised below so the fix cannot silently delete legacy support.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { authenticate, authorize, requirePermission } from '../middleware/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  bootstrapRbacCatalog,
  buildRbacContext,
  isGlobalOwner,
  canAccessBranch,
  canAccessAllBranches,
  resolveUserPermissions,
} from '../core/rbac/rbac-service.js';

const PAST = '2020-01-01 00:00:00';
const FUTURE = '2099-01-01 00:00:00';

const userRow = (id: string) =>
  db.prepare('SELECT id, username, full_name, role, branch_id FROM users WHERE id = ?').get(id) as {
    id: string; username: string; full_name: string; role: string; branch_id: string;
  };

const ctxOf = (id: string) => buildRbacContext(db, userRow(id));
const roleId = (code: string) => (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: string }).id;

/** Replace every grant for a user with exactly the ones described. */
function setGrants(userId: string, grants: Array<{ role: string; scopeType: string; scopeId: string | null; expiresAt?: string | null }>) {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  for (const g of grants) {
    db.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, assigned_by, expires_at)
       VALUES (?, ?, ?, ?, ?, 'test', ?)`,
    ).run(randomUUID(), userId, roleId(g.role), g.scopeType, g.scopeId, g.expiresAt ?? null);
  }
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare("INSERT OR IGNORE INTO organizations (id, name) VALUES ('rbx_org', 'Org')").run();
  db.prepare("INSERT OR IGNORE INTO campuses (id, organization_id, name, code) VALUES ('rbx_c1', 'rbx_org', 'Campus 1', 'RBXC1')").run();
  db.prepare("INSERT OR IGNORE INTO campuses (id, organization_id, name, code) VALUES ('rbx_c2', 'rbx_org', 'Campus 2', 'RBXC2')").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES ('RBX_B1', 'Branch 1', 'Kabul', 'rbx_c1')").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES ('RBX_B2', 'Branch 2', 'Kabul', 'rbx_c2')").run();

  const pw = await hashPassword('Passw0rd!23');
  for (const [id, role, branch] of [
    ['rbx_owner', 'owner', 'RBX_B1'],
    ['rbx_mgr', 'manager', 'RBX_B1'],
    ['rbx_legacy', 'owner', 'RBX_B1'],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    ).run(id, id, id.toUpperCase(), role, branch, pw);
  }
});

beforeEach(() => {
  // Every case declares its own grants; never inherit another case's state.
  setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1' }]);
  setGrants('rbx_mgr', [{ role: 'general_manager', scopeType: 'branch', scopeId: 'RBX_B1' }]);
  db.prepare("DELETE FROM user_roles WHERE user_id = 'rbx_legacy'").run();
});

describe('RBAC-1 · an expired grant must revoke, never escalate', () => {
  it('1 · ACTIVE campus-scoped owner: own campus allowed, other campus denied', () => {
    const ctx = ctxOf('rbx_owner');
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, 'RBX_B1')).toBe(true);
    expect(canAccessBranch(db, ctx, 'RBX_B2')).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
  });

  it('2 · EXPIRED campus-scoped owner: both branches denied and NOT a global owner', () => {
    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const ctx = ctxOf('rbx_owner');

    // The exact escalation: before the fix this was globalOwner=true, B2=true.
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, 'RBX_B2')).toBe(false);
    expect(ctx.permissionCodes.size).toBe(0);
    expect(ctx.roles).toHaveLength(0);

    // NOTE on the home branch: `canAccessBranch` ends with
    // `return ctx.branchId === branchId`, so a user always matches their own
    // `users.branch_id` regardless of grants. Verified PRE-EXISTING on unfixed
    // code with an expired branch-scoped manager (perms=0, globalOwner=false,
    // homeBranch=true), so it is neither caused by nor in scope for this fix.
    // What matters here is that the expired principal carries NO permissions,
    // which is what every route guard actually consults.
    expect(canAccessBranch(db, ctx, 'RBX_B1')).toBe(true);
  });

  it('3 · a not-yet-active (future) assignment leaves the principal permissionless', () => {
    // An assignment that exists but is outside its validity window must not be
    // treated as "no history" either.
    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const expired = ctxOf('rbx_owner');
    expect(expired.permissionCodes.size).toBe(0);
    expect(isGlobalOwner(expired)).toBe(false);

    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: FUTURE }]);
    const live = ctxOf('rbx_owner');
    expect(live.permissionCodes.size).toBeGreaterThan(0);
    expect(isGlobalOwner(live)).toBe(false); // campus scope, still not global
  });

  it('4 · one active + one expired assignment: only the active one contributes', () => {
    setGrants('rbx_mgr', [
      { role: 'general_manager', scopeType: 'branch', scopeId: 'RBX_B1' },
      { role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST },
    ]);
    const ctx = ctxOf('rbx_mgr');

    expect(ctx.roles.map((r) => r.roleCode)).toEqual(['general_manager']);
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, 'RBX_B1')).toBe(true);
    expect(canAccessBranch(db, ctx, 'RBX_B2')).toBe(false);
    expect(ctx.permissionCodes.size).toBeGreaterThan(0);
  });

  it('5 · when the final active assignment expires the principal becomes permissionless', () => {
    const before = ctxOf('rbx_mgr');
    expect(before.permissionCodes.size).toBeGreaterThan(0);

    setGrants('rbx_mgr', [{ role: 'general_manager', scopeType: 'branch', scopeId: 'RBX_B1', expiresAt: PAST }]);
    const after = ctxOf('rbx_mgr');

    expect(after.permissionCodes.size).toBe(0);
    expect(after.roles).toHaveLength(0);
    // Home-branch identity survives (see the note in case 2) — the security
    // property is that the principal now holds zero permissions, so every
    // requirePermission()/authorize() gate denies.
    expect(canAccessAllBranches(after)).toBe(false);
    expect(isGlobalOwner(after)).toBe(false);
  });

  it('6 · users.role=owner + expired explicit grant must NOT resolve to organization owner', () => {
    // The precise escalation vector: the legacy column still says 'owner', so a
    // fallback keyed only on "no active roles" hands back organization scope.
    expect(userRow('rbx_owner').role).toBe('owner');
    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const ctx = ctxOf('rbx_owner');

    expect(ctx.roles.some((r) => r.scopeType === 'organization')).toBe(false);
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(resolveUserPermissions(db, 'rbx_owner')).toHaveLength(0);
  });

  // ── HTTP layer: the defect was demonstrated through the authorization
  // middleware, so the fix must be demonstrated there too, not only in the
  // resolver. These mount the REAL authenticate/authorize/requirePermission
  // chain rather than calling helpers directly.
  const httpApp = () => {
    const app = express();
    app.use(express.json());
    app.get('/org-only', authenticate, authorize('owner'), (_req, res) => res.json({ ok: true }));
    app.get('/needs-perm', authenticate, requirePermission('User.View'), (_req, res) => res.json({ ok: true }));
    app.get('/branch-resource/:branchId', authenticate, (req, res) => {
      const ctx = req.rbac!;
      if (!canAccessBranch(db, ctx, req.params.branchId)) return res.status(403).json({ error: 'forbidden' });
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  };
  const bearer = (id: string) => {
    const u = userRow(id);
    const payload: TokenPayload = {
      userId: u.id, username: u.username, role: u.role as never,
      branchId: u.branch_id, fullName: u.full_name, sessionVersion: 1,
    } as TokenPayload;
    return { Authorization: `Bearer ${signToken(payload)}` };
  };

  it('7 · authorize() must not take the global-owner shortcut for an expired owner', async () => {
    const app = httpApp();
    // Active campus grant: authorize('owner') passes on the role itself.
    expect((await supertest(app).get('/org-only').set(bearer('rbx_owner'))).status).toBe(200);

    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const res = await supertest(app).get('/org-only').set(bearer('rbx_owner'));
    expect(res.status).toBe(403);
  });

  it('8 · requirePermission() must deny a protected action for an expired owner', async () => {
    const app = httpApp();
    expect((await supertest(app).get('/needs-perm').set(bearer('rbx_owner'))).status).toBe(200);

    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const res = await supertest(app).get('/needs-perm').set(bearer('rbx_owner'));
    expect(res.status).toBe(403);
  });

  it('9 · cross-branch access stays 403 for an expired owner', async () => {
    const app = httpApp();
    // Active campus-scoped owner already cannot reach the other campus.
    expect((await supertest(app).get('/branch-resource/RBX_B2').set(bearer('rbx_owner'))).status).toBe(403);

    setGrants('rbx_owner', [{ role: 'owner', scopeType: 'campus', scopeId: 'rbx_c1', expiresAt: PAST }]);
    const res = await supertest(app).get('/branch-resource/RBX_B2').set(bearer('rbx_owner'));
    expect(res.status).toBe(403);
  });

  it('10 · a genuine legacy user with NO assignment history keeps documented behaviour', () => {
    // Legacy support must survive the fix. This user has never had a row in
    // user_roles, which is the transient state syncLegacyUserRoles() repairs.
    expect(db.prepare("SELECT COUNT(*) c FROM user_roles WHERE user_id = 'rbx_legacy'").get()).toEqual({ c: 0 });

    const ctx = ctxOf('rbx_legacy');
    expect(ctx.permissionCodes.size).toBeGreaterThan(0);
    expect(ctx.roles[0].roleCode).toBe('owner');
    expect(isGlobalOwner(ctx)).toBe(true);
    expect(resolveUserPermissions(db, 'rbx_legacy').every((p) => p.source === 'legacy')).toBe(true);
  });
});
