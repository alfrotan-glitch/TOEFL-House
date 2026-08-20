/**
 * A-9 — notifications obey the canonical authorities.
 * ============================================================================
 * Notifications carry money. Twenty-one of the thirty-eight writers put an AFN
 * figure in the message: "250,000 AFN deducted from the main account",
 * "'Generator fuel' (95,000 AFN) exceeds the auto-approve threshold". So who
 * may read one, and who may act on one, is a Finance and RBAC question, not a
 * cosmetic one.
 *
 * Three defects were found by audit and are pinned here.
 *
 *   SCOPE CAME FROM IDENTITY, NOT AUTHORIZATION
 *     The read filtered on `req.user.branchId` — the operator's HOME branch.
 *     C-8 already established that `users.branch_id` is an identity attribute
 *     that authorizes nothing; `resolveBranchScope` is the authority, and 74
 *     other route reads use it. An organization-scoped owner could not reach
 *     another branch's notifications at all, including an expense awaiting
 *     their own approval.
 *
 *   A MUTATION WITH NO BRANCH CHECK
 *     `PATCH /:id/read` looked a notification up by id and marked it read. Its
 *     only guard was `existing.user_id && existing.user_id !== userId`, and
 *     `user_id` is never written by anything — so the guard could not fire and
 *     any authenticated principal could mark ANY branch's notification read.
 *     Because the row is shared, that hides it from the branch it belonged to.
 *
 *   MUTATORS WERE LESS GUARDED THAN THE READ
 *     `GET /` requires at least one permission (`denyPermissionless`). The two
 *     mutators required none, so a principal who cannot read a notification
 *     could still mark it read.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT DECIDE
 *
 * Whether read state is per-user or shared per branch is UNDECIDED and the
 * repository is CONFLICTED on it: the per-id path implements shared state,
 * while the read-all comment states the opposite intent. `POST /read-all`
 * therefore keeps its current semantics and is only made to REPORT what it
 * did, so the defect is visible instead of being a silent success. The tests
 * below assert that truthful reporting — they do not assert a policy.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { notificationsRouter } from '../routes/audit.routes.js';
import { addNotification } from '../utils/notifications.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const BR_A = 'notif_a';
const BR_B = 'notif_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, branchId: string): TokenPayload => ({
  userId,
  username: userId,
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

/** Organization-scoped. Home branch A. */
const OWNER = tok('notif_owner', BR_A);
/** Branch-scoped to A only. */
const RECEP_A = tok('notif_recep_a', BR_A);
/** Branch-scoped to B only. */
const RECEP_B = tok('notif_recep_b', BR_B);
/** Holds a role that carries NO permissions at all. */
const STUDENT = tok('notif_student', BR_A);

let app: ReturnType<typeof createApp>;

const listFor = (u: TokenPayload, query = '') =>
  supertest(app).get(`/api/notifications${query}`).set(auth(u));

const idsIn = (body: unknown) => (body as { id: string }[]).map((n) => n.id).sort();

const readFlag = (nid: string) =>
  (db.prepare('SELECT read FROM notifications WHERE id = ?').get(nid) as { read: number }).read;

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare(
    'INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)',
  ).run('notif_campus', FIXED_ORG_ID, 'Notif Campus', 'NOTC');
  for (const b of [BR_A, BR_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)').run(
      b, b, 'Kabul', 'notif_campus',
    );
  }
  for (const u of [OWNER, RECEP_A, RECEP_B, STUDENT]) {
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.branchId, await hashPassword('x'.repeat(12)));
  }
  assignRole(OWNER.userId, 'owner', null);
  assignRole(RECEP_A.userId, 'receptionist', BR_A);
  assignRole(RECEP_B.userId, 'receptionist', BR_B);
  assignRole(STUDENT.userId, 'student', BR_A);

  app = createApp();
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
});

describe('the fixture is genuinely cross-branch', () => {
  /**
   * Guards the suite itself. If the roles below ever stopped differing in
   * reach, every authorization test would pass without proving anything.
   */
  it('the receptionists really are confined to different branches', async () => {
    addNotification('A money event', '10,000 AFN moved', 'info', BR_A);
    addNotification('B money event', '20,000 AFN moved', 'info', BR_B);

    const a = await listFor(RECEP_A);
    const b = await listFor(RECEP_B);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(idsIn(a.body)).not.toEqual(idsIn(b.body));
    expect(a.body).toHaveLength(1);
    expect(b.body).toHaveLength(1);
  });

  it('the student role carries no permissions, which is what denyPermissionless tests', () => {
    const codes = db
      .prepare(
        `SELECT COUNT(*) c FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = ?`,
      )
      .get(STUDENT.userId) as { c: number };
    expect(codes.c).toBe(0);
  });
});

