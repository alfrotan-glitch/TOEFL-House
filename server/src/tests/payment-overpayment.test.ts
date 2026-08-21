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
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'overpay_branch';
let app: express.Express;
let seq = 0;

function user(): TokenPayload {
  return { userId: 'u_overpay', username: 'overpay_mgr', branchId: BRANCH, fullName: 'Overpay Mgr' };
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
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_overpay', 'overpay_mgr', 'Overpay Mgr', BRANCH, await hashPassword('x'));
  assignRole('u_overpay', 'manager', BRANCH);

  app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/invoices', invoicesRouter);
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

/**
 * The same defect class, found by searching for `Math.min(...)` applied to
 * money rather than by another bug report. An excessive DISCOUNT was capped to
 * the total, so a mistyped 99,999 on a 5,000 invoice silently became a 100%
 * discount (net 0) and reported success — wiping a real obligation.
 */
describe('discounts cannot exceed the amount they discount', () => {
  it('rejects an invoice discount larger than the invoice total', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post('/api/invoices').set(auth()).send({
      studentId,
      purpose: 'other',
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 5000 }],
      discountAmount: 99999,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/discount cannot exceed/i);
  });

  it('still accepts a legitimate partial discount', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post('/api/invoices').set(auth()).send({
      studentId,
      purpose: 'other',
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 5000 }],
      discountAmount: 500,
    });
    expect(res.status).toBe(201);
    expect(res.body.discountAmount).toBe(500);
    expect(res.body.netAmount).toBe(4500);
  });
});

/**
 * Ad-hoc charges ('other' / 'exam' / 'chapter') — the STOP CONDITION.
 *
 * An audit of real usage settled the question these categories raised. They
 * are DELIBERATELY not backed by a pre-created obligation: "Other Fee" is an
 * operator-selectable option in the payment dialog, and the desk uses it for
 * things the catalogue does not model (an exam re-sit, a replacement
 * handout). Blocking them would have broken a legitimate workflow, so the
 * capability is preserved.
 *
 * But with no obligation to validate the amount against, the REASON is the
 * only control. Previously the ledger recorded these as the default
 * "Smart Payment", so an auditor reviewing an unexplained 7,777 AFN charge had
 * nothing to review. These tests fix the semantics in place:
 *
 *   - the amount is recorded exactly as entered, never capped or adjusted;
 *   - a substantive reason is mandatory;
 *   - the reason reaches the ledger, not just the payment row.
 */
describe('ad-hoc charges are unbacked by design but must be explained', () => {
  it('rejects an ad-hoc charge with no reason', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 7777, category: 'other', paymentMethod: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason is required/i);

    const rows = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE student_id = ?').get(studentId) as { c: number };
    expect(rows.c).toBe(0);
  });

  it('rejects a token reason that explains nothing', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 500, category: 'other', paymentMethod: 'cash', notes: 'ab' });
    expect(res.status).toBe(400);
  });

  it('accepts an explained ad-hoc charge and records the amount EXACTLY', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 7777, category: 'other', paymentMethod: 'cash', notes: 'Exam re-sit fee' });

    expect(res.status).toBe(201);
    // No obligation exists, so there is nothing to cap against — and nothing
    // may be substituted for what the operator entered.
    expect(res.body.amountCharged).toBe(7777);

    const pay = db.prepare(
      `SELECT amount, notes FROM payments WHERE student_id = ? AND category = 'other'`
    ).get(studentId) as { amount: number; notes: string };
    expect(pay.amount).toBe(7777);
    expect(pay.notes).toBe('Exam re-sit fee');
  });

  it('carries the reason into the financial ledger, not just the payment row', async () => {
    const studentId = await newStudent();
    await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 1200, category: 'other', paymentMethod: 'cash', notes: 'Replacement handout' });

    const ledger = db.prepare(
      `SELECT description, amount FROM financial_transactions
        WHERE reference_id = ? AND type = 'income' AND category = 'other'`
    ).get(studentId) as { description: string; amount: number };

    // The regression: this used to read "Received other payment from X",
    // leaving an unexplained amount in the ledger.
    expect(ledger.amount).toBe(1200);
    expect(ledger.description).toContain('Replacement handout');
    expect(ledger.description).not.toBe(`Received other payment from `);
  });
});

