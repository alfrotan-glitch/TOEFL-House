/**
TOEFL House ERP — Session Routes (BC #3)
============================================================
REST endpoints for the Session Bounded Context — the true atomic
unit of the academic model. Every class meeting is a Session.
Attendance, homework, and assessments are all anchored to sessions,
not to classes directly.

Access control:
  registrar, manager, head_of_department: create/edit sessions
  teacher: mark attendance, add homework (for own sessions)
  all authenticated: read sessions and rosters (branch-scoped)

@module routes/sessions.routes
@version 2.0.0
@license Apache-2.0
*/
import { Router } from 'express';
import { db } from '../db/connection.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource, hasLegacyRole, hasAnyLegacyRole } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { eventBus } from '../core/events/event-bus.js';
import { isPostActivation, ATTENDANCE_STATUSES, SESSION_TYPES, type AttendanceStatus } from '../core/academic/lifecycle-engine.js';
import { getAttendancePolicy, computeAttendanceWeight, checkConsecutiveAbsences, ATTENDED_EQUIVALENT_STATUSES } from '../core/academic/attendance-policy-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';

const enrollmentServiceForAutoDrop = getEnrollmentService(db);

export const sessionsRouter = Router();
sessionsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetSessionById = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtGetSessionDetail = db.prepare(
  `SELECT s.*, c.name AS class_name, t.full_name AS teacher_name, sk.name AS skill_name
   FROM sessions s
   LEFT JOIN classes c ON c.id = s.class_id
   LEFT JOIN teachers t ON t.id = s.teacher_id
   LEFT JOIN skills sk ON sk.id = s.skill_id
   WHERE s.id = ?`
);
const stmtGetClassById = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtGetTeacherById = db.prepare('SELECT id FROM teachers WHERE id = ?');
const stmtGetUserLinkedTeacher = db.prepare('SELECT linked_teacher_id FROM users WHERE id = ?');
const stmtGetTimeSlot = db.prepare('SELECT start_time, end_time FROM time_slots WHERE id = ?');
// `branch_id` is selected because the handler enforces that a class and its
// academic term belong to the same branch. The column was previously omitted,
// so `term.branch_id` was always undefined and that guard could never fire.
const stmtGetAcademicTerm = db.prepare('SELECT branch_id, start_date, end_date FROM academic_terms WHERE id = ?');
const stmtGetHolidays = db.prepare('SELECT date FROM academic_holidays WHERE branch_id = ?');
const stmtGetClassSkills = db.prepare('SELECT skill_id, teacher_id FROM class_teacher_skills WHERE class_id = ?');
const stmtGetActiveSemesters = db.prepare(`SELECT DISTINCT student_id AS sid FROM student_semesters WHERE class_id = ? AND COALESCE(status, 'active') = 'active'`);
const stmtGetActiveEnrollments = db.prepare(`SELECT DISTINCT student_id AS sid FROM enrollments WHERE class_id = ? AND status = 'active'`);
const stmtGetRosterSummary = db.prepare(
  `SELECT COUNT(*) AS total,
    SUM(CASE WHEN attendance_status = 'present' THEN 1 ELSE 0 END) AS present,
    SUM(CASE WHEN attendance_status = 'late' THEN 1 ELSE 0 END) AS late,
    SUM(CASE WHEN attendance_status = 'absent' THEN 1 ELSE 0 END) AS absent,
    SUM(CASE WHEN attendance_status IN ('excused','leave') THEN 1 ELSE 0 END) AS excused,
    SUM(CASE WHEN attendance_status IN ('medical_leave','sick') THEN 1 ELSE 0 END) AS medicalLeave,
    SUM(CASE WHEN attendance_status = 'online' THEN 1 ELSE 0 END) AS online,
    SUM(CASE WHEN attendance_status = 'hybrid' THEN 1 ELSE 0 END) AS hybrid,
    SUM(CASE WHEN attendance_status = 'left_early' THEN 1 ELSE 0 END) AS leftEarly,
    SUM(CASE WHEN attendance_status = 'not_marked' THEN 1 ELSE 0 END) AS notMarked
   FROM rosters WHERE session_id = ?`
);
const stmtGetHomework = db.prepare('SELECT * FROM homework WHERE session_id = ? ORDER BY due_date ASC');
const stmtInsertSession = db.prepare(
  `INSERT INTO sessions (id, class_id, date, start_time, end_time, topic, notes, status, session_type, linked_session_id, teacher_id, room_id, skill_id, branch_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`
);
const stmtInsertRoster = db.prepare(`INSERT INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, ?, ?, 'not_marked')`);
const stmtGetSessionsForConflict = db.prepare(`SELECT id, start_time, end_time, status FROM sessions WHERE class_id = ? AND date = ? AND status != 'cancelled'`);
const stmtGetTeacherSessionsForConflict = db.prepare(`SELECT id, class_id, start_time, end_time FROM sessions WHERE teacher_id = ? AND date = ? AND status != 'cancelled'`);
const stmtGetRoomSessionsForConflict = db.prepare(`SELECT id, class_id, start_time, end_time FROM sessions WHERE room_id = ? AND date = ? AND status != 'cancelled'`);
const stmtUpdateSession = db.prepare(`UPDATE sessions SET date = ?, start_time = ?, end_time = ?, topic = ?, notes = ?, teacher_id = ?, room_id = ?, skill_id = ? WHERE id = ?`);
const stmtUpdateSessionStatus = db.prepare('UPDATE sessions SET status = ? WHERE id = ?');
const stmtDeleteRosters = db.prepare('DELETE FROM rosters WHERE session_id = ?');
const stmtDeleteHomework = db.prepare('DELETE FROM homework WHERE session_id = ?');
const stmtDeleteQuizzes = db.prepare('DELETE FROM quizzes WHERE session_id = ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtGetRoster = db.prepare('SELECT * FROM rosters WHERE id = ? AND session_id = ?');
const stmtGetRosterByStudent = db.prepare('SELECT * FROM rosters WHERE session_id = ? AND student_id = ?');
const stmtUpdateRoster = db.prepare('UPDATE rosters SET attendance_status = ?, late_minutes = ?, attendance_weight = ?, marked_at = ? WHERE session_id = ? AND student_id = ?');
const stmtUpdateRosterById = db.prepare('UPDATE rosters SET attendance_status = ?, late_minutes = ?, attendance_weight = ?, marked_at = ? WHERE id = ?');
const stmtGetExistingRosterSids = db.prepare('SELECT student_id AS sid FROM rosters WHERE session_id = ?');
const stmtGetRosterFull = db.prepare(`SELECT r.*, s.full_name AS student_name, s.student_code, s.phone AS student_phone FROM rosters r JOIN students s ON s.id = r.student_id WHERE r.session_id = ? ORDER BY s.full_name ASC`);
const stmtInsertHomework = db.prepare(`INSERT INTO homework (id, session_id, title, description, due_date, assigned_by) VALUES (?, ?, ?, ?, ?, ?)`);
const stmtGetHomeworkById = db.prepare('SELECT * FROM homework WHERE id = ? AND session_id = ?');
const stmtDeleteHomeworkById = db.prepare('DELETE FROM homework WHERE id = ?');
const stmtGetQuizzes = db.prepare('SELECT * FROM quizzes WHERE session_id = ? ORDER BY COALESCE(due_date, created_at) ASC');
const stmtInsertQuiz = db.prepare(`INSERT INTO quizzes (id, session_id, title, description, max_score, due_date, assigned_by) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const stmtGetQuizById = db.prepare('SELECT * FROM quizzes WHERE id = ? AND session_id = ?');
const stmtDeleteQuizById = db.prepare('DELETE FROM quizzes WHERE id = ?');
const stmtDeleteLegacyAttendance = db.prepare(`DELETE FROM attendance WHERE date = ? AND target_id = ? AND target_type = 'student' AND session_id = ?`);
const stmtInsertLegacyAttendance = db.prepare(`INSERT INTO attendance (id, date, target_id, target_type, status, class_id, session_id, branch_id) VALUES (?, ?, ?, 'student', ?, ?, ?, ?)`);
const stmtGetSessionByIdSimple = db.prepare('SELECT id FROM sessions WHERE id = ?');
const stmtGetStudentEnrollmentForClass = db.prepare(`SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'`);

/** Safely extracts user context */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.role || !user?.fullName) {
    throw new HttpError(403, 'User context is missing for session operation.');
  }
  return user;
}

