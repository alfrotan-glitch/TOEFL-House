/**
 * Overpayment rejection — student tuition
 * ============================================================================
 * Proven by live attack against the running API before this suite existed:
 *
 *   Obligation 5,000 · paid 2,500 · remaining 2,500
 *   POST amount 3,000  ->  201, amountCharged 2,500
 *
 * The route silently CAPPED the request at the outstanding balance. The
 * operator saw "Payment successfully registered" for a figure they never
 * entered, so a mistyped amount reconciled against the wrong cash total and
 * the receipt disagreed with the drawer. Capping also masked the real
 * question — whether that money was owed at all.
 *
 * The rule under test: a payment larger than the remaining balance is
 * REJECTED with a domain error. It is never capped, never partially applied,
 * and never recorded. The balance must be identical before and after.
 *
 * Both enforcement points are covered, because they fail differently:
 *   - the pre-check, which produces the operator-facing error, and
 *   - the in-transaction re-read, which is the one that holds under
 *     concurrency (all racing requests pass the pre-check simultaneously).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'overpay_branch';
let app: express.Express;
let seq = 0;

function user(): TokenPayload {
  return { userId: 'u_overpay', username: 'overpay_mgr', role: 'manager', branchId: BRANCH, fullName: 'Overpay Mgr' };
}
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

async function newStudent(): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: `Overpay Student ${seq}`,
    phone: `0788${String(200000 + seq).slice(-6)}`,
    gender: 'male',
    branchId: BRANCH,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Creates a student carrying a single tuition obligation of `fee`. */
async function studentOwing(fee: number): Promise<{ studentId: string; semesterId: string }> {
  const studentId = await newStudent();
  const res = await supertest(app)
    .post(`/api/students/${studentId}/enroll-semester`)
    .set(auth())
    .send({ semesterName: 'Semester 1', tuitionAmount: fee });
  expect(res.status).toBe(201);
  return { studentId, semesterId: res.body.semesterId };
}

function pay(studentId: string, semesterId: string, amount: number) {
  return supertest(app)
    .post(`/api/students/${studentId}/payments`)
    .set(auth())
    .send({ amount, category: 'fee', paymentMethod: 'cash', semesterId });
}

/** Authoritative outstanding balance, read from the database, not the API. */
function outstanding(studentId: string, semesterId: string): number {
  const sem = db.prepare('SELECT semester_name, fee_amount, net_fee_amount FROM student_semesters WHERE id = ?')
    .get(semesterId) as { semester_name: string; fee_amount: number; net_fee_amount: number | null };
  const paid = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payments
      WHERE student_id = ? AND status = 'completed'
        AND ((semester = ? AND category IN ('fee','installment')) OR category = 'refund')`
  ).get(studentId, sem.semester_name) as { s: number };
  return Number(sem.net_fee_amount ?? sem.fee_amount) - Number(paid.s);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Overpay Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`
  ).run('u_overpay', 'overpay_mgr', 'Overpay Mgr', BRANCH, await hashPassword('x'));
  syncLegacyUserRoles(db);

  app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
});

describe('tuition payment cannot exceed the remaining balance', () => {
  it('accepts a partial payment and reduces the balance by exactly that amount', async () => {
    const { studentId, semesterId } = await studentOwing(5000);
    const res = await pay(studentId, semesterId, 2000);
    expect(res.status).toBe(201);
    expect(res.body.amountCharged).toBe(2000);
    expect(outstanding(studentId, semesterId)).toBe(3000);
  });

  it('accepts a payment exactly equal to the remaining balance and settles it', async () => {
    const { studentId, semesterId } = await studentOwing(5000);
    // Deliberately different amounts: two identical un-keyed payments are one
    // business intent and correctly collapse into an idempotent replay (200),
    // which would not exercise the "pays off the remainder" path.
    expect((await pay(studentId, semesterId, 2000)).status).toBe(201);
    const res = await pay(studentId, semesterId, 3000);
    expect(res.status).toBe(201);
    expect(res.body.amountCharged).toBe(3000);
    expect(outstanding(studentId, semesterId)).toBe(0);
  });

  it('REJECTS an amount greater than the remaining balance instead of capping it', async () => {
    const { studentId, semesterId } = await studentOwing(5000);
    expect((await pay(studentId, semesterId, 2500)).status).toBe(201);
    expect(outstanding(studentId, semesterId)).toBe(2500);

    const res = await pay(studentId, semesterId, 3000);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the remaining balance/i);
    // The regression this guards: the request used to succeed as a 2,500
    // charge. Nothing may be recorded, so the balance is untouched.
    expect(outstanding(studentId, semesterId)).toBe(2500);
  });

  it('records no payment row and no income when an overpayment is rejected', async () => {
    const { studentId, semesterId } = await studentOwing(4000);
    await pay(studentId, semesterId, 9999);

    const rows = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(studentId) as { c: number };
    const income = db.prepare(
      `SELECT COUNT(*) AS c FROM financial_transactions WHERE reference_id = ? AND type = 'income'`
    ).get(studentId) as { c: number };
    expect(rows.c).toBe(0);
    expect(income.c).toBe(0);
  });

  it('REJECTS any further payment once the balance reaches zero', async () => {
    const { studentId, semesterId } = await studentOwing(3000);
    expect((await pay(studentId, semesterId, 3000)).status).toBe(201);
    expect(outstanding(studentId, semesterId)).toBe(0);

    const res = await pay(studentId, semesterId, 500);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already fully paid/i);
    expect(outstanding(studentId, semesterId)).toBe(0);
  });

  it('concurrent final payments cannot overpay the obligation', async () => {
    const { studentId, semesterId } = await studentOwing(5000);
    const results = await Promise.all(Array.from({ length: 8 }, () => pay(studentId, semesterId, 5000)));

    const charged = results.filter((r) => r.status === 201).length;
    expect(charged).toBe(1);
    // The invariant that actually matters is the money, not the status codes.
    expect(outstanding(studentId, semesterId)).toBe(0);
    const paid = db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id = ? AND status = 'completed'`
    ).get(studentId) as { s: number };
    expect(paid.s).toBe(5000);
  });
});
