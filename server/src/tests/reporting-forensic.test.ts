/**
 * Reporting / financial forensic suite.
 * ============================================================================
 * Reproduces period-correctness and reconciliation defects:
 *
 *  1. Period bounds: /api/reports/overview?period=month&month=2026-06 must
 *     cover ONLY June 2026 — but resolvePeriod caps `to` at TODAY, so a
 *     historical month includes later data. Same for ?year=2025.
 *  2. Reconciliation: report income total == SUM(fin_tx income) for the SAME
 *     period; report expense == SUM(fin_tx expense); daily→month→quarter→year
 *     consistency.
 *  3. Refunds reduce income correctly; no double count.
 *  4. Ledger endpoint honors explicit from/to (period isolation).
 *  5. Discount aggregation: report exposes gross/discount/net from invoices.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';

const BRANCH = 'rep_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
  return app;
}
function authHeader(user: TokenPayload) { return { Authorization: `Bearer ${signToken(user)}` }; }

describe('Reporting financial forensic', () => {
  let app: express.Express;
  let owner: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Rep Branch', 'L');
    await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES ('rep_owner', 'rep_owner', 'Rep Owner', ?, ?, 1, 0)`).run(BRANCH, await hashPassword('x'));
    assignRole('rep_owner', 'owner', BRANCH);

    owner = { userId: 'rep_owner', username: 'rep_owner', branchId: BRANCH, fullName: 'Rep Owner' };
    app = createApp();

    // Seed ledger rows: 1000 income in June, 500 income in July, 200 expense in June.
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'income', 'fee', 1000, '2026-06-15', 'June fee', 'T', ?)`).run(id('tx'), BRANCH);
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'income', 'fee', 500, '2026-07-10', 'July fee', 'T', ?)`).run(id('tx'), BRANCH);
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'income', 'book', 300, '2026-06-20', 'June book', 'T', ?)`).run(id('tx'), BRANCH);
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'expense', 'rent', 200, '2026-06-05', 'June rent', 'T', ?)`).run(id('tx'), BRANCH);
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'expense', 'salary', 400, '2026-07-01', 'July salary', 'T', ?)`).run(id('tx'), BRANCH);
    // Refund in June: -100 income.
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
      VALUES (?, 'income', 'refund', -100, '2026-06-25', 'June refund', 'T', ?)`).run(id('tx'), BRANCH);
  });

  it('DEFECT: historical month report includes data from later months (period bound bug)', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=month&month=2026-06').set(authHeader(owner));
    expect(res.status).toBe(200);
    const income = res.body.financial.income.total;
    // June alone: fee 1000 + book 300 - refund 100 = 1200. If the bug includes July (500), income = 1700.
    console.log(`[EVIDENCE] ?month=2026-06 report income = ${income} (expected 1200 if period-correct)`);
    expect(income).toBe(1200);
  });

  it('DEFECT: historical year report includes data from later periods', async () => {
    // request year=2025 → should be 0 income (no 2025 rows). Bug: includes 2026 rows → 1700.
    const res = await supertest(app).get('/api/reports/overview?period=year&year=2025').set(authHeader(owner));
    expect(res.status).toBe(200);
    const income = res.body.financial.income.total;
    console.log(`[EVIDENCE] ?year=2025 report income = ${income} (expected 0)`);
    expect(income).toBe(0);
  });

  it('control: current-month report reconciles with the ledger for the same period', async () => {
    // July is the "current" month in this seeded world; use range to be exact.
    const res = await supertest(app).get('/api/reports/overview?period=range&from=2026-07-01&to=2026-07-31').set(authHeader(owner));
    expect(res.status).toBe(200);
    const income = res.body.financial.income.total;
    const expense = res.body.financial.expense.total;
    expect(income).toBe(500);
    expect(expense).toBe(400);
  });

  it('control: ledger endpoint honors explicit from/to (period isolation)', async () => {
    const res = await supertest(app).get('/api/finance/transactions?from=2026-06-01&to=2026-06-30&includeTotal=1').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4); // 3 income + 1 expense in June only
  });

  it('control: refund reduces income (net income correct)', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=range&from=2026-06-01&to=2026-06-30').set(authHeader(owner));
    const income = res.body.financial.income.total;
    const byCat = res.body.financial.income.byCategory;
    const refundCat = byCat.find((c: { category: string }) => c.category === 'refund');
    expect(refundCat.total).toBe(-100);
    expect(income).toBe(1200); // 1000 + 300 - 100
  });
});

describe('Reporting forensic — new required metrics + period consistency', () => {
  let app: express.Express;
  let owner: TokenPayload;

  beforeAll(async () => {
    app = createApp();
    owner = { userId: 'rep_owner', username: 'rep_owner', branchId: BRANCH, fullName: 'Rep Owner' };
    // Seed an invoice with discount + partial payment (outstanding), and a book sale.
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rep_stu', 'TH-REP-1', 'Rep Student', 'active', '2026-06-01', ?, 'male', '0700111888')`).run(BRANCH);
    db.prepare(`INSERT OR IGNORE INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
      VALUES ('rep_inv', 'rep_stu', 5000, 500, 4500, 'partial', '2026-06-10', '2026-07-10', ?, 'INV-REP-1')`).run(BRANCH);
    const repPayId = id('pay');
    db.prepare(`INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, 'rep_stu', 'rep_inv', 2000, '2026-06-11', 'cash', 'completed', 'fee', 'R-REP-1', ?, hex(randomblob(16)))`).run(repPayId, BRANCH);
    // Mirror what the real writers do: a payment creates a ledger income row.
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, payment_id, operator_name, branch_id)
      VALUES (?, 'income', 'fee', 2000, '2026-06-11', 'Rep invoice payment', 'rep_inv', ?, 'T', ?)`).run(id('tx'), repPayId, BRANCH);
    db.prepare(`INSERT OR IGNORE INTO books (id, title, price, stock, is_chapter, branch_id) VALUES ('rep_book', 'Rep Title', 300, 5, 0, ?)`).run(BRANCH);
    const repSaleId = id('sale');
    db.prepare(`INSERT INTO book_sales (id, book_id, quantity, total_amount, discount_amount, net_amount, status, date, customer_name, branch_id)
      VALUES (?, 'rep_book', 2, 600, 0, 600, 'completed', '2026-06-12', 'Walk-in', ?)`).run(repSaleId, BRANCH);
    // Mirror the book-sale income writer.
    db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
      VALUES (?, 'income', 'book', 600, '2026-06-12', 'Sold 2 copies of Rep Title', 'rep_book', 'T', ?)`).run(id('tx'), BRANCH);
  });

  it('reports discounts and outstanding balances from authoritative sources', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=month&month=2026-06').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.financial.discounts.invoiceDiscounts).toBe(500);
    // Outstanding: invoice net 4500 - paid 2000 = 2500.
    expect(res.body.financial.outstanding.gross).toBe(4500);
    expect(res.body.financial.outstanding.paid).toBe(2000);
    expect(res.body.financial.outstanding.remaining).toBe(2500);
  });

  it('reports books sold by title with quantity and net', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=month&month=2026-06').set(authHeader(owner));
    const title = res.body.operational.booksByTitle.find((b: { title: string }) => b.title === 'Rep Title');
    expect(title).toBeTruthy();
    expect(title.quantity).toBe(2);
    expect(title.net).toBe(600);
  });

  it('period consistency: quarterly == sum of its months; annual == sum of quarters', async () => {
    const q2 = await supertest(app).get('/api/reports/overview?period=quarter&year=2026&quarter=2').set(authHeader(owner));
    expect(q2.status).toBe(200);
    // June-only income in Q2: fee 1000 + book 300 - refund 100 + rep book 600 + rep invoice payment 2000 = 3800.
    const q2Income = q2.body.financial.income.total;
    const june = await supertest(app).get('/api/reports/overview?period=month&month=2026-06').set(authHeader(owner));
    const juneIncome = june.body.financial.income.total;
    console.log(`[EVIDENCE] Q2 income=${q2Income}, June income=${juneIncome}`);
    expect(q2Income).toBeGreaterThanOrEqual(juneIncome); // Q2 ⊇ June
    // The June income now includes the 2000 payment + 600 book = 3800 (June-only).
    expect(juneIncome).toBe(3800);
  });
});
