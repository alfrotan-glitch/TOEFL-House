/**
 * Payroll reversal and budget-floor integrity.
 * ============================================================================
 * TWO DEFECTS PROVEN LIVE (2026-08-16, second audit pass):
 *
 * F-2 HIGH — voiding a teacher salary INFLATED reported expense.
 *   The void wrote a POSITIVE `expense` row via a prepared statement whose SQL
 *   hard-codes `'expense'`. Voiding a 6,000 AFN payment moved reported salary
 *   expense from 15,000 to 21,000 instead of back to 9,000 — the P&L counted
 *   the payment twice and the reversal never subtracted. The budget line WAS
 *   restored correctly, which is exactly why the bug stayed invisible: every
 *   budget assertion passed while the profit-and-loss statement was wrong.
 *   Signed-negative contra entries are the convention everywhere else in this
 *   system (student refunds, book-sale refunds); payroll was the outlier.
 *
 * F-1 MEDIUM — budget_lines.current_amount had no floor.
 *   books.stock has non-negative triggers and finance_accounts has
 *   CHECK (>= 0), but a budget line could be driven to -998,999 by a direct
 *   UPDATE. Two of four application decrement sites guard with
 *   `AND current_amount >= ?`; two do not. Migration 065 puts the floor in the
 *   database so every writer is subject to it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'payroll_rev_branch';
const BUDGET_ID = 'budget_teacher_salary_payroll_rev';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use(errorHandler);
  return app;
}
const user = (): TokenPayload => ({
  userId: 'u_payroll_rev', username: 'payroll_rev', role: 'owner',
  branchId: BRANCH, fullName: 'Payroll Rev Owner',
});
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

let app: express.Express;
let seq = 0;

/** Total salary expense as the P&L computes it: a plain SUM over the ledger. */
function salaryExpense(): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions
      WHERE type = 'expense' AND category = 'salary' AND branch_id = ?`,
  ).get(BRANCH) as { total: number };
  return row.total;
}
const budgetBalance = () =>
  (db.prepare('SELECT current_amount AS c FROM budget_lines WHERE id = ?').get(BUDGET_ID) as { c: number }).c;

async function newTeacher(name: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/teachers').set(auth()).send({
    fullName: name, phone: `0755${String(100000 + seq).slice(-6)}`,
    email: `payroll.rev.${seq}@example.com`, baseSalary: 10_000,
    branchId: BRANCH, contractType: 'monthly', salaryType: 'fixed',
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Payroll Rev Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`,
  ).run('u_payroll_rev', 'payroll_rev', 'Payroll Rev Owner', BRANCH, await hashPassword('x'));
  db.prepare(
    `INSERT OR IGNORE INTO budget_lines (id, name, category_id, allocated_amount, current_amount, branch_id, payroll_target)
     VALUES (?, 'Teacher Salaries', 'sub_salaries_wages', 500000, 500000, ?, 'teacher')`,
  ).run(BUDGET_ID, BRANCH);
  syncLegacyUserRoles(db);
  app = createApp();
});

