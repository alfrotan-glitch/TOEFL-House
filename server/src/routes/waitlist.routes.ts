/**
 * TOEFL House ERP — Waitlist Engine
 * ============================================================================
 * Academic Module Refactor — Phase 9.
 *
 * Genuinely new (no Phase 6 policy getter exists for this one, unlike Freeze
 * and Transfer above it in enrollment.routes.ts). The gap this closes: class
 * capacity was already enforced in one place (visitors.routes.ts's convert-
 * to-student flow — "Class is full", a hard 400) but nowhere offered a
 * waitlist as the alternative. This engine is deliberately self-contained:
 * join → (offer) → convert, all explicit staff/registrar actions. No
 * automatic promotion is triggered when a seat frees up elsewhere (a drop,
 * withdrawal, or transfer-out) — see the Phase 9 report (AM-46) for why that
 * is a reasonable, explicitly-scoped-out follow-up rather than an oversight.
 *
 * A note on a road not taken: EnrollmentService.enroll()'s `initialStatus`
 * param was left in Phase 1 with a comment flagging 'pending'/'reserved' as
 * usable "for a future Waitlist Engine phase." This engine deliberately
 * does NOT go that route — 'pending'/'reserved'/'confirmed' model the
 * admissions funnel (applied → seat reserved → payment confirmed → active),
 * and nothing distinguishes "pending because still onboarding" from
 * "queued because the class is full" without adding columns to a
 * heavily-used core table. A dedicated table keeps those two concepts
 * separate and gives the queue its own position/offer/response tracking
 * without overloading `enrollments.status`. See AM-45 in the report.
 *
 * Mounted at /api/classes/:id/waitlist (mergeParams) — mirrors the existing
 * /api/students/:id/journey nested-router pattern (journey.routes.ts).
 * ============================================================================
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource, requestHasAnyRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id as makeId, today } from '../utils/ids.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { countActiveStudentsInClass } from '../core/academic/class-capacity.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';

export const waitlistRouter = Router({ mergeParams: true });
waitlistRouter.use(authenticate);

const enrollmentService = getEnrollmentService(db);

// ── Prepared statements ─────────────────────────────────────────────────────
const stmtGetClassForWaitlist = db.prepare(
  'SELECT id, name, status, branch_id, capacity, program_id, level, level_id FROM classes WHERE id = ?'
);
const stmtGetStudentMinimal = db.prepare('SELECT id, full_name, branch_id, gender FROM students WHERE id = ?');
// Capacity is counted by the single authoritative rule in
// core/academic/class-capacity.ts (enrollments — the same source the classes
// list/merge endpoints and EnrollmentService use). student_semesters is a
// derived projection and is never authoritative for capacity.
const stmtCheckActiveEnrollmentInClass = db.prepare(
  `SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'`
);
const stmtGetNextActivePosition = db.prepare(`
  SELECT COALESCE(MAX(position), 0) + 1 AS position
  FROM class_waitlist
  WHERE class_id = ? AND status IN ('waiting','offered')
`);
const stmtGetActiveWaitlistEntry = db.prepare(
  `SELECT id FROM class_waitlist WHERE class_id = ? AND student_id = ? AND status IN ('waiting','offered')`
);
const stmtInsertWaitlistEntry = db.prepare(
  `INSERT INTO class_waitlist (id, class_id, student_id, branch_id, position, status, notes, requested_by)
   VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`
);
const stmtGetWaitlistEntryById = db.prepare('SELECT * FROM class_waitlist WHERE id = ?');
const stmtListWaitlistForClass = db.prepare('SELECT * FROM class_waitlist WHERE class_id = ? ORDER BY position ASC');
const stmtGetFirstWaitingEntry = db.prepare(`
  SELECT id FROM class_waitlist
  WHERE class_id = ? AND status = 'waiting'
  ORDER BY position ASC, created_at ASC, id ASC
  LIMIT 1
`);
const stmtCountOfferedEntries = db.prepare(`SELECT COUNT(*) AS c FROM class_waitlist WHERE class_id = ? AND status = 'offered'`);
const stmtUpdateWaitlistOffered = db.prepare(
  `UPDATE class_waitlist SET status = 'offered', offered_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'waiting'`
);
const stmtUpdateWaitlistCancelled = db.prepare(
  `UPDATE class_waitlist SET status = 'cancelled', responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('waiting','offered')`
);

function requireClassForWaitlist(req: import('express').Request, classId: string) {
  const row = stmtGetClassForWaitlist.get(classId) as any;
  if (!row) throw new HttpError(404, 'Class not found.');

  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const scopes = req.rbac?.permissions.map((p: { scope: string }) => p.scope) ?? [];
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Class belongs to another branch.');
  }
  return row;
}

function mapWaitlistEntry(row: any) {
  return {
    id: row.id,
    classId: row.class_id,
    studentId: row.student_id,
    position: row.position,
    status: row.status,
    notes: row.notes,
    offeredAt: row.offered_at,
    respondedAt: row.responded_at,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
  };
}

/** POST /api/classes/:id/waitlist — join. Only allowed once the class is
 *  actually full; otherwise the student should just be enrolled directly. */
