/**
 * Reporting period boundaries — the calendar authority (audit D-6, D-8).
 * ============================================================================
 * A reporting period is a HIJRI SHAMSI period resolved to its Gregorian span.
 * Before this was fixed, "this month" was `${today.slice(0, 7)}-01` .. today —
 * a Gregorian window presented under a Jalali label. The two calendars share
 * no boundaries, so 9-10 days were misattributed EVERY month; on a real branch
 * ledger that gap held 160,947 AFN of income.
 *
 * D-8 recorded that a month-boundary mutant was killed by 0 of 9 tests. These
 * tests exist so that boundary arithmetic can never silently move again.
 */
import { describe, expect, it } from 'vitest';
import {
  periodBoundaries,
  currentJalaliMonthSpan,
  type ReportingPeriod,
} from '../core/calendar/periods.js';
import {
  gregorianToJalali,
  jalaliToIso,
  jalaliMonthLength,
  isJalaliLeapYear,
  isoToJalaliPeriodKey,
} from '../utils/jalali.js';

/** Every date in an inclusive Gregorian range. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('D-6 — month boundaries follow the Shamsi calendar', () => {
  it('resolves 2026-08-17 to Asad 1405, not Gregorian August', () => {
    const b = periodBoundaries('month', '2026-08-17');
    expect(b.periodKey).toBe('1405-05');
    expect(b.from).toBe('2026-07-23');
    expect(b.periodEnd).toBe('2026-08-22');
    expect(b.from).not.toBe('2026-08-01');
  });

  it('every day inside the window belongs to the labelled Shamsi month', () => {
    const b = periodBoundaries('month', '2026-08-17');
    for (const day of eachDay(b.from, b.periodEnd)) {
      expect(isoToJalaliPeriodKey(day)).toBe(b.periodKey);
    }
  });

  it('the day before the window belongs to the PREVIOUS Shamsi month', () => {
    const b = periodBoundaries('month', '2026-08-17');
    const before = new Date(`${b.from}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    expect(isoToJalaliPeriodKey(before.toISOString().slice(0, 10))).not.toBe(b.periodKey);
  });

  it('the day after the window belongs to the NEXT Shamsi month', () => {
    const b = periodBoundaries('month', '2026-08-17');
    const after = new Date(`${b.periodEnd}T00:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 1);
    expect(isoToJalaliPeriodKey(after.toISOString().slice(0, 10))).not.toBe(b.periodKey);
  });

  it('holds for a full Gregorian year of sample dates', () => {
    for (let m = 1; m <= 12; m += 1) {
      for (const day of ['01', '15', '28']) {
        const iso = `2026-${String(m).padStart(2, '0')}-${day}`;
        const b = periodBoundaries('month', iso);
        expect(isoToJalaliPeriodKey(iso)).toBe(b.periodKey);
        expect(b.from <= iso).toBe(true);
        expect(iso <= b.periodEnd).toBe(true);
      }
    }
  });
});

describe('Shamsi month transitions — the exact boundary days', () => {
  // Walk several consecutive Shamsi months and assert each first/last day.
  it('first and last day of each month resolve to that same month', () => {
    for (let jm = 1; jm <= 12; jm += 1) {
      const first = jalaliToIso(1405, jm, 1);
      const last = jalaliToIso(1405, jm, jalaliMonthLength(1405, jm));
      const bFirst = periodBoundaries('month', first);
      const bLast = periodBoundaries('month', last);
      const key = `1405-${String(jm).padStart(2, '0')}`;
      expect(bFirst.periodKey).toBe(key);
      expect(bFirst.from).toBe(first);
      expect(bLast.periodKey).toBe(key);
      expect(bLast.periodEnd).toBe(last);
    }
  });

  it('on the first day of a month, month-to-date covers exactly that one day', () => {
    const first = jalaliToIso(1405, 6, 1);
    const b = periodBoundaries('month', first);
    expect(b.from).toBe(first);
    expect(b.to).toBe(first); // clamped to "today", never the whole month
  });

  it('consecutive months are contiguous and non-overlapping', () => {
    for (let jm = 1; jm < 12; jm += 1) {
      const end = periodBoundaries('month', jalaliToIso(1405, jm, 15)).periodEnd;
      const nextStart = periodBoundaries('month', jalaliToIso(1405, jm + 1, 15)).from;
      const dayAfterEnd = new Date(`${end}T00:00:00Z`);
      dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);
      expect(nextStart).toBe(dayAfterEnd.toISOString().slice(0, 10));
    }
  });

  it('handles the Hamal 1 (Nawruz) year rollover', () => {
    const nawruz = jalaliToIso(1405, 1, 1);
    const b = periodBoundaries('month', nawruz);
    expect(b.periodKey).toBe('1405-01');
    expect(b.from).toBe(nawruz);
    const dayBefore = new Date(`${nawruz}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    // The previous day is the last day of the previous Shamsi YEAR.
    expect(isoToJalaliPeriodKey(dayBefore.toISOString().slice(0, 10))).toBe('1404-12');
  });

  it('handles Hut in both a leap and a common Shamsi year', () => {
    for (const jy of [1403, 1404, 1405, 1406, 1407, 1408]) {
      const len = jalaliMonthLength(jy, 12);
      expect(len).toBe(isJalaliLeapYear(jy) ? 30 : 29);
      const last = jalaliToIso(jy, 12, len);
      const b = periodBoundaries('month', last);
      expect(b.periodKey).toBe(`${jy}-12`);
      expect(b.periodEnd).toBe(last);
    }
  });
});

describe('Shamsi year boundaries', () => {
  it('the year window opens on Nawruz, not 1 January', () => {
    const b = periodBoundaries('year', '2026-08-17');
    expect(b.periodKey).toBe('1405');
    expect(b.from).toBe('2026-03-21');
    expect(b.from).not.toBe('2026-01-01');
  });

  it('a January date belongs to the PREVIOUS Shamsi year', () => {
    const b = periodBoundaries('year', '2026-01-15');
    expect(b.periodKey).toBe('1404');
    expect(b.from < '2026-01-01').toBe(true);
  });

  it('the year window ends on the correct Hut length in a LEAP Shamsi year', () => {
    // 1403 and 1408 are leap (Hut = 30 days); 1405 is not (Hut = 29).
    for (const jy of [1403, 1408]) {
      expect(isJalaliLeapYear(jy)).toBe(true);
      const lastDay = jalaliToIso(jy, 12, 30);
      const b = periodBoundaries('year', lastDay);
      expect(b.periodKey).toBe(String(jy));
      // periodEnd must be the 30th, not the 29th, or a day falls outside the year.
      expect(b.periodEnd).toBe(lastDay);
      expect(b.to).toBe(lastDay);
    }
  });

  it('the last day of a leap Hut is still inside its own year window', () => {
    const jy = 1403;
    const lastDay = jalaliToIso(jy, 12, 30);
    const b = periodBoundaries('year', lastDay);
    expect(b.from <= lastDay && lastDay <= b.periodEnd).toBe(true);
  });

  it('a common year ends on Hut 29', () => {
    const jy = 1405;
    expect(isJalaliLeapYear(jy)).toBe(false);
    const b = periodBoundaries('year', jalaliToIso(jy, 12, 29));
    expect(b.periodEnd).toBe(jalaliToIso(jy, 12, 29));
  });

  it('every day in the year window maps to the same Shamsi year', () => {
    const b = periodBoundaries('year', '2026-08-17');
    for (const day of [b.from, '2026-06-01', '2026-08-17']) {
      expect(String(gregorianToJalali(
        Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))
      ).jy)).toBe(b.periodKey);
    }
  });
});

describe('Invariants that must hold for every period', () => {
  const periods: ReportingPeriod[] = ['today', 'month', 'year'];
  const samples = ['2026-01-01', '2026-03-20', '2026-03-21', '2026-08-17', '2026-12-31', '2027-02-28'];

  it('never returns a window that ends after today', () => {
    for (const todayStr of samples) {
      for (const p of periods) {
        const b = periodBoundaries(p, todayStr);
        expect(b.to <= todayStr).toBe(true);
        expect(b.from <= b.to).toBe(true);
      }
    }
  });

  it('today is always inside its own window', () => {
    for (const todayStr of samples) {
      for (const p of periods) {
        const b = periodBoundaries(p, todayStr);
        expect(b.from <= todayStr && todayStr <= b.to).toBe(true);
      }
    }
  });

  it('windows nest: today within month within year', () => {
    for (const todayStr of samples) {
      const d = periodBoundaries('today', todayStr);
      const m = periodBoundaries('month', todayStr);
      const y = periodBoundaries('year', todayStr);
      expect(m.from <= d.from).toBe(true);
      expect(y.from <= m.from).toBe(true);
    }
  });

  it('is a pure function — same input, same output', () => {
    const a = periodBoundaries('month', '2026-08-17');
    const b = periodBoundaries('month', '2026-08-17');
    expect(a).toEqual(b);
  });

  it('rejects malformed input rather than guessing a window', () => {
    for (const bad of ['', 'not-a-date', '2026-8-17', '20260817', '2026-13-01', '2026-08-00']) {
      expect(() => periodBoundaries('month', bad)).toThrow();
    }
  });

  it('currentJalaliMonthSpan returns the untruncated month', () => {
    const span = currentJalaliMonthSpan('2026-08-17');
    expect(span.from).toBe('2026-07-23');
    expect(span.to).toBe('2026-08-22'); // NOT clamped to today
    expect(span.periodKey).toBe('1405-05');
  });
});

describe('Agreement with payroll, which already reports on Shamsi months', () => {
  it('produces the same span payroll uses for the same period key', async () => {
    const { jalaliMonthToGregorianRange } = await import('../utils/jalali.js');
    for (const iso of ['2026-01-15', '2026-05-05', '2026-08-17', '2026-11-30']) {
      const b = periodBoundaries('month', iso);
      const [jy, jm] = b.periodKey.split('-').map(Number);
      const payroll = jalaliMonthToGregorianRange(jy, jm);
      expect(b.from).toBe(payroll.start);
      expect(b.periodEnd).toBe(payroll.end);
    }
  });
});
