/**
 * Pagination cap enforcement (group F10)
 * ============================================================================
 * S14 — the row cap could be escaped with a negative limit.
 *
 * Two routers shared this shape:
 *
 *     let limit = parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE;
 *     if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;
 *
 * `-1` is truthy, so the `||` default does not fire, and `-1 > 2000` is false,
 * so the ceiling does not fire either. The value reaches SQLite as `LIMIT -1`,
 * which SQLite defines as *no limit*.
 *
 * Proven live against a 5,000-student dataset:
 *     GET /students?limit=2000  ->  2,000 rows / 1,336,317 bytes  (the cap)
 *     GET /students?limit=-1    ->  5,027 rows / 3,362,514 bytes  (everything)
 *
 * Any token holder could dump the entire roster in one request, and the cost
 * grows without bound as the academy grows. `automations` had the same hole in
 * a different shape: `Math.min(Number(limit) || 50, 200)` returns -1 unchanged.
 *
 * Fixed by one shared parser (utils/pagination.ts) that accepts only a finite
 * positive integer and otherwise falls back to the default.
 */
import { describe, it, expect } from 'vitest';
import { parsePaginationQuery } from '../utils/pagination.js';

const OPTS = { defaultPageSize: 2000, maxPageSize: 2000 };
const SMALL = { defaultPageSize: 50, maxPageSize: 200 };

describe('S14: the row cap cannot be escaped', () => {
  it('a negative limit falls back to the default, never LIMIT -1', () => {
    expect(parsePaginationQuery({ limit: '-1' }, OPTS).limit).toBe(2000);
    expect(parsePaginationQuery({ limit: '-999999' }, OPTS).limit).toBe(2000);
    expect(parsePaginationQuery({ limit: -1 }, OPTS).limit).toBe(2000);
  });

  it('the limit is never negative or zero for any input', () => {
    const hostile = ['-1', '0', '-0', 'abc', '', '  ', '1e9', 'NaN', 'Infinity', '-Infinity', '1.5', '-2.7', '0x10', '2000000000000'];
    for (const limit of hostile) {
      const { limit: got } = parsePaginationQuery({ limit }, OPTS);
      expect(got, `limit=${JSON.stringify(limit)}`).toBeGreaterThan(0);
      expect(got, `limit=${JSON.stringify(limit)}`).toBeLessThanOrEqual(OPTS.maxPageSize);
    }
  });

  it('the ceiling still applies to large positive values', () => {
    expect(parsePaginationQuery({ limit: '999999' }, OPTS).limit).toBe(2000);
    expect(parsePaginationQuery({ limit: '201' }, SMALL).limit).toBe(200);
  });

  it('a fractional limit does not become a one-row page', () => {
    // parseInt('1.5') === 1 would have silently produced a single row.
    expect(parsePaginationQuery({ limit: '1.5' }, OPTS).limit).toBe(2000);
  });

  it('a legitimate limit is honoured exactly', () => {
    expect(parsePaginationQuery({ limit: '50' }, OPTS).limit).toBe(50);
    expect(parsePaginationQuery({ limit: '1' }, OPTS).limit).toBe(1);
    expect(parsePaginationQuery({ limit: '2000' }, OPTS).limit).toBe(2000);
  });
});

describe('S14: offset is equally hardened', () => {
  it('a negative offset is ignored rather than passed to SQL', () => {
    expect(parsePaginationQuery({ offset: '-1' }, OPTS).offset).toBe(0);
    expect(parsePaginationQuery({ offset: '-500' }, OPTS).offset).toBe(0);
  });

  it('offset zero is respected and does not fall through to page maths', () => {
    expect(parsePaginationQuery({ offset: '0', page: '5' }, OPTS).offset).toBe(0);
  });

  it('an explicit offset wins over page', () => {
    expect(parsePaginationQuery({ offset: '120', page: '9' }, OPTS).offset).toBe(120);
  });

  it('offset derives from page when absent', () => {
    expect(parsePaginationQuery({ page: '3', limit: '50' }, OPTS).offset).toBe(100);
  });

  it('a hostile page never yields a negative offset', () => {
    for (const page of ['-1', '0', 'abc', '-99999', '1.5']) {
      const { offset } = parsePaginationQuery({ page, limit: '50' }, OPTS);
      expect(offset, `page=${page}`).toBeGreaterThanOrEqual(0);
    }
  });
});
