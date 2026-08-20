/**
 * Notifications carry operational and financial facts, so visibility and read
 * state are both authorization concerns. This suite proves the owner-approved
 * policy: the event is branch-visible, each viewer owns an independent read
 * receipt, and organization-wide principals aggregate their authorized
 * branches by default.
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

/** Organization-scoped, with branch A as the identity/home attribute. */
const OWNER = tok('notif_owner', BR_A);
/** Two independent viewers with access to branch A. */
const RECEP_A = tok('notif_recep_a', BR_A);
const RECEP_A_2 = tok('notif_recep_a_2', BR_A);
/** Branch-scoped to B only. */
const RECEP_B = tok('notif_recep_b', BR_B);
/** Holds a role that carries no permissions. */
const STUDENT = tok('notif_student', BR_A);

let app: ReturnType<typeof createApp>;

const listFor = (u: TokenPayload, query = '') =>
  supertest(app).get(`/api/notifications${query}`).set(auth(u));

const idsIn = (body: unknown) => (body as { id: string }[]).map((n) => n.id).sort();

const receiptCount = (notificationId: string, userId: string) =>
  (db.prepare(
    `SELECT COUNT(*) AS c
       FROM notification_read_receipts
      WHERE notification_id = ? AND user_id = ?`,
  ).get(notificationId, userId) as { c: number }).c;

async function readState(user: TokenPayload, notificationId: string, query = ''): Promise<number> {
  const res = await listFor(user, query);
  expect(res.status).toBe(200);
  const row = (res.body as { id: string; read: number }[]).find((item) => item.id === notificationId);
  expect(row).toBeDefined();
  return row!.read;
}

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
  for (const u of [OWNER, RECEP_A, RECEP_A_2, RECEP_B, STUDENT]) {
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.branchId, await hashPassword('x'.repeat(12)));
  }
  assignRole(OWNER.userId, 'owner', null);
  assignRole(RECEP_A.userId, 'receptionist', BR_A);
  assignRole(RECEP_A_2.userId, 'receptionist', BR_A);
  assignRole(RECEP_B.userId, 'receptionist', BR_B);
  assignRole(STUDENT.userId, 'student', BR_A);

  app = createApp();
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
});

describe('the fixture is genuinely cross-branch', () => {
  it('the receptionists are confined to their assigned branches', async () => {
    const aId = addNotification('A money event', '10,000 AFN moved', 'info', BR_A);
    const bId = addNotification('B money event', '20,000 AFN moved', 'info', BR_B);

    expect(idsIn((await listFor(RECEP_A)).body)).toEqual([aId]);
    expect(idsIn((await listFor(RECEP_B)).body)).toEqual([bId]);
  });

  it('the student role carries no permission, which is what denyPermissionless tests', () => {
    const codes = db.prepare(
      `SELECT COUNT(*) c FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = ?`,
    ).get(STUDENT.userId) as { c: number };
    expect(codes.c).toBe(0);
  });
});

describe('reads resolve scope through the canonical authority', () => {
  it('an organization-scoped owner aggregates all branches by default', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    const bId = addNotification('B expense awaiting approval', '95,000 AFN', 'warning', BR_B);

    const res = await listFor(OWNER);
    expect(res.status).toBe(200);
    expect(idsIn(res.body)).toEqual([aId, bId].sort());
  });

  it('an owner may still request one branch explicitly', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    const bId = addNotification('B event', '2 AFN', 'info', BR_B);

    const res = await listFor(OWNER, `?branchId=${BR_B}`);
    expect(res.status).toBe(200);
    expect(idsIn(res.body)).toEqual([bId]);
  });

  it('a branch-scoped operator asking for another branch receives only their authorized home scope', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B secret', '999,999 AFN', 'critical', BR_B);

    const res = await listFor(RECEP_A, `?branchId=${BR_B}`);
    expect(res.status).toBe(200);
    expect(idsIn(res.body)).toEqual([aId]);
  });

  it('a branch-scoped operator asking for all branches receives only their authorized home scope', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B secret', '999,999 AFN', 'critical', BR_B);

    const res = await listFor(RECEP_A, '?branchId=all');
    expect(res.status).toBe(200);
    expect(idsIn(res.body)).toEqual([aId]);
  });

  it('a branch-scoped operator defaults to their authorized branch', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    addNotification('B event', '2 AFN', 'info', BR_B);

    expect(idsIn((await listFor(RECEP_A)).body)).toEqual([aId]);
  });

  it('global notifications are visible in every authorized scope', async () => {
    const globalId = addNotification('System maintenance', 'Tonight', 'info');
    expect(idsIn((await listFor(RECEP_A)).body)).toEqual([globalId]);
    expect(idsIn((await listFor(RECEP_B)).body)).toEqual([globalId]);
  });

  it('a principal with no permissions cannot read notifications', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    expect((await listFor(STUDENT)).status).toBe(403);
  });
});