function requireSession(req: import('express').Request, sessionId: string): any {
  const session = stmtGetSessionById.get(sessionId) as any;
  if (!session) throw new HttpError(404, 'Session not found.');
  
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && session.branch_id && session.branch_id !== branchId) {
    const cross = !!session.branch_id && canAccessBranchResource(req, session.branch_id);
    if (!cross) throw new HttpError(403, 'Session belongs to another branch.');
  }
  return session;
}

function activeStudentIdsForClass(classId: string): string[] {
  const fromSemesters = stmtGetActiveSemesters.all(classId) as { sid: string }[];
  let fromEnrollments: { sid: string }[] = [];
  try {
    fromEnrollments = stmtGetActiveEnrollments.all(classId) as { sid: string }[];
  } catch { /* enrollments may not exist on very old DBs */ }
  
  const set = new Set<string>();
  for (const r of fromSemesters) if (r.sid) set.add(r.sid);
  for (const r of fromEnrollments) if (r.sid) set.add(r.sid);
  return [...set];
}

function assertCanMarkSession(req: import('express').Request, session: any): void {
  const user = getUserContext(req);
  if (hasLegacyRole(req, 'owner')) return;
  if (hasAnyLegacyRole(req, ['manager', 'registrar', 'head_of_department'])) {
    if (session.branch_id && canAccessBranchResource(req, session.branch_id)) return;
    throw new HttpError(403, 'You do not have access to this session branch.');
  }
  
  if (hasLegacyRole(req, 'teacher')) {
    const userRow = stmtGetUserLinkedTeacher.get(user.userId) as { linked_teacher_id?: string } | undefined;
    const linked = userRow?.linked_teacher_id || null;
    if (!linked) throw new HttpError(403, 'Teacher account is not linked to a teacher profile.');
    if (session.teacher_id && linked === session.teacher_id) return;
    throw new HttpError(403, 'You can only mark attendance for your own sessions.');
  }
  throw new HttpError(403, 'Not allowed to mark attendance for this session.');
}

function sessionHasStarted(session: { date: string; start_time: string }): boolean {
  const dateParts = String(session.date || '').split('-').map((x) => Number(x));
  if (dateParts.length < 3 || dateParts.some((n) => Number.isNaN(n))) return false;
  const [y, mo, d] = dateParts;
  const raw = String(session.start_time || '00:00').trim();
  const tp = raw.split(':').map((x) => Number(x));
  const hh = Number.isFinite(tp[0]) ? tp[0] : 0;
  const mm = Number.isFinite(tp[1]) ? tp[1] : 0;
  const ss = Number.isFinite(tp[2]) ? tp[2] : 0;
  const start = new Date(y, mo - 1, d, hh, mm, ss, 0);
  return Date.now() >= start.getTime();
}

function assertSessionStartedForAttendance(session: { date: string; start_time: string; status?: string }) {
  if (session.status === 'cancelled') throw new HttpError(400, 'Cannot mark attendance on a cancelled session.');
  if (!sessionHasStarted(session)) {
    throw new HttpError(400, `Attendance is locked until the session starts (${session.date} ${session.start_time}).`);
  }
}

/**
 * Class Lifecycle Engine gate (Phase 1 + blueprint §1): "Only after
 * activation should the system begin: Student attendance [...] Homework
 * [...] Exams [...]". Reuses isPostActivation() from lifecycle-engine.ts
 * rather than duplicating the stage list here.
 */
function assertClassActivatedForAttendance(cls: { lifecycle_stage?: string; name?: string }) {
  if (cls.lifecycle_stage && !isPostActivation(cls.lifecycle_stage as any)) {
    throw new HttpError(400, `Cannot mark attendance: "${cls.name}" has not been activated yet (currently ${cls.lifecycle_stage}). Use POST /api/classes/:id/activate first.`);
  }
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const toMin = (t: string) => {
    const p = String(t).split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
  };
  const as = toMin(aStart), ae = toMin(aEnd), bs = toMin(bStart), be = toMin(bEnd);
  if (ae <= as || be <= bs) return false;
  return as < be && bs < ae;
}

function assertNoSessionConflict(classId: string, date: string, startTime: string, endTime: string, excludeId?: string) {
  const rows = stmtGetSessionsForConflict.all(classId, date) as { id: string; start_time: string; end_time: string; status: string }[];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (row.start_time === startTime || timesOverlap(startTime, endTime, row.start_time, row.end_time)) {
      throw new HttpError(409, `This class already has a session on ${date} that overlaps ${startTime}–${endTime}.`);
    }
  }
}

