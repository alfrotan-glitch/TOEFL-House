/**
 * THE report catalog.
 * ============================================================================
 * Reporting is a core subsystem, and the required set spans daily, weekly,
 * monthly, quarterly, annual, financial, academic, student, visitor,
 * enrollment, attendance, teacher, payroll, management, operational and audit
 * views. Sixteen categories built as sixteen bespoke endpoints is sixteen
 * chances for the same number to be computed two ways — which is exactly how
 * a dashboard and a report come to disagree.
 *
 * So a report is DECLARED, not hand-written. Each declaration names:
 *
 *   · the metrics it presents, by id — never inline SQL;
 *   · the period granularity it is meaningful at;
 *   · the permission required to read it;
 *   · the category it belongs to.
 *
 * A metric is defined exactly ONCE, in METRIC_CATALOG, together with the SQL
 * that produces it. Every consumer — report, dashboard, export, printed
 * copy — reads the same definition, so two surfaces cannot drift apart. This
 * is the executable form of the metric registry in docs/registries/metrics.md.
 *
 * Scope: this establishes the catalog and the engine. Individual metric
 * definitions are added as each domain's authority is confirmed; a report may
 * only reference metrics that exist, and the audit enforces it.
 */
import {
  operatingExpenseSql,
  operatingIncomeSql,
  capitalExpenditureSql,
  nonExpenseCashMovementSql,
} from '../finance/ledger-classification.js';
import { LEAD_CONVERTED_SQL, LEAD_OPEN_SQL } from '../visitors/lead-lifecycle.js';
import { STUDENT_ATTENDANCE_UNION } from '../academic/attendance-query.js';
import type { ReportingPeriod } from '../calendar/periods.js';

/** What kind of number a metric yields, so consumers format it correctly. */
export type MetricUnit = 'afn' | 'count' | 'percent' | 'days';

export interface MetricDefinition {
  id: string;
  /** Human name, used as the column/row heading. */
  label: string;
  unit: MetricUnit;
  /**
   * SQL producing a single numeric column named `value`.
   *
   * Two bound parameters, in order: the inclusive period start and end
   * (Gregorian 'YYYY-MM-DD'). Branch scope is appended by the engine, which
   * is why every definition must expose a `branch_id` on `{{T}}`.
   */
  sql: string;
  /** The table alias carrying `branch_id`, for scope injection. */
  scopeAlias: string;
  /** Why this number exists — kept with the definition, not in a wiki. */
  note: string;
}

const M = (d: MetricDefinition) => d;

/**
 * Every reportable number, defined once.
 *
 * Financial metrics reuse the ledger-classification authority rather than
 * restating its predicates, so a change to what counts as an operating
 * expense reaches every report at once.
 */
