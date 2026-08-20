/**
 * Password-change quarantine — server-side enforcement regression test
 * ============================================================================
 * The first-install / forced-reset flag (users.must_change_password) must be
 * enforced by the backend, not just the frontend gate: while set, the full
 * API is unreachable except for the auth endpoints needed to change the
 * password. After a successful change, normal access resumes.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { authRouter } from '../routes/auth.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'quarantine_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Quarantine Branch', 'Loc');
  app = createApp();
});

describe('Password-change quarantine', () => {
  it('blocks the full API while must_change_password is set, allows auth endpoints, and unlocks after change', async () => {
    const userId = 'u_quarantine';
    const passwordHash = await hashPassword('initial-pass-123');
    db.prepare(
      `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, session_version )
       VALUES (?, 'quarantine_user', 'Quarantine User', ?, ?, 1, 1, 1)`
    ).run(userId, BRANCH, passwordHash);
    assignRole(userId, 'manager', BRANCH);

    const token = signToken({ userId, username: 'quarantine_user', branchId: BRANCH, fullName: 'Quarantine User', sessionVersion: 1 });

    // Quarantined: business endpoints are blocked.
    const blocked = await supertest(app).get('/api/students').set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/change your password/i);

    // Auth self-service endpoints remain reachable.
    const me = await supertest(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(true);

    const change = await supertest(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: 'initial-pass-123', newPassword: 'new-strong-password-456',
    });
    expect(change.status).toBe(200);

    // The change bumps session_version and issues a renewed token via cookie;
    // the old token is revoked. Sign a fresh token with the new version.
    const row = db.prepare('SELECT session_version, must_change_password FROM users WHERE id = ?').get(userId) as { session_version: number; must_change_password: number };
    expect(row.must_change_password).toBe(0);
    const freshToken = signToken({ userId, username: 'quarantine_user', branchId: BRANCH, fullName: 'Quarantine User', sessionVersion: row.session_version });

    const unlocked = await supertest(app).get('/api/students').set('Authorization', `Bearer ${freshToken}`);
    expect(unlocked.status).toBe(200);
  });

  it('rejects an incorrect current password during quarantine', async () => {
    const userId = 'u_quarantine_2';
    db.prepare(
      `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, session_version )
       VALUES (?, 'quarantine_user_2', 'Quarantine User 2', ?, ?, 1, 1, 1)`
    ).run(userId, BRANCH, await hashPassword('initial-pass-123'));
    assignRole(userId, 'manager', BRANCH);

    const token = signToken({ userId, username: 'quarantine_user_2', branchId: BRANCH, fullName: 'Quarantine User 2', sessionVersion: 1 });

    const res = await supertest(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: 'wrong-password', newPassword: 'new-strong-password-456',
    });
    expect(res.status).toBe(401);
    const row = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(userId) as { must_change_password: number };
    expect(row.must_change_password).toBe(1); // still quarantined
  });
});
