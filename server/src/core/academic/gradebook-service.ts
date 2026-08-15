/**
 * core/academic/gradebook-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 4: Gradebook Engine.
 *
 * "Gradebook should become the academic calculation engine rather than
 * simply storing scores" (blueprint §6). Before this phase, the weighted-
 * average + make-up-substitution scoring logic lived inline inside
 * complete-semester only — there was no way to preview a student's
 * projected final grade before locking the class, and the two other
 * things that needed the exact same math (a live gradebook preview, and
 * eventually the Phase 10 Transcript Engine) would have had to duplicate
 * it. This module is that logic, extracted into pure, DB-I/O-free
 * functions so it's usable from anywhere and trivially unit-testable.
 *
 * Nothing here calls db.prepare() — callers own their own prepared
 * statements (matching every other route file's convention) and pass
 * already-fetched rows in. The one exception is getLetterGradeBands(),
 * which goes through the existing Rule Engine (evaluateRules) rather than
 * touching the database directly, consistent with the AM-08/09 pattern:
 * the Academic Policy Engine is a wrapper over the Rule Engine, not new
 * infrastructure.
 * ============================================================================
 */
import { evaluateRules } from '../configuration/rule-engine.js';
import { ACADEMIC_DEFAULTS } from '../configuration/policy-catalog.js';

export interface AssessmentLike {
  id: string;
  weight: number;
  max_score: number;
  makeup_for_assessment_id: string | null;
}

export interface GradeLike {
  assessment_id: string;
  student_id: string;
  score: number | null;
}

export interface StudentLike {
  id: string;
  [key: string]: unknown;
}

export interface ComputedGrade {
  studentId: string;
  finalScore: number;
  finalPercentage: number;
  letterGrade: string;
  hasMissingGrades: boolean;
  isPassing: boolean;
}

export interface LetterGradeBand {
  min: number;
  grade: string;
}

/** Standard 5-band fallback, used until a branch configures its own via an
 *  'academic' category rule with a set_value action targeting
 *  `letterGradeBands` (an array of {min, grade}, evaluated highest-min-first). */
const DEFAULT_LETTER_BANDS: LetterGradeBand[] = [...ACADEMIC_DEFAULTS.letterGradeBands];

export function getLetterGradeBands(branchId: string, scope?: { programId?: string | null; levelId?: string | null }): LetterGradeBand[] {
  const result = evaluateRules({ category: 'academic', branchId, data: { ...scope } });
  const configured = result.finalOutputs.letterGradeBands;
  if (Array.isArray(configured) && configured.length > 0 && configured.every((b: unknown) => {
    const band = b as Partial<LetterGradeBand>;
    return typeof band?.min === 'number' && typeof band?.grade === 'string';
  })) {
    return [...(configured as LetterGradeBand[])].sort((a, b) => b.min - a.min);
  }
  return DEFAULT_LETTER_BANDS;
}

export function letterGradeFor(percentage: number, bands: LetterGradeBand[]): string {
  for (const band of bands) {
    if (percentage >= band.min) return band.grade;
  }
  return bands[bands.length - 1]?.grade ?? 'F';
}

/**
 * Computes each student's weighted final score/percentage/letter grade/
 * pass-fail for a class. This is the exact logic complete-semester has
 * always used (weighted average across non-makeup assessments, with a
 * graded make-up substituting for its original's contribution — see
 * Phase 3's AM-16), now shared by the live gradebook preview too.
 */
export function computeClassGrades(
  students: StudentLike[],
  assessments: AssessmentLike[],
  grades: GradeLike[],
  branchId: string,
  level?: string,
): ComputedGrade[] {
  const originalAssessments = assessments.filter((a) => !a.makeup_for_assessment_id);
  const totalWeight = originalAssessments.reduce((acc, a) => acc + (a.weight || 0), 0);

  const gradeMap = new Map<string, GradeLike>();
  for (const g of grades) gradeMap.set(`${g.assessment_id}_${g.student_id}`, g);

  const makeupsByOriginal = new Map<string, AssessmentLike[]>();
  for (const a of assessments) {
    if (!a.makeup_for_assessment_id) continue;
    const list = makeupsByOriginal.get(a.makeup_for_assessment_id) || [];
    list.push(a);
    makeupsByOriginal.set(a.makeup_for_assessment_id, list);
  }

  const bands = getLetterGradeBands(branchId);

  return students.map((student) => {
    let finalScore = 0;
    let hasMissingGrades = false;

    for (const a of originalAssessments) {
      const makeupCandidates = makeupsByOriginal.get(a.id) || [];
      let effectiveGrade: GradeLike | undefined;
      let effectiveMaxScore = a.max_score;
      for (const makeup of makeupCandidates) {
        const makeupGrade = gradeMap.get(`${makeup.id}_${student.id}`);
        if (makeupGrade && makeupGrade.score != null) {
          effectiveGrade = makeupGrade;
          effectiveMaxScore = makeup.max_score;
          break;
        }
      }
      if (!effectiveGrade) effectiveGrade = gradeMap.get(`${a.id}_${student.id}`);

      if (effectiveGrade && effectiveGrade.score != null) {
        finalScore += (effectiveGrade.score / effectiveMaxScore) * (a.weight || 0);
      } else {
        hasMissingGrades = true;
      }
    }

    const finalPercentage = totalWeight > 0 ? (finalScore / totalWeight) * 100 : 0;

    const promotionResult = evaluateRules({
      category: 'promotion',
      branchId,
      data: { examScore: finalPercentage, level, hasMissingGrades },
    });
    const isPassing =
      promotionResult.finalOutputs.promotionStatus === 'pass' ||
      (Object.keys(promotionResult.finalOutputs).length === 0 && finalPercentage >= ACADEMIC_DEFAULTS.levelPassMark);

    return {
      studentId: student.id,
      finalScore,
      finalPercentage,
      letterGrade: letterGradeFor(finalPercentage, bands),
      hasMissingGrades,
      isPassing,
    };
  });
}

export interface GradeSnapshot {
  score: number | null;
  status: string;
  notes: string | null;
}

/**
 * True if a grade upsert represents an actual change worth logging.
 * Re-saving identical values (e.g. an auto-save UI firing on an unchanged
 * field, or a bulk re-submit) is NOT logged — grade_history exists to show
 * meaningful edits, not to grow unbounded under a debounced-save frontend.
 */
export function hasGradeChanged(previous: GradeSnapshot | undefined, next: { score: number | null; status: string; notes?: string | null }): boolean {
  if (!previous) return true; // first time this assessment/student pair is graded
  if (previous.score !== next.score) return true;
  if (previous.status !== next.status) return true;
  if (next.notes !== undefined && next.notes !== previous.notes) return true;
  return false;
}
