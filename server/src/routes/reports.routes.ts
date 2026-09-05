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
import { Router, type Request } from 'express';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import {
  CAPITAL_INJECTION_CATEGORY,
  OPERATING_EXPENSE_SQL,
  OPERATING_INCOME_SQL,
  OWNER_DRAWINGS_CATEGORY_ID,
  classifyExpenseRow,
  operatingIncomeSql,
} from '../core/finance/ledger-classification.js';
import { CATEGORY_NAME } from '../core/finance/category-taxonomy.js';
import { BUDGET_MOVEMENT_CATEGORY, BUDGET_MOVEMENT_TYPE } from '../core/finance/budget-movements.js';
import { db } from '../db/connection.js';
import { getBranchOutstanding } from '../utils/studentBalance.js';
import { authenticate, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { REPORT_CATALOG, REPORT_CATEGORIES, reportById, type ReportDefinition } from '../core/reporting/report-catalog.js';
import { reportToCsv, reportExportFilename } from '../core/reporting/report-export.js';
import { writeAudit } from '../middleware/audit.js';
import {
  runReport,
  UnknownReportError,
  UnsupportedPeriodError,
} from '../core/reporting/report-engine.js';
import { REPORTING_PERIODS } from '../core/calendar/periods.js';
import {
  InvalidReportWindowError,
  MAX_REPORT_RANGE_DAYS,
  parseReportWindowQuery,
  resolveReportWindow,
} from '../core/reporting/report-window.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { incrementNumberSetting, getNumberSetting } from '../utils/settings.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

function canReadDeclaredReport(
  definition: ReportDefinition,
  permissionCodes: Set<string> | undefined,
  rbac?: Parameters<typeof isGlobalOwner>[0],
) {
  if (definition.permission === 'Report.View') return true;
  if (rbac && isGlobalOwner(rbac)) return true;
  return permissionCodes?.has(definition.permission) ?? false;
}

function requireDeclaredReportPermission(definition: ReportDefinition, req: Request) {
  if (canReadDeclaredReport(definition, req.rbac?.permissionCodes, req.rbac)) return;
  throw new HttpError(403, `This report requires ${definition.permission}.`);
}

function resolveOverviewWindow(query: Record<string, string | undefined>) {
  try {
    const selection = parseReportWindowQuery(query, { allowRange: true, defaultPeriod: 'month' });
    return resolveReportWindow(selection, { allowRange: true, currentMode: 'full-period' });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Invalid report window.');
  }
}

function resolveDeclaredReportWindow(definition: ReportDefinition, query: Record<string, string | undefined>) {
  try {
    return parseReportWindowQuery(query, {
      allowRange: Boolean(definition.allowsDateRange),
      defaultPeriod: 'month',
    });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Invalid report window.');
  }
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
    const window = resolveOverviewWindow(req.query as Record<string, string | undefined>);
    const { period, from, to } = window;
    const periodLabel = window.label;
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
      WHERE ${operatingIncomeSql('ft')}
        AND ft.date >= ? AND ft.date <= ?
        ${scopeSql('ft')}${incomeGenderClause}
      GROUP BY ft.category ORDER BY ft.category`;
    const income = genderSplit(incomeSql, [from, to, ...scopeParam, ...genderParam]);

    // ── Financial: EXPENSE-SIDE rows, split by accounting treatment ──
    // The rule comes from the single classification authority, and the two
    // non-operating treatments are REPORTED SEPARATELY rather than silently
    // dropped: a fixed-asset purchase and a salary advance are real money
    // leaving the branch, they are simply not trading cost.
    const expenseSideRows = (isAll
      // One canonical node is one line — see the same rule in /finance/pnl.
      ? db.prepare(`SELECT MIN(category) AS category, finance_category_id, COALESCE(SUM(amount),0) AS total
                      FROM financial_transactions
                     WHERE type = 'expense' AND date >= ? AND date <= ?
                     GROUP BY COALESCE(finance_category_id, category) ORDER BY 1`).all(from, to)
      : db.prepare(`SELECT MIN(category) AS category, finance_category_id, COALESCE(SUM(amount),0) AS total
                      FROM financial_transactions
                     WHERE type = 'expense' AND date >= ? AND date <= ? AND branch_id = ?
                     GROUP BY COALESCE(finance_category_id, category) ORDER BY 1`).all(from, to, branchId)) as Array<
            { category: string; finance_category_id: string | null; total: number }>;

    const classified = expenseSideRows.map((r) => ({
      // Reported under the canonical NAME, resolved server-side.
      category: (r.finance_category_id ? CATEGORY_NAME.get(r.finance_category_id) : null) ?? r.category,
      total: Number(r.total || 0),
      classification: classifyExpenseRow({ type: 'expense', finance_category_id: r.finance_category_id }),
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
            (type = 'expense' AND finance_category_id = '${OWNER_DRAWINGS_CATEGORY_ID}') OR
            type = '${BUDGET_MOVEMENT_TYPE}' OR type = 'saving_transfer')
          GROUP BY type, category, finance_category_id`).all(from, to)
      : db.prepare(`SELECT type, category, COALESCE(SUM(amount),0) AS total FROM financial_transactions
          WHERE date >= ? AND date <= ? AND branch_id = ? AND (
            (type = 'income' AND category = '${CAPITAL_INJECTION_CATEGORY}') OR
            (type = 'expense' AND finance_category_id = '${OWNER_DRAWINGS_CATEGORY_ID}') OR
            type = '${BUDGET_MOVEMENT_TYPE}' OR type = 'saving_transfer')
          GROUP BY type, category, finance_category_id`).all(from, to, branchId)) as Array<{ type: string; category: string; finance_category_id: string | null; total: number }>;
    // Budget movements are SIGNED and are disclosed by the operator action that
    // produced them. Netting a month-end return against a funding charge and
    // publishing the result as "budget charged" states neither figure.
    const transfers = {
      capitalInjection: 0,
      profitDistribution: 0,
      budgetCharged: 0,
      budgetReturned: 0,
      budgetTransferred: 0,
      savingTransferred: 0,
    };
    for (const r of transferRows) {
      const v = Number(r.total || 0);
      if (r.type === 'income' && r.category === CAPITAL_INJECTION_CATEGORY) transfers.capitalInjection += v;
      else if (r.type === 'expense' && r.finance_category_id === OWNER_DRAWINGS_CATEGORY_ID) transfers.profitDistribution += v;
      else if (r.type === BUDGET_MOVEMENT_TYPE) {
        if (r.category === BUDGET_MOVEMENT_CATEGORY.return) transfers.budgetReturned += -v;
        else if (r.category === BUDGET_MOVEMENT_CATEGORY.transfer_in) transfers.budgetTransferred += v;
        else if (r.category !== BUDGET_MOVEMENT_CATEGORY.transfer_out) transfers.budgetCharged += v;
      }
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

    // Certificates (gender via student). Only issued output counts; revoked
    // certificates are recorded history, not certificates in circulation.
    const certQ = (isAll
      ? db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM certificates c LEFT JOIN students s ON s.id = c.student_id
        WHERE c.status = 'issued' AND c.issue_date >= ? AND c.issue_date <= ? ${genderClause}`).get(from, to, ...genderParam)
      : db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END),0) AS male,
          COALESCE(SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END),0) AS female,
          COUNT(*) AS total
        FROM certificates c LEFT JOIN students s ON s.id = c.student_id
        WHERE c.status = 'issued' AND c.issue_date >= ? AND c.issue_date <= ? AND c.branch_id = ? ${genderClause}`).get(from, to, branchId, ...genderParam)) as { male: number; female: number; total: number };
    const certificatesIssued = { male: Number(certQ.male || 0), female: Number(certQ.female || 0), total: Number(certQ.total || 0) };

    // Exams conducted in period.
    const examsQ = isAll
      ? db.prepare('SELECT COUNT(*) AS c FROM exams WHERE date >= ? AND date <= ?').get(from, to)
      : db.prepare('SELECT COUNT(*) AS c FROM exams WHERE date >= ? AND date <= ? AND branch_id = ?').get(from, to, branchId);
    const examsConducted = Number((examsQ as { c: number }).c || 0);

    // Book sale facts that have no immutable return are the Book commerce authority.
    const booksQ = isAll
      ? db.prepare(`SELECT COALESCE(SUM(s.quantity),0) AS count, COALESCE(SUM(s.net_amount),0) AS total
          FROM book_sales s
         WHERE s.sold_on >= ? AND s.sold_on <= ?
           AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)`).get(from, to)
      : db.prepare(`SELECT COALESCE(SUM(s.quantity),0) AS count, COALESCE(SUM(s.net_amount),0) AS total
          FROM book_sales s
         WHERE s.sold_on >= ? AND s.sold_on <= ? AND s.branch_id = ?
           AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)`).get(from, to, branchId);
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
    // Discounts granted have ONE authority: the invoice document, which
    // records discount_amount for every charge including 100%-discounted
    // tuition. The old `registrationDiscounts` leg summed a registrations
    // column every production writer stored as 0 — a permanently understated
    // figure presented next to the real one.
    const discounts = {
      invoiceDiscounts: Number((discQ as { d: number }).d || 0),
      registrationDiscounts: 0,
    };

    // ── Financial: ONE receivable, derived from the authorities (WP07-F18b) ──
    //
    // Tuition comes from the tuition authority and nothing else does, so a term
    // is counted once. Reading it off invoices instead reported every term a
    // donor had settled as still owed, because aid settles an OBLIGATION and
    // never touches the invoice.
    //
    // Everything that is not tuition is a real receivable that no term carries
    // — registration, books, exam, extra classes — and is summed from the
    // invoices that bill it, each floored at zero so one overpaid document
    // cannot mask another's debt.
    //
    // A POSITION AS AT TODAY, not a flow over the reporting window: it carries
    // no date filter and no longer claims one.
    const outstandingTuition = getBranchOutstanding(db, isAll ? null : branchId);
    const nonTuitionQ = (isAll
      ? db.prepare(`SELECT COALESCE(SUM(MAX(0, i.net_amount -
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed'))),0) AS remaining
          FROM invoices i WHERE i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue')`).get()
      : db.prepare(`SELECT COALESCE(SUM(MAX(0, i.net_amount -
            (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed'))),0) AS remaining
          FROM invoices i WHERE i.branch_id = ? AND i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue')`).get(branchId)) as { remaining: number };
    const outstandingCountRow = (isAll
      ? db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status IN ('issued','partial','overdue')`).get()
      : db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE branch_id = ? AND status IN ('issued','partial','overdue')`).get(branchId)) as { c: number };
    const nonTuition = Number(nonTuitionQ.remaining) || 0;
    const outstanding = {
      /** Owed on tuition, from the tuition authority. Aid-settled terms excluded. */
      tuition: outstandingTuition,
      /** Owed on everything that is not tuition, from the documents that bill it. */
      nonTuition,
      /** What students owe the institute, counted once. */
      total: outstandingTuition + nonTuition,
      /** Operational metric: documents still open, whatever their purpose. */
      openInvoices: Number(outstandingCountRow.c || 0),
    };

    // ── Operational: Book copies sold by title from final, non-returned sale facts ──
    const booksByTitle = (isAll
      ? db.prepare(`SELECT b.title, COALESCE(SUM(s.quantity),0) AS quantity, COALESCE(SUM(s.net_amount),0) AS net
          FROM book_sales s JOIN books b ON b.id = s.book_id
          WHERE s.sold_on >= ? AND s.sold_on <= ?
            AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)
          GROUP BY b.title ORDER BY net DESC`).all(from, to)
      : db.prepare(`SELECT b.title, COALESCE(SUM(s.quantity),0) AS quantity, COALESCE(SUM(s.net_amount),0) AS net
          FROM book_sales s JOIN books b ON b.id = s.book_id
          WHERE s.branch_id = ? AND s.sold_on >= ? AND s.sold_on <= ?
            AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)
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
    const position = req.rbac?.roles?.[0]?.roleName || req.rbac?.primaryRole || 'Unknown';
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

// ── Declared reports ────────────────────────────────────────────────────────
//
// The catalog is browsable so the UI does not hard-code a menu of reports that
// then drifts from what the server can actually produce.

reportsRouter.get(
  '/catalog',
  authenticate,
  requirePermission('Report.View'),
  ah(async (req, res) => {
    res.json({
      categories: REPORT_CATEGORIES,
      periods: REPORTING_PERIODS,
      maxRangeDays: MAX_REPORT_RANGE_DAYS,
      reports: REPORT_CATALOG.filter((r) => canReadDeclaredReport(r, req.rbac?.permissionCodes, req.rbac)).map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        purpose: r.purpose,
        periods: r.periods,
        permission: r.permission,
        allowsDateRange: Boolean(r.allowsDateRange),
      })),
    });
  }),
);

/**
 * Runs one declared report.
 *
 * The report's OWN permission is enforced in addition to Report.View, so a
 * payroll or audit report is not readable by anyone who can merely open the
 * reporting screen.
 */
reportsRouter.get(
  '/run/:reportId',
  authenticate,
  requirePermission('Report.View'),
  ah(async (req, res) => {
    const definition = reportById(req.params.reportId);
    if (!definition) throw new HttpError(404, `Unknown report '${req.params.reportId}'.`);

    requireDeclaredReportPermission(definition, req);
    const window = resolveDeclaredReportWindow(definition, req.query as Record<string, string | undefined>);

    const scope = resolveBranchScope(req);
    try {
      res.json(runReport(db, definition.id, window, scope));
    } catch (err) {
      if (err instanceof UnsupportedPeriodError || err instanceof InvalidReportWindowError) throw new HttpError(400, err.message);
      if (err instanceof UnknownReportError) throw new HttpError(404, err.message);
      throw err;
    }
  }),
);

/**
 * Exports one declared report.
 *
 * Runs the SAME engine call as `/run/:reportId` and serializes its result, so
 * the file and the screen cannot disagree: there is one execution and two
 * renderings of it. Re-querying here, or letting the browser assemble a file
 * from the rendered table, would reintroduce exactly the drift §77 forbids —
 * and in an artifact that then leaves the system.
 *
 * Authorization is identical to running the report, deliberately: an export is
 * a read of the same numbers, so it must not be reachable by anyone who could
 * not see them on screen.
 */
reportsRouter.get(
  '/run/:reportId/export',
  authenticate,
  requirePermission('Report.View'),
  ah(async (req, res) => {
    const definition = reportById(req.params.reportId);
    if (!definition) throw new HttpError(404, `Unknown report '${req.params.reportId}'.`);

    requireDeclaredReportPermission(definition, req);

    const format = String(req.query.format ?? 'csv').toLowerCase();
    if (format !== 'csv') {
      throw new HttpError(400, `Unsupported export format '${format}'. Only csv is available.`);
    }

    const window = resolveDeclaredReportWindow(definition, req.query as Record<string, string | undefined>);
    const scope = resolveBranchScope(req);
    let result;
    try {
      result = runReport(db, definition.id, window, scope);
    } catch (err) {
      if (err instanceof UnsupportedPeriodError || err instanceof InvalidReportWindowError) throw new HttpError(400, err.message);
      if (err instanceof UnknownReportError) throw new HttpError(404, err.message);
      throw err;
    }

    const csv = reportToCsv(result, {
      generatedAt: new Date().toISOString(),
      generatedBy: req.user?.fullName,
    });

    writeAudit(req, `Exported report "${result.title}" (${result.boundaries.periodKey}) to CSV`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Report-Period-Key', result.boundaries.periodKey);
    res.setHeader('Content-Disposition', `attachment; filename="${reportExportFilename(result)}"`);
    res.send(csv);
  }),
);
