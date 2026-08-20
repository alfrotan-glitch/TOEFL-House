import { Router } from 'express';
import {
  CAPITAL_INJECTION_CATEGORY,
  OPERATING_EXPENSE_SQL,
  OPERATING_INCOME_SQL,
  OWNER_DRAWINGS_CATEGORY_ID,
  classifyExpenseRow,
  isCapitalExpenditure,
  isNonExpenseCashMovement,
  isOperatingExpense,
  isOperatingIncome,
} from '../core/finance/ledger-classification.js';
import { db } from '../db/connection.js';
import { CATEGORY_NAME, SUBCATEGORY_PARENT, classificationOf, isSubcategoryId } from '../core/finance/category-taxonomy.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource, requestHasRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { periodBoundaries, addDays } from '../core/calendar/periods.js';
import { addNotification } from '../utils/notifications.js';
import { getNumberSetting, setSetting } from '../utils/settings.js';
import { decrementMainBalanceIfSufficient, incrementMainBalance, getFinanceAccount } from '../utils/financeAccounts.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { assertMoney } from '../utils/money.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const financeRouter = Router();
financeRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetBudgetLineById = db.prepare('SELECT * FROM budget_lines WHERE id = ?');
const stmtUpdateBudgetLineCharge = db.prepare('UPDATE budget_lines SET current_amount = current_amount + ?, allocated_amount = allocated_amount + ? WHERE id = ?');
const stmtUpdateBudgetLineClear = db.prepare('UPDATE budget_lines SET current_amount = 0 WHERE id = ?');
const stmtUpdateBudgetLineAddAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount + ? WHERE id = ?');
const stmtUpdateBudgetLineSubAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?');

// `finance_category_id` is the accounting authority. Transfers (budget charge,
// month-end, capital injection) pass NULL: they are not expenses.
const stmtInsertFinTx = db.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, finance_category_id, amount, date, description, reference_id, operator_name, branch_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Canonical order is DATA (`sort_order`), not an accident of `ORDER BY id`.
// `id` is a slug, so the old ordering put "Water" between "Transport" and
// "Teacher Salaries" and reshuffled itself whenever a line was renamed.
const BUDGET_LINE_ORDER_SQL = 'ORDER BY sort_order, name COLLATE NOCASE, id';
const stmtGetAllBudgetLines = db.prepare(`SELECT * FROM budget_lines ${BUDGET_LINE_ORDER_SQL}`);

// ── Finance command-center statements (GET /dashboard) ──────────────────────
// Prepared once at module load, like every other statement in this file. These
// eleven were being re-prepared on each request (audit D-10): the hot path of
// the finance landing page was the only place that skipped the convention.
// Each has an all-branch and a branch-scoped variant so branch isolation stays
// in the SQL rather than in string interpolation.
// OPERATING activity only.
//
// These were `WHERE type = ?` with no category filter, so the Finance command
// centre counted an owner drawing as an expense and (after the canonical
// taxonomy) would have counted a laptop purchase as one too — while
// `/finance/pnl` and `/reports/overview` reported 0 for the same day, branch
// and money. Four surfaces, one rule: `core/finance/ledger-classification`.
const stmtDashOperatingIncomeAll = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OPERATING_INCOME_SQL} AND date >= ? AND date <= ?`
);
const stmtDashOperatingIncomeBranch = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OPERATING_INCOME_SQL} AND branch_id = ? AND date >= ? AND date <= ?`
);
const stmtDashOperatingExpenseAll = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OPERATING_EXPENSE_SQL} AND date >= ? AND date <= ?`
);
const stmtDashOperatingExpenseBranch = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OPERATING_EXPENSE_SQL} AND branch_id = ? AND date >= ? AND date <= ?`
);
const stmtDashBudgetAll = db.prepare('SELECT id, name, allocated_amount, current_amount FROM budget_lines ORDER BY sort_order, name COLLATE NOCASE, id');
const stmtDashBudgetBranch = db.prepare('SELECT id, name, allocated_amount, current_amount FROM budget_lines WHERE branch_id = ? ORDER BY sort_order, name COLLATE NOCASE, id');
const INVOICE_RECEIVABLE_SQL = `SELECT i.id, i.net_amount, i.status, i.due_date, i.branch_id,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') AS paid
          FROM invoices i`;
const stmtDashInvoicesAll = db.prepare(INVOICE_RECEIVABLE_SQL);
const stmtDashInvoicesBranch = db.prepare(`${INVOICE_RECEIVABLE_SQL} WHERE i.branch_id = ?`);
const stmtDashCollectedAll = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status = 'completed' AND date >= ? AND date <= ?`
);
const stmtDashCollectedBranch = db.prepare(
  `SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status = 'completed' AND date >= ? AND date <= ? AND branch_id = ?`
);
const stmtDashPendingAll = db.prepare(`SELECT id, title, amount, requester, date FROM expense_requests WHERE status = 'pending' ORDER BY date DESC`);
const stmtDashPendingBranch = db.prepare(`SELECT id, title, amount, requester, date FROM expense_requests WHERE status = 'pending' AND branch_id = ? ORDER BY date DESC`);
const stmtDashRecentAll = db.prepare(`SELECT id, date, type, category, amount, description, operator_name, branch_id FROM financial_transactions ORDER BY date DESC, rowid DESC LIMIT 10`);
const stmtDashRecentBranch = db.prepare(`SELECT id, date, type, category, amount, description, operator_name, branch_id FROM financial_transactions WHERE branch_id = ? ORDER BY date DESC, rowid DESC LIMIT 10`);
// Same operating-activity rule as the totals above, so the 14-day chart and the
// headline figures above it can never tell two different stories.
const TREND_SQL = `SELECT date,
            COALESCE(SUM(CASE WHEN ${OPERATING_INCOME_SQL}  THEN amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN ${OPERATING_EXPENSE_SQL} THEN amount ELSE 0 END),0) AS expense
          FROM financial_transactions`;
const stmtDashTrendAll = db.prepare(`${TREND_SQL} WHERE date >= ? GROUP BY date ORDER BY date`);
const stmtDashTrendBranch = db.prepare(`${TREND_SQL} WHERE branch_id = ? AND date >= ? GROUP BY date ORDER BY date`);
const stmtGetBudgetLinesByBranch = db.prepare(`SELECT * FROM budget_lines WHERE branch_id = ? ${BUDGET_LINE_ORDER_SQL}`);

const stmtGetFinanceCategories = db.prepare(
  `SELECT id, parent_id, name, level, classification, sort_order, is_active
   FROM finance_categories WHERE is_active = 1 ORDER BY sort_order, name COLLATE NOCASE, id`
);
const stmtGetFinanceChannels = db.prepare(
  `SELECT id, category_id, name, kind, sort_order, is_active
   FROM finance_category_channels WHERE is_active = 1 ORDER BY sort_order, name COLLATE NOCASE, id`
);

const stmtGetAllExpenseRequests = db.prepare('SELECT * FROM expense_requests ORDER BY date DESC');
const stmtGetExpenseRequestsByBranch = db.prepare('SELECT * FROM expense_requests WHERE branch_id = ? ORDER BY date DESC');
const stmtGetExpenseRequestById = db.prepare('SELECT * FROM expense_requests WHERE id = ?');
const stmtInsertExpenseRequest = db.prepare(
  `INSERT INTO expense_requests (id, title, amount, budget_line_id, requester, status, date, branch_id, expense_kind, bill_period, payment_method, notes, auto_approved, requester_user_id, approved_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateExpenseRequestApproved = db.prepare(
  `UPDATE expense_requests SET status = 'approved', approved_by = ?, approved_by_user_id = ?, reject_reason = NULL WHERE id = ? AND status = 'pending'`
);
const stmtUpdateExpenseRequestRejected = db.prepare(
  `UPDATE expense_requests SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_by_user_id = ? WHERE id = ? AND status = 'pending'`
);

const stmtGetAllTransactions = db.prepare('SELECT * FROM financial_transactions ORDER BY date DESC, rowid DESC LIMIT 500');
const stmtGetTransactionsByBranch = db.prepare('SELECT * FROM financial_transactions WHERE branch_id = ? ORDER BY date DESC, rowid DESC LIMIT 500');

// `/finance/overview` publishes income / expense / net. Those are the same
// three numbers `/finance/pnl` publishes, so they have to obey the same rule —
// otherwise the Finance header and the P&L tab disagree about the same money.
const stmtGetIncomeTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_INCOME_SQL}`);
const stmtGetIncomeTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_INCOME_SQL} AND branch_id = ?`);
const stmtGetExpenseTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_EXPENSE_SQL}`);
const stmtGetExpenseTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_EXPENSE_SQL} AND branch_id = ?`);
const stmtGetTodayIncomeTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_INCOME_SQL} AND date = ?`);
const stmtGetTodayIncomeTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE ${OPERATING_INCOME_SQL} AND date = ? AND branch_id = ?`);
const stmtGetTodaySavedTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'saving_transfer' AND date = ?`);
const stmtGetTodaySavedTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'saving_transfer' AND date = ? AND branch_id = ?`);

