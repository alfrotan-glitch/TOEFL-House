/**
 * core/academic/grade-lock-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 7: Grade Lock Workflow.
 *
 * Draft → Submitted → Reviewed → Approved → Published → Locked, applied
 * per-assessment (class_assessments.lock_status) rather than per
 * individual student_grades row — the whole assessment's grades move
 * through review together, which matches how a teacher actually works
 * (grade everyone, then submit the set for review) and avoids a much
 * heavier per-student-per-assessment state machine for no clear benefit.
 *
 * Reuses lifecycle-engine.ts's assertTransition() — the exact same
 * primitive Class (Phase 1) and Enrollment (Phase 1) already use — rather
 * than writing a fourth bespoke transition guard.
 *
 * "Published" also flips the assessment's Phase 3 `visibility` field to
 * 'visible' — publishing grades and making an assessment visible to
 * students are the same real-world action, so this keeps those two
 * fields from being able to drift out of sync with each other.
 * ============================================================================
 */
import type Database from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertGradeLockTransition, isTeacherEditableStage, type GradeLockStage } from './lifecycle-engine.js';

export interface AssessmentLockRow {
  id: string;
  class_id: string;
  title: string;
  lock_status: GradeLockStage;
}

export class GradeLockService {
  private stmtGetAssessment: Database.Statement;
  private stmtSetLockStatus: Database.Statement;
  private stmtSetLockStatusAndVisibility: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetAssessment = db.prepare('SELECT id, class_id, title, lock_status FROM class_assessments WHERE id = ?');
    this.stmtSetLockStatus = db.prepare(`UPDATE class_assessments SET lock_status = ?, lock_status_updated_at = datetime('now') WHERE id = ?`);
    this.stmtSetLockStatusAndVisibility = db.prepare(
      `UPDATE class_assessments SET lock_status = ?, lock_status_updated_at = datetime('now'), visibility = 'visible' WHERE id = ?`,
    );
  }

  getOrThrow(assessmentId: string): AssessmentLockRow {
    const row = this.stmtGetAssessment.get(assessmentId) as AssessmentLockRow | undefined;
    if (!row) throw new HttpError(404, 'Assessment not found.');
    return row;
  }

  /** Guarded transition — every public method below funnels through this. */
  transition(assessmentId: string, to: GradeLockStage): AssessmentLockRow {
    const assessment = this.getOrThrow(assessmentId);
    assertGradeLockTransition(assessment.lock_status, to);

    if (to === 'published') {
      this.stmtSetLockStatusAndVisibility.run(to, assessmentId);
    } else {
      this.stmtSetLockStatus.run(to, assessmentId);
    }
    return this.getOrThrow(assessmentId);
  }

  submit(assessmentId: string) { return this.transition(assessmentId, 'submitted'); }
  review(assessmentId: string) { return this.transition(assessmentId, 'reviewed'); }
  approve(assessmentId: string) { return this.transition(assessmentId, 'approved'); }
  publish(assessmentId: string) { return this.transition(assessmentId, 'published'); }
  lock(assessmentId: string) { return this.transition(assessmentId, 'locked'); }
  /** Sends back to Draft for correction — valid from submitted/reviewed/approved. */
  sendBackToDraft(assessmentId: string) { return this.transition(assessmentId, 'draft'); }

  /**
   * The one path out of Locked. Deliberately NOT a normal transition (see
   * GRADE_LOCK_TRANSITIONS — 'locked' has no forward transitions at all) —
   * this is a separate method so it's never reachable through the generic
   * transition() guard, matching "Locked grades cannot be modified without
   * authorized administrative action." Callers (routes) are responsible
   * for gating this to owner/manager/head_of_department.
   */
  unlock(assessmentId: string): AssessmentLockRow {
    const assessment = this.getOrThrow(assessmentId);
    if (assessment.lock_status !== 'locked') {
      throw new HttpError(409, `Assessment is not locked (currently ${assessment.lock_status}) — nothing to unlock.`);
    }
    this.stmtSetLockStatus.run('approved', assessmentId);
    return this.getOrThrow(assessmentId);
  }

  /**
   * Whether the given actor role may currently edit grades for this
   * assessment. Teachers only in Draft; manager-tier roles anywhere except
   * Locked (they can still correct a submitted/reviewed/approved/published
   * assessment without a formal unlock — only Locked requires the
   * explicit unlock() path).
   */
  canEditGrades(stage: GradeLockStage, role: string): boolean {
    if (['owner', 'general_manager', 'head_of_department'].includes(role)) {
      return stage !== 'locked';
    }
    return isTeacherEditableStage(stage);
  }
}

export function getGradeLockService(db: Database.Database) {
  return new GradeLockService(db);
}
