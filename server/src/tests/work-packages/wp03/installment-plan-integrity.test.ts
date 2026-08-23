/**
 * An instalment plan is financial data, and it belongs to the term it pays.
 * ============================================================================
 * F-11 (proven live, 2026-08-16): `PATCH /api/students/:id` stored ANY value for
 * `installmentPlan` with an unconditional `JSON.stringify()`. A pre-serialised
 * plan double-encoded the column, parsed back as a *string*, and the payment
 * route crashed with `500 plan.find is not a function` on data the server itself
 * had written.
 *
 * Owner decision D-125 removed the class rather than the instance: the plan is
 * no longer a free-form field of the student profile. It is the schedule of one
 * tuition obligation, written through
 * `PUT /api/students/:id/installment-plan` against the term it pays, and stored
 * in `student_installments` with foreign keys, CHECK constraints and whole-AFN
 * amounts. A JSON blob cannot be malformed if there is no JSON blob.
 *
 * These cases keep the original behavioural knowledge — a plan cannot be
 * corrupt, an instalment charges exactly its amount, and it cannot be paid
 * twice — expressed against the model that replaced it.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import studentsRouter from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { today } from '../../../utils/ids.js';

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
    userId: 'u_inst', username: 'u_inst', branchId: BRANCH, fullName: 'Inst Mgr',
  } as TokenPayload)}`,
});

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('u_inst', 'u_inst', 'Inst Mgr', ?, ?, 1, 0)`,
  ).run(BRANCH, pw);
  assignRole('u_inst', 'manager', BRANCH);

  // The fixture clears prior synthetic history, then restores the canonical
  // allocation trigger before it runs the next case.
  db.exec('DROP TRIGGER IF EXISTS trg_allocations_immutable_delete');
  // Order matters, and it runs BEFORE the student is re-inserted: an instalment
  // names the payment that paid it, an allocation names its obligation, and an
  // obligation names its student — all ON DELETE RESTRICT, so an
  // INSERT OR REPLACE on the student would be blocked by its own history.
  db.prepare(`DELETE FROM student_installments WHERE obligation_id IN (SELECT id FROM student_obligations WHERE student_id = ?)`).run(STUDENT);
  db.prepare(`DELETE FROM obligation_allocations WHERE obligation_id IN (SELECT id FROM student_obligations WHERE student_id = ?)`).run(STUDENT);
  db.prepare(`DELETE FROM payments WHERE student_id = ? AND category = 'refund'`).run(STUDENT);
  db.prepare(`DELETE FROM payments WHERE student_id = ?`).run(STUDENT);
  db.prepare(`DELETE FROM student_obligations WHERE student_id = ?`).run(STUDENT);
  db.prepare(`DELETE FROM student_semesters WHERE student_id = ?`).run(STUDENT);
  initSchema();
  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id, discount_percent)
     VALUES (?, 'INST-1', 'Installment Student', 'male', '0700440001', 'active', ?, ?, 0)`,
  ).run(STUDENT, today(), BRANCH);
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Instalment Term', ?, 12000, 12000, 'active')`,
  ).run(SEMESTER, STUDENT, today());
  app = createApp();
});

const SEMESTER = 'inst_semester';

/** The plan is written against the term it pays. */
const putPlan = (installments: unknown, semesterId: string = SEMESTER) =>
  supertest(app).put(`/api/students/${STUDENT}/installment-plan`).set(auth()).send({ semesterId, installments });

/** The retired route: a plan is no longer a profile field. */
const patchPlan = (plan: unknown) =>
  supertest(app).patch(`/api/students/${STUDENT}`).set(auth()).send({ installmentPlan: plan });

