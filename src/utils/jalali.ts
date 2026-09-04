/**
 * Hijri Shamsi (Solar Hijri / Jalali) calendar — Afghanistan
 * ============================================================================
 * ARCHITECTURE DECISION
 * ----------------------------------------------------------------------------
 * The database keeps storing **Gregorian** `YYYY-MM-DD`. This module converts
 * only at the edges: display and user input.
 *
 * Why: 77+ SQL queries rely on `YYYY-MM-DD` strings sorting chronologically
 * and on SQLite's own `date()` / `datetime()` functions. Shamsi strings sort
 * correctly too, but SQLite's date functions would silently misinterpret
 * them, and every existing row would need migrating. Converting at the edge
 * is the industry-standard approach and keeps the financial core untouched.
 *
 * AFGHAN MONTH NAMES
 * ----------------------------------------------------------------------------
 * Afghanistan uses the SAME solar calendar as Iran but DIFFERENT month names
 * (حمل/ثور/جوزا…, not فروردین/اردیبهشت…). Using an Iranian locale would show
 * the wrong month name to every Afghan user, so the names are explicit here
 * rather than delegated to `Intl`.
 *
 * The conversion itself is the standard Borkowski algorithm, verified against
 * ICU (`en-u-ca-persian`) for every day from 1990 to 2045 — 20,454 days, zero
 * mismatches, and a clean Gregorian→Jalali→Gregorian round trip.
 */

/** Afghan Solar Hijri month names (Dari), in calendar order. */
export const AFGHAN_MONTHS_FA = [
  'حمل', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله',
  'میزان', 'عقرب', 'قوس', 'جدی', 'دلو', 'حوت',
] as const;

/** Latin transliteration, for reports that must stay ASCII. */
export const AFGHAN_MONTHS_EN = [
  'Hamal', 'Sawr', 'Jawza', 'Saratan', 'Asad', 'Sunbula',
  'Mizan', 'Aqrab', 'Qaws', 'Jadi', 'Dalw', 'Hut',
] as const;

/** Weekday names starting Saturday, the first day of the Afghan week. */
export const AFGHAN_WEEKDAYS_FA = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'] as const;

export interface JalaliDate {
  jy: number;
  jm: number;
  jd: number;
}

function div(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Gregorian → Jalali. Month arguments are 1-based. */
export function gregorianToJalali(gy: number, gm: number, gd: number): JalaliDate {
  const gDaysInMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  const year = gy - (gy <= 1600 ? 621 : 1600);
  const gy2 = gm > 2 ? year + 1 : year;
  let days =
    365 * year + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) - 80 + gd + gDaysInMonth[gm - 1];
  jy += 33 * div(days, 12053);
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    jy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return { jy, jm, jd };
}

