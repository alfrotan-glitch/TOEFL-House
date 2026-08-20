/**
 * Reporting period boundaries — the single calendar authority.
 * ============================================================================
 * WHY THIS MODULE EXISTS (audit finding D-6)
 * ----------------------------------------------------------------------------
 * The Dashboard summed a GREGORIAN month window (`YYYY-MM-01` .. today) while
 * the UI labelled every date in JALALI. Those are not the same period. On
 * 2026-08-17 the Gregorian window opened on 08-01, but the Jalali month the
 * user could see on screen — Asad 1405 — opened on 2026-07-23. Nine days of
 * activity were attributed to the wrong month, and in a real branch ledger
 * that gap held 160,947 AFN of income.
 *
 * The divergence is not an edge case. It is 9-10 days EVERY month, all year,
 * because the two calendars simply do not share boundaries.
 *
 * THE DECISION
 * ----------------------------------------------------------------------------
 * A reporting period means the **Hijri Shamsi (Jalali) period**, because:
 *
 *   1. It is the calendar the user actually sees. A figure labelled اسد ۱۴۰۵
 *      must cover اسد ۱۴۰۵.
 *   2. Payroll already works this way. `core/payroll/class-payroll.ts` resolves
 *      its periods with `jalaliMonthToGregorianRange()` and pays staff for
 *      Shamsi months. A Dashboard on a different calendar would disagree with
 *      the payroll it sits beside.
 *   3. It is how Afghan institutions run their month.
 *
 * Storage is unaffected: the database keeps Gregorian `YYYY-MM-DD`, and this
 * module resolves a Shamsi period to its exact Gregorian span, so every
 * `BETWEEN from AND to` query is unchanged. Conversion happens only here.
 *
 * There is deliberately no dual-calendar arithmetic anywhere else. Jalali is
 * for display and for period boundaries; Gregorian is for storage and
 * comparison. Anything computing `${date.slice(0, 7)}-01` as a "month start"
 * is reintroducing D-6.
 */
import {
  gregorianToJalali,
  jalaliToIso,
  jalaliMonthLength,
  isJalaliLeapYear,
} from '../../utils/jalali.js';
import { today } from '../../utils/ids.js';

/**
 * The reporting periods the system recognises.
 *
 * Reporting requires daily, weekly, monthly, quarterly and annual views, and
 * every one of them is resolved HERE. A report that computed its own month
 * boundary would disagree with Finance the moment the Shamsi and Gregorian
 * months diverged — which they do for nine or ten days of every month.
 */
export type ReportingPeriod = 'today' | 'week' | 'month' | 'quarter' | 'year';

export const REPORTING_PERIODS: readonly ReportingPeriod[] = ['today', 'week', 'month', 'quarter', 'year'];

/** Shamsi quarters: Hamal-Jawza, Saratan-Sunbula, Mizan-Qaws, Jadi-Hut. */
const QUARTER_OF_MONTH = (jm: number): number => Math.floor((jm - 1) / 3) + 1;

export interface PeriodBoundaries {
  period: ReportingPeriod;
  /** Inclusive Gregorian start, 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive Gregorian end, 'YYYY-MM-DD' (never beyond `todayStr`). */
  to: string;
  /** Shamsi period key, e.g. '1405-05' for a month or '1405' for a year. */
  periodKey: string;
  /** Full Gregorian end of the period, ignoring "so far" truncation. */
  periodEnd: string;
}

/**
 * Boundaries for a reporting period, as inclusive Gregorian dates.
 *
 * `to` is clamped to `todayStr`: a month-to-date figure must never include
 * days that have not happened yet, or the Dashboard would show a full-month
 * total on the first day of the month.
 */
