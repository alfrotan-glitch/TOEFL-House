/**
 * Financial-subsystem forensics — the 2026-09-05 full-ledger audit.
 * ============================================================================
 * Each test here pins a defect that was PROVEN LIVE (API drills against the
 * running server) before the fix, in the same 10-point discipline as the
 * forensic ledger. Every one of these is a way the books could be wrong while
 * the application kept saying yes:
 *
 *   FS-1  a tuition invoice could collect more than its term still owed
 *         (desk and invoice paths disagreed; obligation over-settled at 133%)
 *   FS-2  refunding an invoice payment left the invoice 'paid' and the
 *         invoice-backed balance counting returned cash as settled
 *   FS-3  the journey enrollment path priced the term from the fee-rule
 *         catalog instead of the class fee (second price authority)
 *   FS-4  exam fees booked income with no payment row and no receipt
 *   FS-5  the obligation engine trusted callers not to over-allocate a payment
 *   FS-6  aid settlement stranded the tuition invoices billing the term
 *   FS-7  employee payroll accepted any "full" amount with no due authority
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import journeyRouter from '../routes/journey.routes.js';
import examsRouter from '../routes/exams.routes.js';
import { fundingRouter } from '../routes/funding.routes.js';
import { employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { assignRole } from './support/identity.js';
import { seedLinkedDonation } from './support/funding.js';
import { getStudentNonTuitionSummary } from '../utils/studentBalance.js';
import {
  allocatePaymentToObligation,
  ensureTuitionObligation,
  getObligationPosition,
} from '../core/finance/obligations.js';
import { registerEventHandlers } from '../core/events/handlers.js';
import { eventBus } from '../core/events/event-bus.js';
import { seedDefaultAutomations } from '../routes/automations.routes.js';

const BRANCH = 'fsx_branch';
const USER = 'u_fsx';
const CLASS_A = 'fsx_class_a';   // fee 6500, divergent fee rule 6000
const CLASS_B = 'fsx_class_b';   // fee 5000, invoice over-collect drill
const EXAM = 'fsx_exam';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/students/:id/journey', journeyRouter);
  app.use('/api/exams', examsRouter);
  app.use('/api/funding', fundingRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
  return app;
}

const gm = (): TokenPayload => ({ userId: USER, username: 'fsx', branchId: BRANCH, fullName: 'Fsx GM' });
const auth = () => ({ Authorization: `Bearer ${signToken(gm())}` });
const REG_USER = 'u_fsx_reg';
const reg = (): TokenPayload => ({ userId: REG_USER, username: 'fsx_reg', branchId: BRANCH, fullName: 'Fsx Reg' });
const regAuth = () => ({ Authorization: `Bearer ${signToken(reg())}` });

let app: express.Express;
let seq = 0;

async function newStudent(name: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: name, phone: `0788${String(100000 + seq).slice(-6)}`, gender: 'male', branchId: BRANCH,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function settleRegistration(studentId: string): Promise<void> {
  const invs = db.prepare(`SELECT id, net_amount FROM invoices WHERE student_id = ? AND charge_kind = 'registration' AND status = 'issued'`).all(studentId) as Array<{ id: string; net_amount: number }>;
  for (const inv of invs) {
    const res = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth()).send({ amount: inv.net_amount, paymentMethod: 'cash' });
    expect([200, 201]).toContain(res.status);
  }
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  registerEventHandlers();
  seedDefaultAutomations();
  eventBus.markHandlersReady();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'FSX Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(USER, 'fsx', 'Fsx GM', BRANCH, await hashPassword('x'));
  // general_manager passes the role-label gates (invoice pay, exam enroll) and,
  // through the RBAC catalog, the permission gates (refund, funding, class).
  assignRole(USER, 'general_manager', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(REG_USER, 'fsx_reg', 'Fsx Reg', BRANCH, await hashPassword('x'));
  // A registrar CANNOT override the academic hold — that is the point of FS-8.
  assignRole(REG_USER, 'registrar', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO classes (id, name, level, branch_id, status, lifecycle_stage, schedule_time, fee)
     VALUES (?, 'FSX A', 'A1', ?, 'active', 'in_progress', '08:00', 6500)`,
  ).run(CLASS_A, BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO classes (id, name, level, branch_id, status, lifecycle_stage, schedule_time, fee)
     VALUES (?, 'FSX B', 'A2', ?, 'active', 'in_progress', '10:00', 5000)`,
  ).run(CLASS_B, BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
     VALUES ('fsx_registration', ?, 'registration', 'Registration', 0, 1, 1)`,
  ).run(BRANCH);
  // A semester fee rule that DISAGREES with CLASS_A's pinned fee: 6000 vs 6500.
  db.prepare(
    `INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
     VALUES ('fsx_semester', ?, 'semester', 'Semester', 6000, 1, 1)`,
  ).run(BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO exams (id, title, fee, branch_id, date, type)
     VALUES (?, 'FSX Exam', 500, ?, '2026-09-10', 'midterm')`,
  ).run(EXAM, BRANCH);
  app = createApp();
});

describe('FS-3 — the class is the price of its seat, on EVERY enrollment path', () => {
  it('prices a journey-enrolled term from classes.fee, not the fee-rule snapshot', async () => {
    const sid = await newStudent('FS3 Price Authority');
    await settleRegistration(sid);
    const res = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(auth())
      .send({ classId: CLASS_A, semesterName: 'FS3 Term', enrollmentType: 'new' });
    expect(res.status).toBe(201);
    const term = db.prepare('SELECT fee_amount, net_fee_amount FROM student_semesters WHERE student_id = ?').get(sid) as { fee_amount: number; net_fee_amount: number };
    expect(term.fee_amount).toBe(6500);
    expect(term.net_fee_amount).toBe(6500);
    // The tuition invoice bills the class fee too, not the catalog fee.
    const tinv = db.prepare(`SELECT net_amount FROM invoices WHERE student_id = ? AND purpose = 'tuition'`).get(sid) as { net_amount: number };
    expect(tinv.net_amount).toBe(6500);
  });
});

describe('FS-1 — a tuition invoice cannot collect beyond its term', () => {
  it('refuses an invoice payment that exceeds the obligation outstanding, while the desk refuses the same', async () => {
    const sid = await newStudent('FS1 Overcollect');
    await settleRegistration(sid);
    const j = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(auth())
      .send({ classId: CLASS_B, semesterName: 'FS1 Term', enrollmentType: 'new' });
    expect(j.status).toBe(201);
    const term = db.prepare(`SELECT id FROM student_semesters WHERE student_id = ? AND semester_name = 'FS1 Term'`).get(sid) as { id: string };
    const tinv = db.prepare(`SELECT id, net_amount FROM invoices WHERE student_id = ? AND purpose = 'tuition'`).get(sid) as { id: string; net_amount: number };

    // Desk collects 2000 of the 5000 term.
    const desk = await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .send({ amount: 2000, category: 'fee', semesterId: term.id, method: 'cash' });
    expect(desk.status).toBe(201);

    // The desk refuses 3001 (only 3000 outstanding) — the control.
    const ctl = await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .send({ amount: 3001, category: 'fee', semesterId: term.id, method: 'cash' });
    expect(ctl.status).toBe(400);

    // ATTACK: pay the invoice's FULL remaining 5000 although the term owes 3000.
    const attack = await supertest(app).post(`/api/invoices/${tinv.id}/pay`).set(auth())
      .send({ amount: 5000, paymentMethod: 'cash' });
    expect(attack.status).toBe(400);
    expect(String(attack.body.error)).toContain('term outstanding: 3000');

    // What IS still owed can be collected through the invoice.
    const ok = await supertest(app).post(`/api/invoices/${tinv.id}/pay`).set(auth())
      .send({ amount: 3000, paymentMethod: 'cash' });
    expect([200, 201]).toContain(ok.status);

    const obligation = ensureTuitionObligation(db, term.id);
    const position = getObligationPosition(db, obligation.id);
    expect(position.settled).toBe(5000);
    expect(position.outstanding).toBe(0);
    // No phantom credit: paid can never exceed due now.
    expect(position.settledCash).toBeLessThanOrEqual(position.obligation.netAmount);
  });
});

describe('FS-2 — a refund re-opens the invoice money it returned', () => {
  it('carries the invoice linkage, reopens the invoice status and re-arms the enrollment gate', async () => {
    const sid = await newStudent('FS2 Refund Visibility');
    // Registration invoice of the default rule is 0 — issue a real one by hand
    // through the same writer the desk uses (extra class invoice is 'other';
    // registration path here): direct document with the registration kind.
    const invId = 'fsx_inv_fs2';
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, charge_kind, purpose)
       VALUES (?, ?, 2000, 0, 2000, 'issued', '2026-09-05', '2026-09-19', ?, 'FS2 fixture', 'FS2-INV-1', 'fsx', 'registration', 'other')`,
    ).run(invId, sid, BRANCH);
    db.prepare(`INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES ('fsx_ii_fs2', ?, 'Registration', 1, 2000, 2000)`).run(invId);

    const pay = await supertest(app).post(`/api/invoices/${invId}/pay`).set(auth()).send({ amount: 2000, paymentMethod: 'cash' });
    expect([200, 201]).toContain(pay.status);
    expect(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invId)).toMatchObject({ status: 'paid' });

    const paymentId = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(invId) as { id: string };
    const refund = await supertest(app).post(`/api/students/${sid}/refund`).set(auth())
      .send({ paymentId: paymentId.id, amount: 2000, reason: 'FS2 drill: full refund of registration' });
    expect(refund.status).toBe(201);

    // The refund row names the invoice it reversed.
    const byTarget = db.prepare(`SELECT invoice_id FROM payments WHERE refunds_payment_id = ?`).get(paymentId.id) as { invoice_id: string | null };
    expect(byTarget.invoice_id).toBe(invId);

    // The invoice itself re-opened.
    expect(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invId)).toMatchObject({ status: 'issued' });

    // The invoice-backed balance counts the refund: 2000 due, 0 paid.
    const summary = getStudentNonTuitionSummary(db, sid, ['registration']);
    expect(summary.nonTuitionDue).toBe(2000);
    expect(summary.nonTuitionPaid).toBe(0);
    expect(summary.nonTuitionOutstanding).toBe(2000);
  });
});

describe('FS-4 — exam cash is a payment with a receipt', () => {
  it('writes a payments row and links the income row to it', async () => {
    const sid = await newStudent('FS4 Exam Fee');
    const res = await supertest(app).post(`/api/exams/${EXAM}/enroll`).set(auth())
      .send({ studentId: sid, feePaid: true });
    expect(res.status).toBe(201);
    expect(typeof res.body.receiptNumber).toBe('string');
    const payment = db.prepare(`SELECT id, amount, category, receipt_number FROM payments WHERE student_id = ? AND category = 'exam'`).get(sid) as { id: string; amount: number; receipt_number: string };
    expect(payment.amount).toBe(500);
    expect(payment.receipt_number).toMatch(/^R-/);
    const ledger = db.prepare(`SELECT amount, payment_id FROM financial_transactions WHERE payment_id = ?`).get(payment.id) as { amount: number; payment_id: string };
    expect(ledger.amount).toBe(500);
  });
});

describe('FS-5 — the obligation engine caps allocations at the cash they allocate', () => {
  it('refuses to allocate more than the payment holds, across obligations too', () => {
    const sid = 'stu_fsx_engine';
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'FSX-ENG', 'FS Engine', 'active', '2026-09-05', ?, 'male')`,
    ).run(sid, BRANCH);
    const termA = 'fsx_sem_a';
    const termB = 'fsx_sem_b';
    const ins = db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, ?, ?, ?, '2026-09-05', 5000, 5000, 'active')`);
    ins.run(termA, sid, 'FS5 A', CLASS_B);
    ins.run(termB, sid, 'FS5 B', CLASS_B);
    const payId = 'fsx_pay_engine';
    db.prepare(
      `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
       VALUES (?, ?, 3000, '2026-09-05', 'cash', 'completed', 'other', 'R-FSX-1', ?, 'fsx-engine-fixture')`,
    ).run(payId, sid, BRANCH);

    const oblA = ensureTuitionObligation(db, termA);
    const oblB = ensureTuitionObligation(db, termB);

    // Allocating beyond the payment itself: refused by the ENGINE.
    expect(() =>
      db.transaction(() => allocatePaymentToObligation(db, { paymentId: payId, obligationId: oblA.id, amount: 4000 }))(),
    ).toThrowError(/unallocated/);

    // Splitting one payment across two obligations is fine up to its amount…
    db.transaction(() => allocatePaymentToObligation(db, { paymentId: payId, obligationId: oblA.id, amount: 2000 }))();
    db.transaction(() => allocatePaymentToObligation(db, { paymentId: payId, obligationId: oblB.id, amount: 1000 }))();
    // …and the third afghani past the payment is refused.
    expect(() =>
      db.transaction(() => allocatePaymentToObligation(db, { paymentId: payId, obligationId: oblB.id, amount: 1 }))(),
    ).toThrowError(/unallocated/);
  });
});

describe('FS-6 — aid settlement re-prices the invoices billing the term', () => {
  it('cancels the unpaid tuition invoice and reissues the residual after a scholarship allocation', async () => {
    const sid = await newStudent('FS6 Aid Reprice');
    await settleRegistration(sid);
    const j = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(auth())
      .send({ classId: CLASS_B, semesterName: 'FS6 Term', enrollmentType: 'new' });
    expect(j.status).toBe(201);
    const term = db.prepare(`SELECT id FROM student_semesters WHERE student_id = ? AND semester_name = 'FS6 Term'`).get(sid) as { id: string };
    const oldInvoice = db.prepare(`SELECT id, net_amount FROM invoices WHERE student_id = ? AND purpose = 'tuition'`).get(sid) as { id: string; net_amount: number };
    expect(oldInvoice.net_amount).toBe(5000);

    // Funding machinery: donor → donation → scholarship → award.
    const donorId = 'fsx_donor_1';
    db.prepare(`INSERT INTO donors (id, full_name) VALUES (?, 'FSX Donor')`).run(donorId);
    const donationId = 'fsx_don_1';
    seedLinkedDonation(db, { id: donationId, donorId, amount: 10000, date: '2026-09-05', receiptNo: 'DON-FSX-1', branchId: BRANCH });
    const scholarshipId = 'fsx_sch_1';
    db.prepare(`INSERT INTO scholarships (id, name, branch_id) VALUES (?, 'FSX Scholarship', ?)`).run(scholarshipId, BRANCH);
    const fundingId = 'fsx_schf_1';
    db.prepare(
      `INSERT INTO scholarship_fundings (id, scholarship_id, donation_id, amount, branch_id, date)
       VALUES (?, ?, ?, 10000, ?, '2026-09-05')`,
    ).run(fundingId, scholarshipId, donationId, BRANCH);
    const awardId = 'fsx_award_1';
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, status, branch_id, award_date)
       VALUES (?, ?, ?, 5000, 'active', ?, '2026-09-05')`,
    ).run(awardId, scholarshipId, sid, BRANCH);

    const obligation = ensureTuitionObligation(db, term.id);
    const alloc = await supertest(app).post(`/api/funding/scholarship-awards/${awardId}/allocations`).set(auth())
      .send({ obligationId: obligation.id, scholarshipFundingId: fundingId, amount: 3000 });
    expect(alloc.status).toBe(201);

    // The original invoice is cancelled…
    expect(db.prepare('SELECT status FROM invoices WHERE id = ?').get(oldInvoice.id)).toMatchObject({ status: 'cancelled' });
    // …and one replacement invoices exactly the residual 2000.
    const reissued = db.prepare(`SELECT net_amount, status FROM invoices WHERE student_id = ? AND purpose = 'tuition' AND status <> 'cancelled'`).get(sid) as { net_amount: number; status: string };
    expect(reissued.net_amount).toBe(2000);
    expect(reissued.status).toBe('issued');

    // Paying the residual through the invoice works; the term settles exactly.
    const pay = await supertest(app).post(`/api/invoices/${db.prepare(`SELECT id FROM invoices WHERE student_id = ? AND purpose = 'tuition' AND status <> 'cancelled'`).get(sid)!.id}/pay`).set(auth())
      .send({ amount: 2000, paymentMethod: 'cash' });
    expect([200, 201]).toContain(pay.status);
    const position = getObligationPosition(db, obligation.id);
    expect(position.settled).toBe(5000);
    expect(position.outstanding).toBe(0);
  });
});

describe('FS-7 — employee payroll has a due authority', () => {
  it('refuses a full payment that is not the remaining salary of the period', async () => {
    const empId = 'fsx_emp_1';
    db.prepare(
      `INSERT INTO employees (id, full_name, role, base_salary, status, branch_id, joined_date)
       VALUES (?, 'FSX Employee', 'receptionist', 8000, 'active', ?, '2026-01-01')`,
    ).run(empId, BRANCH);
    const res = await supertest(app).post(`/api/employees/${empId}/pay-salary`).set(auth())
      .send({ monthName: '1405-06', amountPaid: 50000, paymentType: 'full' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/remaining salary of 8000/);
  });
});

describe('FS-8 — the academic hold is lifetime-scoped and covers every enrollment surface', () => {
  it('debt on a NON-active term still blocks a new term for a registrar; override roles may proceed', async () => {
    const sid = await newStudent('FS8 Debtor');
    await settleRegistration(sid);
    const enroll = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(regAuth())
      .send({ classId: CLASS_A, semesterName: 'FS8 Term', enrollmentType: 'new' });
    expect(enroll.status).toBe(201);

    // Move the term out of 'active' the way a drop does. An active-scoped hold
    // would see zero debt after this — the exact bypass the lifetime scope
    // exists to close.
    db.prepare(`UPDATE student_semesters SET status = 'deferred' WHERE student_id = ? AND semester_name = 'FS8 Term'`).run(sid);

    const blocked = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(regAuth())
      .send({ classId: CLASS_B, semesterName: 'FS8 Fresh Term', enrollmentType: 'new' });
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toMatch(/Academic Hold/i);

    // Override roles keep their judgement call.
    const overridden = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(auth())
      .send({ classId: CLASS_B, semesterName: 'FS8 Fresh Term', enrollmentType: 'new' });
    expect(overridden.status).toBe(201);
  });

  it('re-entering a term the student already holds is never held (the resume exception)', async () => {
    const sid = await newStudent('FS8 Resume');
    await settleRegistration(sid);
    await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(regAuth())
      .send({ classId: CLASS_A, semesterName: 'FS8R Term', enrollmentType: 'new' }).expect(201);
    // Mimic a drop: the enrollment closes and its term projection defers.
    db.prepare(`UPDATE enrollments SET status = 'dropped' WHERE student_id = ? AND class_id = ?`).run(sid, CLASS_A);
    db.prepare(`UPDATE student_semesters SET status = 'deferred' WHERE student_id = ? AND semester_name = 'FS8R Term'`).run(sid);

    // Same class + same term name: this RE-OPENS the held term rather than
    // consuming a new seat, so the unpaid debt on it must not block resumption.
    const resumed = await supertest(app).post(`/api/students/${sid}/journey/enrollments`).set(regAuth())
      .send({ classId: CLASS_A, semesterName: 'FS8R Term', enrollmentType: 'new' });
    expect(resumed.status).toBe(201);
    const rows = db.prepare(`SELECT status FROM student_semesters WHERE student_id = ? AND semester_name = 'FS8R Term'`).all(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });
});
