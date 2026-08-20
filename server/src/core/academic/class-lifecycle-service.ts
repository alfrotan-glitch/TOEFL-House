/**
 * core/academic/class-lifecycle-service.ts
 * ============================================================================
 * Academic Module Refactor — Phase 1: Class Lifecycle Engine.
 *
 * Fixes the confirmed critical bug where every class creation threw
 * "SqliteError: CHECK constraint failed: classes" (classes.routes.ts always
 * inserted status='scheduled', a value the old 3-value CHECK never allowed,
 * and /:id/activate gated on that same unreachable value). Replaces the
 * unreachable activation gate with the full 11-stage blueprint
 * lifecycle: Draft → Scheduled → Enrollment Open → Enrollment Closed →
 * Activated → In Progress → Suspended → Grading → Completed → Archived /
 * Cancelled.
 *
 * `classes.status` is a derived, coarse 4-value
 * ('draft'|'active'|'completed'|'cancelled') projection of
 * `lifecycle_stage` (see deriveCoarseClassStatus in lifecycle-engine.ts) so
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
import { assertClassTransition, deriveCoarseClassStatus, type ClassStage } from './lifecycle-engine.js';
import { ACTIVE_ENROLLMENT_STATUSES } from './class-capacity.js';
import { createLogger } from '../observability/logger.js';
const log = createLogger('class-lifecycle-service');

/**
 * ROSTER-DRAIN INVARIANT (class audit C-1) — the single definition.
 *
 * A class may not be CANCELLED while students still hold a seat-consuming
 * enrollment in it.
 *
 * WHY THIS IS THE RULE, established from this codebase's own behaviour rather
 * than assumed:
 *
 *  1. `POST /:id/merge` already upholds it exactly. Merge relocates every
 *     seat-consuming enrollment into the target and only THEN cancels the
 *     source, so at the moment the source becomes 'cancelled' it holds zero
 *     live seats. The enrollment audit (E-3) made this explicit and locked it
 *     with a regression test: "a live enrollment pointing at a dead class" is
 *     named there as the defect being fixed.
 *  2. `DELETE /:id` refuses while ANY seat-consuming enrollment exists
 *     ("Transfer or complete them before deleting, or merge into another
 *     class"), which is the same invariant stated for a different terminal
 *     operation.
 *  3. `POST /:id/complete-semester` — the intended completion path — resolves
 *     every student through the Promotion Engine before locking the class, so
 *     it too leaves no live seat behind.
 *
 * The direct `POST /:id/cancel` endpoint was the only terminal writer that did
 * NOT apply it, so it stranded live enrollments on a dead class: the seats
 * stayed counted, the student stayed "enrolled" in a class that no longer runs,
 * and the class could then never be deleted because its own stranded seats
 * tripped the delete guard (reproduced live — see the C-1 regression suite).
 *
 * SEAT-CONSUMING is deliberately the same predicate capacity and duplicate
 * detection use (`ACTIVE_ENROLLMENT_STATUSES`): if a row counts against class
 * capacity, it is a live seat. Closed rows (transferred / dropped / withdrawn /
 * completed / graduated) are history and never block cancellation, so
 * cancelling an empty class, or one whose students have all left, stays legal.
 *
 * WHY 'completed' AND 'archived' ARE DELIBERATELY EXCLUDED
 * --------------------------------------------------------
 * They are NOT stranding states in this design. `complete-semester` resolves
 * students through the Promotion Engine, and an outcome of `manual_review`
 * INTENTIONALLY leaves the enrollment and its semester row 'active' after the
 * class locks — `GET /:id/promotion/pending-review` exists precisely to list
 * those rows, and it only returns anything once the stage is 'completed' or
 * 'archived'. `POST /:id/promotion/resolve/:studentId` then closes each one
 * (verified live: resolve returns 200 on a completed class). Blocking those two
 * stages would break the documented manual-review workflow, so the guard is
 * scoped to cancellation, which has no such resolution path and no reason to
 * retain a live seat.
 *
 * Merge is unaffected: it drains the roster inside the same transaction before
 * calling cancel(), so the guard sees zero live seats by then.
 */
export const ROSTER_DRAIN_GUARDED_STAGES: readonly ClassStage[] = ['cancelled'];

const SEAT_STATUS_SQL = ACTIVE_ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(', ');

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
  private stmtCountLiveSeats: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtGetClass = db.prepare('SELECT * FROM classes WHERE id = ?');
    this.stmtSetStage = db.prepare(`UPDATE classes SET lifecycle_stage = ?, status = ? WHERE id = ?`);
    this.stmtSetStageWithActivation = db.prepare(
      `UPDATE classes SET lifecycle_stage = ?, status = ?, activation_date = COALESCE(activation_date, ?) WHERE id = ?`,
    );
    this.stmtSetStageWithCancellation = db.prepare(
      `UPDATE classes SET lifecycle_stage = ?, status = ?, cancellation_reason = ? WHERE id = ?`,
    );
    this.stmtCountLiveSeats = db.prepare(
      `SELECT COUNT(DISTINCT student_id) AS c FROM enrollments
        WHERE class_id = ? AND status IN (${SEAT_STATUS_SQL})`,
    );
  }

  /** Live (seat-consuming) enrollments currently held by this class. */
  private countLiveSeats(classId: string): number {
    return Number((this.stmtCountLiveSeats.get(classId) as { c: number } | undefined)?.c ?? 0);
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

    // ── ROSTER-DRAIN GUARD (audit C-1) ──────────────────────────────────────
    // Cancellation must not strand live enrollments (see the invariant
    // documented above ROSTER_DRAIN_GUARDED_STAGES). Enforced here, at the
    // single transition funnel, so POST /:id/cancel and every future writer
    // that reaches 'cancelled' inherit it rather than each route repeating it.
    //
    // Merge is unaffected: it moves the seats out of the source inside its own
    // transaction BEFORE calling cancel(), so the count is already zero.
    if (ROSTER_DRAIN_GUARDED_STAGES.includes(to)) {
      const liveSeats = this.countLiveSeats(classId);
      if (liveSeats > 0) {
        throw new HttpError(
          409,
          `This class still has ${liveSeats} enrolled student(s) and cannot be cancelled. ` +
            'Resolve them first — merge this class into another, transfer them, or ' +
            'drop/withdraw each enrollment — so no student is left attached to a ' +
            'cancelled class.',
        );
      }
    }

    const nextStatus = deriveCoarseClassStatus(to);

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
      eventBus.dispatch(event).catch((err) => log.warn('[eventBus] class.lifecycle_changed dispatch failed', err));

      if (to === 'activated') {
        const activationEvent = eventBus.emit(
          'class.activated',
          'class',
          classId,
          { activationDate: cls.activation_date || today() },
          { operatorId: opts.operatorId ?? null, branchId: cls.branch_id },
        );
        eventBus.dispatch(activationEvent).catch((err) => log.warn('[eventBus] class.activated dispatch failed', err));
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
