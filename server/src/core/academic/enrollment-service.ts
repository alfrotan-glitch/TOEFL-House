import type Database from 'better-sqlite3';
import { id as makeId } from '../../utils/ids.js';
import { getCatalogService } from './catalog-service.js';
import { getJourneyEngine } from '../journey/journey-engine.js';
import { JourneyEventType } from '../journey/event-types.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { nextInvoiceNumber } from '../../utils/invoice.js';
import {
  assertEnrollmentTransition,
  type EnrollmentStatus,
  HOLD_STATUSES,
  TERMINAL_ENROLLMENT_STATUSES,
} from './lifecycle-engine.js';
import { countActiveStudentsInClass } from './class-capacity.js';
import { resolvePlacementRequirement } from '../placement/policy-engine.js';
import { evaluateEnrollmentEligibility } from '../placement/placement-policy.js';
import { resolveGoverningProgramVersionId } from '../placement/enrollment-gate.js';

export interface EnrollStudentInput {
  studentId: string;
  branchId: string;
  programVersionId?: string | null;
  programId?: string | null;
  programName?: string | null;
  levelId?: string | null;
  levelCode?: string | null;
  classId?: string | null;
  semesterName?: string | null;
  enrollmentType?: 'new' | 'repeat' | 'partial_repeat' | 'resume' | 'jump' | 'extra';
  skillsFocus?: string[] | null;
  notes?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
  startedAt?: string;
  autoInvoice?: boolean;
  discountAmount?: number;
  /** Enrollment Lifecycle Engine — defaults to 'active' to preserve exactly
   *  the historical behavior of every existing caller. Pass 'pending' or
   *  'reserved' to create a not-yet-active enrollment (e.g. for a future
   *  Waitlist Engine phase) without going through a second write. */
  initialStatus?: EnrollmentStatus;
  /** When false, enroll() does not create the student_semesters projection
   *  row. Callers that maintain their own (richer) semester row in the same
   *  transaction pass false to avoid duplicate projection writes. Defaults
   *  to true — EnrollmentService is the single writer of the projection. */
  writeSemester?: boolean;
}

/** Enrollment status → enrollment_events.event_type for the new lifecycle
 *  transitions. 'active' is context-sensitive: resuming from a hold logs
 *  'unfrozen', everything else landing on 'active' logs 'activated'. */
function eventTypeForTransition(from: EnrollmentStatus, to: EnrollmentStatus): string {
  if (to === 'active') return HOLD_STATUSES.includes(from) ? 'unfrozen' : 'activated';
  if (to === 'paused' || to === 'suspended') return 'suspended';
  const map: Partial<Record<EnrollmentStatus, string>> = {
    pending: 'pending_created', reserved: 'reserved', confirmed: 'confirmed',
    frozen: 'frozen', transferred: 'transferred', dropped: 'dropped',
    withdrawn: 'withdrawn', completed: 'completed', graduated: 'graduated',
    retake: 'retake_marked', conditional_pass: 'conditional_pass_marked',
  };
  return map[to] ?? 'confirmed';
}

export class EnrollmentService {
  private catalog: ReturnType<typeof getCatalogService>;
  private journey: ReturnType<typeof getJourneyEngine>;

  // Pre-compiled statements for maximum performance
  private stmtGetLevel: Database.Statement;
  private stmtGetVersion: Database.Statement;
  private stmtGetClass: Database.Statement;
  private stmtGetStudentPlacementLink: Database.Statement;
  private stmtGetVisitorPlacement: Database.Statement;
  private stmtGetLatestCompletedAttempt: Database.Statement;
  private stmtGetStudent: Database.Statement;
  private stmtInsertEnrollment: Database.Statement;
  private stmtInsertInvoice: Database.Statement;
  private stmtInsertInvoiceItem: Database.Statement;
  
