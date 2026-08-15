/**
 * Hijri Shamsi (Afghan Solar) calendar — regression suite
 * ============================================================================
 * The ERP stores Gregorian dates and converts at the edges. That contract only
 * holds if the conversion is exact, so these tests verify it against Node's
 * ICU Persian calendar (an independent implementation) rather than against
 * hand-picked values that could encode the same mistake twice.
 *
 * Also locks in the Afghan-specific requirements:
 *   - Afghan month names (حمل/ثور/…), NOT Iranian ones (فروردین/…).
 *   - Payroll periods are Shamsi months resolved to exact Gregorian spans.
 *   - Legacy Gregorian period keys keep working.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gregorianToJalali,
  jalaliToGregorian,
  isoToJalali,
  jalaliToIso,
  formatJalali,
  formatJalaliLatin,
  formatDual,
  jalaliMonthLength,
  isJalaliLeapYear,
  jalaliMonthToGregorianRange,
  isoToJalaliPeriodKey,
  jalaliPeriodLabel,
  recentJalaliPeriods,
  toPersianDigits,
  toLatinDigits,
  AFGHAN_MONTHS_FA,
} from '../utils/jalali.js';
import { toPeriodKey, currentJalaliPeriodKey } from '../core/payroll/class-payroll.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('conversion correctness (verified against ICU)', () => {
  it('matches ICU for every day across a 55-year span', () => {
    const fmt = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
    });
    let checked = 0;
    const mismatches: string[] = [];
    for (let t = Date.UTC(1990, 0, 1); t <= Date.UTC(2045, 11, 31); t += 86400000) {
      const d = new Date(t);
      const gy = d.getUTCFullYear(), gm = d.getUTCMonth() + 1, gd = d.getUTCDate();
      const j = gregorianToJalali(gy, gm, gd);
      const parts = Object.fromEntries(
        fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
      );
      if (Number(parts.year) !== j.jy || Number(parts.month) !== j.jm || Number(parts.day) !== j.jd) {
        if (mismatches.length < 5) mismatches.push(`${gy}-${gm}-${gd} → got ${j.jy}-${j.jm}-${j.jd}, ICU ${parts.year}-${parts.month}-${parts.day}`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20000);
    expect(mismatches).toEqual([]);
  });

  it('round-trips Gregorian → Jalali → Gregorian without drift', () => {
    const failures: string[] = [];
    for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2035, 11, 31); t += 86400000) {
      const d = new Date(t);
      const gy = d.getUTCFullYear(), gm = d.getUTCMonth() + 1, gd = d.getUTCDate();
      const j = gregorianToJalali(gy, gm, gd);
      const back = jalaliToGregorian(j.jy, j.jm, j.jd);
      if (back.gy !== gy || back.gm !== gm || back.gd !== gd) {
        if (failures.length < 5) failures.push(`${gy}-${gm}-${gd}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('handles Nawroz (1 Hamal) and year boundaries', () => {
    // 1 Hamal 1405 = 21 March 2026 (Afghan new year).
    expect(jalaliToIso(1405, 1, 1)).toBe('2026-03-21');
    expect(isoToJalali('2026-03-21')).toEqual({ jy: 1405, jm: 1, jd: 1 });
    // The day before is the last day of Hut 1404.
    const prev = isoToJalali('2026-03-20')!;
    expect(prev.jy).toBe(1404);
    expect(prev.jm).toBe(12);
  });

  it('computes month lengths and leap years correctly', () => {
    for (let m = 1; m <= 6; m++) expect(jalaliMonthLength(1405, m)).toBe(31);
    for (let m = 7; m <= 11; m++) expect(jalaliMonthLength(1405, m)).toBe(30);
    expect([29, 30]).toContain(jalaliMonthLength(1405, 12));
    // A leap year's Hut has 30 days; a common year's has 29.
    expect(jalaliMonthLength(1403, 12)).toBe(isJalaliLeapYear(1403) ? 30 : 29);
    // Cross-check leap detection against real year lengths.
    for (const jy of [1400, 1401, 1402, 1403, 1404, 1405, 1406]) {
      const start = jalaliToGregorian(jy, 1, 1);
      const next = jalaliToGregorian(jy + 1, 1, 1);
      const days = Math.round((Date.UTC(next.gy, next.gm - 1, next.gd) - Date.UTC(start.gy, start.gm - 1, start.gd)) / 86400000);
      expect(days).toBe(isJalaliLeapYear(jy) ? 366 : 365);
    }
  });
});

describe('Afghan localisation (not Iranian)', () => {
  it('uses Afghan month names', () => {
    expect(AFGHAN_MONTHS_FA[0]).toBe('حمل');
    expect(AFGHAN_MONTHS_FA[4]).toBe('اسد');
    // Iranian names must never appear.
    expect(AFGHAN_MONTHS_FA as readonly string[]).not.toContain('فروردین');
    expect(AFGHAN_MONTHS_FA as readonly string[]).not.toContain('مرداد');
  });

  it('formats a stored Gregorian date in Afghan Shamsi', () => {
    expect(formatJalali('2026-08-15', 'long', true)).toBe('24 اسد 1405');
    expect(formatJalaliLatin('2026-08-15', 'long')).toBe('24 Asad 1405');
    expect(formatJalali('2026-08-15', 'numeric', true)).toBe('1405/05/24');
    expect(formatJalali('2026-08-15', 'month-year', true)).toBe('اسد 1405');
  });

  it('renders Persian digits and parses them back', () => {
    expect(toPersianDigits('1405')).toBe('۱۴۰۵');
    expect(toLatinDigits('۱۴۰۵')).toBe('1405');
    expect(toLatinDigits('١٤٠٥')).toBe('1405'); // Arabic-Indic too
    expect(formatJalali('2026-08-15', 'long')).toContain('۱۴۰۵');
  });

  it('shows both calendars during the transition', () => {
    expect(formatDual('2026-08-15', 'long')).toBe('۲۴ اسد ۱۴۰۵ (2026-08-15)');
  });

  it('never prints "Invalid Date" for bad input', () => {
    for (const bad of [null, undefined, '', 'not-a-date', '0000']) {
      expect(formatJalali(bad as never)).toBe('—');
      expect(formatDual(bad as never)).toBe('—');
    }
  });
});

describe('payroll periods are Shamsi months', () => {
  it('resolves a Shamsi month to its exact Gregorian span', () => {
    // Asad 1405 = 23 July 2026 .. 22 August 2026.
    expect(jalaliMonthToGregorianRange(1405, 5)).toEqual({ start: '2026-07-23', end: '2026-08-22' });
  });

  it('spans are contiguous and never overlap across a whole year', () => {
    let prevEnd: string | null = null;
    for (let m = 1; m <= 12; m++) {
      const { start, end } = jalaliMonthToGregorianRange(1405, m);
      expect(start <= end).toBe(true);
      if (prevEnd) {
        const nextDay = new Date(Date.parse(`${prevEnd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        expect(start).toBe(nextDay); // no gap, no overlap
      }
      prevEnd = end;
    }
  });

  it('maps a stored date to the Shamsi period that contains it', () => {
    expect(isoToJalaliPeriodKey('2026-08-15')).toBe('1405-05');
    expect(isoToJalaliPeriodKey('2026-07-22')).toBe('1405-04'); // last day of previous
    expect(isoToJalaliPeriodKey('2026-07-23')).toBe('1405-05'); // first day
  });

  it('labels periods with Afghan month names', () => {
    expect(jalaliPeriodLabel('1405-05', true)).toBe('اسد 1405');
    expect(jalaliPeriodLabel('1405-01', true)).toBe('حمل 1405');
  });

  it('accepts Shamsi keys, Afghan month names and legacy Gregorian input', () => {
    expect(toPeriodKey('1405-05')).toBe('1405-05');
    expect(toPeriodKey('1405/5')).toBe('1405-05');
    expect(toPeriodKey('اسد 1405')).toBe('1405-05');
    expect(toPeriodKey('اسد ۱۴۰۵')).toBe('1405-05'); // Persian digits
    expect(toPeriodKey('Asad 1405')).toBe('1405-05');
    // Legacy Gregorian input converts rather than silently failing.
    expect(toPeriodKey('2026-08')).toBe('1405-05');
    expect(toPeriodKey('August 2026')).toBe('1405-05');
    expect(toPeriodKey('rubbish')).toBe('');
  });

  it('the current period is a valid Shamsi key', () => {
    expect(currentJalaliPeriodKey()).toMatch(/^1[34]\d{2}-(0[1-9]|1[0-2])$/);
  });

  it('recent period pickers walk backwards without invalid months', () => {
    const keys = recentJalaliPeriods(14);
    expect(keys).toHaveLength(14);
    for (const k of keys) expect(k).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
  });
});

describe('frontend and backend calendar modules stay identical', () => {
  it('server/src/utils/jalali.ts mirrors src/utils/jalali.ts', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const frontend = fs.readFileSync(path.join(repoRoot, 'src', 'utils', 'jalali.ts'), 'utf8');
    const backend = fs.readFileSync(path.join(repoRoot, 'server', 'src', 'utils', 'jalali.ts'), 'utf8');
    // The backend copy carries an extra "mirrored file" header; compare bodies.
    const marker = '/**\n * Hijri Shamsi';
    expect(backend.slice(backend.indexOf(marker))).toBe(frontend.slice(frontend.indexOf(marker)));
  });
});