export const METRIC_CATALOG: readonly MetricDefinition[] = [
  M({
    id: 'finance.operating_income',
    label: 'Operating income',
    unit: 'afn',
    scopeAlias: 'ft',
    sql: `SELECT COALESCE(SUM(ft.amount), 0) AS value FROM financial_transactions ft
          WHERE ${operatingIncomeSql('ft')} AND ft.date >= ? AND ft.date <= ?`,
    note: 'Excludes capital injection, which credits the treasury rather than trading income.',
  }),
  M({
    id: 'finance.operating_expense',
    label: 'Operating expense',
    unit: 'afn',
    scopeAlias: 'ft',
    sql: `SELECT COALESCE(SUM(ft.amount), 0) AS value FROM financial_transactions ft
          WHERE ${operatingExpenseSql('ft')} AND ft.date >= ? AND ft.date <= ?`,
    note: 'Excludes capital expenditure and non-expense cash movements.',
  }),
  M({
    id: 'finance.capital_expenditure',
    label: 'Capital expenditure',
    unit: 'afn',
    scopeAlias: 'ft',
    sql: `SELECT COALESCE(SUM(ft.amount), 0) AS value FROM financial_transactions ft
          WHERE ${capitalExpenditureSql('ft')} AND ft.date >= ? AND ft.date <= ?`,
    note: 'Cash out, deliberately not a profit-and-loss cost.',
  }),
  M({
    id: 'finance.non_expense_cash_movement',
    label: 'Non-expense cash movement',
    unit: 'afn',
    scopeAlias: 'ft',
    sql: `SELECT COALESCE(SUM(ft.amount), 0) AS value FROM financial_transactions ft
          WHERE ${nonExpenseCashMovementSql('ft')} AND ft.date >= ? AND ft.date <= ?`,
    note: 'Advances, refunds, owner drawings and charity — movements, not costs.',
  }),
  M({
    id: 'student.registrations',
    label: 'Registrations',
    unit: 'count',
    scopeAlias: 'r',
    sql: `SELECT COUNT(*) AS value FROM registrations r WHERE r.date >= ? AND r.date <= ?`,
    note: 'One row per registration event, not per student.',
  }),
  M({
    id: 'student.new_students',
    label: 'New students',
    unit: 'count',
    scopeAlias: 's',
    sql: `SELECT COUNT(*) AS value FROM students s WHERE s.registration_date >= ? AND s.registration_date <= ?`,
    note: 'Counted on registration date, so a back-dated enrolment lands in the period it belongs to.',
  }),
  M({
    id: 'visitor.new_leads',
    label: 'New leads',
    unit: 'count',
    scopeAlias: 'v',
    sql: `SELECT COUNT(*) AS value FROM visitors v WHERE v.visit_date >= ? AND v.visit_date <= ?`,
    note: 'Every visitor recorded in the period, whatever stage they reached.',
  }),
  M({
    id: 'visitor.converted',
    label: 'Leads converted',
    unit: 'count',
    scopeAlias: 'v',
    sql: `SELECT COUNT(*) AS value FROM visitors v
          WHERE ${LEAD_CONVERTED_SQL} AND v.visit_date >= ? AND v.visit_date <= ?`,
    note: 'Conversion uses the lead-lifecycle authority, not a stage string comparison.',
  }),
  M({
    id: 'visitor.open_leads',
    label: 'Open leads',
    unit: 'count',
    scopeAlias: 'v',
    sql: `SELECT COUNT(*) AS value FROM visitors v
          WHERE ${LEAD_OPEN_SQL} AND v.visit_date >= ? AND v.visit_date <= ?`,
    note: 'Still workable — neither converted nor closed.',
  }),
  M({
    id: 'enrollment.created',
    label: 'Enrollments',
    unit: 'count',
    scopeAlias: 'e',
    sql: `SELECT COUNT(*) AS value FROM enrollments e WHERE e.started_at >= ? AND e.started_at <= ?`,
    note: 'Enrollment events in the period, including those later frozen or transferred.',
  }),
  M({
    id: 'attendance.present',
    label: 'Attendance marked present',
    unit: 'count',
    scopeAlias: 'a',
    sql: `SELECT COUNT(*) AS value FROM (${STUDENT_ATTENDANCE_UNION}) a
          WHERE a.status = 'present' AND a.date >= ? AND a.date <= ?`,
    note: 'Student attendance facts marked present (session rosters plus day-level marks). Row count, not a rate; the rate is derived by the consumer from present/total.',
  }),
  M({
    id: 'attendance.recorded',
    label: 'Attendance records',
    unit: 'count',
    scopeAlias: 'a',
    sql: `SELECT COUNT(*) AS value FROM (${STUDENT_ATTENDANCE_UNION}) a WHERE a.date >= ? AND a.date <= ?`,
    note: 'Student attendance facts (session rosters plus day-level marks). Denominator for any student attendance rate.',
  }),
  M({
    id: 'payroll.teacher_paid',
    label: 'Teacher payroll paid',
    unit: 'afn',
    scopeAlias: 't',
    sql: `SELECT COALESCE(SUM(t.paid_amount), 0) AS value FROM teacher_salary_ledger t
          JOIN financial_transactions ft ON ft.id = t.transaction_id
          WHERE t.status = 'posted' AND ft.date >= ? AND ft.date <= ?`,
    note: 'Posted payroll is dated by its linked financial fact; voided rows are excluded.',
  }),
  M({
    id: 'payroll.employee_paid',
    label: 'Employee payroll paid',
    unit: 'afn',
    scopeAlias: 'e',
    sql: `SELECT COALESCE(SUM(e.paid_amount), 0) AS value FROM employee_salary_ledger e
          JOIN financial_transactions ft ON ft.id = e.transaction_id
          WHERE e.status = 'posted' AND ft.date >= ? AND ft.date <= ?`,
    note: 'Posted employee payroll is dated by its linked financial fact; the envelopes remain separate.',
  }),
  M({
    id: 'academic.sessions_held',
    label: 'Sessions held',
    unit: 'count',
    scopeAlias: 'se',
    sql: `SELECT COUNT(*) AS value FROM sessions se WHERE se.date >= ? AND se.date <= ?`,
    note: 'Scheduled teaching sessions in the period, whatever their outcome.',
  }),
  M({
    id: 'academic.exams_held',
    label: 'Exams held',
    unit: 'count',
    scopeAlias: 'x',
    sql: `SELECT COUNT(*) AS value FROM exams x WHERE x.date >= ? AND x.date <= ?`,
    note: 'Exam events, not candidate sittings.',
  }),
  M({
    id: 'academic.certificates_issued',
    label: 'Certificates issued',
    unit: 'count',
    scopeAlias: 'c',
    sql: `SELECT COUNT(*) AS value FROM certificates c WHERE c.status = 'issued' AND c.issue_date >= ? AND c.issue_date <= ?`,
    note: 'Academic output actually handed over in the period — revoked certificates are recorded history, not issued output.',
  }),
  M({
    id: 'teacher.active',
    label: 'Active teachers',
    unit: 'count',
    scopeAlias: 't',
    sql: `SELECT COUNT(*) AS value FROM teachers t
          WHERE t.status = 'active' AND t.joined_date <= ? AND t.joined_date <= ?`,
    note: 'Point-in-time headcount as at the period end; both bounds are the end date.',
  }),
  M({
    id: 'operational.book_sales',
    label: 'Book sales',
    unit: 'afn',
    scopeAlias: 'bs',
    sql: `SELECT COALESCE(SUM(bs.net_amount), 0) AS value FROM book_sales bs
          WHERE bs.sold_on >= ? AND bs.sold_on <= ?
            AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = bs.id)`,
    note: 'Final Book-sale revenue; student lending moves no money and returned sales are excluded through their immutable contra fact.',
  }),
  M({
    id: 'audit.actions',
    label: 'Audited actions',
    unit: 'count',
    scopeAlias: 'al',
    sql: `SELECT COUNT(*) AS value FROM audit_logs al WHERE al.date >= ? AND al.date <= ?`,
    note: 'Volume of recorded operator activity in the period.',
  }),
];