waitlistRouter.post('/', requirePermission('Waitlist.Manage'), ah(async (req, res) => {
  const classId = req.params.id;
  const cls = requireClassForWaitlist(req, classId);
  const { studentId, notes } = req.body ?? {};
  if (!studentId) throw new HttpError(400, 'studentId is required.');

  const student = stmtGetStudentMinimal.get(studentId) as any;
  if (!student) throw new HttpError(404, 'Student not found.');
  assertClassGenderAllowsStudent(classId, student.gender);

  if (stmtCheckActiveEnrollmentInClass.get(studentId, classId)) {
    throw new HttpError(409, 'This student already has an active enrollment in this class.');
  }

  const activeCount = countActiveStudentsInClass(db, classId);
  if (!(cls.capacity > 0) || activeCount < cls.capacity) {
    throw new HttpError(400, `Class "${cls.name}" has open seats — enroll the student directly instead of joining the waitlist.`);
  }

  if (stmtGetActiveWaitlistEntry.get(classId, studentId)) {
    throw new HttpError(409, 'This student is already on the waitlist for this class.');
  }

  const entryId = makeId('wl');
  const user = req.user;
  const createTx = db.transaction(() => {
    // Offered entries still own their queue positions until converted or
    // cancelled. Counting only waiting rows can reuse an offered position and
    // turn a legitimate join into a storage conflict, so append after the
    // highest currently active position.
    const position = (stmtGetNextActivePosition.get(classId) as { position: number }).position;
    const result = stmtInsertWaitlistEntry.run(entryId, classId, studentId, cls.branch_id, position, notes || null, user?.userId || null);
    if (result.changes !== 1) throw new HttpError(409, 'Waitlist entry could not be created.');
    return position;
  });
  const position = createTx();

  writeAudit(req, `Added ${student.full_name} to waitlist for class "${cls.name}" (position ${position})`);
  res.status(201).json(mapWaitlistEntry(stmtGetWaitlistEntryById.get(entryId)));
}));

/** GET /api/classes/:id/waitlist — list, FIFO order. */
waitlistRouter.get('/', requirePermission('Waitlist.View'), ah(async (req, res) => {
  requireClassForWaitlist(req, req.params.id);
  res.json((stmtListWaitlistForClass.all(req.params.id) as any[]).map(mapWaitlistEntry));
}));

/** POST /api/classes/:id/waitlist/:entryId/offer — mark a seat as offered
 *  to this student (a staff action once a seat has actually opened up). */
waitlistRouter.post('/:entryId/offer', requirePermission('Waitlist.Manage'), authorize('receptionist', 'general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const cls = requireClassForWaitlist(req, req.params.id);
  const entry = stmtGetWaitlistEntryById.get(req.params.entryId) as any;
  if (!entry || entry.class_id !== req.params.id) throw new HttpError(404, 'Waitlist entry not found.');
  if (entry.status !== 'waiting') throw new HttpError(409, `Only a 'waiting' entry can be offered a seat (this one is '${entry.status}').`);

  db.transaction(() => {
    const offeredCount = (stmtCountOfferedEntries.get(cls.id) as { c: number }).c;
    if (!(cls.capacity > 0) || countActiveStudentsInClass(db, cls.id) + offeredCount >= cls.capacity) {
      throw new HttpError(409, `Class "${cls.name}" has no open seat to offer.`);
    }
    const first = stmtGetFirstWaitingEntry.get(cls.id) as { id: string } | undefined;
    if (!first || first.id !== entry.id) throw new HttpError(409, 'An earlier waiting entry must be offered first.');
    const offered = stmtUpdateWaitlistOffered.run(entry.id);
    if (offered.changes !== 1) throw new HttpError(409, 'This waitlist entry changed concurrently; reload and try again.');
  })();
  writeAudit(req, `Offered a seat to waitlist entry ${entry.id} for class ${req.params.id}`);
  res.json(mapWaitlistEntry(stmtGetWaitlistEntryById.get(entry.id)));
}));

