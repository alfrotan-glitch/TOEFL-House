/**
 * TOEFL House ERP — Enrollment Lifecycle Routes
 * ============================================================================
 * Academic Module Refactor — Phase 1.
 *
 * Dedicated, enrollment-id-scoped transition endpoints for the Enrollment
 * Lifecycle Engine (core/academic/enrollment-service.ts +
 * core/academic/lifecycle-engine.ts). This is additive: the existing
 * student-scoped `/students/:id/transfer|suspend|resume` endpoints are
 * untouched and continue to work exactly as before — they call the same
 * EnrollmentService underneath.
 * ============================================================================
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id as makeId, today } from '../utils/ids.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { getFreezePolicy, getTransferPolicy } from '../core/academic/academic-policy-service.js';

export const enrollmentRouter = Router();
enrollmentRouter.use(authenticate);

const enrollments = getEnrollmentService(db);

/** Whole days between two YYYY-MM-DD (or ISO) date strings — same
 *  Math.floor(ms/86400000) pattern already used for the Make-up Policy
 *  window check (classes.routes.ts), reused here for both Freeze duration
 *  and Transfer's minDaysBeforeAutoApprove. */
function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function requireEnrollment(req: import('express').Request, enrollmentId: string) {
  const row = enrollments.getById(enrollmentId);
  if (!row) throw new HttpError(404, 'Enrollment not found.');

  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const scopes = req.rbac?.permissions.map((p: { scope: string }) => p.scope) ?? [];
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Enrollment belongs to another branch.');
  }
  return row;
}