/** Safely extract user context required for financial mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.branchId || !user?.fullName || !user?.role) {
    throw new HttpError(403, 'User context is missing for financial operation.');
  }
  return user;
}

/** Ensure budget line exists and caller may access its branch. */
function requireBudgetLine(req: import('express').Request, budgetLineId: string): any {
  const row = stmtGetBudgetLineById.get(budgetLineId) as any;
  if (!row) throw new HttpError(404, 'Budget line not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Budget line belongs to another branch.');
  }
  return row;
}

/**
 * Serialise a budget line WITH its place in the canonical hierarchy.
 *
 * The browser must never derive an accounting category. It receives the
 * resolved subcategory, its parent, the display names and — critically — the
 * accounting `classification`, all computed here from the taxonomy the database
 * enforces.
 */
function mapBudgetLine(row: any) {
  if (!row) return row;
  const subcategoryId: string | null = row.category_id ?? null;
  const parentId = subcategoryId ? (SUBCATEGORY_PARENT.get(subcategoryId) ?? null) : null;
  return {
    id: row.id,
    name: row.name,
    allocatedAmount: row.allocated_amount,
    currentAmount: row.current_amount,
    branchId: row.branch_id,
    costType: row.cost_type,
    icon: row.icon,
    subcategoryId,
    subcategoryName: subcategoryId ? (CATEGORY_NAME.get(subcategoryId) ?? null) : null,
    categoryId: parentId,
    categoryName: parentId ? (CATEGORY_NAME.get(parentId) ?? null) : null,
    classification: classificationOf(subcategoryId),
    channelId: row.channel_id ?? null,
    payrollTarget: row.payroll_target ?? null,
    sortOrder: row.sort_order ?? 0,
    isActive: row.is_active == null ? true : !!row.is_active,
  };
}

function mapExpenseRequest(row: any) {
  if (!row) return row;
  return {
    id: row.id, title: row.title, amount: row.amount, date: row.date, status: row.status,
    budgetLineId: row.budget_line_id, branchId: row.branch_id, requestedBy: row.requester,
    approvedBy: row.approved_by, approvedByUserId: row.approved_by_user_id, requestedByUserId: row.requester_user_id, rejectReason: row.reject_reason, expenseKind: row.expense_kind,
    paymentMethod: row.payment_method, billPeriod: row.bill_period, notes: row.notes,
  };
}

function mapTransaction(row: any) {
  if (!row) return row;
  return {
    id: row.id, type: row.type, category: row.category, amount: row.amount, date: row.date,
    description: row.description, referenceId: row.reference_id, operatorName: row.operator_name, branchId: row.branch_id,
  };
}

const VALID_EXPENSE_KINDS = new Set(['recurring_bill', 'one_time_purchase', 'maintenance', 'other']);
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'bank_transfer']);

function normalizeExpenseMeta(body: any) {
  const expenseKind = body.expenseKind || body.expense_kind || 'other';
  const paymentMethod = body.paymentMethod || body.payment_method || 'cash';
  const billPeriod = body.billPeriod || body.bill_period || null;
  const notes = body.notes || null;
  if (!VALID_EXPENSE_KINDS.has(expenseKind)) throw new HttpError(400, 'Invalid expense kind.');
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) throw new HttpError(400, 'Invalid payment method.');
  return { expenseKind, paymentMethod, billPeriod, notes };
}

/** Pay an approved amount from a budget line and write the ledger row. */
function payFromBudgetLine(opts: {
  budgetLine: any; amount: number; title: string; date: string; operatorName: string; branchId: string; requestId: string; paymentMethod: string;
}) {
  // The ledger row inherits the budget line's canonical node. `category` is the
  // readable label; `finance_category_id` is the accounting authority. They are
  // written together from one source and can never disagree.
  const categoryId: string = opts.budgetLine.category_id;
  const category = categoryId;
  const methodLabel = opts.paymentMethod === 'card' ? 'card' : opts.paymentMethod === 'bank_transfer' ? 'bank transfer' : 'cash';
  
  const updated = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?').run(opts.amount, opts.budgetLine.id, opts.amount);
  if (updated.changes !== 1) throw new HttpError(409, `Insufficient budget on "${opts.budgetLine.name}" or the balance changed. Please retry.`);
  stmtInsertFinTx.run(
    id('tx'), 'expense', category, categoryId, opts.amount, opts.date,
    `Expense "${opts.title}" from ${opts.budgetLine.name} (${methodLabel})`,
    opts.requestId, opts.operatorName, opts.branchId
  );
}

// ---------- Overview ----------
financeRouter.get(
  '/overview',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const todayStr = today();

    const income = isAll ? (stmtGetIncomeTotalAll.get() as { total: number }).total : (stmtGetIncomeTotalByBranch.get(branchId) as { total: number }).total;
    const expense = isAll ? (stmtGetExpenseTotalAll.get() as { total: number }).total : (stmtGetExpenseTotalByBranch.get(branchId) as { total: number }).total;
    const todayIncome = isAll ? (stmtGetTodayIncomeTotalAll.get(todayStr) as { total: number }).total : (stmtGetTodayIncomeTotalByBranch.get(todayStr, branchId) as { total: number }).total;

    res.json({
      ...(isAll ? (() => { const a = getFinanceAccount('organization', 'global'); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })() : (() => { const a = getFinanceAccount('branch', branchId!); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })()),
      dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
      expenseAutoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
      totals: {
        income, expense, net: income - expense, todayIncome,
        scope: isAll ? 'organization' : 'branch', branchId: branchId || null,
      },
    });
  })
);