describe('reads resolve scope through the canonical authority', () => {
  it('an authorized owner can reach another branch by asking for it', async () => {
    addNotification('B expense awaiting approval', '95,000 AFN', 'warning', BR_B);

    const res = await listFor(OWNER, `?branchId=${BR_B}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('B expense awaiting approval');
  });

  it('an owner asking for all branches receives all of them', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B event', '2 AFN', 'info', BR_B);

    const res = await listFor(OWNER, '?branchId=all');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('a branch-scoped operator asking for another branch is NOT given it', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B secret', '999,999 AFN', 'critical', BR_B);

    const res = await listFor(RECEP_A, `?branchId=${BR_B}`);
    expect(res.status).toBe(200);
    // Falls back to the caller's own branch rather than honouring the request.
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(['A event']);
  });

  it('a branch-scoped operator asking for ALL branches is NOT given them', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B secret', '999,999 AFN', 'critical', BR_B);

    const res = await listFor(RECEP_A, '?branchId=all');
    expect(res.status).toBe(200);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(['A event']);
  });

  it('the default with no query is unchanged — the caller\'s own branch', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B event', '2 AFN', 'info', BR_B);

    const res = await listFor(RECEP_A);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(['A event']);
  });

  it('a principal with no permissions cannot read notifications', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    const res = await listFor(STUDENT);
    expect(res.status).toBe(403);
  });
});

describe('marking one notification read is authorized by branch', () => {
  it('an operator cannot mark another branch\'s notification read', async () => {
    const nid = addNotification('B expense awaiting approval', '95,000 AFN', 'warning', BR_B);

    const res = await supertest(app)
      .patch(`/api/notifications/${nid}/read`)
      .set(auth(RECEP_A));

    expect(res.status).toBe(403);
    // The semantic check: the row must be untouched, not merely an error code.
    expect(readFlag(nid)).toBe(0);
  });

  it('an operator can mark their own branch\'s notification read', async () => {
    const nid = addNotification('A event', '1 AFN', 'info', BR_A);
    const res = await supertest(app).patch(`/api/notifications/${nid}/read`).set(auth(RECEP_A));
    expect(res.status).toBe(200);
    expect(readFlag(nid)).toBe(1);
  });

  it('an organization-scoped owner may mark any branch\'s notification read', async () => {
    const nid = addNotification('B event', '2 AFN', 'info', BR_B);
    const res = await supertest(app).patch(`/api/notifications/${nid}/read`).set(auth(OWNER));
    expect(res.status).toBe(200);
    expect(readFlag(nid)).toBe(1);
  });

  it('a principal with no permissions cannot mark anything read', async () => {
    const nid = addNotification('A event', '1 AFN', 'info', BR_A);
    const res = await supertest(app).patch(`/api/notifications/${nid}/read`).set(auth(STUDENT));
    expect(res.status).toBe(403);
    expect(readFlag(nid)).toBe(0);
  });

  it('an unknown notification is still a 404', async () => {
    const res = await supertest(app).patch('/api/notifications/nope/read').set(auth(OWNER));
    expect(res.status).toBe(404);
  });
});

describe('read-all reports what it actually did', () => {
  /**
   * NOT a policy assertion. Whether read-all should clear shared rows is
   * undecided (A-9.1), so its behaviour is unchanged here. What is asserted is
   * that it stops claiming success while changing nothing: the response states
   * the number of rows it marked, so the gap is visible to a caller and to
   * this suite rather than hidden behind `{ ok: true }`.
   */
  it('states the number of notifications it marked', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    const res = await supertest(app).post('/api/notifications/read-all').set(auth(RECEP_A));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('marked');
    expect(typeof res.body.marked).toBe('number');
  });

  it('a principal with no permissions cannot call it', async () => {
    const res = await supertest(app).post('/api/notifications/read-all').set(auth(STUDENT));
    expect(res.status).toBe(403);
  });
});

describe('no second scoping authority is introduced', () => {
  const routerSource = () =>
    fs.readFileSync(path.join(repoRoot, 'server', 'src', 'routes', 'audit.routes.ts'), 'utf8');

  it('the notifications router does not scope on the home-branch identity attribute', () => {
    const src = routerSource();
    const notifSection = src.slice(src.indexOf('export const notificationsRouter'));
    // `req.user.branchId` is identity, not authorization (C-8). Reading it here
    // is what produced the defect this suite pins.
    expect(notifSection).not.toMatch(/req\.user\?\.branchId/);
  });

  it('it consumes the canonical scope and branch-authorization helpers', () => {
    const notifSection = routerSource().slice(
      routerSource().indexOf('export const notificationsRouter'),
    );
    expect(notifSection).toContain('resolveBranchScope');
    expect(notifSection).toContain('canAccessBranchResource');
  });

  it('every notifications handler is permission-gated like the read', () => {
    const notifSection = routerSource().slice(
      routerSource().indexOf('export const notificationsRouter'),
    );
    const handlers = notifSection.match(/notificationsRouter\.(get|post|patch|delete)\(/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    expect((notifSection.match(/denyPermissionless/g) ?? []).length).toBe(handlers.length);
  });
});
