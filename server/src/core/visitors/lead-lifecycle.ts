/**
 * Lead lifecycle — THE authority for "what state is this lead in?".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The second UX audit found the same question answered five different ways:
 *
 *   visitor-query.ts    open = status<>'registered' AND stage<>'lost'
 *   dashboard-summary   pending = status IN ('visited','follow_up')   <- excludes lost? no: INCLUDES it
 *   bos.routes.ts       registrations = status='registered'
 *   reports.routes.ts   registrations = status='registered'
 *   visitors /pipeline  registrations = COUNT(stage='registration')   <- a DIFFERENT COLUMN
 *
 * Live, on identical data, the Visitors screen reported `pipeline=225` while the
 * Dashboard reported `pendingLeads=226` — the Dashboard counted a closed-lost
 * lead as still open. Two screens, one question, two answers. Adding a sixth
 * private predicate would have made it worse, so every consumer now imports
 * from here.
 *
 * THE DOMAIN RULE (established from the code, then verified against a live server)
 * -------------------------------------------------------------------------------
 * `visitors.stage` and `visitors.status` are NOT redundant. They are two
 * different axes, and collapsing one into the other would be wrong:
 *
 *   stage  = WORKFLOW POSITION. CHECK-constrained to 15 values. Moved by
 *            `POST /:id/advance-stage`, which never touches `status`.
 *   status = COMMERCIAL OUTCOME. Effectively a flag. The ONLY production writer
 *            of 'registered' is the conversion route, which in the same
 *            transaction also sets stage='enrollment' and INSERTs a students row.
 *
 * Proof that they cannot be merged: advancing a lead ten times walks it to
 * stage='enrollment' while status stays 'visited' and NO student exists. So
 * `stage='enrollment'` does not mean converted, and deriving `status` from
 * `stage` would invent 27 fictional enrolments. Conversely `status='registered'`
 * always implies a real student record.
 *
 * Hence exactly three mutually exclusive, collectively exhaustive buckets:
 *
 *   CONVERTED := status = 'registered'          (a student record exists)
 *   CLOSED    := NOT converted AND stage = 'lost'
 *   OPEN      := everything else                (still winnable)
 *
 * `pending`/`open` is defined as the COMPLEMENT of converted+closed rather than
 * as an allow-list of status values. The Dashboard's old allow-list
 * (`status IN ('visited','follow_up')`) silently dropped any row whose status
 * was neither — a latent undercount the moment a new status value appears.
 *
 * NULL-SAFETY
 * -----------
 * `stage` is NULLable, so every predicate wraps it in COALESCE. Writing
 * `stage <> 'lost'` instead silently drops NULL-stage rows in SQLite (NULL
 * comparisons yield NULL, not true) — verified during the UX-1 work, and the
 * exact mistake that would reintroduce the undercount this exists to prevent.
 */

/** SQL fragment: the lead converted into a student. */
export const LEAD_CONVERTED_SQL = `status = 'registered'`;

/**
 * SQL fragment: the lead is closed-lost.
 *
 * Deliberately excludes converted rows. A lead cannot be both won and lost, and
 * conversion is the stronger statement — it is backed by money and a student
 * record, whereas `stage='lost'` is a workflow annotation. Without the
 * `status <> 'registered'` guard a converted lead whose stage was later moved
 * to 'lost' would be counted in two buckets at once and break the
 * converted + closed + open = total invariant.
 */
export const LEAD_CLOSED_SQL = `status <> 'registered' AND COALESCE(stage,'lead') = 'lost'`;

/** SQL fragment: the lead is still open — neither converted nor closed. */
export const LEAD_OPEN_SQL = `status <> 'registered' AND COALESCE(stage,'lead') <> 'lost'`;

/** The three buckets, for callers that want to iterate them. */
export type LeadLifecycleBucket = 'converted' | 'closed' | 'open';

/**
 * In-memory counterpart of the SQL predicates above, for the few callers that
 * already hold a row (the conversion-eligibility preview) and for tests that
 * want to assert the JS and SQL agree.
 *
 * Accepts the snake_case DB shape and the camelCase API shape, because both are
 * in circulation and a helper that only understands one of them invites a
 * caller to hand-roll the other.
 */
export function leadLifecycleBucket(row: {
  status?: string | null;
  stage?: string | null;
}): LeadLifecycleBucket {
  if (row.status === 'registered') return 'converted';
  if ((row.stage ?? 'lead') === 'lost') return 'closed';
  return 'open';
}

/** True when the lead can still be worked (appears in follow-up queues). */
export function isLeadOpen(row: { status?: string | null; stage?: string | null }): boolean {
  return leadLifecycleBucket(row) === 'open';
}

/** True when the lead has been converted into a student. */
export function isLeadConverted(row: { status?: string | null; stage?: string | null }): boolean {
  return leadLifecycleBucket(row) === 'converted';
}

/** True when the lead is closed-lost. */
export function isLeadClosed(row: { status?: string | null; stage?: string | null }): boolean {
  return leadLifecycleBucket(row) === 'closed';
}
