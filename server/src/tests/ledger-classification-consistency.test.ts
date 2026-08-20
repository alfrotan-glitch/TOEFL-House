/**
 * Ledger classification — operating activity vs owner equity.
 * ============================================================================
 * `financial_transactions` stores two categories that are NOT trading activity:
 *
 *   income  / capital_injection    owner capital paid INTO the treasury
 *   expense / profit_distribution  owner drawings paid OUT of it
 *
 * Counting either as revenue or cost overstates the trading result — and in the
 * case of a capital injection, invents revenue that no student ever paid.
 *
 * `/reports/overview`, `/finance/pnl` and the reconciliation checker all knew
 * this. `/dashboard/summary` did not: its cash-flow series summed every income
 * and expense row. On a day with a 100,000 capital injection and a 50,000
 * drawing, the Dashboard rendered income 100,000 / expense 50,000 while the
 * other two surfaces reported 0 / 0 for the same day and branch. Verified live
 * against a running server before the fix.
 *
 * The existing dashboard tests could not catch this: they reconciled the chart
 * against `SUM(amount) WHERE type='income'`, which carries the identical
 * defect, and no fixture ever seeded a transfer category. Reconciling against a
 * query that shares the bug is not verification.
 *
 * These tests therefore assert CROSS-SURFACE AGREEMENT on data that contains
 * equity movements, which is the property that actually failed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { dashboardRouter } from '../routes/dashboard.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { buildDashboardSummary } from '../core/dashboard/dashboard-summary.js';
import {
  OPERATING_INCOME_SQL,
  OPERATING_EXPENSE_SQL,
  EQUITY_TRANSFER_SQL,
  isOperatingIncome,
  isOperatingExpense,
  isEquityTransfer,
} from '../core/finance/ledger-classification.js';
import { today } from '../utils/ids.js';

const BRANCH = 'lc_a';
const BRANCH_B = 'lc_b';
const TODAY = today();

let owner: TokenPayload;
let app: express.Express;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;
function tx(
  type: string,
  category: string,
  amount: number,
  branch = BRANCH,
  date = TODAY,
  financeCategoryId: string | null = null,
) {
  // Owner drawings are identified by their canonical taxonomy node, which is
  // what every surface classifies against.
  const node = financeCategoryId ?? (category === 'profit_distribution' ? 'sub_owner_drawings' : null);
  db.prepare(
    `INSERT INTO financial_transactions (id,type,category,finance_category_id,amount,date,description,branch_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(`lc_tx_${++seq}`, type, category, node, amount, date, `${category} fixture`, branch);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'LC A', 'T')`).run(BRANCH);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'LC B', 'T')`).run(BRANCH_B);
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password)
              VALUES ('lc_own','lc_own',?,'Owner','owner',?,0)`).run(pwd, BRANCH);
  syncLegacyUserRoles(db);
  owner = { userId: 'lc_own', username: 'lc_own', role: 'owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/dashboard', dashboardRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'lc_tx_%'`).run();
});

// ===========================================================================
// The rule itself
// ===========================================================================
describe('classification rule', () => {
  it('treats owner capital as neither income nor expense', () => {
    const row = { type: 'income', category: 'capital_injection' };
    expect(isOperatingIncome(row)).toBe(false);
    expect(isOperatingExpense(row)).toBe(false);
    expect(isEquityTransfer(row)).toBe(true);
  });

  it('treats owner drawings as neither income nor expense', () => {
    const row = { type: 'expense', category: 'owner_drawing', financeCategoryId: 'sub_owner_drawings' };
    expect(isOperatingExpense(row)).toBe(false);
    expect(isOperatingIncome(row)).toBe(false);
    expect(isEquityTransfer(row)).toBe(true);
  });

  it('treats ordinary fees and costs as operating activity', () => {
    expect(isOperatingIncome({ type: 'income', category: 'fee' })).toBe(true);
    expect(isOperatingExpense({ type: 'expense', category: 'salary' })).toBe(true);
    expect(isEquityTransfer({ type: 'income', category: 'fee' })).toBe(false);
  });

  /**
   * The predicates encode the TYPE as well as the category, so they cannot be
   * misapplied. A capital_injection row is only equity when it is income; an
   * expense row that happened to carry that category is still operating cost.
   */
  it('does not misclassify a category applied to the wrong type', () => {
    expect(isOperatingExpense({ type: 'expense', category: 'capital_injection' })).toBe(true);
    expect(isOperatingIncome({ type: 'income', category: 'profit_distribution' })).toBe(true);
  });

  it('the JS helpers and the SQL predicates agree', () => {
    const cases = [
      { type: 'income', category: 'fee' },
      { type: 'income', category: 'capital_injection' },
      { type: 'expense', category: 'salary' },
      { type: 'expense', category: 'owner_drawing', financeCategoryId: 'sub_owner_drawings' },
      { type: 'expense', category: 'capital_injection' },
      { type: 'income', category: 'profit_distribution' },
    ];
    for (const c of cases) {
      tx(c.type, c.category, 10, BRANCH, TODAY, (c as { financeCategoryId?: string }).financeCategoryId ?? null);
      const id = `lc_tx_${seq}`;
      const inSql = (sql: string) =>
        Number((db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE id=? AND ${sql}`).get(id) as any).c) === 1;
      expect(inSql(OPERATING_INCOME_SQL), `income ${JSON.stringify(c)}`).toBe(isOperatingIncome(c));
      expect(inSql(OPERATING_EXPENSE_SQL), `expense ${JSON.stringify(c)}`).toBe(isOperatingExpense(c));
      expect(inSql(EQUITY_TRANSFER_SQL), `equity ${JSON.stringify(c)}`).toBe(isEquityTransfer(c));
    }
  });
});

// ===========================================================================
// The defect that actually shipped
// ===========================================================================
describe('dashboard cash flow excludes owner equity movements', () => {
  beforeEach(() => {
    tx('income', 'fee', 6000);
    tx('income', 'capital_injection', 100000); // owner capital — NOT revenue
    tx('expense', 'salary', 2000);
    tx('expense', 'profit_distribution', 50000); // owner drawing — NOT cost
  });

  it('reports only trading activity', async () => {
    const res = await supertest(app).get('/api/dashboard/summary?days=1').set(authHeader(owner));
    expect(res.status).toBe(200);
    const row = res.body.cashFlow[res.body.cashFlow.length - 1];
    expect(row.date).toBe(TODAY);
    // Before the fix these were 106000 and 52000.
    expect(row.income).toBe(6000);
    expect(row.expense).toBe(2000);
  });

  it('a capital injection alone leaves the chart flat', async () => {
    db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'lc_tx_%'`).run();
    tx('income', 'capital_injection', 250000);
    const s = buildDashboardSummary(db, { branchId: BRANCH, isAll: false }, { days: 1 });
    expect(s.cashFlow[s.cashFlow.length - 1].income).toBe(0);
  });

  it('an owner drawing alone leaves the chart flat', async () => {
    db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'lc_tx_%'`).run();
    tx('expense', 'profit_distribution', 250000);
    const s = buildDashboardSummary(db, { branchId: BRANCH, isAll: false }, { days: 1 });
    expect(s.cashFlow[s.cashFlow.length - 1].expense).toBe(0);
  });

  /**
   * The property the old tests should have asserted. Reconciling the chart
   * against `SUM(amount) WHERE type='income'` passed both before and after the
   * fix, because that query carries the same defect. Reconciling against the
   * OPERATING predicate is what makes the assertion meaningful.
   */
  it('reconciles against the operating-income ledger, not a raw type sum', async () => {
    const s = buildDashboardSummary(db, { branchId: BRANCH, isAll: false }, { days: 1 });
    const operating = Number((db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions
        WHERE ${OPERATING_INCOME_SQL} AND date=? AND branch_id=?`
    ).get(TODAY, BRANCH) as any).v);
    const raw = Number((db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions
        WHERE type='income' AND date=? AND branch_id=?`
    ).get(TODAY, BRANCH) as any).v);

    expect(s.cashFlow[s.cashFlow.length - 1].income).toBe(operating);
    // Guard the guard: on this fixture the two figures genuinely differ, so the
    // assertion above cannot pass by coincidence.
    expect(raw).not.toBe(operating);
  });

  it('keeps equity movements out of every branch scope', () => {
    tx('income', 'capital_injection', 999, BRANCH_B);
    const a = buildDashboardSummary(db, { branchId: BRANCH, isAll: false }, { days: 1 });
    const all = buildDashboardSummary(db, { branchId: null, isAll: true }, { days: 1 });
    expect(a.cashFlow[a.cashFlow.length - 1].income).toBe(6000);
    // Organization scope sees both branches' trading activity and neither
    // branch's equity movements.
    expect(all.cashFlow[all.cashFlow.length - 1].income).toBe(6000);
  });

  it('still counts ordinary income and expense in full', () => {
    db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'lc_tx_%'`).run();
    tx('income', 'fee', 1000);
    tx('income', 'book_sale', 500);
    tx('expense', 'salary', 300);
    tx('expense', 'utilities', 200);
    const s = buildDashboardSummary(db, { branchId: BRANCH, isAll: false }, { days: 1 });
    const row = s.cashFlow[s.cashFlow.length - 1];
    expect(row.income).toBe(1500);
    expect(row.expense).toBe(500);
  });
});
