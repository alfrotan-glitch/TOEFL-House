/**
 * core/academic/academic-policy-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 6: Academic Policy Engine (formalize).
 *
 * The blueprint calls this "Highest Priority": every academic rule should
 * be configurable, assignable by Course, Program, Department, or Student
 * category, with nothing hardcoded. By Phase 5 this had, in practice,
 * already been built — just scattered across three call sites with no
 * single name or reference point:
 *   - attendance-policy-service.ts (Phase 2): late threshold, half-absence
 *     rule, min attendance %, max consecutive absences.
 *   - gradebook-service.ts (Phase 4): letter grade bands.
 *   - promotion-engine.ts (Phase 5): score/attendance/subject thresholds,
 *     resolved across FOUR pre-existing, previously-disconnected layers
 *     (promotion_rules, levels.pass_mark, branch_academic_profiles, the
 *     generic rule engine).
 *
 * This module does not replace or re-implement any of that — doing so
 * would risk regressing three phases of tested behavior for a rename.
 * It does two genuinely new things:
 *
 * 1. Course/Program scoping, which the blueprint explicitly asks for and
 *    nothing had. The Rule Engine's `conditions` already support matching
 *    on arbitrary fields in the evaluation context — Course/Program/Level
 *    scoping needed no new schema, just callers passing that context in
 *    (see the additive `scope` parameters added to getAttendancePolicy()
 *    and getLetterGradeBands() this phase) and rule authors writing a
 *    condition like `{field:'levelId', operator:'equals', value:'...'}`
 *    on the rule they want scoped. "Department" and "Student category"
 *    work the same way once a caller starts passing those fields — no
 *    engine change needed when that day comes.
 *
 * 2. The six policy categories the blueprint names that genuinely had no
 *    home anywhere: Retake, Conditional Pass, Transfer, Freeze,
 *    Certificate, and Make-up Policy. All six are exposed as configurable
 *    getters here (rule-engine 'academic' category, same reuse pattern as
 *    letter grade bands). Two are wired into real enforcement this phase
 *    (Retake and Make-up — see the Phase 6 report for why those two and
 *    not the others). The rest are getters with sensible defaults, ready
 *    for the phases that will actually build their engines (Freeze/
 *    Transfer: Phase 9; Certificate: Phase 10) to consume rather than
 *    invent their own configuration mechanism when they arrive.
 * ============================================================================
 */
import type Database from 'better-sqlite3';
import { evaluateRules } from '../configuration/rule-engine.js';
import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';
import { getAttendancePolicy, type AttendancePolicy, type PolicyScope } from './attendance-policy-service.js';
import { getLetterGradeBands, type LetterGradeBand } from './gradebook-service.js';

// ============================================================================
// New policy categories (blueprint-named, previously nonexistent)
// ============================================================================

export interface RetakePolicy {
  /** Automated retake decisions stop after this many prior retakes of the
   *  SAME class — the next failure escalates to manual_review instead of
   *  looping the student through another automatic retake indefinitely. */
  maxAutomaticRetakes: number;
}

export interface ConditionalPassPolicy {
  /** How many consecutive classes a student may carry a conditional_pass
   *  before it escalates to manual_review — prevents "conditional" from
   *  silently becoming a permanent state. */
  maxConsecutiveConditionalPasses: number;
}

export interface TransferPolicy {
  /** Minimum days a student must have been enrolled before an inbound
   *  transfer is auto-approved rather than requiring sign-off. */
  minDaysBeforeAutoApprove: number;
}

export interface FreezePolicy {
  /** Longest a single freeze may last, in days. Enforcement of this
   *  requires the Freeze Engine's start/end-date fields, which don't
   *  exist yet (Phase 9) — this getter exists so Phase 9 has policy
   *  infrastructure to consume on day one instead of building its own. */
  maxFreezeDurationDays: number;
  maxFreezesPerEnrollment: number;
}

export interface CertificatePolicy {
  /** Minimum final percentage required before a certificate can be
   *  issued — separate from the promotion pass mark, since some programs
   *  certify at a higher bar than the bar for simply advancing. */
  minPercentageForCertificate: number;
}

export interface MakeupPolicy {
  /** How many days after the original assessment's due date a make-up
   *  attempt may still be created. Wired into enforcement this phase —
   *  see classes.routes.ts's POST /:id/assessments/:assessmentId/makeup. */
  windowDays: number;
}

