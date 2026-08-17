import { Router } from 'express';
import { db } from '../db/connection.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { assertClassAccess, isClassTeacherScoped } from '../core/rbac/abac.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney } from '../utils/money.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import { CLASS_TRANSITIONS, deriveLegacyClassStatus, type ClassStage, type GradeLockStage } from '../core/academic/lifecycle-engine.js';
import { getGradeLockService } from '../core/academic/grade-lock-service.js';

const gradeLockService = getGradeLockService(db);
import { computeClassGrades, hasGradeChanged, type GradeSnapshot } from '../core/academic/gradebook-service.js';
import {
  resolvePromotionCriteria, computeAttendancePercentage, hasFinancialHold, findFailedMandatorySkills, decidePromotion,
} from '../core/academic/promotion-engine.js';
import { getRetakePolicy, countPriorRetakes, getMakeupPolicy, getFullPolicyProfile } from '../core/academic/academic-policy-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import type { UserRole } from '../utils/auth.js';
import { ACADEMIC_DEFAULTS } from '../core/configuration/policy-catalog.js';

const enrollmentServiceForPromotion = getEnrollmentService(db);

const classLifecycle = getClassLifecycleService(db);

export const ATTENDANCE_PAGE_SIZE = 2000;
const ATTENDANCE_MAX_PAGE_SIZE = 5000;

const classesRouter = Router();
classesRouter.use(authenticate);

// ── Type Definitions for DB Rows ───────────────────────────────────────────
interface ClassRow {
  id: string; name: string; teacher_id: string | null; program_id: string | null;
  level_id: string | null; level: string; capacity: number; schedule_time: string | null;
  start_date: string | null; end_date: string | null; status: string; fee: number;
  min_viable_size: number; branch_id: string; room_id: string | null;
  time_slot_id: string | null; academic_term_id: string | null;
  activation_date: string | null; gender_policy: string | null;
  merged_into_id?: string | null; notes?: string | null;
  enrolled_count?: number;
  lifecycle_stage: ClassStage;
  cancellation_reason?: string | null;
  offering_id?: string | null;
}

interface AssessmentRow {
  id: string; class_id: string; title: string; type: string;
  weight: number; max_score: number; date: string | null;
  passing_score: number | null; publish_date: string | null; due_date: string | null;
  visibility: string; rubric: string | null; allows_makeup: number; makeup_for_assessment_id: string | null;
  lock_status: GradeLockStage; lock_status_updated_at?: string | null;
  created_at?: string;
}

interface GradeRow {
  id: string; assessment_id: string; student_id: string; class_id: string;
  score: number | null; status: string; notes: string | null;
  graded_by: string | null; graded_at: string | null;
}

interface RosterRow {
  id: string; full_name: string; student_code: string; semester_id: string;
}

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetClassById = db.prepare('SELECT * FROM classes WHERE id = ?');

const stmtGetAllClasses = db.prepare(`
  SELECT c.*, (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.class_id = c.id AND e.status IN ('active','confirmed','pending')) as enrolled_count
  FROM classes c ORDER BY c.start_date DESC
`);
const stmtGetClassesByBranch = db.prepare(`
  SELECT c.*, (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.class_id = c.id AND e.status IN ('active','confirmed','pending')) as enrolled_count
  FROM classes c WHERE c.branch_id = ? ORDER BY c.start_date DESC
`);

const stmtCountStrictActiveEnrolled = db.prepare(
  `SELECT COUNT(DISTINCT student_id) as c FROM enrollments WHERE class_id = ? AND status IN ('active','confirmed','pending')`
);

const stmtCountClassSessions = db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE class_id = ?`);
const stmtCountClassAssessments = db.prepare(`SELECT COUNT(*) as c FROM class_assessments WHERE class_id = ?`);
const stmtGetTeacherConflicts = db.prepare(`
  SELECT id, name FROM classes
  WHERE branch_id = ? AND teacher_id = ? AND id != ?
    AND lifecycle_stage NOT IN ('cancelled','completed','archived')
    AND COALESCE(start_date, '1900-01-01') <= COALESCE(?, '9999-12-31')
    AND COALESCE(end_date, '9999-12-31') >= COALESCE(?, '1900-01-01')
    AND (time_slot_id = ? OR (? IS NULL AND schedule_time = ?))
`);
const stmtGetRoomConflicts = db.prepare(`
  SELECT id, name FROM classes
  WHERE branch_id = ? AND room_id = ? AND id != ?
    AND lifecycle_stage NOT IN ('cancelled','completed','archived')
    AND COALESCE(start_date, '1900-01-01') <= COALESCE(?, '9999-12-31')
    AND COALESCE(end_date, '9999-12-31') >= COALESCE(?, '1900-01-01')
    AND (time_slot_id = ? OR (? IS NULL AND schedule_time = ?))
`);
const stmtGetSlotConflicts = db.prepare(`
  SELECT id, name FROM classes
  WHERE branch_id = ? AND time_slot_id = ? AND id != ?
    AND lifecycle_stage NOT IN ('cancelled','completed','archived')
    AND COALESCE(start_date, '1900-01-01') <= COALESCE(?, '9999-12-31')
    AND COALESCE(end_date, '9999-12-31') >= COALESCE(?, '1900-01-01')
    AND room_id = ?
