/**
 * WP-07 · Refund attribution authority.
 * ============================================================================
 * Owner decisions D-113 and D-114, implemented and pinned here.
 *
 *   D-113  A refund reverses ONE named payment. It inherits that payment's
 *          identity, and it may never exceed what is left on it.
 *   D-114  A tuition refund re-opens the debt of the semester the reversed
 *          payment settled — and only that semester.
 *
 * WP07-F11, the defect that forced the question, is the first case below: with
 * unattributed refunds, returning a 2,000 AFN exam fee moved a student who had
 * paid tuition in full to 2,000 AFN of tuition debt, because the canonical
 * balance authority counted every refund against tuition. The enrolment
 * debt-hold reads that same authority, so the student could then be refused a
 * seat over money they did not owe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import studentsRouter from '../../../routes/students.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { getStudentBalance, getStudentBalancesPage, getBranchOutstanding } from '../../../utils/studentBalance.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let otherBranch: string;
let studentId: string;
let otherStudentId: string;
let semesterId: string;
const SEMESTER = 'Term One';
let owner: { Authorization: string };
let phoneSeq = 0;
const nextPhone = () => `07${String(1000000 + (phoneSeq += 1) + process.pid % 100000).slice(-8)}`;

const pay = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${studentId}/payments`).set(owner).send(body);

const refund = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${studentId}/refund`).set(owner).send(body);

const paymentsOf = (student = studentId) =>
  db.prepare('SELECT id, amount, category, semester, refunds_payment_id FROM payments WHERE student_id = ? ORDER BY rowid').all(student) as Array<{
    id: string; amount: number; category: string; semester: string | null; refunds_payment_id: string | null;
  }>;

/** The route's own semester-settlement rule, read from the database. */
const paidTowardSemester = () =>
  Number(
    (db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN category IN ('fee','installment') THEN amount
                                WHEN category = 'refund' THEN amount ELSE 0 END), 0) AS paid
         FROM payments WHERE student_id = ? AND semester = ? AND status = 'completed'`,
    ).get(studentId, SEMESTER) as { paid: number }).paid,
  );

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7r_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  otherBranch = `${key}_ob`;
  for (const b of [branch, otherBranch]) {
    db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(b, b);
  }
  studentId = `${key}_s`;
  otherStudentId = `${key}_s2`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Refund Probe', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-R${key.slice(-5)}`, today(), branch, nextPhone());
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Other Student', 'active', ?, ?, 'female', ?)`,
  ).run(otherStudentId, `TH-O${key.slice(-5)}`, today(), branch, nextPhone());
  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, SEMESTER, today());
  seedUser({ id: `${key}_owner`, role: 'owner', branchId: branch, fullName: 'Owner' });
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES (?, ?, 'card', 'ID card fee', 200, 1, 1)
  `).run(`${key}_card_fee`, branch);
  owner = bearerFor(`${key}_owner`);
});

describe('WP-07 · a refund reverses one named payment', () => {
  it('WP07-F11 · refunding a non-tuition charge leaves the tuition position untouched', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    await pay({ category: 'exam', amount: 2000, notes: 'Exam sitting fee' }).expect(201);
    const examPayment = paymentsOf().find((p) => p.category === 'exam')!;

    expect(getStudentBalance(db, studentId, 'all').outstanding).toBe(0);

    const res = await refund({ amount: 2000, reason: 'Exam cancelled', paymentId: examPayment.id }).expect(201);
    expect(res.body.refundsCategory).toBe('exam');
    expect(res.body.semester).toBeNull();

    const after = getStudentBalance(db, studentId, 'all');
    expect(after.tuitionPaid).toBe(10000);
    expect(after.outstanding).toBe(0);
    // Every surface that reads the same authority agrees.
    expect(getStudentBalancesPage(db, { branchId: branch, scope: 'all', limit: 50, offset: 0 })
      .find((r) => r.studentId === studentId)?.outstanding).toBe(0);
    expect(getBranchOutstanding(db, branch)).toBe(0);
  });

  it('D-114 · refunding tuition re-opens exactly the semester it settled', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const feePayment = paymentsOf().find((p) => p.category === 'fee')!;
    expect(paidTowardSemester()).toBe(10000);

    const res = await refund({ amount: 4000, reason: 'Withdrew from a module', paymentId: feePayment.id }).expect(201);
    expect(res.body.semester).toBe(SEMESTER);

    // The refund carries the semester of the payment it reverses, so the term's
    // debt re-opens by exactly the refunded amount.
    expect(paidTowardSemester()).toBe(6000);
    expect(getStudentBalance(db, studentId, 'all').outstanding).toBe(4000);
    const stored = paymentsOf().find((p) => p.category === 'refund')!;
    expect(stored).toMatchObject({ amount: -4000, semester: SEMESTER, refunds_payment_id: feePayment.id });
  });

  it('a refund of a non-tuition charge carries no semester, so no term re-opens', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    await pay({ category: 'card', amount: 200 }).expect(201);
    const card = paymentsOf().find((p) => p.category === 'card')!;
    await refund({ amount: 200, reason: 'Card not issued', paymentId: card.id }).expect(201);
    expect(paidTowardSemester()).toBe(10000);
  });

  it('cash and the ledger still move, and reconciliation stays healthy', async () => {
    await pay({ category: 'fee', amount: 5000, semesterId }).expect(201);
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 5000, reason: 'Full withdrawal', paymentId: fee.id }).expect(201);

    const contra = db.prepare(
      `SELECT type, category, amount FROM financial_transactions WHERE branch_id = ? AND category = 'refund'`,
    ).get(branch) as { type: string; category: string; amount: number };
    expect(contra).toMatchObject({ type: 'income', category: 'refund', amount: -5000 });
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });
});

describe('WP-07 · one semester\'s refund never moves another semester\'s debt', () => {
  const SECOND = 'Term Two';
  let secondSemesterId: string;

  beforeEach(() => {
    secondSemesterId = `${key}_sem2`;
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, ?, ?, 10000, 10000, 'active')`,
    ).run(secondSemesterId, studentId, SECOND, today());
  });

  it('WP07-F15 · a refund of term one does not make term two cost more', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const feeOne = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 2000, reason: 'Withdrew from term one', paymentId: feeOne.id }).expect(201);

    // Term two is untouched by term one's refund: it costs 10,000 and, once
    // paid, refuses another afghani. Counting every refund against whichever
    // term was being paid made the desk accept money on a settled term.
    await pay({ category: 'fee', amount: 10000, semesterId: secondSemesterId }).expect(201);
    const overCollect = await pay({ category: 'fee', amount: 1, semesterId: secondSemesterId });
    expect(overCollect.status).toBe(400);
    expect(String(overCollect.body.error)).toMatch(/already fully paid/i);
  });

  it('term one still shows the debt its own refund re-opened', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const feeOne = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 2000, reason: 'Withdrew from term one', paymentId: feeOne.id }).expect(201);

    // The re-opened 2,000 is collectable again — and only that.
    const tooMuch = await pay({ category: 'fee', amount: 2001, semesterId });
    expect(tooMuch.status).toBe(400);
    await pay({ category: 'fee', amount: 2000, semesterId }).expect(201);
    expect(paidTowardSemester()).toBe(10000);
  });

  it('a refund of a non-tuition charge changes no semester at all', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    await pay({ category: 'exam', amount: 1500, notes: 'Exam sitting fee' }).expect(201);
    const exam = paymentsOf().find((p) => p.category === 'exam')!;
    await refund({ amount: 1500, reason: 'Exam cancelled', paymentId: exam.id }).expect(201);

    for (const sem of [semesterId, secondSemesterId]) {
      const res = await pay({ category: 'fee', amount: 1, semesterId: sem });
      if (sem === semesterId) {
        expect(res.status).toBe(400);
        expect(String(res.body.error)).toMatch(/already fully paid/i);
      } else {
        expect(res.status).toBe(201);
      }
    }
  });
});

