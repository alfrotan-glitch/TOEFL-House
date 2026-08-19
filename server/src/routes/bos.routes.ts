import { Router } from 'express';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import { db } from '../db/connection.js';
import { getBranchOutstanding } from '../utils/studentBalance.js';
import { authenticate, authorize, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { hasRole, isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { getNumberSetting, setSetting } from '../utils/settings.js';
import { getFinanceAccount, decrementMainBalanceIfSufficient } from '../utils/financeAccounts.js';
import { addNotification } from '../utils/notifications.js';
import { assertMoney } from '../utils/money.js';

export const bosRouter = Router();
bosRouter.use(authenticate, authorize('owner', 'finance', 'manager')); // Read-only dashboard access for authorized finance/management roles

function requireBosBranch(req: import('express').Request): string {
  const { branchId, isAll } = resolveBranchScope(req);
  if (isAll || !branchId) throw new HttpError(400, 'A concrete branch scope is required.');
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Branch access denied.');
  return branchId;
}

function requireOwner(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  if (!req.rbac || !isGlobalOwner(req.rbac)) {
    return res.status(403).json({ error: 'Owner authorization is required for this operation.' });
  }
  next();
}

// ── Time Bounds Helper (Supports Today, Month, Year) ──────────────────────
function getTimeBounds(period?: string, timeframe?: string) {
  const todayStr = today();
  
  // Explicit period override (e.g., '2024-05' or '2024-05-01')
  if (period) {
    if (period.length === 10) return { from: period, to: period, period };
    if (period.length === 7) return { from: `${period}-01`, to: `${period}-31`, period };
    if (period.length === 4) return { from: `${period}-01-01`, to: `${period}-12-31`, period };
  }

  const tf = timeframe || 'month';
  if (tf === 'today') {
    return { from: todayStr, to: todayStr, period: todayStr };
  }
  if (tf === 'year') {
    const year = todayStr.slice(0, 4);
    return { from: `${year}-01-01`, to: `${year}-12-31`, period: year };
  }
  // Default to month
  const month = todayStr.slice(0, 7);
  return { from: `${month}-01`, to: `${month}-31`, period: month };
}

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtTodayRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as revenue FROM financial_transactions WHERE type='income' AND date=? AND branch_id=?`);
const stmtMonthlyRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as revenue FROM financial_transactions WHERE type='income' AND date BETWEEN ? AND ? AND branch_id=?`);
const stmtMonthlyExpense = db.prepare(`SELECT COALESCE(SUM(amount),0) as expense FROM financial_transactions WHERE type='expense' AND date BETWEEN ? AND ? AND branch_id=?`);
const stmtFixedTotal = db.prepare(`SELECT COALESCE(SUM(allocated_amount),0) as fixedTotal FROM budget_lines WHERE branch_id=? AND cost_type='fixed'`);
// BOS-1: profit distributions ALREADY taken in the period.
//
// The withdrawable ceiling is a share of profit, and a withdrawal is booked as
// an expense — so it lowers profit by 100% of itself while the ceiling is only
// 20% of profit. Each payout therefore removed just a fifth of itself from the
// limit and the limit replenished instead of closing. Proven live: a branch
// with a published 32,000 AFN monthly maximum paid out 140,630 AFN over ten
// sequential calls (4.4x the cap, 70% of all revenue) with every individual
// request passing its own check.
//
// The gross profit (before distributions) is the basis for the tier, and the
// amount already distributed is subtracted from the ceiling, so the period
// total can never exceed the figure the calculate endpoint published.
const stmtPeriodDistributed = db.prepare(
  `SELECT COALESCE(SUM(amount),0) as distributed FROM financial_transactions
    WHERE category='profit_distribution' AND date BETWEEN ? AND ? AND branch_id=?`
);
const stmtVariableTotal = db.prepare(`SELECT COALESCE(SUM(allocated_amount),0) as variableTotal FROM budget_lines WHERE branch_id=? AND cost_type='variable'`);
const stmtTeacherCost = db.prepare(`SELECT COALESCE(SUM(amount),0) as teacherCost FROM financial_transactions WHERE category='salary' AND type='expense' AND date BETWEEN ? AND ? AND branch_id=?`);

const stmtMarketingCost = db.prepare(
  `SELECT COALESCE(SUM(amount),0) as c FROM financial_transactions 
   WHERE type='expense' AND reference_id IN (SELECT id FROM budget_lines WHERE branch_id=? AND is_marketing=1) 
   AND date BETWEEN ? AND ?`
);

// Outstanding = what the student actually OWES. Two corrections:
//  - use net_fee_amount (post-discount); the gross fee_amount overstated the
//    debt of every discounted student (proven: 6,000 reported vs 3,000 real).
//  - count 'installment' payments as well as 'fee'; an installment pays down
//    exactly the same tuition debt.
// Outstanding tuition now comes from the shared authoritative helper
// (server/src/utils/studentBalance.ts) so the dashboard, the student profile,
// the roster list, the portal and the enrollment hold cannot drift apart.
// Two corrections it carries over and one it adds:
//  - net_fee_amount (post-discount); the gross fee overstated discounted debt.
//  - 'installment' pays down the same tuition debt as 'fee'.
//  - NEW: 'refund' is included. Refunds are stored signed-negative, so leaving
//    them out credited the student with money that had been handed back and
//    understated branch debt for every refunded student.
// Per-student outstanding is floored at zero so one student's credit balance
// cannot mask another student's debt.

const stmtNewStudentsCount = db.prepare(`SELECT COUNT(*) as count FROM students WHERE registration_date BETWEEN ? AND ? AND branch_id=?`);
const stmtClassAvgSize = db.prepare(`
  SELECT AVG(enrolled) as avgSize FROM (
    SELECT c.id, COUNT(ss.student_id) as enrolled
    FROM classes c LEFT JOIN student_semesters ss ON ss.class_id = c.id
    WHERE c.branch_id = ? AND c.status = 'active'
    GROUP BY c.id
  )
`);

const stmtMarketingFunnel = db.prepare(`
  SELECT
    source,
    COUNT(*) as leads,
    SUM(CASE WHEN placement_score IS NOT NULL THEN 1 ELSE 0 END) as placementTests,
    SUM(CASE WHEN ${LEAD_CONVERTED_SQL} THEN 1 ELSE 0 END) as registrations
  FROM visitors
  WHERE branch_id = ? AND visit_date BETWEEN ? AND ?
  GROUP BY source
`);
const stmtRevenueBySource = db.prepare(`
  SELECT COALESCE(SUM(p.amount), 0) as total
  FROM payments p
  JOIN students s ON s.id = p.student_id
  JOIN visitors v ON v.id = s.lead_id
  WHERE v.source = ? AND p.category = 'fee' AND s.branch_id = ? AND p.date BETWEEN ? AND ?
`);

const stmtReturningStudents = db.prepare(`
  SELECT COUNT(DISTINCT ss.student_id) as returningCount FROM student_semesters ss
  JOIN students s ON s.id = ss.student_id
  WHERE s.branch_id = ? AND ss.enroll_date BETWEEN ? AND ? AND ss.student_id IN (
    SELECT student_id FROM student_semesters WHERE enroll_date < ?
  )
`);
const stmtDropouts = db.prepare(`SELECT COUNT(*) as dropouts FROM students WHERE branch_id=? AND status='inactive'`);
const stmtGraduates = db.prepare(`SELECT COUNT(*) as graduates FROM students WHERE branch_id=? AND status='graduated'`);
const stmtTotalStudents = db.prepare(`SELECT COUNT(*) as total FROM students WHERE branch_id=?`);
const stmtActiveStudents = db.prepare(`SELECT COUNT(*) as active FROM students WHERE branch_id=? AND status='active'`);
const stmtPlacementLevels = db.prepare(`SELECT placement_score FROM students WHERE branch_id=? AND placement_score IS NOT NULL`);

const stmtLowClasses = db.prepare(`
  SELECT c.name, c.min_viable_size, COUNT(ss.student_id) as enrolled
  FROM classes c LEFT JOIN student_semesters ss ON ss.class_id = c.id
  WHERE c.branch_id = ? AND c.status = 'active' AND c.min_viable_size > 0
  GROUP BY c.id
  HAVING enrolled < c.min_viable_size
`);
const stmtUnderperformingTeachers = db.prepare(`SELECT full_name, performance_score FROM teachers WHERE branch_id=? AND status='active' AND performance_score < 80`);

const stmtInsertFinTx = db.prepare(
  `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
   VALUES (?, 'expense', 'profit_distribution', ?, ?, ?, ?, ?, ?)`
);

// NEW: Profitability Analytics Statements
// Each payment is attributed to EXACTLY ONE class. Joining payments to every
// active semester multiplied revenue by the number of semesters a student
// held (proven: one 9,999 payment reported as 19,998 across two classes).
// The correlated subquery picks a single owning semester — matched by name
// when the payment records one, else the student's most recent active one.
const stmtRevenueByClass = db.prepare(`
  SELECT c.name, SUM(p.amount) as revenue
  FROM payments p
  JOIN student_semesters ss ON ss.id = (
    SELECT s2.id FROM student_semesters s2
    WHERE s2.student_id = p.student_id
      AND (p.semester IS NULL OR s2.semester_name = p.semester)
    ORDER BY (s2.status = 'active') DESC, s2.enroll_date DESC
    LIMIT 1
  )
  JOIN classes c ON c.id = ss.class_id
  WHERE p.category IN ('fee', 'installment') AND p.status = 'completed' 
  AND c.branch_id = ? AND p.date BETWEEN ? AND ?
  GROUP BY c.id
  ORDER BY revenue DESC
  LIMIT 5
`);

// Same single-attribution rule as stmtRevenueByClass above.
const stmtRevenueByTimeSlot = db.prepare(`
  SELECT COALESCE(c.schedule_time, 'Unknown') as slot, SUM(p.amount) as revenue
  FROM payments p
  JOIN student_semesters ss ON ss.id = (
    SELECT s2.id FROM student_semesters s2
    WHERE s2.student_id = p.student_id
      AND (p.semester IS NULL OR s2.semester_name = p.semester)
    ORDER BY (s2.status = 'active') DESC, s2.enroll_date DESC
    LIMIT 1
  )
  JOIN classes c ON c.id = ss.class_id
  WHERE p.category IN ('fee', 'installment') AND p.status = 'completed' 
  AND c.branch_id = ? AND p.date BETWEEN ? AND ?
  GROUP BY c.schedule_time
  ORDER BY revenue DESC
`);

// ================= Executive Dashboard =================
bosRouter.get(
  '/executive-dashboard',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to, period } = getTimeBounds(req.query.period as string, req.query.timeframe as string);
    const todayStr = today();

    const todayRevenue = (stmtTodayRevenue.get(todayStr, branchId) as any).revenue;
    const monthlyRevenue = (stmtMonthlyRevenue.get(from, to, branchId) as any).revenue;
    const monthlyExpense = (stmtMonthlyExpense.get(from, to, branchId) as any).expense;
    const breakEven = (stmtFixedTotal.get(branchId) as any).fixedTotal;
    const variableTotal = (stmtVariableTotal.get(branchId) as any).variableTotal;
    const teacherCost = (stmtTeacherCost.get(from, to, branchId) as any).teacherCost;
    const marketingCost = (stmtMarketingCost.get(branchId, from, to) as any).c;
    const outstandingTuition = getBranchOutstanding(db, branchId);

    const financeAccount = getFinanceAccount('branch', branchId);
    const mainAccountBalance = financeAccount.mainBalance;
    const savingBalance = financeAccount.savingBalance;

    const newThisMonth = (stmtNewStudentsCount.get(from, to, branchId) as any).count;
    const prevMonthDate = new Date(`${from}T00:00:00`);
    prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
    const prevPeriod = prevMonthDate.toISOString().slice(0, 7);
    const newLastMonth = (stmtNewStudentsCount.get(`${prevPeriod}-01`, `${prevPeriod}-31`, branchId) as any).count;

    const classAvgRow = stmtClassAvgSize.get(branchId) as any;

    const profit = monthlyRevenue - monthlyExpense;
    const profitMargin = monthlyRevenue > 0 ? (profit / monthlyRevenue) * 100 : 0;
    const reserveFundTarget = breakEven * 6;

    res.json({
      period,
      todayRevenue,
      monthlyRevenue, // This now represents revenue for the selected timeframe
      monthlyExpense, // This now represents expense for the selected timeframe
      breakEven,
      fixedCosts: breakEven,
      variableCosts: variableTotal,
      profit,
      profitMargin: Math.round(profitMargin * 10) / 10,
      cashAvailable: mainAccountBalance,
      cashBalance: mainAccountBalance + savingBalance,
      reserveFundBalance: savingBalance,
      reserveFundTarget,
      reserveFundProgress: reserveFundTarget > 0 ? Math.min(100, Math.round((savingBalance / reserveFundTarget) * 100)) : 0,
      outstandingPayments: outstandingTuition,
      teacherCost,
      marketingCost,
      marketingROI: marketingCost > 0 ? Math.round(((monthlyRevenue - marketingCost) / marketingCost) * 100) : null,
      studentGrowth: newThisMonth - newLastMonth,
      newStudentsThisMonth: newThisMonth,
      newStudentsLastMonth: newLastMonth,
      averageClassSize: classAvgRow.avgSize ? Math.round(classAvgRow.avgSize * 10) / 10 : 0,
    });
  })
);