/** Jalali → Gregorian. Month arguments are 1-based. */
export function jalaliToGregorian(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number } {
  let gy = jy <= 979 ? 621 : 1600;
  const year = jy - (jy <= 979 ? 0 : 979);
  let days =
    365 * year + div(year, 33) * 8 + div((year % 33) + 3, 4) + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * div(days, 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * div(--days, 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    gy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const isLeap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthLengths = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  for (; gm <= 12; gm++) {
    if (gd <= monthLengths[gm]) break;
    gd -= monthLengths[gm];
  }
  return { gy, gm, gd };
}

/** True when a Jalali year is a leap year (Hut has 30 days instead of 29). */
export function isJalaliLeapYear(jy: number): boolean {
  const g = jalaliToGregorian(jy + 1, 1, 1);
  const prev = jalaliToGregorian(jy, 1, 1);
  const days = Math.round((Date.UTC(g.gy, g.gm - 1, g.gd) - Date.UTC(prev.gy, prev.gm - 1, prev.gd)) / 86400000);
  return days === 366;
}

/** Number of days in a Jalali month. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

/**
 * True when the Jalali parts name a real calendar date. The conversion
 * algorithm itself happily folds an impossible date (Hut 30 of a non-leap
 * year) onto the NEXT day's Gregorian value; a caller that round-trips
 * without this check would silently store a date the user never chose.
 */
export function isValidJalaliDate(jy: number, jm: number, jd: number): boolean {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return false;
  if (jm < 1 || jm > 12) return false;
  return jd >= 1 && jd <= jalaliMonthLength(jy, jm);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parses a stored Gregorian 'YYYY-MM-DD' (optionally with a time part). */
function parseIso(value: string): { gy: number; gm: number; gd: number } | null {
  const m = ISO_DATE.exec(String(value ?? '').trim());
  if (!m) return null;
  const gy = Number(m[1]);
  const gm = Number(m[2]);
  const gd = Number(m[3]);
  if (!gy || gm < 1 || gm > 12 || gd < 1 || gd > 31) return null;
  return { gy, gm, gd };
}

/** Converts a stored Gregorian date string to Jalali parts, or null. */
export function isoToJalali(iso: string): JalaliDate | null {
  const g = parseIso(iso);
  if (!g) return null;
  return gregorianToJalali(g.gy, g.gm, g.gd);
}

/**
 * Converts Jalali parts to the Gregorian 'YYYY-MM-DD' the database stores.
 * Impossible dates are REFUSED, not folded: the algorithm would otherwise
 * return the next day's Gregorian value for e.g. Hut 30 of a non-leap year,
 * and the wrong date would be stored as if the user had chosen it.
 */
export function jalaliToIso(jy: number, jm: number, jd: number): string {
  if (!isValidJalaliDate(jy, jm, jd)) {
    throw new RangeError(`Not a real Jalali date: ${jy}/${jm}/${jd}`);
  }
  const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

/** Today's date in the Jalali calendar, based on local time. */
export function todayJalali(): JalaliDate {
  const now = new Date();
  return gregorianToJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export type JalaliFormat = 'long' | 'short' | 'numeric' | 'month-year';

/**
 * Formats a stored Gregorian date for display in Shamsi.
 *   long       → ۲۴ اسد ۱۴۰۵
 *   short      → ۲۴ اسد
 *   numeric    → ۱۴۰۵/۰۵/۲۴
 *   month-year → اسد ۱۴۰۵
 * Returns '—' for empty/unparsable input so the UI never prints "Invalid Date".
 */
export function formatJalali(iso: string | null | undefined, format: JalaliFormat = 'long', latinDigits = false): string {
  if (!iso) return '—';
  const j = isoToJalali(String(iso));
  if (!j) return '—';
  const month = AFGHAN_MONTHS_FA[j.jm - 1];
  const out =
    format === 'numeric'
      ? `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`
      : format === 'month-year'
        ? `${month} ${j.jy}`
        : format === 'short'
          ? `${j.jd} ${month}`
          : `${j.jd} ${month} ${j.jy}`;
  return latinDigits ? out : toPersianDigits(out);
}

/** Latin transliteration variant, e.g. "24 Asad 1405". */
export function formatJalaliLatin(iso: string | null | undefined, format: JalaliFormat = 'long'): string {
  if (!iso) return '—';
  const j = isoToJalali(String(iso));
  if (!j) return '—';
  const month = AFGHAN_MONTHS_EN[j.jm - 1];
  if (format === 'numeric') return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
  if (format === 'month-year') return `${month} ${j.jy}`;
  if (format === 'short') return `${j.jd} ${month}`;
  return `${j.jd} ${month} ${j.jy}`;
}

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Converts Latin digits to Persian digits for display. */
export function toPersianDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
}

/** Converts Persian/Arabic digits back to Latin, for parsing user input. */
export function toLatinDigits(input: string): string {
  return String(input)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * Shows a Shamsi date with the Gregorian one alongside, e.g.
 * "۲۴ اسد ۱۴۰۵ (2026-08-15)" — used during the transition so operators can
 * cross-check against older Gregorian paperwork.
 */
export function formatDual(iso: string | null | undefined, format: JalaliFormat = 'long'): string {
  if (!iso) return '—';
  const shamsi = formatJalali(iso, format);
  if (shamsi === '—') return '—';
  return `${shamsi} (${String(iso).slice(0, 10)})`;
}

// ── Payroll / reporting periods ────────────────────────────────────────────

/** A Shamsi payroll period key, e.g. '1405-05'. */
export function jalaliPeriodKey(jy: number, jm: number): string {
  return `${jy}-${String(jm).padStart(2, '0')}`;
}

/** Human label for a Shamsi period key, e.g. 'اسد ۱۴۰۵'. */
export function jalaliPeriodLabel(periodKey: string, latinDigits = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey ?? '').trim());
  if (!m) return String(periodKey ?? '');
  const jm = Number(m[2]);
  if (jm < 1 || jm > 12) return String(periodKey);
  const label = `${AFGHAN_MONTHS_FA[jm - 1]} ${m[1]}`;
  return latinDigits ? label : toPersianDigits(label);
}

/**
 * The Gregorian half-open range covering a Shamsi month.
 * Returns inclusive `start` and `end` dates in stored 'YYYY-MM-DD' form, so
 * existing `BETWEEN start AND end` SQL keeps working unchanged.
 */
export function jalaliMonthToGregorianRange(jy: number, jm: number): { start: string; end: string } {
  const start = jalaliToIso(jy, jm, 1);
  const end = jalaliToIso(jy, jm, jalaliMonthLength(jy, jm));
  return { start, end };
}

/** The Shamsi period key that a stored Gregorian date belongs to. */
export function isoToJalaliPeriodKey(iso: string): string | null {
  const j = isoToJalali(iso);
  return j ? jalaliPeriodKey(j.jy, j.jm) : null;
}

/** Recent Shamsi period keys, newest first — for payroll month pickers. */
export function recentJalaliPeriods(count = 8, offsetFuture = 1): string[] {
  const t = todayJalali();
  const keys: string[] = [];
  let jy = t.jy;
  let jm = t.jm + offsetFuture;
  while (jm > 12) { jm -= 12; jy += 1; }
  for (let i = 0; i < count; i++) {
    keys.push(jalaliPeriodKey(jy, jm));
    jm -= 1;
    if (jm < 1) { jm = 12; jy -= 1; }
  }
  return keys;
}

/**
 * Formats a stored Gregorian DATETIME (ISO string) as Shamsi date + local
 * time, e.g. "۲۴ اسد ۱۴۰۵ ۱۴:۳۰". Used for audit/journey/workflow timelines
 * where the clock time matters as much as the day.
 */
export function formatJalaliDateTime(value: string | null | undefined, latinDigits = false): string {
  if (!value) return '—';
  const datePart = formatJalali(value, 'long', true);
  if (datePart === '—') return '—';
  const d = new Date(value);
  const time = Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const out = time ? `${datePart} ${time}` : datePart;
  return latinDigits ? out : toPersianDigits(out);
}

/** Short Shamsi label for chart axes, e.g. "۲۴ اسد". */
export function formatJalaliAxis(value: string | null | undefined): string {
  return formatJalali(value, 'short');
}