function mapEnrollment(row: any) {
  return {
    id: row.id,
    studentId: row.student_id,
    classId: row.class_id,
    branchId: row.branch_id,
    programName: row.program_name,
    semesterName: row.semester_name,
    levelCode: row.level_code,
    enrollmentType: row.enrollment_type,
    status: row.status,
    holdReason: row.hold_reason ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

enrollmentRouter.get('/:id', requirePermission('Student.View'), ah(async (req, res) => {
  res.json(mapEnrollment(requireEnrollment(req, req.params.id)));
}));

/**
 * Every transition endpoint below shares the same shape: validate branch
 * scope, delegate to the named EnrollmentService method (which itself
 * validates the state transition via ENROLLMENT_TRANSITIONS and throws a
 * 409 HttpError for anything illegal), audit, respond.
 */
function registerTransition(
  path: string,
  requiresReason: boolean,
  method: (svc: ReturnType<typeof getEnrollmentService>, enrollmentId: string, opts: { reason?: string; actorUserId?: string; actorName?: string }) => unknown,
  auditVerb: string,
) {
  enrollmentRouter.post(`/:id${path}`, authorize('receptionist', 'general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
    requireEnrollment(req, req.params.id); // 404 / branch-scope check up front
    const reason = req.body?.reason ?? undefined;
    if (requiresReason && !reason) throw new HttpError(400, 'A reason is required for this transition.');
    const user = req.user;
    const result = method(enrollments, req.params.id, { reason, actorUserId: user?.userId, actorName: user?.fullName });
    writeAudit(req, `${auditVerb} enrollment ${req.params.id}${reason ? ` (${reason})` : ''}`);
    res.json({ ok: true, enrollment: mapEnrollment(enrollments.getById(req.params.id)), ...(result as object) });
  }));
}

registerTransition('/reserve', false, (s, id, o) => s.reserve(id, o), 'Reserved');
registerTransition('/confirm', false, (s, id, o) => s.confirm(id, o), 'Confirmed');
registerTransition('/activate', false, (s, id, o) => s.activate(id, o), 'Activated');
registerTransition('/freeze', true, (s, id, o) => s.freeze(id, o as { reason: string }), 'Froze');
registerTransition('/unfreeze', false, (s, id, o) => s.unfreeze(id, o), 'Unfroze');
registerTransition('/drop', true, (s, id, o) => s.drop(id, o as { reason: string }), 'Dropped');
registerTransition('/withdraw', true, (s, id, o) => s.withdraw(id, o as { reason: string }), 'Withdrew');
registerTransition('/complete', false, (s, id, o) => s.complete(id, o), 'Completed');
registerTransition('/graduate', false, (s, id, o) => s.graduate(id, o), 'Graduated');
registerTransition('/mark-retake', false, (s, id, o) => s.markRetake(id, o), 'Marked retake for');
registerTransition('/mark-conditional-pass', false, (s, id, o) => s.markConditionalPass(id, o), 'Marked conditional pass for');

// ============================================================================
// Phase 9 — Freeze Engine
// ============================================================================
// Wraps enrollments.freeze()/unfreeze() (Phase 1) with duration tracking and
// FreezePolicy enforcement (Phase 6). No manual approval queue — see the
// Phase 9 report (AM-43) for why a request that clears both caps is
// recorded as approved immediately rather than left pending, unlike
// Transfer below. approved_by is still populated (system-approved), so
// every freeze still carries a genuine approval record.

const stmtInsertFreeze = db.prepare(
  `INSERT INTO enrollment_freezes (id, enrollment_id, student_id, branch_id, reason, start_date, planned_end_date, status, requested_by, approved_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
);
const stmtGetActiveFreezeForEnrollment = db.prepare(
  `SELECT * FROM enrollment_freezes WHERE enrollment_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
);
const stmtCountFreezesForEnrollment = db.prepare(`SELECT COUNT(*) as c FROM enrollment_freezes WHERE enrollment_id = ?`);
const stmtCompleteFreeze = db.prepare(
  `UPDATE enrollment_freezes SET status = 'completed', actual_end_date = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtListFreezesForEnrollment = db.prepare(`SELECT * FROM enrollment_freezes WHERE enrollment_id = ? ORDER BY created_at DESC`);

function mapFreeze(row: any) {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    studentId: row.student_id,
    reason: row.reason,
    startDate: row.start_date,
    plannedEndDate: row.planned_end_date,
    actualEndDate: row.actual_end_date,
    status: row.status,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
  };
}

/** POST /api/enrollments/:id/freeze-requests — request (and, if within
 *  policy, immediately activate) a freeze with a tracked duration. */
enrollmentRouter.post('/:id/freeze-requests', requirePermission('Enrollment.FreezeRequest'), ah(async (req, res) => {
  const enrollment = requireEnrollment(req, req.params.id);
  const { reason, days } = req.body ?? {};
  if (!reason) throw new HttpError(400, 'A reason is required to request a freeze.');
  const numDays = Number(days);
  if (!Number.isInteger(numDays) || numDays <= 0) throw new HttpError(400, 'days must be a positive whole number.');

  const policy = getFreezePolicy(enrollment.branch_id, { programId: enrollment.program_id, classId: enrollment.class_id });
  if (numDays > policy.maxFreezeDurationDays) {
    throw new HttpError(400, `Requested freeze of ${numDays} day(s) exceeds the policy maximum of ${policy.maxFreezeDurationDays} day(s).`);
  }
  const priorFreezes = (stmtCountFreezesForEnrollment.get(req.params.id) as { c: number }).c;
  if (priorFreezes >= policy.maxFreezesPerEnrollment) {
    throw new HttpError(409, `This enrollment has already used its policy limit of ${policy.maxFreezesPerEnrollment} freeze(s).`);
  }

  const user = req.user;
  // freeze() validates the transition itself (409 if not currently freezable)
  // and writes the enrollments.status change + enrollment_events row exactly
  // as the existing bare /:id/freeze endpoint always has.
  enrollments.freeze(req.params.id, { reason, actorUserId: user?.userId, actorName: user?.fullName });

  const startDate = today();
  const plannedEndDate = addDays(startDate, numDays);
  const freezeId = makeId('efz');
  stmtInsertFreeze.run(freezeId, req.params.id, enrollment.student_id, enrollment.branch_id, reason, startDate, plannedEndDate, user?.userId || null, user?.userId || null);

  writeAudit(req, `Froze enrollment ${req.params.id} for ${numDays} day(s) until ${plannedEndDate} (${reason})`);
  res.status(201).json({ ok: true, freeze: mapFreeze(stmtGetActiveFreezeForEnrollment.get(req.params.id)), enrollment: mapEnrollment(enrollments.getById(req.params.id)) });
}));

/** POST /api/enrollments/:id/freeze-requests/resume — ends the current
 *  active freeze (whenever it happens to be, early or on schedule) and
 *  resumes the enrollment via the existing unfreeze() transition. */
enrollmentRouter.post('/:id/freeze-requests/resume', requirePermission('Enrollment.FreezeRequest'), ah(async (req, res) => {
  requireEnrollment(req, req.params.id);
  const active = stmtGetActiveFreezeForEnrollment.get(req.params.id) as any;
  if (!active) throw new HttpError(404, 'No active freeze to resume from.');

  const user = req.user;
  const reason = req.body?.reason ?? undefined;
  enrollments.unfreeze(req.params.id, { reason, actorUserId: user?.userId, actorName: user?.fullName });
  stmtCompleteFreeze.run(today(), active.id);

  writeAudit(req, `Resumed enrollment ${req.params.id} from freeze ${active.id}`);
  res.json({ ok: true, enrollment: mapEnrollment(enrollments.getById(req.params.id)) });
}));

/** GET /api/enrollments/:id/freeze-requests — full freeze history, the
 *  "why and for how long" record the blueprint asks for. */
enrollmentRouter.get('/:id/freeze-requests', requirePermission('Student.View', 'Enrollment.FreezeRequest', 'Enrollment.TransferRequest'), ah(async (req, res) => {
  requireEnrollment(req, req.params.id);
  res.json((stmtListFreezesForEnrollment.all(req.params.id) as any[]).map(mapFreeze));
}));

// ============================================================================
// Phase 9 — Transfer Engine
// ============================================================================
// Wraps enrollments.transfer() (Phase 1) with TransferPolicy's approval-
// timing gate (Phase 6): a request from a student enrolled at least
// minDaysBeforeAutoApprove days executes immediately; a newer enrollment's
// request is stored 'pending' and needs an explicit approve()/reject().

const stmtGetClassMinimalForTransfer = db.prepare('SELECT id, name, status, branch_id FROM classes WHERE id = ?');
const stmtInsertTransferRequest = db.prepare(
  `INSERT INTO enrollment_transfer_requests (id, enrollment_id, student_id, from_class_id, to_class_id, branch_id, reason, status, new_enrollment_id, requested_by, approved_by, decision_notes)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetTransferRequestById = db.prepare('SELECT * FROM enrollment_transfer_requests WHERE id = ?');
const stmtListTransferRequestsForEnrollment = db.prepare('SELECT * FROM enrollment_transfer_requests WHERE enrollment_id = ? ORDER BY created_at DESC');
const stmtUpdateTransferRequestApproved = db.prepare(
  `UPDATE enrollment_transfer_requests SET status = 'approved', approved_by = ?, new_enrollment_id = ?, decision_notes = ?, updated_at = datetime('now') WHERE id = ?`
);
const stmtUpdateTransferRequestRejected = db.prepare(
  `UPDATE enrollment_transfer_requests SET status = 'rejected', approved_by = ?, decision_notes = ?, updated_at = datetime('now') WHERE id = ?`
);

function mapTransferRequest(row: any) {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    studentId: row.student_id,
    fromClassId: row.from_class_id,
    toClassId: row.to_class_id,
    reason: row.reason,
    status: row.status,
    newEnrollmentId: row.new_enrollment_id,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    decisionNotes: row.decision_notes,
    createdAt: row.created_at,
  };
}

/** POST /api/enrollments/:id/transfer-requests — request a transfer to
 *  another class. Auto-approves and executes immediately once the
 *  student's tenure clears TransferPolicy.minDaysBeforeAutoApprove;
 *  otherwise the request waits as 'pending' for approve()/reject(). */
enrollmentRouter.post('/:id/transfer-requests', requirePermission('Enrollment.TransferRequest'), ah(async (req, res) => {
  const enrollment = requireEnrollment(req, req.params.id);
  const { toClassId, reason } = req.body ?? {};
  if (!toClassId || !reason) throw new HttpError(400, 'toClassId and reason are required.');
  if (enrollment.class_id === toClassId) throw new HttpError(400, 'Student is already in this class.');

  const toClass = stmtGetClassMinimalForTransfer.get(toClassId) as any;
  if (!toClass) throw new HttpError(404, 'Target class not found.');
  if (!canAccessBranchResource(req, toClass.branch_id)) throw new HttpError(403, 'Target class is outside your authorized branch scope.');
  if (toClass.status && toClass.status !== 'active') throw new HttpError(400, 'Target class is not active.');

  const policy = getTransferPolicy(enrollment.branch_id, { programId: enrollment.program_id, classId: enrollment.class_id });
  const daysEnrolled = daysBetween(today(), enrollment.started_at);
  const user = req.user;
  const requestId = makeId('etr');

  if (daysEnrolled >= policy.minDaysBeforeAutoApprove) {
    const result = enrollments.transfer({ studentId: enrollment.student_id, toClassId, notes: reason, actorUserId: user?.userId });
    stmtInsertTransferRequest.run(
      requestId, req.params.id, enrollment.student_id, enrollment.class_id, toClassId, enrollment.branch_id,
      reason, 'approved', result.enrollmentId, user?.userId || null, user?.userId || null, 'Auto-approved: tenure meets policy threshold.',
    );
    writeAudit(req, `Auto-approved transfer of enrollment ${req.params.id} to class ${toClassId} (${reason})`);
    res.status(201).json({ ok: true, transferRequest: mapTransferRequest(stmtGetTransferRequestById.get(requestId)) });
  } else {
    stmtInsertTransferRequest.run(
      requestId, req.params.id, enrollment.student_id, enrollment.class_id, toClassId, enrollment.branch_id,
      reason, 'pending', null, user?.userId || null, null, null,
    );
    writeAudit(req, `Requested transfer of enrollment ${req.params.id} to class ${toClassId}, pending approval (${reason})`);
    res.status(201).json({ ok: true, transferRequest: mapTransferRequest(stmtGetTransferRequestById.get(requestId)) });
  }
}));

/** POST /api/enrollments/:id/transfer-requests/:requestId/approve —
 *  manually approves and executes a pending transfer request. */
enrollmentRouter.post('/:id/transfer-requests/:requestId/approve', authorize('general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  requireEnrollment(req, req.params.id);
  const reqRow = stmtGetTransferRequestById.get(req.params.requestId) as any;
  if (!reqRow || reqRow.enrollment_id !== req.params.id) throw new HttpError(404, 'Transfer request not found.');
  if (reqRow.status !== 'pending') throw new HttpError(409, `Only a pending transfer request can be approved (this one is '${reqRow.status}').`);

  const user = req.user;
  const result = enrollments.transfer({ studentId: reqRow.student_id, toClassId: reqRow.to_class_id, notes: reqRow.reason, actorUserId: user?.userId });
  stmtUpdateTransferRequestApproved.run(user?.userId || null, result.enrollmentId, req.body?.notes || null, req.params.requestId);

  writeAudit(req, `Approved transfer request ${req.params.requestId} for enrollment ${req.params.id}`);
  res.json({ ok: true, transferRequest: mapTransferRequest(stmtGetTransferRequestById.get(req.params.requestId)) });
}));

