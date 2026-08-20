/**
 * Teacher evaluation integrity — regression suite
 * ============================================================================
 * Locks in the "no fabricated default evaluation" invariant:
 *
 * 1. A newly created teacher has performance_score 0 ("not yet evaluated"),
 *    NOT a fabricated 50/100.
 * 2. Submitting an evaluation records the score and updates the teacher.
 * 3. A zero/negative/out-of-range evaluation is rejected (an accidental 0
 *    must never be stored as a real evaluation).
 * 4. The evaluation history is traceable (score + date + notes).
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'eval_regression_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH, fullName: 'Eval Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let manager: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Eval Branch', 'Loc');
  await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run('u_eval_mgr', 'eval_mgr', 'Eval Mgr', BRANCH, await hashPassword('x'));
  assignRole('u_eval_mgr', 'manager', BRANCH);

  manager = makeUser({ userId: 'u_eval_mgr', branchId: BRANCH });
  app = createApp();
});

describe('Teacher evaluation integrity', () => {
  it('new teacher starts with performance_score 0 (not a fabricated 50)', async () => {
    const res = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Fresh Teacher', phone: '0700000999', baseSalary: 12000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    expect(res.status).toBe(201);
    expect(res.body.performanceScore).toBe(0);
    const row = db.prepare('SELECT performance_score FROM teachers WHERE id = ?').get(res.body.id) as any;
    expect(Number(row.performance_score)).toBe(0);
  });

  it('submitting an evaluation records it and updates the teacher score', async () => {
    const created = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Scored Teacher', phone: '0700000888', baseSalary: 12000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    const evalRes = await supertest(app).post(`/api/teachers/${created.body.id}/evaluation`).set(authHeader(manager)).send({
      score: 85, notes: 'Strong classroom management', criteria: { teaching: 40, management: 30, communication: 15 },
    });
    expect(evalRes.status).toBe(201);
    const row = db.prepare('SELECT performance_score FROM teachers WHERE id = ?').get(created.body.id) as any;
    expect(Number(row.performance_score)).toBe(85);
    const history = db.prepare('SELECT score, notes FROM teacher_evaluations WHERE teacher_id = ?').all(created.body.id) as any[];
    expect(history).toHaveLength(1);
    expect(Number(history[0].score)).toBe(85);
    expect(history[0].notes).toContain('classroom');
  });

  it('rejects zero / negative / out-of-range evaluations', async () => {
    const created = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Guard Teacher', phone: '0700000777', baseSalary: 12000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    for (const score of [0, -5, 101]) {
      const res = await supertest(app).post(`/api/teachers/${created.body.id}/evaluation`).set(authHeader(manager)).send({ score, notes: 'x' });
      expect(res.status).toBe(400);
    }
    const row = db.prepare('SELECT performance_score FROM teachers WHERE id = ?').get(created.body.id) as any;
    expect(Number(row.performance_score)).toBe(0);
  });

  it('rejects non-object criteria', async () => {
    const created = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Criteria Teacher', phone: '0700000666', baseSalary: 12000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    const res = await supertest(app).post(`/api/teachers/${created.body.id}/evaluation`).set(authHeader(manager)).send({ score: 70, criteria: 'not-an-object' });
    expect(res.status).toBe(400);
  });
});
