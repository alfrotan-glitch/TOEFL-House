/**
 * Placement enrollment gate — shared helper for callers that write an
 * enrollment row directly instead of going through EnrollmentService.enroll().
 *
 * There is exactly one such caller today (the extra-class endpoint in
 * students.routes.ts). It exists so that path applies the SAME domain rule as
 * the service, rather than growing a second copy of the logic. Both ultimately
 * call `evaluateEnrollmentEligibility`.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { resolvePlacementRequirement, isAuthoritativeDecision } from './policy-engine.js';
import { evaluateEnrollmentEligibility } from './placement-policy.js';

/**
 * The program version that GOVERNS an enrollment, resolved the one correct way.
 *
 * The class's own level is authoritative, because that is what determines which
 * placement policy applies to the seat being filled. A caller-supplied program
 * (from a visitor row or a request body) is only a fallback for classes that
 * carry no level.
 *
 * Audit V-1 existed precisely because two call sites disagreed about this:
 * `EnrollmentService` resolved class → level → program_version_id, while the
 * conversion route read `visitors.program_version_id`. Detaching the visitor's
 * program therefore silenced the route's gate while the class remained
 * placement-governed. Everything that needs this answer now calls this function.
 */
export function resolveGoverningProgramVersionId(
  cls: { level_id?: string | null; program_version_id?: string | null } | null | undefined,
  fallbackProgramVersionId: string | null | undefined,
  lookupLevelProgramVersion?: (levelId: string) => string | null
): string | null {
  if (cls?.level_id && lookupLevelProgramVersion) {
    const fromLevel = lookupLevelProgramVersion(cls.level_id);
    if (fromLevel) return fromLevel;
  }
  return fallbackProgramVersionId ?? null;
}

export function assertPlacementEligibleForClass(
  db: BetterSqlite3.Database,
  studentId: string,
  classId: string,
  branchId: string
): void {
  const cls = db.prepare('SELECT level_id FROM classes WHERE id = ?').get(classId) as { level_id: string | null } | undefined;
  if (!cls?.level_id) return; // no level → no placement policy can attach
  const level = db.prepare('SELECT program_version_id FROM levels WHERE id = ?').get(cls.level_id) as { program_version_id: string | null } | undefined;
  const programVersionId = level?.program_version_id ?? null;
  if (!programVersionId) return;

  const requirement = resolvePlacementRequirement(programVersionId, branchId, cls.level_id);
  // Fail CLOSED on configuration faults. A missing/unresolvable profile is not
  // a business waiver, and previously fell through this check and admitted the
  // student without any assessment.
  if (!isAuthoritativeDecision(requirement)) {
    throw new HttpError(
      409,
      'Placement policy is not configured for this program version. An administrator must configure it in Academic Setup before enrollment can proceed.'
    );
  }
  if (requirement.mode === 'not_required') return;

  const student = db.prepare('SELECT lead_id FROM students WHERE id = ?').get(studentId) as { lead_id: string | null } | undefined;
  const leadId = student?.lead_id ?? null;
  const visitor = leadId
    ? (db.prepare('SELECT placement_status FROM visitors WHERE id = ?').get(leadId) as { placement_status: string | null } | undefined)
    : undefined;
  const attempt = leadId
    ? (db.prepare(`SELECT status, outcome FROM placement_assessment_attempts WHERE visitor_id = ? AND status = 'completed' ORDER BY completed_at DESC, attempt_number DESC LIMIT 1`).get(leadId) as { status: string; outcome: string | null } | undefined)
    : undefined;

  const verdict = evaluateEnrollmentEligibility(requirement.mode, {
    placementStatus: visitor?.placement_status ?? null,
    attempt: attempt ?? null,
    hasVisitorRecord: Boolean(leadId && visitor),
  });
  if (!verdict.eligible) throw new HttpError(400, verdict.reason);
}
