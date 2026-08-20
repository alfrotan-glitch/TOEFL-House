/**
 * ONE definition of a student's tuition balance — proven, not asserted.
 * ============================================================================
 * DEFECT THIS LOCKS DOWN (proven by live probe, 2026-08-16):
 *
 *   The same student showed a tuition debt 20,000 AFN apart depending on the
 *   screen. `GET /payments/balances` (the roster) summed only semesters with
 *   status='active'; the profile drawer and the student portal each recomputed
 *   the figure in the browser over ALL semesters from the paginated payments
 *   array. Completing a semester — an ordinary lifecycle event — made them
 *   disagree. Three independent implementations, three answers.
 *
 * The rule now lives once, in utils/studentBalance.ts. Every surface reads it:
 *
 *   getStudentBalance(scope)      single student
 *   getStudentBalancesPage(scope) roster page
 *   GET /students/:id  -> balance.lifetime / balance.current
 *   GET /students/me   -> same shape, for the portal
 *   GET /payments/balances -> getStudentBalancesPage
 *
 * These tests assert the implementations agree under the states that broke
 * them, and that the HTTP surfaces actually carry the figures so no client has
 * a reason to recompute.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter, paymentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getStudentBalance, getStudentBalancesPage, deriveBalance } from '../utils/studentBalance.js';

const BRANCH = 'sot_branch';
const CLASS_ID = 'sot_class';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use(errorHandler);
  return app;
}
const user = (): TokenPayload => ({
  userId: 'u_sot', username: 'sot', branchId: BRANCH, fullName: 'SoT Mgr',
});
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

let app: express.Express;
let seq = 0;

async function newStudent(name: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: name, phone: `0777${String(100000 + seq).slice(-6)}`, gender: 'male', branchId: BRANCH,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}
async function enrol(sid: string, name: string, tuition: number): Promise<string> {
  const res = await supertest(app).post(`/api/students/${sid}/enroll-semester`).set(auth())
    .send({ semesterName: name, classId: CLASS_ID, tuitionAmount: tuition, amountPaidNow: 0 });
  expect(res.status).toBe(201);
  return res.body.semesterId as string;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'SoT Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run('u_sot', 'sot', 'SoT Mgr', BRANCH, await hashPassword('x'));
  assignRole('u_sot', 'manager', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,lifecycle_stage,schedule_time,fee)
     VALUES (?,?,'A1',?,'active','in_progress','08:00',1000)`,
  ).run(CLASS_ID, 'SoT Class', BRANCH);

  app = createApp();
});

describe('the roster page and the single-student read never disagree', () => {
  it('agree after a semester is COMPLETED — the exact state that broke them', async () => {
    const sid = await newStudent('Completed Semester');
    const first = await enrol(sid, 'Term One', 20_000);
    await enrol(sid, 'Term Two', 30_000);
    // The lifecycle event that used to split the two implementations.
    db.prepare(`UPDATE student_semesters SET status = 'completed' WHERE id = ?`).run(first);

    const single = getStudentBalance(db, sid, 'all');
    const page = getStudentBalancesPage(db, { branchId: BRANCH, scope: 'all', limit: 500, offset: 0 })
      .find((r) => r.studentId === sid);

    expect(page).toBeDefined();
    expect(page).toMatchObject({
      tuitionDue: single.tuitionDue,
      tuitionPaid: single.tuitionPaid,
      outstanding: single.outstanding,
      creditBalance: single.creditBalance,
    });
    // Lifetime scope must count BOTH semesters.
    expect(single.tuitionDue).toBe(50_000);
  });

  it("'active' scope excludes completed semesters in BOTH implementations", async () => {
    const sid = await newStudent('Active Scope');
    const done = await enrol(sid, 'Old Term', 15_000);
    await enrol(sid, 'Live Term', 25_000);
    db.prepare(`UPDATE student_semesters SET status = 'completed' WHERE id = ?`).run(done);

    const single = getStudentBalance(db, sid, 'active');
    const page = getStudentBalancesPage(db, { branchId: BRANCH, scope: 'active', limit: 500, offset: 0 })
      .find((r) => r.studentId === sid);

    expect(single.tuitionDue).toBe(25_000);
    expect(page?.tuitionDue).toBe(25_000);
  });

  it('agree once refunds are involved (refunds are signed-negative, never dropped)', async () => {
    const sid = await newStudent('Refunded Student');
    const semesterId = await enrol(sid, 'Refund Term', 10_000);
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .set('Idempotency-Key', 'sot-pay').send({ amount: 4000, category: 'fee', semesterId, paymentMethod: 'cash' });
    await supertest(app).post(`/api/students/${sid}/refund`).set(auth())
      .set('Idempotency-Key', 'sot-refund').send({ amount: 1500, reason: 'withdrew from module' });

    const single = getStudentBalance(db, sid, 'all');
    const page = getStudentBalancesPage(db, { branchId: BRANCH, scope: 'all', limit: 500, offset: 0 })
      .find((r) => r.studentId === sid);

    expect(single.tuitionPaid).toBe(2500); // 4000 - 1500
    expect(page?.tuitionPaid).toBe(2500);
    expect(page?.outstanding).toBe(single.outstanding);
  });
});

describe('the HTTP surfaces carry the authoritative figures', () => {
  it('GET /students/:id returns both lifetime and current balances', async () => {
    const sid = await newStudent('Http Balance');
    await enrol(sid, 'Http Term', 8_000);

    const res = await supertest(app).get(`/api/students/${sid}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.balance).toBeDefined();
    for (const scope of ['lifetime', 'current'] as const) {
      for (const k of ['tuitionDue', 'tuitionPaid', 'outstanding', 'creditBalance', 'paidPercentage']) {
        expect(res.body.balance[scope]).toHaveProperty(k);
      }
    }
    expect(res.body.balance.lifetime).toMatchObject(getStudentBalance(db, sid, 'all'));
    expect(res.body.balance.current).toMatchObject(getStudentBalance(db, sid, 'active'));
  });

  it('GET /payments/balances matches GET /students/:id for every student on the page', async () => {
    const page = await supertest(app).get('/api/payments/balances').set(auth());
    expect(page.status).toBe(200);
    expect(Array.isArray(page.body)).toBe(true);
    expect(page.body.length).toBeGreaterThan(0);

    for (const row of page.body) {
      const one = await supertest(app).get(`/api/students/${row.studentId}`).set(auth());
      if (one.status !== 200) continue; // other branches are correctly invisible
      const lifetime = one.body.balance.lifetime;
      expect({
        tuitionDue: row.tuitionDue, tuitionPaid: row.tuitionPaid,
        outstanding: row.outstanding, creditBalance: row.creditBalance,
      }).toEqual({
        tuitionDue: lifetime.tuitionDue, tuitionPaid: lifetime.tuitionPaid,
        outstanding: lifetime.outstanding, creditBalance: lifetime.creditBalance,
      });
    }
  });
});

describe('balance arithmetic invariants', () => {
  it('outstanding and creditBalance are mutually exclusive and never negative', () => {
    for (const [due, paid] of [[0, 0], [100, 0], [0, 100], [100, 100], [100, 250], [250, 100]]) {
      const b = deriveBalance(due, paid);
      expect(b.outstanding).toBeGreaterThanOrEqual(0);
      expect(b.creditBalance).toBeGreaterThanOrEqual(0);
      expect(Math.min(b.outstanding, b.creditBalance)).toBe(0);
      expect(b.outstanding - b.creditBalance).toBeCloseTo(due - paid, 6);
    }
  });

  it('paidPercentage is clamped to 0..100 and is 100 when nothing was charged', () => {
    expect(deriveBalance(0, 0).paidPercentage).toBe(100);
    expect(deriveBalance(0, 500).paidPercentage).toBe(100);
    expect(deriveBalance(1000, 0).paidPercentage).toBe(0);
    expect(deriveBalance(1000, 5000).paidPercentage).toBe(100);
    expect(deriveBalance(1000, 500).paidPercentage).toBe(50);
  });
});
