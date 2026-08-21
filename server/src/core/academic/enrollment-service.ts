import type Database from 'better-sqlite3';
import { id as makeId } from '../../utils/ids.js';
import { getCatalogService } from './catalog-service.js';
import { getJourneyEngine } from '../journey/journey-engine.js';
import { JourneyEventType } from '../journey/event-types.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { nextInvoiceNumber } from '../../utils/invoice.js';
import { assertMoney } from '../../utils/money.js';
import {
  assertEnrollmentTransition,
  type EnrollmentStatus,
  HOLD_STATUSES,
  TERMINAL_ENROLLMENT_STATUSES,
} from './lifecycle-engine.js';
import { countActiveStudentsInClass } from './class-capacity.js';
import { partitionFeeSnapshot } from '../finance/invoicing.js';
import { ensureTuitionObligation } from '../finance/obligations.js';
import { assertClassGenderAllows, assertNoDuplicateSeatEnrollment, assertNotAlreadySeatedInClass } from './class-admission.js';
import { resolvePlacementRequirement, isAuthoritativeDecision } from '../placement/policy-engine.js';
import { evaluateEnrollmentEligibility } from '../placement/placement-policy.js';
import { resolveGoverningProgramVersionId, assertPlacementEligibleForClass } from '../placement/enrollment-gate.js';
import { createLogger } from '../observability/logger.js';
const log = createLogger('enrollment-service');

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
  
  private stmtGetActiveEnrollments: Database.Statement;
  private stmtGetSuspendedEnrollments: Database.Statement;
  private stmtCompleteEnrollment: Database.Statement;
  private stmtTransferOutEnrollment: Database.Statement;
  private stmtInsertNewEnrollment: Database.Statement;
  private stmtInsertTransferEvent: Database.Statement;
  private stmtInsertEnrollEvent: Database.Statement;
  private stmtCompleteSourceSemester: Database.Statement;
  private stmtInsertNewSemester: Database.Statement;
  private stmtUpdateStudentCurrentClass: Database.Statement | null;
  private stmtDeleteFutureRosters: Database.Statement;
  private stmtGetFutureSessions: Database.Statement;
  private stmtInsertRoster: Database.Statement;
  
  private stmtSuspendEnrollment: Database.Statement;
  private stmtGetActiveSemesters: Database.Statement;
  private stmtDeferActiveSemesters: Database.Statement;
  private stmtDeferSemesterForClass: Database.Statement;
  private stmtInsertSuspensionBatch: Database.Statement;
  private stmtInsertSuspensionSemester: Database.Statement;
  private stmtGetOpenSuspensionBatch: Database.Statement;
  private stmtGetSuspensionSemesters: Database.Statement;
  private stmtActivateDeferredSemesterById: Database.Statement;
  private stmtCloseSuspensionBatch: Database.Statement;
  private stmtInsertSuspendEvent: Database.Statement;
  
  private stmtResumeEnrollment: Database.Statement;
  private stmtInsertResumeEvent: Database.Statement;
  private stmtSetStudentStatus: Database.Statement;

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
    
    // PURPOSE: `other`, and it is forced rather than chosen (WP07-F18).
    // `buildFeeSnapshot` puts a registration fee and a semester fee on ONE
    // document, so this invoice bills a mixture and can name no single tuition
    // obligation — which owner decision D-118 requires of a tuition invoice.
    // The semester row this service writes bills 0, so no tuition of its own
    // goes unsettled by the choice; booking it as `fee`, by contrast, paid down
    // OTHER terms' debt. Revisit when the owner rules on WP07-F18.
    this.stmtInsertInvoice = db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, purpose, obligation_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    this.stmtInsertInvoiceItem = db.prepare(
      `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, 1, ?, ?)`
    );

    this.stmtGetActiveEnrollments = db.prepare(
      `SELECT * FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY started_at ASC, created_at ASC, id ASC`,
    );
    this.stmtGetSuspendedEnrollments = db.prepare(
      `SELECT * FROM enrollments WHERE student_id = ? AND status = 'suspended' ORDER BY started_at ASC, created_at ASC, id ASC`,
    );
    this.stmtCompleteEnrollment = db.prepare(`UPDATE enrollments SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now'), notes = COALESCE(notes, '') || ? WHERE id = ?`);
    this.stmtTransferOutEnrollment = db.prepare(`UPDATE enrollments SET status = 'transferred', ended_at = datetime('now'), updated_at = datetime('now'), notes = COALESCE(notes, '') || ? WHERE id = ? AND status = 'active'`);
    this.stmtInsertNewEnrollment = db.prepare(
      `INSERT INTO enrollments (id, student_id, program_id, program_name, semester_name, level_code, class_id, branch_id, enrollment_type, status, started_at, notes, program_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', 'active', datetime('now'), ?, ?, datetime('now'), datetime('now'))`
    );
    this.stmtInsertTransferEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'transferred', ?, ?, ?, ?)`);
    this.stmtInsertEnrollEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'enrolled', ?, ?, ?, ?)`);
    this.stmtCompleteSourceSemester = db.prepare(`
      UPDATE student_semesters SET status = 'completed'
      WHERE student_id = ? AND class_id IS ? AND semester_name = ? AND status = 'active'
    `);
    // The term carries the tuition it bills. While it was inserted with a
    // hard-coded 0, the enrolment billed tuition on an invoice and the balance
    // authority — which reads this row — saw no debt at all (WP07-F18).
    this.stmtInsertNewSemester = db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, ?, ?, ?, date('now'), ?, ?, 'active')`);
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
    this.stmtGetActiveSemesters = db.prepare(
      `SELECT id, class_id FROM student_semesters WHERE student_id = ? AND status = 'active' ORDER BY enroll_date ASC, id ASC`,
    );
    this.stmtDeferActiveSemesters = db.prepare(`UPDATE student_semesters SET status = 'deferred' WHERE student_id = ? AND status = 'active'`);
    this.stmtInsertSuspensionBatch = db.prepare(
      `INSERT INTO student_suspension_batches (id, student_id) VALUES (?, ?)`,
    );
    this.stmtInsertSuspensionSemester = db.prepare(
      `INSERT INTO student_suspension_semesters (batch_id, semester_id, original_class_id) VALUES (?, ?, ?)`,
    );
    this.stmtGetOpenSuspensionBatch = db.prepare(
      `SELECT id FROM student_suspension_batches WHERE student_id = ? AND resumed_at IS NULL ORDER BY suspended_at DESC, id DESC LIMIT 1`,
    );
    this.stmtGetSuspensionSemesters = db.prepare(
      `SELECT semester_id, original_class_id FROM student_suspension_semesters WHERE batch_id = ? ORDER BY semester_id ASC`,
    );
    this.stmtActivateDeferredSemesterById = db.prepare(
      `UPDATE student_semesters SET status = 'active', class_id = ? WHERE id = ? AND status = 'deferred'`,
    );
    this.stmtCloseSuspensionBatch = db.prepare(
      `UPDATE student_suspension_batches SET resumed_at = datetime('now') WHERE id = ? AND resumed_at IS NULL`,
    );
    // Class-scoped variant used when a single enrollment closes (C-1): the
    // student-wide statement above belongs to suspend(), which defers the
    // student's whole load. Dropping one enrollment must only close that
    // enrollment's own semester projection.
    this.stmtDeferSemesterForClass = db.prepare(`UPDATE student_semesters SET status = 'deferred' WHERE student_id = ? AND class_id = ? AND status = 'active'`);
    this.stmtInsertSuspendEvent = db.prepare(`INSERT INTO enrollment_events (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id) VALUES (?, ?, ?, 'suspended', ?, NULL, ?, ?)`);

    this.stmtResumeEnrollment = db.prepare(`UPDATE enrollments SET status = 'active', class_id = ?, updated_at = datetime('now'), ended_at = NULL WHERE id = ?`);
    this.stmtSetStudentStatus = db.prepare(
      'UPDATE students SET status = ? WHERE id = ? AND status = ?',
    );
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
        // The occupied seat determines the placement level. A caller-supplied
        // first level must never replace a higher class level and manufacture
        // a first-level exemption.
        targetLevelId = cls.level_id;
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
    // Fail CLOSED on configuration faults: a program version exists, so a
    // placement policy is expected. A missing/unresolvable profile must not be
    // read as an administrative waiver. (Ad-hoc classes with no program version
    // at all are handled by the `!effectiveVersionId` early return above.)
    if (!isAuthoritativeDecision(requirement)) {
      throw new HttpError(
        409,
        'Placement policy is not configured for this program version. An administrator must configure it in Academic Setup before enrollment can proceed.'
      );
    }
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

  /**
   * DUPLICATE ENROLLMENT AUTHORITY (audit E-2).
   *
   * The business rule is: a student may hold at most ONE seat-consuming
   * enrollment in a given class at a time. "Seat-consuming" is deliberately
   * the same predicate capacity uses (`ACTIVE_ENROLLMENT_STATUSES` =
   * active / confirmed / pending) — if a row is counted against the class
   * capacity, it is a seat, and a student cannot hold two seats in one class.
   * Closed rows (transferred / dropped / withdrawn / completed / graduated)
   * are history and are intentionally NOT covered, so a student may legitimately
   * re-enroll in a class they left earlier, or repeat one.
   *
   * Before remediation this rule existed only as an inline check in
   * `students.routes.ts`, keyed on `status='active'` alone. Every other writer
   * — including `journey/enrollments`, which delegates here — had no duplicate
   * rule at all, so the same student could be given six active enrollments in
   * one class by varying `semesterName`. The rule now lives at the single
   * creation authority and is backed by a partial UNIQUE index (migration 074)
   * so it holds even under a race.
   *
   * Note the rule is per (student, class) and NOT per (student, class,
   * semester): semester name is caller-supplied free text and using it as part
   * of the key is precisely what made the old DB index bypassable.
   */
  private assertNoDuplicateClassEnrollment(
    studentId: string,
    classId: string | null | undefined,
    semesterName: string | null | undefined,
  ): void {
    assertNoDuplicateSeatEnrollment(this.db, studentId, classId, semesterName);
  }

  enroll(input: EnrollStudentInput) {
    const student = this.stmtGetStudent.get(input.studentId) as { id: string; branch_id: string; status: string; gender: string } | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.branch_id !== input.branchId) throw new HttpError(400, 'Student and enrollment branch must match.');
    // Graduation is terminal at the domain boundary, not merely at selected
    // HTTP routes. Journey enrollment and future callers converge here and
    // must not be able to manufacture an active enrollment for a graduate.
    if (student.status === 'graduated') {
      throw new HttpError(409, 'Cannot enroll this student: graduation is a final state.');
    }
    if (student.status === 'suspended') {
      throw new HttpError(409, 'Suspended students must be resumed through the lifecycle workflow.');
    }

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
      if (input.levelId && cls.level_id && String(input.levelId) !== String(cls.level_id)) {
        throw new HttpError(400, 'Class and enrollment level must match.');
      }
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

    // ── DUPLICATE GATE (single enforcement point for every enrollment path) ──
    // Enforced here rather than per route: checked at only one of the routes,
    // `journey/enrollments` — which funnels through this method — could stack
    // unlimited active enrollments for one student in one class (audit E-2).
    this.assertNoDuplicateClassEnrollment(input.studentId, input.classId, input.semesterName ?? null);

    // ── PLACEMENT GATE (single enforcement point for every enrollment path) ──
    // Every route that enrolls a student funnels through this method, so the
    // placement invariant lives here rather than being repeated per route.
    // Before this, only visitor→student conversion checked placement and five
    // other paths did not (certification finding C-1).
    //
    // UNCONDITIONAL. There is deliberately no opt-out parameter.
    //
    // A `skipPlacementGate` flag is deliberately not offered to the visitor
    // conversion route. The justification would be that conversion "evaluates
    // the identical placement rule" moments earlier. That claim is false, and
    // the gap it opens is
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
    const initialStatus: EnrollmentStatus = input.initialStatus || 'active';
    const semesterName = input.classId && initialStatus === 'active'
      ? (input.semesterName || 'Current Semester')
      : (input.semesterName ?? null);

    const run = this.db.transaction(() => {
      if (input.classId) {
        const current = countActiveStudentsInClass(this.db, input.classId);
        const capacity = Number((this.stmtGetClass.get(input.classId) as any)?.capacity ?? 0);
        if (capacity > 0 && current >= capacity) throw new HttpError(409, 'Selected class is full.');
        // Re-checked under the write lock so two concurrent requests cannot
        // both pass the pre-flight duplicate check (audit E-2).
        this.assertNoDuplicateClassEnrollment(input.studentId, input.classId, input.semesterName ?? null);
      }
      const snapshot = this.catalog.buildFeeSnapshot({
        programVersionId, levelId: input.levelId, branchId: input.branchId, enrollmentType,
      });
      const snapshotJson = JSON.stringify(snapshot);

      // WHAT THIS ENROLMENT BILLS, split by purpose before anything is written.
      // The discount attaches to TUITION only — the rule visitor conversion and
      // manual registration already apply — so a discount that fits the whole
      // snapshot but not the tuition is refused rather than silently spread
      // onto a registration fee nobody discounted.
      const { tuitionFees, otherFees, tuitionTotal, otherTotal } = partitionFeeSnapshot(snapshot.fees);
      // PARSED, not coerced (WP07-F20). `Math.max(0, Number(x))` accepted
      // `true` as a 1 AFN discount, `[1000]` as 1,000 AFN, and turned a
      // negative into a silent 0. The route above this one already parses with
      // `assertMoney`, but every caller converges HERE, so the guard belongs
      // here too — the same rule the invoice and payment boundaries apply.
      const discount = input.discountAmount == null
        ? 0
        : assertMoney(input.discountAmount, 'Enrolment discount');
      if (discount > tuitionTotal) {
        throw new HttpError(400, `Discount cannot exceed the tuition of ${tuitionTotal} AFN for this enrolment.`);
      }
      const netTuition = tuitionTotal - discount;

      this.stmtInsertEnrollment.run(
        enrollmentId, input.studentId, programId, programName, semesterName,
        levelCode, input.classId ?? null, input.branchId, enrollmentType, initialStatus, skillsJson,
        input.startedAt || new Date().toISOString(), input.notes ?? null, programVersionId, snapshotJson
      );

      // The student_semesters row is this enrolment's term, created here in the
      // same transaction as the enrollments row so the two can never drift.
      //
      // It carries the TUITION the enrolment bills, because `student_semesters`
      // is the canonical authority for what a term costs and every balance,
      // hold and settlement rule reads it. Two other writers — manual student
      // registration and visitor conversion — create the term themselves with
      // their own figures and pass `writeSemester: false`, which is why this is
      // conditional rather than unconditional.
      let termId: string | null = null;
      if (input.classId && initialStatus === 'active' && input.writeSemester !== false) {
        termId = makeId('ss');
        this.stmtInsertNewSemester.run(termId, input.studentId, semesterName, input.classId, tuitionTotal, netTuition);
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

      // ── BILLING: one document per purpose (owner decision on WP07-F18) ──
      //
      // Each purpose gets its own document, and the tuition one names the term
      // it bills — what D-127 requires of every tuition invoice. Registration
      // and tuition on one document would produce a tuition charge that can
      // settle no term, invisible to the balance authority.
      const issued: Array<{ id: string; number: string | null; purpose: 'tuition' | 'other'; netAmount: number }> = [];

      const issueInvoice = (
        purpose: 'tuition' | 'other',
        obligationId: string | null,
        gross: number,
        discountAmount: number,
        lines: readonly { name: string; amount: number }[],
      ) => {
        const netAmount = gross - discountAmount;
        if (gross <= 0) return;
        const newInvoiceId = makeId('inv');
        const due = new Date();
        due.setDate(due.getDate() + 14);
        const number = nextInvoiceNumber(input.branchId, new Date().getFullYear());
        this.stmtInsertInvoice.run(
          newInvoiceId, input.studentId, gross, discountAmount, netAmount,
          new Date().toISOString().slice(0, 10), due.toISOString().slice(0, 10), input.branchId,
          `Auto-generated from enrollment ${enrollmentId}`, number, input.actorName || 'system',
          purpose, obligationId,
        );
        for (const fee of lines) {
          this.stmtInsertInvoiceItem.run(makeId('ii'), newInvoiceId, fee.name, fee.amount, fee.amount);
        }
        issued.push({ id: newInvoiceId, number, purpose, netAmount });
        this.journey.appendEvent({
          studentId: input.studentId, eventType: JourneyEventType.INVOICE_ISSUED, occurredAt: new Date().toISOString(),
          branchId: input.branchId, enrollmentId, actorUserId: input.actorUserId, actorName: input.actorName,
          payload: { invoiceId: newInvoiceId, invoiceNumber: number, amount: netAmount, purpose, fees: lines },
        });
      };

      if (input.autoInvoice !== false) {
        if (termId) {
          // This call created the term, so tuition has an obligation to name.
          // Issued whenever tuition was CHARGED, even when a 100% authorized
          // discount takes it all: the document is the record that the fee
          // existed and was discounted, and the discounts-granted report sums
          // `invoices.discount_amount` from exactly these rows.
          if (tuitionTotal > 0) {
            const obligation = ensureTuitionObligation(this.db, termId);
            issueInvoice('tuition', obligation.id, tuitionTotal, discount, tuitionFees);
          }
          issueInvoice('other', null, otherTotal, 0, otherFees);
        } else if (input.writeSemester === false) {
          // The CALLER owns the term and has already written its own tuition
          // figure onto it. Billing tuition again here would charge it twice,
          // so only the fees alongside tuition are billed.
          issueInvoice('other', null, otherTotal, 0, otherFees);
        } else {
          // No term exists anywhere — an enrolment with no class writes no
          // projection — so no tuition obligation can be named and the whole
          // snapshot is billed as one non-tuition document. Recorded as the
          // narrow residual of WP07-F18: such an enrolment creates no tuition
          // receivable in the balance authority, because it creates no term.
          issueInvoice('other', null, snapshot.total, discount, snapshot.fees);
        }
      }

      const primary = issued.find((row) => row.purpose === 'tuition') ?? issued[0] ?? null;
      const invoiceId: string | null = primary?.id ?? null;
      const invoiceNumber: string | null = primary?.number ?? null;

      return { enrollmentId, invoiceId, invoiceNumber, invoices: issued, snapshot };
    });

    return run();
  }

  /**
   * Move a student from their current class into another one.
   *
   * TRANSFER SEMANTICS (audit E-1). A transfer MOVES an existing seat; it is
   * not a way to create one. Before remediation this method treated the source
   * enrollment as optional (`if (active)`) while running the destination
   * INSERT unconditionally, which made it an unguarded enrollment-CREATE path:
   * it resurrected students whose only enrollment was terminal, admitted
   * students with no enrollment at all, and skipped both the placement gate
   * and the lifecycle state machine that `enroll()` enforces.
   *
   * The contract is now explicit:
   *
   *   source enrollment  — MUST exist and MUST be 'active'. A student whose
   *                        enrollments are all terminal (graduated / dropped /
   *                        withdrawn / transferred) or who has none has nothing
   *                        to transfer; the correct operation is a fresh
   *                        enrollment through `enroll()`, which applies the
   *                        admission gates.
   *   source state       — active → 'transferred', validated through
   *                        `assertEnrollmentTransition` (the single lifecycle
   *                        authority) rather than an unchecked UPDATE.
   *   destination class  — must exist, be active, be in the student's branch,
   *                        admit the student's gender, have a free seat, and
   *                        not already hold a seat-consuming enrollment for
   *                        this student.
   *   destination enroll — created 'active', carrying the source program
   *                        lineage forward.
   *   financials         — unchanged by design: the source semester row is
   *                        closed and a new zero-fee row opened, so the
   *                        obligation is NOT duplicated (verified live).
   *
   * Admission gates (placement, gender, duplicate, capacity) are applied here
   * in the domain layer, not in the route, so every caller — the students
   * route, the transfer-request approval workflow, and any future writer —
   * gets the same rule.
   */
  transfer(input: { sourceEnrollmentId: string; toClassId: string; notes?: string | null; actorUserId?: string | null; }) {
    const source = this.stmtGetEnrollmentById.get(input.sourceEnrollmentId) as any;
    if (!source) throw new HttpError(404, 'Source enrollment not found.');
    if (source.status !== 'active') {
      throw new HttpError(409, `Only an active source enrollment can be transferred (this one is '${source.status}').`);
    }

    const student = this.stmtGetStudent.get(source.student_id) as { id: string; branch_id: string; status: string; gender: string } | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.status === 'suspended') throw new HttpError(409, 'Suspended students must be resumed before transfer.');
    const toClass = this.stmtGetClass.get(input.toClassId) as any;
    if (!toClass) throw new HttpError(404, 'Target class not found.');
    if (toClass.branch_id !== student.branch_id) throw new HttpError(400, 'Target class belongs to another branch.');
    if (toClass.status && toClass.status !== 'active') throw new HttpError(400, 'Target class is not active.');

    assertEnrollmentTransition(source.status as EnrollmentStatus, 'transferred');
    const fromClassId = source.class_id || null;
    if (fromClassId === input.toClassId) throw new HttpError(400, 'Student is already in this class.');

    assertClassGenderAllows(toClass, student.gender);
    assertPlacementEligibleForClass(this.db, source.student_id, input.toClassId, student.branch_id);
    assertNotAlreadySeatedInClass(this.db, source.student_id, input.toClassId);

    const newEnrollmentId = makeId('enr');
    const semesterName = source.semester_name || 'Current Semester';

    this.db.transaction(() => {
      const lockedSource = this.stmtGetEnrollmentById.get(input.sourceEnrollmentId) as any;
      if (!lockedSource || lockedSource.status !== 'active') {
        throw new HttpError(409, 'Source enrollment changed before the transfer could be committed.');
      }
      const currentTargetCount = countActiveStudentsInClass(this.db, input.toClassId);
      const targetCapacity = Number(toClass.capacity ?? 0);
      if (targetCapacity > 0 && currentTargetCount >= targetCapacity) throw new HttpError(409, 'Target class is full.');
      assertNotAlreadySeatedInClass(this.db, source.student_id, input.toClassId);

      const moved = this.stmtTransferOutEnrollment.run(
        input.notes ? `\n[transfer] ${input.notes}` : '\n[transfer]',
        source.id,
      );
      if (moved.changes !== 1) throw new HttpError(409, 'Source enrollment changed before the transfer could be committed.');
      this.stmtInsertTransferEvent.run(makeId('eev'), source.id, source.student_id, fromClassId, input.toClassId, input.notes || null, input.actorUserId || null);

      this.stmtInsertNewEnrollment.run(
        newEnrollmentId, source.student_id, source.program_id || toClass.program_id || null,
        source.program_name || null, semesterName, source.level_code || toClass.level || null,
        input.toClassId, toClass.branch_id, input.notes || null, source.program_version_id || null,
      );

      const semester = this.stmtCompleteSourceSemester.run(source.student_id, fromClassId, semesterName);
      if (semester.changes !== 1) {
        throw new HttpError(409, 'The source enrollment semester projection is missing or no longer active.');
      }
      // A transfer moves a student between classes; it opens the destination
      // projection and bills no NEW tuition, because the term being transferred
      // was already billed (D-88).
      this.stmtInsertNewSemester.run(makeId('ss'), source.student_id, semesterName, input.toClassId, 0, 0);

      try { this.stmtUpdateStudentCurrentClass?.run(input.toClassId, source.student_id); } catch { /* optional column */ }
      if (fromClassId) this.stmtDeleteFutureRosters.run(source.student_id, fromClassId);

      const futureSessions = this.stmtGetFutureSessions.all(input.toClassId) as { id: string }[];
      for (const s of futureSessions) this.stmtInsertRoster.run(makeId('ros'), s.id, source.student_id);

      this.stmtInsertEnrollEvent.run(makeId('eev'), newEnrollmentId, source.student_id, fromClassId, input.toClassId, 'transfer target', input.actorUserId || null);
    })();

    return { enrollmentId: newEnrollmentId, sourceEnrollmentId: source.id, fromClassId, toClassId: input.toClassId };
  }

  suspend(input: { studentId: string; notes?: string | null; actorUserId?: string | null; actorName?: string | null }) {
    const student = this.stmtGetStudent.get(input.studentId) as
      | { id: string; branch_id: string; status: string }
      | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.status !== 'active') {
      throw new HttpError(409, `Only an active student can be suspended (current status: '${student.status}').`);
    }

    // Only active enrollments can legally transition to suspended under the
    // enrollment state machine. Refuse the whole operation if any other live
    // lifecycle row exists instead of leaving a suspended profile with a
    // pending, reserved, frozen, paused, or retake enrollment behind.
    const incompatible = this.db.prepare(
      `SELECT status FROM enrollments WHERE student_id = ?
        AND status IN ('pending','reserved','confirmed','frozen','paused','suspended','retake','conditional_pass')
        LIMIT 1`,
    ).get(input.studentId) as { status: string } | undefined;
    if (incompatible) {
      throw new HttpError(409, `Resolve the student's '${incompatible.status}' enrollment before suspension.`);
    }

    const active = this.stmtGetActiveEnrollments.all(input.studentId) as any[];
    if (active.length === 0) throw new HttpError(409, 'No active enrollment to suspend.');

    this.db.transaction(() => {
      const suspensionBatchId = makeId('ssb');
      const activeSemesters = this.stmtGetActiveSemesters.all(input.studentId) as Array<{
        id: string;
        class_id: string | null;
      }>;
      this.stmtInsertSuspensionBatch.run(suspensionBatchId, input.studentId);
      for (const semester of activeSemesters) {
        this.stmtInsertSuspensionSemester.run(suspensionBatchId, semester.id, semester.class_id);
      }

      for (const enrollment of active) {
        assertEnrollmentTransition(enrollment.status as EnrollmentStatus, 'suspended');
        this.stmtSuspendEnrollment.run(
          input.notes ? `\n[suspend] ${input.notes}` : '\n[suspend]',
          enrollment.id,
        );
        if (enrollment.class_id) {
          this.stmtDeleteFutureRosters.run(input.studentId, enrollment.class_id);
        }
        this.stmtInsertSuspendEvent.run(
          makeId('eev'), enrollment.id, input.studentId, enrollment.class_id,
          input.notes || null, input.actorUserId || null,
        );
      }
      this.stmtDeferActiveSemesters.run(input.studentId);
      const statusUpdate = this.stmtSetStudentStatus.run('suspended', input.studentId, 'active');
      if (statusUpdate.changes !== 1) {
        throw new HttpError(409, 'Student status changed concurrently; reload before suspension.');
      }
      this.journey.appendEvent({
        studentId: input.studentId,
        eventType: JourneyEventType.STATUS_CHANGED,
        branchId: student.branch_id,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        payload: { from: 'active', status: 'suspended', enrollmentIds: active.map((row) => row.id) },
      });
    })();

    return {
      enrollmentId: active[0].id,
      classId: active[0].class_id,
      enrollmentIds: active.map((row) => row.id),
    };
  }

  resume(input: { studentId: string; classId?: string | null; notes?: string | null; actorUserId?: string | null; actorName?: string | null; }) {
    const student = this.stmtGetStudent.get(input.studentId) as
      | { id: string; branch_id: string; status: string; gender: string }
      | undefined;
    if (!student) throw new HttpError(404, 'Student not found.');
    if (student.status !== 'suspended') {
      throw new HttpError(409, `Only a suspended student can be resumed (current status: '${student.status}').`);
    }

    const suspended = this.stmtGetSuspendedEnrollments.all(input.studentId) as any[];
    if (suspended.length === 0) throw new HttpError(409, 'No suspended enrollment to resume.');
    const incompatible = this.db.prepare(
      `SELECT status FROM enrollments WHERE student_id = ?
        AND status IN ('pending','reserved','confirmed','active','frozen','paused','retake','conditional_pass')
        LIMIT 1`,
    ).get(input.studentId) as { status: string } | undefined;
    if (incompatible) {
      throw new HttpError(409, `Resolve the student's '${incompatible.status}' enrollment before resuming suspended enrollments.`);
    }
    if (input.classId && suspended.length !== 1) {
      throw new HttpError(409, 'A resume-class override is only valid when exactly one enrollment is suspended.');
    }

    const targets = suspended.map((enrollment) => {
      const classId = input.classId || enrollment.class_id;
      if (!classId) throw new HttpError(400, 'Every suspended enrollment needs a class before it can resume.');
      const targetClass = this.stmtGetClass.get(classId) as any;
      if (!targetClass) throw new HttpError(404, 'Resume class not found.');
      if (targetClass.branch_id !== student.branch_id) throw new HttpError(400, 'Resume class belongs to another branch.');
      if (targetClass.status !== 'active') throw new HttpError(400, 'Resume class is not active.');
      assertClassGenderAllows(targetClass, student.gender);
      return { enrollment, classId, targetClass };
    });

    this.db.transaction(() => {
      const openBatch = this.stmtGetOpenSuspensionBatch.get(input.studentId) as { id: string } | undefined;
      if (!openBatch) {
        // Pre-authority rows cannot identify which deferred semesters belonged
        // to the suspension. Reactivating by student or class would revive
        // unrelated history, so fail closed until the row is repaired with an
        // exact suspension mapping.
        throw new HttpError(409, 'Suspension restoration data is missing; repair the suspension record before resume.');
      }
      const suspensionSemesters = this.stmtGetSuspensionSemesters.all(openBatch.id) as Array<{
        semester_id: string;
        original_class_id: string | null;
      }>;
      const checkedClasses = new Set<string>();
      for (const target of targets) {
        // Capacity counts distinct students, not enrollment rows. Multiple
        // suspended terms for this one student in the same class consume one
        // seat when resumed together.
        if (checkedClasses.has(target.classId)) continue;
        const current = countActiveStudentsInClass(this.db, target.classId);
        const capacity = Number(target.targetClass.capacity ?? 0);
        if (capacity > 0 && current >= capacity) {
          throw new HttpError(409, `Resume class "${target.targetClass.name}" is full.`);
        }
        checkedClasses.add(target.classId);
      }

      for (const { enrollment, classId } of targets) {
        assertEnrollmentTransition(enrollment.status as EnrollmentStatus, 'active');
        this.stmtResumeEnrollment.run(classId, enrollment.id);

        const futureSessions = this.stmtGetFutureSessions.all(classId) as { id: string }[];
        for (const session of futureSessions) {
          this.stmtInsertRoster.run(makeId('ros'), session.id, input.studentId);
        }
        this.stmtInsertResumeEvent.run(
          makeId('eev'), enrollment.id, input.studentId,
          enrollment.class_id, classId, input.notes || null, input.actorUserId || null,
        );
      }

      const overriddenFromClass = input.classId ? suspended[0].class_id as string | null : undefined;
      for (const semester of suspensionSemesters) {
        const restoredClassId = input.classId && semester.original_class_id === overriddenFromClass
          ? input.classId
          : semester.original_class_id;
        this.stmtActivateDeferredSemesterById.run(restoredClassId, semester.semester_id);
      }
      this.stmtCloseSuspensionBatch.run(openBatch.id);

      const statusUpdate = this.stmtSetStudentStatus.run('active', input.studentId, 'suspended');
      if (statusUpdate.changes !== 1) {
        throw new HttpError(409, 'Student status changed concurrently; reload before resume.');
      }
      this.journey.appendEvent({
        studentId: input.studentId,
        eventType: JourneyEventType.STATUS_CHANGED,
        branchId: student.branch_id,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        payload: { from: 'suspended', status: 'active', enrollmentIds: suspended.map((row) => row.id) },
      });
    })();

    return {
      enrollmentId: suspended[0].id,
      classId: targets[0].classId,
      enrollmentIds: suspended.map((row) => row.id),
    };
  }

  // ==========================================================================
  // Enrollment Lifecycle Engine
  // ===========================================================================
  // Each named method validates its transition against ENROLLMENT_TRANSITIONS,
  // updates status/hold_reason/ended_at, records an enrollment_events row, and
  // appends the corresponding student journey event.

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
        // ── ENROLLMENT → SEMESTER PROJECTION (closure-audit finding C-1) ──
        // `student_semesters` is a derived projection of the enrollment, and
        // EnrollmentService is its single writer. Closing an enrollment without
        // closing that projection left the row `status='active'`, which had two
        // consequences: (1) `uq_student_semester_active(student_id,
        // semester_name)` (migration 056) then rejected a legitimate
        // re-enrolment into the same term with an opaque DB-level 409, and
        // (2) the dropped term kept counting toward the ACTIVE balance scope,
        // overstating current debt (proven: 6000 still reported as current
        // after a drop).
        //
        // 'deferred' — not 'completed' — is the correct target, established
        // from the existing precedent in classes.routes.ts: a manual-review
        // outcome of 'drop'/'retake' already maps the semester to 'deferred'
        // while calling this same service. It is also the only other status the
        // schema CHECK permits ('active','completed','deferred'), and
        // 'completed' would falsely assert the term was finished.
        //
        // Financial truth is preserved, not rewritten: the lifetime scope in
        // utils/studentBalance.ts applies no status filter, so the obligation
        // and every payment against it remain intact; only the ACTIVE scope
        // stops counting a term the student is no longer attending. No row is
        // deleted and no amount is altered.
        //
        // Scoped to this enrollment's own class so a student's other concurrent
        // terms are untouched.
        this.stmtDeferSemesterForClass.run(enrollment.student_id, enrollment.class_id);
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
        log.warn('[journey] enrollment status change event failed', err);
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