// ================= Marketing Funnel =================
bosRouter.get(
  '/marketing-funnel',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);

    const rows = stmtMarketingFunnel.all(branchId, from, to) as any[];

    const revenueBySource: Record<string, number> = {};
    for (const r of rows) {
      const rev = stmtRevenueBySource.get(r.source, branchId, from, to) as any;
      revenueBySource[r.source] = rev.total;
    }

    const totalMarketingCost = (stmtMarketingCost.get(branchId, from, to) as any).c;

    const funnel = rows.map(r => ({
      source: r.source,
      leads: r.leads,
      placementTests: r.placementTests,
      registrations: r.registrations,
      revenue: revenueBySource[r.source] || 0,
      conversionRate: r.leads > 0 ? Math.round((r.registrations / r.leads) * 1000) / 10 : 0,
    }));

    const totalRevenue = funnel.reduce((sum, f) => sum + f.revenue, 0);

    res.json({
      funnel,
      totalMarketingCost,
      totalRevenue,
      overallROI: totalMarketingCost > 0 ? Math.round(((totalRevenue - totalMarketingCost) / totalMarketingCost) * 100) : null,
    });
  })
);

// ================= Student Analytics =================
bosRouter.get(
  '/student-analytics',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);

    const newStudents = (stmtNewStudentsCount.get(from, to, branchId) as any).count;
    const returningCount = (stmtReturningStudents.get(branchId, from, to, from) as any).returningCount;
    const dropouts = (stmtDropouts.get(branchId) as any).dropouts;
    const graduates = (stmtGraduates.get(branchId) as any).graduates;
    const total = (stmtTotalStudents.get(branchId) as any).total;
    const active = (stmtActiveStudents.get(branchId) as any).active;

    const placementLevels = stmtPlacementLevels.all(branchId) as any[];
    const levelCounts: Record<string, number> = {};
    for (const row of placementLevels) {
      try {
        const score = JSON.parse(row.placement_score);
        const level = score.levelRecommendation || 'Unknown';
        levelCounts[level] = (levelCounts[level] || 0) + 1;
      } catch { /* skip malformed */ }
    }

    res.json({
      newStudents,
      returningStudents: returningCount,
      dropouts,
      graduates,
      totalStudents: total,
      activeStudents: active,
      completionRate: total > 0 ? Math.round((graduates / total) * 1000) / 10 : 0,
      placementLevels: levelCounts,
    });
  })
);