  private stmtGetActiveEnrollment: Database.Statement;
  private stmtGetSuspendedEnrollment: Database.Statement;
  private stmtCompleteEnrollment: Database.Statement;
  private stmtTransferOutEnrollment: Database.Statement;
  private stmtInsertNewEnrollment: Database.Statement;
  private stmtInsertTransferEvent: Database.Statement;
  private stmtInsertEnrollEvent: Database.Statement;
  private stmtCompleteActiveSemesters: Database.Statement;
  private stmtInsertNewSemester: Database.Statement;
  private stmtUpdateStudentCurrentClass: Database.Statement | null;
  private stmtDeleteFutureRosters: Database.Statement;
  private stmtGetFutureSessions: Database.Statement;
  private stmtInsertRoster: Database.Statement;
  
  private stmtSuspendEnrollment: Database.Statement;
  private stmtDeferActiveSemesters: Database.Statement;
  private stmtInsertSuspendEvent: Database.Statement;
  
  private stmtResumeEnrollment: Database.Statement;
  private stmtActivateDeferredSemesters: Database.Statement;
  private stmtInsertResumeEvent: Database.Statement;

  private stmtGetEnrollmentById: Database.Statement;
  private stmtSetEnrollmentStatus: Database.Statement;
  private stmtInsertLifecycleEvent: Database.Statement;

