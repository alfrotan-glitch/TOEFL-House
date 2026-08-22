/**
 * TOEFL House ERP — Class-Linked Teacher Payroll Engine
 * ============================================================
 * Implements the FIVE teacher contract types, 100-point evaluation
 * integration, and dynamic Rule Engine lookups for levels and performance
 * bonuses.
 *
 * ── SKILL vs CONTRACT TYPE ────────────────────────────────────────────────
 * A SKILL (a row in `class_teacher_skills`) is the record of a teacher's
 * actual teaching workload in a class. A CONTRACT TYPE
 * (`teachers.salary_type`) decides only HOW that teacher is PAID.
 *
 *   Teaching activity -> Skill -> workload / performance / reports
 *   Contract type     -> compensation rule -> payroll
 *
 * Contract type therefore NEVER decides whether a Skill may be recorded or
 * reported. Every model below returns `skillCount` — the teacher's real
 * workload for the period — even when that workload contributes no money
 * (a fixed contract being the obvious case).
 *
 * Enterprise Grade: N+1 queries resolved, Rule Engine cached, Strict Types.
 */
import type Database from 'better-sqlite3';
import { evaluateRules } from '../configuration/rule-engine.js';
import {
  jalaliMonthToGregorianRange,
  isoToJalaliPeriodKey,
  AFGHAN_MONTHS_FA,
  AFGHAN_MONTHS_EN,
  toLatinDigits,
} from '../../utils/jalali.js';

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

/**
 * THE FIVE TEACHER CONTRACT TYPES — discovered from, and enforced by, the
 * live database (`teachers.salary_type` CHECK, migrations 029 / 059).
 * This constant is the single source of truth shared by the payroll engine,
 * the HTTP routes and the schema. Do not extend it without a migration.
 */
export const CONTRACT_TYPES = ['fixed', 'per_skill', 'per_session', 'hybrid', 'per_level'] as const;

export type TeacherSalaryModel = (typeof CONTRACT_TYPES)[number];

/**
 * Narrows a stored value to one of the five contract types.
 *
 * Both columns that can supply one — `teachers.salary_type` and
 * `teacher_compensation_history.salary_type` — carry a CHECK for exactly these
 * five, so an out-of-vocabulary value cannot be stored and this is a total
 * function over what the database can hold. `'fixed'` is the answer for the
 * remaining cases (NULL, or a value read from somewhere unconstrained) because
 * paying a base salary is the safe reading; the alternative, computing 0, pays
 * a teacher nothing without saying why.
 */
export function normalizeContractType(value: unknown): TeacherSalaryModel {
  const raw = String(value ?? '').trim();
  if ((CONTRACT_TYPES as readonly string[]).includes(raw)) return raw as TeacherSalaryModel;
  return 'fixed';
}

/** True when the contract's compensation rule pays per recorded Skill. */
export function contractPaysPerSkill(model: TeacherSalaryModel): boolean {
  return model === 'per_skill' || model === 'hybrid' || model === 'per_level';
}

export interface TeacherPayrollInput {
  id: string;
  branch_id: string;
  base_salary: number;
  salary_type: string;
  default_skill_rate: number;
  performance_score: number;
}

/** A configured payroll rule is authoritative policy, so it must either
 * evaluate successfully or stop the calculation. */