// ================= Decision Warnings =================
bosRouter.get(
  '/decision-warnings',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const warnings: { severity: 'info' | 'warning' | 'critical'; title: string; message: string }[] = [];
    const { from, to } = getTimeBounds(undefined, 'month'); // Warnings always check current month health

    const revenue = (stmtMonthlyRevenue.get(from, to, branchId) as any).revenue;
    const fixedTotal = (stmtFixedTotal.get(branchId) as any).fixedTotal;

    if (revenue < fixedTotal) {
      warnings.push({
        severity: 'warning',
        title: 'Monthly revenue has not reached break-even',
        message: `Current month revenue (${Math.round(revenue).toLocaleString()} AFN) is still below fixed costs (${Math.round(fixedTotal).toLocaleString()} AFN). Consider postponing new hires or non-essential expenses until the situation improves.`,
      });
    }

    const mainAccountBalance = getFinanceAccount('branch', branchId).mainBalance;
    const monthlyFixed = fixedTotal || 1;
    if (mainAccountBalance < monthlyFixed * 2) {
      warnings.push({
        severity: 'critical',
        title: 'Cash reserve is below two months of fixed costs',
        message: `Main account balance (${Math.round(mainAccountBalance).toLocaleString()} AFN) is less than twice the monthly fixed costs. Avoid any large capital purchases.`,
      });
    }

    const lowClasses = stmtLowClasses.all(branchId) as any[];
    for (const cls of lowClasses) {
      warnings.push({
        severity: 'warning',
        title: `Class "${cls.name}" is below minimum viable size`,
        message: `This class has ${cls.enrolled} students, while the economic minimum is ${cls.min_viable_size}. Consider merging with a similar class rather than reducing teaching quality.`,
      });
    }

    const underperformingTeachers = stmtUnderperformingTeachers.all(branchId) as any[];
    for (const t of underperformingTeachers) {
      warnings.push({
        severity: 'info',
        title: `Teacher ${t.full_name} performance is below 80%`,
        message: `Current performance score: ${t.performance_score}%. Supplementary training is recommended; if repeated, class assignment review is needed.`,
      });
    }

    res.json({ warnings });
  })
);