`);

const stmtGetLevelById = db.prepare('SELECT * FROM levels WHERE id = ?');
const stmtGetLevelFee = db.prepare('SELECT fee FROM level_branch_fees WHERE level_id = ? AND branch_id = ?');
const stmtGetTimeSlot = db.prepare('SELECT * FROM time_slots WHERE id = ? AND is_active = 1');
const stmtGetRoom = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_active = 1');

const stmtInsertClass = db.prepare(
  `INSERT INTO classes (
     id, name, teacher_id, program_id, level_id, level, capacity, schedule_time,
     start_date, end_date, status, lifecycle_stage, fee, min_viable_size, branch_id,
     room_id, time_slot_id, academic_term_id, activation_date, gender_policy
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
// NOTE: `status` is intentionally excluded from this statement's SET list.
// It is a derived projection of lifecycle_stage (see lifecycle-engine.ts)
// and must only ever be written by ClassLifecycleService, or the two
// columns can drift. Use the /:id/schedule, /:id/activate, /:id/cancel,
// etc. endpoints below to change lifecycle state.
const stmtUpdateClass = db.prepare(
  `UPDATE classes SET name=?, teacher_id=?, level=?, capacity=?, schedule_time=?, start_date=?, end_date=?, fee=?, min_viable_size=? WHERE id=?`
);
const stmtUpdateClassGender = db.prepare('UPDATE classes SET gender_policy = ? WHERE id = ?');

const stmtDeleteClassTeacherSkills = db.prepare('DELETE FROM class_teacher_skills WHERE class_id = ?');
const stmtDeleteSessionsForClass = db.prepare('DELETE FROM sessions WHERE class_id = ?');
const stmtDeleteClass = db.prepare('DELETE FROM classes WHERE id = ?');

const stmtUpdateSemestersMerge = db.prepare(
  `UPDATE student_semesters SET class_id = ? WHERE class_id = ? AND status = 'active'`
);
const stmtUpdateEnrollmentsMerge = db.prepare(
  `UPDATE enrollments SET class_id = ? WHERE class_id = ? AND status = 'active'`
);
const stmtDeleteFutureSourceRosters = db.prepare(`DELETE FROM rosters WHERE student_id IN (SELECT student_id FROM enrollments WHERE class_id = ?) AND session_id IN (SELECT id FROM sessions WHERE class_id = ? AND date >= date('now') AND status != 'cancelled')`);
const stmtGetFutureTargetSessions = db.prepare(`SELECT id FROM sessions WHERE class_id = ? AND date >= date('now') AND status != 'cancelled'`);
const stmtGetSourceActiveStudents = db.prepare(`SELECT DISTINCT student_id FROM enrollments WHERE class_id = ? AND status = 'active'`);
const stmtInsertMergeRoster = db.prepare(`INSERT OR IGNORE INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, ?, ?, 'not_marked')`);
// Cancellation itself (lifecycle_stage/status/cancellation_reason) goes
// through classLifecycle.cancel() so it's validated and audited the same
// way as every other transition; this statement only records the merge
// linkage, which is merge-specific and has no place in the lifecycle engine.
const stmtLinkMergedClass = db.prepare(
  `UPDATE classes SET merged_into_id = ?, notes = ? WHERE id = ?`
);

const stmtGetMergeCandidatesByLevelId = db.prepare(`
  SELECT c.*, (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.class_id = c.id AND e.status IN ('active','confirmed','pending')) as enrolled_count
  FROM classes c WHERE c.branch_id = ? AND c.status = 'active' AND c.id != ? AND c.level_id = ?
`);
const stmtGetMergeCandidatesByLevelName = db.prepare(`
  SELECT c.*, (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e WHERE e.class_id = c.id AND e.status IN ('active','confirmed','pending')) as enrolled_count
  FROM classes c WHERE c.branch_id = ? AND c.status = 'active' AND c.id != ? AND c.level = ?
`);

const stmtGetClassGenderAndName = db.prepare('SELECT gender_policy, name FROM classes WHERE id = ?');

// Gradebook & Assessment Statements (LMS Core) — Assessment Engine (Phase 3)
const ASSESSMENT_TYPES = [
  'midterm', 'final', 'assignment', 'attendance', 'participation',
  'quiz', 'homework', 'speaking', 'listening', 'reading', 'writing',
  'practice_test', 'makeup_exam',
] as const;

const stmtInsertAssessment = db.prepare(
  `INSERT INTO class_assessments (id, class_id, title, type, weight, max_score, date, passing_score, publish_date, due_date, visibility, rubric, allows_makeup, makeup_for_assessment_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateAssessment = db.prepare(
  `UPDATE class_assessments SET title = ?, weight = ?, max_score = ?, date = ?, passing_score = ?, publish_date = ?, due_date = ?, visibility = ?, rubric = ?, allows_makeup = ? WHERE id = ?`
);
const stmtDeleteAssessment = db.prepare('DELETE FROM class_assessments WHERE id = ?');
const stmtGetAssessmentById = db.prepare('SELECT * FROM class_assessments WHERE id = ? AND class_id = ?');
const stmtGetAssessments = db.prepare(`SELECT * FROM class_assessments WHERE class_id = ?`);
const stmtHasGradesForAssessment = db.prepare(`SELECT COUNT(*) AS c FROM student_grades WHERE assessment_id = ? AND status = 'graded'`);

function mapAssessment(a: AssessmentRow) {
  return {
    id: a.id, title: a.title, type: a.type, weight: a.weight, maxScore: a.max_score, date: a.date,
    passingScore: a.passing_score, publishDate: a.publish_date, dueDate: a.due_date,
    visibility: a.visibility, rubric: a.rubric, allowsMakeup: Boolean(a.allows_makeup),
    makeupForAssessmentId: a.makeup_for_assessment_id,
    lockStatus: a.lock_status, lockStatusUpdatedAt: a.lock_status_updated_at ?? null,
  };
}
const stmtUpsertGrade = db.prepare(
  `INSERT INTO student_grades (id, assessment_id, student_id, class_id, score, status, notes, graded_by) 
   VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
   ON CONFLICT(assessment_id, student_id) 
   DO UPDATE SET score = excluded.score, status = excluded.status, notes = COALESCE(excluded.notes, notes), graded_by = excluded.graded_by, graded_at = datetime('now')`
);
const stmtGetGradesByClass = db.prepare(`SELECT * FROM student_grades WHERE class_id = ?`);
const stmtGetExistingGrade = db.prepare(`SELECT score, status, notes FROM student_grades WHERE assessment_id = ? AND student_id = ?`);
const stmtInsertGradeHistory = db.prepare(
  `INSERT INTO grade_history (id, grade_id, assessment_id, student_id, class_id, previous_score, previous_status, previous_notes, new_score, new_status, new_notes, changed_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetGradeHistory = db.prepare(`SELECT * FROM grade_history WHERE class_id = ? ORDER BY changed_at DESC LIMIT ?`);
const stmtGetGradeHistoryForStudent = db.prepare(`SELECT * FROM grade_history WHERE class_id = ? AND student_id = ? ORDER BY changed_at DESC LIMIT ?`);
const stmtGetSavedGradeIdAndNotes = db.prepare('SELECT id, notes FROM student_grades WHERE assessment_id = ? AND student_id = ?');
const stmtUpdateSemesterFinalGrade = db.prepare(`UPDATE student_semesters SET status = ?, final_score = ?, final_percentage = ?, letter_grade = ? WHERE id = ?`);
const stmtGetActiveEnrollmentForClass = db.prepare(`SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'`);
const stmtGetClassRoster = db.prepare(`
  SELECT s.id, s.full_name, s.student_code, ss.id as semester_id 
  FROM students s JOIN student_semesters ss ON s.id = ss.student_id 
  WHERE ss.class_id = ? AND ss.status = 'active'
`);

// Legacy Attendance Statements
const stmtInsertAttendance = db.prepare(
  `INSERT INTO attendance (id, date, target_id, target_type, status, class_id, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// Clean mapping function
function mapClass(row: ClassRow) {
  if (!row) return row;
  return {
    id: row.id,
    name: row.name,
    teacherId: row.teacher_id,
    programId: row.program_id,
    levelId: row.level_id,
    level: row.level,
    capacity: row.capacity,
    minViableSize: row.min_viable_size,
    scheduleTime: row.schedule_time,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    fee: row.fee,
    branchId: row.branch_id,
    roomId: row.room_id,
    timeSlotId: row.time_slot_id,
    academicTermId: row.academic_term_id,
    activationDate: row.activation_date,
    genderPolicy: row.gender_policy || 'mixed',
    enrolled: row.enrolled_count || 0,
    lifecycleStage: row.lifecycle_stage,
    cancellationReason: row.cancellation_reason ?? null,
  };
}

function requireClass(req: import('express').Request, classId: string): ClassRow {
  const row = stmtGetClassById.get(classId) as ClassRow | undefined;
  if (!row) throw new HttpError(404, 'Class not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const user = req.user;
    if (!user) throw new HttpError(401, 'Not authenticated');
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Class belongs to another branch.');
  }

  // A branch check is not sufficient for a teacher. Colleagues share a branch,
  // so branch-only authorization let one teacher read AND overwrite another
  // teacher's gradebook (proven live: a linked teacher user PUT a score of 99
  // into a class taught by someone else, and the row persisted). Sessions
  // already enforce ownership via assertCanMarkSession; classes must match.
  if (isClassTeacherScoped(req)) assertClassAccess(req, classId);

  return row;
}

/**
 * @deprecated Legacy attendance router — kept for backward compatibility only.
 */
export const attendanceRouter = Router();
attendanceRouter.use(authenticate);

// ============================================================================
// §1 — CLASSES CRUD
// ============================================================================

function assertClassPlanningConstraints(args: {
  classId?: string;
  branchId: string;
  teacherId?: string | null;
  roomId?: string | null;
  timeSlotId?: string | null;
  scheduleTime?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  capacity?: number | null;
  minViableSize?: number | null;
}) {
  const start = args.startDate || null;
  const end = args.endDate || null;
  if (start && end && start > end) throw new HttpError(400, 'Class start date cannot be after end date.');
  const capacity = Number(args.capacity ?? 0);
  const minViable = Number(args.minViableSize ?? 0);
  if (!Number.isFinite(capacity) || capacity < 0) throw new HttpError(400, 'Class capacity must be a non-negative number.');
  if (!Number.isFinite(minViable) || minViable < 0) throw new HttpError(400, 'Minimum viable size must be a non-negative number.');
  if (capacity > 0 && minViable > capacity) throw new HttpError(400, 'Minimum viable size cannot exceed class capacity.');
  if (args.roomId && capacity > 0) {
    const room = stmtGetRoom.get(args.roomId) as any;
    if (room?.capacity > 0 && capacity > Number(room.capacity)) {
      throw new HttpError(400, `Class capacity (${capacity}) cannot exceed room capacity (${room.capacity}).`);
    }
  }
  if (args.teacherId && (args.timeSlotId || args.scheduleTime)) {
    const conflict = stmtGetTeacherConflicts.get(args.branchId, args.teacherId, args.classId || '', end, start, args.timeSlotId || null, args.timeSlotId || null, args.scheduleTime || null) as any;
    if (conflict) throw new HttpError(409, `Teacher is already assigned to class "${conflict.name}" at the same time.`);
  }
  if (args.roomId && (args.timeSlotId || args.scheduleTime)) {
    const conflict = stmtGetRoomConflicts.get(args.branchId, args.roomId, args.classId || '', end, start, args.timeSlotId || null, args.timeSlotId || null, args.scheduleTime || null) as any;
    if (conflict) throw new HttpError(409, `Room is already reserved by class "${conflict.name}" at the same time.`);
  }
  if (args.roomId && args.timeSlotId) {
    const conflict = stmtGetSlotConflicts.get(args.branchId, args.timeSlotId, args.classId || '', end, start, args.roomId) as any;
    if (conflict) throw new HttpError(409, `The selected time slot conflicts with another class using this room.`);
  }
}

classesRouter.get(
  '/',

  requirePermission('Class.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = (isAll ? stmtGetAllClasses.all() : stmtGetClassesByBranch.all(branchId)) as ClassRow[];
    res.json(rows.map(mapClass));
  })
);

classesRouter.post(
  '/',
  requirePermission('Class.Create'),
  ah(async (req, res) => {
    const {
      name, teacherId, level, levelId, programId, capacity, scheduleTime, startDate, endDate,
      fee, minViableSize, branchId, roomId, timeSlotId, academicTermId, activationDate, genderPolicy,
    } = req.body;
    assertTextLengths([[(req.body as { name?: unknown }).name, 'Class name', TEXT_LIMITS.name]]);
    
    if (!name) throw new HttpError(400, 'Class name is required.');

    const userBranchId = req.user?.branchId;
    if (!userBranchId) throw new HttpError(403, 'User branch context is missing.');

    let resolvedLevelLabel = level || '';
    // Without a levelId this is the raw client value and used to be written
    // straight to classes.fee: 'abc', -6000 and 1e15 were all stored. With a
    // levelId it is replaced by the level's fee below, which is now validated
    // at its own source.
    let resolvedFee = fee == null ? 0 : assertMoney(fee, 'class fee');
    let resolvedSchedule = scheduleTime || null;
    const resolvedBranch = branchId || userBranchId;
    if (!canAccessBranchResource(req, resolvedBranch)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
    if (teacherId) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(teacherId) as { id: string; branch_id: string; status: string } | undefined;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== resolvedBranch) throw new HttpError(400, 'Teacher and class branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }
    if (academicTermId) {
      const term = db.prepare('SELECT id, branch_id, is_active FROM academic_terms WHERE id = ?').get(academicTermId) as { id: string; branch_id: string; is_active: number } | undefined;
      if (!term) throw new HttpError(404, 'Academic term not found.');
      if (term.branch_id !== resolvedBranch) throw new HttpError(400, 'Academic term belongs to another branch.');
      if (!term.is_active) throw new HttpError(400, 'Academic term is inactive.');
    }
    const resolvedGender = genderPolicy === 'female' || genderPolicy === 'male' || genderPolicy === 'mixed' ? genderPolicy : 'mixed';

    let resolvedCapacity = capacity || 0;
    let resolvedMinViable = minViableSize || 0;

    if (levelId) {
      const lvl = stmtGetLevelById.get(levelId) as any;
      if (!lvl) throw new HttpError(400, 'Configured level not found.');
      if (lvl.is_active === 0) throw new HttpError(400, 'Selected level is inactive.');
      resolvedLevelLabel = lvl.name;
      
      const override = stmtGetLevelFee.get(levelId, resolvedBranch) as any;
      resolvedFee = override ? override.fee : (lvl.default_fee ?? 0);
      resolvedMinViable = Number(lvl.min_viable_size) >= 0 ? Number(lvl.min_viable_size) : (Number(minViableSize) || ACADEMIC_DEFAULTS.levelMinViableSize);
    }
    if (!resolvedLevelLabel) throw new HttpError(400, 'Level is required (select a configured level).');
    if (levelId && programId) {
      const levelRow = stmtGetLevelById.get(levelId) as any;
      if (levelRow?.program_id && String(levelRow.program_id) !== String(programId)) {
        throw new HttpError(400, 'Selected level does not belong to the selected program.');
      }
    }

    if (timeSlotId) {
      const slot = stmtGetTimeSlot.get(timeSlotId) as any;
      if (!slot) throw new HttpError(400, 'Time slot not found or inactive.');
      if (slot.branch_id !== resolvedBranch) throw new HttpError(400, 'Time slot belongs to another branch.');
      resolvedSchedule = `${slot.start_time}-${slot.end_time}`;
    }
    if (roomId) {
      const room = stmtGetRoom.get(roomId) as any;
      if (!room) throw new HttpError(400, 'Room not found or inactive.');
      if (room.branch_id !== resolvedBranch) throw new HttpError(400, 'Room belongs to another branch.');
      resolvedCapacity = room.capacity ?? resolvedCapacity;
    }

    assertClassPlanningConstraints({
      branchId: resolvedBranch, teacherId: teacherId || null, roomId: roomId || null,
      timeSlotId: timeSlotId || null, scheduleTime: resolvedSchedule, startDate: startDate || null,
      endDate: endDate || null, capacity: resolvedCapacity, minViableSize: resolvedMinViable,
    });

    const newId = id('c');
    // Lifecycle Engine: default new classes to 'scheduled' (closest match to
    // this endpoint's historical intent — immediately visible/orderable).
    // Pass activationDate to create it already-activated in one step, or
    // asDraft: true for the blueprint's not-yet-published Draft state.
    const initialStage: ClassStage = activationDate ? 'activated' : (req.body?.asDraft ? 'draft' : 'scheduled');
    const initialStatus = deriveLegacyClassStatus(initialStage);

    stmtInsertClass.run(
      newId, name, teacherId || null, programId || null, levelId || null, resolvedLevelLabel,
      resolvedCapacity, resolvedSchedule, startDate || null, endDate || null,
      initialStatus, initialStage,
      resolvedFee || 0, resolvedMinViable || 5, resolvedBranch,
      roomId || null, timeSlotId || null, academicTermId || null,
      activationDate || null, resolvedGender
    );

    writeAudit(req, `Created new class: ${name} (fee rule: ${resolvedFee || 0} AFN)`);
    res.status(201).json(mapClass(stmtGetClassById.get(newId) as ClassRow));
  })
);

classesRouter.put(
  '/:id',
  requirePermission('Class.Edit'),
  ah(async (req, res) => {
    const existing = requireClass(req, req.params.id);
    const { name, teacherId, level, capacity, scheduleTime, startDate, endDate, status, fee, minViableSize } = req.body;

    const nextTeacherId = teacherId ?? existing.teacher_id;
    if (nextTeacherId) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(nextTeacherId) as any;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== existing.branch_id) throw new HttpError(400, 'Teacher and class branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }

    const hasLevelRule = !!existing.level_id;
    const hasSlotRule = !!existing.time_slot_id;
    const hasRoomRule = !!existing.room_id;

    const nextLevel = hasLevelRule ? existing.level : (level ?? existing.level);
    const nextFee = hasLevelRule ? existing.fee : (fee ?? existing.fee);
    const nextSchedule = hasSlotRule ? existing.schedule_time : (scheduleTime ?? existing.schedule_time);
    const nextCapacity = hasRoomRule ? existing.capacity : (capacity ?? existing.capacity);

    assertClassPlanningConstraints({
      classId: existing.id, branchId: existing.branch_id, teacherId: nextTeacherId,
      roomId: existing.room_id, timeSlotId: existing.time_slot_id, scheduleTime: nextSchedule,
      startDate: startDate ?? existing.start_date, endDate: endDate ?? existing.end_date,
      capacity: nextCapacity, minViableSize: minViableSize ?? existing.min_viable_size,
    });

    const validGenders = ['female', 'male', 'mixed'];
    const requestedGender = req.body?.genderPolicy;

    const updateTx = db.transaction(() => {
      stmtUpdateClass.run(
        name ?? existing.name, nextTeacherId, nextLevel,
        nextCapacity, nextSchedule,
        startDate ?? existing.start_date, endDate ?? existing.end_date,
        nextFee, minViableSize ?? existing.min_viable_size, req.params.id
      );

      if (requestedGender && validGenders.includes(requestedGender)) {
        stmtUpdateClassGender.run(requestedGender, req.params.id);
      }

      // Backward compatibility: this endpoint historically accepted a raw
      // `status` field. `status` is now a derived projection of
      // `lifecycle_stage` (see lifecycle-engine.ts) written only by
      // ClassLifecycleService, so route the two unambiguous legacy values
      // through a guarded transition instead of writing `status` directly.
      // status: 'active'/'draft' from legacy callers is a deliberate no-op —
      // 'active' maps to six different lifecycle stages, so there's no
      // single correct target; use /:id/schedule, /:id/activate, etc.
      if (status && status !== existing.status) {
        const legacyTargetStage: Partial<Record<string, ClassStage>> = { cancelled: 'cancelled', completed: 'completed' };
        const targetStage = legacyTargetStage[status];
        if (targetStage) {
          classLifecycle.transition(req.params.id, targetStage, { operatorId: req.user?.userId });
        }
      }
    });
    updateTx();
    
    writeAudit(req, `Updated class: ${existing.name}`);
    const updated = stmtGetClassById.get(req.params.id) as ClassRow;
    res.json(mapClass(updated));
  })
);

classesRouter.delete(
  '/:id',
  requirePermission('Class.Delete', 'Class.Edit'),
  ah(async (req, res) => {
    const existing = requireClass(req, req.params.id);
    if (existing.status === 'completed') {
      throw new HttpError(400, 'Completed classes cannot be deleted. Keep them for academic history.');
    }
    
    const enrolled = (stmtCountStrictActiveEnrolled.get(req.params.id) as { c: number }).c;
    if (enrolled > 0) {
      throw new HttpError(400, `This class has ${enrolled} active enrollment(s). Transfer or complete them before deleting, or merge into another class.`);
    }
    const sessionCount = Number((stmtCountClassSessions.get(req.params.id) as { c: number }).c || 0);
    const assessmentCount = Number((stmtCountClassAssessments.get(req.params.id) as { c: number }).c || 0);
    if (sessionCount > 0 || assessmentCount > 0) {
      throw new HttpError(409, 'This class has academic history (sessions or assessments) and cannot be deleted. Cancel or archive it to preserve the audit trail.');
    }
    
    const deleteTx = db.transaction(() => {
      stmtDeleteClassTeacherSkills.run(req.params.id);
      stmtDeleteClass.run(req.params.id);
    });
    deleteTx();
    
    writeAudit(req, `Deleted class: ${existing.name}`);
    res.json({ ok: true, deleted: true });
  })
);

classesRouter.post(
  '/:id/merge',
  requirePermission('Class.Edit'),
  ah(async (req, res) => {
    const sourceId = req.params.id;
    const { targetClassId } = req.body ?? {};
    if (!targetClassId) throw new HttpError(400, 'targetClassId is required.');
    if (targetClassId === sourceId) throw new HttpError(400, 'Cannot merge a class into itself.');

    const source = requireClass(req, sourceId);
    const target = requireClass(req, targetClassId);
    if (source.branch_id !== target.branch_id) throw new HttpError(400, 'Classes must belong to the same branch to merge.');
    if (target.status !== 'active') throw new HttpError(400, 'Target class must be active.');
    if (source.level_id && target.level_id && source.level_id !== target.level_id) {
      throw new HttpError(400, 'Merge only allowed between classes of the same configured level.');
    }
    if (!source.level_id && source.level !== target.level) {
      throw new HttpError(400, 'Merge only allowed between classes with the same level label.');
    }
    if (source.program_id && target.program_id && String(source.program_id) !== String(target.program_id)) {
      throw new HttpError(400, 'Merge only allowed between classes in the same program.');
    }
    if (source.academic_term_id && target.academic_term_id && String(source.academic_term_id) !== String(target.academic_term_id)) {
      throw new HttpError(400, 'Merge only allowed within the same academic term.');
    }

    const enrolled = (stmtCountStrictActiveEnrolled.get(sourceId) as { c: number }).c;
    const targetCount = (stmtCountStrictActiveEnrolled.get(targetClassId) as { c: number }).c;
    const free = Math.max(0, (target.capacity || 0) - targetCount);
    
    if (enrolled > free) {
      throw new HttpError(400, `Target class only has ${free} free seat(s), but source has ${enrolled} active student(s).`);
    }

    const mergeTx = db.transaction(() => {
      stmtUpdateSemestersMerge.run(targetClassId, sourceId);
      stmtUpdateEnrollmentsMerge.run(target.id, source.id);
      stmtDeleteFutureSourceRosters.run(source.id, source.id);
      const targetSessions = stmtGetFutureTargetSessions.all(target.id) as { id: string }[];
      const sourceStudents = stmtGetSourceActiveStudents.all(source.id) as { student_id: string }[];
      for (const student of sourceStudents) {
        for (const session of targetSessions) stmtInsertMergeRoster.run(id('ros'), session.id, student.student_id);
      }
      classLifecycle.cancel(sourceId, {
        reason: `Merged into ${target.name} (${targetClassId})`,
        operatorId: req.user?.userId,
      });
      stmtLinkMergedClass.run(
        targetClassId,
        `Merged into ${target.name} (${targetClassId}) with ${enrolled} student(s).`,
        sourceId
      );
    });
    mergeTx();

    writeAudit(req, `Merged class ${source.name} into ${target.name} (${enrolled} student(s) moved)`);
    res.json({ ok: true, movedStudents: enrolled, sourceId, targetClassId });
  })
);

classesRouter.get(
  '/:id/merge-candidates',
  authorize('owner', 'manager', 'registrar', 'head_of_department'),
  ah(async (req, res) => {
    const source = requireClass(req, req.params.id);
    const enrolled = (stmtCountStrictActiveEnrolled.get(source.id) as { c: number }).c;

    let rows: ClassRow[];
    if (source.level_id) {
      rows = stmtGetMergeCandidatesByLevelId.all(source.branch_id, source.id, source.level_id) as ClassRow[];
    } else {
      rows = stmtGetMergeCandidatesByLevelName.all(source.branch_id, source.id, source.level) as ClassRow[];
    }

    const sourceGender = source.gender_policy || 'mixed';
    
    const candidates = rows
      .filter((r) => {
        const g = r.gender_policy || 'mixed';
        if (sourceGender === 'mixed' || g === 'mixed') return true;
        return g === sourceGender;
      })
      .map((r) => ({
        id: r.id, name: r.name, level: r.level, scheduleTime: r.schedule_time,
        capacity: r.capacity, enrolled: r.enrolled_count || 0,
        freeSeats: Math.max(0, (r.capacity || 0) - (r.enrolled_count || 0)),
        fee: r.fee, minViableSize: r.min_viable_size, genderPolicy: r.gender_policy || 'mixed',
      }))
      .filter((c) => c.freeSeats >= enrolled);

    res.json({
      source: {
        id: source.id, name: source.name, enrolled, capacity: source.capacity,
        minViableSize: source.min_viable_size, underMin: enrolled < (source.min_viable_size || 0),
      },
      candidates,
    });
  })
);

// ============================================================================
// §2 — CLASS LIFECYCLE ENGINE
// ============================================================================
// Draft → Scheduled → Enrollment Open → Enrollment Closed → Activated →
// In Progress → Suspended → Grading → Completed → Archived / Cancelled.
// Every transition is validated against CLASS_TRANSITIONS (lifecycle-engine.ts),
// audited, and emits a 'class.lifecycle_changed' domain event.
// The historical POST /:id/activate path is preserved for backward
// compatibility; its former "status !== 'scheduled'" gate was dead code
// anyway (no class could ever reach that value — see migration 030).

function registerLifecycleTransition(
  path: string,
  method: (svc: ReturnType<typeof getClassLifecycleService>, classId: string, opts: { reason?: string | null; operatorId?: string | null }) => unknown,
  auditVerb: string,
) {
  classesRouter.post(
    `/:id${path}`,
    authorize('owner', 'manager', 'head_of_department'),
    ah(async (req, res) => {
      requireClass(req, req.params.id); // 404s + branch-scope check up front
      const reason = req.body?.reason ?? null;
      const updated = method(classLifecycle, req.params.id, { reason, operatorId: req.user?.userId }) as ClassRow;
      writeAudit(req, `${auditVerb} class: ${updated.name}${reason ? ` (${reason})` : ''}`);
      res.json({ ok: true, class: mapClass(updated) });
    }),
  );
}

registerLifecycleTransition('/schedule', (s, id, o) => s.schedule(id, o), 'Scheduled');
registerLifecycleTransition('/open-enrollment', (s, id, o) => s.openEnrollment(id, o), 'Opened enrollment for');
registerLifecycleTransition('/close-enrollment', (s, id, o) => s.closeEnrollment(id, o), 'Closed enrollment for');
registerLifecycleTransition('/activate', (s, id, o) => s.activate(id, o), 'Activated');
registerLifecycleTransition('/start-teaching', (s, id, o) => s.startTeaching(id, o), 'Started teaching for');
registerLifecycleTransition('/suspend', (s, id, o) => s.suspend(id, o), 'Suspended');
registerLifecycleTransition('/resume', (s, id, o) => s.resume(id, o), 'Resumed');
registerLifecycleTransition('/start-grading', (s, id, o) => s.startGrading(id, o), 'Started grading for');
registerLifecycleTransition('/complete', (s, id, o) => s.complete(id, o), 'Completed');
registerLifecycleTransition('/archive', (s, id, o) => s.archive(id, o), 'Archived');
registerLifecycleTransition('/cancel', (s, id, o) => s.cancel(id, o), 'Cancelled');

classesRouter.get('/:id/lifecycle', authorize('owner', 'manager', 'head_of_department', 'registrar', 'teacher'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  res.json({
    stage: cls.lifecycle_stage,
    legacyStatus: cls.status,
    activationDate: cls.activation_date,
    cancellationReason: cls.cancellation_reason ?? null,
    allowedNextStages: CLASS_TRANSITIONS[cls.lifecycle_stage as ClassStage] ?? [],
  });
}));

/**
 * Academic Policy Engine (Phase 6) diagnostic view: every policy category
 * that would apply to this specific class, resolved through whichever
 * layer actually supplies it (promotion_rules / levels.pass_mark /
 * branch_academic_profiles / the generic rule engine — see
 * promotion-engine.ts's resolvePromotionCriteria for that chain) plus the
 * attendance/gradebook/retake/conditional-pass/transfer/freeze/
 * certificate/make-up policies. Read-only — this is for transparency, not
 * a config-editing surface.
 */
classesRouter.get('/:id/policy-profile', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const scope = { programId: cls.program_id, levelId: cls.level_id, classId: cls.id };
  const promotionCriteria = resolvePromotionCriteria(db, { level_id: cls.level_id, branch_id: cls.branch_id, offering_id: cls.offering_id });
  const policyProfile = getFullPolicyProfile(cls.branch_id, scope);
  res.json({ classId: cls.id, promotion: promotionCriteria, ...policyProfile });
}));

// ============================================================================
// §3 — GRADEBOOK & ASSESSMENTS (LMS CORE)
// ============================================================================

classesRouter.get('/:id/gradebook', authorize('owner', 'manager', 'head_of_department', 'teacher'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const students = stmtGetClassRoster.all(cls.id) as RosterRow[];
  const assessments = stmtGetAssessments.all(cls.id) as AssessmentRow[];
  const grades = stmtGetGradesByClass.all(cls.id) as GradeRow[];

  // Live projection using the exact math complete-semester will use to
  // lock the class — lets staff see where each student currently stands
  // (final %, letter grade, pass/fail) before anything is finalized.
  const computed = computeClassGrades(
    students.map(s => ({ id: s.id })),
    assessments.map(a => ({ id: a.id, weight: a.weight, max_score: a.max_score, makeup_for_assessment_id: a.makeup_for_assessment_id })),
    grades.map(g => ({ assessment_id: g.assessment_id, student_id: g.student_id, score: g.score })),
    cls.branch_id, cls.level
  );
  const computedByStudent = new Map(computed.map(c => [c.studentId, c]));

  res.json({ 
    students: students.map(s => ({
      id: s.id, fullName: s.full_name, studentCode: s.student_code, semesterId: s.semester_id,
      projected: computedByStudent.get(s.id) ?? null,
    })), 
    assessments: assessments.map(mapAssessment),
    grades: grades.map(g => ({ id: g.id, assessmentId: g.assessment_id, studentId: g.student_id, score: g.score, status: g.status, notes: g.notes }))
  });
}));

classesRouter.get('/:id/gradebook/history', authorize('owner', 'manager', 'head_of_department', 'teacher'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const { studentId, limit } = req.query as { studentId?: string; limit?: string };
  const rowLimit = Math.min(Number(limit) || 200, 500);

  const rows = (studentId
    ? stmtGetGradeHistoryForStudent.all(cls.id, studentId, rowLimit)
    : stmtGetGradeHistory.all(cls.id, rowLimit)) as any[];

  res.json(rows.map(r => ({
    id: r.id, gradeId: r.grade_id, assessmentId: r.assessment_id, studentId: r.student_id,
    previousScore: r.previous_score, previousStatus: r.previous_status, previousNotes: r.previous_notes,
    newScore: r.new_score, newStatus: r.new_status, newNotes: r.new_notes,
    changedBy: r.changed_by, changedAt: r.changed_at,
  })));
}));

classesRouter.post('/:id/assessments', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const {
    title, type, weight, maxScore, date, passingScore, publishDate, dueDate,
    visibility, rubric, allowsMakeup, makeupForAssessmentId,
  } = req.body;
  if (!title || !type) throw new HttpError(400, 'Title and type are required.');
  if (!ASSESSMENT_TYPES.includes(type)) {
    throw new HttpError(400, `Invalid assessment type: "${type}". Must be one of: ${ASSESSMENT_TYPES.join(', ')}.`);
  }
  if (visibility && !['visible', 'hidden', 'scheduled'].includes(visibility)) {
    throw new HttpError(400, `Invalid visibility: "${visibility}". Must be visible, hidden, or scheduled.`);
  }
  if (makeupForAssessmentId && !stmtGetAssessmentById.get(makeupForAssessmentId, cls.id)) {
    throw new HttpError(404, 'makeupForAssessmentId does not reference an assessment in this class.');
  }

  const existingAssessments = stmtGetAssessments.all(cls.id) as AssessmentRow[];
  // Makeup-linked assessments borrow the original's weight in scoring (see
  // complete-semester) rather than consuming their own slice of the
  // 100% budget, so they're excluded from this check on both sides.
  if (!makeupForAssessmentId) {
    const totalWeight = existingAssessments.filter(a => !a.makeup_for_assessment_id).reduce((acc, a) => acc + a.weight, 0) + (weight || 0);
    if (totalWeight > 100) {
      throw new HttpError(400, `Total assessment weight cannot exceed 100%. Current total would be ${totalWeight}%.`);
    }
  }

  const newId = id('asmt');
  stmtInsertAssessment.run(
    newId, cls.id, title, type, weight || 0, maxScore || 100, dueDate || date || null,
    passingScore ?? null, publishDate || null, dueDate || null,
    visibility || 'visible', rubric || null, allowsMakeup ? 1 : 0, makeupForAssessmentId || null
  );
  writeAudit(req, `Created assessment ${title} for class ${cls.name}`);
  res.status(201).json({ id: newId });
}));

classesRouter.put('/:id/assessments/:assessmentId', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const existing = stmtGetAssessmentById.get(req.params.assessmentId, cls.id) as AssessmentRow | undefined;
  if (!existing) throw new HttpError(404, 'Assessment not found.');

  const {
    title, weight, maxScore, date, passingScore, publishDate, dueDate,
    visibility, rubric, allowsMakeup, confirmRescore,
  } = req.body;

  const nextWeight = weight ?? existing.weight;
  const nextMaxScore = maxScore ?? existing.max_score;
  const scoringFieldsChanged = nextWeight !== existing.weight || nextMaxScore !== existing.max_score;

  if (scoringFieldsChanged && !confirmRescore) {
    const gradedCount = (stmtHasGradesForAssessment.get(req.params.assessmentId) as { c: number }).c;
    if (gradedCount > 0) {
      throw new HttpError(409, `${gradedCount} student(s) already have grades recorded for this assessment. Changing weight or maxScore will change their effective percentage — resend with confirmRescore: true to proceed.`);
    }
  }

  if (scoringFieldsChanged && !existing.makeup_for_assessment_id) {
    const otherWeight = stmtGetAssessments.all(cls.id).reduce((acc: number, a: any) => acc + (a.id === existing.id || a.makeup_for_assessment_id ? 0 : a.weight), 0);
    if (otherWeight + nextWeight > 100) {
      throw new HttpError(400, `Total assessment weight cannot exceed 100%. Current total would be ${otherWeight + nextWeight}%.`);
    }
  }
  if (visibility && !['visible', 'hidden', 'scheduled'].includes(visibility)) {
    throw new HttpError(400, `Invalid visibility: "${visibility}". Must be visible, hidden, or scheduled.`);
  }

  stmtUpdateAssessment.run(
    title ?? existing.title, nextWeight, nextMaxScore, dueDate ?? date ?? existing.date,
    passingScore !== undefined ? passingScore : existing.passing_score,
    publishDate !== undefined ? publishDate : existing.publish_date,
    dueDate !== undefined ? dueDate : existing.due_date,
    visibility ?? existing.visibility, rubric !== undefined ? rubric : existing.rubric,
    allowsMakeup !== undefined ? (allowsMakeup ? 1 : 0) : existing.allows_makeup,
    req.params.assessmentId
  );
  writeAudit(req, `Updated assessment "${existing.title}" for class ${cls.name}`);
  res.json({ ok: true });
}));

classesRouter.delete('/:id/assessments/:assessmentId', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const existing = stmtGetAssessmentById.get(req.params.assessmentId, cls.id) as AssessmentRow | undefined;
  if (!existing) throw new HttpError(404, 'Assessment not found.');

  const gradedCount = (stmtHasGradesForAssessment.get(req.params.assessmentId) as { c: number }).c;
  if (gradedCount > 0) {
    throw new HttpError(409, `Cannot delete: ${gradedCount} student(s) already have grades recorded for this assessment.`);
  }

  stmtDeleteAssessment.run(req.params.assessmentId);
  writeAudit(req, `Deleted assessment "${existing.title}" from class ${cls.name}`);
  res.json({ ok: true });
}));

/**
 * Make-up assessment convenience endpoint (blueprint §5: "Make-up Exam" +
 * "Make-up support"). Mirrors Phase 2's POST /:id/makeup for sessions:
 * creates a new type:'makeup_exam' assessment linked back to the original
 * via makeup_for_assessment_id, defaulting weight/maxScore from it.
 */
classesRouter.post('/:id/assessments/:assessmentId/makeup', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const original = stmtGetAssessmentById.get(req.params.assessmentId, cls.id) as AssessmentRow | undefined;
  if (!original) throw new HttpError(404, 'Assessment not found.');
  if (!original.allows_makeup) {
    throw new HttpError(400, `"${original.title}" does not allow makeup attempts. Set allowsMakeup: true on it first.`);
  }

  const { date, dueDate, weight, maxScore } = req.body || {};

  // Make-up Policy (Academic Policy Engine, Phase 6): only enforced when
  // the original has a due_date to measure from — an assessment with no
  // due date has no "window" to have closed.
  if (original.due_date) {
    const policy = getMakeupPolicy(cls.branch_id, { programId: cls.program_id, levelId: cls.level_id });
    const referenceDate = dueDate || date || today();
    const daysSinceDue = Math.floor((new Date(referenceDate).getTime() - new Date(original.due_date).getTime()) / 86400000);
    if (daysSinceDue > policy.windowDays) {
      throw new HttpError(
        400,
        `Make-up window has closed: "${original.title}" was due ${original.due_date}, and make-ups are only allowed within ${policy.windowDays} day(s) (this request is ${daysSinceDue} days after).`,
      );
    }
  }

  const newId = id('asmt');
  stmtInsertAssessment.run(
    newId, cls.id, `Makeup: ${original.title}`, 'makeup_exam',
    weight ?? 0, // Defaults to 0 — a makeup normally REPLACES the original's
                 // weight in scoring (see complete-semester) rather than
                 // adding a second weighted line item on top of it.
    maxScore ?? original.max_score, dueDate || date || null,
    original.passing_score, null, dueDate || date || null,
    'visible', original.rubric, 0, original.id
  );
  writeAudit(req, `Created makeup assessment for "${original.title}" in class ${cls.name}`);
  res.status(201).json({ id: newId });
}));

// ============================================================================
// §3.1 — GRADE LOCK WORKFLOW (blueprint §9)
// ============================================================================
// Draft → Submitted → Reviewed → Approved → Published → Locked, applied
// per-assessment. "Teachers may edit only Draft grades" is enforced in
// PUT /:id/grades below via GradeLockService#canEditGrades(); unlocking a
// Locked assessment is a separate, more heavily-gated endpoint (owner/
// manager/head_of_department only), never a normal forward transition.


function registerGradeLockTransition(
  path: string,
  method: (svc: ReturnType<typeof getGradeLockService>, assessmentId: string) => unknown,
  auditVerb: string,
  roles: UserRole[] = ['owner', 'manager', 'head_of_department'],
) {
  classesRouter.post(
    `/:id/assessments/:assessmentId${path}`,
    authorize(...roles),
    ah(async (req, res) => {
      const cls = requireClass(req, req.params.id);
      const existing = stmtGetAssessmentById.get(req.params.assessmentId, cls.id);
      if (!existing) throw new HttpError(404, 'Assessment not found.');

      const updated = method(gradeLockService, req.params.assessmentId) as { title: string; lock_status: string };
      writeAudit(req, `${auditVerb} assessment "${updated.title}" in class ${cls.name} (now ${updated.lock_status})`);
      res.json({ ok: true, assessment: mapAssessment(stmtGetAssessmentById.get(req.params.assessmentId, cls.id) as AssessmentRow) });
    }),
  );
}

// Submitting/sending-back is something the teacher who did the grading
// should be able to do themselves; review/approve/publish/lock are
// manager-tier actions ("Academic Managers may approve").
registerGradeLockTransition('/submit', (s, id) => s.submit(id), 'Submitted', ['owner', 'manager', 'head_of_department', 'teacher']);
registerGradeLockTransition('/send-back', (s, id) => s.sendBackToDraft(id), 'Sent back to draft for', ['owner', 'manager', 'head_of_department']);
registerGradeLockTransition('/review', (s, id) => s.review(id), 'Reviewed', ['owner', 'manager', 'head_of_department']);
registerGradeLockTransition('/approve', (s, id) => s.approve(id), 'Approved', ['owner', 'manager', 'head_of_department']);
registerGradeLockTransition('/publish', (s, id) => s.publish(id), 'Published', ['owner', 'manager', 'head_of_department']);
registerGradeLockTransition('/lock', (s, id) => s.lock(id), 'Locked', ['owner', 'manager', 'head_of_department']);
registerGradeLockTransition('/unlock', (s, id) => s.unlock(id), 'Unlocked (administrative override) for', ['owner', 'manager']);

classesRouter.put('/:id/grades', authorize('owner', 'manager', 'head_of_department', 'teacher'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const { grades } = req.body as { grades: Array<{ assessmentId: string; studentId: string; score: number; status: string; notes?: string }> };
  if (!Array.isArray(grades)) throw new HttpError(400, 'Grades array is required.');

  const user = req.user;
  const assessments = stmtGetAssessments.all(cls.id) as AssessmentRow[];
  const assessmentMap = new Map(assessments.map(a => [a.id, a]));

  const bulkGradeTx = db.transaction(() => {
    for (const g of grades) {
      const assessment = assessmentMap.get(g.assessmentId);
      if (!assessment) throw new HttpError(400, `Invalid assessmentId: ${g.assessmentId}`);

      if (!gradeLockService.canEditGrades(assessment.lock_status, user?.role || '')) {
        throw new HttpError(
          409,
          assessment.lock_status === 'locked'
            ? `"${assessment.title}" is locked. An owner or manager must use POST /:id/assessments/${assessment.id}/unlock first.`
            : `"${assessment.title}" is past Draft (currently ${assessment.lock_status}) — only owners, managers, or heads of department can edit it now.`,
        );
      }
      
      if (g.score != null && g.score > assessment.max_score) {
        throw new HttpError(400, `Score ${g.score} exceeds max score ${assessment.max_score} for assessment ${assessment.title}.`);
      }

      const previous = stmtGetExistingGrade.get(g.assessmentId, g.studentId) as GradeSnapshot | undefined;
      const nextStatus = g.status || 'graded';

      stmtUpsertGrade.run(id('gr'), g.assessmentId, g.studentId, cls.id, g.score, nextStatus, g.notes ?? null, user?.userId || 'system');

      if (hasGradeChanged(previous, { score: g.score, status: nextStatus, notes: g.notes })) {
        const savedGrade = stmtGetSavedGradeIdAndNotes.get(g.assessmentId, g.studentId) as { id: string; notes: string | null };
        stmtInsertGradeHistory.run(
          id('gh'), savedGrade.id, g.assessmentId, g.studentId, cls.id,
          previous?.score ?? null, previous?.status ?? null, previous?.notes ?? null,
          g.score, nextStatus, savedGrade.notes, user?.userId || 'system'
        );
      }
    }
  });
  bulkGradeTx();
  
  writeAudit(req, `Bulk updated grades for class: ${cls.name}`);
  res.json({ ok: true, count: grades.length });
}));

// ============================================================================
// §4 — PROMOTION ENGINE (COMPLETE SEMESTER)
// ============================================================================

classesRouter.post('/:id/complete-semester', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  
  if (cls.status === 'completed') {
    throw new HttpError(400, 'This class semester is already completed and locked.');
  }
  if (cls.status !== 'active') {
    throw new HttpError(400, 'Only active classes can be completed.');
  }
  
  const user = req.user;
  const journey = getJourneyEngine(db);
  const students = stmtGetClassRoster.all(cls.id) as RosterRow[];
  const assessments = stmtGetAssessments.all(cls.id) as AssessmentRow[];
  const grades = stmtGetGradesByClass.all(cls.id) as GradeRow[];

  // Same computation the live gradebook preview uses (Gradebook Engine,
  // Phase 4) — this used to be duplicated inline here.
  const computedGrades = computeClassGrades(
    students.map(s => ({ id: s.id })),
    assessments.map(a => ({ id: a.id, weight: a.weight, max_score: a.max_score, makeup_for_assessment_id: a.makeup_for_assessment_id })),
    grades.map(g => ({ assessment_id: g.assessment_id, student_id: g.student_id, score: g.score })),
    cls.branch_id, cls.level
  );
  const computedByStudent = new Map(computedGrades.map(c => [c.studentId, c]));

  // Promotion Engine (Phase 5) — one criteria resolution per class (score/
  // attendance thresholds don't vary per student), then per-student factors.
  const criteria = resolvePromotionCriteria(db, { level_id: cls.level_id, branch_id: cls.branch_id, offering_id: cls.offering_id });

  const retakePolicy = getRetakePolicy(cls.branch_id, { programId: cls.program_id, levelId: cls.level_id });

  const outcomes: { studentId: string; outcome: string }[] = [];

  const completeTx = db.transaction(() => {
    for (const student of students) {
      const computed = computedByStudent.get(student.id)!;
      const decision = decidePromotion({
        finalPercentage: computed.finalPercentage,
        hasMissingGrades: computed.hasMissingGrades,
        attendancePercentage: computeAttendancePercentage(db, student.id, cls.id),
        hasFinancialHold: hasFinancialHold(db, student.id),
        failedMandatorySkills: findFailedMandatorySkills(db, cls.id, student.id),
        criteria,
        priorRetakeCount: countPriorRetakes(db, student.id, cls.id),
        maxAutomaticRetakes: retakePolicy.maxAutomaticRetakes,
      });
      outcomes.push({ studentId: student.id, outcome: decision.outcome });

      // manual_review leaves student_semesters.status as 'active' — not
      // yet decided — even though the class itself locks below. A manager
      // resolves it via POST /:id/promotion/resolve/:studentId, which can
      // apply ANY of the 5 outcomes including Drop (never automated — see
      // promotion-engine.ts's ADR AM-25).
      const semesterStatus = decision.outcome === 'manual_review' ? 'active'
        : decision.outcome === 'retake' ? 'deferred' : 'completed'; // promote & conditional_pass both advance the semester record
      stmtUpdateSemesterFinalGrade.run(semesterStatus, computed.finalScore, computed.finalPercentage, computed.letterGrade, student.semester_id);

      // Apply to the Enrollment Lifecycle Engine (Phase 1) too, when a
      // corresponding active enrollment exists. Not every student_semesters
      // row has one yet — enrollments is the newer of the two roster
      // mechanisms (see Phase 1 report) — so this degrades gracefully
      // rather than failing the whole completion.
      const enrollment = stmtGetActiveEnrollmentForClass.get(student.id, cls.id) as { id: string } | undefined;
      if (enrollment) {
        try {
          if (decision.outcome === 'promote') enrollmentServiceForPromotion.complete(enrollment.id, { reason: 'Promoted', actorUserId: user?.userId });
          else if (decision.outcome === 'conditional_pass') enrollmentServiceForPromotion.markConditionalPass(enrollment.id, { reason: decision.reasons.join(' '), actorUserId: user?.userId });
          else if (decision.outcome === 'retake') enrollmentServiceForPromotion.markRetake(enrollment.id, { reason: decision.reasons.join(' '), actorUserId: user?.userId });
          // manual_review: enrollment stays 'active' until a manager resolves it, same as the semester record.
        } catch (err) { console.warn('[promotion] enrollment transition failed', err); }
      }

      try {
        journey.appendEvent({
          studentId: student.id,
          eventType: JourneyEventType.PROMOTION_DECIDED,
          occurredAt: today(),
          branchId: cls.branch_id,
          actorUserId: user?.userId,
          actorName: user?.fullName,
          payload: {
            decision: decision.outcome, suggestedManualOutcome: decision.suggestedManualOutcome, reasons: decision.reasons,
            score: computed.finalPercentage, letterGrade: computed.letterGrade, classId: cls.id, level: cls.level,
            criteriaSource: criteria.source,
          }
        });
      } catch (err) { console.warn('[journey] promotion event failed', err); }
    }
    
    // Lock the class via the Lifecycle Engine (grading → completed).
    // Transparently passes through 'grading' first for classes that never
    // had an explicit grading-start step — this endpoint has always done
    // grade computation and completion as a single atomic action.
    if (cls.lifecycle_stage !== 'grading') {
      classLifecycle.startGrading(cls.id, { operatorId: user?.userId });
    }
    classLifecycle.complete(cls.id, { operatorId: user?.userId });
  });
  
  completeTx();
  const pendingReview = outcomes.filter(o => o.outcome === 'manual_review').length;
  writeAudit(req, `Completed semester for class: ${cls.name}. ${students.length} students processed${pendingReview ? `, ${pendingReview} pending manual review` : ''}.`);
  res.json({ ok: true, processedStudents: students.length, outcomes, pendingReview });
}));

/**
 * Manual Review resolution (blueprint §7: "Manual Review allows Academic
 * Managers to override automatic decisions with proper authorization").
 * The only path that can ever apply 'drop' — see promotion-engine.ts's
 * ADR AM-25 for why that's never automated.
 */
classesRouter.post('/:id/promotion/resolve/:studentId', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  const { outcome, reason } = req.body as { outcome: 'promote' | 'retake' | 'conditional_pass' | 'drop'; reason?: string };
  if (!['promote', 'retake', 'conditional_pass', 'drop'].includes(outcome)) {
    throw new HttpError(400, `Invalid outcome: "${outcome}". Must be one of: promote, retake, conditional_pass, drop.`);
  }

  const semester = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? AND class_id = ?').get(req.params.studentId, cls.id) as any;
  if (!semester) throw new HttpError(404, 'No semester record found for this student in this class.');
  if (semester.status !== 'active') {
    throw new HttpError(409, `This student's semester is already resolved (status: ${semester.status}). Manual review only applies to pending decisions.`);
  }

  const user = req.user;
  const semesterStatus = outcome === 'retake' || outcome === 'drop' ? 'deferred' : 'completed';

  const resolveTx = db.transaction(() => {
    stmtUpdateSemesterFinalGrade.run(semesterStatus, semester.final_score, semester.final_percentage, semester.letter_grade, semester.id);

    const enrollment = stmtGetActiveEnrollmentForClass.get(req.params.studentId, cls.id) as { id: string } | undefined;
    if (enrollment) {
      if (outcome === 'promote') enrollmentServiceForPromotion.complete(enrollment.id, { reason: reason || 'Manual review: promoted', actorUserId: user?.userId });
      else if (outcome === 'conditional_pass') enrollmentServiceForPromotion.markConditionalPass(enrollment.id, { reason: reason || 'Manual review', actorUserId: user?.userId });
      else if (outcome === 'retake') enrollmentServiceForPromotion.markRetake(enrollment.id, { reason: reason || 'Manual review', actorUserId: user?.userId });
      else enrollmentServiceForPromotion.drop(enrollment.id, { reason: reason || 'Manual review: dropped', actorUserId: user?.userId });
    }

    try {
      getJourneyEngine(db).appendEvent({
        studentId: req.params.studentId,
        eventType: JourneyEventType.PROMOTION_DECIDED,
        occurredAt: today(),
        branchId: cls.branch_id,
        actorUserId: user?.userId,
        actorName: user?.fullName,
        payload: { decision: outcome, reasons: reason ? [reason] : [], classId: cls.id, level: cls.level, isManualOverride: true },
      });
    } catch (err) { console.warn('[journey] manual review event failed', err); }
  });
  resolveTx();

  writeAudit(req, `Manually resolved promotion for student ${req.params.studentId} in class ${cls.name}: ${outcome}${reason ? ` (${reason})` : ''}`);
  res.json({ ok: true, outcome });
}));