  constructor(private db: Database.Database) {
    this.catalog = getCatalogService(db);
    this.journey = getJourneyEngine(db);

    this.stmtGetLevel = db.prepare('SELECT * FROM levels WHERE id = ?');
    this.stmtGetVersion = db.prepare(`SELECT pv.*, p.name AS program_name FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`);
    this.stmtGetClass = db.prepare('SELECT * FROM classes WHERE id = ?');
    this.stmtGetStudentPlacementLink = db.prepare('SELECT lead_id FROM students WHERE id = ?');
    this.stmtGetVisitorPlacement = db.prepare('SELECT placement_status FROM visitors WHERE id = ?');
    this.stmtGetLatestCompletedAttempt = db.prepare(`SELECT status, outcome FROM placement_assessment_attempts WHERE visitor_id = ? AND status = 'completed' ORDER BY completed_at DESC, attempt_number DESC LIMIT 1`);
    this.stmtGetStudent = db.prepare('SELECT id, branch_id, status, gender FROM students WHERE id = ?');
    // Capacity is counted by the single authoritative rule in
    // class-capacity.ts (enrollments, not student_semesters).
    
    this.stmtInsertEnrollment = db.prepare(
      `INSERT INTO enrollments (id, student_id, program_id, program_name, semester_name, level_code, class_id, branch_id, enrollment_type, status, skills_focus, started_at, notes, program_version_id, fee_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    );
    
    this.stmtInsertInvoice = db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    this.stmtInsertInvoiceItem = db.prepare(
      `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, 1, ?, ?)`
    );

    this.stmtGetActiveEnrollment = db.prepare(`SELECT * FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`);
    this.stmtGetSuspendedEnrollment = db.prepare(`SELECT * FROM enrollments WHERE student_id = ? AND status = 'suspended' ORDER BY started_at DESC LIMIT 1`);
    this.stmtCompleteEnrollment = db.prepare(`UPDATE enrollments SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now'), notes = COALESCE(notes, '') || ? WHERE id = ?`);
    this.stmtTransferOutEnrollment = db.prepare(`UPDATE enrollments SET status = 'transferred', ended_at = datetime('now'), updated_at = datetime('now'), notes = COALESCE(notes, '') || ? WHERE id = ?`);
    this.stmtInsertNewEnrollment = db.prepare(
      `INSERT INTO enrollments (id, student_id, program_id, program_name, semester_name, level_code, class_id, branch_id, enrollment_type, status, started_at, notes, program_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 'active', datetime('now'), ?, ?, datetime('now'), datetime('now'))`
    );
    this.stmtInsertTransferEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'transferred', ?, ?, ?, ?)`);
    this.stmtInsertEnrollEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'enrolled', ?, ?, ?, ?)`);
    this.stmtCompleteActiveSemesters = db.prepare(`UPDATE student_semesters SET status = 'completed' WHERE student_id = ? AND status = 'active'`);
    this.stmtInsertNewSemester = db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, ?, ?, date('now'), 0, 'active')`);
    // `students.current_class_id` is a denormalized convenience column that
    // has never existed in this schema (confirmed: absent from schema.sql
    // and all 30 migrations). Nothing else in the codebase reads it — the
    // one place that reports a student's "current class" (students.routes.ts
    // mapStudentBase) derives it from student_semesters instead — so this
    // here, meaning EnrollmentService could never be constructed at all
    // (every enroll/transfer/suspend/resume call site threw 500 before
    // reaching any logic). The call site already guarded `.run()` with a
    // try/catch and an "optional column" comment — that was the right
    // intent, just applied one level too late.
    try {
      this.stmtUpdateStudentCurrentClass = db.prepare(`UPDATE students SET current_class_id = ? WHERE id = ?`);
    } catch {
      this.stmtUpdateStudentCurrentClass = null;
    }
    this.stmtDeleteFutureRosters = db.prepare(`DELETE FROM rosters WHERE student_id = ? AND attendance_status = 'not_marked' AND session_id IN (SELECT id FROM sessions WHERE class_id = ? AND date >= date('now') AND status != 'cancelled')`);
    this.stmtGetFutureSessions = db.prepare(`SELECT id FROM sessions WHERE class_id = ? AND date >= date('now') AND status != 'cancelled'`);
    this.stmtInsertRoster = db.prepare(`INSERT OR IGNORE INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, ?, ?, 'not_marked')`);

    this.stmtSuspendEnrollment = db.prepare(`UPDATE enrollments SET status = 'suspended', updated_at = datetime('now'), notes = COALESCE(notes,'') || ? WHERE id = ?`);
    this.stmtDeferActiveSemesters = db.prepare(`UPDATE student_semesters SET status = 'deferred' WHERE student_id = ? AND status = 'active'`);
    this.stmtInsertSuspendEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'suspended', ?, NULL, ?, ?)`);

    this.stmtResumeEnrollment = db.prepare(`UPDATE enrollments SET status = 'active', class_id = ?, updated_at = datetime('now'), ended_at = NULL WHERE id = ?`);
    this.stmtActivateDeferredSemesters = db.prepare(`UPDATE student_semesters SET status = 'active', class_id = ? WHERE student_id = ? AND status = 'deferred'`);
    this.stmtInsertResumeEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'resumed', ?, ?, ?, ?)`);

    // Phase 1 — Enrollment Lifecycle Engine: generic transition support.
    this.stmtGetEnrollmentById = db.prepare('SELECT * FROM enrollments WHERE id = ?');
    this.stmtSetEnrollmentStatus = db.prepare(
      `UPDATE enrollments SET status = ?, hold_reason = ?,
         ended_at = CASE WHEN ? = 1 THEN datetime('now') ELSE ended_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    );
    this.stmtInsertLifecycleEvent = db.prepare(
      `INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  /**
   * Resolve the student's placement state and apply the shared domain rule.
   *
   * Reads the requirement from the program version the student is actually
   * being enrolled into (falling back to the class's own level so a caller
   * cannot dodge the gate by omitting programVersionId), then delegates the
   * verdict to `evaluateEnrollmentEligibility`. No rule logic lives here.
   */
  private assertPlacementEligible(input: EnrollStudentInput, programVersionId: string | null, levelCode: string | null): void {
    // Resolve the target level: explicit input first, then the class's level.
    // Without this fallback, omitting levelId would skip first-level exemption
    // handling and could refuse an otherwise-legitimate enrollment.
    let targetLevelId: string | null = input.levelId ?? null;
    let effectiveVersionId: string | null = programVersionId;
    if (input.classId) {
      const cls = this.stmtGetClass.get(input.classId) as any;
      if (cls?.level_id) {
        targetLevelId = targetLevelId || cls.level_id;
      }
      // The class's level is authoritative; the caller-supplied program is only
      // a fallback. Shared with the conversion route so the two can never
      // disagree about which program governs the seat (audit V-1).
      effectiveVersionId = resolveGoverningProgramVersionId(
        cls,
        effectiveVersionId,
        (levelId) => (this.stmtGetLevel.get(levelId) as any)?.program_version_id ?? null
      );
    }
    // No program version anywhere means no placement policy can apply. This is
    // the historical behaviour for ad-hoc classes and is preserved.
    if (!effectiveVersionId) return;

    const requirement = resolvePlacementRequirement(effectiveVersionId, input.branchId, targetLevelId);
    if (requirement.mode === 'not_required') return;

    const student = this.stmtGetStudentPlacementLink.get(input.studentId) as { lead_id: string | null } | undefined;
    const leadId = student?.lead_id ?? null;
    const visitor = leadId ? (this.stmtGetVisitorPlacement.get(leadId) as { placement_status: string | null } | undefined) : undefined;
    const attempt = leadId ? (this.stmtGetLatestCompletedAttempt.get(leadId) as { status: string; outcome: string | null } | undefined) : undefined;

    const verdict = evaluateEnrollmentEligibility(requirement.mode, {
      placementStatus: visitor?.placement_status ?? null,
      attempt: attempt ?? null,
      hasVisitorRecord: Boolean(leadId && visitor),
    });
    if (!verdict.eligible) throw new HttpError(400, verdict.reason);
    void levelCode;
  }

  enroll(input: EnrollStudentInput) {
    const student = this.stmtGetStudent.get(input.studentId) as { id: string; branch_id: string; status: string; gender: string } | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.branch_id !== input.branchId) throw new HttpError(400, 'Student and enrollment branch must match.');
    if (student.status === 'suspended' && input.enrollmentType !== 'resume') throw new HttpError(409, 'Suspended students must be resumed through the lifecycle workflow.');

    const enrollmentType = input.enrollmentType || 'new';
    let levelCode = input.levelCode ?? null;
    let programId = input.programId ?? null;
    let programName = input.programName ?? null;
    let programVersionId = input.programVersionId ?? null;

    if (input.levelId) {
      const level = this.stmtGetLevel.get(input.levelId) as any;
      if (level) {
        levelCode = levelCode || level.code || level.name;
        programId = programId || level.program_id;
        programVersionId = programVersionId || level.program_version_id;
      }
    }

    if (programVersionId && !programName) {
      const v = this.stmtGetVersion.get(programVersionId) as any;
      if (v) {
        programName = v.program_name;
        programId = programId || v.program_id;
      }
    }

    if (input.classId) {
      const cls = this.stmtGetClass.get(input.classId) as any;
      if (!cls) throw new HttpError(404, 'Class not found.');
      if (cls.branch_id !== input.branchId) throw new HttpError(400, 'Class and enrollment branch must match.');
      if (cls.status !== 'active') throw new HttpError(409, 'Selected class is not active.');
      if (programVersionId) {
        const classLevel = cls.level_id ? this.stmtGetLevel.get(cls.level_id) as any : null;
        const classProgramVersionId = classLevel?.program_version_id || null;
        if (classProgramVersionId && String(classProgramVersionId) !== String(programVersionId)) {
          throw new HttpError(400, 'Class and enrollment program version must match.');
        }
      }
      if (programId && cls.program_id && String(programId) !== String(cls.program_id)) {
        throw new HttpError(400, 'Class and enrollment program must match.');
      }
      if (!programId) {
        programId = cls.program_id;
        levelCode = levelCode || cls.level;
      }
    }

    if (input.classId) {
      const cls = this.stmtGetClass.get(input.classId) as any;
      const activeCount = countActiveStudentsInClass(this.db, input.classId);
      const capacity = Number(cls.capacity ?? 0);
      if (capacity > 0 && activeCount >= capacity) throw new HttpError(409, 'Selected class is full.');
    }

    // ── PLACEMENT GATE (single enforcement point for every enrollment path) ──
    // Every route that enrolls a student funnels through this method, so the
    // placement invariant lives here rather than being repeated per route.
    // Before this, only visitor→student conversion checked placement and five
    // other paths did not (certification finding C-1).
    //
    // UNCONDITIONAL. There is deliberately no opt-out parameter.
    //
    // A `skipPlacementGate` flag used to exist for the visitor conversion
    // route, justified by the claim that conversion "evaluates the identical
    // placement rule" moments earlier. That claim was false, and the gap was
    // exploitable (audit V-1): the route read the program off the VISITOR,
    // while this method resolves it from the CLASS's level. Clearing
    // `visitors.program_version_id` with an ordinary Lead.Edit PATCH therefore
    // made the route's check evaluate nothing at all — it was skipped, not
    // failed — and a candidate whose attempt completed with outcome 'failed'
    // was enrolled into the very program version they had failed.
    //
    // Two gates that resolve their inputs differently are two different rules.
    // This is now the single placement authority for every enrollment path.
    this.assertPlacementEligible(input, programVersionId, levelCode);

    const enrollmentId = makeId('enr');
    const skillsJson = input.skillsFocus ? JSON.stringify(input.skillsFocus) : null;

    const run = this.db.transaction(() => {
      if (input.classId) {
        const current = countActiveStudentsInClass(this.db, input.classId);
        const capacity = Number((this.stmtGetClass.get(input.classId) as any)?.capacity ?? 0);
        if (capacity > 0 && current >= capacity) throw new HttpError(409, 'Selected class is full.');
      }
      const snapshot = this.catalog.buildFeeSnapshot({
        programVersionId, levelId: input.levelId, branchId: input.branchId, enrollmentType,
      });
      const snapshotJson = JSON.stringify(snapshot);

      const initialStatus: EnrollmentStatus = input.initialStatus || 'active';
      this.stmtInsertEnrollment.run(
        enrollmentId, input.studentId, programId, programName, input.semesterName ?? null,
        levelCode, input.classId ?? null, input.branchId, enrollmentType, initialStatus, skillsJson,
        input.startedAt || new Date().toISOString(), input.notes ?? null, programVersionId, snapshotJson
      );

      // The student_semesters row is a derived projection (attendance /
      // gradebook). EnrollmentService is the single writer: it is created
      // here, in the same transaction as the enrollments row, so the two can
      // never drift. Callers that previously inserted a semester row
      // themselves (visitor conversion, waitlist conversion, manual student
      // registration) now rely on this.
      if (input.classId && initialStatus === 'active' && input.writeSemester !== false) {
        this.stmtInsertNewSemester.run(makeId('ss'), input.studentId, input.semesterName || 'Current Semester', input.classId);
      }

      const eventType = enrollmentType === 'repeat' || enrollmentType === 'partial_repeat'
        ? JourneyEventType.RETAKE_STARTED
        : enrollmentType === 'jump' ? JourneyEventType.PROGRAM_STARTED : JourneyEventType.ENROLLMENT_CREATED;

      this.journey.appendEvent({
        studentId: input.studentId, eventType, occurredAt: new Date().toISOString(), branchId: input.branchId,
        enrollmentId, actorUserId: input.actorUserId, actorName: input.actorName,
        payload: { enrollmentId, enrollmentType, programName, programVersionId, levelCode, classId: input.classId, feeSnapshot: snapshot },
      });

      if (input.classId) {
        this.journey.appendEvent({
          studentId: input.studentId, eventType: JourneyEventType.CLASS_ASSIGNED, occurredAt: new Date().toISOString(),
          branchId: input.branchId, enrollmentId, actorUserId: input.actorUserId, actorName: input.actorName,
          payload: { classId: input.classId },
        });
      }

      let invoiceId: string | null = null;
      let invoiceNumber: string | null = null;

      if (input.autoInvoice !== false && snapshot.total > 0) {
        invoiceId = makeId('inv');
        // A discount may not exceed the fee it discounts. `Math.max(0, total -
        // discount)` silently floored the net at zero, so a client-supplied
        // 9,999,999 on a 5,000 enrolment produced a 100% discount and a net of
        // 0 — a wiped obligation reported as success. journey.routes passes
        // discountAmount straight from the request body, so this is reachable
        // from the API and must be rejected here, at the one place every
        // caller converges.
        const discount = Math.max(0, Number(input.discountAmount || 0));
        if (discount > snapshot.total) {
          throw new HttpError(400, `Discount cannot exceed the enrolment fee of ${snapshot.total} AFN.`);
        }
        const net = snapshot.total - discount;
        
        const due = new Date();
        due.setDate(due.getDate() + 14);
        
        const year = new Date().getFullYear();
        invoiceNumber = nextInvoiceNumber(input.branchId, year);

        this.stmtInsertInvoice.run(
          invoiceId, input.studentId, snapshot.total, discount, net, new Date().toISOString().slice(0, 10),
          due.toISOString().slice(0, 10), input.branchId, `Auto-generated from enrollment ${enrollmentId}`,
          invoiceNumber, input.actorName || 'system'
        );

        for (const fee of snapshot.fees) {
          this.stmtInsertInvoiceItem.run(makeId('ii'), invoiceId, fee.name, fee.amount, fee.amount);
        }

        this.journey.appendEvent({
          studentId: input.studentId, eventType: JourneyEventType.INVOICE_ISSUED, occurredAt: new Date().toISOString(),
          branchId: input.branchId, enrollmentId, actorUserId: input.actorUserId, actorName: input.actorName,
          payload: { invoiceId, invoiceNumber, amount: net, fees: snapshot.fees },
        });
      }

      return { enrollmentId, invoiceId, invoiceNumber, snapshot };
    });

    return run();
  }

  transfer(input: { studentId: string; toClassId: string; notes?: string | null; actorUserId?: string | null; }) {
    const student = this.stmtGetStudent.get(input.studentId) as { id: string; branch_id: string; status: string; gender: string } | undefined;
    if (!student) throw new Error('Student not found.');
    if (student.status === 'suspended') throw new Error('Suspended students must be resumed before transfer.');
    const active = this.stmtGetActiveEnrollment.get(input.studentId) as any;
    const toClass = this.stmtGetClass.get(input.toClassId) as any;
    if (!toClass) throw new Error('Target class not found.');
    if (toClass.branch_id !== student.branch_id) throw new Error('Target class belongs to another branch.');
    if (toClass.status && toClass.status !== 'active') throw new Error('Target class is not active.');

    const fromClassId = active?.class_id || null;
    if (fromClassId === input.toClassId) throw new Error('Student is already in this class.');

    const newEnrollmentId = makeId('enr');

    this.db.transaction(() => {
      const currentTargetCount = countActiveStudentsInClass(this.db, input.toClassId);
      const targetCapacity = Number(toClass.capacity ?? 0);
      if (targetCapacity > 0 && currentTargetCount >= targetCapacity) throw new HttpError(409, 'Target class is full.');

      if (active) {
        this.stmtTransferOutEnrollment.run(input.notes ? `\n[transfer] ${input.notes}` : '\n[transfer]', active.id);
        this.stmtInsertTransferEvent.run(makeId('eev'), active.id, input.studentId, fromClassId, input.toClassId, input.notes || null, input.actorUserId || null);
      }

      this.stmtInsertNewEnrollment.run(
        newEnrollmentId, input.studentId, active?.program_id || toClass.program_id || null,
        active?.program_name || null, active?.semester_name || null, active?.level_code || toClass.level || null,
        input.toClassId, toClass.branch_id, input.notes || null, active?.program_version_id || null
      );

      this.stmtCompleteActiveSemesters.run(input.studentId);
      this.stmtInsertNewSemester.run(makeId('ss'), input.studentId, active?.semester_name || toClass.name || 'Term', input.toClassId);

      try { this.stmtUpdateStudentCurrentClass?.run(input.toClassId, input.studentId); } catch { /* optional column */ }

      if (fromClassId) {
        this.stmtDeleteFutureRosters.run(input.studentId, fromClassId);
      }

      const futureSessions = this.stmtGetFutureSessions.all(input.toClassId) as { id: string }[];
      for (const s of futureSessions) {
        this.stmtInsertRoster.run(makeId('ros'), s.id, input.studentId);
      }

      this.stmtInsertEnrollEvent.run(makeId('eev'), newEnrollmentId, input.studentId, fromClassId, input.toClassId, 'transfer target', input.actorUserId || null);
    })();

    return { enrollmentId: newEnrollmentId, fromClassId, toClassId: input.toClassId };
  }

  suspend(input: { studentId: string; notes?: string | null; actorUserId?: string | null }) {
    const active = this.stmtGetActiveEnrollment.get(input.studentId) as any;
    if (!active) throw new Error('No active enrollment to suspend.');

    this.db.transaction(() => {
      this.stmtSuspendEnrollment.run(input.notes ? `\n[suspend] ${input.notes}` : '\n[suspend]', active.id);
      this.stmtDeferActiveSemesters.run(input.studentId);

      if (active.class_id) {
        this.stmtDeleteFutureRosters.run(input.studentId, active.class_id);
      }

      this.stmtInsertSuspendEvent.run(makeId('eev'), active.id, input.studentId, active.class_id, input.notes || null, input.actorUserId || null);
    })();

    return { enrollmentId: active.id, classId: active.class_id };
  }

  resume(input: { studentId: string; classId?: string | null; notes?: string | null; actorUserId?: string | null; }) {
    const student = this.stmtGetStudent.get(input.studentId) as { id: string; branch_id: string; status: string } | undefined;
    if (!student) throw new Error('Student not found.');
    const suspended = this.stmtGetSuspendedEnrollment.get(input.studentId) as any;
    if (!suspended) throw new Error('No suspended enrollment to resume.');

    const classId = input.classId || suspended.class_id;
    if (!classId) throw new Error('classId required to resume.');
    const targetClass = this.stmtGetClass.get(classId) as any;
    if (!targetClass) throw new Error('Resume class not found.');
    if (targetClass.branch_id !== student.branch_id) throw new Error('Resume class belongs to another branch.');
    if (targetClass.status !== 'active') throw new Error('Resume class is not active.');

    this.db.transaction(() => {
      const currentTargetCount = countActiveStudentsInClass(this.db, classId);
      const targetCapacity = Number(targetClass.capacity ?? 0);
      if (targetCapacity > 0 && currentTargetCount >= targetCapacity) throw new HttpError(409, 'Resume class is full.');

      this.stmtResumeEnrollment.run(classId, suspended.id);
      this.stmtActivateDeferredSemesters.run(classId, input.studentId);

      const futureSessions = this.stmtGetFutureSessions.all(classId) as { id: string }[];
      for (const s of futureSessions) {
        this.stmtInsertRoster.run(makeId('ros'), s.id, input.studentId);
      }

      this.stmtInsertResumeEvent.run(makeId('eev'), suspended.id, input.studentId, suspended.class_id, classId, input.notes || null, input.actorUserId || null);
    })();

    return { enrollmentId: suspended.id, classId };
  }

  // ==========================================================================
  // Phase 1 — Enrollment Lifecycle Engine (blueprint expansion)
  // ==========================================================================
  // enroll()/transfer()/suspend()/resume() above are unchanged in behavior
  // (aside from transfer() now correctly writing 'transferred' instead of
  // overloading 'completed' — audited as safe, see lifecycle-engine.ts).
  // Everything below is additive. Each method validates the transition
  // against ENROLLMENT_TRANSITIONS, updates status/hold_reason/ended_at,
  // records an enrollment_events row, and appends a student journey event,
  // mirroring this service's existing pattern.

  getById(enrollmentId: string) {
    return this.stmtGetEnrollmentById.get(enrollmentId) as any;
  }

  private getEnrollmentOrThrow(enrollmentId: string): any {
    const row = this.stmtGetEnrollmentById.get(enrollmentId) as any;
    if (!row) throw new HttpError(404, 'Enrollment not found.');
    return row;
  }

  /** Core guarded transition. Kept private — call the named convenience
   *  methods below so call sites stay self-documenting. */
  private transitionEnrollment(input: {
    enrollmentId: string;
    to: EnrollmentStatus;
    reason?: string | null;
    actorUserId?: string | null;
    actorName?: string | null;
  }) {
    const enrollment = this.getEnrollmentOrThrow(input.enrollmentId);
    const from = enrollment.status as EnrollmentStatus;
    assertEnrollmentTransition(from, input.to);

    const isTerminal = TERMINAL_ENROLLMENT_STATUSES.includes(input.to) || input.to === 'completed';
    const holdReason = HOLD_STATUSES.includes(input.to) ? (input.reason ?? null) : null;

    this.db.transaction(() => {
      this.stmtSetEnrollmentStatus.run(input.to, holdReason, isTerminal ? 1 : 0, input.enrollmentId);

      this.stmtInsertLifecycleEvent.run(
        makeId('eev'), input.enrollmentId, enrollment.student_id,
        eventTypeForTransition(from, input.to),
        enrollment.class_id, enrollment.class_id, input.reason || null, input.actorUserId || null,
      );

      // Dropping/withdrawing means the student is not coming back to future
      // sessions of this class — clear their not-yet-marked roster entries,
      // mirroring how suspend() already does this for its own hold state.
      if ((input.to === 'dropped' || input.to === 'withdrawn') && enrollment.class_id) {
        this.stmtDeleteFutureRosters.run(enrollment.student_id, enrollment.class_id);
      }

      try {
        this.journey.appendEvent({
          studentId: enrollment.student_id,
          eventType: JourneyEventType.ENROLLMENT_STATUS_CHANGED,
          occurredAt: new Date().toISOString(),
          branchId: enrollment.branch_id,
          enrollmentId: input.enrollmentId,
          actorUserId: input.actorUserId,
          actorName: input.actorName,
          payload: { fromStatus: from, toStatus: input.to, reason: input.reason ?? null, classId: enrollment.class_id },
        });
      } catch (err) {
        console.warn('[journey] enrollment status change event failed', err);
      }
    })();

    return { enrollmentId: input.enrollmentId, from, to: input.to };
  }

  reserve(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'reserved', ...opts });
  }

  confirm(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'confirmed', ...opts });
  }

  /** Activates a pending/reserved/confirmed enrollment into 'active'. For
   *  resuming out of a hold (frozen/paused/suspended) prefer unfreeze(). */
  activate(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'active', ...opts });
  }

  /** Preferred going forward over suspend(): writes the blueprint-aligned
   *  'frozen' status and requires a reason (Freeze Engine minimum field). */
  freeze(enrollmentId: string, opts: { reason: string; actorUserId?: string; actorName?: string }) {
    return this.transitionEnrollment({ enrollmentId, to: 'frozen', ...opts });
  }

  unfreeze(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'active', ...opts });
  }

  drop(enrollmentId: string, opts: { reason: string; actorUserId?: string; actorName?: string }) {
    return this.transitionEnrollment({ enrollmentId, to: 'dropped', ...opts });
  }

  withdraw(enrollmentId: string, opts: { reason: string; actorUserId?: string; actorName?: string }) {
    return this.transitionEnrollment({ enrollmentId, to: 'withdrawn', ...opts });
  }

  /** Marks this specific class enrollment complete. Distinct from the
   *  Promotion Engine's class-level `complete-semester` action — that walks
   *  every roster row; this is the single-enrollment building block it can
   *  call into in a later refactor pass. */
  complete(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'completed', ...opts });
  }

  graduate(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'graduated', ...opts });
  }

  markRetake(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'retake', ...opts });
  }

  markConditionalPass(enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string } = {}) {
    return this.transitionEnrollment({ enrollmentId, to: 'conditional_pass', ...opts });
  }
}

export function getEnrollmentService(db: Database.Database) {
  return new EnrollmentService(db);
}
