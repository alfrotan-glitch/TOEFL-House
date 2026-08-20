/**
 * Accounting classification across every financial surface.
 * ============================================================================
 * The rule under test: a fixed-asset purchase, a genuine salary advance, a
 * refund and an owner's drawing are all CASH OUT, and none of them is an
 * ordinary operating expense.
 *
 * Classification is resolved through `financial_transactions.finance_category_id`
 * — a foreign key into the taxonomy — so there is one authority and the six
 * surfaces below cannot hold different opinions about the same money.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  CAPITAL_EXPENDITURE_SQL,
  NON_EXPENSE_CASH_MOVEMENT_SQL,
  OPERATING_EXPENSE_SQL,
  classifyExpenseRow,
  isCapitalExpenditure,
  isNonExpenseCashMovement,
  isOperatingExpense,
} from '../core/finance/ledger-classification.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { today } from '../utils/ids.js';

const BRANCH = 'facc_a';
const OTHER = 'facc_b';
const TODAY = today();

let owner: TokenPayload;
let app: express.Express;
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;
/** Write an expense row the way the application does: label + canonical node. */
function expense(node: string | null, amount: number, branch = BRANCH, label = 'fixture') {
  db.prepare(
    `INSERT INTO financial_transactions (id,type,category,finance_category_id,amount,date,description,branch_id)
     VALUES (?,'expense',?,?,?,?,?,?)`,
  ).run(`facc_tx_${++seq}`, label, node, amount, TODAY, `${label} fixture`, branch);
}
function income(category: string, amount: number, branch = BRANCH) {
  db.prepare(
    `INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id)
     VALUES (?,'income',?,?,?,?,?)`,
  ).run(`facc_tx_${++seq}`, category, amount, TODAY, `${category} fixture`, branch);
}

/** The formula every surface used before the taxonomy: all expense rows. */
const everyExpenseRow = (branch = BRANCH) =>
  Number((db.prepare(
    `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='expense' AND branch_id=?`,
  ).get(branch) as { v: number }).v);

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [id, name] of [[BRANCH, 'FACC A'], [OTHER, 'FACC B']]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location,is_active) VALUES (?,?, 'Kabul',1)`).run(id, name);
    ensureBranchBudgetLines(db, id);
  }
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, password_hash, full_name, branch_id, must_change_password )
     VALUES ('facc_own', 'facc_own', ?, 'Owner', ?, 0)`,
  ).run(pwd, BRANCH);
  assignRole('facc_own', 'owner', BRANCH);

  owner = { userId: 'facc_own', username: 'facc_own', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'facc_tx_%'`).run();
});

// ── The authority ───────────────────────────────────────────────────────────
describe('the classification authority resolves through the taxonomy', () => {
  it('classifies fixed-asset nodes as capital expenditure', () => {
    for (const node of ['sub_it_equipment', 'sub_office_equipment', 'sub_furniture_fixtures', 'sub_vehicles', 'sub_other_fixed_assets']) {
      expect(classifyExpenseRow({ financeCategoryId: node }), node).toBe('capital_expenditure');
      expect(isCapitalExpenditure({ type: 'expense', financeCategoryId: node })).toBe(true);
      expect(isOperatingExpense({ type: 'expense', financeCategoryId: node })).toBe(false);
    }
  });

  it('classifies advances, refunds, drawings and charity as non-expense cash movements', () => {
    for (const node of ['sub_salary_advances', 'sub_refunds', 'sub_owner_drawings', 'sub_charitable_contributions']) {
      expect(classifyExpenseRow({ financeCategoryId: node }), node).toBe('non_expense_cash_movement');
      expect(isNonExpenseCashMovement({ type: 'expense', financeCategoryId: node })).toBe(true);
      expect(isOperatingExpense({ type: 'expense', financeCategoryId: node })).toBe(false);
    }
  });

  it('treats an uncategorised expense as operating cost — never as invisible', () => {
    expect(classifyExpenseRow({ financeCategoryId: null })).toBe('operating_expense');
    expect(isOperatingExpense({ type: 'expense', financeCategoryId: null })).toBe(true);
  });

  it('the SQL predicates and the in-memory helpers agree, including on NULL', () => {
    expense(null, 11);
    expense('sub_rent', 13);
    expense('sub_vehicles', 17);
    expense('sub_owner_drawings', 19);

    const sum = (predicate: string) => Number((db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE ${predicate} AND branch_id=?`,
    ).get(BRANCH) as { v: number }).v);

    expect(sum(OPERATING_EXPENSE_SQL)).toBe(24);        // 11 (NULL) + 13
    expect(sum(CAPITAL_EXPENDITURE_SQL)).toBe(17);
    expect(sum(NON_EXPENSE_CASH_MOVEMENT_SQL)).toBe(19);
    // Nothing is lost: the three buckets partition the expense side exactly.
    expect(sum(OPERATING_EXPENSE_SQL) + sum(CAPITAL_EXPENDITURE_SQL) + sum(NON_EXPENSE_CASH_MOVEMENT_SQL))
      .toBe(everyExpenseRow());
  });
});

