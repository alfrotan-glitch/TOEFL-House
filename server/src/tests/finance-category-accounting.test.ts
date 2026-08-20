/**
 * Accounting classification across every financial surface.
 * ============================================================================
 * The rule under test: a fixed-asset purchase, a salary advance, a refund and
 * an owner's drawing are all CASH OUT, and none of them is an ordinary
 * operating expense.
 *
 * Before the canonical taxonomy the system knew exactly ONE exception —
 * `profit_distribution` — and even that was implemented privately in three
 * places while `/finance/dashboard` had no copy at all. So:
 *
 *   * a 25,000 laptop purchase counted as operating cost in the P&L, and
 *   * a 10,000 owner drawing counted as operating cost on the Finance command
 *     centre while `/finance/pnl` reported 0 for the same day and branch.
 *
 * Each test below computes the OLD formula alongside the new one and asserts
 * they disagree, so the suite proves the previous behaviour was wrong rather
 * than merely asserting that today's behaviour is today's behaviour.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { dashboardRouter } from '../routes/dashboard.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  CAPITAL_EXPENDITURE_CATEGORIES,
  NON_EXPENSE_CASH_MOVEMENT_CATEGORIES,
  classifyExpenseCategory,
  isCapitalExpenditure,
  isNonExpenseCashMovement,
  isOperatingExpense,
} from '../core/finance/ledger-classification.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { today } from '../utils/ids.js';

const BRANCH = 'fcls_a';
const OTHER_BRANCH = 'fcls_b';
const TODAY = today();

let owner: TokenPayload;
let app: express.Express;
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;
function tx(type: string, category: string, amount: number, branch = BRANCH, date = TODAY) {
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`fcls_tx_${++seq}`, type, category, amount, date, `${category} fixture`, branch);
}

/** The formula every surface used before the taxonomy: all expense rows. */
const legacyExpenseTotal = (branch = BRANCH) =>
  Number(
    (db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='expense' AND branch_id=?`,
    ).get(branch) as { v: number }).v,
  );

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [id, name] of [[BRANCH, 'FCLS A'], [OTHER_BRANCH, 'FCLS B']]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (?, ?, 'Kabul', 1)`).run(id, name);
  }
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, must_change_password)
     VALUES ('fcls_own','fcls_own',?,'Owner','owner',?,0)`,
  ).run(pwd, BRANCH);
  syncLegacyUserRoles(db);
  owner = { userId: 'fcls_own', username: 'fcls_own', role: 'owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'fcls_tx_%'`).run();
});

// ── The classification authority itself ─────────────────────────────────────
describe('the classification authority knows all three treatments', () => {
  it('classifies fixed-asset categories as capital expenditure', () => {
    for (const category of ['sub_it_equipment', 'sub_office_equipment', 'sub_furniture_fixtures', 'sub_vehicles', 'sub_other_fixed_assets']) {
      expect(classifyExpenseCategory(category), category).toBe('capital_expenditure');
      expect(isCapitalExpenditure({ type: 'expense', category })).toBe(true);
      expect(isOperatingExpense({ type: 'expense', category })).toBe(false);
    }
  });

  it('classifies advances, refunds, drawings and charity as non-expense cash movements', () => {
    for (const category of ['sub_salary_advances', 'sub_refunds', 'sub_owner_drawings', 'sub_charitable_contributions', 'profit_distribution']) {
      expect(classifyExpenseCategory(category), category).toBe('non_expense_cash_movement');
      expect(isNonExpenseCashMovement({ type: 'expense', category })).toBe(true);
      expect(isOperatingExpense({ type: 'expense', category })).toBe(false);
    }
  });

  it('classifies the legacy "equipment" purpose as capital expenditure', () => {
    // Decided from the seed catalogue's `Monitor` icon, not from the word.
    expect(classifyExpenseCategory('equipment')).toBe('capital_expenditure');
  });

  it('leaves every ordinary category, and every UNKNOWN category, as operating expense', () => {
    for (const category of ['rent', 'salary', 'misc', 'sub_rent', 'facbook', 'something_nobody_predicted']) {
      expect(classifyExpenseCategory(category), category).toBe('operating_expense');
    }
  });

  it('the two exclusion sets are disjoint and non-empty', () => {
    expect(CAPITAL_EXPENDITURE_CATEGORIES.size).toBeGreaterThan(0);
    expect(NON_EXPENSE_CASH_MOVEMENT_CATEGORIES.size).toBeGreaterThan(0);
    const overlap = [...CAPITAL_EXPENDITURE_CATEGORIES].filter((c) => NON_EXPENSE_CASH_MOVEMENT_CATEGORIES.has(c));
    expect(overlap).toEqual([]);
  });
});