describe('F-11: an instalment plan is a schedule, not a JSON field', () => {
  it('the student profile no longer accepts a plan at all', async () => {
    // The double-encoding defect needed a free-form field to double-encode.
    for (const plan of [JSON.stringify([{ id: 'i1', amount: 100 }]), [{ id: 'i1', amount: 100 }], 'not-json']) {
      const res = await patchPlan(plan);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/installment-plan/);
    }
    expect(() => db.prepare('SELECT installment_plan FROM students LIMIT 1').get()).toThrow(/no such column/i);
  });

  it('rejects structurally invalid plans', async () => {
    const cases: Array<[string, unknown]> = [
      ['object rather than array', { amount: 100 }],
      ['empty plan', []],
      ['zero amount', [{ amount: 0 }]],
      ['negative amount', [{ amount: -500 }]],
      ['non-numeric amount', [{ amount: 'lots' }]],
      ['fractional amount', [{ amount: 100.5 }]],
      ['unparseable due date', [{ amount: 100, dueDate: 'someday' }]],
      ['impossible due date', [{ amount: 100, dueDate: '2026-02-30' }]],
    ];
    for (const [label, plan] of cases) {
      const res = await putPlan(plan);
      expect(res.status, `${label} must be refused`).toBe(400);
    }
    // Identity is the database's job now: instalments are rows with primary
    // keys, so duplicate or blank ids cannot be expressed at all.
  });

  it('refuses a plan that promises more than the term bills', async () => {
    const res = await putPlan([{ amount: 7000 }, { amount: 6000 }]);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/the term bills 12000 AFN/);
  });

  it('refuses a plan against a term that is not this student\'s', async () => {
    expect((await putPlan([{ amount: 1000 }], 'no_such_semester')).status).toBe(404);
  });

  it('accepts a valid plan and charges exactly the instalment amount', async () => {
    const plan = await putPlan([{ amount: 2500, dueDate: today() }, { amount: 2500 }]);
    expect(plan.status).toBe(200);
    const [first] = plan.body as Array<{ id: string; status: string }>;

    const pay = await supertest(app)
      .post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 2500, category: 'installment', installmentId: first.id, paymentMethod: 'cash' });
    expect(pay.status).toBe(201);

    const rows = db.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM payments WHERE student_id = ? AND category = 'installment'`,
    ).get(STUDENT) as { c: number; t: number };
    expect(rows).toEqual({ c: 1, t: 2500 });

    // Only the paid instalment flips, and it names the payment that paid it.
    const stored = db.prepare(
      `SELECT id, status, paid_payment_id FROM student_installments ORDER BY sequence`,
    ).all() as Array<{ id: string; status: string; paid_payment_id: string | null }>;
    expect(stored.map((i) => `${i.id === first.id ? 'first' : 'second'}=${i.status}`)).toEqual(['first=paid', 'second=pending']);
    expect(stored[0].paid_payment_id).toBeTruthy();
  });

  it('an instalment payment settles the term its plan pays', async () => {
    const plan = await putPlan([{ amount: 4000 }]);
    const [only] = plan.body as Array<{ id: string }>;
    await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 4000, category: 'installment', installmentId: only.id, paymentMethod: 'cash' })
      .expect(201);

    // The term now shows 4,000 settled, so it cannot be collected twice.
    const row = db.prepare(
      `SELECT COALESCE(SUM(amount),0) t FROM payments WHERE student_id = ? AND semester = 'Instalment Term'`,
    ).get(STUDENT) as { t: number };
    expect(row.t).toBe(4000);

    const overCollect = await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 12000, category: 'fee', semesterId: SEMESTER, paymentMethod: 'cash' });
    expect(overCollect.status).toBe(400);
    expect(String(overCollect.body.error)).toMatch(/Outstanding: 8000 AFN/);
  });

  it('an instalment cannot be paid twice', async () => {
    const plan = await putPlan([{ amount: 1000 }]);
    const [only] = plan.body as Array<{ id: string }>;
    const body = { amount: 1000, category: 'installment', installmentId: only.id, paymentMethod: 'cash' };

    const first = await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth()).send(body);
    expect(first.status).toBe(201);

    const second = await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth()).send(body);
    if (second.status === 200) expect(second.body.idempotentReplay).toBe(true);
    else expect(second.status).toBe(409);

    const total = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) t FROM payments WHERE student_id = ? AND category = 'installment'`,
    ).get(STUDENT) as { t: number }).t;
    expect(total, 'the student must never be charged twice for one instalment').toBe(1000);
  });

  it('a plan with a paid instalment can no longer be rewritten', async () => {
    const plan = await putPlan([{ amount: 1000 }, { amount: 1000 }]);
    const [first] = plan.body as Array<{ id: string }>;
    await supertest(app).post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 1000, category: 'installment', installmentId: first.id, paymentMethod: 'cash' }).expect(201);

    const rewrite = await putPlan([{ amount: 5000 }]);
    expect(rewrite.status).toBe(409);
    expect(String(rewrite.body.error)).toMatch(/paid instalment/i);
  });

  it('a plan is no longer a field of the student profile', async () => {
    const res = await patchPlan([{ id: 'i1', amount: 100 }]);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/installment-plan/);
  });

  it('an unknown instalment is a handled outcome, never a 500', async () => {
    const res = await supertest(app)
      .post(`/api/students/${STUDENT}/payments`).set(auth())
      .send({ amount: 100, category: 'installment', installmentId: 'inst_does_not_exist', paymentMethod: 'cash' });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });
});