describe('one viewer cannot change another viewer\'s read state', () => {
  it('marking one notification creates only the caller\'s receipt', async () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);

    const res = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(RECEP_A));

    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(receiptCount(notificationId, RECEP_A.userId)).toBe(1);
    expect(receiptCount(notificationId, RECEP_A_2.userId)).toBe(0);
    expect(await readState(RECEP_A, notificationId)).toBe(1);
    expect(await readState(RECEP_A_2, notificationId)).toBe(0);
  });

  it('an organization-scoped owner may read another branch event without clearing it for that branch', async () => {
    const notificationId = addNotification('B event', '2 AFN', 'info', BR_B);
    const res = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(OWNER));

    expect(res.status).toBe(200);
    expect(receiptCount(notificationId, OWNER.userId)).toBe(1);
    expect(receiptCount(notificationId, RECEP_B.userId)).toBe(0);
    expect(await readState(OWNER, notificationId)).toBe(1);
    expect(await readState(RECEP_B, notificationId)).toBe(0);
  });

  it('marking the same notification twice is idempotent', async () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    const first = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(RECEP_A));
    const replay = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(RECEP_A));

    expect(first.body.marked).toBe(1);
    expect(replay.body.marked).toBe(0);
    expect(receiptCount(notificationId, RECEP_A.userId)).toBe(1);
  });

  it('two concurrent marks converge on one receipt', async () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    const [left, right] = await Promise.all([
      supertest(app).patch(`/api/notifications/${notificationId}/read`).set(auth(RECEP_A)),
      supertest(app).patch(`/api/notifications/${notificationId}/read`).set(auth(RECEP_A)),
    ]);

    expect([left.status, right.status]).toEqual([200, 200]);
    expect(left.body.marked + right.body.marked).toBe(1);
    expect(receiptCount(notificationId, RECEP_A.userId)).toBe(1);
  });

  it('an operator cannot mark another branch\'s notification read', async () => {
    const notificationId = addNotification('B expense awaiting approval', '95,000 AFN', 'warning', BR_B);
    const res = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(RECEP_A));

    expect(res.status).toBe(403);
    expect(receiptCount(notificationId, RECEP_A.userId)).toBe(0);
  });

  it('a principal with no permissions cannot mark anything read', async () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    const res = await supertest(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set(auth(STUDENT));
    expect(res.status).toBe(403);
    expect(receiptCount(notificationId, STUDENT.userId)).toBe(0);
  });

  it('an unknown notification is a 404 and creates no receipt', async () => {
    const res = await supertest(app)
      .patch('/api/notifications/nope/read')
      .set(auth(OWNER));
    expect(res.status).toBe(404);
    expect(receiptCount('nope', OWNER.userId)).toBe(0);
  });
});