export function periodBoundaries(
  period: ReportingPeriod,
  todayStr: string = today()
): PeriodBoundaries {
  const g = parseIsoStrict(todayStr);
  const j = gregorianToJalali(g.y, g.m, g.d);

  if (period === 'today') {
    return {
      period,
      from: todayStr,
      to: todayStr,
      periodKey: `${j.jy}-${pad2(j.jm)}-${pad2(j.jd)}`,
      periodEnd: todayStr,
    };
  }

  if (period === 'week') {
    // A Shamsi week begins on Saturday (Shanbe). JS getUTCDay(): 0=Sunday,
    // so Saturday is 6 and the offset back to the week's start is (day + 1) % 7.
    const jsDay = new Date(Date.UTC(g.y, g.m - 1, g.d)).getUTCDay();
    const from = addDays(todayStr, -((jsDay + 1) % 7));
    const periodEnd = addDays(from, 6);
    const fg = parseIsoStrict(from);
    const fj = gregorianToJalali(fg.y, fg.m, fg.d);
    return {
      period,
      from,
      to: minIso(todayStr, periodEnd),
      periodKey: `${fj.jy}-W${from}`,
      periodEnd,
    };
  }

  if (period === 'quarter') {
    const q = QUARTER_OF_MONTH(j.jm);
    const firstMonth = (q - 1) * 3 + 1;
    const lastMonth = firstMonth + 2;
    const from = jalaliToIso(j.jy, firstMonth, 1);
    const periodEnd = jalaliToIso(j.jy, lastMonth, jalaliMonthLength(j.jy, lastMonth));
    return {
      period,
      from,
      to: minIso(todayStr, periodEnd),
      periodKey: `${j.jy}-Q${q}`,
      periodEnd,
    };
  }

  if (period === 'month') {
    const from = jalaliToIso(j.jy, j.jm, 1);
    const periodEnd = jalaliToIso(j.jy, j.jm, jalaliMonthLength(j.jy, j.jm));
    return {
      period,
      from,
      to: minIso(todayStr, periodEnd),
      periodKey: `${j.jy}-${pad2(j.jm)}`,
      periodEnd,
    };
  }

  // Jalali year: Hamal 1 .. Hut (29 or 30 in a leap year).
  const from = jalaliToIso(j.jy, 1, 1);
  const periodEnd = jalaliToIso(j.jy, 12, isJalaliLeapYear(j.jy) ? 30 : 29);
  return {
    period,
    from,
    to: minIso(todayStr, periodEnd),
    periodKey: String(j.jy),
    periodEnd,
  };
}

/**
 * The inclusive Gregorian span of the Shamsi month containing `todayStr`,
 * NOT truncated at today. Use this for "the whole current month" questions
 * (payroll, month-end); use `periodBoundaries('month')` for month-to-date.
 */
export function currentJalaliMonthSpan(todayStr: string = today()): { from: string; to: string; periodKey: string } {
  const b = periodBoundaries('month', todayStr);
  return { from: b.from, to: b.periodEnd, periodKey: b.periodKey };
}

/**
 * Shift an ISO date by whole days, purely in calendar terms.
 *
 * Deliberately NOT `new Date(iso)` + `setDate()` + reformat. That round trip is
 * timezone-sensitive in a way that is easy to get wrong: `new Date('2026-08-17')`
 * is parsed as UTC midnight, so `toLocaleDateString('en-CA')` returns the
 * PREVIOUS day in any zone behind UTC, while `toISOString()` returns the right
 * one. Mixing the two bases is precisely audit finding D-4. Using UTC accessors
 * throughout keeps the arithmetic independent of the server's zone: the input
 * is already a calendar date, so no zone is involved in the question being asked.
 */
export function addDays(iso: string, days: number): string {
  const g = parseIsoStrict(iso);
  const d = new Date(Date.UTC(g.y, g.m - 1, g.d));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of ISO dates from `from` to `to`. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = parseIsoStrict(from) && from;
  parseIsoStrict(to);
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Parse a stored 'YYYY-MM-DD'. Throws rather than guessing, because a silently
 * mis-parsed boundary produces a plausible-looking but wrong financial total —
 * the exact failure mode this module exists to prevent.
 */
function parseIsoStrict(iso: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!match) throw new Error(`periodBoundaries: expected YYYY-MM-DD, received ${JSON.stringify(iso)}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`periodBoundaries: invalid date ${iso}`);
  return { y, m, d };
}
