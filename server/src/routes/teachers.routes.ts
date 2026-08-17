/**
 * TOEFL House ERP — Teachers & Employees Routes (BC #7 & #8)
 * Handles the FIVE teacher contract types, the 100-point evaluation system,
 * and Rule Engine integration.
 *
 * SKILL != CONTRACT TYPE: a Skill records teaching workload; the contract
 * type decides only how the teacher is paid. See core/payroll/class-payroll.ts.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { assertMoney } from '../utils/money.js';
import { addNotification } from '../utils/notifications.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import {
  computeTeacherDueAmount, toPeriodKey, currentJalaliPeriodKey,
  sumPaidForPeriod, hasFullPayForPeriod, teacherBranchAsOf,
  CONTRACT_TYPES,
} from '../core/payroll/class-payroll.js';
import { jalaliPeriodLabel } from '../utils/jalali.js';
import { resolveIdempotency, isUniqueViolation } from '../utils/idempotency.js';

export const teachersRouter = Router();
teachersRouter.use(authenticate);

export const employeesRouter = Router();
employeesRouter.use(authenticate);

// ── Type Definitions ───────────────────────────────────────────────────────
interface TeacherRow {
  id: string; full_name: string; phone: string | null; email: string | null;
  base_salary: number; salary_type: string; performance_score: number;
  status: string; branch_id: string; joined_date: string;
  specialization: string | null; qualification: string | null;
  contract_type: string | null; default_skill_rate: number; user_id: string | null;
  target_skills_per_month?: number;
}

interface EmployeeRow {
  id: string; full_name: string; phone: string | null; email: string | null;
  role: string; base_salary: number; status: string; branch_id: string;
  joined_date: string; user_id: string | null;
}

interface BudgetRow {
  id: string; name: string; current_amount: number; purpose: string | null;
}

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetTeacherById = db.prepare('SELECT *, COALESCE(default_skill_rate, 0) AS default_skill_rate FROM teachers WHERE id = ?');
const stmtGetEmployeeById = db.prepare('SELECT * FROM employees WHERE id = ?');
const stmtGetAllTeachers = db.prepare('SELECT * FROM teachers ORDER BY full_name');
const stmtGetTeachersByBranch = db.prepare('SELECT * FROM teachers WHERE branch_id = ? ORDER BY full_name');
const stmtGetAllEmployees = db.prepare('SELECT * FROM employees ORDER BY full_name');
const stmtGetEmployeesByBranch = db.prepare('SELECT * FROM employees WHERE branch_id = ? ORDER BY full_name');

const stmtCountActiveClassesForTeacher = db.prepare(`SELECT COUNT(DISTINCT class_id) AS c FROM (
  SELECT id AS class_id FROM classes WHERE teacher_id = ? AND status = 'active'
  UNION
  SELECT cts.class_id FROM class_teacher_skills cts JOIN classes c ON c.id = cts.class_id
  WHERE cts.teacher_id = ? AND cts.assignment_type IN ('primary','assistant') AND c.status = 'active'
)`);
const stmtCountSkillsForTeacher = db.prepare("SELECT COUNT(*) as c FROM class_teacher_skills WHERE teacher_id = ?");
const stmtGetActiveTeacherClasses = db.prepare("SELECT id, name, branch_id, status FROM classes WHERE teacher_id = ? AND status = 'active' ORDER BY name");
const stmtGetActiveTeacherAssignments = db.prepare(`SELECT cts.id, cts.class_id, cts.skill_id, cts.assignment_type, cts.session_id, cts.start_date, cts.end_date, c.name AS class_name FROM class_teacher_skills cts JOIN classes c ON c.id = cts.class_id WHERE cts.teacher_id = ? AND cts.assignment_type IN ('primary','assistant') AND (cts.end_date IS NULL OR cts.end_date >= date('now'))`);

const stmtInsertTeacher = db.prepare(
  `INSERT INTO teachers (id, full_name, phone, email, base_salary, salary_type, performance_score, status, branch_id, joined_date, specialization, qualification, contract_type, default_skill_rate, target_skills_per_month) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
);
const stmtUpdateTeacher = db.prepare(
  `UPDATE teachers SET full_name=?, phone=?, email=?, base_salary=?, salary_type=?, specialization=?, qualification=?, contract_type=?, status=?, default_skill_rate=COALESCE(?, default_skill_rate), performance_score=?, target_skills_per_month=COALESCE(?, target_skills_per_month) WHERE id=?`
);

const stmtGetBranchById = db.prepare('SELECT id, name, is_active, campus_id FROM branches WHERE id = ?');
const stmtGetBranchDetailsForTransfer = db.prepare(`SELECT b.id, b.name, b.code, b.is_active, b.campus_id, c.name AS campus_name, c.code AS campus_code FROM branches b LEFT JOIN campuses c ON c.id = b.campus_id WHERE b.id = ?`);
const stmtUpdateTeacherBranch = db.prepare('UPDATE teachers SET branch_id = ? WHERE id = ?');
const stmtUpdateUserBranchForTeacher = db.prepare('UPDATE users SET branch_id = ? WHERE linked_teacher_id = ?');
const stmtDeactivateLinkedTeacherUser = db.prepare('UPDATE users SET is_active = 0 WHERE linked_teacher_id = ?');
const stmtGetTeacherSalaryByIdempotency = db.prepare('SELECT id, teacher_id, period_key, due_amount, paid_amount, payment_type, transaction_id, branch_id, status FROM teacher_salary_ledger WHERE idempotency_key = ?');
const stmtGetSalaryLedger = db.prepare('SELECT * FROM teacher_salary_ledger WHERE id = ? AND teacher_id = ?');
const stmtVoidSalaryLedger = db.prepare(`UPDATE teacher_salary_ledger SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'posted'`);
const stmtInsertSalaryLedgerWithIdempotency = db.prepare(`INSERT INTO teacher_salary_ledger (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, transaction_id, notes, branch_id, operator_name, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')`);
const stmtGetBranchName = db.prepare('SELECT name FROM branches WHERE id = ?');
const stmtInsertTeacherBranchHistory = db.prepare('INSERT INTO teacher_branch_history (id, teacher_id, from_branch_id, to_branch_id, effective_date, reason, operator_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)');

// Payroll & Finance Statements
const stmtGetBudgetByPurpose = db.prepare('SELECT * FROM budget_lines WHERE purpose = ? AND branch_id = ?');
const stmtUpdateBudgetAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?');
const stmtInsertFinTx = db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id) VALUES (?, 'expense', 'salary', ?, ?, ?, ?, ?, ?)`);
const stmtInsertSalaryLedger = db.prepare(`INSERT INTO teacher_salary_ledger (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, transaction_id, notes, branch_id, operator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtInsertCompensationHistory = db.prepare('INSERT INTO teacher_compensation_history (id, teacher_id, effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason, operator_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const stmtInsertEvaluation = db.prepare(`INSERT INTO teacher_evaluations (id, teacher_id, evaluator_id, date, score, criteria, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Employee Statements
const stmtInsertEmployee = db.prepare(`INSERT INTO employees (id, full_name, phone, email, role, base_salary, status, branch_id, joined_date) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
const stmtUpdateEmployee = db.prepare(`UPDATE employees SET full_name=?, phone=?, email=?, role=?, base_salary=?, status=? WHERE id=?`);
const stmtUpdateEmployeeBranch = db.prepare('UPDATE employees SET branch_id = ? WHERE id = ?');
const stmtUpdateUserBranchForEmployee = db.prepare('UPDATE users SET branch_id = ? WHERE linked_employee_id = ?');
const stmtUpdateUserBranchById = db.prepare('UPDATE users SET branch_id = ? WHERE id = ?');
const stmtSoftDeleteEmployee = db.prepare("UPDATE employees SET status = 'inactive' WHERE id = ?");
const stmtCheckDuplicateEmployeePay = db.prepare(`SELECT id FROM financial_transactions WHERE reference_id = ? AND category = 'salary' AND description LIKE ? LIMIT 1`);

/** The five contract types, taken from the payroll engine's single source of
 *  truth so routes, engine and database CHECK can never drift apart again. */