describe('WP-07 · attack · a refund cannot be pointed anywhere else', () => {
  beforeEach(async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
  });

  it('refuses a refund that names no payment', async () => {
    const res = await refund({ amount: 100, reason: 'Unattributed' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/name the payment it reverses/i);
    expect(paymentsOf().filter((p) => p.category === 'refund')).toHaveLength(0);
  });

  it('refuses a payment id that does not exist', async () => {
    const res = await refund({ amount: 100, reason: 'Ghost', paymentId: 'pay_does_not_exist' });
    expect(res.status).toBe(404);
  });

  it("refuses another student's payment", async () => {
    db.prepare(
      `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
       VALUES (?, ?, 3000, ?, 'cash', 'completed', 'fee', ?, ?, ?)`,
    ).run(`${key}_other_pay`, otherStudentId, today(), `RC-${key}-o`, branch, `k_${randomUUID()}`);

    const res = await refund({ amount: 100, reason: 'Wrong student', paymentId: `${key}_other_pay` });
    expect(res.status).toBe(403);
    expect(paymentsOf().filter((p) => p.category === 'refund')).toHaveLength(0);
  });

  it('refuses to refund a refund', async () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 1000, reason: 'First', paymentId: fee.id }).expect(201);
    const firstRefund = paymentsOf().find((p) => p.category === 'refund')!;

    const res = await refund({ amount: 500, reason: 'Refund of a refund', paymentId: firstRefund.id });
    expect(res.status).toBe(400);
  });

  it('refuses more than the payment still holds, and allows exactly what it holds', async () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 6000, reason: 'Part one', paymentId: fee.id }).expect(201);

    const tooMuch = await refund({ amount: 4001, reason: 'Part two', paymentId: fee.id });
    expect(tooMuch.status).toBe(400);
    expect(String(tooMuch.body.error)).toMatch(/4000 AFN still refundable/);

    await refund({ amount: 4000, reason: 'Part two', paymentId: fee.id }).expect(201);
    const exhausted = await refund({ amount: 1, reason: 'Part three', paymentId: fee.id });
    expect(exhausted.status).toBe(409);
    expect(getStudentBalance(db, studentId, 'all').tuitionPaid).toBe(0);
  });

  it('two concurrent refunds cannot together exceed the payment', async () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    const [a, b] = await Promise.all([
      supertest(app).post(`/api/students/${studentId}/refund`).set(owner)
        .set('Idempotency-Key', `${key}-a`).send({ amount: 8000, reason: 'Race A', paymentId: fee.id }),
      supertest(app).post(`/api/students/${studentId}/refund`).set(owner)
        .set('Idempotency-Key', `${key}-b`).send({ amount: 8000, reason: 'Race B', paymentId: fee.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const refunded = paymentsOf().filter((p) => p.category === 'refund').reduce((sum, p) => sum + Math.abs(p.amount), 0);
    expect(refunded).toBe(8000);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('the database refuses an unattributed refund even when the route is bypassed', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
         VALUES (?, ?, -500, ?, 'cash', 'completed', 'refund', ?, ?, ?)`,
      ).run(`${key}_raw_refund`, studentId, today(), `RC-${key}-raw`, branch, `k_${randomUUID()}`),
    ).toThrow(/must name the payment it reverses/i);
  });

  it('the database refuses a charge that claims to reverse something', () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    expect(() =>
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key, refunds_payment_id)
         VALUES (?, ?, 500, ?, 'cash', 'completed', 'fee', ?, ?, ?, ?)`,
      ).run(`${key}_bad_charge`, studentId, today(), `RC-${key}-bad`, branch, `k_${randomUUID()}`, fee.id),
    ).toThrow(/only a refund may name one/i);
  });

  it('a refunded payment cannot be deleted out from under its refund', async () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 1000, reason: 'Keep the trail', paymentId: fee.id }).expect(201);
    expect(() => db.prepare('DELETE FROM payments WHERE id = ?').run(fee.id)).toThrow(/FOREIGN KEY/i);
  });

  it('a retried refund of the same payment replays instead of paying twice', async () => {
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    const first = await supertest(app).post(`/api/students/${studentId}/refund`).set(owner)
      .set('Idempotency-Key', `${key}-retry`).send({ amount: 2500, reason: 'Retry', paymentId: fee.id }).expect(201);
    const retry = await supertest(app).post(`/api/students/${studentId}/refund`).set(owner)
      .set('Idempotency-Key', `${key}-retry`).send({ amount: 2500, reason: 'Retry', paymentId: fee.id }).expect(200);
    expect(retry.body).toMatchObject({ receiptNumber: first.body.receiptNumber, idempotentReplay: true });
    expect(paymentsOf().filter((p) => p.category === 'refund')).toHaveLength(1);
  });
});