// ---------- Finance command center (role-scoped dashboard) ----------
/**
 * GET /api/finance/dashboard — the finance manager's landing view.
 * Every figure is computed from the database in this handler (backend-only
 * financials): cash position, today/month movement, budget utilization,
 * receivables, pending approvals, reconciliation health and a 14-day trend.
 * All queries honor resolveBranchScope, so a finance manager only ever sees
 * their own branch while the owner can request the whole organization.
 */
financeRouter.get(
  '/dashboard',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const todayStr = today();
    // "This month" is the HIJRI SHAMSI month, resolved to its Gregorian span by
    // the single calendar authority. Using `${todayStr.slice(0, 7)}-01` here
    // summed a Gregorian window under a Jalali label and misattributed 9-10
    // days of money every month (audit D-6). Payroll already reports on Shamsi
    // months, so this also makes the two agree.
    const monthPeriod = periodBoundaries('month', todayStr);
    const monthStart = monthPeriod.from;

    // Balances (organization treasury for owner scope, branch account otherwise).
    const account = isAll ? getFinanceAccount('organization', 'global') : getFinanceAccount('branch', branchId!);

    // Ledger movement helpers — bound parameters only, never string concatenation.
    const ledgerTotals = (type: 'income' | 'expense', from: string, to: string) => {
      const all = type === 'income' ? stmtDashOperatingIncomeAll : stmtDashOperatingExpenseAll;
      const branch = type === 'income' ? stmtDashOperatingIncomeBranch : stmtDashOperatingExpenseBranch;
      const row = (isAll ? all.get(from, to) : branch.get(branchId, from, to)) as { v: number };
      return Number(row.v || 0);
    };

    const todayIncome = ledgerTotals('income', todayStr, todayStr);
    const todayExpense = ledgerTotals('expense', todayStr, todayStr);
    const monthIncome = ledgerTotals('income', monthStart, todayStr);
    const monthExpense = ledgerTotals('expense', monthStart, todayStr);

    // Budget utilization.
    const budgetRows = (isAll
      ? stmtDashBudgetAll.all()
      : stmtDashBudgetBranch.all(branchId)) as Array<{ id: string; name: string; allocated_amount: number; current_amount: number }>;

    let allocatedTotal = 0;
    let remainingTotal = 0;
    const exhausted: Array<{ id: string; name: string; remaining: number }> = [];
    const atRisk: Array<{ id: string; name: string; allocated: number; remaining: number; usedPercent: number }> = [];
    for (const b of budgetRows) {
      const allocated = Number(b.allocated_amount || 0);
      const remaining = Number(b.current_amount || 0);
      allocatedTotal += allocated;
      remainingTotal += remaining;
      const used = allocated - remaining;
      const usedPercent = allocated > 0 ? Math.round((used / allocated) * 100) : 0;
      if (remaining <= 0 && allocated > 0) exhausted.push({ id: b.id, name: b.name, remaining });
      else if (allocated > 0 && usedPercent >= 80) atRisk.push({ id: b.id, name: b.name, allocated, remaining, usedPercent });
    }

    // Receivables — open = issued/partial with an unpaid balance.
    const invoiceRows = (isAll
      ? stmtDashInvoicesAll.all()
      : stmtDashInvoicesBranch.all(branchId)) as Array<{ id: string; net_amount: number; status: string; due_date: string | null; branch_id: string; paid: number }>;

    let openInvoices = 0;
    let openValue = 0;
    let overdueInvoices = 0;
    let overdueValue = 0;
    let drafts = 0;
    for (const inv of invoiceRows) {
      if (inv.status === 'draft') { drafts += 1; continue; }
      const remaining = Math.max(0, Number(inv.net_amount) - Number(inv.paid));
      if (inv.status === 'issued' || inv.status === 'partial') {
        if (remaining > 0) {
          openInvoices += 1;
          openValue += remaining;
          if (inv.due_date && inv.due_date < todayStr) {
            overdueInvoices += 1;
            overdueValue += remaining;
          }
        }
      }
    }

    // A `LIKE 'YYYY-MM%'` prefix match can only ever express a GREGORIAN month,
    // so it cannot represent a Shamsi period at all. Range-compare instead, over
    // the same window as month income/expense, so every "this month" figure on
    // the panel covers exactly the same days (audit D-6).
    const collectedThisMonth = Number(((isAll
      ? stmtDashCollectedAll.get(monthStart, todayStr)
      : stmtDashCollectedBranch.get(monthStart, todayStr, branchId)) as { v: number }).v || 0);

    // Pending approvals.
    const pending = (isAll
      ? stmtDashPendingAll.all()
      : stmtDashPendingBranch.all(branchId)) as Array<{ id: string; title: string; amount: number; requester: string; date: string }>;
    const pendingValue = pending.reduce((s, p) => s + Number(p.amount || 0), 0);

    // Recent ledger activity.
    const recent = (isAll
      ? stmtDashRecentAll.all()
      : stmtDashRecentBranch.all(branchId)) as Array<{ id: string; date: string; type: string; category: string; amount: number; description: string; operator_name: string; branch_id: string }>;

    // 14-day income/expense trend.
    // Calendar arithmetic on the date STRING. Going through a Date object here
    // is timezone-sensitive: `new Date('2026-08-17')` is UTC midnight, so
    // reformatting it with a local formatter yields the previous day west of
    // UTC (audit D-4). `addDays` avoids the round trip entirely.
    const trendStart = addDays(todayStr, -13);
    const trendRows = (isAll
      ? stmtDashTrendAll.all(trendStart)
      : stmtDashTrendBranch.all(branchId, trendStart)) as Array<{ date: string; income: number; expense: number }>;
    const trendMap = new Map(trendRows.map((r) => [r.date, r]));
    const trend: Array<{ date: string; income: number; expense: number }> = [];
    for (let i = 0; i < 14; i++) {
      // Same basis as `trendStart`, so the axis and the SQL window can never
      // drift apart by a day in any timezone.
      const key = addDays(trendStart, i);
      const row = trendMap.get(key);
      trend.push({ date: key, income: Number(row?.income || 0), expense: Number(row?.expense || 0) });
    }

    res.json({
      scope: isAll ? 'organization' : 'branch',
      branchId: branchId || null,
      balances: { main: account.mainBalance, saving: account.savingBalance },
      today: { income: todayIncome, expense: todayExpense, net: todayIncome - todayExpense },
      month: {
        income: monthIncome,
        expense: monthExpense,
        net: monthIncome - monthExpense,
        // The exact window these figures cover, so the panel can state the
        // period instead of leaving the reader to assume a calendar.
        periodKey: monthPeriod.periodKey,
        from: monthPeriod.from,
        to: monthPeriod.to,
      },
      budget: {
        lines: budgetRows.length,
        allocated: allocatedTotal,
        remaining: remainingTotal,
        used: allocatedTotal - remainingTotal,
        utilizationPercent: allocatedTotal > 0 ? Math.round(((allocatedTotal - remainingTotal) / allocatedTotal) * 100) : 0,
        exhausted,
        atRisk,
      },
      receivables: { openInvoices, openValue, overdueInvoices, overdueValue, drafts, collectedThisMonth },
      approvals: { pendingCount: pending.length, pendingValue, items: pending.slice(0, 8) },
      ledger: { recent: recent.map((r) => ({ id: r.id, date: r.date, type: r.type, category: r.category, amount: Number(r.amount), description: r.description, operatorName: r.operator_name, branchId: r.branch_id })) },
      reconciliation: (() => {
        const r = computeReconciliation({ branchId, isAll });
        return { healthy: r.healthy, amountVariance: r.amountVariance, unmatchedPayments: r.unmatchedPayments, orphanLedgerRows: r.orphanLedgerRows };
      })(),
      settings: {
        dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
        expenseAutoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
        invoiceDueDays: getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays),
      },
      trend,
    });
  })
);

