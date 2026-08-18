import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, canAccessBranchResource } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { assertMoney } from '../utils/money.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { writeAudit } from '../middleware/audit.js';
// The journey route is NOT a second status authority (audit STU-C1). It
// delegates every students.status write to the same guarded function the
// status endpoint uses.
import { applyStudentStatus } from './students.routes.js';
import {
  assertStudentTransition,
  isStudentStatus,
  STUDENT_STATUSES,
  type StudentStatus,
} from '../core/students/student-lifecycle.js';

export const journeyRouter = Router({ mergeParams: true });
journeyRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetStudentCore = db.prepare('SELECT id, full_name, branch_id, status, gender FROM students WHERE id = ?');
// stmtUpdateStudentStatus / stmtGraduateStudent removed (audit STU-C1): this
// module no longer writes students.status directly. Both event types now go
// through applyStudentStatus(), which validates the transition and performs
// the enrollment side effects.

const engine = () => getJourneyEngine(db);

/** Safely extract user context required for mutations */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for journey operation.');
  }
  return user;
}

function requireStudent(req: import('express').Request, studentId: string) {
  const row = stmtGetStudentCore.get(studentId) as any;
  if (!row) throw new HttpError(404, 'Student not found.');
  if (!canAccessBranchResource(req, row.branch_id)) {
    throw new HttpError(403, 'Student belongs to another branch.');
  }
  return row;
}

/** Full chronological lifecycle timeline. */
journeyRouter.get(
  '/timeline',
  authorize('owner', 'manager', 'registrar', 'finance', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    requireStudent(req, studentId);
    res.json({
      studentId,
      timeline: engine().getTimeline(studentId),
    });
  })
);

/** Financial subset of the journey (ledger-style). */
journeyRouter.get(
  '/finance-timeline',
  authorize('owner', 'manager', 'registrar', 'finance'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    requireStudent(req, studentId);
    res.json({
      studentId,
      timeline: engine().getFinancialTimeline(studentId),
    });
  })
);

/** Projected current state from events only. */
journeyRouter.get(
  '/state',
  authorize('owner', 'manager', 'registrar', 'finance', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    requireStudent(req, studentId);
    res.json(engine().getCurrentState(studentId));
  })
);

/** Combined journey payload for UI drawers. */
journeyRouter.get(
  '/',
  authorize('owner', 'manager', 'registrar', 'finance', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    const j = engine();
    res.json({
      student: {
        id: student.id,
        fullName: student.full_name,
        status: student.status,
        branchId: student.branch_id,
      },
      state: j.getCurrentState(studentId),
      timeline: j.getTimeline(studentId),
      financialTimeline: j.getFinancialTimeline(studentId),
    });
  })
);

/** Manual note / status annotation on the journey (append-only). */
journeyRouter.post(
  '/events',
  authorize('owner', 'manager', 'registrar'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    const { eventType, payload, occurredAt, enrollmentId } = req.body ?? {};

    const allowed = new Set([
      JourneyEventType.NOTE_ADDED,
      JourneyEventType.STATUS_CHANGED,
      JourneyEventType.PROMOTION_DECIDED,
      JourneyEventType.PLACEMENT_TEST_RECORDED,
      JourneyEventType.PLACEMENT_PASSED,
      JourneyEventType.PLACEMENT_FAILED,
      JourneyEventType.GRADUATED,
      JourneyEventType.ALUMNI_ENTERED,
    ]);

    if (!eventType || !allowed.has(eventType)) {
      throw new HttpError(400, 'Unsupported or missing eventType for manual append.');
    }

    // Profile status mirror. This used to be a second, unvalidated writer of
    // students.status: it accepted 'suspended' (which the status endpoint
    // explicitly refuses because suspension must defer enrollments), skipped
    // every transition rule, and silently ignored unknown values. It now
    // delegates to the single guarded authority — audit STU-C1.
    const applyStatus = (to: StudentStatus) => {
      const from = (isStudentStatus(student.status) ? student.status : 'active') as StudentStatus;
      if (to === 'suspended') {
        throw new HttpError(
          400,
          'Use POST /api/students/:id/suspend to suspend a student — suspension must also defer their enrollments.',
        );
      }
      if (from === 'suspended' && to === 'active') {
        throw new HttpError(
          400,
          'Use POST /api/students/:id/resume to reactivate a suspended student.',
        );
      }
      assertStudentTransition(from, to);
      if (from !== to) applyStudentStatus(req, student, to);
    };

    if (eventType === JourneyEventType.STATUS_CHANGED && payload?.status) {
      const st = String(payload.status);
      if (!isStudentStatus(st)) {
        throw new HttpError(400, `Status must be one of: ${STUDENT_STATUSES.join(', ')}.`);
      }
      applyStatus(st);
    }
    if (eventType === JourneyEventType.GRADUATED) {
      applyStatus('graduated');
    }

    const item = engine().appendEvent({
      studentId,
      eventType,
      occurredAt,
      branchId: student.branch_id,
      enrollmentId: enrollmentId || null,
      payload: payload || {},
      actorUserId: user.userId,
      actorName: user.fullName,
    });

    writeAudit(req, `Journey event ${eventType} for student ${student.full_name}`);
    res.status(201).json(item);
  })
);

/** Create enrollment (new / repeat / partial_repeat / resume / jump). */
journeyRouter.post(
  '/enrollments',
  authorize('owner', 'manager', 'registrar'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const studentId = req.params.id as string;
    const student = requireStudent(req, studentId);
    
    const {
      programId, programName, semesterName, levelCode, classId,
      enrollmentType, skillsFocus, notes,
    } = req.body ?? {};

    const { programVersionId, levelId, autoInvoice, discountAmount } = req.body ?? {};
    if (classId) assertClassGenderAllowsStudent(classId, student.gender);
    
    const result = getEnrollmentService(db).enroll({
      studentId,
      branchId: student.branch_id,
      programId,
      programName,
      programVersionId: programVersionId || null,
      levelId: levelId || null,
      semesterName,
      levelCode,
      classId,
      enrollmentType: enrollmentType || 'new',
      skillsFocus: Array.isArray(skillsFocus) ? skillsFocus : null,
      notes,
      actorUserId: user.userId,
      actorName: user.fullName,
      autoInvoice: autoInvoice !== false,
      discountAmount: discountAmount != null ? assertMoney(discountAmount, 'discount amount') : 0,
    });

    writeAudit(req, `Enrollment ${result.enrollmentId} for student ${student.full_name}`);
    res.status(201).json(result);
  })
);

export default journeyRouter;