function assertNoRoomConflict(roomId: string | null | undefined, date: string, startTime: string, endTime: string, excludeId?: string) {
  if (!roomId) return;
  const rows = stmtGetRoomSessionsForConflict.all(roomId, date) as { id: string; class_id: string; start_time: string; end_time: string }[];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (timesOverlap(startTime, endTime, row.start_time, row.end_time)) {
      throw new HttpError(409, `This room already has a session on ${date} (${row.start_time}–${row.end_time}) that overlaps ${startTime}–${endTime}.`);
    }
  }
}

function assertNoTeacherConflict(teacherId: string | null | undefined, date: string, startTime: string, endTime: string, excludeId?: string) {
  if (!teacherId) return;
  const rows = stmtGetTeacherSessionsForConflict.all(teacherId, date) as { id: string; class_id: string; start_time: string; end_time: string }[];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if (timesOverlap(startTime, endTime, row.start_time, row.end_time)) {
      throw new HttpError(409, `This teacher already has a session on ${date} (${row.start_time}–${row.end_time}) that overlaps ${startTime}–${endTime}.`);
    }
  }
}

function parseScheduleTimes(scheduleTime: string | null | undefined): { start: string; end: string } | null {
  if (!scheduleTime) return null;
  const m = String(scheduleTime).match(/(\d{1,2}:\d{2})\s*[-–to]+\s*(\d{1,2}:\d{2})/i);
  if (!m) return null;
  const norm = (x: string) => (x.length === 4 ? `0${x}` : x);
  return { start: norm(m[1]), end: norm(m[2]) };
}

