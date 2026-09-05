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
import { assertMoney, assertPerformanceScore, assertSeatCount } from '../utils/money.js';
import { addNotification } from '../utils/notifications.js';
import {
  computeTeacherDueAmount, currentJalaliPeriodKey, resolvePayrollPeriodKey,
  PayrollRuleConfigurationError,
  sumPaidForPeriod, hasFullPayForPeriod, teacherBranchAsOf,
  CONTRACT_TYPES,
} from '../core/payroll/class-payroll.js';
import { jalaliPeriodLabel } from '../utils/jalali.js';
import { payrollLedgerCategoryId } from '../core/finance/category-taxonomy.js';
import { computeEmployeeDueAmount } from '../core/payroll/employee-payroll.js';
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
  contract_type: string | null; default_skill_rate: number;
  target_skills_per_month?: number;
}

interface EmployeeRow {
  id: string; full_name: string; phone: string | null; email: string | null;
  role: string; base_salary: number; status: string; branch_id: string;
  joined_date: string;
}

interface BudgetRow {
  id: string; name: string; current_amount: number; payroll_target: string | null;
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
const stmtGetActiveTeacherClasses = db.prepare("SELECT id, name, branch_id, status FROM classes WHERE teacher_id = ? AND lifecycle_stage NOT IN ('completed','archived','cancelled') ORDER BY name");
const stmtGetActiveTeacherAssignments = db.prepare(`SELECT cts.id, cts.class_id, cts.skill_id, cts.assignment_type, cts.session_id, cts.start_date, cts.end_date, c.name AS class_name FROM class_teacher_skills cts JOIN classes c ON c.id = cts.class_id WHERE cts.teacher_id = ? AND cts.assignment_type IN ('primary','assistant') AND c.lifecycle_stage NOT IN ('completed','archived','cancelled') AND (cts.end_date IS NULL OR cts.end_date >= date('now'))`);

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
const stmtGetTeacherSalaryByIdempotency = db.prepare("SELECT id, teacher_id, period_key, due_amount, paid_amount, payment_type, transaction_id, branch_id, status, notes FROM teacher_salary_ledger WHERE idempotency_key = ? AND status = 'posted'");
const stmtGetTeacherSalaryByIdempotencyCandidates = db.prepare("SELECT id, teacher_id, period_key, due_amount, paid_amount, payment_type, transaction_id, branch_id, status, notes FROM teacher_salary_ledger WHERE idempotency_key IN (?, ?) AND status = 'posted' LIMIT 1");
const stmtGetSalaryLedger = db.prepare('SELECT * FROM teacher_salary_ledger WHERE id = ? AND teacher_id = ?');
const stmtVoidSalaryLedger = db.prepare(`UPDATE teacher_salary_ledger SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'posted'`);
const stmtInsertSalaryLedgerWithIdempotency = db.prepare(`INSERT INTO teacher_salary_ledger (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, transaction_id, notes, branch_id, operator_name, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')`);
const stmtGetBranchName = db.prepare('SELECT name FROM branches WHERE id = ?');
const stmtInsertTeacherBranchHistory = db.prepare('INSERT INTO teacher_branch_history (id, teacher_id, from_branch_id, to_branch_id, effective_date, reason, operator_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)');

// Payroll & Finance Statements
// The payroll envelope is resolved through the BUSINESS RELATIONSHIP
// (`payroll_target`), not through a display-derived string. The database allows
// at most one teacher and one employee envelope per branch, so this is a
// single-row lookup by construction.
const stmtGetPayrollBudgetLine = db.prepare(
  'SELECT * FROM budget_lines WHERE payroll_target = ? AND branch_id = ? AND is_active = 1',
);
const stmtUpdateBudgetAmount = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?');
// `finance_category_id` is the accounting authority; `category` is the
// human-readable label beside it. They are written together and always agree.
const stmtInsertFinTx = db.prepare(
  `INSERT INTO financial_transactions
     (id, type, category, finance_category_id, amount, date, description, reference_id, operator_name, branch_id)
   VALUES (?, 'expense', ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const stmtInsertCompensationHistory = db.prepare('INSERT INTO teacher_compensation_history (id, teacher_id, effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason, operator_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const stmtInsertEvaluation = db.prepare(`INSERT INTO teacher_evaluations (id, teacher_id, evaluator_id, date, score, criteria, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Employee Statements
const stmtInsertEmployee = db.prepare(`INSERT INTO employees (id, full_name, phone, email, role, base_salary, status, branch_id, joined_date) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
const stmtUpdateEmployee = db.prepare(`UPDATE employees SET full_name=?, phone=?, email=?, role=?, base_salary=?, status=? WHERE id=?`);
const stmtUpdateEmployeeBranch = db.prepare('UPDATE employees SET branch_id = ? WHERE id = ?');
const stmtUpdateUserBranchForEmployee = db.prepare('UPDATE users SET branch_id = ? WHERE linked_employee_id = ?');
const stmtSoftDeleteEmployee = db.prepare("UPDATE employees SET status = 'inactive' WHERE id = ?");

// ── EMPLOYEE PAYROLL LEDGER (teacher audit T-1) ────────────────────────────
// Employee salary payment writes a ledger row, not merely a raw
// financial_transactions expense. Without one there is no idempotency and no
// reconcilable trail, and the only available duplicate guard is a
// `description LIKE '%full salary%<month>%'` string match — which covers
// `full` only and is a check-then-act under concurrency.
// These statements mirror the teacher payroll path exactly.
const stmtGetEmployeeSalaryByIdempotency = db.prepare(
  "SELECT id, employee_id, period_key, paid_amount, payment_type, transaction_id, branch_id, status FROM employee_salary_ledger WHERE idempotency_key = ? AND status = 'posted'"
);
const stmtGetEmployeeSalaryByIdempotencyCandidates = db.prepare(
  "SELECT id, employee_id, period_key, paid_amount, payment_type, transaction_id, branch_id, status FROM employee_salary_ledger WHERE idempotency_key IN (?, ?) AND status = 'posted' LIMIT 1"
);
const stmtGetEmployeeSalaryLedger = db.prepare('SELECT * FROM employee_salary_ledger WHERE id = ? AND employee_id = ?');
const stmtVoidEmployeeSalaryLedger = db.prepare("UPDATE employee_salary_ledger SET status = 'voided', voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND status = 'posted'");
const stmtInsertEmployeeSalaryLedger = db.prepare(
  `INSERT INTO employee_salary_ledger (id, employee_id, period_key, period_label, due_amount, paid_amount, payment_type, transaction_id, notes, branch_id, operator_name, idempotency_key, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')`
);

function findTeacherSalaryReplay(candidates: readonly string[]) {
  return (candidates.length === 1
    ? stmtGetTeacherSalaryByIdempotency.get(candidates[0])
    : stmtGetTeacherSalaryByIdempotencyCandidates.get(candidates[0], candidates[1])) as any;
}

function findEmployeeSalaryReplay(candidates: readonly string[]) {
  return (candidates.length === 1
    ? stmtGetEmployeeSalaryByIdempotency.get(candidates[0])
    : stmtGetEmployeeSalaryByIdempotencyCandidates.get(candidates[0], candidates[1])) as any;
}

function teacherReplaySettlement(ledger: { teacher_id: string; period_key: string; due_amount: number; paid_amount: number; notes?: string | null }) {
  try {
    const snapshot = JSON.parse(String(ledger.notes ?? '')) as Record<string, unknown>;
    if (
      Number.isFinite(snapshot.due) && Number.isFinite(snapshot.previouslyPaid) && Number.isFinite(snapshot.remainingAfter)
      && Number(snapshot.due) >= 0 && Number(snapshot.previouslyPaid) >= 0 && Number(snapshot.remainingAfter) >= 0
    ) {
      return {
        due: Number(snapshot.due),
        previouslyPaid: Number(snapshot.previouslyPaid),
        remainingAfter: Number(snapshot.remainingAfter),
      };
    }
  } catch {
    // A row without a settlement snapshot derives its current position from
    // the posted facts for its own period.
  }

  const paid = sumPaidForPeriod(db, ledger.teacher_id, ledger.period_key);
  const due = Number(ledger.due_amount);
  return {
    due,
    previouslyPaid: Math.max(0, paid - Number(ledger.paid_amount)),
    remainingAfter: Math.max(0, due - paid),
  };
}

/** The five contract types, taken from the payroll engine's single source of
 *  truth so routes, engine and database CHECK can never drift apart again. */
const ALLOWED_SALARY_TYPES: readonly string[] = CONTRACT_TYPES;

/** Safely extract user context */
function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) throw new HttpError(403, 'User context missing.');
  return user;
}

function requirePayrollPeriod(value: unknown): string {
  const periodKey = resolvePayrollPeriodKey(value);
  if (periodKey) return periodKey;
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new HttpError(400, 'Month is required.');
  }
  throw new HttpError(400, 'Month must be a Shamsi period such as 1405-05 or "اسد 1405".');
}

function computeTeacherPayroll(teacher: TeacherRow, periodKey: string) {
  try {
    return computeTeacherDueAmount(db, teacher, periodKey);
  } catch (error) {
    if (error instanceof PayrollRuleConfigurationError) {
      throw new HttpError(409, 'Payroll configuration is invalid. Correct the active payroll rules before calculating or paying salary.');
    }
    throw error;
  }
}

function mapTeacher(row: TeacherRow | undefined) {
  if (!row) return row;
  return { 
    id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, baseSalary: row.base_salary, 
    salaryType: row.salary_type, performanceScore: row.performance_score, status: row.status, branchId: row.branch_id, 
    joinedDate: row.joined_date, specialization: row.specialization, qualification: row.qualification, 
    contractType: row.contract_type, defaultSkillRate: row.default_skill_rate ?? 0,
    targetSkillsPerMonth: row.target_skills_per_month ?? 0
  };
}

function mapEmployee(row: EmployeeRow | undefined) {
  if (!row) return row;
  return { 
    id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, role: row.role, 
    baseSalary: row.base_salary, status: row.status, branchId: row.branch_id, joinedDate: row.joined_date
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

function assertTeacherHasNoActiveWork(teacher: TeacherRow, action = 'deactivated'): void {
  const activeClasses = stmtGetActiveTeacherClasses.all(teacher.id) as Array<{ name: string }>;
  const activeAssignments = stmtGetActiveTeacherAssignments.all(teacher.id) as Array<{ class_name: string }>;
  if (!activeClasses.length && !activeAssignments.length) return;
  const classNames = [...new Set([
    ...activeClasses.map((item) => item.name),
    ...activeAssignments.map((item) => item.class_name),
  ])];
  throw new HttpError(
    409,
    `Teacher cannot be ${action} while active teaching assignments exist. Reassign or close them first. Active classes: ${classNames.join(', ') || 'none'}.`,
  );
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
  let defaultSkillRate: number;
  try { defaultSkillRate = bodyDefaultSkillRate == null ? 0 : assertMoney(bodyDefaultSkillRate, 'default skill rate'); }
  catch { throw new HttpError(400, 'Default skill rate must be a non-negative number.'); }
  if ((resolvedType === 'per_skill' || resolvedType === 'hybrid') && defaultSkillRate <= 0 && Number(baseSalary) <= 0) {
    throw new HttpError(400, 'A skill-based salary requires a positive base salary or default skill rate.');
  }
  // Monthly workload target (Skills/month). Configuration only — it never
  // changes pay; it drives Target/Actual/Shortfall/Excess reporting.
  const targetSkills = req.body.targetSkillsPerMonth == null
    ? 0
    : assertSeatCount(req.body.targetSkillsPerMonth, 'Target Skills per month');

  const newId = id('t');
  const tx = db.transaction(() => {
    // New teachers start with NO evaluation (performance_score 0) — a 50/100
    // default silently fabricated a half-appraisal. The score is set only by
    // the evaluation endpoint (POST /:id/evaluation).
    stmtInsertTeacher.run(newId, String(fullName).trim(), phone || null, email || null, numericBaseSalary, resolvedType, 0, resolvedBranchId, today(), specialization || null, qualification || null, contractType || null, defaultSkillRate, targetSkills);
    stmtInsertCompensationHistory.run(id('tch'), newId, today(), numericBaseSalary, resolvedType, contractType || null, defaultSkillRate, 'Initial contract', user.userId);
  });
  tx();

  writeAudit(req, `Created new teacher: ${fullName} (${resolvedType}) at branch ${branch.name}`);
  res.status(201).json(mapTeacher(stmtGetTeacherById.get(newId) as TeacherRow));
}));

teachersRouter.put('/:id', requirePermission('Teacher.Edit'), ah(async (req, res) => {
  const existing = requireTeacher(req, req.params.id);
  const { fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, status } = req.body;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'performanceScore')) {
    throw new HttpError(400, 'Performance score can only be changed through the teacher evaluation command.');
  }
  if (status !== undefined && status !== null && !['active','inactive','on_leave'].includes(status)) {
    throw new HttpError(400, 'Invalid teacher status.');
  }
  if (status === 'inactive' && existing.status !== 'inactive') assertTeacherHasNoActiveWork(existing);
  if (fullName !== undefined && (typeof fullName !== 'string' || !fullName.trim())) throw new HttpError(400, 'Teacher name cannot be empty.');
  assertTextLengths([
    [fullName, 'Full name', TEXT_LIMITS.name], [phone, 'Phone', TEXT_LIMITS.short], [email, 'Email', TEXT_LIMITS.email],
    [specialization, 'Specialization', TEXT_LIMITS.line], [qualification, 'Qualification', TEXT_LIMITS.line],
  ]);
  // ── T-2: money fields use the SAME authority as POST ─────────────────────
  // These were validated only for `!Number.isFinite(...) || < 0`, which is a
  // coercion rather than a parse. Reproduced live on a fresh database, PUT
  // accepted values POST refuses with 400:
  //     1e15 -> stored (and propagated into computed-salary)
  //     ''   -> stored as 0        (a blank form field became a ZERO salary)
  //     true -> stored as 1
  //     [5]  -> stored as 5
  //     '0x10' -> stored as 16
  // `assertMoney` is the boundary POST already uses; it adds the decimal-numeral
  // parse, two-decimal rounding and the safe-integer-cents ceiling. Routing PUT
  // through it makes create and update agree on what a valid amount is.
  let nextBaseSalary: number;
  if (baseSalary != null) {
    try { nextBaseSalary = assertMoney(baseSalary, 'Base salary'); }
    catch (err) { throw err instanceof HttpError ? err : new HttpError(400, 'Base salary must be a non-negative number.'); }
  } else {
    nextBaseSalary = Number(existing.base_salary);
  }
  const resolvedType = salaryType ? (ALLOWED_SALARY_TYPES.includes(salaryType) ? salaryType : (() => { throw new HttpError(400, 'Invalid salary type.'); })()) : existing.salary_type;
  const nextContractType = contractType ?? existing.contract_type;
  if (nextContractType && !['monthly','hourly','per_session'].includes(nextContractType)) throw new HttpError(400, 'Invalid contract type.');
  if (resolvedType === 'per_session' && nextContractType && nextContractType !== 'per_session') throw new HttpError(400, 'A per-session salary model requires a per-session contract type.');
  
  let nextDefaultSkillRate: number;
  if (req.body.defaultSkillRate != null) {
    try { nextDefaultSkillRate = assertMoney(req.body.defaultSkillRate, 'Default skill rate'); }
    catch (err) { throw err instanceof HttpError ? err : new HttpError(400, 'Default skill rate must be a non-negative number.'); }
  } else {
    nextDefaultSkillRate = Number(existing.default_skill_rate);
  }
  const nextTargetSkills = req.body.targetSkillsPerMonth == null
    ? null
    : assertSeatCount(req.body.targetSkillsPerMonth, 'Target Skills per month');
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
      existing.performance_score,
      nextTargetSkills,
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

  assertTeacherHasNoActiveWork(teacher, 'transferred');

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
  assertTeacherHasNoActiveWork(teacher);
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
  const query = req.query as Record<string, unknown>;
  const suppliedMonth = query.month ?? query.monthName;
  if (query.month !== undefined && query.monthName !== undefined && query.month !== query.monthName) {
    throw new HttpError(400, 'month and monthName must identify the same payroll period.');
  }
  const periodKey = suppliedMonth === undefined ? currentJalaliPeriodKey() : requirePayrollPeriod(suppliedMonth);
  // The payroll engine reports the period-correct Skill workload
  // (skillCount / targetSkills / shortfall / excess) for EVERY contract
  // type, alongside the separately-visible fixed and Skill pay components.
  const dueInfo = computeTeacherPayroll(teacher, periodKey);
  // Lifetime assignment count, reported alongside the period figures because
  // clients read `totalSkillAssignments` as a career total, not a period one.
  const totalSkillAssignments = (stmtCountSkillsForTeacher.get(teacher.id) as { c: number }).c;
  res.json({ ...dueInfo, totalSkillAssignments });
}));

