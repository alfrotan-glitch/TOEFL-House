/**
 * Dashboard Summary — the single authoritative source for every Dashboard KPI.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Dashboard audit (docs/DASHBOARD_AUDIT_2026-08-17.md) found that the
 * frontend counted records out of whatever PAGE it happened to have loaded:
 *
 *   D-1  conversion rate divided by the 100-row visitor page → 50% vs a true 20%
 *   D-2  the 7-day cash-flow chart reduced a 500-row transaction page →
 *        today understated by 39,540 AFN (45%) beside a correct KPI tile
 *   D-3  pending leads counted from the same page → 50 vs a true 200
 *   D-5  active students counted from a 2,000-row page → latent, reproduced
 *        as 1,970 vs a true 2,220
 *
 * Raising page limits only moves the ceiling. The fix is that populations are
 * counted in SQL — `COUNT(*)` and `SUM(...)` over the whole scoped table — and
 * the client only ever displays what the server computed.
 *
 * D-4 (client used UTC dates while the server used local dates, a 4.5-hour
 * daily divergence in Asia/Kabul) is fixed by making this module the ONLY
 * definition of "today"/"this month"/"this year" for the Dashboard, and by
 * returning those boundaries in the payload so the frontend never derives them.
 *
 * AUTHORITY MODEL
 * ---------------
 * Every figure below is a SQL aggregate over the caller's resolved branch
 * scope. Nothing is counted in JavaScript from a fetched array. Nothing here
 * reads the HTTP request; the caller resolves scope and passes it in.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { today } from '../../utils/ids.js';
import {
  periodBoundaries,
  addDays,
  type PeriodBoundaries,
  type ReportingPeriod,
} from '../calendar/periods.js';

export { periodBoundaries };
export type { PeriodBoundaries };

export type DashboardPeriod = ReportingPeriod;

export interface DashboardScope {
  /** Null when the caller legitimately sees the whole organization. */
  branchId: string | null;
  isAll: boolean;
}

export interface DashboardSummary {
  scope: 'branch' | 'organization';
  branchId: string | null;
  /** The server's local "today". The client must not compute its own. */
  today: string;
  boundaries: Record<DashboardPeriod, PeriodBoundaries>;
  population: {
    activeStudents: number;
    totalStudents: number;
    activeClasses: number;
    activeTeachers: number;
    totalVisitors: number;
    pendingLeads: number;
    convertedLeads: number;
    /** Whole-population conversion rate, 0-100, rounded. */
    conversionRate: number;
  };
  periods: Record<DashboardPeriod, { newVisitors: number; newStudents: number }>;
  /** Daily income/expense for the trailing N days, summed in SQL. */
  cashFlow: Array<{ date: string; income: number; expense: number }>;
}

/*
 * Period boundaries come from `core/calendar/periods.ts`, the single calendar
 * authority, and are re-exported above so existing importers keep working.
 *
 * Two properties matter here and are enforced there:
 *   - Dates are SERVER LOCAL (`toLocaleDateString('en-CA')`), never UTC (D-4).
 *   - "Month"/"year" are HIJRI SHAMSI periods resolved to their Gregorian span,
 *     so a figure labelled اسد ۱۴۰۵ actually covers اسد ۱۴۰۵ (D-6), and the
 *     Dashboard agrees with payroll, which already pays on Shamsi months.
 */

/** Build `WHERE`-clause fragments that honour branch scope with bound params. */
function scopeClause(scope: DashboardScope, column = 'branch_id'): { sql: string; params: unknown[] } {
  return scope.isAll ? { sql: '', params: [] } : { sql: ` AND ${column} = ?`, params: [scope.branchId] };
}

function countOf(db: BetterSqlite3.Database, sql: string, params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { c: number } | undefined)?.c ?? 0);
}

/**
 * Compute the whole Dashboard summary for a resolved scope.
 *
 * `days` controls the cash-flow window (default 7, matching the chart).
 */