const ALLOWED_SALARY_TYPES: readonly string[] = CONTRACT_TYPES;

/** Safely extract user context */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName || !user?.role) throw new HttpError(403, 'User context missing.');
  return user;
}

function mapTeacher(row: TeacherRow | undefined) {
  if (!row) return row;
  return { 
    id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, baseSalary: row.base_salary, 
    salaryType: row.salary_type, performanceScore: row.performance_score, status: row.status, branchId: row.branch_id, 
    joinedDate: row.joined_date, specialization: row.specialization, qualification: row.qualification, 
    contractType: row.contract_type, defaultSkillRate: row.default_skill_rate ?? 0, userId: row.user_id,
    targetSkillsPerMonth: row.target_skills_per_month ?? 0
  };
}

function mapEmployee(row: EmployeeRow | undefined) {
  if (!row) return row;
  return { 
    id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, role: row.role, 
    baseSalary: row.base_salary, status: row.status, branchId: row.branch_id, joinedDate: row.joined_date, userId: row.user_id 
  };
}

function requireEmployee(req: import('express').Request, employeeId: string): EmployeeRow {
  const row = stmtGetEmployeeById.get(employeeId) as EmployeeRow | undefined;
  if (!row) throw new HttpError(404, 'Employee not found.');
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Employee belongs to another branch.');
  }
  return row;
}

function requireTeacher(req: import('express').Request, teacherId: string): TeacherRow {
  const row = stmtGetTeacherById.get(teacherId) as TeacherRow | undefined;
  if (!row) throw new HttpError(404, 'Teacher not found.');
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && row.branch_id && row.branch_id !== branchId) {
    const cross = !!row.branch_id && canAccessBranchResource(req, row.branch_id);
    if (!cross) throw new HttpError(403, 'Teacher belongs to another branch.');
  }
  return row;
}

// ============================================================================ 
// §1 — TEACHERS 
// ============================================================================ 
teachersRouter.get('/', requirePermission('Teacher.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const rows = (isAll ? stmtGetAllTeachers.all() : stmtGetTeachersByBranch.all(branchId)) as TeacherRow[];
  res.json(rows.map((row) => ({ 
    ...mapTeacher(row), 
    activeClassCount: (stmtCountActiveClassesForTeacher.get(row.id, row.id) as { c: number }).c 
  })));
}));

