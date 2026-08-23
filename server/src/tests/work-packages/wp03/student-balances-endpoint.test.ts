/**
 * Server-aggregated student balances (group F12)
 * ============================================================================
 * S19 — the roster reported paid students as owing their full fee.
 *
 * `StudentsView` derived every student's paid/owed figure by reducing the
 * `payments` array the client had loaded. That array is ONE PAGE: the endpoint
 * caps at 2,000 rows. Proven live with 2,000 students holding 6,000 payments —
 * two thirds never reached the browser, and a student who had genuinely paid
 * 8,636 AFN was displayed as having paid 0 and owing the entire fee.
 *
 * This is a correctness defect wearing a performance costume: it was also
 * 379 KB of payload transferred purely to compute a handful of numbers.
 *
 * GET /payments/balances aggregates in SQL over ALL payments, using the same
 * authoritative rule as utils/studentBalance: fee + installment + refund, with
 * refunds stored signed-negative.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { paymentsRouter } from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { getStudentBalance } from '../../../utils/studentBalance.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'bal_ep_branch';
const OTHER = 'bal_ep_other';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  app.use(errorHandler);
  return app;
}
const user = (): TokenPayload => ({
  userId: 'u_bal_ep', username: 'bal_ep', branchId: BRANCH, fullName: 'Bal Mgr',
});
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  const d = today();

  db.prepare(`DELETE FROM payments WHERE id LIKE 'balep_%' AND category = 'refund'`).run();
  db.prepare(`DELETE FROM payments WHERE id LIKE 'balep_%'`).run();
  db.prepare(`DELETE FROM student_semesters WHERE id LIKE 'balep_%'`).run();
  db.prepare(`DELETE FROM students WHERE id LIKE 'balep_%'`).run();

  for (const b of [BRANCH, OTHER]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(b, b);
  }
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('u_bal_ep', 'bal_ep', 'Bal Mgr', ?, ?, 1, 0)`,
  ).run(BRANCH, pw);
  assignRole('u_bal_ep', 'manager', BRANCH);

  const mkStudent = (n: number, branch = BRANCH) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
         VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
      )
      .run(`balep_s${n}`, `BEP-${n}`, `Bal Student ${n}`, `0700${String(n).padStart(6, '0')}`, d, branch);

  const mkSemester = (n: number, net: number) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
         VALUES (?, ?, 'Term', ?, ?, ?, 'active')`,
      )
      .run(`balep_sem${n}`, `balep_s${n}`, d, net, net);

  // A refund names the payment it reverses (owner decision D-113).
  const mkPayment = (id: string, n: number, amount: number, category: string, reverses: string | null = null) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key, refunds_payment_id)
         VALUES (?, ?, ?, ?, 'cash', 'completed', ?, ?, ?, hex(randomblob(16)), ?)`,
      )
      .run(id, `balep_s${n}`, amount, d, category, `RC-${id}`, BRANCH, reverses);

  // 1: owes 13,000, paid 10,000 fee + 3,000 installment, refunded 2,000 => owes 2,000
  mkStudent(1); mkSemester(1, 13000);
  mkPayment('balep_p1a', 1, 10000, 'fee');
  mkPayment('balep_p1b', 1, 3000, 'installment');
  mkPayment('balep_p1c', 1, -2000, 'refund', 'balep_p1a');

  // 2: owes 8,000, paid a 1,500 chapter charge (not tuition) => owes 8,000
  mkStudent(2); mkSemester(2, 8000);
  mkPayment('balep_p2a', 2, 1500, 'chapter');

  // 3: overpaid — owes 5,000, paid 6,000 => credit 1,000, outstanding 0
  mkStudent(3); mkSemester(3, 5000);
  mkPayment('balep_p3a', 3, 6000, 'fee');

  // 4: another branch entirely
  mkStudent(4, OTHER); mkSemester(4, 9000);

  app = createApp();
});

describe('S19: balances are aggregated server-side over ALL payments', () => {
  it('returns one row per student with the authoritative arithmetic', async () => {
    const res = await supertest(app).get('/api/payments/balances').set(auth());
    expect(res.status).toBe(200);

    const byId = new Map<string, any>(res.body.map((r: any) => [r.studentId, r]));

    const s1 = byId.get('balep_s1');
    expect(s1.tuitionDue).toBe(13000);
    expect(s1.tuitionPaid).toBe(11000); // refund subtracts
    expect(s1.outstanding).toBe(2000);

    const s2 = byId.get('balep_s2');
    expect(s2.tuitionPaid).toBe(0); // a ad-hoc chapter charge is not tuition
    expect(s2.outstanding).toBe(8000);
  });

  it('an overpayment yields a credit balance, never negative outstanding', async () => {
    const res = await supertest(app).get('/api/payments/balances').set(auth());
    const s3 = res.body.find((r: any) => r.studentId === 'balep_s3');
    expect(s3.outstanding).toBe(0);
    expect(s3.creditBalance).toBe(1000);
  });

  it('agrees exactly with getStudentBalance, the shared definition', async () => {
    const res = await supertest(app).get('/api/payments/balances').set(auth());
    for (const row of res.body) {
      const direct = getStudentBalance(db, row.studentId, 'active');
      expect(row.tuitionPaid, row.studentId).toBe(direct.tuitionPaid);
      expect(row.outstanding, row.studentId).toBe(direct.outstanding);
    }
  });

  it('scopes to the caller branch', async () => {
    const res = await supertest(app).get('/api/payments/balances').set(auth());
    const ids = res.body.map((r: any) => r.studentId);
    expect(ids).toContain('balep_s1');
    expect(ids).not.toContain('balep_s4');
  });

  it('is unaffected by the payments page cap — the defect that caused S19', async () => {
    // Push this student's payments far beyond any page boundary by adding many
    // rows for OTHER students first. A client-side reduce over one page would
    // miss them; a SQL aggregate cannot.
    const d = today();
    for (let i = 100; i < 400; i++) {
      db.prepare(
        `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
         VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
      ).run(`balep_s${i}`, `BEP-${i}`, `Filler ${i}`, `0701${String(i).padStart(6, '0')}`, d, BRANCH);
      db.prepare(
        `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
         VALUES (?, ?, 500, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`,
      ).run(`balep_fill${i}`, `balep_s${i}`, d, `RC-F${i}`, BRANCH);
    }

    const res = await supertest(app).get('/api/payments/balances').set(auth());
    const s1 = res.body.find((r: any) => r.studentId === 'balep_s1');
    // Still exact despite hundreds of intervening payment rows.
    expect(s1.tuitionPaid).toBe(11000);
    expect(s1.outstanding).toBe(2000);
    expect(res.body.length).toBeGreaterThan(300);
  });

  it('requires authentication', async () => {
    const res = await supertest(app).get('/api/payments/balances');
    expect([401, 403]).toContain(res.status);
  });
});
