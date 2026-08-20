/**
 * TOEFL House ERP — Reporting API
 * ============================================================
 * GET /api/reports/overview — a single authoritative, server-computed
 * operational + financial report for a period (today / month / year /
 * arbitrary range) and scope (branch / organization), with gender
 * breakdowns wherever the metric supports meaningful classification.
 *
 * Every figure is calculated in SQL on the backend from the authoritative
 * tables (students, visitors, registrations, exams, certificates,
 * book_sales, financial_transactions, payments). The frontend only renders.
 *
 * The response carries a stable report header (Report ID, type, period,
 * filters, generated-by, position, timestamp) so printed reports are
 * self-explanatory and traceable without ERP access.
 */
import { Router } from 'express';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import {
  CAPITAL_INJECTION_CATEGORY,
  OPERATING_EXPENSE_SQL,
  OPERATING_INCOME_SQL,
  PROFIT_DISTRIBUTION_CATEGORY,
  classifyExpenseCategory,
} from '../core/finance/ledger-classification.js';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { incrementNumberSetting, getNumberSetting } from '../utils/settings.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const MAX_RANGE_DAYS = 366;

function resolvePeriod(query: Record<string, string | undefined>) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const period = query.period || 'month';
  let from: string;
  let to: string;
  let periodLabel: string;

  // Period correctness: a calendar period ALWAYS spans the full period (the
  // label is the period name, so the bounds must match it). Historically the
  // `to` bound was capped at TODAY even for a past month/year, which silently
  // pulled later-period transactions into a historical report.
  const lastDayOfMonth = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  switch (period) {
    case 'today':
      from = to = iso(today);
      periodLabel = from;
      break;
    case 'quarter': {
      const y = query.year || String(today.getFullYear());
      const q = query.quarter || String(Math.floor(today.getMonth() / 3) + 1);
      if (!/^\d{4}$/.test(y) || !/^[1-4]$/.test(q)) throw new HttpError(400, 'Invalid year or quarter.');
      const startMonth = (Number(q) - 1) * 3 + 1;
      from = `${y}-${String(startMonth).padStart(2, '0')}-01`;
      to = lastDayOfMonth(`${y}-${String(startMonth + 2).padStart(2, '0')}`);
      periodLabel = `${y} Q${q}`;
      break;
    }
    case 'year': {
      const y = query.year || String(today.getFullYear());
      if (!/^\d{4}$/.test(y)) throw new HttpError(400, 'Invalid year.');
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      periodLabel = y;
      break;
    }
    case 'range': {
      from = typeof query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : '';
      to = typeof query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : '';
      if (!from || !to) throw new HttpError(400, 'Range reports require valid from and to dates (YYYY-MM-DD).');
      if (from > to) throw new HttpError(400, 'from must not be after to.');
      const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000);
      if (days > MAX_RANGE_DAYS) throw new HttpError(400, `Range may not exceed ${MAX_RANGE_DAYS} days.`);
      periodLabel = `${from} → ${to}`;
      break;
    }
    case 'month':
    default: {
      const ym = query.month || iso(today).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) throw new HttpError(400, 'Invalid month (YYYY-MM).');
      from = `${ym}-01`;
      to = lastDayOfMonth(ym);
      periodLabel = ym;
      break;
    }
  }
  return { period, from, to, periodLabel };
}

/** Sum helper for gender-aware income. */
function genderSplit(sql: string, params: unknown[]) {
  const rows = db.prepare(sql).all(...params) as Array<{ category: string; male: number; female: number; unclassified: number }>;
  let total = 0;
  const byCategory = rows.map((r) => {
    const male = Number(r.male || 0);
    const female = Number(r.female || 0);
    const unclassified = Number(r.unclassified || 0);
    const rowTotal = male + female + unclassified;
    total += rowTotal;
    return { category: r.category, total: rowTotal, male, female, unclassified };
  });
  return { total, byCategory };
}