teachersRouter.post('/', requirePermission('Teacher.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, branchId, defaultSkillRate: bodyDefaultSkillRate } = req.body;
  if (!fullName || !String(fullName).trim()) throw new HttpError(400, 'Full name and a valid non-negative base salary are required.');
  // Finite and non-negative was not enough: 1e15 passed and became a base
  // salary of one quadrillion. assertMoney adds the two-decimal rounding and
  // the safe-integer-cents ceiling every other money field already enforces.
  let numericBaseSalary: number;
  try { numericBaseSalary = assertMoney(baseSalary, 'base salary'); }
  catch { throw new HttpError(400, 'Full name and a valid non-negative base salary are required.'); }
  // Bound free text (see utils/textInput.ts — S16).
  assertTextLengths([
    [fullName, 'Full name', TEXT_LIMITS.name],
    [phone, 'Phone', TEXT_LIMITS.short],
    [email, 'Email', TEXT_LIMITS.email],
    [specialization, 'Specialization', TEXT_LIMITS.line],
    [qualification, 'Qualification', TEXT_LIMITS.line],
  ]);

  const resolvedBranchId = typeof branchId === 'string' && branchId.trim() ? branchId.trim() : user.branchId;
  if (!canAccessBranchResource(req, resolvedBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  const branch = stmtGetBranchById.get(resolvedBranchId) as any;
  if (!branch) throw new HttpError(400, 'Target branch not found.');
  if (!branch.is_active) throw new HttpError(400, 'Cannot assign a teacher to an inactive branch.');

  const resolvedType = salaryType ? (ALLOWED_SALARY_TYPES.includes(salaryType) ? salaryType : (() => { throw new HttpError(400, 'Invalid salary type.'); })()) : 'fixed';
  const allowedContractTypes = ['monthly','hourly','per_session'];
  if (contractType && !allowedContractTypes.includes(contractType)) throw new HttpError(400, 'Invalid contract type.');
  if ((resolvedType === 'per_session') && contractType && contractType !== 'per_session') throw new HttpError(400, 'A per-session salary model requires a per-session contract type.');
  const defaultSkillRate = bodyDefaultSkillRate == null ? 0 : Number(bodyDefaultSkillRate);
  if (!Number.isFinite(defaultSkillRate) || defaultSkillRate < 0) throw new HttpError(400, 'Default skill rate must be a non-negative number.');
  if ((resolvedType === 'per_skill' || resolvedType === 'hybrid') && defaultSkillRate <= 0 && Number(baseSalary) <= 0) {
    throw new HttpError(400, 'A skill-based salary requires a positive base salary or default skill rate.');
  }
  // Monthly workload target (Skills/month). Configuration only — it never
  // changes pay; it drives Target/Actual/Shortfall/Excess reporting.
  const targetSkills = req.body.targetSkillsPerMonth == null ? 0 : Number(req.body.targetSkillsPerMonth);
  if (!Number.isFinite(targetSkills) || targetSkills < 0) throw new HttpError(400, 'Target Skills per month must be a non-negative number.');

  const newId = id('t');
  const tx = db.transaction(() => {
    // New teachers start with NO evaluation (performance_score 0) — a 50/100
    // default silently fabricated a half-appraisal. The score is set only by
    // the evaluation endpoint (POST /:id/evaluation).
    stmtInsertTeacher.run(newId, String(fullName).trim(), phone || null, email || null, numericBaseSalary, resolvedType, 0, resolvedBranchId, today(), specialization || null, qualification || null, contractType || null, defaultSkillRate, Math.round(targetSkills));
    stmtInsertCompensationHistory.run(id('tch'), newId, today(), numericBaseSalary, resolvedType, contractType || null, defaultSkillRate, 'Initial contract', user.userId);
  });
  tx();

  writeAudit(req, `Created new teacher: ${fullName} (${resolvedType}) at branch ${branch.name}`);
  res.status(201).json(mapTeacher(stmtGetTeacherById.get(newId) as TeacherRow));
}));

teachersRouter.put('/:id', requirePermission('Teacher.Edit'), ah(async (req, res) => {
  const existing = requireTeacher(req, req.params.id);
  const { fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, status, performanceScore } = req.body;
  if (status && !['active','inactive','on_leave'].includes(status)) throw new HttpError(400, 'Invalid teacher status.');
  const nextBaseSalary = baseSalary != null ? Number(baseSalary) : Number(existing.base_salary);
  if (!Number.isFinite(nextBaseSalary) || nextBaseSalary < 0) throw new HttpError(400, 'Base salary must be a non-negative number.');
  if (req.body.defaultSkillRate != null && (!Number.isFinite(Number(req.body.defaultSkillRate)) || Number(req.body.defaultSkillRate) < 0)) throw new HttpError(400, 'Default skill rate must be a non-negative number.');
  const resolvedType = salaryType ? (ALLOWED_SALARY_TYPES.includes(salaryType) ? salaryType : (() => { throw new HttpError(400, 'Invalid salary type.'); })()) : existing.salary_type;
  const nextContractType = contractType ?? existing.contract_type;
  if (nextContractType && !['monthly','hourly','per_session'].includes(nextContractType)) throw new HttpError(400, 'Invalid contract type.');
  if (resolvedType === 'per_session' && nextContractType && nextContractType !== 'per_session') throw new HttpError(400, 'A per-session salary model requires a per-session contract type.');
  
  // Validate performance score
  const resolvedScore = performanceScore != null ? Math.max(0, Math.min(100, Number(performanceScore))) : existing.performance_score;

  const nextDefaultSkillRate = req.body.defaultSkillRate != null ? Number(req.body.defaultSkillRate) : Number(existing.default_skill_rate);
  if (!Number.isFinite(nextDefaultSkillRate) || nextDefaultSkillRate < 0) throw new HttpError(400, 'Default skill rate must be a non-negative number.');
  const nextTargetSkills = req.body.targetSkillsPerMonth != null ? Number(req.body.targetSkillsPerMonth) : null;
  if (nextTargetSkills != null && (!Number.isFinite(nextTargetSkills) || nextTargetSkills < 0)) throw new HttpError(400, 'Target Skills per month must be a non-negative number.');
  const compensationChanged = nextBaseSalary !== Number(existing.base_salary) || resolvedType !== existing.salary_type || nextContractType !== existing.contract_type || nextDefaultSkillRate !== Number(existing.default_skill_rate);
  const effectiveFrom = typeof req.body.effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.effectiveFrom) ? req.body.effectiveFrom : today();
  const joinedDate = (db.prepare('SELECT joined_date FROM teachers WHERE id = ?').get(existing.id) as { joined_date?: string } | undefined)?.joined_date;
  if (joinedDate && effectiveFrom < joinedDate) throw new HttpError(400, 'Compensation effective date cannot precede the teacher join date.');
  const tx = db.transaction(() => {
    stmtUpdateTeacher.run(
      String(fullName ?? existing.full_name).trim(), phone ?? existing.phone, email ?? existing.email, nextBaseSalary,
      resolvedType, specialization ?? existing.specialization, qualification ?? existing.qualification, 
      nextContractType, status ?? existing.status,
      nextDefaultSkillRate,
      resolvedScore, 
      nextTargetSkills == null ? null : Math.round(nextTargetSkills),
      req.params.id
    );
    if (compensationChanged) {
      stmtInsertCompensationHistory.run(id('tch'), existing.id, effectiveFrom, nextBaseSalary, resolvedType, nextContractType, nextDefaultSkillRate, typeof req.body.compensationReason === 'string' && req.body.compensationReason.trim() ? req.body.compensationReason.trim() : 'Compensation change', req.user?.userId || null);
    }
  });
  tx();
  writeAudit(req, `Updated teacher details: ${existing.full_name}` + (compensationChanged ? ' (compensation changed)' : ''));
  res.json(mapTeacher(stmtGetTeacherById.get(req.params.id) as TeacherRow));
}));

