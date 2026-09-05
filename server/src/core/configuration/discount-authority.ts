import type BetterSqlite3 from 'better-sqlite3';
import { today as todayLocal } from '../../utils/ids.js';

/**
 * THE DISCOUNT AUTHORIZATION BOUNDARY
 * ============================================================================
 * `RULE != AUTHORIZATION`.
 *
 * The Rule Engine computes a *candidate* discount. It is not, and must never
 * be, the thing that authorizes one. CFG-1 proved why: a branch manager could
 * create a rule with `conditions: []` and `discountPercent: 95`, and the
 * candidate became the charge. Reproduced live on the unfixed engine, student
 * requesting 10%, institutional cap rule at priority 200:
 *
 *     exploit priority   1 ->  95      199 ->  95      999 -> 30
 *                       10 ->  95      201 ->  30    10000 -> 30
 *
 * Every one of those exceeds the 20% ordinary maximum. The reason the numbers
 * differ is itself the bug: the "cap" was an ordinary rule in a
 * `priority DESC` pass, so a rule ordered after it was never re-clamped, and a
 * rule ordered before it merely lost to the clamp. Ordering decided policy.
 *
 * This module removes ordering from the decision entirely. It runs AFTER the
 * rule pass and answers one question:
 *
 *     what is the maximum this student is actually authorized to receive?
 *
 * No valid authorization  => ordinary policy => <= ORDINARY_MAX.
 * A valid authorization   => that category's maximum, and no more.
 *
 * Because the ceiling is derived from authorization records rather than from
 * rules, no number of rules, no priority, and no rule source can raise it.
 */

/** Ordinary discount ceiling. Manager approval; no exception record needed. */
export const ORDINARY_MAX = 20;

export type DiscountCategory =
  | 'ORDINARY'
  | 'COURSE_AMBASSADOR'
  | 'FIRST_DEGREE_RELATIVE'
  | 'SECOND_DEGREE_RELATIVE'
  | 'FAMILY_OF_FOUR_PLUS'
  | 'SPONSORSHIP';

/** Per-category maximum. The resolver never returns more than this. */
export const CATEGORY_MAX: Record<DiscountCategory, number> = {
  ORDINARY: ORDINARY_MAX,
  COURSE_AMBASSADOR: 15,
  SECOND_DEGREE_RELATIVE: 50,
  FAMILY_OF_FOUR_PLUS: 50,
  FIRST_DEGREE_RELATIVE: 100,
  SPONSORSHIP: 100,
};

/**
 * Which role may approve each category. A 100% grant wipes tuition entirely,
 * so both 100% categories require the owner; the rest are manager-approvable.
 * Enforced at the route that creates an authorization.
 */
export const APPROVER_ROLE: Record<Exclude<DiscountCategory, 'ORDINARY'>, 'owner' | 'manager'> = {
  COURSE_AMBASSADOR: 'manager',
  SECOND_DEGREE_RELATIVE: 'manager',
  FAMILY_OF_FOUR_PLUS: 'manager',
  FIRST_DEGREE_RELATIVE: 'owner',
  SPONSORSHIP: 'owner',
};

/** Minimum household size that qualifies for the family category. */
export const FAMILY_MIN_MEMBERS = 4;

export interface AuthorizedDiscount {
  /** The final, authorized percentage. Safe to charge. */
  percent: number;
  /** Which policy produced it. Stored on the transaction for attribution. */
  category: DiscountCategory;
  /** The ceiling that applied. */
  maxAllowed: number;
  /** The authorization row id, when an exception was used. */
  authorizationId: string | null;
  /** Why the candidate was reduced, when it was. */
  clampedFrom: number | null;
}

interface AuthRow {
  id: string;
  category: Exclude<DiscountCategory, 'ORDINARY'>;
  approved_percent: number;
  status: string;
  effective_from: string | null;
  effective_to: string | null;
  branch_id: string;
}

/**
 * Eligibility is verified against authoritative data, never against a claim in
 * the request body. A category whose underlying facts do not hold is refused
 * even when an approver signed an authorization for it.
 */
