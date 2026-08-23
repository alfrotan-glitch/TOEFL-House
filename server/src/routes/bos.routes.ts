import { Router } from 'express';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import { db } from '../db/connection.js';
import { getBranchOutstanding, CASH_ALLOCATION_SQL } from '../utils/studentBalance.js';
import { authenticate, requirePermission, requireGlobalOwner, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { getFinanceAccount, decrementMainBalanceIfSufficient } from '../utils/financeAccounts.js';
import { addNotification } from '../utils/notifications.js';
import { assertMoney, assertComputedMoney } from '../utils/money.js';
import {
  periodBoundaries,
  periodBoundariesForKey,
  previousMonthKey,
  REPORTING_PERIODS,
  type ReportingPeriod,
} from '../core/calendar/periods.js';
import { isoToJalaliPeriodKey } from '../utils/jalali.js';
import {
  cashReserveWarningThresholdFor,
  computeProfitDistribution,
  reserveFundTargetFor,
} from '../core/finance/profit-distribution.js';
import { TREASURY_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const bosRouter = Router();
bosRouter.use(authenticate);

function requireBosBranch(req: import('express').Request): string {
  const { branchId, isAll } = resolveBranchScope(req);
  if (isAll || !branchId) throw new HttpError(400, 'A concrete branch scope is required.');
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Branch access denied.');
  return branchId;
}

/**
 * The period a BOS figure covers, resolved by the calendar authority.
 *
 * Slicing the ISO date — `${today().slice(0,7)}-01` .. `-31` — yields a
 * GREGORIAN month, while Finance, payroll, the dashboard and every report
 * resolve a SHAMSI month through `periodBoundaries` (D-28). Sampled across
 * eight dates the two windows disagree 8/8 times.
 *
 * That was not a reporting inconvenience here. The withdrawable ceiling
 * subtracts the drawings already taken in the period, and both halves are
 * queried with this window — so a window that omits part of the accounting
 * month omits the drawings taken in it and the ceiling re-opens. Proven: a
 * 50,000 drawing inside the accounting month left the published ceiling at
 * 200,000 instead of 150,000, and total drawings reached 300,000 against a
 * 200,000 ceiling.
 *
 * A sliced window also runs to the 31st — days into the future — while the
 * authority stops at today.
 *
 * An explicit period is named by its Shamsi key ('1405-05', '1405-Q2', '1405'),
 * matching how `/reports/overview` names a historical period.
 */
function getTimeBounds(period?: string, timeframe?: string) {
  if (period) {
    try {
      const explicit = periodBoundariesForKey(period);
      return { from: explicit.from, to: explicit.to, period: explicit.periodKey };
    } catch {
      throw new HttpError(
        400,
        'Period must be a Shamsi key such as 1405-05 (month), 1405-Q2 (quarter) or 1405 (year).',
      );
    }
  }

  const requested = timeframe || 'month';
  if (!(REPORTING_PERIODS as readonly string[]).includes(requested)) {
    throw new HttpError(400, `Timeframe must be one of: ${REPORTING_PERIODS.join(', ')}.`);
  }
  const bounds = periodBoundaries(requested as ReportingPeriod, today());
  return { from: bounds.from, to: bounds.to, period: bounds.periodKey };
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
    WHERE finance_category_id='sub_owner_drawings' AND date BETWEEN ? AND ? AND branch_id=?`
);

/**
 * Loads every input to the current-month withdrawal authority as one unit.
 * The read endpoint and the enforcing transaction both call this function, so
 * they cannot silently choose different periods, balances, or cost bases.
 */
function currentProfitDistributionPosition(branchId: string) {
  const { from, to, period } = getTimeBounds(undefined, 'month');
  const revenue = Number((stmtMonthlyRevenue.get(from, to, branchId) as any).revenue || 0);
  const expense = Number((stmtMonthlyExpense.get(from, to, branchId) as any).expense || 0);
  const fixedTotal = Number((stmtFixedTotal.get(branchId) as any).fixedTotal || 0);
  const distributed = assertMoney(
    Number((stmtPeriodDistributed.get(from, to, branchId) as any).distributed || 0),
    'distributed this period',
  );
  const account = getFinanceAccount('branch', branchId);
  const position = computeProfitDistribution({
    revenue,
    expense,
    distributed,
    fixedTotal,
    mainBalance: account.mainBalance,
    savingBalance: account.savingBalance,
  });
  return { from, to, period, revenue, expense, fixedTotal, position };
}

const stmtVariableTotal = db.prepare(`SELECT COALESCE(SUM(allocated_amount),0) as variableTotal FROM budget_lines WHERE branch_id=? AND cost_type='variable'`);
const stmtTeacherCost = db.prepare(`SELECT COALESCE(SUM(amount),0) as teacherCost FROM financial_transactions WHERE finance_category_id='sub_salaries_wages' AND type='expense' AND date BETWEEN ? AND ? AND branch_id=?`);

// Marketing spend is answered by the TAXONOMY.
//
// Joining the canonical tree means "marketing" is defined in exactly one place:
// anything filed under a Marketing & Promotion subcategory counts, including
// subcategories added later. A per-budget-line flag would be a second opinion
// about the same fact, free to drift from the first.
const stmtMarketingCost = db.prepare(
  `SELECT COALESCE(SUM(ft.amount),0) as c FROM financial_transactions ft
   JOIN finance_categories sub ON sub.id = ft.finance_category_id
   WHERE ft.type='expense' AND ft.branch_id=? AND sub.parent_id='cat_marketing_promotion'
   AND ft.date BETWEEN ? AND ?`
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
const stmtUnderperformingTeachers = db.prepare(
  `SELECT full_name, performance_score FROM teachers
   WHERE branch_id = ? AND status = 'active' AND performance_score < ?`,
);

const stmtInsertFinTx = db.prepare(
  `INSERT INTO financial_transactions (id, type, category, finance_category_id, amount, date, description, reference_id, operator_name, branch_id)
   VALUES (?, 'expense', 'owner_drawing', 'sub_owner_drawings', ?, ?, ?, ?, ?, ?)`
);

// NEW: Profitability Analytics Statements
// Each payment is attributed to EXACTLY ONE class. Joining payments to every
// active semester multiplied revenue by the number of semesters a student
// held (proven: one 9,999 payment reported as 19,998 across two classes).
// The correlated subquery picks a single owning semester — matched by name
// when the payment records one, else the student's most recent active one.
// Revenue is attributed through the settlement authority: a tuition payment
// names the obligation it settles, the obligation names the term, and the term
// names the class. Nothing is guessed.
//
// A term NAME cannot carry this: `uq_student_semester_active` scopes uniqueness
// to ACTIVE terms, so a student repeating a term has two terms under one name.
// Matching by name and preferring the active one handed money paid for a
// finished class to the class running now (WP07-F22).
//
// Only ACTIVE allocations count, so a refunded amount stops being reported as
// revenue for the class that no longer holds it.
const REVENUE_BY_ALLOCATION_SQL = `
  FROM obligation_allocations a
  JOIN payments p ON p.id = a.payment_id
  JOIN student_obligations o ON o.id = a.obligation_id
  JOIN student_semesters ss ON ss.id = o.semester_id
  LEFT JOIN classes c ON c.id = ss.class_id
  WHERE ${CASH_ALLOCATION_SQL}
    AND p.status = 'completed'
    AND ((c.id IS NOT NULL AND c.branch_id = ?) OR (c.id IS NULL AND p.branch_id = ?))
    AND p.date BETWEEN ? AND ?`;

const stmtRevenueByClass = db.prepare(`
  SELECT COALESCE(c.name, '(no class)') AS name, SUM(a.amount) as revenue
  ${REVENUE_BY_ALLOCATION_SQL}
  GROUP BY c.id
  ORDER BY revenue DESC
`);

// Same single-attribution rule as stmtRevenueByClass above.
const stmtRevenueByTimeSlot = db.prepare(`
  SELECT COALESCE(c.schedule_time, 'Unknown') as slot, SUM(a.amount) as revenue
  ${REVENUE_BY_ALLOCATION_SQL}
  GROUP BY c.schedule_time
  ORDER BY revenue DESC
`);

// ================= Executive Dashboard =================
bosRouter.get(
  '/executive-dashboard',
  requirePermission('Dashboard.Executive'),
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
    // "Last month" is the previous SHAMSI month. Stepping back one Gregorian
    // month from a Shamsi month's start lands in a window that is neither
    // month — on 2026-08-20 that is 2026-06, overlapping two Shamsi months.
    const previous = periodBoundariesForKey(previousMonthKey(isoToJalaliPeriodKey(from) ?? period));
    const newLastMonth = (stmtNewStudentsCount.get(previous.from, previous.to, branchId) as any).count;

    const classAvgRow = stmtClassAvgSize.get(branchId) as any;

    const profit = monthlyRevenue - monthlyExpense;
    const profitMargin = monthlyRevenue > 0 ? (profit / monthlyRevenue) * 100 : 0;
    const reserveFundTarget = reserveFundTargetFor(breakEven);
    const reserveFundBalance = assertComputedMoney(
      mainAccountBalance + savingBalance,
      'total branch liquidity',
    );

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
      cashBalance: reserveFundBalance,
      reserveFundBalance,
      reserveFundTarget,
      reserveFundProgress: reserveFundTarget > 0 ? Math.min(100, Math.round((reserveFundBalance / reserveFundTarget) * 100)) : 100,
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
  requirePermission('Dashboard.Executive'),
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
  requirePermission('Dashboard.Executive'),
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
  requirePermission('Dashboard.Executive'),
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
    const cashWarningThreshold = cashReserveWarningThresholdFor(fixedTotal);
    if (mainAccountBalance < cashWarningThreshold) {
      warnings.push({
        severity: 'critical',
        title: `Cash reserve is below ${TREASURY_DEFAULTS.cashReserveWarningMonths} months of fixed costs`,
        message: `Main account balance (${Math.round(mainAccountBalance).toLocaleString()} AFN) is below the ${Math.round(cashWarningThreshold).toLocaleString()} AFN cash warning threshold.`,
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

    const underperformingTeachers = stmtUnderperformingTeachers.all(
      branchId,
      TREASURY_DEFAULTS.teacherPerformanceWarningPercent,
    ) as any[];
    for (const t of underperformingTeachers) {
      warnings.push({
        severity: 'info',
        title: `Teacher ${t.full_name} performance is below ${TREASURY_DEFAULTS.teacherPerformanceWarningPercent}%`,
        message: `Current performance score: ${t.performance_score}%. Supplementary training is recommended; if repeated, class assignment review is needed.`,
      });
    }

    res.json({ warnings });
  })
);

// ================= Tiered Profit Distribution =================

bosRouter.get(
  '/profit-distribution/calculate',
  requirePermission('Dashboard.Executive'),
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    if (req.query.period || (req.query.timeframe && req.query.timeframe !== 'month')) {
      throw new HttpError(400, 'The profit-withdrawal position is always for the current accounting month.');
    }

    // A profit withdrawal is a current-month action, not an analytics view.
    // Publishing a today/year ceiling while enforcing a month ceiling would
    // show an amount that the mutation does not honour.
    const { from, to, period, revenue, expense, position } =
      currentProfitDistributionPosition(branchId);

    res.json({
      period,
      // The span is reported so a caller can see which days the figure covers
      // rather than inferring it from the period name.
      periodFrom: from,
      periodTo: to,
      revenue,
      expense,
      profit: position.profit,
      profitMargin: Math.round(position.marginPercent * 10) / 10,
      tierPercent: position.tierPercent,
      reserveFundTarget: position.reserveFundTarget,
      reserveFundBalance: position.totalLiquidity,
      reserveFundMet: position.reserveFundMet,
      mainBalance: position.mainBalance,
      savingBalance: position.savingBalance,
      liquidityHeadroom: position.liquidityHeadroom,
      periodAllowance: position.periodAllowance,
      remainingAllowance: position.remainingAllowance,
      alreadyDistributed: position.distributed,
      maxWithdrawable: position.maxWithdrawable,
    });
  })
);

bosRouter.post(
  '/profit-distribution/withdraw',
  requireGlobalOwner,
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
      // Recompute every limit under the same write lock as the cash decrement,
      // through the exact input loader used by the published position.
      const { position } = currentProfitDistributionPosition(branchId);
      const { tierPercent, periodAllowance, maxWithdrawable } = position;
      const margin = position.marginPercent;

      if (!position.reserveFundMet) {
        throw new HttpError(409, `Profit withdrawal not allowed: total branch liquidity has not reached its ${TREASURY_DEFAULTS.reserveFundMonths}-month minimum (${position.totalLiquidity.toLocaleString()} of ${position.reserveFundTarget.toLocaleString()} AFN).`);
      }
      if (amount > position.liquidityHeadroom) {
        throw new HttpError(409, `Profit withdrawal not allowed: the branch must retain ${position.reserveFundTarget.toLocaleString()} AFN after withdrawal (${position.liquidityHeadroom.toLocaleString()} AFN liquidity headroom available).`);
      }
      if (amount > position.remainingAllowance) {
        throw new HttpError(409, `Requested amount exceeds this period's remaining withdrawable limit (${position.remainingAllowance.toLocaleString()} AFN of a ${periodAllowance.toLocaleString()} AFN allowance based on a ${Math.round(margin)}% profit margin; ${position.distributed.toLocaleString()} AFN already distributed).`);
      }
      if (amount > position.mainBalance) {
        throw new HttpError(409, 'Insufficient cash balance in the main account for this withdrawal.');
      }

      if (!decrementMainBalanceIfSufficient('branch', branchId, amount)) {
        throw new HttpError(409, 'Insufficient branch cash balance or balance changed.');
      }
      const postWithdrawalAccount = getFinanceAccount('branch', branchId);
      const postWithdrawalLiquidity = assertComputedMoney(
        postWithdrawalAccount.mainBalance + postWithdrawalAccount.savingBalance,
        'post-withdrawal branch liquidity',
      );
      if (postWithdrawalLiquidity < position.reserveFundTarget) {
        throw new HttpError(409, 'Withdrawal would breach the required contingency reserve.');
      }
      const date = today();
      stmtInsertFinTx.run(
        id('tx'), amount, date,
        `Management profit withdrawal (${tierPercent}% of ${Math.round(margin)}% profit margin)${notes ? ' — ' + notes : ''}`,
        recipientPartnerId, user.fullName, branchId
      );
      addNotification(
        'Profit withdrawal recorded',
        `${amount.toLocaleString()} AFN has been deducted from the main account as a management profit withdrawal.`,
        'info',
        branchId,
      );
      return { maxWithdrawable, margin, tierPercent };
    }).immediate();

    writeAudit(req, `Management profit withdrawal of ${amount} AFN (this month's max: ${result.maxWithdrawable} AFN)`);
    res.status(201).json({ ok: true, ...result });
  })
);
// ================= NEW: Profitability Analytics =================
bosRouter.get(
  '/revenue-by-class',
  requirePermission('Dashboard.Executive'),
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);
    const rows = stmtRevenueByClass.all(branchId, branchId, from, to) as any[];
    res.json(rows.map(r => ({ name: r.name, revenue: r.revenue || 0 })));
  })
);

bosRouter.get(
  '/revenue-by-timeslot',
  requirePermission('Dashboard.Executive'),
  ah(async (req, res) => {
    const branchId = requireBosBranch(req);
    const { from, to } = getTimeBounds(req.query.period as string, req.query.timeframe as string);
    const rows = stmtRevenueByTimeSlot.all(branchId, branchId, from, to) as any[];
    res.json(rows.map(r => ({ slot: r.slot, revenue: r.revenue || 0 })));
  })
);

export default bosRouter;