describe('voiding a salary payment reverses it in the ledger', () => {
  it('returns reported salary expense to its pre-payment total', async () => {
    const teacherId = await newTeacher('Void Ledger Teacher');
    const expenseBefore = salaryExpense();
    const budgetBefore = budgetBalance();

    const pay = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1405-05', amountPaid: 6000, paymentType: 'partial' });
    expect(pay.status).toBe(201);
    expect(salaryExpense()).toBe(expenseBefore + 6000);
    expect(budgetBalance()).toBe(budgetBefore - 6000);

    const ledger = db.prepare(
      `SELECT id FROM teacher_salary_ledger WHERE teacher_id = ? AND status = 'posted'`,
    ).get(teacherId) as { id: string };

    const voided = await supertest(app).post(`/api/teachers/${teacherId}/payroll/${ledger.id}/void`).set(auth())
      .send({ reason: 'regression test void reason' });
    expect(voided.status).toBe(200);

    // THE ASSERTION THAT FAILED BEFORE THE FIX: expense went to +6000, not back to 0.
    expect(salaryExpense()).toBe(expenseBefore);
    // The budget restore was always correct; it must stay correct.
    expect(budgetBalance()).toBe(budgetBefore);
  });

  it('writes the reversal as a NEGATIVE contra row, matching refunds elsewhere', async () => {
    const teacherId = await newTeacher('Contra Sign Teacher');
    await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1405-06', amountPaid: 2500, paymentType: 'partial' });
    const ledger = db.prepare(
      `SELECT id FROM teacher_salary_ledger WHERE teacher_id = ? AND status = 'posted'`,
    ).get(teacherId) as { id: string };
    await supertest(app).post(`/api/teachers/${teacherId}/payroll/${ledger.id}/void`).set(auth())
      .send({ reason: 'contra sign check reason' });

    const reversal = db.prepare(
      `SELECT amount, type FROM financial_transactions WHERE reference_id = ? AND description LIKE 'Voided%'`,
    ).get(ledger.id) as { amount: number; type: string };
    expect(reversal).toBeDefined();
    expect(reversal.type).toBe('expense');
    expect(reversal.amount).toBe(-2500);
  });

  it('a voided payment stops counting toward the period, so it can be re-paid', async () => {
    // Business behaviour that must be preserved: voiding frees the money up again.
    const teacherId = await newTeacher('Repay After Void');
    await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1405-07', amountPaid: 10000, paymentType: 'full' });
    const ledger = db.prepare(
      `SELECT id FROM teacher_salary_ledger WHERE teacher_id = ? AND status = 'posted'`,
    ).get(teacherId) as { id: string };
    await supertest(app).post(`/api/teachers/${teacherId}/payroll/${ledger.id}/void`).set(auth())
      .send({ reason: 'voided to allow correction' });

    const repay = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1405-07', amountPaid: 10000, paymentType: 'full' });
    expect(repay.status).toBe(201);
  });
});

describe('the schema itself releases a voided period', () => {
  it('uq_teacher_salary_full_period excludes voided rows', () => {
    // The application fix (sumPaidForPeriod filtering status) is not enough on
    // its own: the partial UNIQUE index also has to release the slot, or the
    // re-payment fails with "A record with this unique information already
    // exists" straight from SQLite. Both halves are required, so both are
    // pinned — this asserts the schema half directly.
    const idx = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_teacher_salary_full_period'`,
    ).get() as { sql: string } | undefined;
    expect(idx, 'uq_teacher_salary_full_period must exist').toBeDefined();
    expect(idx!.sql).toMatch(/payment_type\s*=\s*'full'/i);
    expect(idx!.sql, 'the index must not count voided rows').toMatch(/status\s*=\s*'posted'/i);
  });

  it('permits a NEW full payment after the previous one is voided, at the DB level', async () => {
    // Direct insert: two 'full' rows for one teacher+period are allowed only
    // because the first is voided. A live duplicate must still be rejected.
    const tid = await newTeacher('Index Probe Teacher');
    const insert = (id: string, status: string) =>
      db.prepare(
        `INSERT INTO teacher_salary_ledger
           (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, branch_id, operator_name, idempotency_key, status)
         VALUES (?, ?, '1499-01', '1499-01', 10000, 10000, 'full', ?, 'probe', ?, ?)`,
      ).run(id, tid, BRANCH, `idx-probe-${id}`, status);

    insert('tsl_idx_a', 'voided');
    expect(() => insert('tsl_idx_b', 'posted')).not.toThrow();
    // A second LIVE full payment for the same period must still be blocked.
    expect(() => insert('tsl_idx_c', 'posted')).toThrow(/UNIQUE/i);
  });
});

