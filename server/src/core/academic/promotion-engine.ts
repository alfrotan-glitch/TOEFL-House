/**
 * core/academic/promotion-engine.ts
 * ============================================================================
 * Academic Module Refactor — Phase 5: Promotion Engine.
 *
 * The audit before writing any code here found FOUR overlapping,
 * mostly-disconnected sources of promotion policy already built into this
 * codebase:
 *   1. `promotion_rules` — program_version + from_level + branch scoped,
 *      the richest (min_score, min_attendance_pct, require_all_subjects,
 *      to_level_id, auto_promote), evaluated by
 *      catalog-service.ts#evaluatePromotion() — which exists, is exposed
 *      at POST /api/catalog/promotion/evaluate, and is NEVER called by
 *      complete-semester. It was a standalone "check eligibility" preview
 *      tool, disconnected from the thing that actually locks a semester.
 *   2. `levels.pass_mark` — a per-level score threshold, fully CRUD-able
 *      via academic.routes.ts, read by nothing.
 *   3. `branch_academic_profiles.default_pass_mark` /
 *      `default_min_attendance` — branch-wide fallbacks, also read by
 *      nothing.
 *   4. The generic Rule Engine's 'promotion' category (branch-scoped only)
 *      — this is the ONE actually wired into complete-semester (Phase 3/4).
 *
 * Per "refactor only, reuse existing models" (ADR AM-24 below documents
 * the precedence chosen), this module does not add a fifth source. It
 * resolves criteria through the existing four, most-specific-wins, and
 * ADDS the two blueprint factors that had no home anywhere yet: financial
 * hold (built from the existing `invoices` table) and mandatory
 * per-skill passing scores (built from Phase 3's `passing_score` field,
 * which until now was stored but never checked against anything).
 *
 * No new migration was needed for this phase — see the Phase 5 report.
 * ============================================================================
 */
import type Database from 'better-sqlite3';
import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';

export type PromotionOutcome = 'promote' | 'retake' | 'conditional_pass' | 'manual_review';
export type ManualResolutionOutcome = 'promote' | 'retake' | 'conditional_pass' | 'drop';

export interface PromotionCriteria {
  minScore: number;
  minAttendancePercentage: number;
  requireAllSubjects: boolean;
  toLevelId: string | null;
  /** Which policy layer actually supplied these numbers — surfaced so a
   *  manager reviewing a decision can see why, not just what. */
  source: 'promotion_rules' | 'level_pass_mark' | 'branch_profile' | 'default';
}

export interface PromotionFactors {
  finalPercentage: number;
  hasMissingGrades: boolean;
  attendancePercentage: number | null;
  hasFinancialHold: boolean;
  failedMandatorySkills: string[];
  criteria: PromotionCriteria;
  /** Academic Policy Engine (Phase 6) — when provided, a retake outcome
   *  that would exceed the configured cap escalates to manual_review
   *  instead of looping the student through another automatic retake. */
  priorRetakeCount?: number;
  maxAutomaticRetakes?: number;
}

export interface PromotionDecision {
  outcome: PromotionOutcome;
  /** Only meaningful when outcome === 'manual_review' — a hint, never
   *  auto-applied. Drop is deliberately NOT an automated outcome (see
   *  ADR AM-25): a human always confirms it. */
  suggestedManualOutcome?: ManualResolutionOutcome;
  reasons: string[];
  toLevelId: string | null;
}

// ============================================================================
// Criteria resolution (most-specific-wins across the 4 existing layers)
// ============================================================================