// ---------- Canonical finance category taxonomy ----------
/**
 * GET /api/finance/categories — the canonical Category → Subcategory tree,
 * with the channels/vendors that sit below a subcategory.
 *
 * This endpoint exists so the frontend NEVER invents, guesses or locally
 * derives an accounting category. It renders exactly what the database holds,
 * in the order the database holds it, with the accounting classification the
 * server resolved. "Facebook" arrives as a CHANNEL of Digital Advertising, not
 * as a category, which is the whole point of the model.
 */
financeRouter.get(
  '/categories',
  requirePermission('Budget.View', 'Ledger.View', 'Finance.Report', 'Expense.View'),
  ah(async (_req, res) => {
    const rows = stmtGetFinanceCategories.all() as Array<{
      id: string; parent_id: string | null; name: string; level: string;
      classification: string; sort_order: number; is_active: number;
    }>;
    const channels = stmtGetFinanceChannels.all() as Array<{
      id: string; category_id: string; name: string; kind: string; sort_order: number; is_active: number;
    }>;

    const channelsByCategory = new Map<string, Array<{ id: string; name: string; kind: string }>>();
    for (const channel of channels) {
      const list = channelsByCategory.get(channel.category_id) ?? [];
      list.push({ id: channel.id, name: channel.name, kind: channel.kind });
      channelsByCategory.set(channel.category_id, list);
    }

    const categories = rows.filter((r) => r.level === 'category').map((category) => ({
      id: category.id,
      name: category.name,
      classification: category.classification,
      sortOrder: category.sort_order,
      isActive: !!category.is_active,
      channels: channelsByCategory.get(category.id) ?? [],
      subcategories: rows
        .filter((r) => r.parent_id === category.id)
        .map((sub) => ({
          id: sub.id,
          name: sub.name,
          parentId: category.id,
          classification: sub.classification,
          sortOrder: sub.sort_order,
          isActive: !!sub.is_active,
          channels: channelsByCategory.get(sub.id) ?? [],
        })),
    }));

    res.json({ categories });
  })
);

// ---------- Budget lines ----------
financeRouter.get(
  '/budget-lines',
  requirePermission('Budget.View', 'Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllBudgetLines.all() : stmtGetBudgetLinesByBranch.all(branchId);
    res.json((rows as any[]).map(mapBudgetLine));
  })
);

/**
 * POST /api/finance/budget-lines — create a branch budget envelope.
 *
 * The taxonomy is complete and organization-wide; the BUDGET is sparse and
 * deliberate. Rather than provisioning forty-five zero-value rows per branch so
 * the catalogue "looks complete", a branch carries only the envelopes it
 * actually funds, and an authorised user creates the rest here.
 *
 * The subcategory is validated against the canonical taxonomy server-side. The
 * browser proposes; the server decides.
 */
financeRouter.post(
  '/budget-lines',
  requirePermission('Budget.Allocate', 'Budget.Edit'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { subcategoryId, name, costType, channelId, branchId: bodyBranch } = req.body as {
      subcategoryId?: string; name?: string; costType?: 'fixed' | 'variable';
      channelId?: string | null; branchId?: string;
    };

    if (!isSubcategoryId(subcategoryId)) {
      throw new HttpError(400, 'A valid finance subcategory is required.');
    }
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName) throw new HttpError(400, 'A budget line name is required.');
    assertTextLengths([[trimmedName, 'Budget line name', TEXT_LIMITS.line]]);
    if (costType && !['fixed', 'variable'].includes(costType)) throw new HttpError(400, 'Invalid cost type.');

    const branchId = bodyBranch || user.branchId;
    if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Budget line belongs to another branch.');
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ? AND is_active = 1').get(branchId)) {
      throw new HttpError(404, 'Branch not found or inactive.');
    }
    if (channelId) {
      const channel = db.prepare('SELECT category_id FROM finance_category_channels WHERE id = ? AND is_active = 1')
        .get(channelId) as { category_id: string } | undefined;
      if (!channel) throw new HttpError(404, 'Channel not found.');
      if (channel.category_id !== subcategoryId) throw new HttpError(400, 'Channel does not belong to the selected subcategory.');
    }

    // Ordering is data, not alphabetical accident: a new envelope sorts after
    // everything the branch already has.
    const nextOrder = Number(
      (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM budget_lines WHERE branch_id = ?')
        .get(branchId) as { n: number }).n,
    );

    const newId = id('bl');
    try {
      db.prepare(`
        INSERT INTO budget_lines
          (id, name, current_amount, allocated_amount, icon, cost_type, branch_id,
           category_id, channel_id, sort_order, is_active, payroll_target)
        VALUES (?, ?, 0, 0, NULL, ?, ?, ?, ?, ?, 1, NULL)
      `).run(newId, trimmedName, costType ?? 'variable', branchId, subcategoryId, channelId ?? null, nextOrder);
    } catch (err: unknown) {
      // The unique index is on (branch_id, category_id, name): two envelopes
      // under one subcategory are legitimate, two with the same NAME are not.
      if (String((err as { message?: string })?.message || '').includes('UNIQUE')) {
        throw new HttpError(409, `A budget line named "${trimmedName}" already exists under that subcategory for this branch.`);
      }
      throw err;
    }

    writeAudit(req, `Created budget line "${trimmedName}" under ${CATEGORY_NAME.get(subcategoryId!) ?? subcategoryId}`);
    res.status(201).json(mapBudgetLine(stmtGetBudgetLineById.get(newId)));
  })
);

/**
 * PATCH /api/finance/budget-lines/:id — rename, reclassify cost type, retire.
 *
 * Cost type is a budgeting property (is this a recurring commitment?), not an
 * accounting one — the accounting treatment belongs to the subcategory and is
 * not editable here, precisely so there is only ever one authority for it.
 *
 * A budget line is never DELETED: `expense_requests` and the ledger reference
 * it, so retirement is `isActive = false`. It disappears from every picker and
 * keeps resolving for history.
 */
