import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney } from '../utils/money.js';
import { assertOptionalIsoDate, assertDateRange } from '../utils/isoDate.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { contractPaysPerSkill, normalizeContractType } from '../core/payroll/class-payroll.js';

export const skillsRouter = Router();
skillsRouter.use(authenticate);

export const classTeacherSkillsRouter = Router();
classTeacherSkillsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetAllSkills = db.prepare('SELECT * FROM skills ORDER BY name');
const stmtGetSkillByName = db.prepare('SELECT id FROM skills WHERE name = ?');
const stmtInsertSkill = db.prepare('INSERT INTO skills (id, name) VALUES (?, ?)');

// One scope-aware listing query replaces four near-identical branch/filter
// permutations. `isAll` comes from resolveBranchScope, so a user authorized
// across several branches sees all of them instead of only their home branch.
const stmtListCts = db.prepare(
  `SELECT * FROM class_teacher_skills
    WHERE (:isAll = 1 OR branch_id = :branchId)
      AND (:teacherId IS NULL OR teacher_id = :teacherId)
      AND (:classId IS NULL OR class_id = :classId)`
);

const stmtGetTeacherById = db.prepare('SELECT * FROM teachers WHERE id = ?');
const stmtCountDistinctSkillsInClass = db.prepare(`SELECT COUNT(DISTINCT skill_id) as c FROM class_teacher_skills WHERE class_id = ? AND assignment_type IN ('primary','assistant')`);
const stmtGetCtsByClassAndSkill = db.prepare(`SELECT id FROM class_teacher_skills WHERE class_id = ? AND skill_id = ? AND assignment_type IN ('primary','assistant')`);
// Class-scoped duplicate check (session_id IS NULL): SQLite treats every
// NULL as distinct in a UNIQUE index, so the table's own constraint can no
// longer catch two class-scoped rows for the same class+teacher+skill now
// that session_id participates in it — re-enforced here at the app layer.
const stmtGetClassScopedCts = db.prepare('SELECT id FROM class_teacher_skills WHERE class_id = ? AND teacher_id = ? AND skill_id = ? AND session_id IS NULL');
const stmtInsertCts = db.prepare(
  `INSERT INTO class_teacher_skills (id, class_id, teacher_id, skill_id, monthly_rate, branch_id, assignment_type, start_date, end_date, reason, session_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetCtsById = db.prepare('SELECT * FROM class_teacher_skills WHERE id = ?');
const stmtUpdateCtsFull = db.prepare(
  `UPDATE class_teacher_skills SET monthly_rate = ?, assignment_type = ?, start_date = ?, end_date = ?, reason = ? WHERE id = ?`
);
const stmtDeleteCts = db.prepare('DELETE FROM class_teacher_skills WHERE id = ?');
const stmtGetSessionForCts = db.prepare('SELECT id, class_id, branch_id, date FROM sessions WHERE id = ?');

const ASSIGNMENT_TYPES = ['primary', 'assistant', 'substitute', 'guest', 'examiner'] as const;
/** Ongoing, ordinarily-paid roles — these feed automatic monthly payroll
 *  (see core/payroll/class-payroll.ts). Substitute/guest/examiner are
 *  one-off by nature and are deliberately excluded from that automatic
 *  calculation — see the Phase 8 report for why. */
const PAYROLL_ELIGIBLE_TYPES = ['primary', 'assistant'];

/** Safely extracts user context required for mutations. */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.branchId) {
    throw new HttpError(403, 'User branch context is missing.');
  }
  return user;
}

// ============================================================================
// §1 — SKILLS CATALOG
// ============================================================================

/** GET /api/skills — List all available skills */
skillsRouter.get(
  '/',
  requirePermission('Teacher.View', 'Class.View', 'Student.View', 'AcademicSetup.View'),
  ah(async (_req, res) => {
    res.json(stmtGetAllSkills.all());
  })
);

/** POST /api/skills — Create a new skill (Manager/HoD only) */
skillsRouter.post(
  '/',
  authorize('general_manager', 'head_of_department'),
  ah(async (req, res) => {
    const { name } = req.body;
    if (!name || !String(name).trim()) throw new HttpError(400, 'Skill name is required.');
    
    const trimmedName = String(name).trim();
    if (stmtGetSkillByName.get(trimmedName)) {
      throw new HttpError(409, 'Skill already exists.');
    }
    
    const newId = id('sk');
    stmtInsertSkill.run(newId, trimmedName);
    writeAudit(req, `Added skill: ${trimmedName}`);
    res.status(201).json({ id: newId, name: trimmedName });
  })
);

// ============================================================================
// §2 — CLASS-TEACHER-SKILL ASSIGNMENTS
// ============================================================================

function mapAssignment(row: any) {
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    skillId: row.skill_id,
    monthlyRate: row.monthly_rate,
    branchId: row.branch_id,
    assignmentType: row.assignment_type,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason,
    sessionId: row.session_id,
  };
}

/** GET /api/class-teacher-skills — List assignments with optional filters */
classTeacherSkillsRouter.get(
  '/',
  authorize('general_manager', 'head_of_department', 'receptionist', 'finance_manager', 'owner'),
  ah(async (req, res) => {
    const { teacherId, classId } = req.query as Record<string, string>;
    const { branchId, isAll } = resolveBranchScope(req);
    const rows = stmtListCts.all({
      isAll: isAll ? 1 : 0,
      branchId: branchId ?? null,
      teacherId: teacherId || null,
      classId: classId || null,
    }) as any[];
    res.json(rows.map(mapAssignment));
  })
);

/**
POST /api/class-teacher-skills
Record a SKILL — assign a teacher to a skill in a class (their teaching
workload for that class).

Business Rules:
  - Max 3 distinct ongoing skill teachers per class.
  - EVERY contract type can record Skills. Contract type governs pay only.
  - A monthly rate is required only where the contract actually pays per
    Skill (per_skill / hybrid / per_level).
*/
classTeacherSkillsRouter.post(
  '/',
  authorize('general_manager', 'head_of_department'),
  ah(async (req, res) => {
    getUserContext(req);
    const { classId, teacherId, skillId, monthlyRate, assignmentType, startDate, endDate, reason, sessionId } = req.body;
    
    if (!classId || !teacherId || !skillId) {
      throw new HttpError(400, 'classId, teacherId, and skillId are required.');
    }
    const resolvedType = assignmentType || 'primary';
    if (!ASSIGNMENT_TYPES.includes(resolvedType)) {
      throw new HttpError(400, `Invalid assignmentType: "${resolvedType}". Must be one of: ${ASSIGNMENT_TYPES.join(', ')}.`);
    }

    const teacher = stmtGetTeacherById.get(teacherId) as any;
    if (!teacher) throw new HttpError(404, 'Teacher not found.');
    if (!canAccessBranchResource(req, teacher.branch_id)) throw new HttpError(403, 'Teacher belongs to another branch.');
    const cls = db.prepare('SELECT id, branch_id, status, lifecycle_stage FROM classes WHERE id = ?').get(classId) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');
    if (!canAccessBranchResource(req, cls.branch_id)) throw new HttpError(403, 'Class belongs to another branch.');
    // The teaching work happens where the CLASS is, so the class branch owns
    // the assignment. Deriving it from the operator's home branch instead
    // mis-filed every assignment a multi-branch user created.
    if (teacher.branch_id !== cls.branch_id) throw new HttpError(400, 'Teacher and class must belong to the same branch.');
    const assignmentBranchId = cls.branch_id;
    if (cls.status === 'cancelled' || cls.lifecycle_stage === 'archived') throw new HttpError(409, 'Cannot assign a teacher to a cancelled or archived class.');
    const skill = db.prepare('SELECT id FROM skills WHERE id = ?').get(skillId) as any;
    if (!skill) throw new HttpError(404, 'Skill not found.');

    let sessionDate: string | null = null;
    if (sessionId) {
      const session = stmtGetSessionForCts.get(sessionId) as any;
      if (!session) throw new HttpError(404, 'Session not found.');
      if (session.class_id !== classId) throw new HttpError(400, 'sessionId does not belong to the specified class.');
      if (session.branch_id !== assignmentBranchId) throw new HttpError(400, 'Session belongs to another branch.');
      sessionDate = session.date;
    }
    // A teacher must be employable to receive new teaching work. This is an
    // employment-status rule, NOT a contract-type rule.
    if (teacher.status !== 'active') {
      throw new HttpError(400, 'Only an active teacher can be assigned new teaching work.');
    }
    const normalizedStart = assertOptionalIsoDate(startDate, 'startDate');
    const normalizedEnd = assertOptionalIsoDate(endDate, 'endDate');
    assertDateRange(normalizedStart, normalizedEnd, 'startDate', 'endDate');
    if (sessionDate && ((normalizedStart && normalizedStart > sessionDate) || (normalizedEnd && normalizedEnd < sessionDate))) {
      throw new HttpError(400, 'Assignment dates must include the linked session date.');
    }

    // ── SKILL != CONTRACT TYPE ───────────────────────────────────────────
    // A Skill records the teacher's ACTUAL TEACHING WORKLOAD. The contract
    // type decides only how the teacher is PAID. All five contract types
    // (fixed, per_skill, per_session, hybrid, per_level) therefore record
    // Skills identically; a fixed-contract teacher must never lose, skip or
    // become ineligible for Skills. Compensation is resolved later and
    // independently by core/payroll/class-payroll.ts.

    // Resolve Monthly Rate — the rate is a COMPENSATION attribute, so it is
    // only meaningful for contracts whose rule actually pays per Skill.
    // Contracts with no per-Skill component (fixed, per_session) legitimately
    // carry rate 0: the workload is recorded, the salary comes from elsewhere.
    // One-off roles (substitute/guest/examiner) may also be unpaid or
    // compensated outside the monthly-rate mechanism.
    const paysPerSkill = contractPaysPerSkill(normalizeContractType(teacher.salary_type));
    // `Number(x)` here accepted 'abc' as NaN and only the follow-up isFinite
    // check caught it, while 1e15 passed entirely. Route it through the one
    // monetary boundary so every rejection reason is consistent.
    const resolvedRate = monthlyRate != null
      ? assertMoney(monthlyRate, 'monthlyRate')
      : assertMoney(teacher.default_skill_rate ?? 0, 'monthlyRate');
    if (resolvedRate <= 0 && paysPerSkill && PAYROLL_ELIGIBLE_TYPES.includes(resolvedType)) {
      throw new HttpError(400, 'monthlyRate is required for a primary/assistant assignment on a Skill-paid contract (or set defaultSkillRate on the teacher contract).');
    }

    // Business Rule: Max 3 distinct ongoing (primary/assistant) skill
    // teachers per class — substitute/guest/examiner assignments are
    // one-off and don't count toward this cap.
    if (PAYROLL_ELIGIBLE_TYPES.includes(resolvedType)) {
      const skillCount = (stmtCountDistinctSkillsInClass.get(classId) as { c: number }).c;
      const sameSkill = stmtGetCtsByClassAndSkill.get(classId, skillId) as { id?: string } | undefined;
      if (!sameSkill && skillCount >= 3) {
        throw new HttpError(409, 'A class can have at most 3 skill teachers (e.g. Listening/Speaking, Writing/Grammar, Reading/Vocabulary).');
      }
    }

    // App-level duplicate check for class-scoped assignments (see the
    // stmtGetClassScopedCts comment above for why this can't be left to
    // the DB constraint alone anymore).
    if (!sessionId && stmtGetClassScopedCts.get(classId, teacherId, skillId)) {
      throw new HttpError(409, 'This teacher already has a class-scoped assignment for this skill in this class.');
    }

    const newId = id('cts');
    try {
      stmtInsertCts.run(newId, classId, teacherId, skillId, resolvedRate, assignmentBranchId, resolvedType, normalizedStart, normalizedEnd, reason || null, sessionId || null);
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) {
        throw new HttpError(409, 'This teacher is already assigned to this skill in this class (and session, if specified).');
      }
      throw err; // Re-throw unexpected errors
    }
    
    writeAudit(req, `Assigned ${resolvedType} skill ${skillId} to teacher ${teacher.full_name} for class ${classId}${sessionId ? ` (session ${sessionId})` : ''} at ${resolvedRate} AFN/month`);
    res.status(201).json({ id: newId, monthlyRate: resolvedRate, assignmentType: resolvedType });
  })
);

/** PUT /api/class-teacher-skills/:id — Update an assignment's rate and/or details */
classTeacherSkillsRouter.put(
  '/:id',
  authorize('general_manager', 'head_of_department'),
  ah(async (req, res) => {
    getUserContext(req);
    const existing = stmtGetCtsById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Assignment not found.');
    if (!canAccessBranchResource(req, existing.branch_id)) throw new HttpError(403, 'Assignment belongs to another branch.');
    
    const { monthlyRate, assignmentType, startDate, endDate, reason } = req.body;
    if (monthlyRate == null && assignmentType === undefined && startDate === undefined && endDate === undefined && reason === undefined) {
      throw new HttpError(400, 'Nothing to update — provide at least one of monthlyRate, assignmentType, startDate, endDate, or reason.');
    }
    if (assignmentType !== undefined && !ASSIGNMENT_TYPES.includes(assignmentType)) {
      throw new HttpError(400, `Invalid assignmentType: "${assignmentType}". Must be one of: ${ASSIGNMENT_TYPES.join(', ')}.`);
    }
    const nextType = assignmentType ?? existing.assignment_type;
    const nextRate = monthlyRate != null ? assertMoney(monthlyRate, 'monthlyRate') : Number(existing.monthly_rate) || 0;
    // Same rule as creation: a rate is only required where the contract's
    // compensation rule actually pays per Skill. A fixed/per_session teacher
    // keeps a legitimate rate of 0 — the Skill is workload, not pay.
    const assignmentTeacher = stmtGetTeacherById.get(existing.teacher_id) as any;
    const editPaysPerSkill = contractPaysPerSkill(normalizeContractType(assignmentTeacher?.salary_type));
    if (editPaysPerSkill && PAYROLL_ELIGIBLE_TYPES.includes(nextType) && nextRate <= 0) {
      throw new HttpError(400, 'Primary/assistant assignments on a Skill-paid contract require a positive monthly rate.');
    }
    const nextStart = startDate !== undefined
      ? assertOptionalIsoDate(startDate, 'startDate')
      : existing.start_date;
    const nextEnd = endDate !== undefined
      ? assertOptionalIsoDate(endDate, 'endDate')
      : existing.end_date;
    assertDateRange(nextStart, nextEnd, 'startDate', 'endDate');
    if (existing.session_id) {
      const linkedSession = stmtGetSessionForCts.get(existing.session_id) as { date: string } | undefined;
      if (!linkedSession) throw new HttpError(409, 'Linked session no longer exists.');
      if ((nextStart && nextStart > linkedSession.date) || (nextEnd && nextEnd < linkedSession.date)) {
        throw new HttpError(400, 'Assignment dates must include the linked session date.');
      }
    }
    if (nextType !== existing.assignment_type && !existing.session_id && stmtGetClassScopedCts.get(existing.class_id, existing.teacher_id, existing.skill_id)) {
      const duplicate = db.prepare(`SELECT id FROM class_teacher_skills WHERE class_id = ? AND teacher_id = ? AND skill_id = ? AND session_id IS NULL AND id != ?`).get(existing.class_id, existing.teacher_id, existing.skill_id, existing.id);
      if (duplicate) throw new HttpError(409, 'Another class-scoped assignment already exists for this teacher and skill.');
    }

    // PATCH semantics: a request carrying only monthlyRate leaves every other
    // field unchanged via the ?? fallback.
    try {
      stmtUpdateCtsFull.run(
        nextRate,
        nextType,
        nextStart,
        nextEnd,
        reason !== undefined ? reason : existing.reason,
        req.params.id
      );
    } catch (err: any) {
      if (String(err?.message).includes('ongoing skill limit')) {
        throw new HttpError(409, 'A class may have at most three distinct ongoing primary/assistant skills.');
      }
      if (String(err?.message).includes('UNIQUE')) {
        throw new HttpError(409, 'Another assignment already owns this class, teacher, skill and session identity.');
      }
      throw err;
    }
    writeAudit(req, `Updated skill assignment ${req.params.id}` + (monthlyRate != null ? ` (rate: ${monthlyRate} AFN)` : ''));
    res.json({ ok: true });
  })
);

/** DELETE /api/class-teacher-skills/:id — Remove an assignment */
classTeacherSkillsRouter.delete(
  '/:id',
  authorize('general_manager', 'head_of_department'),
  ah(async (req, res) => {
    getUserContext(req);
    const existing = stmtGetCtsById.get(req.params.id) as any;
    if (!existing) throw new HttpError(404, 'Assignment not found.');
    
    if (!canAccessBranchResource(req, existing.branch_id)) throw new HttpError(403, 'Assignment belongs to another branch.');
    stmtDeleteCts.run(req.params.id);
    writeAudit(req, `Removed teacher skill assignment from class ${existing.class_id}`);
    res.json({ ok: true });
  })
);

/**
 * Teacher replacement convenience endpoint (blueprint §8: "Supports: ...
 * Teacher replacement"). Creates a substitute-type assignment scoped to a
 * specific session, referencing the ongoing assignment being covered.
 * Mirrors the makeup-creation pattern from Phases 2 (sessions) and 3
 * (assessments): a reason is required (matching the Freeze/withdraw
 * pattern of requiring one for consequential actions), rate defaults to 0
 * (a substitute's compensation is frequently handled outside the ongoing
 * monthly-rate mechanism — see PAYROLL_ELIGIBLE_TYPES).
 */
classTeacherSkillsRouter.post(
  '/:id/substitute',
  authorize('general_manager', 'head_of_department'),
  ah(async (req, res) => {
    getUserContext(req);
    const original = stmtGetCtsById.get(req.params.id) as any;
    if (!original) throw new HttpError(404, 'Assignment not found.');
    if (!canAccessBranchResource(req, original.branch_id)) throw new HttpError(403, 'Assignment belongs to another branch.');

    const { substituteTeacherId, sessionId, reason, monthlyRate } = req.body;
    if (!substituteTeacherId || !sessionId) throw new HttpError(400, 'substituteTeacherId and sessionId are required.');
    if (!reason) throw new HttpError(400, 'A reason is required for a teacher replacement.');

    const session = stmtGetSessionForCts.get(sessionId) as any;
    if (!session) throw new HttpError(404, 'Session not found.');
    if (session.class_id !== original.class_id) throw new HttpError(400, 'sessionId does not belong to the same class as the original assignment.');

    const teacher = stmtGetTeacherById.get(substituteTeacherId) as any;
    if (!teacher) throw new HttpError(404, 'Substitute teacher not found.');
    if (teacher.branch_id !== original.branch_id) throw new HttpError(400, 'Substitute teacher belongs to another branch.');
    if (session.branch_id !== original.branch_id) throw new HttpError(400, 'Session belongs to another branch.');
    if (teacher.status !== 'active') throw new HttpError(400, 'Substitute teacher must be active.');
    const resolvedRate = monthlyRate == null ? 0 : assertMoney(monthlyRate, 'monthlyRate');

    const newId = id('cts');
    try {
      stmtInsertCts.run(
        newId, original.class_id, substituteTeacherId, original.skill_id,
        resolvedRate, original.branch_id,
        'substitute', session.date ?? null, session.date ?? null, reason, sessionId
      );
    } catch (err: any) {
      if (String(err.message).includes('UNIQUE')) {
        throw new HttpError(409, 'This teacher already has a substitute assignment for this session and skill.');
      }
      throw err;
    }

    writeAudit(req, `Assigned ${teacher.full_name} as substitute for session ${sessionId} (covering assignment ${original.id}): ${reason}`);
    res.status(201).json({ id: newId });
  })
);


export default skillsRouter;