/** POST /api/classes/:id/waitlist/:entryId/convert — turn a waitlist entry
 *  into a real active enrollment. Re-checks capacity and gender policy at
 *  conversion time (seats may have changed since offer()), then keeps
 *  `enrollments` and `student_semesters` in sync the same way the rest of
 *  this codebase's "add an existing student to a class" paths do
 *  (students.routes.ts's extra-enrollment endpoint; EnrollmentService's
 *  transfer()/resume()), including seeding rosters for future sessions so
 *  the student shows up on the attendance sheet immediately. */
waitlistRouter.post('/:entryId/convert', requirePermission('Waitlist.Manage'), authorize('receptionist', 'general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const classId = req.params.id;
  const cls = requireClassForWaitlist(req, classId);
  const entry = stmtGetWaitlistEntryById.get(req.params.entryId) as any;
  if (!entry || entry.class_id !== classId) throw new HttpError(404, 'Waitlist entry not found.');
  if (entry.status !== 'waiting' && entry.status !== 'offered') {
    throw new HttpError(409, `Only a 'waiting' or 'offered' entry can be converted (this one is '${entry.status}').`);
  }

  const student = stmtGetStudentMinimal.get(entry.student_id) as any;
  if (!student) throw new HttpError(404, 'Student not found.');
  assertClassGenderAllowsStudent(classId, student.gender);

  const activeCount = countActiveStudentsInClass(db, classId);
  if (cls.capacity > 0 && activeCount >= cls.capacity) {
    throw new HttpError(409, `Class "${cls.name}" is still full — no seat is actually available to convert into.`);
  }

  const user = req.user;
  const run = db.transaction(() => {
    if (entry.status === 'waiting') {
      const first = stmtGetFirstWaitingEntry.get(classId) as { id: string } | undefined;
      const offeredCount = (stmtCountOfferedEntries.get(classId) as { c: number }).c;
      if (!first || first.id !== entry.id || offeredCount > 0) {
        throw new HttpError(409, 'An earlier offered or waiting entry must be processed first.');
      }
    }
    const activeEntryUpdate = db.prepare(`UPDATE class_waitlist SET status = 'converted', responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('waiting','offered')`).run(entry.id);
    if (activeEntryUpdate.changes !== 1) throw new HttpError(409, 'This waitlist entry was already processed by another request.');
    const lockedActiveCount = countActiveStudentsInClass(db, classId);
    if (cls.capacity > 0 && lockedActiveCount >= cls.capacity) throw new HttpError(409, `Class "${cls.name}" is full.`);
    return enrollmentService.enroll({
      studentId: entry.student_id,
      branchId: cls.branch_id,
      classId,
      semesterName: cls.name || 'Current Semester',
      enrollmentType: 'new',
      startedAt: today(),
      notes: `Converted from class waitlist (entry ${entry.id})`,
      actorUserId: user?.userId,
      actorName: user?.fullName,
    });
  });
  const result = run();

  writeAudit(req, `Converted waitlist entry ${entry.id} (${student.full_name}) into an enrollment in class "${cls.name}"`);
  res.status(201).json({ ok: true, enrollmentId: result.enrollmentId, waitlistEntry: mapWaitlistEntry(stmtGetWaitlistEntryById.get(entry.id)) });
}));

/** POST /api/classes/:id/waitlist/:entryId/cancel — student/staff withdraws
 *  from the waitlist without ever taking a seat. */
waitlistRouter.post('/:entryId/cancel', requirePermission('Waitlist.Manage'), ah(async (req, res) => {
  requireClassForWaitlist(req, req.params.id);
  const entry = stmtGetWaitlistEntryById.get(req.params.entryId) as any;
  if (!entry || entry.class_id !== req.params.id) throw new HttpError(404, 'Waitlist entry not found.');
  if (entry.status !== 'waiting' && entry.status !== 'offered') {
    throw new HttpError(409, `Only a 'waiting' or 'offered' entry can be cancelled (this one is '${entry.status}').`);
  }
  // Staff (resolved through canonical RBAC roles, not the mutable
  // canonical role assignment) may cancel any entry; anyone else may only cancel
  // their own request.
  if (!req.user || !requestHasAnyRole(req, ['owner', 'general_manager', 'receptionist', 'head_of_department'])) {
    if (entry.requested_by !== req.user?.userId) throw new HttpError(403, 'You may only cancel your own waitlist request.');
  }

  const cancelled = stmtUpdateWaitlistCancelled.run(entry.id);
  if (cancelled.changes !== 1) throw new HttpError(409, 'This waitlist entry changed concurrently; reload and try again.');
  writeAudit(req, `Cancelled waitlist entry ${entry.id} for class ${req.params.id}`);
  res.json(mapWaitlistEntry(stmtGetWaitlistEntryById.get(entry.id)));
}));

export default waitlistRouter;