teachersRouter.post('/:id/transfer', requirePermission('Teacher.Edit'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  const targetBranchId = typeof req.body?.targetBranchId === 'string' ? req.body.targetBranchId.trim() : '';
  if (!targetBranchId) throw new HttpError(400, 'targetBranchId is required.');
  if (targetBranchId === teacher.branch_id) throw new HttpError(400, 'Teacher is already assigned to this branch.');
  if (!canAccessBranchResource(req, targetBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  const target = stmtGetBranchDetailsForTransfer.get(targetBranchId) as any;
  if (!target) throw new HttpError(404, 'Target branch not found.');
  if (!target.is_active) throw new HttpError(400, 'Cannot transfer a teacher to an inactive branch.');

  const activeClasses = stmtGetActiveTeacherClasses.all(teacher.id) as Array<{ id: string; name: string; branch_id: string; status: string }>;
  const activeAssignments = stmtGetActiveTeacherAssignments.all(teacher.id) as Array<{ id: string; class_id: string; class_name: string; assignment_type: string }>;
  if (activeClasses.length || activeAssignments.length) {
    const classNames = [
      ...new Set([
        ...activeClasses.map((c) => c.name),
        ...activeAssignments.map((a) => a.class_name),
      ]),
    ];
    throw new HttpError(409, `Teacher cannot be transferred while active teaching assignments exist. Reassign or close the current assignments first. Active classes: ${classNames.join(', ') || 'none'}.`);
  }

  const tx = db.transaction(() => {
    stmtUpdateTeacherBranch.run(targetBranchId, teacher.id);
    stmtUpdateUserBranchForTeacher.run(targetBranchId, teacher.id);
    stmtInsertTeacherBranchHistory.run(id('tbh'), teacher.id, teacher.branch_id, targetBranchId, today(), typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'Administrative branch transfer', req.user?.userId || null);
  });
  tx();
  const fromBranch = stmtGetBranchName.get(teacher.branch_id) as any;
  writeAudit(req, `Transferred teacher ${teacher.full_name} from "${fromBranch?.name || teacher.branch_id}" to "${target.name}"`);
  res.json({ ok: true, teacherId: teacher.id, fromBranchId: teacher.branch_id, toBranchId: targetBranchId, activeClasses: [] });
}));

teachersRouter.delete('/:id', requirePermission('Teacher.Delete', 'Teacher.Edit'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  const activeClasses = stmtGetActiveTeacherClasses.all(teacher.id) as any[];
  const activeAssignments = stmtGetActiveTeacherAssignments.all(teacher.id) as any[];
  if (activeClasses.length || activeAssignments.length) throw new HttpError(409, `Teacher cannot be deactivated while active teaching assignments exist. Reassign or close them first. Active classes: ${activeClasses.map((c: any) => c.name).join(', ') || 'none'}.`);
  const tx = db.transaction(() => {
    stmtUpdateTeacher.run(teacher.full_name, teacher.phone, teacher.email, teacher.base_salary, teacher.salary_type, teacher.specialization, teacher.qualification, teacher.contract_type, 'inactive', teacher.default_skill_rate, teacher.performance_score, null, teacher.id);
    stmtDeactivateLinkedTeacherUser.run(teacher.id);
  });
  tx();
  writeAudit(req, `Deactivated teacher: ${teacher.full_name}`);
  res.json({ ok: true, mode: 'soft_delete', status: 'inactive' });
}));

