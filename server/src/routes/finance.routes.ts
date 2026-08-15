import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource, hasLegacyRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
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
const stmtUpdateBudgetLineClassify = db.prepare('UPDATE budget_lines SET cost_type = ?, is_marketing = ? WHERE id = ?');
const stmtUpdateBudgetLineCharge = db.prepare('UPDATE budget_lines SET current_amount = current_amount + ?, allocated_amount = allocated_amount + ? WHERE id = ?');
const stmtUpdateBudgetLineClear = db.prepare('UPDATE budget_lines SET current_amount = 0 WHERE id = ?');
const stmtUpdateBudgetLineAddAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount + ? WHERE id = ?');
const stmtUpdateBudgetLineSubAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?');

const stmtInsertFinTx = db.prepare(
  `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const stmtGetAllBudgetLines = db.prepare('SELECT * FROM budget_lines ORDER BY id');
const stmtGetBudgetLinesByBranch = db.prepare('SELECT * FROM budget_lines WHERE branch_id = ? ORDER BY id');

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

const stmtGetIncomeTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'income'`);
const stmtGetIncomeTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'income' AND branch_id = ?`);
const stmtGetExpenseTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'expense'`);
const stmtGetExpenseTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'expense' AND branch_id = ?`);
const stmtGetTodayIncomeTotalAll = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'income' AND date = ?`);
const stmtGetTodayIncomeTotalByBranch = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE type = 'income' AND date = ? AND branch_id = ?`);
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

function mapBudgetLine(row: any) {
  if (!row) return row;
  return {
    id: row.id, name: row.name, allocatedAmount: row.allocated_amount, currentAmount: row.current_amount,
    branchId: row.branch_id, costType: row.cost_type, isMarketing: !!row.is_marketing, purpose: row.purpose,
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
  const category = opts.budgetLine.purpose || 'utility';
  const methodLabel = opts.paymentMethod === 'card' ? 'card' : opts.paymentMethod === 'bank_transfer' ? 'bank transfer' : 'cash';
  
  const updated = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?').run(opts.amount, opts.budgetLine.id, opts.amount);
  if (updated.changes !== 1) throw new HttpError(409, `Insufficient budget on "${opts.budgetLine.name}" or the balance changed. Please retry.`);
  stmtInsertFinTx.run(
    id('tx'), 'expense', category, opts.amount, opts.date,
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
    const monthStart = `${todayStr.slice(0, 7)}-01`;

    // Balances (organization treasury for owner scope, branch account otherwise).
    const account = isAll ? getFinanceAccount('organization', 'global') : getFinanceAccount('branch', branchId!);

    // Ledger movement helpers — bound parameters only, never string concatenation.
    const ledgerTotals = (type: 'income' | 'expense', from: string, to: string) => {
      const where = isAll ? ' AND date >= ? AND date <= ?' : ' AND branch_id = ? AND date >= ? AND date <= ?';
      const params = isAll ? [from, to] : [branchId, from, to];
      return Number((db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type = ?${where}`).get(type, ...params) as { v: number }).v || 0);
    };

    const todayIncome = ledgerTotals('income', todayStr, todayStr);
    const todayExpense = ledgerTotals('expense', todayStr, todayStr);
    const monthIncome = ledgerTotals('income', monthStart, todayStr);
    const monthExpense = ledgerTotals('expense', monthStart, todayStr);

    // Budget utilization.
    const budgetRows = (isAll
      ? db.prepare('SELECT id, name, allocated_amount, current_amount FROM budget_lines ORDER BY name').all()
      : db.prepare('SELECT id, name, allocated_amount, current_amount FROM budget_lines WHERE branch_id = ? ORDER BY name').all(branchId)) as Array<{ id: string; name: string; allocated_amount: number; current_amount: number }>;

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
      ? db.prepare(`SELECT i.id, i.net_amount, i.status, i.due_date, i.branch_id,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') AS paid
          FROM invoices i`).all()
      : db.prepare(`SELECT i.id, i.net_amount, i.status, i.due_date, i.branch_id,
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') AS paid
          FROM invoices i WHERE i.branch_id = ?`).all(branchId)) as Array<{ id: string; net_amount: number; status: string; due_date: string | null; branch_id: string; paid: number }>;

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

    const collectedThisMonth = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status = 'completed' AND date LIKE ?${isAll ? '' : ' AND branch_id = ?'}`).get(`${monthStart.slice(0, 7)}%`, ...(isAll ? [] : [branchId])) as { v: number }).v || 0);

    // Pending approvals.
    const pending = (isAll
      ? db.prepare(`SELECT id, title, amount, requester, date FROM expense_requests WHERE status = 'pending' ORDER BY date DESC`).all()
      : db.prepare(`SELECT id, title, amount, requester, date FROM expense_requests WHERE status = 'pending' AND branch_id = ? ORDER BY date DESC`).all(branchId)) as Array<{ id: string; title: string; amount: number; requester: string; date: string }>;
    const pendingValue = pending.reduce((s, p) => s + Number(p.amount || 0), 0);

    // Recent ledger activity.
    const recent = (isAll
      ? db.prepare(`SELECT id, date, type, category, amount, description, operator_name, branch_id FROM financial_transactions ORDER BY date DESC, rowid DESC LIMIT 10`).all()
      : db.prepare(`SELECT id, date, type, category, amount, description, operator_name, branch_id FROM financial_transactions WHERE branch_id = ? ORDER BY date DESC, rowid DESC LIMIT 10`).all(branchId)) as Array<{ id: string; date: string; type: string; category: string; amount: number; description: string; operator_name: string; branch_id: string }>;

    // 14-day income/expense trend.
    const trendFrom = new Date(todayStr);
    trendFrom.setDate(trendFrom.getDate() - 13);
    const trendRows = (isAll
      ? db.prepare(`SELECT date,
            COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END),0) AS expense
          FROM financial_transactions WHERE date >= ? GROUP BY date ORDER BY date`).all(trendFrom.toISOString().slice(0, 10))
      : db.prepare(`SELECT date,
            COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END),0) AS expense
          FROM financial_transactions WHERE branch_id = ? AND date >= ? GROUP BY date ORDER BY date`).all(branchId, trendFrom.toISOString().slice(0, 10))) as Array<{ date: string; income: number; expense: number }>;
    const trendMap = new Map(trendRows.map((r) => [r.date, r]));
    const trend: Array<{ date: string; income: number; expense: number }> = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(trendFrom);
      d.setDate(trendFrom.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const row = trendMap.get(key);
      trend.push({ date: key, income: Number(row?.income || 0), expense: Number(row?.expense || 0) });
    }

    res.json({
      scope: isAll ? 'organization' : 'branch',
      branchId: branchId || null,
      balances: { main: account.mainBalance, saving: account.savingBalance },
      today: { income: todayIncome, expense: todayExpense, net: todayIncome - todayExpense },
      month: { income: monthIncome, expense: monthExpense, net: monthIncome - monthExpense },
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

financeRouter.put(
  '/budget-lines/:id/classify',
  requirePermission('Budget.Allocate', 'Budget.Edit', 'Expense.Approve'),
  ah(async (req, res) => {
    const budgetLine = requireBudgetLine(req, req.params.id);
    const { costType, isMarketing } = req.body as { costType?: 'fixed' | 'variable'; isMarketing?: boolean };
    if (costType && !['fixed', 'variable'].includes(costType)) throw new HttpError(400, 'Invalid cost type.');
    
    stmtUpdateBudgetLineClassify.run(
      costType ?? budgetLine.cost_type,
      isMarketing != null ? (isMarketing ? 1 : 0) : budgetLine.is_marketing,
      req.params.id
    );
    writeAudit(req, `Classified budget line "${budgetLine.name}" as ${costType === 'variable' ? 'variable' : 'fixed'} cost`);
    res.json({ ok: true });
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
        id('tx'), 'budget_charge', 'utility', amount, date,
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
          id('tx'), 'budget_charge', 'utility', unusedAmount, date,
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
          id('tx'), 'saving_transfer', 'utility', unusedAmount, date,
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
        id('tx'), 'income', 'capital_injection', amount, date,
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
    
    if (!title?.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !budgetLine) {
      throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.');
    }
    
    const { expenseKind, paymentMethod, billPeriod, notes } = normalizeExpenseMeta(req.body);
    const newId = id('req');
    stmtInsertExpenseRequest.run(
      newId, title, amount, budgetLineId, user.fullName, 'pending', today(), user.branchId,
      expenseKind, billPeriod, paymentMethod, notes, 0, user.userId, null
    );
    
    addNotification('New expense request', `Expense request "${title}" for ${amount} AFN against budget ${budgetLine.name} is pending approval.`, 'info', user.branchId);
    writeAudit(req, `Created expense request: ${title} for ${amount} AFN against budget ${budgetLine.name}`);
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
    
    const resolvedAmount = Number(amount);
    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;
    if (budgetLine) requireBudgetLine(req, String(budgetLineId));
    if (!title?.trim() || !Number.isFinite(resolvedAmount) || resolvedAmount <= 0 || !budgetLine) {
      throw new HttpError(400, 'Title, a valid amount, and a budget line are required.');
    }

    const { expenseKind, paymentMethod, billPeriod, notes } = normalizeExpenseMeta(req.body);
    const threshold = getNumberSetting('expense_auto_approve_threshold', SYSTEM_DEFAULTS.expenseAutoApproveThreshold);
    const shouldAutoPay = !requireApproval && (resolvedAmount <= threshold || hasLegacyRole(req, 'owner'));

    const date = today();
    const newId = id('req');

    if (!shouldAutoPay) {
      stmtInsertExpenseRequest.run(
        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'pending', date, user.branchId,
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
        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'approved', date, user.branchId,
        expenseKind, billPeriod, paymentMethod, notes, 1, user.userId, user.userId
      );
      db.prepare("UPDATE expense_requests SET approved_by = ? WHERE id = ?").run(user.fullName, newId);
      
      payFromBudgetLine({
        budgetLine, amount: resolvedAmount, title: title.trim(), date, operatorName: user.fullName, branchId: user.branchId, requestId: newId, paymentMethod,
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

    const datePattern = month === 'all' ? `${year}-%` : `${year}-${month.padStart(2, '0')}-%`;
    
    const allRequests = isAll 
      ? stmtGetAllExpenseRequests.all() as any[] 
      : stmtGetExpenseRequestsByBranch.all(branchId) as any[];
    
    const filtered = allRequests.filter(er => er.status === 'approved' && er.date.startsWith(datePattern));

    const rowsMap = new Map<string, { budgetLineId: string; budgetLineName: string; purpose: string; costType: string; totalAmount: number; count: number }>();
    const byKindMap = new Map<string, { kind: string; total: number; count: number }>();

    for (const er of filtered) {
      const bl = stmtGetBudgetLineById.get(er.budget_line_id) as any;
      const bId = er.budget_line_id || 'unknown';
      const bName = bl?.name || 'Unknown';
      const purpose = bl?.purpose || 'other';
      const costType = bl?.cost_type || 'variable';
      
      if (!rowsMap.has(bId)) rowsMap.set(bId, { budgetLineId: bId, budgetLineName: bName, purpose, costType, totalAmount: 0, count: 0 });
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
    const totalExpense = rows.reduce((s, r) => s + r.totalAmount, 0);

    res.json({
      year, month, rows, totalExpense, byKind,
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
    if (request.requester_user_id && request.requester_user_id === user.userId && !hasLegacyRole(req, 'owner')) throw new HttpError(403, 'Requester and approver must be different users.');
    if (!request.branch_id || !canAccessBranchResource(req, request.branch_id)) throw new HttpError(403, 'Expense request belongs to another branch.');

    const budgetLine = requireBudgetLine(req, String(request.budget_line_id));
    if (budgetLine.branch_id !== request.branch_id) throw new HttpError(409, 'Expense request and budget line belong to different branches.');
    
    const { isApproved, rejectReason } = req.body as { isApproved: boolean; rejectReason?: string };
    if (typeof isApproved !== 'boolean') throw new HttpError(400, 'isApproved must be a boolean.');
    
    if (!isApproved) {
      stmtUpdateExpenseRequestRejected.run(rejectReason || 'Rejected by the course owner', user.fullName, user.userId, request.id);
      addNotification('Budget request rejected', `Request "${request.title}" was rejected by the course owner. Reason: ${rejectReason || 'Not specified'}`, 'alert', user.branchId);
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
    let sql = `SELECT type, category, COALESCE(SUM(amount), 0) AS total FROM financial_transactions WHERE 1=1`;
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
    
    sql += ' GROUP BY type, category ORDER BY type, category';
    
    const finalByCategory = db.prepare(sql).all(...params) as any[];

    // Operating P&L accounting semantics (single source of truth):
    //  - income: type='income' EXCEPT capital injections (balance-sheet funding).
    //  - expense: type='expense' EXCEPT profit distributions (owner draws).
    //  - budget_charge and saving_transfer are balance-sheet transfers between
    //    treasury/saving/budget accounts, never operating income or expense.
    //  - refunds are already recorded as negative income (contra-revenue) and
    //    therefore reduce operating income.
    let income = 0;
    let expense = 0;
    let capitalInjection = 0;
    let profitDistribution = 0;
    let budgetCharged = 0;
    let savingTransferred = 0;

    for (const row of finalByCategory) {
      if (row.type === 'income' && row.category === 'capital_injection') capitalInjection += row.total;
      else if (row.type === 'income') income += row.total;
      else if (row.type === 'expense' && row.category === 'profit_distribution') profitDistribution += row.total;
      else if (row.type === 'expense') expense += row.total;
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
      byCategory: finalByCategory.map((r) => ({ type: r.type, category: r.category, total: r.total })),
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