// ================= Tiered Profit Distribution =================
function profitDistributionTier(marginPercent: number): number {
  if (marginPercent < 10) return 0;
  if (marginPercent < 20) return 10;
  if (marginPercent < 30) return 15;
  return 20;
}

bosRouter.get(
  '/profit-distribution/calculate',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);

    const revenue = (stmtMonthlyRevenue.get(from, to, branchId) as any).revenue;
    const expense = (stmtMonthlyExpense.get(from, to, branchId) as any).expense;
    const fixedTotal = (stmtFixedTotal.get(branchId) as any).fixedTotal;

    const distributed = (stmtPeriodDistributed.get(from, to, branchId) as any).distributed;
    // Gross profit excludes distributions already taken, so paying one out does
    // not lower the tier and re-open the ceiling (BOS-1).
    const profit = revenue - expense + distributed;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const tierPercent = profitDistributionTier(margin);
    const reserveFundTarget = fixedTotal * 6;
    const reserveFundBalance = getFinanceAccount('branch', branchId).savingBalance;
    const reserveMet = reserveFundBalance >= reserveFundTarget;
    const periodAllowance = profit > 0 ? Math.round((profit * tierPercent) / 100) : 0;
    // What is still available, not what was available before anything was paid.
    const maxWithdrawable = reserveMet ? Math.max(0, periodAllowance - distributed) : 0;

    res.json({
      period: req.query.period || today().slice(0, 7),
      revenue, expense, profit: revenue - expense,
      profitMargin: Math.round(margin * 10) / 10,
      tierPercent,
      reserveFundTarget,
      reserveFundBalance,
      reserveFundMet: reserveMet,
      periodAllowance,
      alreadyDistributed: distributed,
      maxWithdrawable,
    });
  })
);

