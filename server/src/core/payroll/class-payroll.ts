/**
 * TOEFL House ERP — Class-Linked Teacher Payroll Engine
 * ============================================================
 * Supports 6 contract types, 100-point evaluation integration, 
 * and dynamic Rule Engine lookups for levels and performance bonuses.
 * Enterprise Grade: N+1 queries resolved, Rule Engine cached, Strict Types.
 */
import type Database from 'better-sqlite3';
import { evaluateRules } from '../configuration/rule-engine.js';

export interface ClassPayrollLine {
  classId: string;
  className: string;
  level: string;
  skillName: string;
  enrolledCount: number;
  baseRate: number;
  enrollmentMultiplier: number;
  performanceMultiplier: number;
  adjustedAmount: number;
}

// The DB defines EXACTLY FIVE contract types (teachers.salary_type CHECK):
// fixed | per_skill | per_session | hybrid | per_level. 'hybrid_skill' and
// 'hybrid_level' are legacy aliases that can only exist in compensation
// history (the teachers table CHECK never admitted them); they are treated
// as 'hybrid' for calculation.
export type TeacherSalaryModel = 'fixed' | 'per_skill' | 'per_level' | 'per_session' | 'hybrid' | 'hybrid_skill' | 'hybrid_level';

export interface TeacherPayrollInput {
  id: string;
  branch_id: string;
  base_salary: number;
  salary_type: string;
  default_skill_rate: number;
  performance_score: number;
}

interface AssignmentRow {
  skill_id: string;
  monthly_rate: number;
  level: string;
  class_id: string;
  class_name: string;
  skill_name: string;
  status: string;
  activation_date: string | null;
  start_date: string | null;
}

// ── Module-Level Prepared Statements (WeakMap Cache) ───────────────────────
const stmtCache = new WeakMap<Database.Database, any>();

function getStmts(db: Database.Database) {
  if (stmtCache.has(db)) return stmtCache.get(db);
  
  const stmts = {
    getTeacherAssignments: db.prepare(
      `SELECT cts.skill_id, cts.monthly_rate, c.level, c.id as class_id, c.name as class_name,
              s.name as skill_name, c.status, c.activation_date, c.start_date, c.end_date
       FROM class_teacher_skills cts
       JOIN classes c ON c.id = cts.class_id
       JOIN skills s ON s.id = cts.skill_id
       WHERE cts.teacher_id = ?
         AND cts.branch_id = ?
         AND c.branch_id = ?
         AND cts.assignment_type IN ('primary','assistant')
         AND (cts.start_date IS NULL OR cts.start_date <= ?)
         AND (cts.end_date IS NULL OR cts.end_date >= ?)
         AND (c.start_date IS NULL OR c.start_date <= ?)
         AND (c.end_date IS NULL OR c.end_date >= ?)
         AND c.status <> 'cancelled'`
    ),
    countEnrolledBatch: db.prepare(
      `SELECT class_id, COUNT(*) as c FROM student_semesters 
       WHERE status <> 'deferred' AND enroll_date <= ? AND class_id IN (SELECT value FROM json_each(?)) 
       GROUP BY class_id`
    ),
    countCompletedSessions: db.prepare(
      `SELECT COUNT(*) as c FROM sessions s
       WHERE s.teacher_id = ? AND s.status = 'completed' AND s.date LIKE ?
         AND s.branch_id = COALESCE((
           SELECT h.to_branch_id
           FROM teacher_branch_history h
           WHERE h.teacher_id = ? AND h.effective_date <= date(s.date)
           ORDER BY h.effective_date DESC, h.created_at DESC
           LIMIT 1
         ), (
           SELECT h.from_branch_id
           FROM teacher_branch_history h
           WHERE h.teacher_id = ?
           ORDER BY h.effective_date ASC, h.created_at ASC
           LIMIT 1
         ), (SELECT t.branch_id FROM teachers t WHERE t.id = ?))`
    ),
    getCompensationAsOf: db.prepare(
      `SELECT base_salary, salary_type, contract_type, default_skill_rate
       FROM teacher_compensation_history
       WHERE teacher_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC, created_at DESC
       LIMIT 1`
    ),
    getEvaluationAsOf: db.prepare(
      `SELECT score FROM teacher_evaluations
       WHERE teacher_id = ? AND date <= ?
       ORDER BY date DESC, created_at DESC
       LIMIT 1`
    ),
    getLevelSkillRate: db.prepare(
      `SELECT rate_per_skill FROM teacher_level_skill_rates
       WHERE teacher_id = ? AND branch_id = (SELECT branch_id FROM teachers WHERE id = ?)
         AND level_code = ? AND (skill_id = ? OR skill_id IS NULL)
       ORDER BY CASE WHEN skill_id = ? THEN 0 ELSE 1 END
       LIMIT 1`
    ),
    sumPaidForPeriod: db.prepare(
      `SELECT COALESCE(SUM(paid_amount), 0) as s FROM teacher_salary_ledger WHERE teacher_id = ? AND period_key = ?`
    ),
    checkFullPay: db.prepare(
      `SELECT id FROM teacher_salary_ledger WHERE teacher_id = ? AND period_key = ? AND payment_type = 'full' LIMIT 1`
    )
  };
  
  stmtCache.set(db, stmts);
  return stmts;
}