export function resolvePromotionCriteria(
  db: Database.Database,
  cls: { level_id: string | null; branch_id: string; offering_id?: string | null },
): PromotionCriteria {
  const level = cls.level_id ? (db.prepare('SELECT * FROM levels WHERE id = ?').get(cls.level_id) as any) : null;
  const profile = db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?').get(cls.branch_id) as any;

  // Layer 1: promotion_rules, if we can resolve a program_version_id. The
  // most reliable path is via the level itself (levels.program_version_id
  // is set whenever a level was created through the catalog system);
  // course_offerings.program_version_id is a secondary path for classes
  // that carry an offering_id but whose level predates program versioning.
  let programVersionId: string | null = level?.program_version_id ?? null;
  if (!programVersionId && cls.offering_id) {
    const offering = db.prepare('SELECT program_version_id FROM course_offerings WHERE id = ?').get(cls.offering_id) as any;
    programVersionId = offering?.program_version_id ?? null;
  }

  if (programVersionId && cls.level_id) {
    const rule = db
      .prepare(
        `SELECT * FROM promotion_rules WHERE program_version_id = ? AND is_active = 1
         AND (from_level_id IS NULL OR from_level_id = ?) AND (branch_id IS NULL OR branch_id = ?)
         ORDER BY branch_id DESC LIMIT 1`,
      )
      .get(programVersionId, cls.level_id, cls.branch_id) as any;
    if (rule) {
      return {
        minScore: rule.min_score,
        minAttendancePercentage: rule.min_attendance_pct,
        requireAllSubjects: Boolean(rule.require_all_subjects),
        toLevelId: rule.to_level_id ?? null,
        source: 'promotion_rules',
      };
    }
  }

  // Layer 2: levels.pass_mark for score; branch profile for attendance
  // (levels has no attendance field of its own).
  if (level?.pass_mark != null) {
    return {
      minScore: level.pass_mark,
      minAttendancePercentage: profile?.default_min_attendance ?? ACADEMIC_DEFAULTS.defaultMinAttendance,
      requireAllSubjects: false, // no explicit rule configured -> don't newly start failing students per-skill
      toLevelId: null,
      source: 'level_pass_mark',
    };
  }

  // Layer 3: branch-wide profile.
  if (profile) {
    return {
      minScore: profile.default_pass_mark,
      minAttendancePercentage: profile.default_min_attendance,
      requireAllSubjects: false,
      toLevelId: null,
      source: 'branch_profile',
    };
  }

  // Layer 4: absolute last resort — matches the hardcoded fallback
  // complete-semester has always used.
  return { minScore: ACADEMIC_DEFAULTS.levelPassMark, minAttendancePercentage: ACADEMIC_DEFAULTS.defaultMinAttendance, requireAllSubjects: false, toLevelId: null, source: 'default' };
}

// ============================================================================
// Factor computation
// ============================================================================

export function computeAttendancePercentage(db: Database.Database, studentId: string, classId: string): number | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(COALESCE(r.attendance_weight, CASE WHEN r.attendance_status IN ('present','late','leave','online','hybrid','left_early') THEN 1 ELSE 0 END)) AS attended
       FROM rosters r JOIN sessions s ON s.id = r.session_id
       WHERE r.student_id = ? AND s.class_id = ? AND s.status = 'completed' AND r.attendance_status != 'not_marked'`,
    )
    .get(studentId, classId) as { total: number; attended: number };
  if (!row.total) return null; // no marked sessions at all — don't penalize on unknown data
  return (row.attended / row.total) * 100;
}

/** Reuses the existing `invoices.status` model rather than adding a new
 *  concept: overdue, or issued/partial already past due_date, both count. */
export function hasFinancialHold(db: Database.Database, studentId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM invoices
       WHERE student_id = ? AND (status = 'overdue' OR (status IN ('issued','partial') AND due_date IS NOT NULL AND due_date < date('now')))`,
    )
    .get(studentId) as { c: number };
  return row.c > 0;
}

/** Assessment types treated as the mandatory "subjects" blueprint's
 *  require_all_subjects refers to — the 4 core skill areas plus midterm/
 *  final, which is a class's actual proficiency checkpoints. Attendance/
 *  participation/homework/quiz/practice_test are excluded on purpose:
 *  they're formative, not gatekeeping. */
const MANDATORY_SUBJECT_TYPES = ['speaking', 'listening', 'reading', 'writing', 'midterm', 'final'];