describe('mark all read is scoped, per-user, and idempotent', () => {
  it('marks the caller\'s branch and global events, but no foreign branch', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    const bId = addNotification('B event', '2 AFN', 'info', BR_B);
    const globalId = addNotification('Global event', 'Notice', 'info');

    const res = await supertest(app).post('/api/notifications/read-all').set(auth(RECEP_A));
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2);
    expect(receiptCount(aId, RECEP_A.userId)).toBe(1);
    expect(receiptCount(globalId, RECEP_A.userId)).toBe(1);
    expect(receiptCount(bId, RECEP_A.userId)).toBe(0);
  });

  it('does not mark the same rows for a second viewer', async () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    await supertest(app).post('/api/notifications/read-all').set(auth(RECEP_A));

    expect(await readState(RECEP_A, notificationId)).toBe(1);
    expect(await readState(RECEP_A_2, notificationId)).toBe(0);
  });

  it('cannot be widened to another branch through a query parameter', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    const bId = addNotification('B event', '2 AFN', 'info', BR_B);

    const res = await supertest(app)
      .post(`/api/notifications/read-all?branchId=${BR_B}`)
      .set(auth(RECEP_A));

    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(receiptCount(aId, RECEP_A.userId)).toBe(1);
    expect(receiptCount(bId, RECEP_A.userId)).toBe(0);
  });

  it('an organization-scoped owner marks every branch by default', async () => {
    const aId = addNotification('A event', '1 AFN', 'info', BR_A);
    const bId = addNotification('B event', '2 AFN', 'info', BR_B);

    const res = await supertest(app).post('/api/notifications/read-all').set(auth(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2);
    expect(receiptCount(aId, OWNER.userId)).toBe(1);
    expect(receiptCount(bId, OWNER.userId)).toBe(1);
    expect(receiptCount(aId, RECEP_A.userId)).toBe(0);
    expect(receiptCount(bId, RECEP_B.userId)).toBe(0);
  });

  it('a replay reports zero new receipts', async () => {
    addNotification('A event', '1 AFN', 'info', BR_A);
    const first = await supertest(app).post('/api/notifications/read-all').set(auth(RECEP_A));
    const replay = await supertest(app).post('/api/notifications/read-all').set(auth(RECEP_A));
    expect(first.body.marked).toBe(1);
    expect(replay.body.marked).toBe(0);
  });

  it('a principal with no permissions cannot call it', async () => {
    const res = await supertest(app).post('/api/notifications/read-all').set(auth(STUDENT));
    expect(res.status).toBe(403);
  });
});

describe('the database enforces the canonical read-state model', () => {
  it('stores no shared read flag or unused target user on the event row', () => {
    const columns = (db.pragma('table_info(notifications)') as { name: string }[]).map((column) => column.name);
    expect(columns).not.toContain('read');
    expect(columns).not.toContain('user_id');
  });

  it('permits at most one receipt per notification and user', () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    db.prepare(
      'INSERT INTO notification_read_receipts (notification_id, user_id) VALUES (?, ?)',
    ).run(notificationId, RECEP_A.userId);
    expect(() => db.prepare(
      'INSERT INTO notification_read_receipts (notification_id, user_id) VALUES (?, ?)',
    ).run(notificationId, RECEP_A.userId)).toThrow(/UNIQUE constraint/i);
  });

  it('deleting an event cascades its receipts', () => {
    const notificationId = addNotification('A event', '1 AFN', 'info', BR_A);
    db.prepare(
      'INSERT INTO notification_read_receipts (notification_id, user_id) VALUES (?, ?)',
    ).run(notificationId, RECEP_A.userId);
    db.prepare('DELETE FROM notifications WHERE id = ?').run(notificationId);
    expect(receiptCount(notificationId, RECEP_A.userId)).toBe(0);
  });
});

describe('no second authorization authority is introduced', () => {
  const routerSource = () =>
    fs.readFileSync(path.join(repoRoot, 'server', 'src', 'routes', 'audit.routes.ts'), 'utf8');

  it('the notifications router does not scope on the home-branch identity attribute', () => {
    const notifSection = routerSource().slice(
      routerSource().indexOf('export const notificationsRouter'),
    );
    expect(notifSection).not.toMatch(/req\.user\?\.branchId/);
  });

  it('consumes the canonical scope and branch-authorization helpers', () => {
    const notifSection = routerSource().slice(
      routerSource().indexOf('export const notificationsRouter'),
    );
    expect(notifSection).toContain('resolveBranchScope');
    expect(notifSection).toContain('canAccessBranchResource');
  });

  it('every notifications handler is permission-gated', () => {
    const notifSection = routerSource().slice(
      routerSource().indexOf('export const notificationsRouter'),
    );
    const handlers = notifSection.match(/notificationsRouter\.(get|post|patch|delete)\(/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    expect((notifSection.match(/denyPermissionless/g) ?? []).length).toBe(handlers.length);
  });
});