// ============================================================================ 
// §2 — TEACHER EVALUATION (100-Point System)
// ============================================================================ 
teachersRouter.post('/:id/evaluation', authorize('general_manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const user = getUserContext(req);
  const teacher = requireTeacher(req, req.params.id);
  const { score, criteria, notes } = req.body;

  // T-3: parse the score instead of comparing a raw, unvalidated body value.
  // `score <= 0 || score > 100` is a COMPARISON, not a parse, so anything that
  // is not a number slipped past it and reached SQLite. Reproduced live:
  //     'abc' / {} / '50abc' -> 500 "NOT NULL constraint failed: teacher_evaluations.score"
  //     true                 -> 201, stored as score 1
  //     '0x10'               -> 201, stored as score 16
  // (`NaN <= 0` and `NaN > 100` are both false, so NaN passed every branch.)
  // `assertPerformanceScore` with allowZero:false is exactly this endpoint's
  // documented rule — "a positive number between 1 and 100" — expressed as a
  // parse with type discipline. The accepted range is unchanged.
  const numericScore = assertPerformanceScore(score, 'Evaluation score', { allowZero: false });
  if (criteria && (typeof criteria !== 'object' || Array.isArray(criteria))) {
    throw new HttpError(400, 'Evaluation criteria must be an object.');
  }

  const evalId = id('eval');
  const date = today();
  const criteriaJson = JSON.stringify(criteria || {});

  const tx = db.transaction(() => {
    // Persist and report the PARSED score. Echoing the raw body value back
    // meant a '0x10' request answered 201 with score:'0x10' while the row
    // actually held 16.
    stmtInsertEvaluation.run(evalId, teacher.id, user.userId, date, numericScore, criteriaJson, notes || null);
    stmtUpdateTeacher.run(
      teacher.full_name, teacher.phone, teacher.email, teacher.base_salary, teacher.salary_type,
      teacher.specialization, teacher.qualification, teacher.contract_type, teacher.status,
      teacher.default_skill_rate, numericScore, null, teacher.id
    );
  });
  tx();

  writeAudit(req, `Evaluated teacher ${teacher.full_name} with score: ${numericScore}/100`);
  addNotification('Teacher Evaluated', `${teacher.full_name} received a performance score of ${numericScore}/100.`, 'info', teacher.branch_id);
  res.status(201).json({ ok: true, score: numericScore });
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
  const query = req.query as Record<string, unknown>;
  const suppliedMonth = query.month ?? query.monthName;
  if (query.month !== undefined && query.monthName !== undefined && query.month !== query.monthName) {
    throw new HttpError(400, 'month and monthName must identify the same payroll period.');
  }
  const periodKey = suppliedMonth === undefined ? currentJalaliPeriodKey() : requirePayrollPeriod(suppliedMonth);
  const dueInfo = computeTeacherPayroll(teacher, periodKey);
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

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const monthName = body.monthName;
  const amountPaid = body.amountPaid;
  const paymentType = body.paymentType;
  const periodKey = requirePayrollPeriod(monthName);
  // A teacher payment is always against salary already earned. The capped
  // former `advance` path is therefore an ordinary partial payment, not a
  // distinct accounting event.
  if (paymentType !== undefined && paymentType !== 'full' && paymentType !== 'partial') {
    throw new HttpError(400, "Invalid payment type. Teacher payroll accepts 'full' or 'partial'; a teacher payment is always against salary already earned.");
  }
  const type: 'full' | 'partial' = paymentType === 'partial' ? 'partial' : 'full';

  // T-3: same treatment as the employee path. `amountPaid` is optional here
  // (omitting it means "pay the full remaining balance"), so null/undefined
  // stays undefined; anything actually supplied is parsed rather than coerced.
  // Pre-fix, 0.001 passed `> 0` and was rejected by the two-decimal database
  // trigger as a raw 500 — the audit recorded this path as a correct control,
  // which live reproduction refuted.
  const numericAmount = amountPaid == null ? undefined : assertMoney(amountPaid, 'Payment amount');
  if (numericAmount != null && numericAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');

  // Idempotency is ALWAYS applied, never only when the caller remembers a key.
  //
  // Honouring only an explicit Idempotency-Key protects nothing: six
  // concurrent identical un-keyed 1,000 AFN partials create SIX ledger rows and
  // six expense entries. This is the same defect class the student payment path
  // guards against — a double-click, a refresh or a retry double-pays a
  // teacher, bounded only by the period's due amount.
  //
  // When no key is supplied a fingerprint of the business intent is derived,
  // so retries of the same intent collapse while a genuinely later, distinct
  // payment (a different amount, or a different time bucket) still goes
  // through. The DB unique index on idempotency_key is the race arbiter.
  const { key: idempotencyKey, candidates: idempotencyCandidates } = resolveIdempotency(req, {
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
        const existing = findTeacherSalaryReplay(idempotencyCandidates);
        if (existing) {
          if (existing.teacher_id !== freshTeacher.id || existing.period_key !== periodKey) throw new HttpError(409, 'Idempotency key was already used for a different payroll operation.');
          const settlement = teacherReplaySettlement(existing);
          db.exec('COMMIT');
          return { amountPaid: Number(existing.paid_amount), ...settlement, periodKey, teacher: freshTeacher, replayed: true };
        }
      }

      const dueInfo = computeTeacherPayroll(freshTeacher, periodKey);
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
      const budgetLine = stmtGetPayrollBudgetLine.get('teacher', payrollBranchId) as BudgetRow | undefined;
      if (!budgetLine) throw new HttpError(500, 'Teacher payroll budget line is not configured for this branch.');
      const updated = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?').run(resolvedAmount, budgetLine.id, resolvedAmount);
      if (updated.changes !== 1) throw new HttpError(409, 'Insufficient salary budget or concurrent budget update.');

      const txId = id('tx');
      const ledgerId = id('tsl');
      const finalPaymentType = type === 'full' ? 'full' : type;
      const date = today();
      // Persist the canonical Shamsi label (e.g. 'اسد ۱۴۰۵') rather than the
      // raw client string, so the ledger reads consistently regardless of
      // whether the caller sent '1405-05', 'Asad 1405' or a Gregorian '2026-08'.
      const periodLabel = jalaliPeriodLabel(periodKey);
      stmtInsertFinTx.run(
        txId, 'salary', payrollLedgerCategoryId(false), resolvedAmount, date,
        `Paid ${finalPaymentType} salary for ${periodLabel} to teacher ${freshTeacher.full_name}`,
        freshTeacher.id, user.fullName, payrollBranchId,
      );
      const remainingAfter = Math.max(0, remaining - resolvedAmount);
      const replaySnapshot = JSON.stringify({
        breakdown: dueInfo.breakdown,
        due: adjustedDue,
        previouslyPaid: alreadyPaid,
        remainingAfter,
      });
      stmtInsertSalaryLedgerWithIdempotency.run(ledgerId, freshTeacher.id, periodKey, periodLabel, adjustedDue, resolvedAmount, finalPaymentType, txId, replaySnapshot, payrollBranchId, user.fullName, idempotencyKey);

      db.exec('COMMIT');
      return { amountPaid: resolvedAmount, due: adjustedDue, previouslyPaid: alreadyPaid, remainingAfter, periodKey, teacher: freshTeacher, replayed: false };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* rollback may already be complete */ }
      // Atomic backstop. The replay pre-check above is a fast path; under true
      // concurrency several requests pass it simultaneously and only one can
      // win uq_teacher_salary_idempotency. The losers replay the winner's
      // result rather than surfacing a 500 or paying the teacher twice.
      if (isUniqueViolation(err)) {
        const winner = findTeacherSalaryReplay([idempotencyKey]);
        if (winner && winner.teacher_id === teacher.id) {
          return {
            amountPaid: Number(winner.paid_amount),
            ...teacherReplaySettlement(winner),
            periodKey,
            teacher,
            replayed: true,
          };
        }
      }
      throw err;
    }
  })();

  addNotification('Teacher Salary Paid', `${result.amountPaid} AFN paid to ${result.teacher.full_name}.`, 'success', result.teacher.branch_id);
  writeAudit(req, `Paid teacher salary — ${result.teacher.full_name} — ${result.amountPaid} AFN for ${monthName}`);
  res.status(201).json({ ok: true, amountPaid: result.amountPaid, periodKey: result.periodKey, due: result.due, previouslyPaid: result.previouslyPaid, remainingAfter: result.remainingAfter, replayed: !!result.replayed });
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
    const budgetLine = stmtGetPayrollBudgetLine.get('teacher', payrollBranchId) as BudgetRow | undefined;
    if (!budgetLine) throw new HttpError(500, 'Teacher payroll budget line is not configured for this branch.');
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
    stmtInsertFinTx.run(
      reversalTxId, 'salary', payrollLedgerCategoryId(false), -Number(freshLedger.paid_amount), today(),
      `Voided teacher salary payment ${freshLedger.id}: ${reason}`,
      freshLedger.id, user.fullName, payrollBranchId,
    );
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
  // Employee salary uses the same money boundary as every other salary field.
  // Without it `Number()` never even ran here: the raw body value went straight
  // into a REAL column, and SQLite's type affinity STORES non-numeric text
  // verbatim rather than rejecting it (proven: 'abc', '50abc', '' persisted as
  // TEXT). Aggregates then treat those rows as 0, silently under-reporting
  // payroll. Teacher create/update already route through assertMoney; this is
  // the same invariant, not a new rule.
  const numericBaseSalary = assertMoney(baseSalary, 'Base salary');

  const resolvedBranchId = typeof branchId === 'string' && branchId.trim() ? branchId.trim() : user.branchId;
  if (!canAccessBranchResource(req, resolvedBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  const branch = stmtGetBranchById.get(resolvedBranchId) as any;
  if (!branch) throw new HttpError(400, 'Target branch not found.');
  if (!branch.is_active) throw new HttpError(400, 'Cannot assign an employee to an inactive branch.');

  const newId = id('emp');
  stmtInsertEmployee.run(newId, fullName, phone || null, email || null, role, numericBaseSalary, resolvedBranchId, today());
  writeAudit(req, `Created new employee: ${fullName} (${role}) at branch ${branch.name}`);
  res.status(201).json(mapEmployee(stmtGetEmployeeById.get(newId) as EmployeeRow));
}));