teachersRouter.get('/:id/computed-salary', requirePermission('Payroll.View'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  const periodKey = typeof (req.query as any).month === 'string' ? toPeriodKey(String((req.query as any).month)) : undefined;
  // The payroll engine reports the period-correct Skill workload
  // (skillCount / targetSkills / shortfall / excess) for EVERY contract
  // type, alongside the separately-visible fixed and Skill pay components.
  const dueInfo = computeTeacherDueAmount(db, teacher, periodKey);
  // Lifetime assignment count is kept for backward compatibility with
  // existing clients that read `totalSkillAssignments`.
  const totalSkillAssignments = (stmtCountSkillsForTeacher.get(teacher.id) as { c: number }).c;
  res.json({ ...dueInfo, totalSkillAssignments });
}));

// ============================================================================ 
// §2 — TEACHER EVALUATION (100-Point System)
// ============================================================================ 
teachersRouter.post('/:id/evaluation', authorize('manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const user = getUserContext(req);
  const teacher = requireTeacher(req, req.params.id);
  const { score, criteria, notes } = req.body;

  if (score == null || score <= 0 || score > 100) {
    throw new HttpError(400, 'Evaluation score must be a positive number between 1 and 100.');
  }
  if (criteria && (typeof criteria !== 'object' || Array.isArray(criteria))) {
    throw new HttpError(400, 'Evaluation criteria must be an object.');
  }

  const evalId = id('eval');
  const date = today();
  const criteriaJson = JSON.stringify(criteria || {});

  const tx = db.transaction(() => {
    stmtInsertEvaluation.run(evalId, teacher.id, user.userId, date, Number(score), criteriaJson, notes || null);
    stmtUpdateTeacher.run(
      teacher.full_name, teacher.phone, teacher.email, teacher.base_salary, teacher.salary_type,
      teacher.specialization, teacher.qualification, teacher.contract_type, teacher.status,
      teacher.default_skill_rate, Number(score), null, teacher.id
    );
  });
  tx();

  writeAudit(req, `Evaluated teacher ${teacher.full_name} with score: ${score}/100`);
  addNotification('Teacher Evaluated', `${teacher.full_name} received a performance score of ${score}/100.`, 'info', teacher.branch_id);
  res.status(201).json({ ok: true, score });
}));

// ============================================================================ 
// §3 — TEACHER SALARY & PAYROLL (Rule Engine Integrated)
// ============================================================================ 

teachersRouter.get('/:id/compensation-history', requirePermission('Payroll.View', 'Teacher.View'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  const rows = db.prepare(`SELECT id, effective_from AS effectiveFrom, base_salary AS baseSalary, salary_type AS salaryType, contract_type AS contractType, default_skill_rate AS defaultSkillRate, reason, operator_user_id AS operatorUserId, created_at AS createdAt FROM teacher_compensation_history WHERE teacher_id = ? ORDER BY effective_from DESC, created_at DESC`).all(teacher.id);
  res.json(rows);
}));

teachersRouter.get('/:id/evaluations', requirePermission('Teacher.View'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  const rows = db.prepare(`SELECT id, date, score, criteria, notes, evaluator_id AS evaluatorId, created_at AS createdAt FROM teacher_evaluations WHERE teacher_id = ? ORDER BY date DESC, created_at DESC`).all(teacher.id);
  res.json(rows);
}));

teachersRouter.get('/:id/salary-status', requirePermission('Payroll.Edit', 'Payroll.View', 'Teacher.View'), ah(async (req, res) => {
  const teacher = requireTeacher(req, req.params.id);
  // Periods are Hijri Shamsi months (e.g. '1405-05' = اسد ۱۴۰۵). Legacy
  // Gregorian input is converted by toPeriodKey, so old clients keep working.
  const monthName = String((req.query as any).month || currentJalaliPeriodKey());
  const periodKey = toPeriodKey(monthName);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new HttpError(400, 'Month must be a Shamsi period such as 1405-05 or "اسد 1405".');
  const dueInfo = computeTeacherDueAmount(db, teacher, periodKey);
  const paid = sumPaidForPeriod(db, teacher.id, periodKey);
  const fullPaid = hasFullPayForPeriod(db, teacher.id, periodKey);
  
  if (!Number.isFinite(dueInfo.due) || dueInfo.due < 0) throw new HttpError(500, 'Payroll calculation returned an invalid amount.');
  res.json({ 
    teacherId: teacher.id, periodKey, periodLabel: jalaliPeriodLabel(periodKey), model: dueInfo.model, 
    due: dueInfo.due, paid, remaining: Math.max(0, dueInfo.due - paid), fullPaid, 
    breakdown: dueInfo.breakdown, canPayFull: !fullPaid && dueInfo.due - paid > 0,
    // Fixed and Skill components stay separately identifiable, and the Skill
    // workload is reported for every contract type — including fixed, where
    // it is workload only and contributes nothing to `due`.
    base: dueInfo.base, skillsTotal: dueInfo.skillsTotal,
    skillCount: dueInfo.skillCount, targetSkills: dueInfo.targetSkills,
    shortfall: dueInfo.shortfall, excess: dueInfo.excess,
    ruleNote: ''
  });
}));