function eligibilityHolds(db: BetterSqlite3.Database, studentId: string, row: AuthRow): boolean {
  switch (row.category) {
    case 'FIRST_DEGREE_RELATIVE':
    case 'SECOND_DEGREE_RELATIVE': {
      const degree = row.category === 'FIRST_DEGREE_RELATIVE' ? 1 : 2;
      const rel = db
        .prepare('SELECT 1 FROM student_staff_relations WHERE student_id = ? AND degree = ? LIMIT 1')
        .get(studentId, degree);
      return !!rel;
    }
    case 'FAMILY_OF_FOUR_PLUS': {
      // Counted from the authoritative household grouping, never from input.
      const row2 = db
        .prepare(
          `SELECT COUNT(*) AS n FROM students
            WHERE household_id IS NOT NULL
              AND household_id = (SELECT household_id FROM students WHERE id = ?)`,
        )
        .get(studentId) as { n: number } | undefined;
      return (row2?.n ?? 0) >= FAMILY_MIN_MEMBERS;
    }
    case 'COURSE_AMBASSADOR':
      // The authorization row IS the ambassador designation: it names an
      // approver and is revocable. A client boolean is never consulted.
      return true;
    case 'SPONSORSHIP':
      // Reuses the existing funding structures when a reference is supplied;
      // an unreferenced sponsorship still requires owner approval to exist.
      return true;
    default:
      return false;
  }
}

/** `active`, within its effective window, and scoped to the student's branch. */
function authorizationIsLive(row: AuthRow, studentBranchId: string | null, today: string): boolean {
  if (row.status !== 'active') return false;
  if (row.effective_from && row.effective_from > today) return false;
  if (row.effective_to && row.effective_to < today) return false;
  // Cross-branch authorization is impossible: the row must belong to the
  // student's own branch.
  if (studentBranchId && row.branch_id !== studentBranchId) return false;
  return true;
}

/**
 * Resolve the final authorized discount.
 *
 * @param candidate the Rule Engine's answer (already includes referral etc.)
 *
 * Categories do NOT stack. When several are valid the single highest
 * authorized benefit wins, so Ambassador 15 + Family 50 is 50, never 65.
 */
export function resolveAuthorizedDiscount(
  db: BetterSqlite3.Database,
  studentId: string | null,
  candidate: number,
  opts: { branchId?: string | null; today?: string } = {},
): AuthorizedDiscount {
  const requested = Number.isFinite(Number(candidate)) ? Math.max(0, Number(candidate)) : 0;
  // The business clock, not the UTC clock: authorization windows are read
  // against dates written by `today()` (local). Mixing clocks made a grant
  // flip active/expired at 19:30 Kabul time instead of midnight.
  const today = opts.today ?? todayLocal();

  let best: { row: AuthRow; max: number } | null = null;

  if (studentId) {
    const branchId =
      opts.branchId ??
      ((db.prepare('SELECT branch_id FROM students WHERE id = ?').get(studentId) as { branch_id?: string } | undefined)
        ?.branch_id ??
        null);

    // No fallback. A failure to read the authorization store is not evidence
    // that the student has no authorization, and answering with ordinary policy
    // would quietly charge a different figure than the approver granted. The
    // canonical schema always provides this table, so an error here is a real
    // fault and must surface (LAW 6).
    const rows = db
      .prepare(
        `SELECT id, category, approved_percent, status, effective_from, effective_to, branch_id
           FROM student_discount_authorizations WHERE student_id = ?`,
      )
      .all(studentId) as AuthRow[];

    for (const row of rows) {
      if (!authorizationIsLive(row, branchId, today)) continue;
      if (!eligibilityHolds(db, studentId, row)) continue;
      const categoryMax = CATEGORY_MAX[row.category] ?? ORDINARY_MAX;
      // The approver's grant, never above the category ceiling.
      const allowed = Math.min(Number(row.approved_percent) || 0, categoryMax);
      // No stacking: keep the single highest authorized benefit.
      if (!best || allowed > best.max) best = { row, max: allowed };
    }
  }

  if (!best) {
    // No valid authorization => ordinary policy. This is the branch that makes
    // rule priority irrelevant: whatever the engine produced, it is bounded
    // here.
    const percent = Math.min(requested, ORDINARY_MAX);
    return {
      percent,
      category: 'ORDINARY',
      maxAllowed: ORDINARY_MAX,
      authorizationId: null,
      clampedFrom: percent < requested ? requested : null,
    };
  }

  // An authorized exception governs the transaction.
  //
  // The candidate is deliberately NOT used as the upper bound here. The Rule
  // Engine's institutional cap rule clamps every candidate to its own value
  // (30 by default), so honouring the candidate would silently hold a 100%
  // sponsorship down to 30 — the authorization would exist on paper and be
  // unusable. Proven: with the cap rule seeded, an authorized first-degree
  // relative resolved to 30 instead of 100.
  //
  // The approver's grant, already clamped to the category maximum, IS the
  // authorized figure. Rules cannot raise it (it is bounded by `best.max`) and
  // rules must not lower it either, because a rule is not an authorization in
  // whichever direction it points.
  return {
    percent: best.max,
    category: best.row.category,
    maxAllowed: best.max,
    authorizationId: best.row.id,
    clampedFrom: requested > best.max ? requested : null,
  };
}
