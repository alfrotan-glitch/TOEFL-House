/**
 * SECURITY — privilege-grant surface (roles, scopes and permission overrides).
 *
 * The RBAC *evaluator* is frozen and audited. This suite covers the *grant API*
 * in routes/security.routes.ts, which is what writes the rows the evaluator
 * later trusts, and which had no dedicated coverage.
 *
 * The endpoints are gated by `requirePermission('Role.Edit')` /
 * `('Permission.Override')`. By default only the owner holds those, but they
 * are ordinary delegatable permissions — an organisation can legitimately give
 * a branch manager `Role.Edit` + `User.Edit` to administer their own branch's
 * staff. Everything below is reproduced from exactly that supported position:
 * a branch manager, NOT an owner, with those permissions delegated.
 *
 * SEC-1 (CRITICAL) · vertical privilege escalation to global owner.
 *   POST /security/users/:userId/roles accepted the owner identity role from a
 *   branch manager. Live: the manager assigned roleCode 'owner' at
 *   scopeType 'organization' to an ordinary receptionist and got HTTP 201.
 *   Rebuilding that victim's real RBAC context gave
 *     isGlobalOwner = true, canAccessAllBranches = true
 *   and `users.role` was rewritten to 'owner'. `isGlobalOwner` short-circuits
 *   `requirePermission` in middleware/auth.ts, so the victim now bypasses every
 *   permission check in the entire system, in every branch. A branch-level
 *   administrator could mint an organisation-wide superuser — including
 *   themselves, via a second account they administer.
 *
 * SEC-2 (HIGH) · scope escalation past the branch guard.
 *   `requireScopedAssignment` only validated `scopeType === 'branch'`. A branch
 *   manager therefore granted an ORGANIZATION-scoped role assignment (HTTP 201,
 *   stored scope_type='organization'), which `canAccessAllBranches` treats as
 *   access to every branch. The same hole applied to permission overrides: an
 *   organization-scoped `grant` override was accepted (HTTP 201).
 *
 * SEC-3 (HIGH) · system identity roles were rewritable.
 *   PUT /security/roles/:id/permissions had no `is_system` guard. A branch
 *   manager replaced the OWNER role's entire permission set: the endpoint
 *   deletes all rows then re-inserts the body, so the live run took the owner
 *   role from its full catalogue down to 3 permissions and returned
 *   {"ok":true,"count":3}. That is a denial-of-service against the owner and a
 *   silent rewrite of the system's identity model.
 *
 * The invariant: a principal may never grant privilege it does not itself
 * hold, may never widen scope beyond its own reach, and may never rewrite a
 * system identity role. Owner remains reachable only from an existing global
 * owner.
 *
 * Enforcement reuses the frozen RBAC authorities already imported by this
 * route — `isGlobalOwner` and `canAccessBranchResource` — rather than adding a
 * parallel notion of who is privileged.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, buildRbacContext, isGlobalOwner, canAccessAllBranches } from '../core/rbac/rbac-service.js';
import securityRouter from '../routes/security.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';

const BRANCH_A = 'secg_a';
const BRANCH_B = 'secg_b';

let app: express.Express;
let owner: TokenPayload;
let manager: TokenPayload;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const roleByCode = (code: string) => db.prepare('SELECT id, code, is_system FROM roles WHERE code = ?').get(code) as { id: string; code: string; is_system: number };
const permByCode = (code: string) => db.prepare('SELECT id, code FROM permissions WHERE code = ?').get(code) as { id: string; code: string } | undefined;

/** Rebuild the victim's real RBAC context the way the auth middleware does. */
function contextOf(userId: string) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as never;
  return buildRbacContext(db, row);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  app = express();
  app.use(express.json());
  app.use('/api/security', securityRouter);
  app.use(errorHandler);

  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')").run(BRANCH_A, 'Sec A');
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')").run(BRANCH_B, 'Sec B');

  const pwd = await hashPassword('Str0ng!Pass2026');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO users (id, username, password_hash, full_name, branch_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
  );
  ins.run('secg_owner', 'secg_owner', pwd, 'Owner', BRANCH_A);
  assignRole('secg_owner', 'owner', BRANCH_A);
  ins.run('secg_manager', 'secg_manager', pwd, 'Manager', BRANCH_A);
  assignRole('secg_manager', 'manager', BRANCH_A);
  ins.run('secg_victim', 'secg_victim', pwd, 'Victim', BRANCH_A);
  assignRole('secg_victim', 'registrar', BRANCH_A);
  ins.run('secg_victim_b', 'secg_victim_b', pwd, 'Victim B', BRANCH_B);
  assignRole('secg_victim_b', 'registrar', BRANCH_B);

  owner = { userId: 'secg_owner', username: 'secg_owner', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;
  manager = { userId: 'secg_manager', username: 'secg_manager', branchId: BRANCH_A, fullName: 'Manager' } as TokenPayload;

  // The supported delegation this suite is written around: a branch manager is
  // given the staff-administration permissions for their own branch.
  const gm = roleByCode('general_manager');
  for (const code of ['Role.View', 'Role.Edit', 'User.View', 'User.Edit', 'Permission.View', 'Permission.Override']) {
    const p = permByCode(code);
    if (p) {
      db.prepare("INSERT OR IGNORE INTO role_permissions (id, role_id, permission_id, default_scope) VALUES (?, ?, ?, 'branch')")
        .run(id('rp'), gm.id, p.id);
    }
  }
});