financeRouter.patch(
  '/budget-lines/:id',
  requirePermission('Budget.Allocate', 'Budget.Edit'),
  ah(async (req, res) => {
    const line = requireBudgetLine(req, req.params.id);
    const { name, costType, isActive, channelId } = req.body as {
      name?: string; costType?: 'fixed' | 'variable'; isActive?: boolean; channelId?: string | null;
    };

    if (costType && !['fixed', 'variable'].includes(costType)) throw new HttpError(400, 'Invalid cost type.');
    let nextName = line.name as string;
    if (name != null) {
      nextName = String(name).trim();
      if (!nextName) throw new HttpError(400, 'A budget line name is required.');
      assertTextLengths([[nextName, 'Budget line name', TEXT_LIMITS.line]]);
    }
    if (isActive === false && line.payroll_target) {
      // Retiring a payroll envelope would make payroll answer 500 on the next
      // salary run, with no way back through the UI.
      throw new HttpError(409, 'A payroll budget line cannot be retired; payroll depends on it.');
    }
    if (channelId) {
      const channel = db.prepare('SELECT category_id FROM finance_category_channels WHERE id = ? AND is_active = 1')
        .get(channelId) as { category_id: string } | undefined;
      if (!channel) throw new HttpError(404, 'Channel not found.');
      if (channel.category_id !== line.category_id) throw new HttpError(400, 'Channel does not belong to this budget line\'s subcategory.');
    }

    db.prepare(`
      UPDATE budget_lines
         SET name = ?, cost_type = ?, is_active = ?, channel_id = ?
       WHERE id = ?
    `).run(
      nextName,
      costType ?? line.cost_type,
      isActive == null ? line.is_active : (isActive ? 1 : 0),
      channelId === undefined ? line.channel_id : channelId,
      line.id,
    );

    writeAudit(req, `Updated budget line "${nextName}"`);
    res.json(mapBudgetLine(stmtGetBudgetLineById.get(line.id)));
  })
);

financeRouter.post(
  '/budget-lines/:id/charge',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const budgetLine = requireBudgetLine(req, req.params.id);
    const { amount } = req.body;
    if (!amount || amount <= 0) throw new HttpError(400, 'Invalid amount.');
    
    const date = today();
    const tx = db.transaction(() => {
      if (!decrementMainBalanceIfSufficient('organization', 'global', amount)) throw new HttpError(409, 'Insufficient organization treasury balance or the balance changed.');
      stmtUpdateBudgetLineCharge.run(amount, amount, budgetLine.id);
      stmtInsertFinTx.run(
        id('tx'), 'budget_charge', 'budget_allocation', null, amount, date,
        `Budget charge for line "${budgetLine.name}" from the central finance account`,
        budgetLine.id, user.fullName, budgetLine.branch_id || user.branchId
      );
    });
    tx();
    
    addNotification('Budget charge successful', `${amount} AFN deducted from the main account and added to the ${budgetLine.name} budget.`, 'success', user.branchId);
    writeAudit(req, `Allocated and charged budget line ${budgetLine.name} for ${amount} AFN`);
    res.status(201).json({ ok: true });
  })
);

financeRouter.post(
  '/budget-lines/:id/month-end',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const budgetLine = requireBudgetLine(req, req.params.id);
    const { decision, targetBudgetLineId } = req.body as { decision: 'return' | 'transfer'; targetBudgetLineId?: string };
    const unusedAmount = budgetLine.current_amount;
    
    if (unusedAmount <= 0) throw new HttpError(400, 'The remaining budget for this line is zero and requires no adjustment.');
    const date = today();
    
    if (decision === 'return') {
      const tx = db.transaction(() => {
        stmtUpdateBudgetLineClear.run(budgetLine.id);
        incrementMainBalance('organization', 'global', unusedAmount);
        stmtInsertFinTx.run(
          id('tx'), 'budget_charge', 'budget_return', null, unusedAmount, date,
          `Month-end settlement: returning unused budget from line "${budgetLine.name}" to the main account`,
          budgetLine.id, user.fullName, user.branchId
        );
      });
      tx();
      addNotification('Month-end budget settlement', `${unusedAmount} AFN of unused budget from ${budgetLine.name} has been returned to the main account.`, 'success', user.branchId);
      writeAudit(req, `Month-end operation: returned unused budget "${budgetLine.name}" (${unusedAmount} AFN) to the main account`);
    } else if (decision === 'transfer' && targetBudgetLineId) {
      const targetLine = stmtGetBudgetLineById.get(targetBudgetLineId) as any;
      if (!targetLine) throw new HttpError(404, 'Target budget line not found.');
      if (targetLine.branch_id && !canAccessBranchResource(req, targetLine.branch_id)) throw new HttpError(403, 'Target budget line belongs to another branch.');
      if (targetLine.branch_id && budgetLine.branch_id && targetLine.branch_id !== budgetLine.branch_id) throw new HttpError(400, 'Budget transfer must remain within the same branch.');
      
      const tx = db.transaction(() => {
        stmtUpdateBudgetLineClear.run(budgetLine.id);
        stmtUpdateBudgetLineAddAmount.run(unusedAmount, targetBudgetLineId);
        stmtInsertFinTx.run(
          id('tx'), 'saving_transfer', 'budget_transfer', null, unusedAmount, date,
          `Month-end settlement: transferring remaining budget from "${budgetLine.name}" to budget line "${targetLine.name}"`,
          budgetLine.id, user.fullName, user.branchId
        );
      });
      tx();
      addNotification('Month-end budget transfer', `${unusedAmount} AFN of unused budget from "${budgetLine.name}" has been transferred to "${targetLine.name}".`, 'success', user.branchId);
      writeAudit(req, `Month-end operation: transferred remaining budget "${budgetLine.name}" (${unusedAmount} AFN) to "${targetLine.name}"`);
    } else {
      throw new HttpError(400, 'Invalid decision.');
    }
    res.json({ ok: true });
  })
);

// ---------- Central treasury (capital) ----------
/**
 * POST /api/finance/treasury/deposit — owner-only capital injection into the
 * organization treasury ("central capital").
 *
 * The central treasury is the source that funds budget lines (budget charge →
 * salary payments / operational expenses → month-end return). On a fresh
 * install it starts at 0 and has no other funding path, so without this
 * endpoint the entire budget/payroll/month-end chain is unreachable. The
 * owner records the opening balance / capital deposits here.
 */
financeRouter.post(
  '/treasury/deposit',
  authorize('owner'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const rawAmount = req.body?.amount;
    let amount: number;
    try { amount = assertMoney(rawAmount, 'deposit amount'); } catch { throw new HttpError(400, 'Deposit amount must be a valid positive monetary amount.'); }
    if (amount <= 0) throw new HttpError(400, 'Deposit amount must be greater than zero.');

    const notes = typeof req.body?.notes === 'string' ? String(req.body.notes).trim().slice(0, 500) : null;
    const date = today();

    const tx = db.transaction(() => {
      incrementMainBalance('organization', 'global', amount);
      stmtInsertFinTx.run(
        id('tx'), 'income', 'capital_injection', null, amount, date,
        notes ? `Capital injection into central treasury — ${notes}` : 'Capital injection into central treasury',
        null, user.fullName, user.branchId
      );
    });
    tx();

    addNotification('Capital deposited', `${amount} AFN added to the central treasury. Budgets can now be funded.`, 'success', user.branchId);
    writeAudit(req, `Deposited ${amount} AFN of capital into the central treasury${notes ? ` (${notes})` : ''}`);
    res.status(201).json({ ok: true, amount, balance: getFinanceAccount('organization', 'global').mainBalance });
  })
);

// ---------- Expense requests ----------
financeRouter.get(
  '/expense-requests',
  requirePermission('Expense.View', 'Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = isAll ? stmtGetAllExpenseRequests.all() : stmtGetExpenseRequestsByBranch.all(branchId);
    res.json((rows as any[]).map(mapExpenseRequest));
  })
);