export class PayrollRuleConfigurationError extends Error {
  constructor(message = 'Active payroll configuration cannot be evaluated.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PayrollRuleConfigurationError';
  }
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
      // Bounded by the Gregorian span of the Shamsi payroll month. A
      // `date LIKE 'YYYY-MM%'` prefix match cannot work here: the period key
      // is Shamsi ('1405-05') while `sessions.date` is Gregorian, so the
      // prefix would never match and per-session teachers would be paid 0.
      `SELECT COUNT(*) as c FROM sessions s
       WHERE s.teacher_id = ? AND s.status = 'completed' AND s.date BETWEEN ? AND ?
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
    /** WORKLOAD, not money: every Skill the teacher actually holds in the
     *  period, for EVERY contract type. Mirrors the payroll assignment
     *  window but is deliberately free of any rate/eligibility condition —
     *  contract type must never suppress a workload record. */
    countSkillsForPeriod: db.prepare(
      `SELECT COUNT(*) as c
       FROM class_teacher_skills cts
       JOIN classes c ON c.id = cts.class_id
       WHERE cts.teacher_id = ?
         AND (cts.start_date IS NULL OR cts.start_date <= ?)
         AND (cts.end_date IS NULL OR cts.end_date >= ?)
         AND (c.start_date IS NULL OR c.start_date <= ?)
         AND (c.end_date IS NULL OR c.end_date >= ?)
         AND c.status <> 'cancelled'`
    ),
    getTargetSkills: db.prepare(
      `SELECT COALESCE(target_skills_per_month, 0) AS t FROM teachers WHERE id = ?`
    ),
    // VOIDED rows must not count as paid.
    //
    // Both of these ignored `status`, so a voided salary payment still
    // occupied the period: after voiding a wrong 10,000 AFN payment the clerk
    // got "Nothing remains payable" and the teacher could NEVER be paid for
    // that month again. Voiding is advertised as a correction mechanism, so it
    // has to actually release the period it reverses.
    sumPaidForPeriod: db.prepare(
      `SELECT COALESCE(SUM(paid_amount), 0) as s FROM teacher_salary_ledger
        WHERE teacher_id = ? AND period_key = ? AND status = 'posted'`
    ),
    checkFullPay: db.prepare(
      `SELECT id FROM teacher_salary_ledger
        WHERE teacher_id = ? AND period_key = ? AND payment_type = 'full' AND status = 'posted' LIMIT 1`
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

/** Today's date in the SERVER'S LOCAL calendar.
 *
 *  This must agree with utils/ids.ts `today()`, which is what every route
 *  writes into date columns. Using UTC here instead caused a real off-by-one:
 *  in Kabul (UTC+04:30) between 19:30 and midnight local, `today()` already
 *  returns tomorrow while UTC still returns today, so a class starting
 *  "today" was judged not yet operational and dropped from payroll. Dates in
 *  this system are calendar days, not instants, so the local calendar is the
 *  correct basis. */
export function gregorianToday(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** Checks if a class is operational for payroll purposes */
function isClassOperational(
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

  let result;
  try {
    result = evaluateRules({ category: 'payroll', branchId, data, dryRun: true });
  } catch (cause) {
    throw new PayrollRuleConfigurationError(undefined, { cause });
  }

  const numericOutput = (key: string, fallback: number | null): number | null => {
    if (!Object.prototype.hasOwnProperty.call(result.finalOutputs, key)) return fallback;
    const value = result.finalOutputs[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PayrollRuleConfigurationError(`Active payroll rule produced a non-numeric ${key}.`);
    }
    return value;
  };

  const value = {
    enrollmentMultiplier: numericOutput('enrollmentMultiplier', 1) as number,
    performanceMultiplier: numericOutput('performanceMultiplier', 1) as number,
    levelRate: numericOutput('levelRate', null),
    isBlocked: result.isBlocked,
    blockReason: result.blockReason,
    warnings: result.warnings || []
  };
  cache.set(cacheKey, value);
  return value;
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
  /** Actual recorded teaching workload for the period — reported for EVERY
   *  contract type, including those where Skills add no compensation. */
  skillCount: number;
  /** Configured monthly workload target (0 = none configured). */
  targetSkills: number;
  /** max(target - actual, 0) — reporting only, never alters pay. */
  shortfall: number;
  /** max(actual - target, 0) — reporting only, never alters pay. */
  excess: number;
  breakdown: ClassPayrollLine[] | { label: string; amount: number }[];
  warnings: string[];
  isBlocked: boolean;
  blockReason?: string;
} {
  const stmts = getStmts(db);
  const ruleCache = createRuleEngineCache();
  // ── PERIOD RESOLUTION (Hijri Shamsi) ─────────────────────────────────────
  // Payroll periods are SHAMSI months, matching how Afghan payroll is
  // actually run. `periodKey` is a Shamsi key such as '1405-05' (اسد ۱۴۰۵).
  // Dates in the database remain Gregorian, so the Shamsi month is resolved
  // to its exact Gregorian span and every query below is unchanged.
  const targetPeriod = periodKey && /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)
    ? periodKey
    : currentJalaliPeriodKey();
  const { start: periodStart, end: periodEnd } = jalaliMonthToGregorianRange(
    Number(targetPeriod.slice(0, 4)),
    Number(targetPeriod.slice(5, 7)),
  );
  const branchAsOf = teacherBranchAsOf(db, teacher.id, periodEnd, teacher.branch_id);
  const compensation = stmts.getCompensationAsOf.get(teacher.id, periodStart) as { base_salary?: number; salary_type?: string; contract_type?: string | null; default_skill_rate?: number } | undefined;
  const evaluation = stmts.getEvaluationAsOf.get(teacher.id, periodEnd) as { score?: number } | undefined;
  const model = normalizeContractType(compensation?.salary_type || teacher.salary_type);
  const baseSalary = Number(compensation?.base_salary ?? teacher.base_salary) || 0;
  const defaultRate = Number(compensation?.default_skill_rate ?? teacher.default_skill_rate) || 0;
  const perfScore = Number(evaluation?.score ?? teacher.performance_score) || 0;
  
  // 1. Get Performance Multiplier (Evaluation Impact) - Applies to ALL models
  const perfEval = getRuleEngineValues(ruleCache, branchAsOf, { performanceScore: perfScore });
  const perfMultiplier = perfEval.performanceMultiplier;
  
  const breakdown: ClassPayrollLine[] = [];
  const allWarnings: string[] = perfEval.warnings;
  let skillsTotal = 0;

  // ── WORKLOAD (contract-independent) ──────────────────────────────────────
  // Counted for every model before any compensation branch, so that a Skill
  // is never invisible merely because the contract does not pay for it.
  const skillCount = Number(
    (stmts.countSkillsForPeriod.get(teacher.id, periodEnd, periodStart, periodEnd, periodStart) as { c: number })?.c ?? 0
  );
  const targetSkills = Number((stmts.getTargetSkills.get(teacher.id) as { t?: number } | undefined)?.t ?? 0);
  const workload = {
    skillCount,
    targetSkills,
    shortfall: targetSkills > 0 ? Math.max(0, targetSkills - skillCount) : 0,
    excess: targetSkills > 0 ? Math.max(0, skillCount - targetSkills) : 0,
  };

  // Model: FIXED — guaranteed monthly salary. Skills ARE recorded and
  // reported, but they do not multiply into pay.
  if (model === 'fixed') {
    const dueAmount = Math.round(baseSalary * perfMultiplier);
    return {
      model, due: dueAmount, base: baseSalary, skillsTotal: 0, ...workload,
      breakdown: [{ label: `Base Salary (${perfMultiplier}x Performance)`, amount: dueAmount }],
      warnings: allWarnings, isBlocked: perfEval.isBlocked, blockReason: perfEval.blockReason
    };
  }

  // Model: PER_SESSION — paid per completed session, not per Skill; the
  // Skill workload is still reported.
  if (model === 'per_session') {
    const sessions = stmts.countCompletedSessions.get(teacher.id, periodStart, periodEnd, teacher.id, teacher.id, teacher.id) as { c: number };
    const sessionRate = defaultRate > 0 ? defaultRate : (baseSalary > 0 ? Math.round(baseSalary / 20) : 0);
    const total = sessions.c * sessionRate * perfMultiplier;
    
    return {
      model, due: Math.round(total), base: 0, skillsTotal: total, ...workload,
      breakdown: [{ label: `${sessions.c} Sessions × ${sessionRate} AFN (${perfMultiplier}x Perf)`, amount: Math.round(total) }],
      warnings: allWarnings, isBlocked: perfEval.isBlocked, blockReason: perfEval.blockReason
    };
  }

  // Models: PER_SKILL, HYBRID, PER_LEVEL — compensation derives from the
  // Skills actually recorded for the period.
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

  // HYBRID pays a fixed component PLUS the Skill component, each separately
  // visible so reports never conflate them. PER_SKILL / PER_LEVEL are pure
  // Skill-derived compensation (no fixed component).
  const finalBase = model === 'hybrid' ? Math.round(baseSalary * perfMultiplier) : 0;
  const finalDue = finalBase + skillsTotal;

  return {
    model,
    due: finalDue,
    base: finalBase,
    skillsTotal,
    ...workload,
    breakdown,
    warnings: allWarnings,
    isBlocked: perfEval.isBlocked,
    blockReason: perfEval.blockReason
  };
}

// ── Period & Ledger Helpers ────────────────────────────────────────────────

/** The Shamsi period key for the current local date, e.g. '1405-05'. */
export function currentJalaliPeriodKey(): string {
  return isoToJalaliPeriodKey(gregorianToday()) ?? '';
}

/**
 * Normalises a month label into a SHAMSI period key ('1405-05').
 *
 * Accepts, in order:
 *   - a Shamsi key already:            '1405-05', '1405/5'
 *   - an Afghan month name:            'اسد ۱۴۰۵', 'Asad 1405'
 *   - a Gregorian month key/name:      '2026-08', 'August 2026'
 *
 * Gregorian input is CONVERTED to the Shamsi period that contains its first
 * day, so links, bookmarks and API clients that still send '2026-08' keep
 * working instead of silently computing an empty period.
 */
export function toPeriodKey(monthName: string): string {
  const s = toLatinDigits(String(monthName || '').trim());

  // Afghan month name + year (Dari or Latin transliteration).
  const nameMatch = s.match(/^(\S+)\s+(\d{4})$/);
  if (nameMatch) {
    const label = nameMatch[1];
    const idxFa = (AFGHAN_MONTHS_FA as readonly string[]).indexOf(label);
    const idxEn = (AFGHAN_MONTHS_EN as readonly string[]).findIndex((m) => m.toLowerCase() === label.toLowerCase());
    // Operators use more than one established Latin transliteration for three
    // Afghan month names. They all normalize to the same stored month key.
    const aliasIndex: Record<string, number> = { saur: 1, sonbola: 5, hoot: 11 };
    const idxAlias = aliasIndex[label.toLowerCase()] ?? -1;
    const idx = idxFa >= 0 ? idxFa : idxEn >= 0 ? idxEn : idxAlias;
    if (idx >= 0) return `${nameMatch[2]}-${String(idx + 1).padStart(2, '0')}`;
  }

  // Numeric 'YYYY-MM' / 'YYYY/M'.
  const numeric = s.match(/^(\d{4})\s*[/-]\s*(\d{1,2})$/);
  if (numeric && Number(numeric[2]) >= 1 && Number(numeric[2]) <= 12) {
    const year = Number(numeric[1]);
    const month = String(numeric[2]).padStart(2, '0');
    // A four-digit year in the Gregorian range is a Gregorian date: convert it.
    if (year >= 1800) return isoToJalaliPeriodKey(`${year}-${month}-01`) ?? '';
    return `${year}-${month}`;
  }

  // Gregorian month name.
  const gregorian = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i);
  if (gregorian) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const gm = months.findIndex((m) => m.toLowerCase() === gregorian[1].toLowerCase()) + 1;
    return isoToJalaliPeriodKey(`${gregorian[2]}-${String(gm).padStart(2, '0')}-01`) ?? '';
  }

  return '';
}

/** Canonical stored payroll-period shape: a Solar Hijri year and month. */
export const PAYROLL_PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPayrollPeriodKey(value: unknown): value is string {
  return typeof value === 'string' && PAYROLL_PERIOD_KEY.test(value);
}

/** Normalizes an API value only when it names one real payroll period. */
export function resolvePayrollPeriodKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const periodKey = toPeriodKey(value);
  return isPayrollPeriodKey(periodKey) ? periodKey : null;
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