// ── Helper Functions ───────────────────────────────────────────────────────

export function teacherBranchAsOf(
  db: Database.Database,
  teacherId: string,
  asOfDate: string,
  fallbackBranchId: string,
): string {
  const row = db.prepare(
    `SELECT COALESCE(
       (SELECT h.to_branch_id
        FROM teacher_branch_history h
        WHERE h.teacher_id = ? AND h.effective_date <= ?
        ORDER BY h.effective_date DESC, h.created_at DESC
        LIMIT 1),
       (SELECT h.from_branch_id
        FROM teacher_branch_history h
        WHERE h.teacher_id = ?
        ORDER BY h.effective_date ASC, h.created_at ASC
        LIMIT 1),
       t.branch_id,
       ?
     ) AS branch_id
     FROM teachers t WHERE t.id = ?`
  ).get(teacherId, asOfDate, teacherId, fallbackBranchId, teacherId) as { branch_id?: string } | undefined;
  return row?.branch_id || fallbackBranchId;
}

export function gregorianToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Checks if a class is operational for payroll purposes */
export function isClassOperational(
  row: { status: string; activation_date?: string | null; start_date?: string | null; end_date?: string | null },
  asOfDate: string = gregorianToday(),
): boolean {
  if (row.status === 'draft' || row.status === 'cancelled') return false;
  const activationDate = row.activation_date || row.start_date;
  if (activationDate && activationDate > asOfDate) return false;
  if (row.end_date && row.end_date < asOfDate) return false;
  return true;
}

/** Rule Engine Cache to prevent repeated expensive evaluations */
function createRuleEngineCache() {
  const cache = new Map<string, any>();
  return {
    has: (key: string) => cache.has(key),
    get: (key: string) => cache.get(key),
    set: (key: string, val: any) => cache.set(key, val)
  };
}

function getRuleEngineValues(cache: ReturnType<typeof createRuleEngineCache>, branchId: string, data: Record<string, unknown>) {
  const cacheKey = JSON.stringify(data);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const result = evaluateRules({ category: 'payroll', branchId, data, dryRun: true });
    const value = {
      enrollmentMultiplier: typeof result.finalOutputs.enrollmentMultiplier === 'number' ? result.finalOutputs.enrollmentMultiplier : 1,
      performanceMultiplier: typeof result.finalOutputs.performanceMultiplier === 'number' ? result.finalOutputs.performanceMultiplier : 1,
      levelRate: typeof result.finalOutputs.levelRate === 'number' ? result.finalOutputs.levelRate : null,
      isBlocked: result.isBlocked,
      blockReason: result.blockReason,
      warnings: result.warnings || []
    };
    cache.set(cacheKey, value);
    return value;
  } catch (e) {
    const fallback = { enrollmentMultiplier: 1, performanceMultiplier: 1, levelRate: null, isBlocked: false, blockReason: '', warnings: [] };
    cache.set(cacheKey, fallback);
    return fallback;
  }
}