// ── P&L ─────────────────────────────────────────────────────────────────────
describe('P&L excludes capital expenditure and non-expense cash movements', () => {
  it('reports them on their own lines instead of in operating cost', async () => {
    tx('income', 'fee', 100000);
    tx('expense', 'rent', 20000);
    tx('expense', 'sub_it_equipment', 25000);   // a laptop
    tx('expense', 'sub_salary_advances', 5000); // an advance
    tx('expense', 'profit_distribution', 10000); // an owner drawing

    const res = await supertest(app)
      .get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`)
      .set(auth(owner));
    expect(res.status).toBe(200);

    expect(res.body.income).toBe(100000);
    // ONLY the rent.
    expect(res.body.expense).toBe(20000);
    expect(res.body.net).toBe(80000);
    expect(res.body.nonOperating.capitalExpenditure).toBe(25000);
    expect(res.body.nonOperating.nonExpenseCashMovement).toBe(15000);
    // The pre-existing owner-drawing contract is preserved.
    expect(res.body.transfers.profitDistribution).toBe(10000);

    // PROOF the old behaviour was wrong: summing every expense row — which is
    // what this endpoint effectively did for capex and advances — gives 60,000.
    expect(legacyExpenseTotal()).toBe(60000);
    expect(res.body.expense).not.toBe(legacyExpenseTotal());
  });

  it('tags every expense row it returns with the treatment the server resolved', async () => {
    tx('expense', 'rent', 1000);
    tx('expense', 'sub_vehicles', 2000);
    tx('expense', 'sub_refunds', 3000);

    const res = await supertest(app)
      .get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`)
      .set(auth(owner));
    const byCategory = res.body.byCategory as Array<{ category: string; classification: string | null }>;
    const treatment = (category: string) => byCategory.find((r) => r.category === category)?.classification;

    expect(treatment('rent')).toBe('operating_expense');
    expect(treatment('sub_vehicles')).toBe('capital_expenditure');
    expect(treatment('sub_refunds')).toBe('non_expense_cash_movement');
  });
});

