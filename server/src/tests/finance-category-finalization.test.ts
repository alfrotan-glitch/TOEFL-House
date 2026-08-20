/**
 * Finance category — FINALIZATION guards.
 * ============================================================================
 * The taxonomy is being frozen. These tests pin the decisions taken during the
 * finalization audit so that none of them can be silently changed, silently
 * resolved, or silently regress:
 *
 *   · the exact roster of unresolved items (so "needs_review = 0" can never be
 *     reached by quietly guessing one of them, and so a NEW ambiguity cannot
 *     appear unnoticed);
 *   · Reserve's out-of-taxonomy treatment, end to end;
 *   · the safety of the zero-allocation canonical budget-line catalogue;
 *   · the payroll-advance limitation, which must stay documented for exactly as
 *     long as it is true.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';
import { hashPassword, signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { LEGACY_PURPOSE_MAP, classificationOf } from '../core/finance/category-taxonomy.js';
import { classifyExpenseCategory } from '../core/finance/ledger-classification.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { today } from '../utils/ids.js';
import { groupBudgetLines } from '../../../src/components/finance/financeCategoryGrouping';
import type { BudgetLine, FinanceCategory } from '../../../src/types';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const BRANCH = 'fcfz_a';
let owner: TokenPayload;
let app: express.Express;
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (?, 'FCFZ A', 'Kabul', 1)`).run(BRANCH);
  // A branch created by raw INSERT has no catalogue; provision it the way the
  // branch-creation route does, so this suite measures the real thing.
  ensureBranchBudgetLines(db, BRANCH);
  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, must_change_password)
     VALUES ('fcfz_own','fcfz_own',?,'Owner','owner',?,0)`,
  ).run(pwd, BRANCH);
  syncLegacyUserRoles(db);
  owner = { userId: 'fcfz_own', username: 'fcfz_own', role: 'owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
});

// ── The frozen roster of unresolved items ───────────────────────────────────
describe('the set of unresolved mappings is exactly what the audit documented', () => {
  it('has precisely four legacy purposes that are not fully mapped', () => {
    const unresolved = Object.entries(LEGACY_PURPOSE_MAP)
      .filter(([, m]) => m.status !== 'mapped')
      .map(([purpose, m]) => `${purpose}:${m.status}`)
      .sort();

    // Adding a fifth means a NEW ambiguity appeared and nobody noticed.
    // Removing one means somebody resolved it — which is welcome, but must be a
    // deliberate edit here with the evidence recorded in
    // docs/finance-category-followups.md, not a silent guess.
    expect(unresolved).toEqual([
      'equipment:needs_review',
      'marketing:needs_review',
      'purchases:needs_review',
      'reserve:out_of_taxonomy',
      'transport:needs_review',
    ].sort());
  });

  it('every unresolved item still carries a correct, settled accounting treatment', () => {
    // This is what makes the freeze safe: an open SUBCATEGORY never leaves the
    // P&L undecided.
    expect(classificationOf(LEGACY_PURPOSE_MAP.equipment.categoryId)).toBe('capital_expenditure');
    expect(classificationOf(LEGACY_PURPOSE_MAP.marketing.categoryId)).toBe('operating_expense');
    expect(classificationOf(LEGACY_PURPOSE_MAP.transport.categoryId)).toBe('operating_expense');
    expect(classificationOf(LEGACY_PURPOSE_MAP.purchases.categoryId)).toBe('operating_expense');
    expect(classificationOf(LEGACY_PURPOSE_MAP.reserve.categoryId)).toBe('operating_expense');
  });

  it('each unresolved item states WHY it could not be decided', () => {
    for (const purpose of ['equipment', 'marketing', 'transport', 'purchases', 'reserve']) {
      expect(LEGACY_PURPOSE_MAP[purpose].rationale.length, purpose).toBeGreaterThan(40);
    }
  });

  it('the open decisions are written down where an owner will find them', () => {
    const followups = read('docs/finance-category-followups.md');
    for (const marker of ['OD-1', 'OD-2', 'OD-3', 'OD-4', 'FU-1']) {
      expect(followups, marker).toContain(marker);
    }
  });
});

// ── Reserve ─────────────────────────────────────────────────────────────────
describe('Reserve is financial planning, not an expense category', () => {
  it('is out of the taxonomy and has no canonical node', () => {
    expect(LEGACY_PURPOSE_MAP.reserve.status).toBe('out_of_taxonomy');
    expect(LEGACY_PURPOSE_MAP.reserve.categoryId).toBeNull();
    expect(db.prepare(`SELECT id FROM finance_categories WHERE name LIKE '%Reserve%'`).all()).toEqual([]);
  });

  it('is NOT presented to the owner as an outstanding decision', () => {
    // It used to share the "Unclassified — needs an owner decision" bucket with
    // genuinely undecided lines, which told the owner that a settled question
    // was still open.
    const lines: BudgetLine[] = [
      {
        id: 'x1', name: 'General Purchases', purpose: 'purchases', currentAmount: 0, allocatedAmount: 0,
        icon: 'ShoppingCart', costType: 'variable', isMarketing: false, branchId: '1',
        categoryId: null, mappingStatus: 'needs_review', isActive: true, sortOrder: 1,
      },
      {
        id: 'x2', name: 'Reserve', purpose: 'reserve', currentAmount: 0, allocatedAmount: 0,
        icon: 'ShieldCheck', costType: 'fixed', isMarketing: false, branchId: '1',
        categoryId: null, mappingStatus: 'out_of_taxonomy', isActive: true, sortOrder: 2,
      },
    ];
    const groups = groupBudgetLines(lines, [] as FinanceCategory[]);

    const undecided = groups.find((g) => g.isUnclassified)!;
    const outside = groups.find((g) => g.isOutOfTaxonomy)!;

    expect(undecided.groups[0].lines.map((l) => l.purpose)).toEqual(['purchases']);
    expect(outside.groups[0].lines.map((l) => l.purpose)).toEqual(['reserve']);
    expect(outside.categoryName).toMatch(/outside the expense taxonomy/i);
    expect(outside.categoryName).not.toMatch(/needs an owner decision/i);
  });

  it('the six-month reserve policy does not read the Reserve budget line', () => {
    // The BOS rule targets the branch SAVINGS ACCOUNT against a multiple of
    // fixed-cost allocation. Nothing in it looks the line up by name or purpose,
    // so the taxonomy cannot have disturbed it.
    const bos = read('server/src/routes/bos.routes.ts');
    expect(bos).toContain("cost_type='fixed'");
    expect(bos).toContain('reserveFundTarget');
    expect(bos).not.toMatch(/purpose\s*=\s*'reserve'/);
    expect(bos).not.toMatch(/budget_lines[^;]*name\s*=\s*'Reserve'/);
  });

  it('spend booked to the Reserve line stays an ordinary operating expense', () => {
    // Deliberate and conservative: money leaving a contingency envelope paid for
    // something real. It must not vanish from the cost side just because the
    // envelope itself is outside the expense taxonomy.
    expect(classifyExpenseCategory('reserve')).toBe('operating_expense');
  });
});

// ── The zero-allocation canonical catalogue ─────────────────────────────────
describe('the canonical budget-line catalogue is inert until somebody funds it', () => {
  it('provisions every subcategory with zero money', () => {
    const funded = db.prepare(
      `SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND (current_amount <> 0 OR allocated_amount <> 0)`,
    ).get(BRANCH) as { c: number };
    expect(funded.c).toBe(0);
  });

  it('does not distort budget utilization, exhausted or at-risk on the dashboard', async () => {
    const res = await supertest(app).get(`/api/finance/dashboard?branchId=${BRANCH}`).set(auth(owner));
    expect(res.status).toBe(200);

    // Every line is unfunded, so there is nothing allocated, nothing used, and —
    // critically — nothing "exhausted". `remaining <= 0` is true for all of them;
    // only the `allocated > 0` guard keeps them off the alarm list.
    expect(res.body.budget.lines).toBeGreaterThan(40);
    expect(res.body.budget.allocated).toBe(0);
    expect(res.body.budget.used).toBe(0);
    expect(res.body.budget.utilizationPercent).toBe(0);
    expect(res.body.budget.exhausted).toEqual([]);
    expect(res.body.budget.atRisk).toEqual([]);
  });

  it('does not appear as actual expense anywhere', async () => {
    const report = await supertest(app)
      .get(`/api/finance/expense-report?year=${new Date().getFullYear()}&branchId=${BRANCH}`)
      .set(auth(owner));
    expect(report.status).toBe(200);
    // No approved expense request exists for this branch, so an unfunded
    // envelope must produce no row. Guarded by the positive test below, which
    // proves the report can return rows at all — otherwise this would pass for
    // the wrong reason, which is exactly how the date-prefix defect survived.
    expect(report.body.rows).toEqual([]);
    expect(report.body.totalExpense).toBe(0);
    expect(report.body.totalCapitalExpenditure).toBe(0);
    expect(report.body.totalNonExpenseCashMovement).toBe(0);
  });

  it('does not move any balance or open a reconciliation variance', () => {
    const recon = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(recon.budgetVariance).toBe(0);
    expect(recon.cashVariance).toBe(0);
    expect(recon.savingVariance).toBe(0);
  });

  it('does not force a branch to use every subcategory — lines are optional envelopes', () => {
    // Nothing anywhere requires a line to be funded or spent from.
    const unfunded = db.prepare(
      `SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND allocated_amount = 0`,
    ).get(BRANCH) as { c: number };
    const total = db.prepare(`SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?`).get(BRANCH) as { c: number };
    expect(unfunded.c).toBe(total.c);
  });

  it('an inactive line is retained in the database but offered by no picker', () => {
    const target = db.prepare(
      `SELECT id FROM budget_lines WHERE branch_id = ? AND purpose = 'sub_vehicles'`,
    ).get(BRANCH) as { id: string } | undefined;
    expect(target).toBeDefined();
    db.prepare('UPDATE budget_lines SET is_active = 0 WHERE id = ?').run(target!.id);
    try {
      const rows = db.prepare(
        `SELECT id, name, current_amount AS currentAmount, allocated_amount AS allocatedAmount, purpose,
                is_active AS isActive, sort_order AS sortOrder
         FROM budget_lines WHERE branch_id = ?`,
      ).all(BRANCH) as Array<Record<string, unknown>>;
      const lines = rows.map((r) => ({
        ...r,
        isActive: !!r.isActive,
        icon: 'Circle',
        costType: 'variable' as const,
        isMarketing: false,
        branchId: BRANCH,
      })) as unknown as BudgetLine[];

      const visible = groupBudgetLines(lines, [] as FinanceCategory[])
        .flatMap((g) => g.groups.flatMap((s) => s.lines.map((l) => l.id)));
      expect(visible).not.toContain(target!.id);

      // Still present — deactivation is not deletion, so history keeps resolving.
      expect(db.prepare('SELECT id FROM budget_lines WHERE id = ?').get(target!.id)).toBeDefined();
    } finally {
      db.prepare('UPDATE budget_lines SET is_active = 1 WHERE id = ?').run(target!.id);
    }
  });
});

// ── FU-1: payroll advances ──────────────────────────────────────────────────
describe('the payroll-advance limitation is true, unchanged, and documented', () => {
  it('payroll still posts an advance as salary expense — behaviour deliberately untouched', () => {
    const teachers = read('server/src/routes/teachers.routes.ts');
    expect(teachers).toContain("VALUES (?, 'expense', 'salary', ?, ?, ?, ?, ?, ?)");
    expect(classifyExpenseCategory('salary')).toBe('operating_expense');
  });

  it('the taxonomy nonetheless defines Salary Advances correctly', () => {
    const node = db.prepare(
      `SELECT classification FROM finance_categories WHERE id = 'sub_salary_advances'`,
    ).get() as { classification: string };
    expect(node.classification).toBe('non_expense_cash_movement');
    expect(classifyExpenseCategory('sub_salary_advances')).toBe('non_expense_cash_movement');
  });

  it('no surface claims payroll advances are already excluded from operating cost', () => {
    // The classification authority must state the limit...
    expect(read('server/src/core/finance/ledger-classification.ts')).toContain('KNOWN LIMIT');
    // ...the P&L panel must say it on screen...
    expect(read('src/components/finance/PnLPanel.tsx')).toMatch(/Payroll advances[\s\S]{0,160}not here/);
    // ...and the follow-up register must carry the resolution options.
    expect(read('docs/finance-category-followups.md')).toMatch(/FU-1[\s\S]{0,4000}receivable/);
  });
});

// ── The expense report actually reports ─────────────────────────────────────
describe('the expense report returns rows and splits them by treatment', () => {
  /**
   * REGRESSION: `datePattern` was a SQL LIKE pattern (`2026-08-%`) handed to
   * `String.prototype.startsWith`, where `%` is a literal character. No ISO date
   * can start with that, so this endpoint returned an empty report for every
   * year and every month — forever, and silently. It had no test.
   *
   * It matters here because the taxonomy work put the per-row accounting
   * `classification` and the capex / non-expense totals into this very payload:
   * figures nobody could observe while the filter was broken.
   */
  const REPORT_BRANCH = 'fcfz_rep';
  const DATE = today();
  const [year, month] = [DATE.slice(0, 4), DATE.slice(5, 7)];

  beforeAll(() => {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES (?, 'FCFZ REP', 'Kabul', 1)`,
    ).run(REPORT_BRANCH);
    ensureBranchBudgetLines(db, REPORT_BRANCH);

    const lineFor = (purpose: string) =>
      (db.prepare('SELECT id FROM budget_lines WHERE branch_id = ? AND purpose = ?')
        .get(REPORT_BRANCH, purpose) as { id: string }).id;

    const insert = db.prepare(
      `INSERT OR REPLACE INTO expense_requests (id, title, amount, budget_line_id, requester, status, date, branch_id, expense_kind)
       VALUES (?, ?, ?, ?, 'audit', 'approved', ?, ?, 'other')`,
    );
    insert.run('fcfz_er_rent', 'August rent', 55000, lineFor('rent'), DATE, REPORT_BRANCH);
    insert.run('fcfz_er_it', 'Two laptops', 35000, lineFor('sub_it_equipment'), DATE, REPORT_BRANCH);
    insert.run('fcfz_er_adv', 'Staff advance', 15000, lineFor('sub_salary_advances'), DATE, REPORT_BRANCH);
  });

  it('returns the approved requests for a specific month', async () => {
    const res = await supertest(app)
      .get(`/api/finance/expense-report?year=${year}&month=${month}&branchId=${REPORT_BRANCH}`)
      .set(auth(owner));
    expect(res.status).toBe(200);
    // Before the fix this was `[]` — the whole report was unreachable.
    expect(res.body.rows).toHaveLength(3);
  });

  it('returns them for month=all as well', async () => {
    const res = await supertest(app)
      .get(`/api/finance/expense-report?year=${year}&month=all&branchId=${REPORT_BRANCH}`)
      .set(auth(owner));
    expect(res.body.rows).toHaveLength(3);
  });

  it('splits the totals by accounting treatment, agreeing with the P&L rule', async () => {
    const res = await supertest(app)
      .get(`/api/finance/expense-report?year=${year}&month=${month}&branchId=${REPORT_BRANCH}`)
      .set(auth(owner));

    expect(res.body.totalExpense).toBe(55000);              // operating only
    expect(res.body.totalCapitalExpenditure).toBe(35000);
    expect(res.body.totalNonExpenseCashMovement).toBe(15000);
    expect(res.body.totalCashOut).toBe(105000);

    const byLine = Object.fromEntries(
      (res.body.rows as Array<{ purpose: string; classification: string; categoryName: string; subcategoryName: string }>)
        .map((r) => [r.purpose, r]),
    );
    expect(byLine.rent).toMatchObject({ classification: 'operating_expense', categoryName: 'Premises & Facilities', subcategoryName: 'Rent Expense' });
    expect(byLine.sub_it_equipment).toMatchObject({ classification: 'capital_expenditure', categoryName: 'Capital Expenditure' });
    expect(byLine.sub_salary_advances).toMatchObject({ classification: 'non_expense_cash_movement', categoryName: 'Non-Expense Cash Movements' });
  });

  it('still excludes other years', async () => {
    const res = await supertest(app)
      .get(`/api/finance/expense-report?year=${Number(year) - 1}&month=all&branchId=${REPORT_BRANCH}`)
      .set(auth(owner));
    expect(res.body.rows).toEqual([]);
  });
});
