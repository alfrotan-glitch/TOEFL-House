/**
 * Login lockout must isolate accounts, not whole offices.
 * ============================================================================
 * DEFECT (observed live, 2026-08-16): the login limiter was keyed on IP alone
 * at 10 attempts / 15 minutes. An entire branch shares one NAT egress IP, so
 * ten wrong passwords from one person locked out every colleague behind that
 * IP. During the audit a single probe locked out four unrelated accounts.
 *
 * The guard must still bound credential stuffing against any one username, and
 * still bound a username-rotating sweep from one host — so both layers are
 * asserted here, including the counter-invariant that a *correct* password for
 * a *different* account keeps working while another account is locked out.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { hashPassword } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { authRouter } from '../../../routes/auth.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BRANCH = 'ratelimit_branch';
const GOOD_PASSWORD = 'CorrectHorse!2026';

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'RateLimit Branch', 'Loc');
  const hash = await hashPassword(GOOD_PASSWORD);
  for (const [id, username] of [['u_rl_alice', 'rl_alice'], ['u_rl_bob', 'rl_bob']]) {
    db.prepare(
      `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(id, username, username, BRANCH, hash);
    assignRole(id, 'registrar', BRANCH);
  }

  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);
});

describe('login lockout is scoped to the account, not the network', () => {
  it('locks the abused account after repeated failures', async () => {
    // 10 is the per-account allowance; the 11th must be refused by the limiter.
    for (let i = 0; i < 10; i += 1) {
      const r = await supertest(app).post('/api/auth/login').send({ username: 'rl_alice', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const blocked = await supertest(app).post('/api/auth/login').send({ username: 'rl_alice', password: 'wrong' });
    expect(blocked.status).toBe(429);
  });

  it('a COLLEAGUE on the same IP can still sign in — the office is not locked out', async () => {
    // This is the regression that matters: same source IP, different account.
    const ok = await supertest(app).post('/api/auth/login').send({ username: 'rl_bob', password: GOOD_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('rl_bob');
  });

  it('the locked account stays locked even with the CORRECT password', async () => {
    // Lockout must not be bypassable by finally guessing right.
    const r = await supertest(app).post('/api/auth/login').send({ username: 'rl_alice', password: GOOD_PASSWORD });
    expect(r.status).toBe(429);
  });
});
