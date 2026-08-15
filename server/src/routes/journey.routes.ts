import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, canAccessBranchResource } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { writeAudit } from '../middleware/audit.js';

export const journeyRouter = Router({ mergeParams: true });
journeyRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetStudentCore = db.prepare('SELECT id, full_name, branch_id, status, gender FROM students WHERE id = ?');
const stmtUpdateStudentStatus = db.prepare('UPDATE students SET status = ? WHERE id = ?');
const stmtGraduateStudent = db.prepare("UPDATE students SET status = 'graduated' WHERE id = ?");

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

    // Profile status mirror (not source of truth — journey is)
    if (eventType === JourneyEventType.STATUS_CHANGED && payload?.status) {
      const st = String(payload.status);
      if (['active', 'inactive', 'graduated', 'suspended'].includes(st)) {
        stmtUpdateStudentStatus.run(st, studentId);
      }
    }
    if (eventType === JourneyEventType.GRADUATED) {
      stmtGraduateStudent.run(studentId);
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
      discountAmount: discountAmount != null ? Number(discountAmount) : 0,
    });

    writeAudit(req, `Enrollment ${result.enrollmentId} for student ${student.full_name}`);
    res.status(201).json(result);
  })
);

export default journeyRouter;