financeRouter.post(
  '/expense-requests',
  requirePermission('Expense.View', 'Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { title, amount, budgetLineId } = req.body;
    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;
    if (budgetLine) requireBudgetLine(req, String(budgetLineId));

    // F-3a: `Number.isFinite(Number(amount))` VALIDATED a coercion but then
    // stored the RAW body value, so the check and the write disagreed.
    // Reproduced live on a fresh database:
    //     '0x10'  -> 201, persisted as TEXT '0x10' in a REAL column
    //     [500]   -> 201, persisted as 500
    //     true    -> 500 "SQLite3 can only bind numbers, strings, bigints..."
    //     [[7]]   -> 500 (same raw bind error)
    //     0.001   -> 500, leaking the two-decimal database trigger
    //     1e15    -> 201, persisted
    // A TEXT amount is not inert: `/expense-report` accumulates with
    // `r.totalAmount += er.amount` (string concatenation), the dashboard sums
    // pending value, and `/decide` feeds `request.amount` straight into
    // payFromBudgetLine. `assertMoney` is the boundary /treasury/deposit and
    // /operational-payments on this same router already use.
    let resolvedAmount: number;
    try { resolvedAmount = assertMoney(amount, 'Expense amount'); }
    catch { throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.'); }
    if (!title?.trim() || resolvedAmount <= 0 || !budgetLine) {
      throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.');
    }
    assertTextLengths([[title, 'Title', TEXT_LIMITS.line]]);

    // F-3b: book the request to the branch that owns the budget line, exactly
    // as /operational-payments and /decide do. Storing `user.branchId` let a
    // global owner create a cross-branch request that `/decide` then refused
    // forever with its own 409 ("...belong to different branches"): verified
    // permanently stuck in `pending`, approvable AND rejectable never — because
    // the branch check runs before the approve/reject split.
    const requestBranchId = budgetLine.branch_id || user.branchId;
    const { expenseKind, paymentMethod, billPeriod, notes } = normalizeExpenseMeta(req.body);
    const newId = id('req');
    stmtInsertExpenseRequest.run(
      newId, title, resolvedAmount, budgetLineId, user.fullName, 'pending', today(), requestBranchId,
      expenseKind, billPeriod, paymentMethod, notes, 0, user.userId, null
    );
    
    // Report the PARSED amount and notify the branch that will actually pay,
    // so the notification, the audit line and the stored row all agree.
    addNotification('New expense request', `Expense request "${title}" for ${resolvedAmount} AFN against budget ${budgetLine.name} is pending approval.`, 'info', requestBranchId);
    writeAudit(req, `Created expense request: ${title} for ${resolvedAmount} AFN against budget ${budgetLine.name}`);
    res.status(201).json({ id: newId, status: 'pending' });
  })
);

financeRouter.post(
  '/operational-payments',
  requirePermission('Expense.Create', 'Expense.Approve', 'Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { title, amount, budgetLineId, requireApproval } = req.body as {
      title?: string; amount?: number; budgetLineId?: string; requireApproval?: boolean;
    };
    
    // F-2: `Number()` is a coercion, not a parse, so values that are not
    // amounts became real payments. Reproduced live on a fresh database:
    //     true     -> 201, 1 AFN paid from the budget line
    //     [500]    -> 201, 500 AFN paid
    //     '0x10'   -> 201, 16 AFN paid
    //     [[7]]    -> 201, 7 AFN paid
    //     0.001    -> 500, leaking the two-decimal database trigger
    // `assertMoney` is the boundary /treasury/deposit on this same router
    // already uses; it parses, rounds to 2dp and applies the precision
    // ceiling. The endpoint's own "> 0" rule is kept and applied to the
    // PARSED value, so 0.001 (which rounds to 0) is now a clean 400 instead
    // of a database error. Any amount >= 0.01 behaves exactly as before.
    let resolvedAmount: number;
    try { resolvedAmount = assertMoney(amount, 'Expense amount'); }
    catch { throw new HttpError(400, 'Title, a valid amount, and a budget line are required.'); }
    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;
    if (budgetLine) requireBudgetLine(req, String(budgetLineId));
    if (!title?.trim() || resolvedAmount <= 0 || !budgetLine) {
      throw new HttpError(400, 'Title, a valid amount, and a budget line are required.');
    }
    // F-1: book the expense to the branch that actually owns the budget line.
    // `POST /expense-requests/:id/decide` — the other caller of
    // payFromBudgetLine — already enforces this exact invariant, rejecting a
    // request whose budget line belongs to another branch with 409 and paying
    // with `branchId: budgetLine.branch_id`. This path used `user.branchId`
    // for both the expense_request row and the ledger row, so a global owner
    // spending another branch's line drained THAT branch's budget while the
    // expense landed on their own: verified 1,200 AFN left branch B's line
    // and branch A's expense total rose by 1,200 while B's stayed 0.
    // Branch expense totals feed /finance/overview, /finance/dashboard,
    // the reports P&L and the BOS break-even KPIs, so the misattribution
    // propagates into every branch-scoped financial figure.
    const expenseBranchId = budgetLine.branch_id || user.branchId;
    assertTextLengths([[title, 'Title', TEXT_LIMITS.line]]);

    const { expenseKind, paymentMethod, billPeriod, notes } = normalizeExpenseMeta(req.body);
    const threshold = getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold);
    const shouldAutoPay = !requireApproval && (resolvedAmount <= threshold || requestHasRole(req, 'owner'));

    const date = today();
    const newId = id('req');

    if (!shouldAutoPay) {
      stmtInsertExpenseRequest.run(
        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'pending', date, expenseBranchId,
        expenseKind, billPeriod, paymentMethod, notes, 0, user.userId, null
      );
      addNotification('Operational expense awaiting approval', `"${title}" (${resolvedAmount} AFN) exceeds the auto-approve threshold (${threshold} AFN) and needs manager/owner approval.`, 'warning', user.branchId);
      writeAudit(req, `Operational expense pending approval: ${title} for ${resolvedAmount} AFN`);
      return res.status(201).json({ id: newId, status: 'pending', autoApproved: false, threshold });
    }

    if (budgetLine.current_amount < resolvedAmount) {
      throw new HttpError(409, `Insufficient balance on budget line "${budgetLine.name}" (remaining: ${budgetLine.current_amount} AFN). Charge the budget first.`);
    }

    const tx = db.transaction(() => {
      stmtInsertExpenseRequest.run(
        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'approved', date, expenseBranchId,
        expenseKind, billPeriod, paymentMethod, notes, 1, user.userId, user.userId
      );
      db.prepare("UPDATE expense_requests SET approved_by = ? WHERE id = ?").run(user.fullName, newId);
      
      payFromBudgetLine({
        budgetLine, amount: resolvedAmount, title: title.trim(), date, operatorName: user.fullName, branchId: expenseBranchId, requestId: newId, paymentMethod,
      });
    });
    tx();

    addNotification('Operational expense paid', `"${title}" for ${resolvedAmount} AFN paid from ${budgetLine.name}.`, 'success', user.branchId);
    writeAudit(req, `Operational expense paid: ${title} for ${resolvedAmount} AFN from ${budgetLine.name}`);
    res.status(201).json({ id: newId, status: 'approved', autoApproved: true, threshold });
  })
);