// ── P&L ─────────────────────────────────────────────────────────────────────
describe('P&L excludes capital expenditure and non-expense cash movements', () => {
  it('reports them on their own lines instead of in operating cost', async () => {
    income('fee', 100000);
    expense('sub_rent', 20000, BRANCH, 'sub_rent');
    expense('sub_it_equipment', 25000, BRANCH, 'sub_it_equipment');
    expense('sub_salary_advances', 5000, BRANCH, 'salary_advance');
    expense('sub_owner_drawings', 10000, BRANCH, 'owner_drawing');

    const res = await supertest(app).get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.income).toBe(100000);
    expect(res.body.expense).toBe(20000);
    expect(res.body.net).toBe(80000);
    expect(res.body.nonOperating.capitalExpenditure).toBe(25000);
    expect(res.body.nonOperating.nonExpenseCashMovement).toBe(15000);
    expect(res.body.transfers.profitDistribution).toBe(10000);

    // Summing every expense row — what the surface did before — gives 60,000.
    expect(everyExpenseRow()).toBe(60000);
    expect(res.body.expense).not.toBe(everyExpenseRow());
  });

  it('names each line from the taxonomy and tags it with the resolved treatment', async () => {
    expense('sub_rent', 1000);
    expense('sub_vehicles', 2000);
    expense('sub_refunds', 3000);

    const res = await supertest(app).get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner));
    const rows = res.body.byCategory as Array<{ category: string; categoryId: string | null; classification: string | null }>;
    const find = (node: string) => rows.find((r) => r.categoryId === node);

    expect(find('sub_rent')).toMatchObject({ category: 'Rent Expense', classification: 'operating_expense' });
    expect(find('sub_vehicles')).toMatchObject({ category: 'Vehicles', classification: 'capital_expenditure' });
    expect(find('sub_refunds')).toMatchObject({ category: 'Refunds', classification: 'non_expense_cash_movement' });
  });

  it('never sums two treatments into one line', async () => {
    // Both rows carry the label 'salary'; only the node tells them apart.
    expense('sub_salaries_wages', 800, BRANCH, 'salary');
    expense('sub_salary_advances', 200, BRANCH, 'salary');

    const res = await supertest(app).get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner));
    expect(res.body.expense).toBe(800);
    expect(res.body.nonOperating.nonExpenseCashMovement).toBe(200);
  });
});

// ── Cross-surface agreement ─────────────────────────────────────────────────
describe('every financial surface agrees to the cent', () => {
  it('P&L, reports overview, dashboard and expense report tell one story', async () => {
    income('fee', 70000);
    expense('sub_rent', 9000);
    expense('sub_furniture_fixtures', 15000);
    expense('sub_owner_drawings', 6000);

    const pnl = (await supertest(app).get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner))).body;
    const overview = (await supertest(app).get(`/api/reports/overview?period=range&from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner))).body;
    const dashboard = (await supertest(app).get(`/api/finance/dashboard?branchId=${BRANCH}`).set(auth(owner))).body;

    expect(pnl.expense).toBe(9000);
    expect(overview.financial.expense.total).toBe(9000);
    expect(dashboard.today.expense).toBe(9000);
    expect(overview.financial.capitalExpenditure.total).toBe(15000);
    expect(overview.financial.nonExpenseCashMovements.total).toBe(6000);
    expect(pnl.nonOperating.capitalExpenditure).toBe(overview.financial.capitalExpenditure.total);
    expect(pnl.nonOperating.nonExpenseCashMovement).toBe(overview.financial.nonExpenseCashMovements.total);
  });

  it('branch isolation holds for every classified figure', async () => {
    expense('sub_rent', 1000, BRANCH);
    expense('sub_vehicles', 50000, OTHER);
    const res = await supertest(app).get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`).set(auth(owner));
    expect(res.body.expense).toBe(1000);
    expect(res.body.nonOperating.capitalExpenditure).toBe(0);
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────
describe('reconciliation understands where the money left from', () => {
  it('an owner drawing debits branch cash, not a budget line', () => {
    income('fee', 20000);
    expense('sub_owner_drawings', 5000);
    // Expected cash = income − savings − drawings; expected budget ignores it.
    expect(computeReconciliation({ branchId: BRANCH, isAll: false }).budgetVariance).toBe(0);
  });

  it('an ordinary expense IS counted as budget spend — the fix did not swing the other way', () => {
    expense('sub_rent', 3000);
    expect(computeReconciliation({ branchId: BRANCH, isAll: false }).budgetVariance).toBe(3000);
  });

  it('an uncategorised expense is still counted as budget spend', () => {
    // `NOT (fk = 'x')` is NULL when fk is NULL, which silently dropped these
    // rows out of the budget total and hid real drift. The predicate is
    // null-safe now.
    expense(null, 4000);
    expect(computeReconciliation({ branchId: BRANCH, isAll: false }).budgetVariance).toBe(4000);
  });
});
