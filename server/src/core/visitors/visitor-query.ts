/**
 * Visitor list query + summary — the single authority for "which visitors" and
 * "how many visitors".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Without this module the frontend fetches a hard-coded 100-row page and then
 * computes every headline figure — total leads, conversion rate, pipeline,
 * overdue — from that array,
 * plus running search and filtering over it in JavaScript. With 250 leads the
 * manager's conversion tile read 27% against a true 11%, and a receptionist
 * searching for lead #101+ was told "No visitors match this search" for a
 * person who plainly exists, inviting a duplicate registration.
 *
 * This is the same defect class the Dashboard audit fixed (D-1/D-3), and it is
 * fixed the same way: populations are counted in SQL over the whole scoped
 * table, filtering happens in SQL so page N is a page of the FILTERED set, and
 * the client renders what the server computed. Raising the page limit is not a
 * fix — it only moves the ceiling.
 *
 * INVARIANTS PRESERVED
 * --------------------
 * Branch scope is applied by the caller through `resolveBranchScope` and passed
 * in as a resolved scope, exactly like `buildDashboardSummary`. This module
 * never reads the HTTP request, and every filter value is bound as a SQL
 * parameter — no user input is ever concatenated into SQL.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { LEAD_CLOSED_SQL, LEAD_CONVERTED_SQL, LEAD_OPEN_SQL } from './lead-lifecycle.js';

export interface VisitorScope {
  /** Null when the caller legitimately sees the whole organization. */
  branchId: string | null;
  isAll: boolean;
}

export interface VisitorFilters {
  /** Free text matched against name, phone and notes. */
  search?: string;
  /** Pipeline status bucket: 'all' | 'pending' | 'registered' | 'lost'. */
  status?: string;
  /** A `visitors.source` value, or 'all'. */
  source?: string;
  /** A `visitors.follow_up_status` value, or 'all'. */
  interest?: string;
  /** 'all' | 'not_started' | 'scheduled' | 'in_progress' | 'completed' | 'waived' | 'needs_assessment'. */
  placement?: string;
  /** When true, only leads whose next_contact_date is before `today`. */
  overdueOnly?: boolean;
}

export interface VisitorSummary {
  scope: 'branch' | 'organization';
  branchId: string | null;
  /** The server's local "today", so the client never computes its own (D-4). */
  today: string;
  /** Whole scoped population, ignoring filters — the honest denominator. */
  total: number;
  /** Open leads: neither converted nor closed-lost. */
  pipeline: number;
  /** Converted leads. */
  registered: number;
  /** Closed-lost leads. Counted separately so they inflate nothing. */
  lost: number;
  /** Open leads whose next contact date has passed. */
  overdue: number;
  /** registered / total, rounded — computed over the FULL population. */
  conversionRate: number;
  /** Rows matching the caller's current filters (the paginator's denominator). */
  filtered: number;
  /**
   * Lead count per `source` over the whole scoped population.
   *
   * Counted over the whole population, not inside the loaded page. Counting the
   * page under-reports every channel, and because the UI knows only four source
   * keys it then displays walk_in/referral/event/organic/facebook leads as
   * "Other". Returning the real distribution lets the UI render every channel
   * the server actually stores.
   */
  bySource: Array<{ source: string; count: number }>;
  /**
   * Lead count per workflow `stage` over the whole scoped population.
   *
   * The kanban board — the DEFAULT view — bucketed the loaded PAGE into its
   * five columns and printed those lengths as column badges. With 250 leads it
   * showed "New: 21" against a true 223, directly beneath a KPI strip that
   * correctly said 250: two contradictory numbers on one screen. This is the
   * same defect class as UX-1, and it is fixed the same way — counted in SQL,
   * rendered by the client.
   *
   * Keyed by the raw stage value so the client owns the column grouping;
   * NULL stage is normalised to 'lead', matching the lifecycle predicates.
   */
  byStage: Array<{ stage: string; count: number }>;
}

/**
 * Lifecycle predicates come from the shared authority (core/visitors/lead-lifecycle.ts).
 *
 * Declaring them privately here would be correct for this module but would
 * leave the Dashboard, BOS and reports each carrying their own copy, and copies
 * disagree: on identical data one such copy reported 225 open leads while the
 * Dashboard reported 226, because only one treated closed-lost as
 * terminal. One question must have one implementation.
 */
const LOST_SQL = LEAD_CLOSED_SQL;
const REGISTERED_SQL = LEAD_CONVERTED_SQL;
const PIPELINE_SQL = LEAD_OPEN_SQL;

function scopeClause(scope: VisitorScope): { sql: string; params: unknown[] } {
  return scope.isAll ? { sql: '', params: [] } : { sql: ` AND branch_id = ?`, params: [scope.branchId] };
}

function countOf(db: BetterSqlite3.Database, sql: string, params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { c: number } | undefined)?.c ?? 0);
}

/**
 * Translate the caller's filters into bound SQL.
 *
 * Every value is a `?` parameter. `search` is wrapped with LIKE wildcards after
 * escaping the LIKE metacharacters, so a lead literally named "100%" is found
 * rather than matching everything.
 */