function addDaysISO(isoDate: string, days: number): string {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function startOfWeekSaturday(isoDate?: string): string {
  const base = isoDate ? new Date(isoDate + 'T12:00:00') : new Date();
  const day = base.getDay();
  const diff = day === 6 ? 0 : -(day + 1);
  base.setDate(base.getDate() + diff);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
}

function offsetFromSaturday(jsDay: number): number {
  return jsDay === 6 ? 0 : jsDay + 1;
}

const AF_TEACHING_DAYS = [6, 0, 1, 2, 3, 4];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Shared hardened parser (this router's guard was already correct). */
function parsePagination(req: import('express').Request): { page: number; limit: number; offset: number } {
  return parsePaginationShared(req as { query: Record<string, unknown> }, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
  });
}

function mapSessionRow(r: any, classTeacherId?: string | null) {
  return {
    id: r.id, classId: r.class_id, className: r.class_name, date: r.date, startTime: r.start_time,
    endTime: r.end_time, topic: r.topic, notes: r.notes ?? null, status: r.status, teacherId: r.teacher_id, teacherName: r.teacher_name,
    skillId: r.skill_id || null, skillName: r.skill_name || null, branchId: r.branch_id, createdAt: r.created_at,
    sessionType: r.session_type || 'regular',
    linkedSessionId: r.linked_session_id ?? null,
    roomId: r.room_id ?? null,
    // Teacher substitution needs no stored flag — session.teacher_id has
    // always been independent of the class's primary teacher; this just
    // makes that fact visible to API consumers without an extra join.
    isSubstitute: classTeacherId !== undefined ? Boolean(r.teacher_id && classTeacherId && r.teacher_id !== classTeacherId) : undefined,
  };
}

// ============================================================================
// §1 — SESSION CRUD
// ============================================================================

sessionsRouter.get(
  '/',
  authorize('registrar', 'manager', 'head_of_department', 'teacher', 'owner', 'finance'),
  ah(async (req, res) => {
    const { classId, from, to, status } = req.query as Record<string, string>;
    const { branchId, isAll } = resolveBranchScope(req);
    const { limit, offset } = parsePagination(req);
    let sql = `SELECT s.*, c.name AS class_name, t.full_name AS teacher_name, sk.name AS skill_name FROM sessions s LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id LEFT JOIN skills sk ON sk.id = s.skill_id WHERE 1=1`;
    const params: unknown[] = [];

    if (!isAll) { sql += ' AND s.branch_id = ?'; params.push(branchId); }
    if (classId) { sql += ' AND s.class_id = ?'; params.push(classId); }
    if (from && to) { sql += ' AND s.date BETWEEN ? AND ?'; params.push(from, to); } 
    else if (from) { sql += ' AND s.date >= ?'; params.push(from); } 
    else if (to) { sql += ' AND s.date <= ?'; params.push(to); }
    if (status) { sql += ' AND s.status = ?'; params.push(status); }

    sql += ' ORDER BY s.date DESC, s.start_time ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as any[];
    res.json(rows.map((r) => mapSessionRow(r)));
  })
);

sessionsRouter.get(
  '/:id',
  requirePermission('Session.View'),
  ah(async (req, res) => {
    const session = stmtGetSessionDetail.get(req.params.id) as any;
    if (!session) throw new HttpError(404, 'Session not found.');

    const { branchId, isAll } = resolveBranchScope(req);
    if (!isAll && session.branch_id !== branchId) throw new HttpError(403, 'You do not have access to this session.');

    const rosterSummary = stmtGetRosterSummary.get(req.params.id) as any;
    const homework = stmtGetHomework.all(req.params.id) as any[];
    const quizzes = stmtGetQuizzes.all(req.params.id) as any[];
    const cls = stmtGetClassById.get(session.class_id) as any;

    res.json({
      ...mapSessionRow(session, cls?.teacher_id ?? null),
      rosterSummary: {
        total: rosterSummary.total || 0, present: rosterSummary.present || 0, late: rosterSummary.late || 0,
        absent: rosterSummary.absent || 0, excused: rosterSummary.excused || 0, medicalLeave: rosterSummary.medicalLeave || 0,
        online: rosterSummary.online || 0, hybrid: rosterSummary.hybrid || 0, leftEarly: rosterSummary.leftEarly || 0,
        notMarked: rosterSummary.notMarked || 0,
      },
      homework: homework.map((h) => ({
        id: h.id, title: h.title, description: h.description, dueDate: h.due_date, assignedBy: h.assigned_by, createdAt: h.created_at,
      })),
      quizzes: quizzes.map((q) => ({
        id: q.id, title: q.title, description: q.description, maxScore: q.max_score, dueDate: q.due_date, assignedBy: q.assigned_by, createdAt: q.created_at,
      })),
    });
  })
);

// ============================================================================
// §1.1 — TIMETABLE GENERATOR
// ============================================================================

sessionsRouter.post(
  '/generate',
  authorize('registrar', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { classId, weekStart, weeks = 1, daysOfWeek, startTime, endTime, skillId, skillIds, teacherId } = req.body || {};

    if (!classId) throw new HttpError(400, 'classId is required.');
    const weekCount = Math.min(12, Math.max(1, Number(weeks) || 1));
    const days: number[] = Array.isArray(daysOfWeek) && daysOfWeek.length ? daysOfWeek.map(Number) : AF_TEACHING_DAYS;

    const cls = stmtGetClassById.get(classId) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');
    if (!canAccessBranchResource(req, cls.branch_id)) throw new HttpError(403, 'Class belongs to another branch.');
    if (cls.status && cls.status !== 'active') throw new HttpError(400, 'Cannot generate sessions for an inactive class.');

    let start = startTime as string | undefined;
    let end = endTime as string | undefined;
    if ((!start || !end) && cls.time_slot_id) {
      const slot = stmtGetTimeSlot.get(cls.time_slot_id) as any;
      if (slot?.start_time) start = start || slot.start_time;
      if (slot?.end_time) end = end || slot.end_time;
    }
    const parsed = parseScheduleTimes(cls.schedule_time);
    start = start || parsed?.start || '08:00';
    end = end || parsed?.end || '09:30';
    const resolvedTeacher = teacherId || cls.teacher_id;
    if (resolvedTeacher) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(resolvedTeacher) as any;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== cls.branch_id) throw new HttpError(400, 'Teacher and class branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }
    const weekOrigin = startOfWeekSaturday(weekStart);

    let termFrom: string | null = null, termTo: string | null = null;
    if (cls.academic_term_id) {
      const term = stmtGetAcademicTerm.get(cls.academic_term_id) as any;
      if (!term) throw new HttpError(400, 'Academic term not found.');
      if (term.branch_id && term.branch_id !== cls.branch_id) throw new HttpError(400, 'Academic term and class branch must match.');
      termFrom = term.start_date || null;
      termTo = term.end_date || null;
    }
    if (cls.room_id) {
      const room = db.prepare('SELECT id, branch_id, is_active FROM rooms WHERE id = ?').get(cls.room_id) as any;
      if (!room) throw new HttpError(400, 'Class room not found.');
      if (room.branch_id !== cls.branch_id) throw new HttpError(400, 'Class room and branch must match.');
      if (room.is_active !== undefined && Number(room.is_active) !== 1) throw new HttpError(400, 'Class room is inactive.');
    }


    const holidaySet = new Set((stmtGetHolidays.all(cls.branch_id) as { date: string }[]).map((h) => h.date));
    const requestedSkillIds = Array.isArray(skillIds) ? skillIds.map(String).filter(Boolean) : (skillId ? [String(skillId)] : []);
    if (requestedSkillIds.length > 0 && new Set(requestedSkillIds).size !== requestedSkillIds.length) {
      throw new HttpError(400, 'skillIds must contain unique skill identifiers.');
    }
    let targets: { skill_id: string | null; teacher_id: string | null | undefined }[] = [];
    const cts = stmtGetClassSkills.all(classId) as any[];
    if (requestedSkillIds.length > 0) {
      const selected = new Set(requestedSkillIds);
      const selectedRows = cts.filter((ct) => selected.has(String(ct.skill_id)));
      if (selectedRows.length !== selected.size) throw new HttpError(400, 'Every selected skill must be configured for this class.');
      targets = requestedSkillIds.map((sid) => {
        const rows = selectedRows.filter((ct) => String(ct.skill_id) === sid);
        return { skill_id: sid, teacher_id: rows[0]?.teacher_id || resolvedTeacher };
      });
    } else if (cts.length > 0) {
      targets = cts.map(ct => ({ skill_id: ct.skill_id, teacher_id: ct.teacher_id || resolvedTeacher }));
    } else {
      targets.push({ skill_id: null, teacher_id: resolvedTeacher });
    }

    const uniqueTeacherIds = [...new Set(targets.map((t) => t.teacher_id).filter(Boolean) as string[])];
    for (const tid of uniqueTeacherIds) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(tid) as any;
      if (!teacher) throw new HttpError(404, 'Session target teacher not found.');
      if (teacher.branch_id !== cls.branch_id) throw new HttpError(400, 'All session teachers must belong to the class branch.');
      if (teacher.status !== 'active') throw new HttpError(400, 'All session teachers must be active.');
    }
    const configuredSkills = new Set((stmtGetClassSkills.all(classId) as any[]).map((r) => r.skill_id));
    for (const target of targets) {
      if (target.skill_id && !configuredSkills.has(target.skill_id)) throw new HttpError(400, 'Every generated session skill must be configured for this class.');
    }

    const created: string[] = [];
    const skipped: { date: string; reason: string }[] = [];
    let targetIndex = 0; // Round-robin index for skills

    const tx = db.transaction(() => {
      for (let w = 0; w < weekCount; w++) {
        for (const dow of days) {
          const offset = offsetFromSaturday(dow);
          const date = addDaysISO(weekOrigin, w * 7 + offset);

          if (termFrom && date < termFrom) { skipped.push({ date, reason: 'before term start' }); continue; }
          if (termTo && date > termTo) { skipped.push({ date, reason: 'after term end' }); continue; }
          if (holidaySet.has(date)) { skipped.push({ date, reason: 'holiday' }); continue; }

          const existing = stmtGetSessionsForConflict.all(classId, date) as any[];
          let conflict = false;
          for (const row of existing) {
            if (row.start_time === start || timesOverlap(start, end, row.start_time, row.end_time)) {
              conflict = true; skipped.push({ date, reason: `overlap ${row.start_time}–${row.end_time}` }); break;
            }
          }
          if (conflict) continue;

          let target: { skill_id: string | null; teacher_id: string | null | undefined } | null = null;
          let targetReason = 'no eligible skill target';
          for (let attempt = 0; attempt < targets.length; attempt++) {
            const candidate = targets[(targetIndex + attempt) % targets.length];
            let teacherBusy = false;
            if (candidate.teacher_id) {
              const tBusy = stmtGetTeacherSessionsForConflict.all(candidate.teacher_id, date) as any[];
              teacherBusy = tBusy.some((row) => timesOverlap(start, end, row.start_time, row.end_time));
            }
            if (teacherBusy) {
              targetReason = 'all eligible skill teachers are busy';
              continue;
            }
            target = candidate;
            targetIndex = (targetIndex + attempt + 1) % targets.length;
            break;
          }
          if (!target) {
            skipped.push({ date, reason: targetReason });
            continue;
          }

          try {
            assertNoRoomConflict(cls.room_id || null, date, start, end);
          } catch (err) {
            skipped.push({ date, reason: err instanceof Error ? err.message : 'room busy' });
            continue;
          }

          const newId = id('sess');
          stmtInsertSession.run(newId, classId, date, start, end, null, null, 'regular', null, target.teacher_id, cls.room_id || null, target.skill_id, cls.branch_id);

          const studentIds = activeStudentIdsForClass(classId);
          for (const studentId of studentIds) {
            stmtInsertRoster.run(id('ros'), newId, studentId);
          }
          created.push(newId);
        }
      }
    });
    tx();
    const createdRows = created.length ? (db.prepare(`SELECT skill_id, COUNT(*) AS c FROM sessions WHERE id IN (${created.map(() => '?').join(',')}) GROUP BY skill_id`).all(...created) as any[]) : [];
    const skillCoverage = Object.fromEntries(createdRows.filter((r) => r.skill_id).map((r) => [r.skill_id, Number(r.c)]));
    const requestedSkills = targets.map((t) => t.skill_id).filter(Boolean) as string[];
    const missingSkillIds = requestedSkills.filter((skillId) => !Number(skillCoverage[skillId] || 0));

    writeAudit(req, `Generated ${created.length} session(s) for class "${cls.name}" (${weekCount} week(s)); skipped ${skipped.length}`);
    res.status(201).json({
      created: created.length, skipped: skipped.length, sessionIds: created,
      details: { weekStart: weekOrigin, weeks: weekCount, daysOfWeek: days, start, end, skills: requestedSkills, skillCoverage, missingSkillIds, skipped },
    });
  })
);