export function buildDashboardSummary(
  db: BetterSqlite3.Database,
  scope: DashboardScope,
  options: { days?: number; todayStr?: string } = {}
): DashboardSummary {
  const todayStr = options.todayStr ?? today();
  const days = Math.min(Math.max(Math.trunc(options.days ?? 7), 1), 90);
  const s = scopeClause(scope);

  // ── Population counts — SQL over the full scoped table, never a page ──────
  const activeStudents = countOf(db, `SELECT COUNT(*) AS c FROM students WHERE status = 'active'${s.sql}`, s.params);
  const totalStudents = countOf(db, `SELECT COUNT(*) AS c FROM students WHERE 1=1${s.sql}`, s.params);
  const activeClasses = countOf(db, `SELECT COUNT(*) AS c FROM classes WHERE status = 'active'${s.sql}`, s.params);
  // `teachers.status` is nullable and a NULL historically means active, which is
  // how the previous client-side count treated it: `(t.status || 'active')`.
  const activeTeachers = countOf(db, `SELECT COUNT(*) AS c FROM teachers WHERE COALESCE(status, 'active') = 'active'${s.sql}`, s.params);

  const totalVisitors = countOf(db, `SELECT COUNT(*) AS c FROM visitors WHERE 1=1${s.sql}`, s.params);
  const pendingLeads = countOf(db, `SELECT COUNT(*) AS c FROM visitors WHERE status IN ('visited','follow_up')${s.sql}`, s.params);
  const convertedLeads = countOf(db, `SELECT COUNT(*) AS c FROM visitors WHERE status = 'registered'${s.sql}`, s.params);
  // Denominator is the FULL visitor population, not a page (D-1).
  const conversionRate = totalVisitors > 0 ? Math.round((convertedLeads / totalVisitors) * 100) : 0;

  // ── Per-period intake counts ──────────────────────────────────────────────
  const boundaries = {
    today: periodBoundaries('today', todayStr),
    month: periodBoundaries('month', todayStr),
    year: periodBoundaries('year', todayStr),
  } satisfies Record<DashboardPeriod, PeriodBoundaries>;

  const periodCounts = (b: PeriodBoundaries) => ({
    newVisitors: countOf(
      db,
      `SELECT COUNT(*) AS c FROM visitors WHERE visit_date >= ? AND visit_date <= ?${s.sql}`,
      [b.from, b.to, ...s.params]
    ),
    newStudents: countOf(
      db,
      `SELECT COUNT(*) AS c FROM students WHERE registration_date >= ? AND registration_date <= ?${s.sql}`,
      [b.from, b.to, ...s.params]
    ),
  });

  // ── Cash flow — SQL GROUP BY, reconciles with /finance/dashboard (D-2) ────
  // Window and axis are both built with `addDays`, pure calendar arithmetic on
  // the date string. Constructing Dates and reformatting them is timezone- and
  // DST-sensitive (see the note on `addDays`), which is how D-4 arose.
  const fromDate = addDays(todayStr, -(days - 1));

  const rows = db
    .prepare(
      `SELECT date,
              COALESCE(SUM(CASE WHEN type = 'income'  THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM financial_transactions
        WHERE date >= ? AND date <= ?${s.sql}
        GROUP BY date`
    )
    .all(fromDate, todayStr, ...s.params) as Array<{ date: string; income: number; expense: number }>;

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const cashFlow: DashboardSummary['cashFlow'] = [];
  for (let i = 0; i < days; i += 1) {
    const iso = addDays(fromDate, i);
    const hit = byDate.get(iso);
    // Days with no activity are returned as explicit zeros so the chart has a
    // continuous axis and an empty period renders as a flat line, not a gap.
    cashFlow.push({ date: iso, income: Number(hit?.income ?? 0), expense: Number(hit?.expense ?? 0) });
  }

  return {
    scope: scope.isAll ? 'organization' : 'branch',
    branchId: scope.isAll ? null : scope.branchId,
    today: todayStr,
    boundaries,
    population: {
      activeStudents, totalStudents, activeClasses, activeTeachers,
      totalVisitors, pendingLeads, convertedLeads, conversionRate,
    },
    periods: {
      today: periodCounts(boundaries.today),
      month: periodCounts(boundaries.month),
      year: periodCounts(boundaries.year),
    },
    cashFlow,
  };
}
