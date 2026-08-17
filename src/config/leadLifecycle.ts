/**
 * Lead lifecycle — the frontend mirror of the server's authority.
 *
 * The server owns this rule in `server/src/core/visitors/lead-lifecycle.ts`;
 * every population COUNT comes from the server and is never recomputed here
 * (that is the UX-1 rule and it still holds). What this module exists for is
 * the per-ROW question the UI must answer while rendering a list it already
 * has: "what do I label this one, and which action do I offer?"
 *
 * WHY IT IS NEEDED
 * ----------------
 * `VisitorsView` carried its own inline rule:
 *
 *   status || (stage === 'registration' || stage === 'enrollment'
 *                ? 'registered' : 'visited')
 *
 * Two things were wrong with it:
 *
 *  1. `status` is NOT NULL in the schema and always populated, so `status || …`
 *     short-circuits every time and the entire stage branch was dead code. It
 *     looked like it handled stage, and never ran.
 *  2. It had no concept of closed-lost. A lead at stage='lost' rendered the
 *     badge "In follow-up" and an "Enroll now" button — inviting the operator
 *     to enrol a lead the server will refuse (verified live: the convert route
 *     answers "This lead is closed (lost). Reopen it before converting.").
 *
 * Keeping the vocabulary in one module is what stops the client and server
 * drifting again. The three buckets and their precedence are identical to the
 * server's: converted wins over closed, closed wins over open.
 */

/** Mirrors the server's `LeadLifecycleBucket`. */
export type LeadLifecycleBucket = 'converted' | 'closed' | 'open';

/**
 * Classify a lead row.
 *
 * Precedence matters: a converted lead whose stage was later annotated 'lost'
 * is still converted, because conversion is backed by a student record and a
 * payment while the stage is only a workflow marker.
 */
export function leadLifecycleBucket(v: {
  status?: string | null;
  stage?: string | null;
}): LeadLifecycleBucket {
  if (v.status === 'registered') return 'converted';
  if ((v.stage ?? 'lead') === 'lost') return 'closed';
  return 'open';
}

/** The lead converted into a student. */
export const isLeadConverted = (v: { status?: string | null; stage?: string | null }): boolean =>
  leadLifecycleBucket(v) === 'converted';

/** The lead is closed-lost and cannot be enrolled without reopening. */
export const isLeadClosed = (v: { status?: string | null; stage?: string | null }): boolean =>
  leadLifecycleBucket(v) === 'closed';

/** The lead is still winnable — the only bucket that should offer "Enroll". */
export const isLeadOpen = (v: { status?: string | null; stage?: string | null }): boolean =>
  leadLifecycleBucket(v) === 'open';

/** Operator-facing label for the status column. One word per bucket. */
export const LEAD_BUCKET_LABEL: Record<LeadLifecycleBucket, string> = {
  converted: 'Enrolled',
  closed: 'Lost',
  open: 'In follow-up',
};

/** Badge styling per bucket, so the three states are visually distinct. */
export const LEAD_BUCKET_BADGE: Record<LeadLifecycleBucket, string> = {
  converted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
  open: 'bg-amber-50 text-amber-700 border-amber-200',
};