sessionsRouter.post(
  '/',
  authorize('registrar', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const { classId, date, startTime, endTime, topic, notes, teacherId, skillId, sessionType, linkedSessionId, roomId } = req.body;
    
    if (!classId || !date || !startTime || !endTime) throw new HttpError(400, 'classId, date, startTime, and endTime are required.');
    if (sessionType && !SESSION_TYPES.includes(sessionType)) {
      throw new HttpError(400, `Invalid sessionType: "${sessionType}". Must be one of: ${SESSION_TYPES.join(', ')}.`);
    }

    const cls = stmtGetClassById.get(classId) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');
    if (!canAccessBranchResource(req, cls.branch_id)) throw new HttpError(403, 'Class belongs to another branch.');
    if (cls.status && cls.status !== 'active') throw new HttpError(400, 'Cannot create sessions for an inactive or cancelled class.');

    if (teacherId) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(teacherId) as any;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== cls.branch_id) throw new HttpError(400, 'Teacher and class branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }
    if (skillId) {
      const linkedSkill = (stmtGetClassSkills.all(classId) as any[]).some((row) => row.skill_id === skillId);
      if (!linkedSkill) throw new HttpError(400, 'Selected skill is not configured for this class.');
    }
    const selectedRoomId = roomId || cls.room_id || null;
    if (selectedRoomId) {
      const room = db.prepare('SELECT id, branch_id, is_active FROM rooms WHERE id = ?').get(selectedRoomId) as any;
      if (!room) throw new HttpError(404, 'Room not found.');
      if (room.branch_id !== cls.branch_id) throw new HttpError(400, 'Room and class branch must match.');
      if (room.is_active === 0) throw new HttpError(400, 'Selected room is not active.');
    }

    if (linkedSessionId) {
      const linked = stmtGetSessionById.get(linkedSessionId) as any;
      if (!linked) throw new HttpError(404, 'linkedSessionId does not reference an existing session.');
      if (linked.branch_id !== cls.branch_id) throw new HttpError(400, 'Linked session must belong to the same branch.');
    }

    const newId = id('sess');
    const resolvedTeacherId = teacherId || cls.teacher_id;

    assertNoSessionConflict(classId, date, startTime, endTime);
    assertNoTeacherConflict(resolvedTeacherId, date, startTime, endTime);

    const tx = db.transaction(() => {
      stmtInsertSession.run(
        newId, classId, date, startTime, endTime, topic || null, notes || null,
        sessionType || 'regular', linkedSessionId || null,
        resolvedTeacherId, selectedRoomId, skillId || null, cls.branch_id
      );
      const studentIds = activeStudentIdsForClass(classId);
      for (const studentId of studentIds) {
        stmtInsertRoster.run(id('ros'), newId, studentId);
      }
      return eventBus.emit('session.scheduled', 'session', newId, { classId, date, startTime, endTime, topic }, { operatorId: user.userId, branchId: cls.branch_id });
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Created session for class "${cls.name}" on ${date} (${startTime}–${endTime})`);
    const created = stmtGetSessionDetail.get(newId) as any;
    res.status(201).json(mapSessionRow(created));
  })
);

sessionsRouter.put(
  '/:id',
  authorize('registrar', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const existing = requireSession(req, req.params.id);
    const { date, startTime, endTime, topic, notes, teacherId, skillId, roomId } = req.body;
    
    const nextDate = date ?? existing.date;
    const nextStart = startTime ?? existing.start_time;
    const nextEnd = endTime ?? existing.end_time;
    
    assertNoSessionConflict(existing.class_id, nextDate, nextStart, nextEnd, req.params.id);
    const nextRoomId = roomId !== undefined ? roomId : existing.room_id;
    if (nextRoomId) {
      const room = db.prepare('SELECT id, branch_id, is_active FROM rooms WHERE id = ?').get(nextRoomId) as any;
      if (!room) throw new HttpError(404, 'Room not found.');
      if (room.branch_id !== existing.branch_id) throw new HttpError(400, 'Room and session branch must match.');
      if (room.is_active === 0) throw new HttpError(400, 'Selected room is not active.');
    }

    const nextTeacher = teacherId ?? existing.teacher_id;
    if (nextTeacher) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(nextTeacher) as any;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== existing.branch_id) throw new HttpError(400, 'Teacher and session branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }
    if (skillId !== undefined && skillId !== null) {
      const linkedSkill = (stmtGetClassSkills.all(existing.class_id) as any[]).some((row) => row.skill_id === skillId);
      if (!linkedSkill) throw new HttpError(400, 'Selected skill is not configured for this class.');
    }
    assertNoTeacherConflict(nextTeacher, nextDate, nextStart, nextEnd, req.params.id);
    assertNoRoomConflict(nextRoomId, nextDate, nextStart, nextEnd, req.params.id);
    
    stmtUpdateSession.run(
      nextDate, nextStart, nextEnd, topic ?? existing.topic, notes ?? existing.notes,
      nextTeacher, nextRoomId,
      skillId !== undefined ? skillId : existing.skill_id, req.params.id
    );

    writeAudit(req, `Updated session ${req.params.id}`);
    res.json({ ok: true });
  })
);

sessionsRouter.patch(
  '/:id/status',
  authorize('registrar', 'manager', 'head_of_department', 'teacher'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const existing = requireSession(req, req.params.id);
    assertCanMarkSession(req, existing);

    const { status } = req.body;
    if (!['completed', 'cancelled'].includes(status)) throw new HttpError(400, 'Status must be "completed" or "cancelled".');
    if (existing.status === status) return res.json({ ok: true, message: 'Session already in this status.' });
    
    if (status === 'completed' && !sessionHasStarted(existing)) {
      throw new HttpError(400, `Cannot complete a session before it starts (${existing.date} ${existing.start_time}).`);
    }

    const eventType = status === 'completed' ? 'session.completed' : 'session.cancelled';
    const tx = db.transaction(() => {
      stmtUpdateSessionStatus.run(status, req.params.id);
      return eventBus.emit(eventType, 'session', req.params.id, { classId: existing.class_id, date: existing.date }, { operatorId: user.userId, branchId: existing.branch_id });
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Session ${req.params.id} marked as ${status}`);
    res.json({ ok: true });
  })
);

