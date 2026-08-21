/**
 * WP-07 · E1b — cash settles a term by naming it.
 * ============================================================================
 * `obligation_allocations` declared three instruments and only two used it.
 * Cash was attributed by `payments.semester`, a free-text column, so "what has
 * this term been paid" had two implementations reconciled by one reader.
 *
 * The reason this is not merely tidiness: `uq_student_semester_active` is
 * `UNIQUE(student_id, semester_name) WHERE status = 'active'`, so a term NAME
 * is unique only among ACTIVE terms and not over time. A student who takes
 * "Term One" twice has two terms carrying one name, and a string cannot say
 * which one the money paid. An allocation names the obligation, so it always
 * can — which is what the first case below proves.
 *
 * Owner decision on the refund fork: a refund REVERSES the allocation it
 * targets, through the mechanism scholarships and sponsorships already use, and
 * re-allocates whatever the student keeps settled. There is one way to undo an
 * allocation and `CHECK (amount > 0)` keeps guarding the table.
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
import { getStudentBalance, getSemesterTuitionSettled } from '../../../utils/studentBalance.js';
import { ensureTuitionObligation, getObligationPosition } from '../../../core/finance/obligations.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use(errorHandler);

const TERM = 'Term One';
let key: string;
let branch: string;
let studentId: string;
let semesterId: string;
let obligationId: string;
let owner: { Authorization: string };
let phoneSeq = 0;
const nextPhone = () => `07${String(4000000 + (phoneSeq += 1) + (process.pid % 100000)).slice(-8)}`;

const pay = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${studentId}/payments`).set(owner).send(body);

const refund = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${studentId}/refund`).set(owner).send(body);

const allocations = () =>
  db
    .prepare(
      `SELECT a.id, a.amount, a.source_kind, a.status, a.payment_id
         FROM obligation_allocations a WHERE a.obligation_id = ? ORDER BY a.rowid`,
    )
    .all(obligationId) as Array<{ id: string; amount: number; source_kind: string; status: string; payment_id: string | null }>;

const activeCash = () => allocations().filter((a) => a.source_kind === 'payment' && a.status === 'active');

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7c_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);
  studentId = `${key}_s`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Cash Probe', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-C${(phoneSeq += 1)}-${key.slice(-6)}`, today(), branch, nextPhone());
  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, TERM, today());
  obligationId = ensureTuitionObligation(db, semesterId).id;
  seedUser({ id: `${key}_own`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_own`);
});

describe('WP-07 · E1b — cash names the obligation it settles', () => {
  it('a tuition payment writes an allocation, and the term reads it', async () => {
    await pay({ category: 'fee', amount: 4000, semesterId }).expect(201);

    const cash = activeCash();
    expect(cash).toHaveLength(1);
    expect(cash[0].amount).toBe(4000);

    expect(getObligationPosition(db, obligationId).settledCash).toBe(4000);
    expect(getSemesterTuitionSettled(db, studentId, TERM)).toBe(4000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(6000);
  });

  it('THE reason for E1b — a repeated term name cannot confuse the settlement', async () => {
    // The first term is completed and a SECOND term of the same name opens.
    // `uq_student_semester_active` permits this, so one name now covers two
    // different debts.
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    db.prepare("UPDATE student_semesters SET status = 'completed' WHERE id = ?").run(semesterId);

    const secondId = `${key}_sem2`;
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, ?, ?, 10000, 10000, 'active')`,
    ).run(secondId, studentId, TERM, today());
    const secondObligation = ensureTuitionObligation(db, secondId).id;

    // Each term knows exactly what IT was paid, because the money named it.
    expect(getObligationPosition(db, obligationId).settledCash).toBe(10000);
    expect(getObligationPosition(db, obligationId).outstanding).toBe(0);
    expect(getObligationPosition(db, secondObligation).settledCash).toBe(0);
    expect(getObligationPosition(db, secondObligation).outstanding).toBe(10000);

    // And the second term is still collectable in full.
    await pay({ category: 'fee', amount: 10000, semesterId: secondId }).expect(201);
    expect(getObligationPosition(db, secondObligation).settledCash).toBe(10000);
  });

  it('a non-tuition charge allocates nothing', async () => {
    await pay({ category: 'other', amount: 2000, notes: 'ad-hoc non-tuition charge' }).expect(201);
    expect(allocations()).toHaveLength(0);
    expect(getStudentBalance(db, studentId).outstanding).toBe(10000);
  });

  it('a full refund reverses the allocation and re-opens the term', async () => {
    const paid = await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const paymentId = (db.prepare('SELECT id FROM payments WHERE student_id = ? AND category = ?').get(studentId, 'fee') as { id: string }).id;
    expect(paid.status).toBe(201);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);

    await refund({ amount: 10000, paymentId, reason: 'student withdrew before the term began' }).expect(201);

    expect(activeCash()).toHaveLength(0);
    expect(allocations().filter((a) => a.status === 'reversed')).toHaveLength(1);
    expect(getObligationPosition(db, obligationId).settledCash).toBe(0);
    expect(getStudentBalance(db, studentId).outstanding).toBe(10000);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a partial refund retains the part the student keeps settled', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const paymentId = (db.prepare('SELECT id FROM payments WHERE student_id = ? AND category = ?').get(studentId, 'fee') as { id: string }).id;

    await refund({ amount: 3000, paymentId, reason: 'partial withdrawal from the term' }).expect(201);

    // One reversed row and one fresh active row for the 7,000 retained.
    const cash = activeCash();
    expect(cash).toHaveLength(1);
    expect(cash[0].amount).toBe(7000);
    expect(allocations().filter((a) => a.status === 'reversed')).toHaveLength(1);

    expect(getObligationPosition(db, obligationId).settledCash).toBe(7000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(3000);

    // The re-opened 3,000 is collectable again, and no more than that.
    const over = await pay({ category: 'fee', amount: 3001, semesterId });
    expect(over.status).toBe(400);
    await pay({ category: 'fee', amount: 3000, semesterId }).expect(201);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
  });

  it('two successive partial refunds each reduce the term by exactly their amount', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    const paymentId = (db.prepare('SELECT id FROM payments WHERE student_id = ? AND category = ?').get(studentId, 'fee') as { id: string }).id;

    await refund({ amount: 2000, paymentId, reason: 'first partial return of the fee' }).expect(201);
    await refund({ amount: 3000, paymentId, reason: 'second partial return of the fee' }).expect(201);

    expect(activeCash()).toHaveLength(1);
    expect(activeCash()[0].amount).toBe(5000);
    expect(getObligationPosition(db, obligationId).settledCash).toBe(5000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(5000);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a refund of a non-tuition charge touches no allocation', async () => {
    await pay({ category: 'fee', amount: 10000, semesterId }).expect(201);
    await pay({ category: 'other', amount: 2000, notes: 'ad-hoc non-tuition charge' }).expect(201);
    const examId = (db.prepare('SELECT id FROM payments WHERE student_id = ? AND category = ?').get(studentId, 'other') as { id: string }).id;

    await refund({ amount: 2000, paymentId: examId, reason: 'exam was cancelled by the institute' }).expect(201);

    expect(activeCash()).toHaveLength(1);
    expect(activeCash()[0].amount).toBe(10000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
  });

  it('an instalment payment allocates to the term its plan belongs to', async () => {
    await supertest(app)
      .put(`/api/students/${studentId}/installment-plan`)
      .set(owner)
      .send({ semesterId, installments: [{ amount: 4000 }, { amount: 6000 }] })
      .expect(200);
    const first = (db.prepare('SELECT id FROM student_installments WHERE obligation_id = ? ORDER BY sequence').get(obligationId) as { id: string }).id;

    await pay({ category: 'installment', amount: 4000, installmentId: first }).expect(201);

    expect(activeCash()).toHaveLength(1);
    expect(activeCash()[0].amount).toBe(4000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(6000);
  });
});

describe('WP-07 · E1b · ATTACK', () => {
  it('a rejected payment leaves no allocation behind', async () => {
    const res = await pay({ category: 'fee', amount: 10001, semesterId });
    expect(res.status).toBe(400);
    expect(allocations()).toHaveLength(0);
  });

  it('a retried payment settles the term once, not twice', async () => {
    const body = { category: 'fee', amount: 5000, semesterId };
    const first = await pay(body);
    const retry = await pay(body);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(retry.status);

    expect(activeCash()).toHaveLength(1);
    expect(getObligationPosition(db, obligationId).settledCash).toBe(5000);
  });

  it('cash and aid together cannot settle more than the term bills', async () => {
    const scholarshipId = `${key}_sch`;
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, branch_id) VALUES (?, 'Fund', 0, ?)`).run(scholarshipId, branch);
    const donorId = `${key}_donor`;
    db.prepare(`INSERT INTO donors (id, full_name, type) VALUES (?, 'D', 'individual')`).run(donorId);
    const donationId = `${key}_don`;
    db.prepare(
      `INSERT INTO donations (id, donor_id, amount, date, receipt_no, branch_id, idempotency_key)
       VALUES (?, ?, 6000, ?, ?, ?, ?)`,
    ).run(donationId, donorId, today(), `DN-${key.slice(-6)}`, branch, donationId);
    db.prepare(
      `INSERT INTO scholarship_fundings (id, scholarship_id, donation_id, amount, branch_id, operator_name, date)
       VALUES (?, ?, ?, 6000, ?, 'Owner', ?)`,
    ).run(`${key}_f`, scholarshipId, donationId, branch, today());
    const awardId = `${key}_awd`;
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, status, branch_id, award_date)
       VALUES (?, ?, ?, 6000, 'active', ?, ?)`,
    ).run(awardId, scholarshipId, studentId, branch, today());
    db.transaction(() => {
      db.prepare(
        `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, scholarship_award_id, status, date)
         VALUES (?, ?, 6000, 'scholarship', ?, 'active', ?)`,
      ).run(`${key}_alloc`, obligationId, awardId, today());
    })();

    // 6,000 of the 10,000 term is already settled by a donor.
    expect(getObligationPosition(db, obligationId).outstanding).toBe(4000);
    expect((await pay({ category: 'fee', amount: 4001, semesterId })).status).toBe(400);
    await pay({ category: 'fee', amount: 4000, semesterId }).expect(201);
    expect(getObligationPosition(db, obligationId).outstanding).toBe(0);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
  });

  it('the database still refuses a cash allocation that names no payment', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, status, date)
           VALUES (?, ?, 1000, 'payment', 'active', ?)`,
        )
        .run(`${key}_bad`, obligationId, today()),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('the database still refuses a non-positive allocation', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, payment_id, status, date)
           VALUES (?, ?, -1000, 'payment', NULL, 'active', ?)`,
        )
        .run(`${key}_bad2`, obligationId, today()),
    ).toThrow(/CHECK constraint failed/i);
  });
});