classesRouter.get('/:id/promotion/pending-review', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const cls = requireClass(req, req.params.id);
  if (cls.lifecycle_stage !== 'completed' && cls.lifecycle_stage !== 'archived') {
    return res.json({ pending: [] }); // nothing to review before the class is locked
  }
  const rows = db.prepare(
    `SELECT ss.id AS semester_id, ss.student_id, s.full_name, s.student_code, ss.final_score, ss.final_percentage, ss.letter_grade
     FROM student_semesters ss JOIN students s ON s.id = ss.student_id
     WHERE ss.class_id = ? AND ss.status = 'active'`
  ).all(cls.id) as any[];
  res.json({
    pending: rows.map(r => ({
      studentId: r.student_id, studentName: r.full_name, studentCode: r.student_code,
      finalScore: r.final_score, finalPercentage: r.final_percentage, letterGrade: r.letter_grade,
    })),
  });
}));

// ============================================================================
// §5 — LEGACY ATTENDANCE (deprecated — use sessions roster instead)
// ============================================================================

attendanceRouter.post(
  '/',
  authorize('registrar', 'manager', 'teacher', 'head_of_department'),
  ah(async (req, res) => {
    const { date, records } = req.body as {
      date: string;
      records: { targetId: string; targetType: 'student' | 'teacher'; status: 'present' | 'absent' | 'sick' | 'leave'; classId?: string }[];
    };
    if (!date || !Array.isArray(records) || records.length === 0) {
      throw new HttpError(400, 'Date and attendance records are required.');
    }

    const userBranchId = req.user?.branchId;
    if (!userBranchId) throw new HttpError(403, 'User branch context is missing.');

    const insertAttendanceTx = db.transaction(() => {
      const stmtDeleteAttendanceByDateAndTarget = db.prepare(
        `DELETE FROM attendance WHERE date = ? AND target_id = ?`
      );
      
      for (const r of records) {
        stmtDeleteAttendanceByDateAndTarget.run(date, r.targetId);
        stmtInsertAttendance.run(id('at'), date, r.targetId, r.targetType, r.status, r.classId || null, userBranchId);
      }
    });
    insertAttendanceTx();

    writeAudit(req, `Recorded attendance for ${date}`);
    res.status(201).json({ ok: true, count: records.length });
  })
);