const BY_ID = new Map(METRIC_CATALOG.map((m) => [m.id, m]));

export function metricById(id: string): MetricDefinition | undefined {
  return BY_ID.get(id);
}

/** The report categories the product is required to cover. */
export const REPORT_CATEGORIES = [
  'financial',
  'academic',
  'student',
  'visitor',
  'enrollment',
  'attendance',
  'teacher',
  'payroll',
  'management',
  'operational',
  'audit',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface ReportDefinition {
  id: string;
  title: string;
  category: ReportCategory;
  /** Permission required to read it. Reporting is not exempt from RBAC. */
  permission: string;
  /** Periods this report is meaningful at. */
  periods: readonly ReportingPeriod[];
  /** Whether the definition authorizes explicit bounded date ranges. */
  allowsDateRange?: boolean;
  /** Metric ids, in presentation order. */
  metrics: readonly string[];
  purpose: string;
}

const ALL_PERIODS: readonly ReportingPeriod[] = ['today', 'week', 'month', 'quarter', 'year'];

export const REPORT_CATALOG: readonly ReportDefinition[] = [
  {
    id: 'financial-summary',
    title: 'Financial summary',
    category: 'financial',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: [
      'finance.operating_income',
      'finance.operating_expense',
      'finance.capital_expenditure',
      'finance.non_expense_cash_movement',
    ],
    purpose: 'What the branch earned and spent, with cash movements kept out of the trading result.',
  },
  {
    id: 'student-intake',
    title: 'Student intake',
    category: 'student',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['student.new_students', 'student.registrations'],
    purpose: 'How many students joined, and how many registration events were taken.',
  },
  {
    id: 'visitor-pipeline',
    title: 'Visitor pipeline',
    category: 'visitor',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['visitor.new_leads', 'visitor.converted', 'visitor.open_leads'],
    purpose: 'Lead volume and what became of it, using the lead-lifecycle authority.',
  },
  {
    id: 'enrollment-activity',
    title: 'Enrollment activity',
    category: 'enrollment',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['enrollment.created'],
    purpose: 'Enrollment events recorded in the period.',
  },
  {
    id: 'attendance-summary',
    title: 'Attendance summary',
    category: 'attendance',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['attendance.recorded', 'attendance.present'],
    purpose: 'Attendance volume and presence, from which a rate can be derived consistently.',
  },
  {
    id: 'payroll-summary',
    title: 'Payroll summary',
    category: 'payroll',
    permission: 'Payroll.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['payroll.teacher_paid', 'payroll.employee_paid'],
    purpose: 'Payroll actually paid in the period, with reversals excluded.',
  },
  {
    id: 'management-overview',
    title: 'Management overview',
    category: 'management',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: [
      'finance.operating_income',
      'finance.operating_expense',
      'student.new_students',
      'visitor.converted',
    ],
    purpose: 'The four numbers a branch manager is accountable for, on one page.',
  },
  {
    id: 'academic-delivery',
    title: 'Academic delivery',
    category: 'academic',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['academic.sessions_held', 'academic.exams_held', 'academic.certificates_issued'],
    purpose: 'What was actually taught, examined and awarded in the period.',
  },
  {
    id: 'teacher-roster',
    title: 'Teacher roster',
    category: 'teacher',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['teacher.active'],
    purpose: 'Active teaching headcount as at the period end.',
  },
  {
    id: 'operational-summary',
    title: 'Operational summary',
    category: 'operational',
    permission: 'Report.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['operational.book_sales', 'academic.sessions_held'],
    purpose: 'Day-to-day operational output that is not academic or financial reporting.',
  },
  {
    id: 'audit-activity',
    title: 'Audit activity',
    category: 'audit',
    permission: 'Audit.View',
    periods: ALL_PERIODS,
    allowsDateRange: true,
    metrics: ['audit.actions'],
    purpose: 'Recorded operator activity, for review.',
  },
];

export function reportById(id: string): ReportDefinition | undefined {
  return REPORT_CATALOG.find((r) => r.id === id);
}