bosRouter.post(
  '/profit-distribution/withdraw',
  requireOwner,
  ah(async (req, res) => {
    const rawAmount = req.body?.amount;
    let amount: number;
    try { amount = assertMoney(rawAmount, 'withdrawal amount'); } catch { throw new HttpError(400, 'Withdrawal amount must be a valid positive monetary amount.'); }
    if (amount <= 0) throw new HttpError(400, 'Invalid withdrawal amount.');

    const user = req.user;
    if (!user?.branchId || !user?.fullName) throw new HttpError(403, 'User context is missing.');

    const branchId = requireBosBranch(req);
    const recipientPartnerId = req.body?.recipientPartnerId ? String(req.body.recipientPartnerId) : null;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 2000) : null;
    if (recipientPartnerId && !db.prepare('SELECT id FROM partners WHERE id = ?').get(recipientPartnerId)) {
      throw new HttpError(404, 'Recipient partner was not found.');
    }

    const result = db.transaction(() => {
      // Recompute every limit under the same write lock as the cash decrement.
      const { from, to } = getTimeBounds(undefined, 'month');
      const revenue = Number((stmtMonthlyRevenue.get(from, to, branchId) as any).revenue || 0);
      const expense = Number((stmtMonthlyExpense.get(from, to, branchId) as any).expense || 0);
      const fixedTotal = Number((stmtFixedTotal.get(branchId) as any).fixedTotal || 0);
      const distributed = assertMoney(
        Number((stmtPeriodDistributed.get(from, to, branchId) as any).distributed || 0),
        'distributed this period',
      );
      // Gross profit, i.e. before profit distributions (BOS-1).
      const profit = assertMoney(revenue - expense + distributed, 'calculated profit', { allowNegative: true });
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
      const tierPercent = profitDistributionTier(margin);
      const reserveFundTarget = assertMoney(fixedTotal * 6, 'reserve target');
      const reserveFundBalance = assertMoney(getFinanceAccount('branch', branchId).savingBalance, 'reserve balance');

      if (reserveFundBalance < reserveFundTarget) {
        throw new HttpError(409, `Profit withdrawal not allowed: the contingency reserve fund has not yet reached its 6-month target (${Math.round(reserveFundBalance).toLocaleString()} of ${Math.round(reserveFundTarget).toLocaleString()} AFN).`);
      }

      const periodAllowance = Math.max(0, assertMoney((profit * tierPercent) / 100, 'maximum withdrawal', { allowNegative: true }));
      // The ceiling applies to the PERIOD, not to each request.
      const maxWithdrawable = Math.max(0, assertMoney(periodAllowance - distributed, 'remaining withdrawal allowance', { allowNegative: true }));
      if (amount > maxWithdrawable) {
        throw new HttpError(409, `Requested amount exceeds this month's remaining withdrawable limit (${maxWithdrawable.toLocaleString()} AFN of a ${periodAllowance.toLocaleString()} AFN allowance based on a ${Math.round(margin)}% profit margin; ${distributed.toLocaleString()} AFN already distributed).`);
      }

      const currentMainBalance = assertMoney(getFinanceAccount('branch', branchId).mainBalance, 'main account balance');
      if (amount > currentMainBalance) throw new HttpError(409, 'Insufficient cash balance in the main account for this withdrawal.');

      if (!decrementMainBalanceIfSufficient('branch', branchId, amount)) {
        throw new HttpError(409, 'Insufficient branch cash balance or balance changed.');
      }
      const date = today();
      stmtInsertFinTx.run(
        id('tx'), amount, date,
        `Management profit withdrawal (${tierPercent}% of ${Math.round(margin)}% profit margin)${notes ? ' — ' + notes : ''}`,
        recipientPartnerId, user.fullName, branchId
      );
      return { maxWithdrawable, margin, tierPercent };
    })();

    addNotification('Profit withdrawal recorded', `${amount.toLocaleString()} AFN has been deducted from the main account as a management profit withdrawal.`, 'info', branchId);
    writeAudit(req, `Management profit withdrawal of ${amount} AFN (this month's max: ${result.maxWithdrawable} AFN)`);
    res.status(201).json({ ok: true, ...result });
  })
);
// ================= NEW: Profitability Analytics =================
bosRouter.get(
  '/revenue-by-class',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);
    const rows = stmtRevenueByClass.all(branchId, from, to) as any[];
    res.json(rows.map(r => ({ name: r.name, revenue: r.revenue || 0 })));
  })
);

bosRouter.get(
  '/revenue-by-timeslot',
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);
    const rows = stmtRevenueByTimeSlot.all(branchId, from, to) as any[];
    res.json(rows.map(r => ({ slot: r.slot, revenue: r.revenue || 0 })));
  })
);

export default bosRouter;