describe('payroll idempotency (F-4: un-keyed repeats double-paid teachers)', () => {
  it('6 concurrent un-keyed identical payments create exactly ONE ledger row and ONE expense row', async () => {
    // Before the fix payroll honoured an explicit Idempotency-Key and did
    // nothing at all without one: six concurrent identical 1,000 AFN partials
    // produced SIX ledger rows and six expense entries. Same defect class as
    // the student-payment hole, unfixed on this endpoint.
    const teacherId = await newTeacher('Payroll Idem Racer');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
          .send({ monthName: '1406-06', amountPaid: 1500, paymentType: 'partial' }),
      ),
    );
    for (const r of responses) expect(r.status).toBe(201);

    const ledger = db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(paid_amount),0) AS s FROM teacher_salary_ledger WHERE teacher_id = ?`,
    ).get(teacherId) as { c: number; s: number };
    const expense = db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM financial_transactions WHERE reference_id = ?`,
    ).get(teacherId) as { c: number; s: number };

    expect(ledger).toMatchObject({ c: 1, s: 1500 });
    // The ledger and the expense entry must not diverge.
    expect(expense).toMatchObject({ c: 1, s: 1500 });
  });

  it('always persists an idempotency key, so the unique index can arbitrate', async () => {
    const teacherId = await newTeacher('Payroll Key Persist');
    await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1406-09', amountPaid: 800, paymentType: 'partial' });
    const nulls = db.prepare(
      `SELECT COUNT(*) AS c FROM teacher_salary_ledger
        WHERE teacher_id = ? AND (idempotency_key IS NULL OR TRIM(idempotency_key) = '')`,
    ).get(teacherId) as { c: number };
    expect(nulls.c).toBe(0);
  });

  it('does NOT block genuinely different payments (counter-invariant)', async () => {
    const teacherId = await newTeacher('Payroll Distinct Amounts');
    const a = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1406-07', amountPaid: 2000, paymentType: 'partial' });
    const b = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1406-07', amountPaid: 3500, paymentType: 'partial' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const rows = db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(paid_amount),0) AS s FROM teacher_salary_ledger WHERE teacher_id = ?`,
    ).get(teacherId) as { c: number; s: number };
    expect(rows).toMatchObject({ c: 2, s: 5500 });
  });

  it('refuses one key reused across two different teachers', async () => {
    const one = await newTeacher('Payroll Key One');
    const two = await newTeacher('Payroll Key Two');
    const first = await supertest(app).post(`/api/teachers/${one}/pay-salary`).set(auth())
      .set('Idempotency-Key', 'payroll-shared').send({ monthName: '1406-10', amountPaid: 900, paymentType: 'partial' });
    expect(first.status).toBe(201);
    const second = await supertest(app).post(`/api/teachers/${two}/pay-salary`).set(auth())
      .set('Idempotency-Key', 'payroll-shared').send({ monthName: '1406-10', amountPaid: 900, paymentType: 'partial' });
    expect(second.status).toBe(409);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM teacher_salary_ledger WHERE teacher_id = ?`).get(two) as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe('budget lines cannot go negative', () => {
  it('the DATABASE rejects an overdraw, not just the application', () => {
    const before = budgetBalance();
    expect(() =>
      db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?')
        .run(before + 1, BUDGET_ID),
    ).toThrow(/cannot be negative/i);
    expect(budgetBalance()).toBe(before);
  });

  it('rejects inserting a budget line that is already negative', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO budget_lines (id, name, category_id, allocated_amount, current_amount, branch_id)
         VALUES ('bl_negative_probe', 'Negative', 'sub_miscellaneous', 0, -1, ?)`,
      ).run(BRANCH),
    ).toThrow(/cannot be negative/i);
  });

  it('a salary payment larger than the remaining budget is refused', async () => {
    const teacherId = await newTeacher('Budget Ceiling Teacher');
    db.prepare('UPDATE budget_lines SET current_amount = 1000 WHERE id = ?').run(BUDGET_ID);
    const res = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(auth())
      .send({ monthName: '1405-08', amountPaid: 5000, paymentType: 'partial' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(budgetBalance()).toBe(1000);
    db.prepare('UPDATE budget_lines SET current_amount = 500000 WHERE id = ?').run(BUDGET_ID);
  });
});