teachersRouter.post('/:id/pay-salary', requirePermission('Payroll.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const teacher = requireTeacher(req, req.params.id);
  if (teacher.status === 'inactive') throw new HttpError(400, 'Cannot pay salary to an inactive teacher.');

  const { monthName, amountPaid, paymentType } = req.body as { monthName: string; amountPaid?: number; paymentType?: 'full' | 'partial' | 'advance' };
  if (!monthName) throw new HttpError(400, 'Month is required.');
  const periodKey = toPeriodKey(monthName);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new HttpError(400, 'Month must be a Shamsi period such as 1405-05 or "اسد 1405".');
  const type = paymentType || 'full';
  if (!['full','partial','advance'].includes(type)) throw new HttpError(400, 'Invalid payment type.');

  const numericAmount = amountPaid == null ? undefined : Number(amountPaid);
  if (numericAmount != null && (!Number.isFinite(numericAmount) || numericAmount <= 0)) throw new HttpError(400, 'Payment amount must be greater than zero.');

  // Idempotency is ALWAYS applied, never only when the caller remembers a key.
  //
  // Payroll previously honoured an explicit Idempotency-Key and did nothing at
  // all without one: six concurrent identical un-keyed 1,000 AFN partials
  // created SIX ledger rows and six expense entries. This is the same defect
  // class already fixed for student payments — a double-click, a refresh or a
  // retry double-pays a teacher, bounded only by the period's due amount.
  //
  // When no key is supplied a fingerprint of the business intent is derived,
  // so retries of the same intent collapse while a genuinely later, distinct
  // payment (a different amount, or a different time bucket) still goes
  // through. The DB unique index on idempotency_key is the race arbiter.
  const { key: idempotencyKey } = resolveIdempotency(req, {
    route: 'teacher-pay-salary',
    teacherId: teacher.id,
    periodKey,
    amount: numericAmount ?? null,
    type,
    actorUserId: user.userId,
  });
  const result = (() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const freshTeacher = stmtGetTeacherById.get(teacher.id) as TeacherRow;
      if (!freshTeacher || freshTeacher.status === 'inactive') throw new HttpError(400, 'Teacher is not eligible for salary payment.');
      {
        const existing = stmtGetTeacherSalaryByIdempotency.get(idempotencyKey) as any;
        if (existing) {
          if (existing.teacher_id !== freshTeacher.id || existing.period_key !== periodKey) throw new HttpError(409, 'Idempotency key was already used for a different payroll operation.');
          db.exec('COMMIT');
          return { amountPaid: Number(existing.paid_amount), due: Number(existing.due_amount), previouslyPaid: Math.max(0, Number(existing.due_amount) - Number(existing.paid_amount)), remainingAfter: Math.max(0, Number(existing.due_amount) - Number(existing.paid_amount)), periodKey, teacher: freshTeacher, replayed: true };
        }
      }

      const dueInfo = computeTeacherDueAmount(db, freshTeacher, periodKey);
      if (dueInfo.isBlocked) throw new HttpError(409, dueInfo.blockReason || 'Payroll is blocked by policy.');
      const adjustedDue = Number(dueInfo.due);
      if (!Number.isFinite(adjustedDue) || adjustedDue < 0) throw new HttpError(500, 'Payroll calculation returned an invalid amount.');

      const alreadyPaid = sumPaidForPeriod(db, freshTeacher.id, periodKey);
      const remaining = Math.max(0, adjustedDue - alreadyPaid);
      if (remaining <= 0) throw new HttpError(409, `Nothing remains payable for "${monthName}".`);

      const resolvedAmount = numericAmount ?? (type === 'full' ? remaining : 0);
      if (resolvedAmount <= 0) throw new HttpError(400, 'Payment amount is required for partial/advance payments.');
      if (resolvedAmount > remaining + 0.0001) throw new HttpError(400, `Payment cannot exceed the remaining salary of ${remaining} AFN.`);
      if (type === 'full' && Math.abs(resolvedAmount - remaining) > 0.0001) throw new HttpError(400, 'Full payment must settle the entire remaining balance.');

      const payrollBranchId = teacherBranchAsOf(db, freshTeacher.id, `${periodKey}-31`, freshTeacher.branch_id);
      const budgetLine = stmtGetBudgetByPurpose.get('teacher_salary', payrollBranchId) as BudgetRow | undefined;
      if (!budgetLine) throw new HttpError(500, 'Teacher salary budget line is not configured.');
      const updated = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?').run(resolvedAmount, budgetLine.id, resolvedAmount);
      if (updated.changes !== 1) throw new HttpError(409, 'Insufficient salary budget or concurrent budget update.');

      const txId = id('tx');
      const ledgerId = id('tsl');
      const finalPaymentType = type === 'full' ? 'full' : type;
      const date = today();
      // Persist the canonical Shamsi label (e.g. 'اسد ۱۴۰۵') rather than the
      // raw client string, so the ledger reads consistently regardless of
      // whether the caller sent '1405-05', 'Asad 1405' or a legacy '2026-08'.
      const periodLabel = jalaliPeriodLabel(periodKey);
      stmtInsertFinTx.run(txId, resolvedAmount, date, `Paid ${finalPaymentType} salary for ${periodLabel} to teacher ${freshTeacher.full_name}`, freshTeacher.id, user.fullName, payrollBranchId);
      stmtInsertSalaryLedgerWithIdempotency.run(ledgerId, freshTeacher.id, periodKey, periodLabel, adjustedDue, resolvedAmount, finalPaymentType, txId, JSON.stringify(dueInfo.breakdown), payrollBranchId, user.fullName, idempotencyKey);

      db.exec('COMMIT');
      return { amountPaid: resolvedAmount, due: adjustedDue, previouslyPaid: alreadyPaid, remainingAfter: Math.max(0, remaining - resolvedAmount), periodKey, teacher: freshTeacher };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* rollback may already be complete */ }
      // Atomic backstop. The replay pre-check above is a fast path; under true
      // concurrency several requests pass it simultaneously and only one can
      // win uq_teacher_salary_idempotency. The losers replay the winner's
      // result rather than surfacing a 500 or paying the teacher twice.
      if (isUniqueViolation(err)) {
        const winner = stmtGetTeacherSalaryByIdempotency.get(idempotencyKey) as any;
        if (winner && winner.teacher_id === teacher.id) {
          return {
            amountPaid: Number(winner.paid_amount), due: Number(winner.due_amount),
            previouslyPaid: Math.max(0, Number(winner.due_amount) - Number(winner.paid_amount)),
            remainingAfter: Math.max(0, Number(winner.due_amount) - Number(winner.paid_amount)),
            periodKey, teacher, replayed: true,
          };
        }
      }
      throw err;
    }
  })();

  addNotification('Teacher Salary Paid', `${result.amountPaid} AFN paid to ${result.teacher.full_name}.`, 'success', result.teacher.branch_id);
  writeAudit(req, `Paid teacher salary — ${result.teacher.full_name} — ${result.amountPaid} AFN for ${monthName}`);
  res.status(201).json({ ok: true, amountPaid: result.amountPaid, periodKey: result.periodKey, due: result.due, previouslyPaid: result.previouslyPaid, remainingAfter: result.remainingAfter });
}));