sessionsRouter.delete(
  '/:id',
  authorize('manager', 'head_of_department'),
  ah(async (req, res) => {
    const existing = requireSession(req, req.params.id);
    if (existing.status === 'completed') throw new HttpError(409, 'Cannot delete a completed session.');

    const tx = db.transaction(() => {
      stmtDeleteRosters.run(req.params.id);
      stmtDeleteHomework.run(req.params.id);
      stmtDeleteQuizzes.run(req.params.id);
      stmtDeleteSession.run(req.params.id);
    });
    tx();

    writeAudit(req, `Deleted session ${req.params.id}`);
    res.json({ ok: true });
  })
);

/**
 * Makeup session convenience endpoint (blueprint §3: "This design allows
 * future support for: Substitute teachers, Makeup sessions..."). Equivalent
 * to POST / with sessionType:'makeup' and linkedSessionId set, but starts
 * from the original session's class/teacher/skill/room so the caller only
 * needs to supply the new date/time.
 */
sessionsRouter.post(
  '/:id/makeup',
  authorize('registrar', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const original = requireSession(req, req.params.id);
    const { date, startTime, endTime, teacherId, roomId, notes } = req.body || {};
    if (!date || !startTime || !endTime) throw new HttpError(400, 'date, startTime, and endTime are required.');

    const cls = stmtGetClassById.get(original.class_id) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');

    const resolvedTeacherId = teacherId || original.teacher_id || cls.teacher_id;
    if (resolvedTeacherId) {
      const teacher = db.prepare('SELECT id, branch_id, status FROM teachers WHERE id = ?').get(resolvedTeacherId) as any;
      if (!teacher) throw new HttpError(404, 'Teacher not found.');
      if (teacher.branch_id !== cls.branch_id) throw new HttpError(400, 'Teacher and class branch must match.');
      if (teacher.status !== 'active') throw new HttpError(400, 'Selected teacher is not active.');
    }
    assertNoSessionConflict(original.class_id, date, startTime, endTime);
    assertNoTeacherConflict(resolvedTeacherId, date, startTime, endTime);
    assertNoRoomConflict(roomId || original.room_id || cls.room_id || null, date, startTime, endTime);

    const newId = id('sess');
    const tx = db.transaction(() => {
      stmtInsertSession.run(
        newId, original.class_id, date, startTime, endTime,
        original.topic ? `Makeup: ${original.topic}` : 'Makeup session',
        notes || null, 'makeup', original.id,
        resolvedTeacherId, roomId || original.room_id || cls.room_id || null, original.skill_id, cls.branch_id
      );
      const studentIds = activeStudentIdsForClass(original.class_id);
      for (const studentId of studentIds) {
        stmtInsertRoster.run(id('ros'), newId, studentId);
      }
      return eventBus.emit('session.scheduled', 'session', newId, { classId: original.class_id, date, startTime, endTime, sessionType: 'makeup', linkedSessionId: original.id }, { operatorId: user.userId, branchId: cls.branch_id });
    });
    const event = tx();
    void eventBus.dispatch(event);

    writeAudit(req, `Created makeup session for session ${original.id} on ${date} (${startTime}–${endTime})`);
    const created = stmtGetSessionDetail.get(newId) as any;
    res.status(201).json(mapSessionRow(created));
  })
);

// ============================================================================
// §2 — ROSTER & ATTENDANCE
// ============================================================================

sessionsRouter.get(
  '/:id/roster',
  requirePermission('Session.View', 'Attendance.View'),
  ah(async (req, res) => {
    requireSession(req, req.params.id);
    const rows = stmtGetRosterFull.all(req.params.id) as any[];
    res.json(rows.map((r) => ({
      id: r.id, sessionId: r.session_id, studentId: r.student_id, studentName: r.student_name,
      studentCode: r.student_code, studentPhone: r.student_phone, attendanceStatus: r.attendance_status,
      lateMinutes: r.late_minutes ?? null, attendanceWeight: r.attendance_weight ?? null, markedAt: r.marked_at,
    })));
  })
);

/**
 * Smart Attendance Engine — Automatic drop after consecutive absences
 * (blueprint §4). Runs after a student is marked 'absent'; no-ops quietly
 * if the threshold isn't met, if there's no active enrollment to drop
 * (student already left some other way), or if the enrollment isn't in a
 * state 'dropped' is reachable from — attendance marking must never fail
 * because of a downstream policy side-effect.
 */
function checkAndApplyAutoDrop(studentId: string, classId: string, policy: ReturnType<typeof getAttendancePolicy>, actorUserId?: string) {
  const check = checkConsecutiveAbsences(db, studentId, classId, policy);
  if (!check.shouldAutoDrop) return null;

  const enrollment = stmtGetStudentEnrollmentForClass.get(studentId, classId) as { id: string } | undefined;
  if (!enrollment) return null;

  try {
    enrollmentServiceForAutoDrop.drop(enrollment.id, {
      reason: `Automatic drop: ${check.consecutiveAbsences} consecutive absences (policy threshold: ${check.threshold}).`,
      actorUserId,
    });
    return { studentId, enrollmentId: enrollment.id, consecutiveAbsences: check.consecutiveAbsences };
  } catch {
    return null;
  }
}