describe('SEC-1 · the owner identity role cannot be granted by a non-owner', () => {
  it('refuses to make an ordinary user a primary global owner', async () => {
    const ownerRole = roleByCode('owner');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: ownerRole.id, scopeType: 'organization', scopeId: null, isPrimary: true });

    expect(res.status).toBe(403);
    const ctx = contextOf('secg_victim');
    expect(isGlobalOwner(ctx)).toBe(false);
    expect((db.prepare(`SELECT r.code AS role FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND ur.is_primary = 1`).get('secg_victim') as { role: string } | undefined)?.role).toBe('receptionist');
  });

  it('refuses the same escalation without the isPrimary flag', async () => {
    const ownerRole = roleByCode('owner');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: ownerRole.id, scopeType: 'organization', scopeId: null });

    expect(res.status).toBe(403);
    expect(isGlobalOwner(contextOf('secg_victim'))).toBe(false);
    expect(canAccessAllBranches(contextOf('secg_victim'))).toBe(false);
  });

  it('refuses the owner role at BRANCH scope too', async () => {
    // Narrower scope is not safe: owner@branch still resolves to the full
    // 125-permission owner catalogue for that branch, including Role.Edit,
    // User.Edit and Permission.Override — enough to re-administer the branch
    // and keep escalating. Verified by execution before this test was written.
    const ownerRole = roleByCode('owner');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: ownerRole.id, scopeType: 'branch', scopeId: BRANCH_A });

    expect(res.status).toBe(403);
    const granted = db
      .prepare("SELECT COUNT(*) AS c FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.code = 'owner'")
      .get('secg_victim') as { c: number };
    expect(granted.c).toBe(0);
  });

  it('a real global owner may still grant the owner role', async () => {
    const ownerRole = roleByCode('owner');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(owner))
      .send({ roleId: ownerRole.id, scopeType: 'organization', scopeId: null });

    expect(res.status).toBe(201);
    expect(isGlobalOwner(contextOf('secg_victim'))).toBe(true);
    // Undo, so later cases start from an unprivileged victim.
    db.prepare('DELETE FROM user_roles WHERE id = ?').run(res.body.id);
    expect(isGlobalOwner(contextOf('secg_victim'))).toBe(false);
  });
});