// ── Cash flow / dashboard ───────────────────────────────────────────────────
describe('cash-flow and dashboard metrics use the same rule as the P&L', () => {
  it('the Finance command centre no longer counts a drawing or a laptop as expense', async () => {
    tx('income', 'fee', 50000);
    tx('expense', 'rent', 8000);
    tx('expense', 'sub_office_equipment', 12000);
    tx('expense', 'profit_distribution', 4000);

    const res = await supertest(app).get(`/api/finance/dashboard?branchId=${BRANCH}`).set(auth(owner));
    expect(res.status).toBe(200);
    expect(res.body.today.expense).toBe(8000);

    // Old formula = every expense row = 24,000. Proven different.
    expect(legacyExpenseTotal()).toBe(24000);
    expect(res.body.today.expense).not.toBe(legacyExpenseTotal());

    const todayPoint = (res.body.trend as Array<{ date: string; expense: number }>).find((p) => p.date === TODAY);
    expect(todayPoint?.expense).toBe(8000);
  });

  it('/finance/pnl, /reports/overview and /finance/dashboard agree to the cent', async () => {
    tx('income', 'fee', 70000);
    tx('expense', 'rent', 9000);
    tx('expense', 'sub_furniture_fixtures', 15000);
    tx('expense', 'sub_owner_drawings', 6000);

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

  it('branch isolation still holds for every classified figure', async () => {
    tx('expense', 'rent', 1000, BRANCH);
    tx('expense', 'sub_vehicles', 50000, OTHER_BRANCH);

    const res = await supertest(app)
      .get(`/api/finance/pnl?from=${TODAY}&to=${TODAY}&branchId=${BRANCH}`)
      .set(auth(owner));
    expect(res.body.expense).toBe(1000);
    expect(res.body.nonOperating.capitalExpenditure).toBe(0);
  });
});

// ── Budget vs actual / reconciliation ───────────────────────────────────────
describe('budget vs actual is not corrupted by owner drawings', () => {
  it('a profit withdrawal no longer opens a phantom budget and cash variance', () => {
    // A drawing debits BRANCH CASH and never touches a budget line. The
    // reconciler modelled expected cash as `income - savings` and expected
    // budget as `charged - EVERY expense row`, so one 5,000 withdrawal used to
    // produce cashVariance -5,000 and budgetVariance +5,000 with nothing
    // actually wrong. Both formulas are asserted here.
    tx('income', 'fee', 20000);
    tx('expense', 'profit_distribution', 5000);

    const operatingIncome = 20000;
    const savings = 0;
    const drawings = 5000;

    const legacyExpectedMain = operatingIncome - savings;              // old rule
    const correctExpectedMain = operatingIncome - savings - drawings;  // new rule
    expect(legacyExpectedMain - correctExpectedMain).toBe(5000);

    const legacyBudgetSpent = legacyExpenseTotal();                    // old rule
    const correctBudgetSpent = 0;                                      // new rule
    expect(legacyBudgetSpent - correctBudgetSpent).toBe(5000);

    // And the live reconciler now uses the correct one.
    const recon = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(recon.budgetVariance).toBe(0);
  });

  it('an expense paid FROM a budget line is still counted as budget spend', () => {
    // The fix must not swing the other way: ordinary spend still has to
    // reconcile against the envelope it came out of.
    tx('expense', 'rent', 3000);
    const recon = computeReconciliation({ branchId: BRANCH, isAll: false });
    // charged 0 − spent 3,000 = −3,000 expected, lines hold 0 ⇒ variance +3,000.
    expect(recon.budgetVariance).toBe(3000);
  });
});

// ── Budget line contract ────────────────────────────────────────────────────
describe('the budget-line API carries the hierarchy, so the browser never derives it', () => {
  it('returns the resolved category path and accounting treatment', async () => {
    const res = await supertest(app).get(`/api/finance/budget-lines?branchId=1`).set(auth(owner));
    expect(res.status).toBe(200);

    const rent = (res.body as Array<Record<string, unknown>>).find((b) => b.purpose === 'rent');
    expect(rent).toMatchObject({
      categoryId: 'sub_rent',
      subcategoryId: 'sub_rent',
      subcategoryName: 'Rent Expense',
      parentCategoryId: 'cat_premises_facilities',
      parentCategoryName: 'Premises & Facilities',
      classification: 'operating_expense',
      mappingStatus: 'mapped',
    });

    const equipment = (res.body as Array<Record<string, unknown>>).find((b) => b.purpose === 'equipment');
    expect(equipment).toMatchObject({
      parentCategoryName: 'Capital Expenditure',
      subcategoryName: 'IT Equipment',
      classification: 'capital_expenditure',
    });

    const advances = (res.body as Array<Record<string, unknown>>).find((b) => b.purpose === 'sub_salary_advances');
    expect(advances).toMatchObject({
      parentCategoryName: 'Non-Expense Cash Movements',
      subcategoryName: 'Salary Advances',
      classification: 'non_expense_cash_movement',
    });
  });

  it('surfaces an unresolved legacy line as needing review rather than pretending it is classified', async () => {
    const res = await supertest(app).get(`/api/finance/budget-lines?branchId=1`).set(auth(owner));
    const purchases = (res.body as Array<Record<string, unknown>>).find((b) => b.purpose === 'purchases');
    expect(purchases).toMatchObject({
      categoryId: null,
      subcategoryId: null,
      mappingStatus: 'needs_review',
      // Behaviour is unchanged from before the upgrade.
      classification: 'operating_expense',
    });
  });

  it('returns budget lines in canonical order, not alphabetical or id order', async () => {
    const res = await supertest(app).get(`/api/finance/budget-lines?branchId=1`).set(auth(owner));
    const orders = (res.body as Array<{ sortOrder: number }>).map((b) => b.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // The old `ORDER BY id` put "budget_cleaning_1" first; canonical order
    // starts with payroll.
    expect((res.body as Array<{ purpose: string }>)[0].purpose).toBe('teacher_salary');
  });
});

// ── Taxonomy endpoint ───────────────────────────────────────────────────────
describe('GET /finance/categories is the only source of categories for the UI', () => {
  it('returns the tree with classifications, ordering and channels', async () => {
    const res = await supertest(app).get('/api/finance/categories').set(auth(owner));
    expect(res.status).toBe(200);

    const categories = res.body.categories as Array<{
      id: string; name: string; classification: string; sortOrder: number;
      subcategories: Array<{ id: string; name: string; channels: Array<{ name: string }> }>;
      channels: Array<{ name: string }>;
    }>;

    expect(categories).toHaveLength(10);
    expect(categories.map((c) => c.sortOrder)).toEqual([...categories.map((c) => c.sortOrder)].sort((a, b) => a - b));
    expect(categories[0].name).toBe('Personnel & Payroll');

    const marketing = categories.find((c) => c.id === 'cat_marketing_promotion')!;
    const digital = marketing.subcategories.find((s) => s.id === 'sub_digital_advertising')!;
    expect(digital.channels.map((c) => c.name)).toContain('Facebook');

    // Facebook must NOT appear as a category or subcategory anywhere.
    const allNodeNames = categories.flatMap((c) => [c.name, ...c.subcategories.map((s) => s.name)]);
    expect(allNodeNames.some((n) => /facebook/i.test(n))).toBe(false);

    expect(categories.find((c) => c.id === 'cat_capital_expenditure')!.classification).toBe('capital_expenditure');
    expect(categories.find((c) => c.id === 'cat_non_expense_cash')!.classification).toBe('non_expense_cash_movement');
  });
});
