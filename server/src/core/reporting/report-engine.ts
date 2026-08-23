/**
 * The report engine.
 * ============================================================================
 * Runs a DECLARED report. It is the only place that turns a report definition
 * into numbers, which is what keeps the same metric identical across every
 * surface that shows it.
 *
 * Two things it deliberately does NOT do:
 *   · accept SQL from a caller — a report names metric ids, nothing else;
 *   · resolve its own dates — the calendar authority owns periods, so a
 *     report cannot disagree with Finance about when a month began.
 *
 * Branch scope is applied here rather than in each metric, so a metric author
 * cannot forget it and quietly publish another branch's numbers.
 */
import type BetterSqlite3 from 'better-sqlite3';
import type { ReportingPeriod } from '../calendar/periods.js';
import { metricById, reportById, type MetricDefinition, type ReportDefinition } from './report-catalog.js';
import {
  resolveReportWindow,
  type ReportPeriodSelection,
  type ReportWindowSelection,
  type ResolvedReportWindow,
} from './report-window.js';

export interface ReportScope {
  /** Null when the caller legitimately sees the whole organization. */
  branchId: string | null;
  isAll: boolean;
}

export interface ReportMetricResult {
  id: string;
  label: string;
  unit: MetricDefinition['unit'];
  value: number;
  note: string;
}

export interface ReportResult {
  id: string;
  title: string;
  category: ReportDefinition['category'];
  purpose: string;
  period: ReportPeriodSelection;
  /** Resolved boundaries, echoed so a printed copy can state its own span. */
  boundaries: ResolvedReportWindow;
  scope: { branchId: string | null; isAll: boolean };
  metrics: ReportMetricResult[];
  /** True when every metric returned zero — lets the UI show a real empty state. */
  isEmpty: boolean;
}

export class UnknownReportError extends Error {}
export class UnsupportedPeriodError extends Error {}

function normalizeSelection(period: ReportingPeriod | ReportWindowSelection): ReportWindowSelection {
  return typeof period === 'string' ? { period } : period;
}

function runMetric(
  db: BetterSqlite3.Database,
  metric: MetricDefinition,
  boundaries: ResolvedReportWindow,
  scope: ReportScope,
): number {
  const params: unknown[] = [boundaries.from, boundaries.to];
  let sql = metric.sql;

  // Scope is appended centrally. `isAll` is not "no filter by default": a
  // caller only reaches it by holding organization-wide scope, which the route
  // has already resolved.
  if (!scope.isAll && scope.branchId) {
    sql += ` AND ${metric.scopeAlias}.branch_id = ?`;
    params.push(scope.branchId);
  }

  const row = db.prepare(sql).get(...params) as { value: number | null } | undefined;
  return Number(row?.value ?? 0);
}

/**
 * Executes a report definition.
 *
 * Throws rather than returning a partial result: a report that silently omits
 * a metric it could not compute is worse than one that fails, because the
 * total still looks authoritative.
 */
export function runReport(
  db: BetterSqlite3.Database,
  reportId: string,
  period: ReportingPeriod | ReportWindowSelection,
  scope: ReportScope,
  todayStr?: string,
): ReportResult {
  const definition = reportById(reportId);
  if (!definition) throw new UnknownReportError(`Unknown report '${reportId}'.`);

  const selection = normalizeSelection(period);
  if (selection.period !== 'range' && !definition.periods.includes(selection.period)) {
    throw new UnsupportedPeriodError(`Report '${reportId}' is not defined for the '${selection.period}' period.`);
  }

  const boundaries = resolveReportWindow(selection, {
    allowRange: Boolean(definition.allowsDateRange),
    currentMode: 'to-date',
    todayStr,
  });

  const metrics = definition.metrics.map((id) => {
    const metric = metricById(id);
    // Unreachable through the catalog audit, but a wrong id must never be
    // reported as a zero — that reads as "nothing happened".
    if (!metric) throw new UnknownReportError(`Report '${reportId}' references unknown metric '${id}'.`);
    return {
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      value: runMetric(db, metric, boundaries, scope),
      note: metric.note,
    };
  });

  return {
    id: definition.id,
    title: definition.title,
    category: definition.category,
    purpose: definition.purpose,
    period: boundaries.period,
    boundaries,
    scope: { branchId: scope.branchId, isAll: scope.isAll },
    metrics,
    isEmpty: metrics.every((m) => m.value === 0),
  };
}