reportsRouter.get(
  '/overview',
  requirePermission('Report.View', 'Finance.Report', 'Ledger.View'),
  ah(async (req, res) => {
    const { period, from, to, periodLabel } = resolvePeriod(req.query as Record<string, string | undefined>);
    const gender = req.query.gender === 'male' || req.query.gender === 'female' ? req.query.gender : 'all';
    const { branchId, isAll } = resolveBranchScope(req);

    // Branch-scope filter clause + params (organization scope = no filter).
    const scopeSql = (tableAlias: string, column = 'branch_id') => (isAll ? '' : ` AND ${tableAlias}.${column} = ?`);
    const scopeParam = isAll ? [] : [branchId];
    const genderClause = gender === 'all' ? '' : ` AND s.gender = ?`;
    const genderParam = gender === 'all' ? [] : [gender];
    // Income rows may be linked to a student OR (for placement fees) to the
    // candidate visitor; the filter must resolve the same way the split does.
    const incomeGenderClause = gender === 'all' ? '' : ` AND COALESCE(s.gender, v.gender) = ?`;

    // ── Financial: operating income by category (gender split for student-linked income) ──
    const incomeSql = `
      SELECT ft.category AS category,
        COALESCE(SUM(CASE WHEN COALESCE(s.gender, v.gender) = 'male' THEN ft.amount ELSE 0 END), 0) AS male,
        COALESCE(SUM(CASE WHEN COALESCE(s.gender, v.gender) = 'female' THEN ft.amount ELSE 0 END), 0) AS female,
        COALESCE(SUM(CASE WHEN COALESCE(s.gender, v.gender) IS NULL THEN ft.amount ELSE 0 END), 0) AS unclassified
      FROM financial_transactions ft
      LEFT JOIN payments p ON p.id = ft.payment_id
      LEFT JOIN students s ON s.id = p.student_id
      -- Placement fees are booked against the candidate visitor (payment
      -- idempotency key 'placement:<attemptId>'); resolve gender through the
      -- visitor when the payment has no student link.
      LEFT JOIN placement_assessment_attempts pa ON p.idempotency_key = 'placement:' || pa.id
      LEFT JOIN visitors v ON v.id = pa.visitor_id
      WHERE ${OPERATING_INCOME_SQL.replace(/\btype\b/g, 'ft.type').replace(/\bcategory\b/g, 'ft.category')}
        AND ft.date >= ? AND ft.date <= ?
        ${scopeSql('ft')}${incomeGenderClause}
      GROUP BY ft.category ORDER BY ft.category`;
    const income = genderSplit(incomeSql, [from, to, ...scopeParam, ...genderParam]);

    // ── Financial: EXPENSE-SIDE rows, split by accounting treatment ──
    // This used to be `category != 'profit_distribution'`, a private copy of
    // one third of the classification rule. It therefore counted fixed-asset
    // purchases and salary advances as ordinary operating cost. The rule now
    // comes from the single authority, and the two non-operating treatments are
    // REPORTED SEPARATELY rather than silently dropped.
    const expenseSideRows = (isAll
      ? db.prepare(`SELECT category, COALESCE(SUM(amount),0) AS total FROM financial_transactions
          WHERE type = 'expense' AND date >= ? AND date <= ?
          GROUP BY category ORDER BY category`).all(from, to)
      : db.prepare(`SELECT category, COALESCE(SUM(amount),0) AS total FROM financial_transactions
          WHERE type = 'expense' AND date >= ? AND date <= ? AND branch_id = ?
          GROUP BY category ORDER BY category`).all(from, to, branchId)) as Array<{ category: string; total: number }>;

    const classified = expenseSideRows.map((r) => ({
      category: r.category,
      total: Number(r.total || 0),
      classification: classifyExpenseCategory(r.category),
    }));
    const totalFor = (classification: string) =>
      classified.filter((r) => r.classification === classification).reduce((sum, r) => sum + r.total, 0);

    const expense = {
      total: totalFor('operating_expense'),
      byCategory: classified
        .filter((r) => r.classification === 'operating_expense')
        .map((r) => ({ category: r.category, total: r.total })),
    };
    const capitalExpenditure = {
      total: totalFor('capital_expenditure'),
      byCategory: classified
        .filter((r) => r.classification === 'capital_expenditure')
        .map((r) => ({ category: r.category, total: r.total })),
    };
    const nonExpenseCashMovements = {
      total: totalFor('non_expense_cash_movement'),
      byCategory: classified
        .filter((r) => r.classification === 'non_expense_cash_movement')
        .map((r) => ({ category: r.category, total: r.total })),
    };

    // ── Financial: transfers (capital / distributions / budget / savings) ──
    const transferRows = (isAll
      ? db.prepare(`SELECT type, category, COALESCE(SUM(amount),0) AS total FROM financial_transactions
          WHERE date >= ? AND date <= ? AND (
            (type = 'income' AND category = '${CAPITAL_INJECTION_CATEGORY}') OR
            (type = 'expense' AND category = '${PROFIT_DISTRIBUTION_CATEGORY}') OR
            type = 'budget_charge' OR type = 'saving_transfer')
          GROUP BY type, category`).all(from, to)
      : db.prepare(`SELECT type, category, COALESCE(SUM(amount),0) AS total FROM financial_transactions
          WHERE date >= ? AND date <= ? AND branch_id = ? AND (
            (type = 'income' AND category = '${CAPITAL_INJECTION_CATEGORY}') OR
            (type = 'expense' AND category = '${PROFIT_DISTRIBUTION_CATEGORY}') OR
            type = 'budget_charge' OR type = 'saving_transfer')
          GROUP BY type, category`).all(from, to, branchId)) as Array<{ type: string; category: string; total: number }>;
    const transfers = {
      capitalInjection: 0,
      profitDistribution: 0,
      budgetCharged: 0,
      savingTransferred: 0,
    };
    for (const r of transferRows) {
      const v = Number(r.total || 0);
      if (r.type === 'income' && r.category === CAPITAL_INJECTION_CATEGORY) transfers.capitalInjection += v;
      else if (r.type === 'expense' && r.category === PROFIT_DISTRIBUTION_CATEGORY) transfers.profitDistribution += v;
      else if (r.type === 'budget_charge') transfers.budgetCharged += v;
      else if (r.type === 'saving_transfer') transfers.savingTransferred += v;
    }

    // ── Financial: collected payments (count + total) with gender split ──
    const paymentRows = (isAll
      ? db.prepare(`SELECT
          COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN amount ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN amount ELSE 0 END),0) AS female
        FROM payments p LEFT JOIN students s ON s.id = p.student_id
        WHERE p.status = 'completed' AND p.category != 'refund' AND p.date >= ? AND p.date <= ? ${genderClause}`).get(from, to, ...genderParam)
      : db.prepare(`SELECT
          COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN amount ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN amount ELSE 0 END),0) AS female
        FROM payments p LEFT JOIN students s ON s.id = p.student_id
        WHERE p.status = 'completed' AND p.category != 'refund' AND p.date >= ? AND p.date <= ? AND p.branch_id = ? ${genderClause}`).get(from, to, branchId, ...genderParam)) as { count: number; total: number; male: number; female: number };

    // ── Financial: balances (current) ──
    const account = isAll ? getFinanceAccount('organization', 'global') : getFinanceAccount('branch', branchId!);
    const budgetRows = (isAll
      ? db.prepare('SELECT COALESCE(SUM(allocated_amount),0) AS allocated, COALESCE(SUM(current_amount),0) AS remaining FROM budget_lines').get()
      : db.prepare('SELECT COALESCE(SUM(allocated_amount),0) AS allocated, COALESCE(SUM(current_amount),0) AS remaining FROM budget_lines WHERE branch_id = ?').get(branchId)) as { allocated: number; remaining: number };

    // ── Operational: gender-aware counts ──
    const countPair = (table: string, dateCol: string, extraWhere = '') => {
      // These tables carry their own `gender` column — no alias join.
      const tableGenderClause = gender === 'all' ? '' : ' AND gender = ?';
      const tableGenderParam = gender === 'all' ? [] : [gender];
      const q = (isAll
        ? db.prepare(`SELECT
            COALESCE(SUM(CASE WHEN gender = 'male' THEN 1 ELSE 0 END),0) AS male,
            COALESCE(SUM(CASE WHEN gender = 'female' THEN 1 ELSE 0 END),0) AS female,
            COUNT(*) AS total
          FROM ${table} WHERE ${dateCol} >= ? AND ${dateCol} <= ? ${extraWhere}${tableGenderClause}`).get(from, to, ...tableGenderParam)
        : db.prepare(`SELECT
            COALESCE(SUM(CASE WHEN gender = 'male' THEN 1 ELSE 0 END),0) AS male,
            COALESCE(SUM(CASE WHEN gender = 'female' THEN 1 ELSE 0 END),0) AS female,
            COUNT(*) AS total
          FROM ${table} WHERE ${dateCol} >= ? AND ${dateCol} <= ? AND branch_id = ? ${extraWhere}${tableGenderClause}`).get(from, to, branchId, ...tableGenderParam)) as { male: number; female: number; total: number };
      return { male: Number(q.male || 0), female: Number(q.female || 0), total: Number(q.total || 0) };
    };

    const newStudents = countPair('students', 'registration_date');
    const activeStudents = countPair('students', 'registration_date', "AND status = 'active'");
    const visitors = countPair('visitors', 'visit_date');
    const placementCompleted = countPair('visitors', 'visit_date', "AND stage = 'placement_completed'");

    // Registrations (students may be counted once per registration; gender via student).
    const regQ = (isAll
      ? db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM registrations r LEFT JOIN students s ON s.id = r.student_id
        WHERE r.date >= ? AND r.date <= ? ${genderClause}`).get(from, to, ...genderParam)
      : db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM registrations r LEFT JOIN students s ON s.id = r.student_id
        WHERE r.date >= ? AND r.date <= ? AND r.branch_id = ? ${genderClause}`).get(from, to, branchId, ...genderParam)) as { male: number; female: number; total: number };
    const registrations = { male: Number(regQ.male || 0), female: Number(regQ.female || 0), total: Number(regQ.total || 0) };

    // Certificates (gender via student).
    const certQ = (isAll
      ? db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM certificates c LEFT JOIN students s ON s.id = c.student_id
        WHERE c.issue_date >= ? AND c.issue_date <= ? ${genderClause}`).get(from, to, ...genderParam)
      : db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM certificates c LEFT JOIN students s ON s.id = c.student_id
        WHERE c.issue_date >= ? AND c.issue_date <= ? AND c.branch_id = ? ${genderClause}`).get(from, to, branchId, ...genderParam)) as { male: number; female: number; total: number };
    const certificatesIssued = { male: Number(certQ.male || 0), female: Number(certQ.female || 0), total: Number(certQ.total || 0) };

    // Exams conducted in period.
    const examsQ = isAll
      ? db.prepare('SELECT COUNT(*) AS c FROM exams WHERE date >= ? AND date <= ?').get(from, to)
      : db.prepare('SELECT COUNT(*) AS c FROM exams WHERE date >= ? AND date <= ? AND branch_id = ?').get(from, to, branchId);
    const examsConducted = Number((examsQ as { c: number }).c || 0);

    // Book sales.
    const booksQ = isAll
      ? db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(net_amount),0) AS total FROM book_sales
          WHERE status = 'completed' AND date >= ? AND date <= ?`).get(from, to)
      : db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(net_amount),0) AS total FROM book_sales
          WHERE status = 'completed' AND date >= ? AND date <= ? AND branch_id = ?`).get(from, to, branchId);
    const booksSold = { count: Number((booksQ as { count: number }).count || 0), total: Number((booksQ as { total: number }).total || 0) };

    // ── Placement exam metrics (authoritative from placement_assessment_attempts) ──
    const placementQ = isAll
      ? db.prepare(`SELECT
          COUNT(*) AS attempts,
          COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed,
          COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0) AS in_progress,
          COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
          ROUND(COALESCE(AVG(CASE WHEN status='completed' THEN percentage END),0),1) AS avg_score
        FROM placement_assessment_attempts WHERE started_at >= ? AND started_at <= ?`).get(from + ' 00:00:00', to + ' 23:59:59')
      : db.prepare(`SELECT
          COUNT(*) AS attempts,
          COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed,
          COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END),0) AS in_progress,
          COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
          ROUND(COALESCE(AVG(CASE WHEN status='completed' THEN percentage END),0),1) AS avg_score
        FROM placement_assessment_attempts WHERE branch_id = ? AND started_at >= ? AND started_at <= ?`).get(branchId, from + ' 00:00:00', to + ' 23:59:59');
    const pQ = placementQ as { attempts: number; completed: number; in_progress: number; cancelled: number; avg_score: number };
    const levelDist = (isAll
      ? db.prepare(`SELECT COALESCE(l.code, 'Unassigned') AS level_code, COUNT(*) AS c
          FROM placement_assessment_attempts a LEFT JOIN levels l ON l.id = a.recommended_level_id
          WHERE a.status='completed' AND a.started_at >= ? AND a.started_at <= ?
          GROUP BY level_code ORDER BY c DESC`).all(from + ' 00:00:00', to + ' 23:59:59')
      : db.prepare(`SELECT COALESCE(l.code, 'Unassigned') AS level_code, COUNT(*) AS c
          FROM placement_assessment_attempts a LEFT JOIN levels l ON l.id = a.recommended_level_id
          WHERE a.status='completed' AND a.branch_id = ? AND a.started_at >= ? AND a.started_at <= ?
          GROUP BY level_code ORDER BY c DESC`).all(branchId, from + ' 00:00:00', to + ' 23:59:59')) as Array<{ level_code: string; c: number }>;
    const conversionQ = isAll
      ? db.prepare(`SELECT COUNT(*) AS c FROM visitors WHERE ${LEAD_CONVERTED_SQL} AND visit_date >= ? AND visit_date <= ?`).get(from, to)
      : db.prepare(`SELECT COUNT(*) AS c FROM visitors WHERE ${LEAD_CONVERTED_SQL} AND branch_id = ? AND visit_date >= ? AND visit_date <= ?`).get(branchId, from, to);
    const placement = {
      attempts: Number(pQ.attempts || 0),
      completed: Number(pQ.completed || 0),
      inProgress: Number(pQ.in_progress || 0),
      cancelled: Number(pQ.cancelled || 0),
      avgScore: Number(pQ.avg_score || 0),
      convertedToStudent: Number((conversionQ as { c: number }).c || 0),
      levelDistribution: levelDist.map((r) => ({ level: r.level_code, count: Number(r.c) })),
    };

    // ── Financial: discounts granted in the period (authoritative: invoices
    //    and registrations carry the discount amounts; income is net of these) ──
    const discQ = isAll
      ? db.prepare(`SELECT COALESCE(SUM(discount_amount),0) AS d FROM invoices WHERE status != 'draft' AND issue_date >= ? AND issue_date <= ?`).get(from, to)
      : db.prepare(`SELECT COALESCE(SUM(discount_amount),0) AS d FROM invoices WHERE status != 'draft' AND branch_id = ? AND issue_date >= ? AND issue_date <= ?`).get(branchId, from, to);
    const registrationDiscount = (isAll
      ? db.prepare(`SELECT COALESCE(SUM(discount_applied),0) AS d FROM registrations WHERE date >= ? AND date <= ?`).get(from, to)
      : db.prepare(`SELECT COALESCE(SUM(discount_applied),0) AS d FROM registrations WHERE branch_id = ? AND date >= ? AND date <= ?`).get(branchId, from, to)) as { d: number };
    const discounts = {
      invoiceDiscounts: Number((discQ as { d: number }).d || 0),
      registrationDiscounts: Number(registrationDiscount.d || 0),
    };

    // ── Financial: outstanding student balances at period end (open invoices
    //    net minus completed payments; refunds reduce the paid side) ──
    const outstandingQ = (isAll
      ? db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue') THEN i.net_amount ELSE 0 END),0) AS gross,
          COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue') THEN
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') END),0) AS paid
        FROM invoices i WHERE i.status != 'draft' AND i.status != 'cancelled' AND i.status != 'paid'`).get()
      : db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue') THEN i.net_amount ELSE 0 END),0) AS gross,
          COALESCE(SUM(CASE WHEN i.status IN ('issued','partial','overdue') THEN
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') END),0) AS paid
        FROM invoices i WHERE i.branch_id = ? AND i.status != 'draft' AND i.status != 'cancelled' AND i.status != 'paid'`).get(branchId)) as { gross: number; paid: number };
    const outstandingCountRow = (isAll
      ? db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status IN ('issued','partial','overdue')`).get()
      : db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE branch_id = ? AND status IN ('issued','partial','overdue')`).get(branchId)) as { c: number };
    const outstanding = {
      openInvoices: Number(outstandingCountRow.c || 0),
      gross: Number(outstandingQ.gross || 0),
      paid: Number(outstandingQ.paid || 0),
      remaining: Math.max(0, Number(outstandingQ.gross || 0) - Number(outstandingQ.paid || 0)),
    };

    // ── Operational: books sold by title (authoritative: book_sales JOIN books) ──
    const booksByTitle = (isAll
      ? db.prepare(`SELECT b.title, COALESCE(SUM(s.quantity),0) AS quantity, COALESCE(SUM(s.net_amount),0) AS net
          FROM book_sales s JOIN books b ON b.id = s.book_id
          WHERE s.status = 'completed' AND s.date >= ? AND s.date <= ?
          GROUP BY b.title ORDER BY net DESC`).all(from, to)
      : db.prepare(`SELECT b.title, COALESCE(SUM(s.quantity),0) AS quantity, COALESCE(SUM(s.net_amount),0) AS net
          FROM book_sales s JOIN books b ON b.id = s.book_id
          WHERE s.status = 'completed' AND s.branch_id = ? AND s.date >= ? AND s.date <= ?
          GROUP BY b.title ORDER BY net DESC`).all(branchId, from, to)) as Array<{ title: string; quantity: number; net: number }>;

    // ── Previous-period comparison (server-computed, same span length) ──
    // Inclusive-day span (June 1-30 = 30 days) so the comparison window has
    // exactly the same length as the reported period.
    const spanDays = Math.max(1, Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000) + 1);
    const prevTo = new Date(from + 'T00:00:00');
    prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setDate(prevFrom.getDate() - (spanDays - 1));
    const prevFromIso = prevFrom.toISOString().slice(0, 10);
    const prevToIso = prevTo.toISOString().slice(0, 10);
    const prevTotals = (isAll
      ? db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN ${OPERATING_INCOME_SQL} THEN amount ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN ${OPERATING_EXPENSE_SQL} THEN amount ELSE 0 END),0) AS expense
        FROM financial_transactions WHERE date >= ? AND date <= ?`).get(prevFromIso, prevToIso)
      : db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN ${OPERATING_INCOME_SQL} THEN amount ELSE 0 END),0) AS income,
          COALESCE(SUM(CASE WHEN ${OPERATING_EXPENSE_SQL} THEN amount ELSE 0 END),0) AS expense
        FROM financial_transactions WHERE branch_id = ? AND date >= ? AND date <= ?`).get(branchId, prevFromIso, prevToIso)) as { income: number; expense: number };
    const previous = {
      from: prevFromIso,
      to: prevToIso,
      income: Number(prevTotals.income || 0),
      expense: Number(prevTotals.expense || 0),
      net: Number(prevTotals.income || 0) - Number(prevTotals.expense || 0),
    };

    // ── Report header / metadata ──
    const seq = incrementNumberSetting('report_sequence', 1, 0);
    const reportId = `REP-${from.replace(/-/g, '').slice(0, 6)}-${String(seq).padStart(6, '0')}`;
    const position = req.rbac?.roles?.[0]?.roleName || req.user?.role || 'Unknown';
    let branchName: string | null = null;
    let campusName: string | null = null;
    if (branchId) {
      const br = db.prepare('SELECT name, campus_id FROM branches WHERE id = ?').get(branchId) as { name: string; campus_id: string | null } | undefined;
      branchName = br?.name ?? null;
      if (br?.campus_id) {
        const cam = db.prepare('SELECT name FROM campuses WHERE id = ?').get(br.campus_id) as { name: string } | undefined;
        campusName = cam?.name ?? null;
      }
    }

    res.json({
      meta: {
        reportId,
        type: 'operations-overview',
        period,
        periodLabel,
        from,
        to,
        filters: {
          scope: isAll ? 'organization' : 'branch',
          branchId: branchId || null,
          branchName,
          campusName,
          gender,
        },
        generatedBy: { userId: req.user?.userId || null, name: req.user?.fullName || 'System' },
        position,
        generatedAt: new Date().toISOString(),
        settings: {
          dailySavingPercent: getNumberSetting('daily_saving_percent', SYSTEM_DEFAULTS.dailySavingPercent),
        },
      },
      financial: {
        income,
        expense,
        net: income.total - expense.total,
        // Cash out that is NOT trading cost. Surfaced so a reader can still see
        // the money leave — the requirement is that it must not be counted as
        // operating expense, not that it must be hidden.
        capitalExpenditure,
        nonExpenseCashMovements,
        previous,
        transfers,
        balances: {
          main: account.mainBalance,
          saving: account.savingBalance,
          budgetAllocated: Number(budgetRows.allocated || 0),
          budgetRemaining: Number(budgetRows.remaining || 0),
        },
        collectedPayments: {
          count: Number(paymentRows.count || 0),
          total: Number(paymentRows.total || 0),
          male: Number(paymentRows.male || 0),
          female: Number(paymentRows.female || 0),
        },
        discounts,
        outstanding,
      },
      operational: {
        newStudents,
        activeStudents,
        registrations,
        visitors,
        placementCompleted,
        examsConducted,
        certificatesIssued,
        booksSold,
        booksByTitle,
        placement,
      },
    });
  })
);