describe('SEC-2 · scope may not be widened beyond the granter reach', () => {
  it('refuses an organization-scoped role assignment from a branch manager', async () => {
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: gm.id, scopeType: 'organization', scopeId: null });

    expect(res.status).toBe(403);
    expect(canAccessAllBranches(contextOf('secg_victim'))).toBe(false);
  });

  it('refuses a campus-scoped role assignment from a branch manager', async () => {
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: gm.id, scopeType: 'campus', scopeId: 'any_campus' });

    expect(res.status).toBe(403);
  });

  it('refuses an organization-scoped permission override from a branch manager', async () => {
    const perm = permByCode('Payment.Delete') ?? permByCode('Payment.View')!;
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/overrides')
      .set(authHeader(manager))
      .send({ permissionId: perm.id, effect: 'grant', scopeType: 'organization', scopeId: null, reason: 'x' });

    expect(res.status).toBe(403);
    const stored = db.prepare('SELECT COUNT(*) AS c FROM permission_overrides WHERE user_id = ?').get('secg_victim') as { c: number };
    expect(stored.c).toBe(0);
  });

  it('still allows an in-branch role assignment', async () => {
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: gm.id, scopeType: 'branch', scopeId: BRANCH_A });

    expect(res.status).toBe(201);
    db.prepare('DELETE FROM user_roles WHERE id = ?').run(res.body.id);
  });

  it('still allows an in-branch permission override', async () => {
    const perm = permByCode('Payment.View')!;
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/overrides')
      .set(authHeader(manager))
      .send({ permissionId: perm.id, effect: 'grant', scopeType: 'branch', scopeId: BRANCH_A, reason: 'ok' });

    expect(res.status).toBe(201);
    db.prepare('DELETE FROM permission_overrides WHERE id = ?').run(res.body.id);
  });

  it('an owner may still grant organization scope', async () => {
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(owner))
      .send({ roleId: gm.id, scopeType: 'organization', scopeId: null });

    expect(res.status).toBe(201);
    db.prepare('DELETE FROM user_roles WHERE id = ?').run(res.body.id);
  });

  it('refuses a grant SCOPED to a branch the granter cannot reach', async () => {
    // The target user is in the granter's own branch (so the target check
    // passes), but the scope points at a foreign branch. Without the reach
    // check this stored scope_id=BRANCH_B, handing an in-branch user standing
    // permissions in another branch.
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/roles')
      .set(authHeader(manager))
      .send({ roleId: gm.id, scopeType: 'branch', scopeId: BRANCH_B });

    expect(res.status).toBe(403);
    const leaked = db
      .prepare('SELECT COUNT(*) AS c FROM user_roles WHERE user_id = ? AND scope_id = ?')
      .get('secg_victim', BRANCH_B) as { c: number };
    expect(leaked.c).toBe(0);
  });

  it('refuses an override SCOPED to a branch the granter cannot reach', async () => {
    const perm = permByCode('Payment.View')!;
    const res = await supertest(app)
      .post('/api/security/users/secg_victim/overrides')
      .set(authHeader(manager))
      .send({ permissionId: perm.id, effect: 'grant', scopeType: 'branch', scopeId: BRANCH_B, reason: 'x' });

    expect(res.status).toBe(403);
    const leaked = db
      .prepare('SELECT COUNT(*) AS c FROM permission_overrides WHERE user_id = ? AND scope_id = ?')
      .get('secg_victim', BRANCH_B) as { c: number };
    expect(leaked.c).toBe(0);
  });

  it('keeps rejecting a cross-branch target user', async () => {
    const gm = roleByCode('general_manager');
    const res = await supertest(app)
      .post('/api/security/users/secg_victim_b/roles')
      .set(authHeader(manager))
      .send({ roleId: gm.id, scopeType: 'branch', scopeId: BRANCH_B });

    expect(res.status).toBe(403);
  });
});

describe('SEC-3 · system identity roles are not rewritable', () => {
  it('refuses to replace the owner role permission set', async () => {
    const ownerRole = roleByCode('owner');
    const before = (db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(ownerRole.id) as { c: number }).c;
    expect(before).toBeGreaterThan(3);

    const perms = db.prepare('SELECT id FROM permissions LIMIT 3').all() as { id: string }[];
    const res = await supertest(app)
      .put(`/api/security/roles/${ownerRole.id}/permissions`)
      .set(authHeader(manager))
      .send({ permissions: perms.map((p) => ({ permissionId: p.id, scope: 'organization' })) });

    expect(res.status).toBe(403);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(ownerRole.id) as { c: number }).c;
    expect(after).toBe(before);
  });

  it('refuses to rewrite another system role such as finance_manager', async () => {
    const role = roleByCode('finance_manager');
    const before = (db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(role.id) as { c: number }).c;

    const res = await supertest(app)
      .put(`/api/security/roles/${role.id}/permissions`)
      .set(authHeader(manager))
      .send({ permissions: [] });

    expect(res.status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(role.id) as { c: number }).c).toBe(before);
  });

  it('an owner may still edit a system role permission set', async () => {
    const role = roleByCode('finance_manager');
    const before = db.prepare('SELECT permission_id AS pid, default_scope AS scope FROM role_permissions WHERE role_id = ?').all(role.id) as {
      pid: string;
      scope: string;
    }[];

    const res = await supertest(app)
      .put(`/api/security/roles/${role.id}/permissions`)
      .set(authHeader(owner))
      .send({ permissions: before.map((p) => ({ permissionId: p.pid, scope: p.scope })) });

    expect(res.status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(role.id) as { c: number }).c).toBe(before.length);
  });

  it('a custom (non-system) position remains editable by a delegated manager', async () => {
    const created = await supertest(app)
      .post('/api/security/roles')
      .set(authHeader(manager))
      .send({ name: `Desk Helper ${Date.now()}`, description: 'custom', permissions: [] });
    expect(created.status).toBe(201);

    const perm = permByCode('Payment.View')!;
    const res = await supertest(app)
      .put(`/api/security/roles/${created.body.id}/permissions`)
      .set(authHeader(manager))
      .send({ permissions: [{ permissionId: perm.id, scope: 'branch' }] });

    expect(res.status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(created.body.id) as { c: number }).c).toBe(1);
  });

  it('a delegated manager cannot mint a custom position carrying organization scope', async () => {
    const perm = permByCode('Payment.View')!;
    const res = await supertest(app)
      .post('/api/security/roles')
      .set(authHeader(manager))
      .send({ name: `Org Wide ${Date.now()}`, permissions: [{ permissionId: perm.id, scope: 'organization' }] });

    expect(res.status).toBe(403);
  });
});