attendanceRouter.get(
  '/',
  requirePermission('Attendance.View'),
  ah(async (req, res) => {
    const { targetId, date, from, to } = req.query as Record<string, string>;
    const { branchId, isAll } = resolveBranchScope(req);

    let query = 'SELECT * FROM attendance WHERE 1=1';
    const params: string[] = [];

    if (!isAll && branchId) {
      query += ' AND branch_id = ?';
      params.push(branchId);
    }
    if (targetId) {
      query += ' AND target_id = ?';
      params.push(targetId);
    }
    if (date) {
      query += ' AND date = ?';
      params.push(date);
    } else if (from && to) {
      query += ' AND date >= ? AND date <= ?';
      params.push(from, to);
    }

    // BOUNDED. This route had no LIMIT: it returned every attendance record the
    // branch had ever recorded. At 16,001 rows that is already 2.4 MB, and a
    // 500-student academy over three years (~390,000 rows) would be ~58 MB in a
    // single response, re-fetched every time the Attendance tab opens.
    //
    // Callers that need a specific student or day already pass targetId/date/
    // from+to and are unaffected. An unfiltered call now returns the most
    // recent page instead of the entire history.
    const { limit, offset } = parsePaginationShared(req as { query: Record<string, unknown> }, {
      defaultPageSize: ATTENDANCE_PAGE_SIZE,
      maxPageSize: ATTENDANCE_MAX_PAGE_SIZE,
    });
    query += ' ORDER BY date DESC LIMIT ? OFFSET ?';

    const rows = db.prepare(query).all(...params, limit, offset);

    res.json(rows);
  })
);