/** POST /api/enrollments/:id/transfer-requests/:requestId/reject —
 *  rejects a pending transfer request without touching the enrollment. */
enrollmentRouter.post('/:id/transfer-requests/:requestId/reject', authorize('general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  requireEnrollment(req, req.params.id);
  const reqRow = stmtGetTransferRequestById.get(req.params.requestId) as any;
  if (!reqRow || reqRow.enrollment_id !== req.params.id) throw new HttpError(404, 'Transfer request not found.');
  if (reqRow.status !== 'pending') throw new HttpError(409, `Only a pending transfer request can be rejected (this one is '${reqRow.status}').`);

  const user = req.user;
  stmtUpdateTransferRequestRejected.run(user?.userId || null, req.body?.notes || null, req.params.requestId);

  writeAudit(req, `Rejected transfer request ${req.params.requestId} for enrollment ${req.params.id}`);
  res.json({ ok: true, transferRequest: mapTransferRequest(stmtGetTransferRequestById.get(req.params.requestId)) });
}));

/** GET /api/enrollments/:id/transfer-requests — full transfer request history. */
enrollmentRouter.get('/:id/transfer-requests', requirePermission('Student.View', 'Enrollment.FreezeRequest', 'Enrollment.TransferRequest'), ah(async (req, res) => {
  requireEnrollment(req, req.params.id);
  res.json((stmtListTransferRequestsForEnrollment.all(req.params.id) as any[]).map(mapTransferRequest));
}));

export default enrollmentRouter;