export function findFailedMandatorySkills(db: Database.Database, classId: string, studentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT a.title, a.type, a.passing_score, g.score
       FROM class_assessments a
       LEFT JOIN student_grades g ON g.assessment_id = a.id AND g.student_id = ?
       WHERE a.class_id = ? AND a.makeup_for_assessment_id IS NULL AND a.passing_score IS NOT NULL`,
    )
    .all(studentId, classId) as { title: string; type: string; passing_score: number; score: number | null }[];

  const failed: string[] = [];
  for (const row of rows) {
    if (!MANDATORY_SUBJECT_TYPES.includes(row.type)) continue;
    // Check for a graded make-up first — same substitution rule as
    // computeClassGrades (Phase 4): a passed make-up clears the original.
    const makeup = db
      .prepare(
        `SELECT g.score, a.passing_score FROM class_assessments a
         JOIN student_grades g ON g.assessment_id = a.id AND g.student_id = ?
         WHERE a.makeup_for_assessment_id = (SELECT id FROM class_assessments WHERE class_id = ? AND title = ? AND type = ? LIMIT 1)
         ORDER BY g.graded_at DESC LIMIT 1`,
      )
      .get(studentId, classId, row.title, row.type) as { score: number; passing_score: number } | undefined;

    const effectiveScore = makeup?.score ?? row.score;
    if (effectiveScore == null || effectiveScore < row.passing_score) {
      failed.push(row.title);
    }
  }
  return failed;
}

// ============================================================================
// Decision (pure — no DB access, fully unit-testable)
// ============================================================================

export function decidePromotion(factors: PromotionFactors): PromotionDecision {
  const { criteria } = factors;
  const reasons: string[] = [];

  if (factors.hasFinancialHold) {
    return { outcome: 'manual_review', reasons: ['Outstanding financial hold — resolve before promotion can proceed.'], toLevelId: criteria.toLevelId };
  }
  if (factors.hasMissingGrades && factors.finalPercentage === 0) {
    return {
      outcome: 'manual_review',
      suggestedManualOutcome: 'retake',
      reasons: ['No grades recorded for this student — cannot evaluate automatically.'],
      toLevelId: criteria.toLevelId,
    };
  }

  const scoreOk = factors.finalPercentage >= criteria.minScore;
  const attOk = factors.attendancePercentage == null || factors.attendancePercentage >= criteria.minAttendancePercentage;
  const skillsOk = !criteria.requireAllSubjects || factors.failedMandatorySkills.length === 0;

  if (!scoreOk) reasons.push(`Final score ${factors.finalPercentage.toFixed(1)}% is below the required ${criteria.minScore}%.`);
  if (!attOk) reasons.push(`Attendance ${factors.attendancePercentage!.toFixed(1)}% is below the required ${criteria.minAttendancePercentage}%.`);
  if (!skillsOk) reasons.push(`Did not meet the passing score on: ${factors.failedMandatorySkills.join(', ')}.`);

  if (scoreOk && attOk && skillsOk) {
    return { outcome: 'promote', reasons: ['Meets all promotion criteria.'], toLevelId: criteria.toLevelId };
  }
  // Overall score is fine but one other dimension isn't — borderline,
  // not an outright failure. Can continue with conditions.
  if (scoreOk && (!attOk || !skillsOk)) {
    return { outcome: 'conditional_pass', reasons, toLevelId: criteria.toLevelId };
  }
  // Score itself failed. A catastrophic miss (less than half the
  // requirement) goes to manual review with a Drop suggestion rather than
  // an automatic Retake — that's a judgment call for a person, not an
  // algorithm (see ADR AM-25).
  if (factors.finalPercentage < criteria.minScore / 2) {
    return {
      outcome: 'manual_review',
      suggestedManualOutcome: 'drop',
      reasons: [...reasons, 'Score is critically low — consider whether the student should continue in this program.'],
      toLevelId: null,
    };
  }

  // Retake Policy (Academic Policy Engine, Phase 6): don't loop a student
  // through indefinite automatic retakes — escalate to a person once the
  // configured cap is reached.
  if (factors.priorRetakeCount != null && factors.maxAutomaticRetakes != null && factors.priorRetakeCount >= factors.maxAutomaticRetakes) {
    return {
      outcome: 'manual_review',
      reasons: [...reasons, `Already retaken ${factors.priorRetakeCount} time(s), at the configured limit of ${factors.maxAutomaticRetakes} — requires a decision, not another automatic retake.`],
      toLevelId: null,
    };
  }

  return { outcome: 'retake', reasons, toLevelId: null };
}