employeesRouter.post('/:id/transfer', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const employee = requireEmployee(req, req.params.id);
  const targetBranchId = typeof req.body?.targetBranchId === 'string' ? req.body.targetBranchId.trim() : '';
  if (!targetBranchId) throw new HttpError(400, 'targetBranchId is required.');
  if (targetBranchId === employee.branch_id) throw new HttpError(400, 'Employee is already assigned to this branch.');
  if (!canAccessBranchResource(req, targetBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');

  const target = stmtGetBranchDetailsForTransfer.get(targetBranchId) as any;
  if (!target) throw new HttpError(404, 'Target branch not found.');
  if (!target.is_active) throw new HttpError(400, 'Cannot transfer an employee to an inactive branch.');

  const tx = db.transaction(() => {
    stmtUpdateEmployeeBranch.run(targetBranchId, employee.id);
    stmtUpdateUserBranchForEmployee.run(targetBranchId, employee.id);
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

  // This writer had NO validation of any kind: the raw body value was passed
  // straight to a REAL column. Reproduced live on a fresh database —
  //     1e15    -> 200, stored 1000000000000000
  //     -5000   -> 200, stored -5000        (a negative salary)
  //     'abc'   -> 200, stored as TEXT 'abc'
  //     ''      -> 200, stored as TEXT ''
  //     '0x10'  -> 200, stored as TEXT '0x10'
  //     [5]     -> 200, stored 5
  //     true    -> 500 (raw SQLite bind error leaked to the client)
  // SQLite REAL affinity does not reject non-numeric text, it stores it as-is,
  // and SUM() then counts those rows as 0 — payroll silently under-reports.
  // `assertMoney` is the boundary the teacher writers already use. Omitting
  // baseSalary still means "leave it unchanged".
  const nextBaseSalary = baseSalary != null ? assertMoney(baseSalary, 'Base salary') : Number(existing.base_salary);

  stmtUpdateEmployee.run(fullName ?? existing.full_name, phone ?? existing.phone, email ?? existing.email, role ?? existing.role, nextBaseSalary, status ?? existing.status, existing.id);
  writeAudit(req, `Updated employee details: ${existing.full_name}`);
  res.json(mapEmployee(stmtGetEmployeeById.get(existing.id) as EmployeeRow));
}));

employeesRouter.delete('/:id', requirePermission('Employee.Edit'), ah(async (req, res) => {
  const existing = requireEmployee(req, req.params.id);
  stmtSoftDeleteEmployee.run(existing.id);
  writeAudit(req, `Deactivated employee: ${existing.full_name}`);
  res.json({ ok: true, mode: 'soft_delete', status: 'inactive' });
}));

// ── EMPLOYEE SALARY STATUS (W12: symmetric to the teacher preview) ─────────
// Exposes the due COMPOSITION (base + earned bonus) so the desk sees exactly
// what the pay-salary cap will enforce — the two surfaces share one authority
// (computeEmployeeDueAmount), so they can never disagree.
function computeEmployeePayroll(employee: { id: string; branch_id: string; base_salary: number; role: string }) {
  // Same contract as the teacher path: a broken payroll rule configuration is
  // an operator-correctable conflict (409), never an unhandled 500.
  try {
    return computeEmployeeDueAmount(db, employee);
  } catch (error) {
    if (error instanceof PayrollRuleConfigurationError) {
      throw new HttpError(409, 'Payroll configuration is invalid. Correct the active payroll rules before calculating or paying salary.');
    }
    throw error;
  }
}

employeesRouter.get('/:id/salary-status', requirePermission('Payroll.Edit', 'Payroll.View', 'Employee.View'), ah(async (req, res) => {
  const employee = requireEmployee(req, req.params.id);
  const query = req.query as Record<string, unknown>;
  const suppliedMonth = query.month ?? query.monthName;
  if (query.month !== undefined && query.monthName !== undefined && query.month !== query.monthName) {
    throw new HttpError(400, 'month and monthName must identify the same payroll period.');
  }
  const periodKey = suppliedMonth === undefined ? currentJalaliPeriodKey() : requirePayrollPeriod(suppliedMonth);
  const dueInfo = computeEmployeePayroll({
    id: employee.id,
    branch_id: employee.branch_id,
    base_salary: Number(employee.base_salary) || 0,
    role: String(employee.role ?? ''),
  });
  if (!Number.isFinite(dueInfo.due) || dueInfo.due < 0) throw new HttpError(500, 'Payroll calculation returned an invalid amount.');
  const paidRow = db
    .prepare(`SELECT COALESCE(SUM(paid_amount),0) AS s FROM employee_salary_ledger WHERE employee_id = ? AND period_key = ? AND status = 'posted'`)
    .get(employee.id, periodKey) as { s: number };
  const paid = Number(paidRow.s) || 0;
  const fullPaid = !!db
    .prepare(`SELECT 1 FROM employee_salary_ledger WHERE employee_id = ? AND period_key = ? AND payment_type = 'full' AND status = 'posted' LIMIT 1`)
    .get(employee.id, periodKey);
  res.json({
    employeeId: employee.id,
    periodKey,
    periodLabel: jalaliPeriodLabel(periodKey),
    due: dueInfo.due,
    base: dueInfo.base,
    bonus: dueInfo.bonus,
    paid,
    remaining: Math.max(0, dueInfo.due - paid),
    fullPaid,
    canPayFull: !fullPaid && dueInfo.due - paid > 0,
    warnings: dueInfo.warnings,
    isBlocked: dueInfo.isBlocked,
    blockReason: dueInfo.blockReason ?? null,
  });
}));

employeesRouter.post('/:id/pay-salary', requirePermission('Payroll.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const employee = requireEmployee(req, req.params.id);
  if (employee.status === 'inactive') throw new HttpError(400, 'Cannot pay salary to an inactive employee.');

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  const monthName = body.monthName;
  const amountPaid = body.amountPaid;
  const paymentType = body.paymentType;
  if (amountPaid == null) throw new HttpError(400, 'Month and payment amount are required.');
  const periodKey = requirePayrollPeriod(monthName);

  // T-3: parse with the shared money boundary, THEN apply this endpoint's own
  // "greater than zero" rule to the parsed value. `Number()` is a coercion, so
  // `true` became a 1 AFN payment and '0x10' became a 16 AFN payment — both
  // real money, both answered 201. Sub-cent amounts passed `> 0` unrounded and
  // were rejected by the two-decimal database trigger as a raw 500;
  // assertMoney rounds 0.001 to 0, which this guard then refuses as a clean
  // 400. The accepted range is unchanged: any amount >= 0.01 still works.
  const resolvedAmount = assertMoney(amountPaid, 'Payment amount');
  if (resolvedAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');
  if (paymentType !== undefined && paymentType !== 'full' && paymentType !== 'partial' && paymentType !== 'advance') {
    throw new HttpError(400, 'Invalid payment type.');
  }
  const type: 'full' | 'partial' | 'advance' = paymentType === 'partial' || paymentType === 'advance' ? paymentType : 'full';

  // ── SERVER-SIDE IDEMPOTENCY (teacher audit T-1) ──────────────────────────
  // Always applied, never only when the caller remembers a key — the same
  // model the teacher payroll path uses. Without it — and ignoring an explicit
  // Idempotency-Key header — six concurrent identical 1,000 AFN partials
  // produce six payments and six expense rows (reproduced live on a fresh
  // database).
  //
  // The derived fingerprint collapses retries of the SAME intent while
  // leaving genuinely distinct payments alone: a different amount, a
  // different month, a different payment type or a later time bucket all
  // produce a different key. Verified: 1,000 partial + 2,500 partial +
  // another month + an advance all still succeed.
  const { key: idempotencyKey, candidates: idempotencyCandidates } = resolveIdempotency(req, {
    route: 'employee-pay-salary',
    employeeId: employee.id,
    periodKey,
    amount: resolvedAmount,
    type,
    actorUserId: user.userId,
  });

  const typeLabel = type === 'partial' ? 'partial salary' : type === 'advance' ? 'salary advance' : 'full salary';
  const date = today();
  const periodLabel = jalaliPeriodLabel(periodKey);

  const result = (() => {
    // BEGIN IMMEDIATE takes the write lock up front so the replay check, the
    // budget debit and both inserts are one atomic unit — matching the teacher
    // path. A budget read outside the transaction is not covered by that lock.
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = findEmployeeSalaryReplay(idempotencyCandidates) as
        | { id: string; employee_id: string; period_key: string; paid_amount: number; payment_type: string } | undefined;
      if (replay) {
        if (replay.employee_id !== employee.id || replay.period_key !== periodKey) {
          throw new HttpError(409, 'Idempotency key was already used for a different payroll operation.');
        }
        db.exec('COMMIT');
        return { amountPaid: Number(replay.paid_amount), ledgerId: replay.id, replayed: true, remainingBudget: null as number | null, dueInfo: null };
      }

      // DUE AUTHORITY (mirrors the teacher path; W12 due-composition). A
      // salary payment is bounded by what the period still owes — advances
      // included in what is already posted, so an advance is recovered against
      // later salary rather than being free extra money on top of a full
      // month. An advance itself stays uncapped by design: it is a receivable
      // against future pay, exactly as the taxonomy records it.
      // W12: the cap is the COMPOSED due — base salary plus any bonus an
      // active payroll rule legitimately earned (W9 §10.7: the bonus was
      // computable but unpayable, forcing a falsified base-salary raise).
      // Computed INSIDE the write lock so a concurrent rule change cannot make
      // the cap and the ledger row disagree.
      const employeeRow = db.prepare('SELECT base_salary, role FROM employees WHERE id = ?').get(employee.id) as { base_salary: number; role: string } | undefined;
      const dueInfo = computeEmployeePayroll({
        id: employee.id,
        branch_id: employee.branch_id,
        base_salary: Number(employeeRow?.base_salary) || 0,
        role: String(employeeRow?.role ?? ''),
      });
      if (dueInfo.isBlocked) throw new HttpError(409, dueInfo.blockReason || 'Payroll is blocked by policy.');
      const composedDue = dueInfo.due;
      const paidThisPeriod = Number((db
        .prepare(`SELECT COALESCE(SUM(paid_amount),0) AS s FROM employee_salary_ledger WHERE employee_id = ? AND period_key = ? AND status = 'posted'`)
        .get(employee.id, periodKey) as { s: number }).s) || 0;
      const remainingDue = Math.max(0, composedDue - paidThisPeriod);
      if (type !== 'advance') {
          // A second FULL payment against a settled month is classified as the
          // full-payment conflict deterministically here, not only when the
          // unique index happens to catch the insert below (the index stays as
          // the concurrency backstop). Mutation testing previously proved the
          // route's own classification was load-bearing; it still is.
          const fullAlreadyPosted = type === 'full' && !!db
            .prepare(`SELECT 1 FROM employee_salary_ledger WHERE employee_id = ? AND period_key = ? AND payment_type = 'full' AND status = 'posted' LIMIT 1`)
            .get(employee.id, periodKey);
          if (fullAlreadyPosted) throw new HttpError(409, `A full salary payment for \"${monthName}\" already exists.`);
        if (remainingDue <= 0) throw new HttpError(409, `Nothing remains payable for "${monthName}" (due ${composedDue} AFN = base ${dueInfo.base}${dueInfo.bonus ? ` + bonus ${dueInfo.bonus}` : ''}, ${paidThisPeriod} AFN already posted).`);
        if (resolvedAmount > remainingDue) {
          throw new HttpError(400, `Payment cannot exceed the remaining salary of ${remainingDue} AFN for "${monthName}".`);
        }
        if (type === 'full' && resolvedAmount !== remainingDue) {
          throw new HttpError(400, `Full payment must settle the entire remaining salary of ${remainingDue} AFN for "${monthName}".`);
        }
      }

      const budgetLine = stmtGetPayrollBudgetLine.get('employee', employee.branch_id) as BudgetRow | undefined;
      if (!budgetLine) throw new HttpError(500, 'Employee payroll budget line is not configured for this branch.');
      // Conditional debit: the balance is re-checked by the database in the
      // same statement that spends it, so two concurrent payments cannot both
      // pass a stale read.
      const debited = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?')
        .run(resolvedAmount, budgetLine.id, resolvedAmount);
      if (debited.changes !== 1) throw new HttpError(409, `Insufficient employee salary budget. Balance: ${budgetLine.current_amount} AFN.`);

      const txId = id('tx');
      const ledgerId = id('esl');
      // An employee advance is UNCAPPED — it may exceed salary already earned,
      // which makes it a receivable against future pay rather than a wage cost.
      // That is the one payroll case the canonical taxonomy classifies as a
      // Non-Expense Cash Movement, and the only reason the concept survives here
      // while the teacher path lost it.
      const isGenuineAdvance = type === 'advance';
      stmtInsertFinTx.run(
        txId,
        isGenuineAdvance ? 'salary_advance' : 'salary',
        payrollLedgerCategoryId(isGenuineAdvance),
        resolvedAmount, date,
        `Paid ${typeLabel} for ${monthName} to employee ${employee.full_name} (${employee.role})`,
        employee.id, user.fullName, employee.branch_id,
      );
      // The canonical financial trail this endpoint never had. `uq_employee_salary_full_period`
      // replaces the old description-LIKE guard for full payments.
      stmtInsertEmployeeSalaryLedger.run(ledgerId, employee.id, periodKey, periodLabel, composedDue, resolvedAmount, type, txId, dueInfo.bonus > 0 ? `Includes earned bonus of ${dueInfo.bonus} AFN (payroll rule).` : null, employee.branch_id, user.fullName, idempotencyKey);

      db.exec('COMMIT');
      return { amountPaid: resolvedAmount, ledgerId, replayed: false, remainingBudget: Number(budgetLine.current_amount) - resolvedAmount, dueInfo };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* rollback may already be complete */ }
      // Atomic backstop: under true concurrency several requests pass the
      // replay pre-check together and only one can win the unique index. The
      // losers replay the winner's result rather than paying twice or
      // surfacing a 500.
      if (isUniqueViolation(err)) {
        const winner = findEmployeeSalaryReplay([idempotencyKey]) as { id: string; employee_id: string; paid_amount: number } | undefined;
        if (winner && winner.employee_id === employee.id) {
          return { amountPaid: Number(winner.paid_amount), ledgerId: winner.id, replayed: true, remainingBudget: null as number | null };
        }
        // A full-period collision is a genuine business conflict, not a retry.
        throw new HttpError(409, `A full salary payment for "${monthName}" already exists.`);
      }
      throw err;
    }
  })();

  if (!result.replayed) {
    if (result.dueInfo && result.dueInfo.bonus > 0) {
      addNotification('Employee Salary Paid', `Salary of ${result.amountPaid} AFN (due ${result.dueInfo.due} = base ${result.dueInfo.base} + bonus ${result.dueInfo.bonus}) paid to employee ${employee.full_name}.`, 'success', employee.branch_id);
    } else {
      addNotification('Employee Salary Paid', `Salary of ${result.amountPaid} AFN paid to employee ${employee.full_name}.`, 'success', employee.branch_id);
    }
    writeAudit(req, `Paid salary to employee ${employee.full_name} — ${result.amountPaid} AFN for ${monthName}`);
  }
  res.status(201).json({
    ok: true, amountPaid: result.amountPaid, monthName, paymentType: type,
    ledgerId: result.ledgerId, replayed: result.replayed,
    remainingBudget: result.remainingBudget,
    due: result.dueInfo ? result.dueInfo.due : undefined,
    base: result.dueInfo ? result.dueInfo.base : undefined,
    bonus: result.dueInfo ? result.dueInfo.bonus : undefined,
  });
}));