/**
 * The third instance of the same class, found by the cross-cutting sweep for
 * Math.min/Math.max applied to money. `enroll()` floored the net at zero via
 * `Math.max(0, total - discount)`, and journey.routes passes discountAmount
 * straight from the request body — so an API client could enrol with a
 * 9,999,999 discount on a 5,000 fee and receive a fully-discounted invoice.
 *
 * Guarded at the service boundary rather than in each route, because that is
 * the single point every enrolment caller converges on.
 */
/** A level carrying a real fee, so the invoice branch under test is reached. */
function ensurePaidLevel(): string {
  const existing = db.prepare('SELECT id FROM levels WHERE default_fee > 0 LIMIT 1').get() as { id: string } | undefined;
  if (existing) return existing.id;
  db.prepare(`INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES ('prog_overpay', 'Overpay Program', 'OP', ?)`).run(BRANCH);
  db.prepare(
    `INSERT INTO levels (id, program_id, name, code, "order", default_fee)
     VALUES ('lvl_overpay', 'prog_overpay', 'Overpay Level', 'OL', 1, 5000)`
  ).run();
  return 'lvl_overpay';
}

describe('enrolment discount cannot exceed the enrolment fee', () => {
  it('rejects a discount larger than the fee', async () => {
    const { getEnrollmentService } = await import('../core/academic/enrollment-service.js');
    const studentId = await newStudent();
    const levelId = ensurePaidLevel();

    expect(() => getEnrollmentService(db).enroll({
      studentId, branchId: BRANCH, semesterName: 'Guarded', levelId,
      enrollmentType: 'new', actorUserId: 'u_overpay', actorName: 'Overpay Mgr',
      autoInvoice: true, discountAmount: 9_999_999,
    } as never)).toThrow(/discount cannot exceed/i);
  });

  it('still allows a legitimate partial discount', async () => {
    const { getEnrollmentService } = await import('../core/academic/enrollment-service.js');
    const studentId = await newStudent();
    const levelId = ensurePaidLevel();

    const res = getEnrollmentService(db).enroll({
      studentId, branchId: BRANCH, semesterName: 'Discounted', levelId,
      enrollmentType: 'new', actorUserId: 'u_overpay', actorName: 'Overpay Mgr',
      autoInvoice: true, discountAmount: 500,
    } as never) as { invoiceId: string | null };

    expect(res.invoiceId).toBeTruthy();
    const inv = db.prepare('SELECT total_amount, discount_amount, net_amount FROM invoices WHERE id = ?')
      .get(res.invoiceId) as { total_amount: number; discount_amount: number; net_amount: number };
    expect(inv.discount_amount).toBe(500);
    expect(inv.net_amount).toBe(inv.total_amount - 500);
  });
});

/**
 * Fourth instance of the silent-substitution class, found in the final
 * hardening pass by probing negative values on every money endpoint:
 *
 *   POST /invoices  items: [{ quantity: -3, unitPrice: 500 }]
 *     -> 201, invoice line quantity 1, total 500
 *
 * An invalid quantity fell back to 1, so a real invoice line appeared for a
 * charge the operator never entered. Rejected now, like the capped payment,
 * the capped discount and the capped enrolment discount before it.
 */
describe('invoice line quantities are validated, not coerced', () => {
  it('rejects a negative quantity instead of substituting 1', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post('/api/invoices').set(auth())
      .send({ studentId, purpose: 'other', items: [{ description: 'Tuition', quantity: -3, unitPrice: 500 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/quantity/i);
    const count = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE student_id = ?').get(studentId) as { c: number };
    expect(count.c).toBe(0);
  });

  it('rejects a fractional quantity', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post('/api/invoices').set(auth())
      .send({ studentId, purpose: 'other', items: [{ description: 'Tuition', quantity: 1.5, unitPrice: 500 }] });
    expect(res.status).toBe(400);
  });

  it('still accepts a valid multi-unit line and prices it correctly', async () => {
    const studentId = await newStudent();
    const res = await supertest(app).post('/api/invoices').set(auth())
      .send({ studentId, purpose: 'books', items: [{ description: 'Books', quantity: 3, unitPrice: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(1500);
  });
});