sessionsRouter.post(
  '/:id/roster',
  authorize('registrar', 'manager', 'head_of_department', 'teacher'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);
    assertSessionStartedForAttendance(session);

    const cls = stmtGetClassById.get(session.class_id) as any;
    assertClassActivatedForAttendance(cls || {});

    if (session.status === 'completed' && !hasAnyLegacyRole(req, ['manager', 'owner', 'registrar'])) {
      throw new HttpError(400, 'Session is completed. Only managers can correct attendance.');
    }

    const { records } = req.body as { records: { studentId: string; status: AttendanceStatus; lateMinutes?: number }[] };
    if (!Array.isArray(records) || records.length === 0) throw new HttpError(400, 'records array is required and must not be empty.');
    const uniqueStudentIds = new Set<string>();
    for (const rec of records) {
      if (!rec?.studentId || uniqueStudentIds.has(rec.studentId)) throw new HttpError(400, 'Each attendance record must contain a unique studentId.');
      uniqueStudentIds.add(rec.studentId);
      const roster = stmtGetRosterByStudent.get(req.params.id, rec.studentId) as any;
      if (!roster) throw new HttpError(409, `Student ${rec.studentId} is not enrolled in this session roster.`);
    }

    // Bulk marking never accepts 'not_marked' — that's the absence of a
    // mark, not an intentional one (matches the pre-Phase-2 behavior, which
    // also excluded it here while allowing it on the single-roster PATCH).
    for (const rec of records) {
      if (rec.status === 'not_marked' || !ATTENDANCE_STATUSES.includes(rec.status)) {
        throw new HttpError(400, `Invalid attendance status: "${rec.status}".`);
      }
    }

    const policy = getAttendancePolicy(session.branch_id);
    const now = new Date().toISOString();
    const autoDrops: ReturnType<typeof checkAndApplyAutoDrop>[] = [];

    const tx = db.transaction(() => {
      for (const rec of records) {
        const weight = computeAttendanceWeight(rec.status, rec.lateMinutes, policy);
        stmtUpdateRoster.run(rec.status, rec.lateMinutes ?? null, weight, now, req.params.id, rec.studentId);
        stmtDeleteLegacyAttendance.run(session.date, rec.studentId, req.params.id);
        stmtInsertLegacyAttendance.run(id('at'), session.date, rec.studentId, rec.status, session.class_id, req.params.id, session.branch_id);

        if (rec.status === 'absent') {
          autoDrops.push(checkAndApplyAutoDrop(rec.studentId, session.class_id, policy, user.userId));
        }
      }
      // Auto-drop mutations and the attendance event are one transaction so a
      // crash cannot leave the attendance state without its durable event.
      const triggeredDrops = autoDrops.filter((d): d is NonNullable<typeof d> => d !== null);
      return eventBus.emit('attendance.marked', 'session', req.params.id, { classId: session.class_id, date: session.date, recordCount: records.length }, { operatorId: user.userId, branchId: session.branch_id });
    });
    const event = tx();

    const triggeredDrops = autoDrops.filter((d): d is NonNullable<typeof d> => d !== null);
    void eventBus.dispatch(event);

    writeAudit(req, `Marked attendance for ${records.length} students in session ${req.params.id}` + (triggeredDrops.length ? `; auto-dropped ${triggeredDrops.length} student(s) for consecutive absences` : ''));
    res.status(201).json({ ok: true, count: records.length, autoDrops: triggeredDrops });
  })
);

sessionsRouter.patch(
  '/:id/roster/:rosterId',
  authorize('registrar', 'manager', 'head_of_department', 'teacher'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);
    assertSessionStartedForAttendance(session);

    const cls = stmtGetClassById.get(session.class_id) as any;
    assertClassActivatedForAttendance(cls || {});

    const roster = stmtGetRoster.get(req.params.rosterId, req.params.id) as any;
    if (!roster) throw new HttpError(404, 'Roster entry not found.');

    const { status, lateMinutes } = req.body as { status: AttendanceStatus; lateMinutes?: number };
    if (!ATTENDANCE_STATUSES.includes(status)) {
      throw new HttpError(400, `Invalid attendance status: "${status}".`);
    }

    const policy = getAttendancePolicy(session.branch_id);
    const weight = status === 'not_marked' ? null : computeAttendanceWeight(status, lateMinutes, policy);
    stmtUpdateRosterById.run(status, lateMinutes ?? null, weight, new Date().toISOString(), req.params.rosterId);

    let autoDrop = null;
    if (status === 'absent') {
      autoDrop = checkAndApplyAutoDrop(roster.student_id, session.class_id, policy, user.userId);
    }

    writeAudit(req, `Updated roster entry ${req.params.rosterId} to "${status}"` + (autoDrop ? `; auto-dropped student for consecutive absences` : ''));
    res.json({ ok: true, autoDrop });
  })
);

sessionsRouter.post(
  '/:id/sync-roster',
  authorize('registrar', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const session = requireSession(req, req.params.id);
    if (session.status === 'cancelled') throw new HttpError(400, 'Cannot sync roster on a cancelled session.');
    
    const studentIds = activeStudentIdsForClass(session.class_id);
    const existing = new Set((stmtGetExistingRosterSids.all(session.id) as { sid: string }[]).map((r) => r.sid));
    let added = 0;
    
    const tx = db.transaction(() => {
      for (const studentId of studentIds) {
        if (existing.has(studentId)) continue;
        stmtInsertRoster.run(id('ros'), session.id, studentId);
        added += 1;
      }
    });
    tx();
    
    writeAudit(req, `Synced roster for session ${session.id}: +${added} student(s)`);
    res.json({ ok: true, added });
  })
);

// ============================================================================
// §3 — HOMEWORK
// ============================================================================

sessionsRouter.get(
  '/:id/homework',
  requirePermission('Session.View'),
  ah(async (req, res) => {
    requireSession(req, req.params.id);
    const rows = stmtGetHomework.all(req.params.id) as any[];
    res.json(rows.map((h) => ({
      id: h.id, sessionId: h.session_id, title: h.title, description: h.description, dueDate: h.due_date, assignedBy: h.assigned_by, createdAt: h.created_at,
    })));
  })
);

sessionsRouter.post(
  '/:id/homework',
  authorize('teacher', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);

    const { title, description, dueDate } = req.body;
    if (!title || !dueDate) throw new HttpError(400, 'title and dueDate are required.');

    const newId = id('hw');
    stmtInsertHomework.run(newId, req.params.id, title, description || null, dueDate, user.fullName);

    writeAudit(req, `Assigned homework "${title}" for session ${req.params.id}`);
    res.status(201).json({ id: newId });
  })
);