employeesRouter.post('/:id/payroll/:ledgerId/void', requirePermission('Payroll.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const employee = requireEmployee(req, req.params.id);
  const ledger = stmtGetEmployeeSalaryLedger.get(req.params.ledgerId, employee.id) as any;
  if (!ledger) throw new HttpError(404, 'Salary payment record not found.');
  if (ledger.status === 'voided') throw new HttpError(409, 'Salary payment is already voided.');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 8) throw new HttpError(400, 'A void reason of at least 8 characters is required.');

  db.exec('BEGIN IMMEDIATE');
  try {
    const freshLedger = stmtGetEmployeeSalaryLedger.get(req.params.ledgerId, employee.id) as any;
    if (!freshLedger || freshLedger.status !== 'posted') throw new HttpError(409, 'Salary payment is no longer posted.');
    const payrollBranchId = freshLedger.branch_id;
    const budgetLine = stmtGetPayrollBudgetLine.get('employee', payrollBranchId) as BudgetRow | undefined;
    if (!budgetLine) throw new HttpError(500, 'Employee payroll budget line is not configured for this branch.');

    const amount = Number(freshLedger.paid_amount);
    const isGenuineAdvance = freshLedger.payment_type === 'advance';
    const reversalTxId = id('tx');
    stmtUpdateBudgetAmount.run(-amount, budgetLine.id);
    stmtInsertFinTx.run(
      reversalTxId,
      isGenuineAdvance ? 'salary_advance' : 'salary',
      payrollLedgerCategoryId(isGenuineAdvance),
      -amount,
      today(),
      `Voided employee salary payment ${freshLedger.id}: ${reason}`,
      freshLedger.id,
      user.fullName,
      payrollBranchId,
    );
    stmtVoidEmployeeSalaryLedger.run(user.fullName, reason, freshLedger.id);
    db.exec('COMMIT');

    writeAudit(req, `Voided employee salary payment ${freshLedger.id} for ${employee.full_name}: ${reason}`);
    addNotification('Employee Salary Voided', `Salary payment for ${employee.full_name} was voided.`, 'warning', employee.branch_id);
    res.json({ ok: true, ledgerId: freshLedger.id, reversalTransactionId: reversalTxId, amountRestored: amount });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* rollback may already be complete */ }
    throw error;
  }
}));

export default teachersRouter;
