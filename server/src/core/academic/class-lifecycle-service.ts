/**
 * core/academic/class-lifecycle-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 1: Class Lifecycle Engine.
 *
 * Fixes the confirmed critical bug where every class creation threw
 * "SqliteError: CHECK constraint failed: classes" (classes.routes.ts always
 * inserted status='scheduled', a value the old 3-value CHECK never allowed,
 * and /:id/activate gated on that same unreachable value). Replaces the
 * previously dead activation gate with the full 11-stage blueprint
 * lifecycle: Draft → Scheduled → Enrollment Open → Enrollment Closed →
 * Activated → In Progress → Suspended → Grading → Completed → Archived /
 * Cancelled.
 *
 * `classes.status` remains a derived, backward-compatible 4-value
 * ('draft'|'active'|'completed'|'cancelled') projection of
 * `lifecycle_stage` (see deriveLegacyClassStatus in lifecycle-engine.ts) so
 * every existing `status === 'active'` frontend/backend filter keeps
 * working unchanged. This service is the only place that should write
 * `lifecycle_stage`; every write pairs it with the derived `status` in the
 * same statement so the two columns can never drift. There is deliberately
 * no DB trigger enforcing this (see migration 030's header comment: this
 * codebase's migration runner cannot parse CREATE TRIGGER ... BEGIN/END
 * bodies) — application-level enforcement matches this codebase's existing
 * convention for SQLite CHECK limitations.
 * ============================================================================
 */
import type Database from 'better-sqlite3';
import { eventBus } from '../events/event-bus.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { today } from '../../utils/ids.js';
import { assertClassTransition, deriveLegacyClassStatus, type ClassStage } from './lifecycle-engine.js';

export interface ClassRowLite {
  id: string;
  name: string;
  branch_id: string;
  lifecycle_stage: ClassStage;
  status: string;
  activation_date: string | null;
  [key: string]: unknown;
}

export interface TransitionOptions {
  reason?: string | null;
  operatorId?: string | null;
}

export class ClassLifecycleService {
  private stmtGetClass: Database.Statement;
  private stmtSetStage: Database.Statement;
  private stmtSetStageWithActivation: Database.Statement;
  private stmtSetStageWithCancellation: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetClass = db.prepare('SELECT * FROM classes WHERE id = ?');
    this.stmtSetStage = db.prepare(`UPDATE classes SET lifecycle_stage = ?, status = ? WHERE id = ?`);
    this.stmtSetStageWithActivation = db.prepare(
      `UPDATE classes SET lifecycle_stage = ?, status = ?, activation_date = COALESCE(activation_date, ?) WHERE id = ?`,
    );
    this.stmtSetStageWithCancellation = db.prepare(
      `UPDATE classes SET lifecycle_stage = ?, status = ?, cancellation_reason = ? WHERE id = ?`,
    );
  }

  getOrThrow(classId: string): ClassRowLite {
    const row = this.stmtGetClass.get(classId) as ClassRowLite | undefined;
    if (!row) throw new HttpError(404, 'Class not found.');
    return row;
  }

  /**
   * Guarded transition — every public method below funnels through this so
   * lifecycle_stage/status can never be written independently or skip
   * validation. Safe to call from within an already-open db.transaction()
   * (e.g. the merge flow): better-sqlite3 uses a SAVEPOINT for nested
   * transaction() calls rather than failing.
   */
  transition(classId: string, to: ClassStage, opts: TransitionOptions = {}): ClassRowLite {
    const cls = this.getOrThrow(classId);
    const from = cls.lifecycle_stage;
    assertClassTransition(from, to);

    if (to === 'cancelled' && !String(opts.reason ?? '').trim()) {
      throw new HttpError(400, 'Cancellation reason is required.');
    }
    if (to === 'in_progress') {
      const scheduled = this.db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE class_id = ? AND status != 'cancelled'`).get(classId) as { c: number };
      if (Number(scheduled.c) === 0) throw new HttpError(409, 'Class cannot start teaching before at least one teaching session has been scheduled.');
    }

    const nextStatus = deriveLegacyClassStatus(to);

    this.db.transaction(() => {
      if (to === 'activated') {
        this.stmtSetStageWithActivation.run(to, nextStatus, today(), classId);
      } else if (to === 'cancelled') {
        this.stmtSetStageWithCancellation.run(to, nextStatus, opts.reason ?? null, classId);
      } else {
        this.stmtSetStage.run(to, nextStatus, classId);
      }

      const event = eventBus.emit(
        'class.lifecycle_changed',
        'class',
        classId,
        { fromStage: from, toStage: to, reason: opts.reason ?? null },
        { operatorId: opts.operatorId ?? null, branchId: cls.branch_id },
      );
      // Fire-and-forget dispatch: later phases (attendance/payroll gating)
      // can subscribe without this call ever blocking the transition.
      eventBus.dispatch(event).catch((err) => console.warn('[eventBus] class.lifecycle_changed dispatch failed', err));

      if (to === 'activated') {
        const activationEvent = eventBus.emit(
          'class.activated',
          'class',
          classId,
          { activationDate: cls.activation_date || today() },
          { operatorId: opts.operatorId ?? null, branchId: cls.branch_id },
        );
        eventBus.dispatch(activationEvent).catch((err) => console.warn('[eventBus] class.activated dispatch failed', err));
      }
    })();

    return this.getOrThrow(classId);
  }

  schedule(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'scheduled', opts);
  }
  openEnrollment(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'enrollment_open', opts);
  }
  closeEnrollment(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'enrollment_closed', opts);
  }
  /** Sets activation_date (once, first time only) and marks the class as
   *  officially activated — the blueprint's gate for attendance, homework,
   *  exams, academic KPIs, and teaching-related financial calculations. */
  activate(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'activated', opts);
  }
  /** First session has begun / teaching is actively under way. */
  startTeaching(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'in_progress', opts);
  }
  suspend(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'suspended', opts);
  }
  /** Resumes a suspended class back into In Progress. */
  resume(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'in_progress', opts);
  }
  startGrading(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'grading', opts);
  }
  complete(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'completed', opts);
  }
  archive(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'archived', opts);
  }
  cancel(classId: string, opts?: TransitionOptions) {
    return this.transition(classId, 'cancelled', opts);
  }
}

export function getClassLifecycleService(db: Database.Database) {
  return new ClassLifecycleService(db);
}
