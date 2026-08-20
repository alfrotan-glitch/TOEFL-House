/**
 * Placement Domain Policy — the single authoritative source for placement
 * eligibility, outcome and billing decisions.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The forensic audit found the same rule expressed in several places with
 * different logic, and the most important rule (did the candidate pass?)
 * expressed nowhere at all. Routes computed a verdict and threw it away.
 *
 * Every placement business rule that more than one caller needs lives here, so
 * the completion boundary, the conversion boundary and the retake guard cannot
 * drift apart. Routes stay thin: they load state, ask this module, enforce the
 * answer inside a transaction.
 *
 * AUTHORITY MODEL
 * ---------------
 * Every function takes server-loaded persisted state and the attempt's own
 * immutable policy snapshot. Nothing here reads the HTTP request, and no
 * client-supplied score, flag, level or billing hint participates in any
 * decision.
 */
import type { DecisionEvaluation, PlacementOutcome } from './decision-engine.js';
import { evaluateOutcome } from './decision-engine.js';

/**
 * Retake + billing policy as captured in an attempt's immutable snapshot.
 * Defaults reproduce the historical behaviour exactly (unlimited attempts,
 * first sitting billed, retakes free) so existing installs are unaffected.
 */
export interface RetakePolicy {
  allowRetake: boolean;
  /** NULL/undefined = unlimited. */
  maxAttempts: number | null;
  firstAttemptBillable: boolean;
  retakeBillable: boolean;
  /** NULL/undefined = fall back to the branch-configured placement fee. */
  retakeFeeAmount: number | null;
}

/** Read the retake policy out of a profile row or a snapshot profile object. */
export function readRetakePolicy(source: Record<string, unknown> | null | undefined): RetakePolicy {
  const src = (source ?? {}) as Record<string, unknown>;
  // Accept both DB column names (profile row) and camelCase (snapshot profile).
  const pick = (snake: string, camel: string): unknown => (src[snake] !== undefined ? src[snake] : src[camel]);
  const num = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const bool = (value: unknown, fallback: boolean): boolean => (value === undefined || value === null ? fallback : Boolean(Number(value)));

  return {
    allowRetake: bool(pick('allow_retake', 'allowRetake'), true),
    maxAttempts: num(pick('max_attempts', 'maxAttempts')),
    firstAttemptBillable: bool(pick('first_attempt_billable', 'firstAttemptBillable'), true),
    retakeBillable: bool(pick('retake_billable', 'retakeBillable'), false),
    retakeFeeAmount: num(pick('retake_fee_amount', 'retakeFeeAmount')),
  };
}

export interface StartEligibility {
  allowed: boolean;
  /** Reason for refusal, suitable for an HTTP 409 message. */
  reason: string;
}

/**
 * May this visitor START a new placement attempt?
 *
 * Evaluated against COMPLETED sittings (a finished exam consumes an attempt).
 * The "at most one OPEN attempt" rule is deliberately NOT enforced here: it is
 * a concurrency invariant that only the database can guarantee, and it is
 * carried by the partial unique index `uq_placement_open_attempt` (migration
 * 070). Checking it in application code as well would be a race, not a guard.
 */
export function evaluateStartEligibility(policy: RetakePolicy, completedAttempts: number): StartEligibility {
  if (completedAttempts > 0 && !policy.allowRetake) {
    return { allowed: false, reason: 'Retakes are not allowed for this placement policy.' };
  }
  if (policy.maxAttempts != null && completedAttempts >= policy.maxAttempts) {
    return {
      allowed: false,
      reason: `This placement policy allows at most ${policy.maxAttempts} attempt${policy.maxAttempts === 1 ? '' : 's'}.`,
    };
  }
  return { allowed: true, reason: '' };
}

export interface BillingDecision {
  billable: boolean;
  /** Resolved fee amount; 0 when not billable. */
  amount: number;
  reason: string;
}

/**
 * Is THIS completion billable, and for how much?
 *
 * `priorCompletedAttempts` is the number of sittings already completed by this
 * visitor, so attempt #1 is billed under `firstAttemptBillable` and every later
 * sitting under `retakeBillable`. Callers pass the branch-configured placement
 * fee; a policy may override the retake price via `retakeFeeAmount`.
 *
 * Kept separate from eligibility so that "may they sit again?" and "does this
 * sitting cost money?" can be configured independently, as requested.
 */
export function evaluateBilling(
  policy: RetakePolicy,
  priorCompletedAttempts: number,
  branchPlacementFee: number
): BillingDecision {
  const baseFee = Number.isFinite(branchPlacementFee) && branchPlacementFee > 0 ? branchPlacementFee : 0;
  const isFirst = priorCompletedAttempts === 0;

  if (isFirst) {
    if (!policy.firstAttemptBillable) return { billable: false, amount: 0, reason: 'policy_first_attempt_not_billable' };
    return baseFee > 0
      ? { billable: true, amount: baseFee, reason: 'first_attempt' }
      : { billable: false, amount: 0, reason: 'no_fee_configured' };
  }

  if (!policy.retakeBillable) return { billable: false, amount: 0, reason: 'policy_retakes_free' };
  const retakeFee = policy.retakeFeeAmount != null && policy.retakeFeeAmount >= 0 ? policy.retakeFeeAmount : baseFee;
  return retakeFee > 0
    ? { billable: true, amount: retakeFee, reason: 'retake' }
    : { billable: false, amount: 0, reason: 'no_fee_configured' };
}