financeRouter.get(
  '/expense-report',
  requirePermission('Expense.View', 'Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const year = String((req.query as any).year || new Date().getFullYear());
    const month = String((req.query as any).month || 'all');
    const { branchId, isAll } = resolveBranchScope(req);

    // PREFIX for `String.prototype.startsWith`, NOT a SQL LIKE pattern.
    //
    // This was `${year}-${month}-%`, a LIKE pattern fed to a JavaScript
    // `startsWith`, where `%` is an ordinary character. No ISO date can start
    // with "2026-08-%", so `/finance/expense-report` returned an EMPTY report
    // for every year and every month, always — including `month=all`
    // (`${year}-%`). Proven live during the finalization audit: three approved
    // requests totalling 105,000 AFN dated 2026-08-20 produced
    // `rows: [], totalExpense: 0`.
    //
    // It matters more now than it did before: this endpoint carries the
    // per-row accounting `classification` and the capital-expenditure /
    // non-expense splits, so while the filter was broken those figures could
    // never be observed. The date semantics are otherwise unchanged — the same
    // prefix match over the same column.
    const datePattern = month === 'all' ? `${year}-` : `${year}-${month.padStart(2, '0')}-`;
    
    const allRequests = isAll 
      ? stmtGetAllExpenseRequests.all() as any[] 
      : stmtGetExpenseRequestsByBranch.all(branchId) as any[];
    
    const filtered = allRequests.filter(er => er.status === 'approved' && er.date.startsWith(datePattern));

    interface ExpenseReportRow {
      budgetLineId: string; budgetLineName: string; costType: string;
      totalAmount: number; count: number;
      categoryId: string | null; categoryName: string | null;
      subcategoryId: string | null; subcategoryName: string | null;
      classification: string;
    }
    const rowsMap = new Map<string, ExpenseReportRow>();
    const byKindMap = new Map<string, { kind: string; total: number; count: number }>();

    for (const er of filtered) {
      const bl = stmtGetBudgetLineById.get(er.budget_line_id) as any;
      const bId = er.budget_line_id || 'unknown';
      const bName = bl?.name || 'Unknown';
      const costType = bl?.cost_type || 'variable';

      if (!rowsMap.has(bId)) {
        const mapped = mapBudgetLine(bl);
        rowsMap.set(bId, {
          budgetLineId: bId, budgetLineName: bName, costType, totalAmount: 0, count: 0,
          categoryId: mapped?.categoryId ?? null,
          categoryName: mapped?.categoryName ?? null,
          subcategoryId: mapped?.subcategoryId ?? null,
          subcategoryName: mapped?.subcategoryName ?? null,
          // Resolved from the budget line's canonical node, never from its name.
          classification: mapped?.classification ?? 'operating_expense',
        });
      }
      const r = rowsMap.get(bId)!;
      r.totalAmount += er.amount;
      r.count++;

      const kind = er.expense_kind || 'other';
      if (!byKindMap.has(kind)) byKindMap.set(kind, { kind, total: 0, count: 0 });
      const k = byKindMap.get(kind)!;
      k.total += er.amount;
      k.count++;
    }

    const rows = Array.from(rowsMap.values()).sort((a, b) => b.totalAmount - a.totalAmount);
    const byKind = Array.from(byKindMap.values()).sort((a, b) => b.total - a.total);

    // `totalExpense` is the OPERATING total. A fixed-asset purchase and a
    // salary advance are cash out but not operating cost, so they are reported
    // on their own lines instead of inflating the expense figure a manager
    // budgets against. `totalCashOut` preserves the old "everything" number for
    // anyone who needs it.
    const sumWhere = (predicate: (r: ExpenseReportRow) => boolean) =>
      rows.filter(predicate).reduce((sum, r) => sum + r.totalAmount, 0);
    const totalExpense = sumWhere((r) => r.classification === 'operating_expense');
    const totalCapitalExpenditure = sumWhere((r) => r.classification === 'capital_expenditure');
    const totalNonExpenseCashMovement = sumWhere((r) => r.classification === 'non_expense_cash_movement');

    res.json({
      year, month, rows, totalExpense, byKind,
      totalCapitalExpenditure,
      totalNonExpenseCashMovement,
      totalCashOut: totalExpense + totalCapitalExpenditure + totalNonExpenseCashMovement,
      autoApproveThreshold: getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold),
    });
  })
);

financeRouter.put(
  '/expense-auto-approve-threshold',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const { threshold } = req.body as { threshold?: number };
    if (threshold == null || threshold < 0) throw new HttpError(400, 'Threshold must be a non-negative number.');
    setSetting('expense_auto_approve_threshold', String(Math.round(threshold)));
    writeAudit(req, `Set expense auto-approve threshold to ${Math.round(threshold)} AFN`);
    res.json({ ok: true, threshold: Math.round(threshold) });
  })
);

financeRouter.post(
  '/expense-requests/:id/decide',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const request = stmtGetExpenseRequestById.get(req.params.id) as any;
    if (!request) throw new HttpError(404, 'Request not found.');
    if (request.status !== 'pending') throw new HttpError(409, `Expense request is already ${request.status} and cannot be decided again.`);
    if (request.requester_user_id && request.requester_user_id === user.userId && !requestHasRole(req, 'owner')) throw new HttpError(403, 'Requester and approver must be different users.');
    if (!request.branch_id || !canAccessBranchResource(req, request.branch_id)) throw new HttpError(403, 'Expense request belongs to another branch.');

    const budgetLine = requireBudgetLine(req, String(request.budget_line_id));
    if (budgetLine.branch_id !== request.branch_id) throw new HttpError(409, 'Expense request and budget line belong to different branches.');
    
    const { isApproved, rejectReason } = req.body as { isApproved: boolean; rejectReason?: string };
    if (typeof isApproved !== 'boolean') throw new HttpError(400, 'isApproved must be a boolean.');
    
    if (!isApproved) {
      stmtUpdateExpenseRequestRejected.run(rejectReason || 'Rejected by the course owner', user.fullName, user.userId, request.id);
      // F-4: this passed 'alert', which `notifications.type` does not allow
      // (CHECK: info|warning|critical|success). The rejection UPDATE had
      // already committed, so the CHECK violation surfaced AFTER the state
      // change: the request really was rejected but the caller received
      // 400 "Invalid data provided. Please check your inputs." and could not
      // tell that it had worked. 'warning' matches the sibling
      // "awaiting approval" notification on the same workflow.
      addNotification('Budget request rejected', `Request "${request.title}" was rejected by the course owner. Reason: ${rejectReason || 'Not specified'}`, 'warning', user.branchId);
      writeAudit(req, `Rejected expense request: ${request.title}`, { oldValue: 'pending', newValue: 'rejected' });
      return res.json({ status: 'rejected' });
    }
    
    const date = today();
    const tx = db.transaction(() => {
      const updated = stmtUpdateExpenseRequestApproved.run(user.fullName, user.userId, request.id);
      if (updated.changes !== 1) throw new HttpError(409, 'Expense request was already decided.');
      payFromBudgetLine({
        budgetLine, amount: request.amount, title: request.title, date,
        operatorName: user.fullName, branchId: budgetLine.branch_id || user.branchId,
        requestId: request.id, paymentMethod: request.payment_method || 'cash',
      });
    });
    tx();
    
    addNotification('Expense approved and paid', `Request "${request.title}" approved and ${request.amount} AFN paid.`, 'success', user.branchId);
    writeAudit(req, `Approved and paid expense: ${request.title} for ${request.amount} AFN from budget ${budgetLine.name}`);
    res.json({ status: 'approved' });
  })
);