const DEFAULTS = {
  retake: { maxAutomaticRetakes: ACADEMIC_DEFAULTS.maxAutomaticRetakes } satisfies RetakePolicy,
  conditionalPass: { maxConsecutiveConditionalPasses: ACADEMIC_DEFAULTS.maxConditionalPasses } satisfies ConditionalPassPolicy,
  transfer: { minDaysBeforeAutoApprove: ACADEMIC_DEFAULTS.transferMinDaysBeforeAutoApprove } satisfies TransferPolicy,
  freeze: { maxFreezeDurationDays: ACADEMIC_DEFAULTS.freezeMaxDurationDays, maxFreezesPerEnrollment: ACADEMIC_DEFAULTS.freezeMaxPerEnrollment } satisfies FreezePolicy,
  certificate: { minPercentageForCertificate: ACADEMIC_DEFAULTS.certificateMinPercentage } satisfies CertificatePolicy,
  makeup: { windowDays: ACADEMIC_DEFAULTS.makeupWindowDays } satisfies MakeupPolicy,
};

function readPolicy<T extends Record<string, unknown>>(branchId: string, keys: (keyof T)[], defaults: T, scope?: PolicyScope): T {
  const result = evaluateRules({ category: 'academic', branchId, data: { ...scope } });
  const out = { ...defaults };
  for (const key of keys) {
    const val = result.finalOutputs[key as string];
    if (val !== undefined) (out as Record<string, unknown>)[key as string] = val;
  }
  return out;
}

export function getRetakePolicy(branchId: string, scope?: PolicyScope): RetakePolicy {
  return readPolicy(branchId, ['maxAutomaticRetakes'], DEFAULTS.retake, scope);
}
export function getConditionalPassPolicy(branchId: string, scope?: PolicyScope): ConditionalPassPolicy {
  return readPolicy(branchId, ['maxConsecutiveConditionalPasses'], DEFAULTS.conditionalPass, scope);
}
export function getTransferPolicy(branchId: string, scope?: PolicyScope): TransferPolicy {
  return readPolicy(branchId, ['minDaysBeforeAutoApprove'], DEFAULTS.transfer, scope);
}
export function getFreezePolicy(branchId: string, scope?: PolicyScope): FreezePolicy {
  return readPolicy(branchId, ['maxFreezeDurationDays', 'maxFreezesPerEnrollment'], DEFAULTS.freeze, scope);
}
export function getCertificatePolicy(branchId: string, scope?: PolicyScope): CertificatePolicy {
  return readPolicy(branchId, ['minPercentageForCertificate'], DEFAULTS.certificate, scope);
}
export function getMakeupPolicy(branchId: string, scope?: PolicyScope): MakeupPolicy {
  return readPolicy(branchId, ['windowDays'], DEFAULTS.makeup, scope);
}

/**
 * Count of prior 'retake_marked' events for this student in this specific
 * class — the input getRetakePolicy's maxAutomaticRetakes is compared
 * against. Reuses Phase 1's enrollment_events audit trail rather than
 * adding a counter column anywhere.
 */
export function countPriorRetakes(db: Database.Database, studentId: string, classId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM enrollment_events ee
       JOIN enrollments e ON e.id = ee.enrollment_id
       WHERE ee.student_id = ? AND e.class_id = ? AND ee.event_type = 'retake_marked'`,
    )
    .get(studentId, classId) as { c: number };
  return row.c;
}

// ============================================================================
// Consolidated profile — everything in one call, for an admin settings /
// diagnostic view. Read-only aggregation; does not change how any
// individual engine resolves its own policy internally.
// ============================================================================

export interface AcademicPolicyProfile {
  attendance: AttendancePolicy;
  letterGradeBands: LetterGradeBand[];
  retake: RetakePolicy;
  conditionalPass: ConditionalPassPolicy;
  transfer: TransferPolicy;
  freeze: FreezePolicy;
  certificate: CertificatePolicy;
  makeup: MakeupPolicy;
  scope: PolicyScope;
}

export function getFullPolicyProfile(branchId: string, scope: PolicyScope = {}): AcademicPolicyProfile {
  return {
    attendance: getAttendancePolicy(branchId, scope),
    letterGradeBands: getLetterGradeBands(branchId, scope),
    retake: getRetakePolicy(branchId, scope),
    conditionalPass: getConditionalPassPolicy(branchId, scope),
    transfer: getTransferPolicy(branchId, scope),
    freeze: getFreezePolicy(branchId, scope),
    certificate: getCertificatePolicy(branchId, scope),
    makeup: getMakeupPolicy(branchId, scope),
    scope,
  };
}