export interface ConversionEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * May this placement result be converted into an enrolled student?
 *
 * This is the independent second gate demanded by the audit: even if an invalid
 * state were somehow persisted (a bug, a manual DB edit, an older row written
 * before this hardening), conversion re-checks the authoritative outcome and
 * refuses. It intentionally trusts the `outcome` column on the attempt row
 * rather than the denormalised `visitors.placement_score` JSON blob.
 *
 * `attempt` is the visitor's latest completed attempt, or null when none
 * exists. A NULL outcome means the sitting predates the outcome column and was
 * never judged; migration 070 backfills those, so a NULL here after migration
 * indicates an attempt that never completed.
 */
export function evaluateConversionEligibility(
  requirementMode: string,
  placementStatus: string,
  attempt: { status?: string | null; outcome?: string | null } | null
): ConversionEligibility {
  if (requirementMode === 'not_required') return { eligible: true, reason: 'not_required' };

  const waived = isWaivedStatus(placementStatus);
  if (requirementMode === 'optional') {
    if (waived) return { eligible: true, reason: 'waived' };
    if (placementStatus !== 'completed') {
      return {
        eligible: false,
        reason: 'Placement is optional for this program: complete it or record a waiver before enrollment.',
      };
    }
  } else if (requirementMode === 'required') {
    // A waiver is an authorised management exemption and is honoured even when
    // the policy marks placement required; it is audited at the point it is
    // granted and restricted to authorised roles there.
    if (waived) return { eligible: true, reason: 'waived' };
    if (placementStatus !== 'completed') {
      return { eligible: false, reason: 'Placement assessment is required for the selected program before enrollment.' };
    }
  }

  // Status says completed — now verify the ACTUAL result, not just the status.
  if (!attempt || attempt.status !== 'completed') {
    return { eligible: false, reason: 'No completed placement attempt was found for this candidate.' };
  }
  if (attempt.outcome === 'failed') {
    return {
      eligible: false,
      reason: 'The candidate did not meet the placement policy requirements and cannot be enrolled from this result.',
    };
  }
  if (attempt.outcome !== 'passed') {
    return { eligible: false, reason: 'The placement result has no authoritative outcome and cannot be used for enrollment.' };
  }
  return { eligible: true, reason: 'passed' };
}

/**
 * THE placement gate for enrolling a student into a class.
 *
 * `evaluateConversionEligibility` guards the visitor→student conversion route.
 * This function guards the *other* direction: an already-existing student row
 * being enrolled into a class. The certification audit found that placement was
 * enforced only on the conversion route, while five other code paths reached
 * `EnrollmentService.enroll()` (and one raw INSERT) with no placement check —
 * so `POST /api/students/manual` enrolled a candidate into a placement-required
 * class with no assessment at all (finding C-1).
 *
 * Both functions delegate the actual verdict to the same predicate below, so
 * the two boundaries can never disagree about what "eligible" means.
 *
 * A student with no `lead_id` has no visitor record and therefore no placement
 * history. That is NOT treated as an exemption: when the target program
 * requires placement, an unlinked student is refused, because otherwise
 * creating a student directly would remain a bypass.
 */
export interface EnrollmentPlacementState {
  /** visitors.placement_status for the student's originating lead, if any. */
  placementStatus: string | null;
  /** The student's latest completed placement attempt, if any. */
  attempt: { status?: string | null; outcome?: string | null } | null;
  /** True when the student row has no originating visitor (lead_id IS NULL). */
  hasVisitorRecord: boolean;
}

export function evaluateEnrollmentEligibility(
  requirementMode: string,
  state: EnrollmentPlacementState
): ConversionEligibility {
  if (requirementMode === 'not_required') return { eligible: true, reason: 'not_required' };

  if (!state.hasVisitorRecord) {
    return {
      eligible: false,
      reason:
        'This program requires a placement assessment. The student has no placement record, so they must be registered through the visitor placement workflow before enrollment.',
    };
  }

  return evaluateConversionEligibility(requirementMode, String(state.placementStatus ?? ''), state.attempt);
}

/**
 * Canonical waiver status.
 *
 * The audit found two vocabularies for one concept: the skip handler wrote
 * `'waived'` (the only value the `visitors.placement_status` CHECK permits)
 * while the conversion gate tested for `'exempt'`, a value nothing ever wrote
 * and the CHECK would have rejected. `'waived'` is the canonical term because
 * it is the one the database schema actually allows; `'exempt'` is accepted
 * defensively on read so an external caller using that term still resolves.
 */
export const WAIVED_STATUS = 'waived' as const;

export function isWaivedStatus(status: string | null | undefined): boolean {
  return status === WAIVED_STATUS || status === 'exempt';
}

/** Re-exported so callers need only import this module. */
export { evaluateOutcome };
export type { PlacementOutcome, DecisionEvaluation };
