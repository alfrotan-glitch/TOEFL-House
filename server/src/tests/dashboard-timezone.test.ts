/**
 * Timezone invariance for Dashboard/Finance date handling (audit D-4, D-6).
 * ============================================================================
 * The original defect was a date basis MISMATCH: some code derived days with
 * `toISOString()` (UTC) while the rest used `toLocaleDateString('en-CA')`
 * (server local). In Asia/Kabul (UTC+04:30) those disagree for the first 4.5
 * hours of every day, so a chart axis built one way could not line up with a
 * window built the other.
 *
 * The vitest runner itself executes in UTC, where the two bases coincide and a
 * regression is therefore INVISIBLE. These tests deliberately evaluate the
 * date logic under non-UTC offsets so the mismatch cannot come back unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { periodBoundaries, addDays } from '../core/calendar/periods.js';

/** Run `fn` with process.env.TZ temporarily set, restoring it afterwards. */
function withTZ<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/**
 * The two competing ways to turn a Date into a day key. `local` is the
 * project convention (`utils/ids.ts today()`); `utc` is the one that caused
 * D-4. A correct implementation must never mix them.
 */
const localKey = (d: Date) => d.toLocaleDateString('en-CA');
const utcKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The finance 14-day trend axis, built the way the route builds it: with
 * `addDays`, pure calendar arithmetic on the date string.
 */
function trendAxis(todayStr: string): string[] {
  const start = addDays(todayStr, -13);
  return Array.from({ length: 14 }, (_, i) => addDays(start, i));
}

/**
 * The BROKEN pattern the route used to use: build a Date, shift it, then
 * reformat with a local formatter. Kept here so the tests can demonstrate
 * that it really is zone-dependent, which is why the route no longer uses it.
 */
function trendAxisViaDate(todayStr: string, keyFn: (d: Date) => string): string[] {
  const from = new Date(todayStr);
  from.setDate(from.getDate() - 13);
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    return keyFn(d);
  });
}

const ZONES = ['UTC', 'Asia/Kabul', 'America/New_York', 'Asia/Tokyo', 'Pacific/Apia'];

describe('D-4 — a UTC axis and a local window are not interchangeable', () => {
  it('demonstrates the Date round trip really is zone-dependent', () => {
    // This is the property that makes the defect possible, and the reason the
    // route no longer formats Dates. `new Date('YYYY-MM-DD')` is UTC midnight,
    // so a LOCAL formatter reports the previous day in any zone behind UTC.
    const shifted = withTZ('America/New_York', () =>
      trendAxisViaDate('2026-08-17', localKey).at(-1)
    );
    expect(shifted).toBe('2026-08-16'); // wrong day — off by one
    const utcBased = withTZ('America/New_York', () =>
      trendAxisViaDate('2026-08-17', utcKey).at(-1)
    );
    expect(utcBased).toBe('2026-08-17');
    // Two plausible-looking implementations, two different answers: exactly the
    // ambiguity `addDays` removes.
    expect(shifted).not.toBe(utcBased);
  });

  it('the real axis always ends on today, in every zone', () => {
    for (const tz of ZONES) {
      withTZ(tz, () => {
        const axis = trendAxis('2026-08-17');
        expect(axis).toHaveLength(14);
        expect(axis[axis.length - 1]).toBe('2026-08-17');
      });
    }
  });

  it('the real axis is 14 contiguous days with no gap or repeat, in every zone', () => {
    for (const tz of ZONES) {
      withTZ(tz, () => {
        const axis = trendAxis('2026-08-17');
        expect(new Set(axis).size).toBe(14);
        for (let i = 1; i < axis.length; i += 1) {
          expect(axis[i]).toBe(addDays(axis[i - 1], 1));
        }
      });
    }
  });

  it('produces byte-identical axes across all zones', () => {
    const reference = withTZ('UTC', () => trendAxis('2026-08-17'));
    for (const tz of ZONES) {
      expect(withTZ(tz, () => trendAxis('2026-08-17'))).toEqual(reference);
    }
  });

  it('produces the ABSOLUTE expected axis, not merely a self-consistent one', () => {
    // Comparing zones against each other only proves consistency: an
    // implementation that is uniformly wrong would pass. Pin the literal days.
    const expected = [
      '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08',
      '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17',
    ];
    for (const tz of ZONES) {
      withTZ(tz, () => {
        expect(trendAxis('2026-08-17')).toEqual(expected);
      });
    }
  });

  it('addDays(iso, 0) is the identity in every zone', () => {
    // The single sharpest check: a Date round trip through a local formatter
    // returns the PREVIOUS day west of UTC even for a zero-day shift.
    for (const tz of ZONES) {
      withTZ(tz, () => {
        for (const iso of ['2026-08-17', '2026-01-01', '2026-12-31', '2024-02-29']) {
          expect(addDays(iso, 0)).toBe(iso);
        }
      });
    }
  });

  it('addDays is zone-stable across month, year and leap boundaries', () => {
    const cases: Array<[string, number, string]> = [
      ['2026-08-17', -13, '2026-08-04'],
      ['2026-03-01', -1, '2026-02-28'],
      ['2024-03-01', -1, '2024-02-29'], // leap day
      ['2026-01-01', -1, '2025-12-31'],
      ['2026-12-31', 1, '2027-01-01'],
    ];
    for (const tz of ZONES) {
      withTZ(tz, () => {
        for (const [from, delta, expected] of cases) {
          expect(addDays(from, delta)).toBe(expected);
        }
      });
    }
  });
});

describe('Period boundaries are timezone-stable', () => {
  it('returns identical Shamsi boundaries for the same date in every zone', () => {
    const reference = periodBoundaries('month', '2026-08-17');
    for (const tz of ZONES) {
      withTZ(tz, () => {
        expect(periodBoundaries('month', '2026-08-17')).toEqual(reference);
        expect(periodBoundaries('year', '2026-08-17')).toEqual(periodBoundaries('year', '2026-08-17'));
      });
    }
  });

  it('does not shift a month boundary across zones', () => {
    // 2026-07-23 is the first day of Asad 1405 — the most sensitive date.
    for (const tz of ZONES) {
      withTZ(tz, () => {
        const b = periodBoundaries('month', '2026-07-23');
        expect(b.from).toBe('2026-07-23');
        expect(b.periodKey).toBe('1405-05');
      });
    }
  });

  it('does not shift a year boundary (Nawruz) across zones', () => {
    for (const tz of ZONES) {
      withTZ(tz, () => {
        const b = periodBoundaries('year', '2026-03-21');
        expect(b.from).toBe('2026-03-21');
        expect(b.periodKey).toBe('1405');
      });
    }
  });
});