export function buildVisitorFilterClause(filters: VisitorFilters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  if (search) {
    // ESCAPE '\' so % and _ inside a user's search are literal, not wildcards.
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = `%${escaped}%`;
    parts.push(
      `(full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR COALESCE(notes,'') LIKE ? ESCAPE '\\'` +
        ` OR COALESCE(serial_no,'') LIKE ? ESCAPE '\\' OR COALESCE(tazkira_no,'') LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like, like, like);
  }

  switch (filters.status) {
    case 'pending':
      parts.push(`(${PIPELINE_SQL})`);
      break;
    case 'registered':
      parts.push(REGISTERED_SQL);
      break;
    case 'lost':
      parts.push(LOST_SQL);
      break;
    default:
      break; // 'all' or unset
  }

  if (filters.source && filters.source !== 'all') {
    parts.push('source = ?');
    params.push(filters.source);
  }

  if (filters.interest && filters.interest !== 'all') {
    parts.push('follow_up_status = ?');
    params.push(filters.interest);
  }

  if (filters.placement && filters.placement !== 'all') {
    if (filters.placement === 'needs_assessment') {
      // Schema CHECK allows: not_started | scheduled | in_progress | completed | waived.
      // "Needs assessment" is everything that is neither finished nor waived.
      parts.push(`COALESCE(placement_status,'not_started') IN ('not_started','scheduled','in_progress')`);
    } else {
      parts.push(`COALESCE(placement_status,'not_started') = ?`);
      params.push(filters.placement);
    }
  }

  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

/** Rows for one page of the FILTERED, scoped set. Ordering is stable. */
export function queryVisitorPage(
  db: BetterSqlite3.Database,
  scope: VisitorScope,
  filters: VisitorFilters,
  page: { limit: number; offset: number },
  todayStr: string
): { rows: unknown[]; filteredTotal: number } {
  const s = scopeClause(scope);
  const f = buildVisitorFilterClause(filters);
  const overdue = filters.overdueOnly
    ? { sql: ` AND next_contact_date IS NOT NULL AND next_contact_date < ? AND (${PIPELINE_SQL})`, params: [todayStr] }
    : { sql: '', params: [] as unknown[] };

  const where = `WHERE 1=1${s.sql}${f.sql}${overdue.sql}`;
  const params = [...s.params, ...f.params, ...overdue.params];

  const filteredTotal = countOf(db, `SELECT COUNT(*) AS c FROM visitors ${where}`, params);
  // `id` breaks ties so pagination is deterministic when many rows share a
  // visit_date — without it, page 2 can repeat or skip rows from page 1.
  const rows = db
    .prepare(`SELECT * FROM visitors ${where} ORDER BY visit_date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, page.limit, page.offset);

  return { rows: rows as unknown[], filteredTotal };
}

/**
 * Authoritative visitor KPIs. Aggregates over the whole scoped population;
 * `filtered` additionally reflects the caller's current filters so the UI can
 * say "showing 20 of 137 matching / 250 total" without counting anything
 * client-side.
 */
export function buildVisitorSummary(
  db: BetterSqlite3.Database,
  scope: VisitorScope,
  filters: VisitorFilters,
  todayStr: string
): VisitorSummary {
  const s = scopeClause(scope);
  const base = `FROM visitors WHERE 1=1${s.sql}`;

  const total = countOf(db, `SELECT COUNT(*) AS c ${base}`, s.params);
  const registered = countOf(db, `SELECT COUNT(*) AS c ${base} AND ${REGISTERED_SQL}`, s.params);
  const lost = countOf(db, `SELECT COUNT(*) AS c ${base} AND ${LOST_SQL} AND ${REGISTERED_SQL} = 0`, s.params);
  const pipeline = countOf(db, `SELECT COUNT(*) AS c ${base} AND ${PIPELINE_SQL}`, s.params);
  const overdue = countOf(
    db,
    `SELECT COUNT(*) AS c ${base} AND next_contact_date IS NOT NULL AND next_contact_date < ? AND (${PIPELINE_SQL})`,
    [...s.params, todayStr]
  );

  const f = buildVisitorFilterClause(filters);
  const overdueClause = filters.overdueOnly
    ? { sql: ` AND next_contact_date IS NOT NULL AND next_contact_date < ? AND (${PIPELINE_SQL})`, params: [todayStr] }
    : { sql: '', params: [] as unknown[] };
  const filtered = countOf(
    db,
    `SELECT COUNT(*) AS c ${base}${f.sql}${overdueClause.sql}`,
    [...s.params, ...f.params, ...overdueClause.params]
  );

  const byStage = (
    db
      .prepare(
        `SELECT COALESCE(stage,'lead') AS stage, COUNT(*) AS c ${base} GROUP BY COALESCE(stage,'lead') ORDER BY c DESC`
      )
      .all(...s.params) as Array<{ stage: string; c: number }>
  ).map((r) => ({ stage: r.stage, count: Number(r.c) }));

  const bySource = (
    db
      .prepare(
        `SELECT COALESCE(source,'other') AS source, COUNT(*) AS c ${base} GROUP BY COALESCE(source,'other') ORDER BY c DESC`
      )
      .all(...s.params) as Array<{ source: string; c: number }>
  ).map((r) => ({ source: r.source, count: Number(r.c) }));

  return {
    scope: scope.isAll ? 'organization' : 'branch',
    branchId: scope.isAll ? null : scope.branchId,
    today: todayStr,
    bySource,
    byStage,
    total,
    pipeline,
    registered,
    lost,
    overdue,
    // Denominator is the full population minus nothing — every lead ever taken
    // is part of the conversion story. Lost leads stay in the denominator
    // (they were real opportunities) but are excluded from `pipeline`.
    conversionRate: total > 0 ? Math.round((registered / total) * 100) : 0,
    filtered,
  };
}