/**
 * Attendance summary per student, aggregated in SQL.
 *
 * The profile drawer derives an attendance PERCENTAGE from the rows it holds.
 * Bounding the list above would silently skew that number for any student whose
 * history falls outside the page — the same trap as S19 — so the rate is now
 * computed over the complete history server-side.
 */
attendanceRouter.get(
  '/summary',
  requirePermission('Attendance.View'),
  ah(async (req, res) => {
    const { branchId, isAll } = resolveBranchScope(req);
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId.trim() : '';

    // Bounded like the roster it annotates; a single-student lookup passes
    // targetId and is unaffected by the page size.
    const { limit, offset } = parsePaginationShared(req as { query: Record<string, unknown> }, {
      defaultPageSize: ATTENDANCE_PAGE_SIZE,
      maxPageSize: ATTENDANCE_MAX_PAGE_SIZE,
    });
    const clauses: string[] = ["target_type = 'student'"];
    const params: unknown[] = [];
    if (!isAll && branchId) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (targetId) { clauses.push('target_id = ?'); params.push(targetId); }

    const rows = db.prepare(`
      SELECT target_id,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
             SUM(CASE WHEN status = 'leave'   THEN 1 ELSE 0 END) AS onLeave,
             SUM(CASE WHEN status = 'absent'  THEN 1 ELSE 0 END) AS absent,
             SUM(CASE WHEN status = 'sick'    THEN 1 ELSE 0 END) AS sick
      FROM attendance
      WHERE ${clauses.join(' AND ')}
      GROUP BY target_id
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ target_id: string; total: number; present: number; onLeave: number; absent: number; sick: number }>;

    res.json(rows.map((r) => {
      const total = Number(r.total) || 0;
      const credited = (Number(r.present) || 0) + (Number(r.onLeave) || 0);
      return {
        targetId: r.target_id,
        total,
        present: Number(r.present) || 0,
        onLeave: Number(r.onLeave) || 0,
        absent: Number(r.absent) || 0,
        sick: Number(r.sick) || 0,
        // Present + leave counts as attended, matching the existing UI rule.
        rate: total > 0 ? Math.round((credited / total) * 100) : null,
      };
    }));
  })
);

export default classesRouter;

/** Reject enrollment when student gender conflicts with class gender_policy. */
export function assertClassGenderAllowsStudent(classId: string, studentGender: string | null | undefined) {
  const cls = stmtGetClassGenderAndName.get(classId) as { gender_policy?: string; name: string } | undefined;
  if (!cls) throw new HttpError(404, 'Class not found.');
  
  const policy = cls.gender_policy || 'mixed';
  if (policy === 'mixed') return;
  
  const g = (studentGender || '').toLowerCase();
  if (policy === 'female' && g !== 'female') {
    throw new HttpError(400, `Class "${cls.name}" is for female students only.`);
  }
  if (policy === 'male' && g !== 'male') {
    throw new HttpError(400, `Class "${cls.name}" is for male students only.`);
  }
}