// ── Main Payroll Calculator ────────────────────────────────────────────────

export function computeTeacherDueAmount(
  db: Database.Database,
  teacher: TeacherPayrollInput,
  periodKey?: string
): {
  model: TeacherSalaryModel;
  due: number;
  base: number;
  skillsTotal: number;
  breakdown: ClassPayrollLine[] | { label: string; amount: number }[];
  warnings: string[];
  isBlocked: boolean;
  blockReason?: string;
} {
  const stmts = getStmts(db);
  const ruleCache = createRuleEngineCache();
  const targetPeriod = periodKey && /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey) ? periodKey : gregorianToday().slice(0, 7);
  const periodStart = `${targetPeriod}-01`;
  const periodEnd = new Date(Date.UTC(Number(targetPeriod.slice(0, 4)), Number(targetPeriod.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const branchAsOf = teacherBranchAsOf(db, teacher.id, periodEnd, teacher.branch_id);
  const compensation = stmts.getCompensationAsOf.get(teacher.id, periodStart) as { base_salary?: number; salary_type?: string; contract_type?: string | null; default_skill_rate?: number } | undefined;
  const evaluation = stmts.getEvaluationAsOf.get(teacher.id, periodEnd) as { score?: number } | undefined;
  const rawModel = (compensation?.salary_type || teacher.salary_type || 'fixed') as TeacherSalaryModel;
  // Normalize legacy aliases to the DB's 'hybrid' (see type comment above).
  const model: TeacherSalaryModel = rawModel === 'hybrid_skill' || rawModel === 'hybrid_level' ? 'hybrid' : rawModel;
  const baseSalary = Number(compensation?.base_salary ?? teacher.base_salary) || 0;
  const defaultRate = Number(compensation?.default_skill_rate ?? teacher.default_skill_rate) || 0;
  const perfScore = Number(evaluation?.score ?? teacher.performance_score) || 0;
  
  // 1. Get Performance Multiplier (Evaluation Impact) - Applies to ALL models
  const perfEval = getRuleEngineValues(ruleCache, branchAsOf, { performanceScore: perfScore });
  const perfMultiplier = perfEval.performanceMultiplier;
  
  const breakdown: ClassPayrollLine[] = [];
  const allWarnings: string[] = perfEval.warnings;
  let skillsTotal = 0;

  // Model: FIXED
  if (model === 'fixed') {
    const dueAmount = Math.round(baseSalary * perfMultiplier);
    return {
      model, due: dueAmount, base: baseSalary, skillsTotal: 0,
      breakdown: [{ label: `Base Salary (${perfMultiplier}x Performance)`, amount: dueAmount }],
      warnings: allWarnings, isBlocked: perfEval.isBlocked, blockReason: perfEval.blockReason
    };
  }

  // Model: PER_SESSION
  if (model === 'per_session') {
    const sessions = stmts.countCompletedSessions.get(teacher.id, `${targetPeriod}%`, teacher.id, teacher.id, teacher.id) as { c: number };
    const sessionRate = defaultRate > 0 ? defaultRate : (baseSalary > 0 ? Math.round(baseSalary / 20) : 0);
    const total = sessions.c * sessionRate * perfMultiplier;
    
    return {
      model, due: Math.round(total), base: 0, skillsTotal: total,
      breakdown: [{ label: `${sessions.c} Sessions × ${sessionRate} AFN (${perfMultiplier}x Perf)`, amount: Math.round(total) }],
      warnings: allWarnings, isBlocked: perfEval.isBlocked, blockReason: perfEval.blockReason
    };
  }

  // Models: PER_SKILL, HYBRID_SKILL, PER_LEVEL, HYBRID_LEVEL
  const assignments = stmts.getTeacherAssignments.all(teacher.id, branchAsOf, branchAsOf, periodEnd, periodStart, periodEnd, periodStart) as AssignmentRow[];

  const operationalClasses = assignments.filter(a => isClassOperational(a, periodEnd));
  
  // Batch fetch enrolled counts for operational classes only
  const classIds = operationalClasses.map(c => c.class_id);
  const enrolledCountsMap = new Map<string, number>();
  
  if (classIds.length > 0) {
    const counts = stmts.countEnrolledBatch.all(periodEnd, JSON.stringify(classIds)) as Array<{ class_id: string; c: number }>;
    counts.forEach(item => enrolledCountsMap.set(item.class_id, item.c));
  }

  for (const row of operationalClasses) {
    const enrolledCount = enrolledCountsMap.get(row.class_id) || 0;
    
    // Get Enrollment Multiplier
    const enrollEval = getRuleEngineValues(ruleCache, branchAsOf, { enrolledCount });
    const enrollMultiplier = enrollEval.enrollmentMultiplier;
    allWarnings.push(...enrollEval.warnings);

    let baseRate = 0;

    if (model === 'per_skill' || model === 'hybrid') {
      baseRate = Number(row.monthly_rate) > 0 ? Number(row.monthly_rate) : defaultRate;
    } else if (model === 'per_level') {
      const specificRate = stmts.getLevelSkillRate.get(teacher.id, teacher.id, row.level, row.skill_id, row.skill_id) as { rate_per_skill?: number } | undefined;
      if (specificRate && Number(specificRate.rate_per_skill) > 0) {
        baseRate = Number(specificRate.rate_per_skill);
      } else {
        const levelEval = getRuleEngineValues(ruleCache, branchAsOf, { level: row.level });
        baseRate = levelEval.levelRate ?? defaultRate;
        allWarnings.push(...levelEval.warnings);
      }
    }

    const adjustedAmount = Math.round(baseRate * enrollMultiplier * perfMultiplier);
    skillsTotal += adjustedAmount;

    breakdown.push({
      classId: row.class_id,
      className: row.class_name,
      level: row.level,
      skillName: row.skill_name,
      enrolledCount,
      baseRate,
      enrollmentMultiplier: enrollMultiplier,
      performanceMultiplier: perfMultiplier,
      adjustedAmount,
    });
  }

  // Calculate final due based on hybrid (base + skills) or pure skill/level
  const finalBase = model === 'hybrid' ? Math.round(baseSalary * perfMultiplier) : 0;
  const finalDue = finalBase + skillsTotal;

  return {
    model: model === 'hybrid' ? 'hybrid' : model,
    due: finalDue,
    base: finalBase,
    skillsTotal,
    breakdown,
    warnings: allWarnings,
    isBlocked: perfEval.isBlocked,
    blockReason: perfEval.blockReason
  };
}

// ── Period & Ledger Helpers ────────────────────────────────────────────────

export function toPeriodKey(monthName: string): string {
  const s = String(monthName || '').trim();
  const m1 = s.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (m1) return `${m1[1]}-${m1[2]}`;
  const m2 = s.match(/^(\d{4})\s*[/-]\s*(\d{1,2})$/);
  if (m2 && Number(m2[2]) >= 1 && Number(m2[2]) <= 12) return `${m2[1]}-${m2[2].padStart(2, '0')}`;
  const m3 = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
  if (m3) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${m3[2]}-${String(months.findIndex(m => m.toLowerCase() === m3[1].toLowerCase()) + 1).padStart(2, '0')}`;
  }
  return '';
}

export function sumPaidForPeriod(db: Database.Database, teacherId: string, periodKey: string): number {
  const stmts = getStmts(db);
  const row = stmts.sumPaidForPeriod.get(teacherId, periodKey) as { s: number };
  return Number(row?.s) || 0;
}

export function hasFullPayForPeriod(db: Database.Database, teacherId: string, periodKey: string): boolean {
  const stmts = getStmts(db);
  const row = stmts.checkFullPay.get(teacherId, periodKey) as { id?: string } | undefined;
  return !!row?.id;
}