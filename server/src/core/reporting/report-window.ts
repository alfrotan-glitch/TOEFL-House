/**
 * Canonical reporting window parsing and resolution.
 * ============================================================================
 * A reporting consumer may choose one of three window shapes:
 *   · the current named period (`today`, `week`, `month`, `quarter`, `year`)
 *   · a historical named period, addressed by its canonical Shamsi key
 *   · an explicit bounded Gregorian date range, but ONLY when that report
 *     definition allows range mode
 *
 * Every route and engine entry point consumes this module so period parsing,
 * key validation and range bounds cannot drift across reporting surfaces.
 */
import {
  REPORTING_PERIODS,
  periodBoundaries,
  periodBoundariesForKey,
  type ReportingPeriod,
} from '../calendar/periods.js';

export const MAX_REPORT_RANGE_DAYS = 366;
export type ReportPeriodSelection = ReportingPeriod | 'range';

export class InvalidReportWindowError extends Error {}

export interface ReportWindowSelection {
  period: ReportPeriodSelection;
  key?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface ResolvedReportWindow {
  kind: 'current' | 'historical' | 'range';
  period: ReportPeriodSelection;
  from: string;
  to: string;
  periodEnd: string;
  periodKey: string;
  label: string;
}

interface ResolveOptions {
  allowRange: boolean;
  /** Current named periods may mean either "to date" or the full period. */
  currentMode?: 'to-date' | 'full-period';
  todayStr?: string;
}

function assertIsoDate(value: string, field: 'from' | 'to'): string {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new InvalidReportWindowError(`Range reports require a valid ${field} date (YYYY-MM-DD).`);
  }
  const d = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== normalized) {
    throw new InvalidReportWindowError(`Range reports require a real ${field} date (YYYY-MM-DD).`);
  }
  return normalized;
}

function inclusiveSpanDays(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
}

export function parseReportWindowQuery(
  query: Record<string, string | undefined>,
  options: { allowRange: boolean; defaultPeriod?: ReportingPeriod } = { allowRange: false },
): ReportWindowSelection {
  const requestedPeriod = (query.period ?? options.defaultPeriod ?? 'month').trim();

  if (requestedPeriod === 'range') {
    if (!options.allowRange) {
      throw new InvalidReportWindowError('This report does not allow an explicit date range.');
    }
    if (query.key?.trim()) {
      throw new InvalidReportWindowError('Range reports accept from/to dates, not a period key.');
    }
    return {
      period: 'range',
      from: assertIsoDate(query.from ?? '', 'from'),
      to: assertIsoDate(query.to ?? '', 'to'),
    };
  }

  if (!REPORTING_PERIODS.includes(requestedPeriod as ReportingPeriod)) {
    throw new InvalidReportWindowError(`Unknown period '${requestedPeriod}'.`);
  }
  if ((query.from?.trim() || query.to?.trim()) && requestedPeriod !== 'range') {
    throw new InvalidReportWindowError('Named-period reports do not accept from/to dates. Use period=range instead.');
  }

  return {
    period: requestedPeriod as ReportingPeriod,
    key: query.key?.trim() || null,
  };
}

export function resolveReportWindow(
  selection: ReportWindowSelection,
  options: ResolveOptions,
): ResolvedReportWindow {
  if (selection.period === 'range') {
    if (!options.allowRange) {
      throw new InvalidReportWindowError('This report does not allow an explicit date range.');
    }
    const from = assertIsoDate(selection.from ?? '', 'from');
    const to = assertIsoDate(selection.to ?? '', 'to');
    if (from > to) throw new InvalidReportWindowError('from must not be after to.');
    const spanDays = inclusiveSpanDays(from, to);
    if (spanDays > MAX_REPORT_RANGE_DAYS) {
      throw new InvalidReportWindowError(`Range may not exceed ${MAX_REPORT_RANGE_DAYS} days.`);
    }
    return {
      kind: 'range',
      period: 'range',
      from,
      to,
      periodEnd: to,
      periodKey: `range-${from}_to_${to}`,
      label: `${from} → ${to}`,
    };
  }

  const period = selection.period;
  const key = selection.key?.trim();
  if (key) {
    const historical = periodBoundariesForKey(key);
    if (historical.period !== period) {
      throw new InvalidReportWindowError(`Period key '${key}' describes a ${historical.period}, not a ${period}.`);
    }
    return {
      kind: 'historical',
      period,
      from: historical.from,
      to: historical.periodEnd,
      periodEnd: historical.periodEnd,
      periodKey: historical.periodKey,
      label: historical.periodKey,
    };
  }

  const current = periodBoundaries(period, options.todayStr);
  return {
    kind: 'current',
    period,
    from: current.from,
    to: options.currentMode === 'full-period' ? current.periodEnd : current.to,
    periodEnd: current.periodEnd,
    periodKey: current.periodKey,
    label: current.periodKey,
  };
}
