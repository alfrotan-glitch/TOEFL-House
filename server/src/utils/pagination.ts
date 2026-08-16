/**
 * Pagination parsing — one hardened implementation.
 * ============================================================================
 * Three routers each had their own `parsePagination`, and two of them shared a
 * bug:
 *
 *     let limit = parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE;
 *     if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;
 *
 * A NEGATIVE limit is truthy, is not greater than MAX_PAGE_SIZE, and so passes
 * straight through into `LIMIT -1` — which SQLite reads as "no limit at all".
 * `GET /students?limit=-1` therefore returned the entire table: 5,027 rows and
 * 3.4 MB against a 2,000-row / 1.3 MB cap. Any unauthenticated-adjacent client
 * with a valid token could pull the whole roster in one request, and the cost
 * grows without bound as the academy grows.
 *
 * A negative offset was equally accepted. `LIMIT ? OFFSET -1` is tolerated by
 * SQLite but is meaningless, and it silently shifts results.
 *
 * This version rejects anything that is not a finite positive integer and
 * falls back to the default, so the cap cannot be escaped by sign, by
 * overflow, by a float, or by a non-numeric string.
 */

export interface PaginationOptions {
  /** Rows returned when the caller does not ask for a specific page size. */
  defaultPageSize: number;
  /** Hard ceiling. A caller may never exceed this, whatever they send. */
  maxPageSize: number;
}

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

/** Parse a query value as a strictly positive integer, else undefined. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  // parseInt('1.5') is 1 — a fractional request would silently become a
  // one-row page. Require a pure integer literal.
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) return undefined;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  if (!Number.isInteger(n)) return undefined;
  if (n <= 0) return undefined;
  return n;
}

/** Parse a query value as a non-negative integer, else undefined. */
function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value.trim())) return undefined;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  if (!Number.isInteger(n)) return undefined;
  if (n < 0) return undefined;
  return n;
}

export function parsePaginationQuery(
  query: Record<string, unknown>,
  { defaultPageSize, maxPageSize }: PaginationOptions,
): Pagination {
  const page = positiveInt(query.page) ?? 1;

  // A negative, zero, fractional or non-numeric limit falls back to the
  // default — it must never reach SQLite, where LIMIT -1 means "unbounded".
  const requested = positiveInt(query.limit);
  const limit = Math.min(requested ?? defaultPageSize, maxPageSize);

  const explicitOffset = nonNegativeInt(query.offset);
  const offset = explicitOffset ?? (page - 1) * limit;

  return { page, limit, offset };
}

/** Express convenience wrapper. */
export function parsePagination(
  req: { query: Record<string, unknown> },
  options: PaginationOptions,
): Pagination {
  return parsePaginationQuery(req.query ?? {}, options);
}