teachersRouter.post('/:id/payroll/:ledgerId/void', requirePermission('Payroll.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const teacher = requireTeacher(req, req.params.id);
  const ledger = stmtGetSalaryLedger.get(req.params.ledgerId, teacher.id) as any;
  if (!ledger) throw new HttpError(404, 'Salary payment record not found.');
  if (ledger.status === 'voided') throw new HttpError(409, 'Salary payment is already voided.');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 8) throw new HttpError(400, 'A void reason of at least 8 characters is required.');

  db.exec('BEGIN IMMEDIATE');
  try {
    const freshLedger = stmtGetSalaryLedger.get(req.params.ledgerId, teacher.id) as any;
    if (!freshLedger || freshLedger.status !== 'posted') throw new HttpError(409, 'Salary payment is no longer posted.');
    const payrollBranchId = freshLedger.branch_id;
    const budgetLine = stmtGetBudgetByPurpose.get('teacher_salary', payrollBranchId) as BudgetRow | undefined;
    if (!budgetLine) throw new HttpError(500, 'Teacher salary budget line is not configured.');
    const reversalTxId = id('tx');
    stmtUpdateBudgetAmount.run(-Number(freshLedger.paid_amount), budgetLine.id);
    // CONTRA ENTRY — the amount must be NEGATIVE.
    //
    // This wrote a POSITIVE `expense` row, so voiding a 6,000 AFN salary raised
    // reported salary expense from 15,000 to 21,000 instead of returning it to
    // 9,000: the P&L counted the payment twice and the void never subtracted.
    // The budget was restored correctly, which is why the bug was invisible to
    // budget checks and only corrupted reporting.
    //
    // Signed-negative reversal is the established convention everywhere else
    // in this system (student refunds via recordIncome, book-sale contra
    // revenue), so this row now matches its siblings and every SUM() over
    // financial_transactions nets out without needing to know about voids.
    stmtInsertFinTx.run(reversalTxId, -Number(freshLedger.paid_amount), today(), `Voided teacher salary payment ${freshLedger.id}: ${reason}`, freshLedger.id, user.fullName, payrollBranchId);
    stmtVoidSalaryLedger.run(user.fullName, reason, freshLedger.id);
    db.exec('COMMIT');
    writeAudit(req, `Voided teacher salary payment ${freshLedger.id} for ${teacher.full_name}: ${reason}`);
    addNotification('Teacher Salary Voided', `Salary payment for ${teacher.full_name} was voided.`, 'warning', teacher.branch_id);
    res.json({ ok: true, ledgerId: freshLedger.id, reversalTransactionId: reversalTxId, amountRestored: Number(freshLedger.paid_amount) });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* rollback may already be complete */ }
    throw err;
  }
}));

// ============================================================================ 
// §4 — EMPLOYEES 
// ============================================================================ 
employeesRouter.get('/', requirePermission('Employee.View', 'Payroll.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const rows = (isAll ? stmtGetAllEmployees.all() : stmtGetEmployeesByBranch.all(branchId)) as EmployeeRow[];
  res.json(rows.map(mapEmployee));
}));