sessionsRouter.delete(
  '/:id/homework/:homeworkId',
  authorize('teacher', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);
    const hw = stmtGetHomeworkById.get(req.params.homeworkId, req.params.id) as any;
    if (!hw) throw new HttpError(404, 'Homework not found.');

    stmtDeleteHomeworkById.run(req.params.homeworkId);
    writeAudit(req, `Deleted homework "${hw.title}" from session ${req.params.id}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §3.1 — QUIZZES (mirrors §3 HOMEWORK exactly)
// ============================================================================

sessionsRouter.get(
  '/:id/quizzes',
  requirePermission('Session.View'),
  ah(async (req, res) => {
    requireSession(req, req.params.id);
    const rows = stmtGetQuizzes.all(req.params.id) as any[];
    res.json(rows.map((q) => ({
      id: q.id, sessionId: q.session_id, title: q.title, description: q.description,
      maxScore: q.max_score, dueDate: q.due_date, assignedBy: q.assigned_by, createdAt: q.created_at,
    })));
  })
);

sessionsRouter.post(
  '/:id/quizzes',
  authorize('teacher', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);

    const { title, description, maxScore, dueDate } = req.body;
    if (!title) throw new HttpError(400, 'title is required.');

    const newId = id('quiz');
    stmtInsertQuiz.run(newId, req.params.id, title, description || null, maxScore ?? null, dueDate || null, user.fullName);

    writeAudit(req, `Added quiz "${title}" for session ${req.params.id}`);
    res.status(201).json({ id: newId });
  })
);

sessionsRouter.delete(
  '/:id/quizzes/:quizId',
  authorize('teacher', 'manager', 'head_of_department'),
  ah(async (req, res) => {
    const session = requireSession(req, req.params.id);
    assertCanMarkSession(req, session);
    const quiz = stmtGetQuizById.get(req.params.quizId, req.params.id) as any;
    if (!quiz) throw new HttpError(404, 'Quiz not found.');

    stmtDeleteQuizById.run(req.params.quizId);
    writeAudit(req, `Deleted quiz "${quiz.title}" from session ${req.params.id}`);
    res.json({ ok: true });
  })
);

// ============================================================================
// §4 — SESSION ANALYTICS
// ============================================================================

const ATTENDED_STATUS_PLACEHOLDERS = ATTENDED_EQUIVALENT_STATUSES.map(() => '?').join(',');

sessionsRouter.get(
  '/analytics/attendance-rate',
  requirePermission('Session.View', 'Attendance.View'),
  ah(async (req, res) => {
    const { classId, from, to } = req.query as Record<string, string>;
    if (!classId) throw new HttpError(400, 'classId is required.');
    const classRow = stmtGetClassById.get(classId) as any;
    if (!classRow) throw new HttpError(404, 'Class not found.');
    if (!canAccessBranchResource(req, classRow.branch_id)) throw new HttpError(403, 'Class belongs to another branch.');
    // Numerator uses attendance_weight when available (reflects the
    // half-absence policy — a 'late' mark past the half-absence threshold
    // only contributes 0.5), falling back to a plain attended/not split for
    // rows marked before Phase 2 (attendance_weight is NULL there).
    let sql = `SELECT COUNT(*) AS totalMarks,
      SUM(COALESCE(r.attendance_weight, CASE WHEN r.attendance_status IN (${ATTENDED_STATUS_PLACEHOLDERS}) THEN 1 ELSE 0 END)) AS attended
      FROM rosters r JOIN sessions s ON s.id = r.session_id WHERE s.class_id = ? AND s.status = 'completed'`;
    const params: unknown[] = [...ATTENDED_EQUIVALENT_STATUSES, classId];
    if (from && to) { sql += ' AND s.date BETWEEN ? AND ?'; params.push(from, to); }

    const row = db.prepare(sql).get(...params) as any;
    const totalMarks = row.totalMarks || 0;
    const attended = row.attended || 0;
    res.json({ classId, totalMarks, attended, attendanceRate: totalMarks > 0 ? Math.round((attended / totalMarks) * 1000) / 10 : 0 });
  })
);

sessionsRouter.get(
  '/analytics/student-attendance',
  requirePermission('Session.View', 'Attendance.View'),
  ah(async (req, res) => {
    const { classId, from, to } = req.query as Record<string, string>;
    if (!classId) throw new HttpError(400, 'classId is required.');
    const classRow = stmtGetClassById.get(classId) as any;
    if (!classRow) throw new HttpError(404, 'Class not found.');
    if (!canAccessBranchResource(req, classRow.branch_id)) throw new HttpError(403, 'Class belongs to another branch.');

    let sql = `SELECT r.student_id, st.full_name AS student_name, st.student_code, COUNT(*) AS totalSessions,
      SUM(CASE WHEN r.attendance_status = 'present' THEN 1 ELSE 0 END) AS presentCount,
      SUM(CASE WHEN r.attendance_status = 'late' THEN 1 ELSE 0 END) AS lateCount,
      SUM(CASE WHEN r.attendance_status = 'absent' THEN 1 ELSE 0 END) AS absentCount,
      SUM(CASE WHEN r.attendance_status IN ('medical_leave','sick') THEN 1 ELSE 0 END) AS medicalLeaveCount,
      SUM(CASE WHEN r.attendance_status IN ('excused','leave') THEN 1 ELSE 0 END) AS excusedCount,
      SUM(COALESCE(r.attendance_weight, CASE WHEN r.attendance_status IN (${ATTENDED_STATUS_PLACEHOLDERS}) THEN 1 ELSE 0 END)) AS weightedAttended
      FROM rosters r JOIN sessions s ON s.id = r.session_id JOIN students st ON st.id = r.student_id WHERE s.class_id = ? AND s.status = 'completed'`;
    const params: unknown[] = [...ATTENDED_EQUIVALENT_STATUSES, classId];
    if (from && to) { sql += ' AND s.date BETWEEN ? AND ?'; params.push(from, to); }
    sql += ' GROUP BY r.student_id ORDER BY st.full_name ASC';

    const rows = db.prepare(sql).all(...params) as any[];
    res.json(rows.map((r) => ({
      studentId: r.student_id, studentName: r.student_name, studentCode: r.student_code,
      totalSessions: r.totalSessions, presentCount: r.presentCount, lateCount: r.lateCount, absentCount: r.absentCount,
      medicalLeaveCount: r.medicalLeaveCount, excusedCount: r.excusedCount,
      attendanceRate: r.totalSessions > 0 ? Math.round((r.weightedAttended / r.totalSessions) * 1000) / 10 : 0,
    })));
  })
);

export default sessionsRouter;