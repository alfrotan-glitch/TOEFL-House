/**
 * Conversion eligibility preview — "may this lead be enrolled into this class?"
 * answered BEFORE the user fills in a fee and takes a payment.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * UX-3: with placement set to `required`, the receptionist opened Convert, saw
 * the full form (class, fee, discount, amount received, payment method), filled
 * it, clicked Confirm — and only then was refused. In a walk-in office the cash
 * is often already on the counter by that point.
 *
 * The backend refusal is correct and stays exactly where it is. What was
 * missing is a way to ASK the same question without attempting the write.
 *
 * ONE RULE, ONE IMPLEMENTATION
 * ----------------------------
 * This module deliberately owns no policy. It resolves the governing program
 * exactly as the enrollment path does (`resolveGoverningProgramVersionId`),
 * reads the requirement through `resolvePlacementRequirement`, and reaches a
 * verdict through `evaluateEnrollmentEligibility` — the same three functions
 * `EnrollmentService.enroll()` relies on. A preview that computed its own
 * answer would be a second implementation of an invariant, which is precisely
 * the defect class (V-1) the placement work already had to remove once.
 *
 * Consequence: this endpoint can never authorize something the write path would
 * refuse, because it is not a copy of the rule — it is a read-only call INTO
 * the rule.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { resolveGoverningProgramVersionId } from '../placement/enrollment-gate.js';
import { resolvePlacementRequirement, isAuthoritativeDecision } from '../placement/policy-engine.js';
import { evaluateEnrollmentEligibility } from '../placement/placement-policy.js';

export interface ConversionEligibilityResult {
  /** False when a conversion attempt would be refused right now. */
  eligible: boolean;
  /** Machine-readable cause, for the UI to branch on. */
  code:
    | 'ok'
    | 'placement_required'
    | 'already_converted'
    | 'lead_lost'
    | 'student_exists'
    | 'class_not_found'
    | 'class_wrong_branch'
    | 'class_inactive'
    | 'placement_policy_unconfigured';
  /** Operator-facing explanation. Safe to display verbatim. */
  reason: string;
  /** Resolved placement requirement mode for the governing program. */
  requirementMode: string;
  /** The visitor's current placement status, for display. */
  placementStatus: string;
  /** True when the blocker is cleared by running a placement assessment. */
  placementActionable: boolean;
}

/**
 * Evaluate, read-only, whether `visitorId` could convert into `classId`.
 *
 * `classId` is optional: with no class chosen the caller still learns whether
 * the lead itself is convertible (not already converted, not closed-lost), so
 * the modal can refuse to open at all rather than presenting a dead form.
 */
export function evaluateConversionEligibilityForVisitor(
  db: BetterSqlite3.Database,
  visitor: {
    id: string;
    status?: string | null;
    stage?: string | null;
    program_version_id?: string | null;
    placement_status?: string | null;
    branch_id?: string | null;
  },
  classId: string | null,
  branchId: string | null,
  studentAlreadyExists?: boolean
): ConversionEligibilityResult {
  const placementStatus = visitor.placement_status ?? 'not_started';

  // Lifecycle blockers first — these mirror the guards at the top of the
  // convert route, in the same order, so the preview and the write agree.
  if (visitor.status === 'registered') {
    return {
      eligible: false,
      code: 'already_converted',
      reason: 'This visitor has already been converted.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }
  if (visitor.stage === 'lost') {
    return {
      eligible: false,
      code: 'lead_lost',
      reason: 'This lead is closed (lost). Reopen it before converting.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }
  const existingStudent =
    studentAlreadyExists === undefined
      ? db.prepare('SELECT id FROM students WHERE lead_id = ?').get(visitor.id)
      : studentAlreadyExists;
  if (existingStudent) {
    return {
      eligible: false,
      code: 'student_exists',
      reason: 'A student record already exists for this visitor.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }

  if (!classId) {
    return {
      eligible: true,
      code: 'ok',
      reason: 'Select a class to check placement eligibility.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }

  const cls = db
    .prepare('SELECT id, level_id, status, branch_id FROM classes WHERE id = ?')
    .get(classId) as { id: string; level_id: string | null; status: string | null; branch_id: string } | undefined;
  if (!cls) {
    return {
      eligible: false,
      code: 'class_not_found',
      reason: 'Class not found.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }
  const expectedBranchId = visitor.branch_id ?? branchId ?? null;
  if (expectedBranchId && cls.branch_id !== expectedBranchId) {
    return {
      eligible: false,
      code: 'class_wrong_branch',
      reason: 'Selected class belongs to another branch.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }
  if (cls.status && cls.status !== 'active') {
    return {
      eligible: false,
      code: 'class_inactive',
      reason: 'Cannot enroll into an inactive class.',
      requirementMode: 'not_required',
      placementStatus,
      placementActionable: false,
    };
  }

  // Governing program: the class's level wins over the visitor's own program,
  // resolved by the shared helper rather than re-derived here (audit V-1).
  const governingProgramVersionId = resolveGoverningProgramVersionId(
    cls,
    visitor.program_version_id ?? null,
    (levelId) =>
      (db.prepare('SELECT program_version_id FROM levels WHERE id = ?').get(levelId) as
        | { program_version_id: string | null }
        | undefined)?.program_version_id ?? null
  );

  const requirement = resolvePlacementRequirement(
    governingProgramVersionId,
    expectedBranchId,
    cls.level_id ?? null
  );

  // Mirror the authoritative enrollment gate: a configuration fault is not a
  // waiver, so this pre-flight check must report it instead of green-lighting
  // a conversion the write path will (correctly) reject.
  if (!isAuthoritativeDecision(requirement)) {
    return {
      eligible: false,
      code: 'placement_policy_unconfigured',
      reason:
        'Placement policy is not configured for this program version. An administrator must configure it in Academic Setup before this candidate can be enrolled.',
      requirementMode: requirement.mode,
      placementStatus,
      placementActionable: false,
    };
  }

  if (requirement.mode === 'not_required') {
    return {
      eligible: true,
      code: 'ok',
      reason:
        requirement.decision === 'EXEMPT'
          ? 'This candidate is exempt from the required placement assessment.'
          : 'No placement assessment is required for this program.',
      requirementMode: requirement.mode,
      placementStatus,
      placementActionable: false,
    };
  }

  const attempt = db
    .prepare(
      `SELECT status, outcome FROM placement_assessment_attempts
       WHERE visitor_id = ? AND status = 'completed'
       ORDER BY completed_at DESC, attempt_number DESC LIMIT 1`
    )
    .get(visitor.id) as { status: string; outcome: string | null } | undefined;

  const verdict = evaluateEnrollmentEligibility(requirement.mode, {
    placementStatus,
    attempt: attempt ?? null,
    hasVisitorRecord: true,
  });

  return {
    eligible: verdict.eligible,
    code: verdict.eligible ? 'ok' : 'placement_required',
    reason: verdict.reason,
    requirementMode: requirement.mode,
    placementStatus,
    // A failed/blocked attempt is still "placement" territory: the operator's
    // next step is the assessment workspace either way.
    placementActionable: !verdict.eligible,
  };
}