describe('WP-07 · the refundable list is server truth', () => {
  it('publishes what is left on each payment, and drops the exhausted ones', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    await pay({ category: 'exam', amount: 2000, notes: 'Exam sitting fee' }).expect(201);
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    const exam = paymentsOf().find((p) => p.category === 'exam')!;
    await refund({ amount: 3000, reason: 'Partial', paymentId: fee.id }).expect(201);
    await refund({ amount: 2000, reason: 'Whole exam fee', paymentId: exam.id }).expect(201);

    const list = (await supertest(app).get(`/api/students/${studentId}/refundable-payments`).set(owner).expect(200)).body as Array<{
      id: string; refundableAmount: number; refundedAmount: number; semester: string | null;
    }>;
    expect(list.map((r) => r.id)).toEqual([fee.id]);
    expect(list[0]).toMatchObject({ refundableAmount: 7000, refundedAmount: 3000, semester: SEMESTER });
  });

  it('never lists a refund as refundable', async () => {
    await pay({ category: 'fee', amount: 1000, semesterId }).expect(201);
    const fee = paymentsOf().find((p) => p.category === 'fee')!;
    await refund({ amount: 1000, reason: 'All of it', paymentId: fee.id }).expect(201);
    const list = (await supertest(app).get(`/api/students/${studentId}/refundable-payments`).set(owner).expect(200)).body;
    expect(list).toEqual([]);
  });
});