// ---------- Saving engine ----------
financeRouter.post(
  '/saving-engine/run',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const todayStr = today();

    const income = isAll 
      ? (stmtGetTodayIncomeTotalAll.get(todayStr) as { total: number }).total 
      : (stmtGetTodayIncomeTotalByBranch.get(todayStr, branchId) as { total: number }).total;
      
    const alreadySaved = isAll 
      ? (stmtGetTodaySavedTotalAll.get(todayStr) as { total: number }).total 
      : (stmtGetTodaySavedTotalByBranch.get(todayStr, branchId) as { total: number }).total;

    res.json({
      ok: true, 
      mode: 'realtime',
      message: 'Savings are applied automatically on each income transaction. Manual bulk run is disabled to prevent double transfers.',
      todayIncome: income, // Fixed: income is already a number
      alreadyTransferredToday: alreadySaved, // Fixed: alreadySaved is already a number
      ...(isAll ? (() => { const a = getFinanceAccount('organization', 'global'); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })() : (() => { const a = getFinanceAccount('branch', branchId!); return { mainAccountBalance: a.mainBalance, savingBalance: a.savingBalance }; })()),
    });
  })
);

financeRouter.put(
  '/saving-engine/settings',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const { percent } = req.body;
    if (percent == null || percent < 0 || percent > 100) throw new HttpError(400, 'Percentage must be between 0 and 100.');
    setSetting('daily_saving_percent', String(percent));
    writeAudit(req, `Changed daily savings percentage to ${percent}%`);
    res.json({ ok: true });
  })
);

// ---------- Reconciliation ----------
financeRouter.get(
  '/reconciliation',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    res.json(computeReconciliation({ branchId, isAll }));
  })
);

// ---------- Ledger (read-only, paginated) ----------
financeRouter.get(
  '/transactions',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { from, to, category, type } = req.query as Record<string, string>;
    const { branchId, isAll } = resolveBranchScope(req);
    const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!isAll) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (from && to) { clauses.push('date >= ? AND date <= ?'); params.push(from, to); }
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (type) { clauses.push('type = ?'); params.push(type); }

    const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM financial_transactions${whereSql}`).get(...params) as { c: number };
    const rows = db.prepare(`SELECT * FROM financial_transactions${whereSql} ORDER BY date DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    res.setHeader('X-Total-Count', String(countRow.c));
    res.setHeader('X-Page-Limit', String(limit));
    res.setHeader('X-Page-Offset', String(offset));
    // includeTotal=1 returns { rows, total } for paginated consumers; the
    // default array shape keeps existing store callers unchanged.
    if (req.query.includeTotal === '1') {
      res.json({ rows: rows.map(mapTransaction), total: countRow.c });
      return;
    }
    res.json(rows.map(mapTransaction));
  })
);

financeRouter.get(
  '/pnl',
  requirePermission('Ledger.View', 'Finance.Report'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const { from, to } = req.query as { from?: string; to?: string };

    // Safe Dynamic SQL for Date Range PnL using bound parameters
    // One canonical NODE is one line. Grouping by the label as well would split
    // a subcategory across two rows whenever two writers chose different words
    // for the same thing; grouping by the label INSTEAD would merge two
    // treatments that happen to share one. `COALESCE` lets income — which has
    // no node, because the taxonomy models the expense side — group by its
    // billing category as before.
    let sql = `SELECT type, COALESCE(finance_category_id, category) AS group_key, MIN(category) AS category,
                      finance_category_id, COALESCE(SUM(amount), 0) AS total
                 FROM financial_transactions WHERE 1=1`;
    const params: unknown[] = [];
    
    if (!isAll) { 
      sql += ' AND branch_id = ?'; 
      params.push(branchId); 
    }
    if (from) { 
      sql += ' AND date >= ?'; 
      params.push(from); 
    }
    if (to) { 
      sql += ' AND date <= ?'; 
      params.push(to); 
    }
    
    // Grouped by the canonical NODE as well as the label, so two rows that
    // share a label but not a treatment can never be summed together.
    sql += ' GROUP BY type, group_key ORDER BY type, group_key';
    
    const finalByCategory = db.prepare(sql).all(...params) as any[];

    // Operating P&L accounting semantics (single source of truth):
    //  - income: type='income' EXCEPT capital injections (balance-sheet funding).
    //  - expense: type='expense' EXCEPT everything the canonical taxonomy
    //    classifies as capital expenditure or a non-expense cash movement.
    //    Before the taxonomy existed the only exclusion was owner drawings, so
    //    a laptop purchase and a salary advance both landed in operating cost.
    //  - budget_charge and saving_transfer are balance-sheet transfers between
    //    treasury/saving/budget accounts, never operating income or expense.
    //  - student refunds are already recorded as negative income
    //    (contra-revenue) and therefore reduce operating income; that mechanism
    //    is unchanged.
    let income = 0;
    let expense = 0;
    let capitalInjection = 0;
    let profitDistribution = 0;
    let capitalExpenditure = 0;
    let nonExpenseCashMovement = 0;
    let budgetCharged = 0;
    let savingTransferred = 0;

    for (const row of finalByCategory) {
      // Same classification authority as the Dashboard, Reports and
      // reconciliation use, so a change to the rule cannot land in three
      // places and miss the fourth.
      if (row.type === 'income' && row.category === CAPITAL_INJECTION_CATEGORY) capitalInjection += row.total;
      else if (isOperatingIncome(row)) income += row.total;
      else if (isOperatingExpense(row)) expense += row.total;
      else if (isCapitalExpenditure(row)) capitalExpenditure += row.total;
      else if (isNonExpenseCashMovement(row)) {
        nonExpenseCashMovement += row.total;
        // Owner drawings keep their own line as well as counting towards the
        // non-expense total: the existing `transfers.profitDistribution`
        // contract is relied on by /reports/overview and the P&L print-out.
        if (row.finance_category_id === OWNER_DRAWINGS_CATEGORY_ID) profitDistribution += row.total;
      }
      else if (row.type === 'budget_charge') budgetCharged += row.total;
      else if (row.type === 'saving_transfer') savingTransferred += row.total;
    }

    res.json({
      from: from || null, 
      to: to || null,
      scope: isAll ? 'organization' : 'branch', 
      branchId: branchId || null,
      income, 
      expense, 
      net: income - expense,
      // Every expense row is tagged with the treatment the server resolved, so
      // the UI can group the statement without re-deriving accounting rules.
      byCategory: finalByCategory.map((r) => ({
        type: r.type,
        // Display name resolved from the taxonomy, so the statement reads
        // "Rent Expense" rather than a node id.
        category: (r.finance_category_id ? CATEGORY_NAME.get(r.finance_category_id) : null) ?? r.category,
        categoryId: r.finance_category_id ?? null,
        total: r.total,
        classification: r.type === 'expense' ? classifyExpenseRow(r) : null,
      })),
      // NOT part of the trading result. Reported, never hidden.
      nonOperating: {
        capitalExpenditure,
        nonExpenseCashMovement,
      },
      transfers: {
        capitalInjection,
        profitDistribution,
        budgetCharged,
        savingTransferred,
      },
    });
  })
);

export default financeRouter;