employeesRouter.post('/', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { fullName, phone, email, role, baseSalary, branchId } = req.body;
  if (!fullName || !role || baseSalary == null) throw new HttpError(400, 'Full name, role, and base salary are required.');

  const resolvedBranchId = typeof branchId === 'string' && branchId.trim() ? branchId.trim() : user.branchId;
  if (!canAccessBranchResource(req, resolvedBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  const branch = stmtGetBranchById.get(resolvedBranchId) as any;
  if (!branch) throw new HttpError(400, 'Target branch not found.');
  if (!branch.is_active) throw new HttpError(400, 'Cannot assign an employee to an inactive branch.');

  const newId = id('emp');
  stmtInsertEmployee.run(newId, fullName, phone || null, email || null, role, baseSalary, resolvedBranchId, today());
  writeAudit(req, `Created new employee: ${fullName} (${role}) at branch ${branch.name}`);
  res.status(201).json(mapEmployee(stmtGetEmployeeById.get(newId) as EmployeeRow));
}));

employeesRouter.post('/:id/transfer', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const employee = requireEmployee(req, req.params.id);
  const targetBranchId = typeof req.body?.targetBranchId === 'string' ? req.body.targetBranchId.trim() : '';
  if (!targetBranchId) throw new HttpError(400, 'targetBranchId is required.');
  if (targetBranchId === employee.branch_id) throw new HttpError(400, 'Employee is already assigned to this branch.');

  const target = stmtGetBranchDetailsForTransfer.get(targetBranchId) as any;
  if (!target) throw new HttpError(404, 'Target branch not found.');
  if (!target.is_active) throw new HttpError(400, 'Cannot transfer an employee to an inactive branch.');

  const tx = db.transaction(() => {
    stmtUpdateEmployeeBranch.run(targetBranchId, employee.id);
    stmtUpdateUserBranchForEmployee.run(targetBranchId, employee.id);
    if (employee.user_id) stmtUpdateUserBranchById.run(targetBranchId, employee.user_id);
  });
  tx();

  const fromBranch = stmtGetBranchName.get(employee.branch_id) as any;
  writeAudit(req, `Transferred employee ${employee.full_name} from "${fromBranch?.name || employee.branch_id}" to "${target.name}"`);
  res.json({ ok: true, employeeId: employee.id, fromBranchId: employee.branch_id, toBranchId: targetBranchId, toCampusId: target.campus_id || null });
}));

employeesRouter.put('/:id', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const existing = requireEmployee(req, req.params.id);
  const { fullName, phone, email, role, baseSalary, status } = req.body;
  if (status && !['active', 'inactive'].includes(status)) throw new HttpError(400, 'Invalid status.');

  stmtUpdateEmployee.run(fullName ?? existing.full_name, phone ?? existing.phone, email ?? existing.email, role ?? existing.role, baseSalary ?? existing.base_salary, status ?? existing.status, existing.id);
  writeAudit(req, `Updated employee details: ${existing.full_name}`);
  res.json(mapEmployee(stmtGetEmployeeById.get(existing.id) as EmployeeRow));
}));

employeesRouter.delete('/:id', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const existing = requireEmployee(req, req.params.id);
  stmtSoftDeleteEmployee.run(existing.id);
  writeAudit(req, `Deactivated employee: ${existing.full_name}`);
  res.json({ ok: true, mode: 'soft_delete', status: 'inactive' });
}));

employeesRouter.post('/:id/pay-salary', requirePermission('Payroll.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const employee = requireEmployee(req, req.params.id);
  if (employee.status === 'inactive') throw new HttpError(400, 'Cannot pay salary to an inactive employee.');

  const { monthName, amountPaid, paymentType } = req.body as { monthName: string; amountPaid: number; paymentType: 'full' | 'partial' | 'advance' };
  if (!monthName || !amountPaid || amountPaid <= 0) throw new HttpError(400, 'Month and payment amount are required.');
  
  const resolvedAmount = Number(amountPaid);
  const type = paymentType || 'full';
  if (!['full', 'partial', 'advance'].includes(type)) throw new HttpError(400, 'Invalid payment type.');

  const budgetLine = stmtGetBudgetByPurpose.get('employee_salary', employee.branch_id) as BudgetRow | undefined;
  if (!budgetLine) throw new HttpError(500, 'Employee salary budget line is not configured.');
  if (budgetLine.current_amount < resolvedAmount) throw new HttpError(409, `Insufficient employee salary budget. Balance: ${budgetLine.current_amount} AFN.`);

  if (type === 'full') {
    const dup = stmtCheckDuplicateEmployeePay.get(employee.id, `%full salary%${monthName}%`) as any;
    if (dup) throw new HttpError(409, `A full salary payment for "${monthName}" already exists.`);
  }

  const typeLabel = type === 'partial' ? 'partial salary' : type === 'advance' ? 'salary advance' : 'full salary';
  const date = today();

  const tx = db.transaction(() => {
    stmtUpdateBudgetAmount.run(resolvedAmount, budgetLine.id);
    stmtInsertFinTx.run(id('tx'), resolvedAmount, date, `Paid ${typeLabel} for ${monthName} to employee ${employee.full_name} (${employee.role})`, employee.id, user.fullName, employee.branch_id);
  });
  tx();

  addNotification('Employee Salary Paid', `Salary of ${resolvedAmount} AFN paid to employee ${employee.full_name}.`, 'success', employee.branch_id);
  writeAudit(req, `Paid salary to employee ${employee.full_name} — ${resolvedAmount} AFN for ${monthName}`);
  res.status(201).json({ ok: true, amountPaid: resolvedAmount, monthName, paymentType: type, remainingBudget: budgetLine.current_amount - resolvedAmount });
}));

export default teachersRouter;