/**
 * The installment plan is financial data and must be validated as such.
 * ============================================================================
 * F-11 (proven live over HTTP, 2026-08-16 release-candidate pass):
 *
 *   PATCH /api/students/:id accepted ANY value for `installmentPlan` and stored
 *   it with an unconditional JSON.stringify(). Sending an already-serialised
 *   plan — the obvious mistake for any client that keeps it as a string —
 *   double-encoded the column. It then parsed back to a *string*, and the
 *   payment route did `plan.find(...)` on it:
 *
 *     POST /api/students/:id/payments { category: 'installment', ... }
 *       -> 500 "plan.find is not a function"
 *
 *   Two distinct failures:
 *     1. Corrupt financial data was accepted at the write boundary. The plan
 *        drives real charges, so a malformed plan is not a cosmetic problem.
 *     2. A money endpoint crashed with a 500 on data the server itself had
 *        stored, instead of degrading safely.
 *
 * parseJson() guarded against a PARSE failure but not against the parsed value
 * having the wrong SHAPE — a JSON string parses perfectly well.
 *
 * Fix: validate the plan on write (array, unique non-empty ids, positive
 * amounts, known statuses), and read it through parseJsonArray(), which
 * degrades to "no installments" rather than crashing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import studentsRouter from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'inst_branch';
const STUDENT = 'inst_student';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
const auth = () => ({
  Authorization: `Bearer ${signToken({
    userId: 'u_inst', username: 'u_inst', role: 'manager', branchId: BRANCH, fullName: 'Inst Mgr',
  } as TokenPayload)}`,
});

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('u_inst','u_inst','Inst Mgr','manager',?,?,1,0)`,
  ).run(BRANCH, pw);
  syncLegacyUserRoles(db);
  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id, discount_percent)
     VALUES (?, 'INST-1', 'Installment Student', 'male', '0700440001', 'active', ?, ?, 0)`,
  ).run(STUDENT, today(), BRANCH);
  db.prepare(`DELETE FROM payments WHERE student_id = ?`).run(STUDENT);
  app = createApp();
});

const patchPlan = (plan: unknown) =>
  supertest(app).patch(`/api/students/${STUDENT}`).set(auth()).send({ installmentPlan: plan });

describe('F-11: installment plan validation', () => {
  it('rejects a pre-serialised plan instead of double-encoding it', async () => {
    const res = await patchPlan(JSON.stringify([{ id: 'a', amount: 100, status: 'pending' }]));
    expect(res.status).toBe(400);
    // Nothing corrupt may reach the column.
    const stored = (db.prepare('SELECT installment_plan p FROM students WHERE id = ?').get(STUDENT) as { p: string | null }).p;
    expect(stored).toBeNull();
  });

  it('rejects structurally invalid plans', async () => {
    const cases: Array<[string, unknown]> = [
      ['object rather than array', { id: 'a', amount: 100 }],
      ['missing id', [{ amount: 100, status: 'pending' }]],
      ['blank id', [{ id: '   ', amount: 100 }]],
      ['zero amount', [{ id: 'a', amount: 0 }]],
      ['negative amount', [{ id: 'a', amount: -500 }]],
      ['non-numeric amount', [{ id: 'a', amount: 'lots' }]],
      // Duplicate ids make "pay installment X" ambiguous, and settling one
      // would silently mark the other paid.
      ['duplicate ids', [{ id: 'x', amount: 100 }, { id: 'x', amount: 200 }]],
      ['unknown status', [{ id: 'a', amount: 100, status: 'refunded' }]],
    ];
    for (const [label, plan] of cases) {
      const res = await patchPlan(plan);
      expect(res.status, `${label} must be refused`).toBe(400);
    }
  });

  it('accepts a valid plan and charges exactly the installment amount', async () => {
    expect((await patchPlan([{ id: 'i1', amount: 2500, status: 'pending' }, { id: 'i2', amount: 2500, status: 'pending' }])).status).toBe(200);

    const pay = await supertest(app)
      .post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 2500, category: 'installment', installmentId: 'i1', paymentMethod: 'cash' });
    expect(pay.status).toBe(201);

    const rows = db.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM payments WHERE student_id = ? AND category = 'installment'`,
    ).get(STUDENT) as { c: number; t: number };
    expect(rows).toEqual({ c: 1, t: 2500 });

    // Only the paid installment flips.
    const plan = JSON.parse((db.prepare('SELECT installment_plan p FROM students WHERE id = ?').get(STUDENT) as { p: string }).p);
    expect(plan.map((i: { id: string; status: string }) => `${i.id}=${i.status}`)).toEqual(['i1=paid', 'i2=pending']);
  });

  it('an installment cannot be paid twice', async () => {
    await patchPlan([{ id: 'i1', amount: 1000, status: 'pending' }]);
    const body = { amount: 1000, category: 'installment', installmentId: 'i1', paymentMethod: 'cash' };

    const first = await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth()).send(body);
    expect(first.status).toBe(201);

    const second = await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth()).send(body);
    // Either refused outright, or replayed as the SAME receipt — never a
    // second charge.
    if (second.status === 200) expect(second.body.idempotentReplay).toBe(true);
    else expect(second.status).toBe(409);

    const total = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) t FROM payments WHERE student_id = ? AND category = 'installment'`,
    ).get(STUDENT) as { t: number }).t;
    expect(total, 'the student must never be charged twice for one installment').toBe(1000);
  });

  it('a corrupt stored plan degrades safely instead of crashing a money route', async () => {
    // Simulates data written before the write-boundary validation existed.
    db.prepare('UPDATE students SET installment_plan = ? WHERE id = ?').run('"not-an-array"', STUDENT);

    const res = await supertest(app)
      .post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 100, category: 'installment', installmentId: 'i1', paymentMethod: 'cash' });

    // 409 "not found / already paid" — a handled business outcome, never a 500.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(409);
  });
});
