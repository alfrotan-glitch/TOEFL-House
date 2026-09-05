/**
 * TOEFL House ERP — Employee Payroll Due Composition (Wave 12 / W9 §10.7)
 * ============================================================================
 * Wave 9 §10.7 established the competing-path defect: an employee bonus could
 * only be realized by temporarily raising `employees.base_salary` — falsifying
 * the contract fact — because employee payroll due was base salary alone while
 * TEACHER payroll already composes rule-engine bonuses into dues. The
 * authorized fix is symmetric completion: employee due-composition includes a
 * legitimately earned bonus component computed by the same declared authority
 * the teacher path uses — ACTIVE PAYROLL RULES (category 'payroll').
 *
 * NO POLICY IS INVENTED HERE
 * --------------------------
 *  · Eligibility, percentages, maximums and approval requirements are not
 *    hardcoded: they live in operator-configured payroll rules, exactly as the
 *    teacher performance/enrollment multipliers do. "A configured payroll rule
 *    is authoritative policy" (class-payroll.ts).
 *  · No rule produces a bonus → bonus is 0 and behavior is IDENTICAL to the
 *    pre-composition cap (base salary). Nothing is paid that was not payable
 *    before; the only change is that a DECLARED bonus becomes payable without
 *    falsifying the contract.
 *  · A rule producing a NEGATIVE bonus would be a DEDUCTION — Wave 9 marked
 *    deductions F (policy-blocked, no surface). Refused loudly, never clamped:
 *    silently rewriting a configured −500 into 0 would move different money
 *    than the configuration says (LAW 6).
 *  · A non-numeric or non-finite bonus is a configuration defect → the
 *    calculation stops (PayrollRuleConfigurationError), mirroring teachers.
 *
 * RULE CONTRACT (declared, not invented)
 * --------------------------------------
 * evaluateRules({ category: 'payroll', branchId, data: { role, baseSalary } })
 * An active rule may output `employeeBonus` (whole AFN, ≥ 0) — an absolute
 * amount added to the period's due. The output key is read exactly as the
 * teacher path reads `performanceMultiplier`/`enrollmentMultiplier`.
 */
import type Database from 'better-sqlite3';
import { evaluateRules } from '../configuration/rule-engine.js';
import { PayrollRuleConfigurationError } from './class-payroll.js';

export interface EmployeePayrollInput {
  id: string;
  branch_id: string;
  base_salary: number;
  role: string;
}

export interface EmployeeDueComputation {
  /** The employee's period due: base salary + earned bonus. */
  due: number;
  base: number;
  /** Bonus component from active payroll rules (0 when none applies). */
  bonus: number;
  /** The rule outputs that produced the bonus, for the payment trail. */
  warnings: string[];
  isBlocked: boolean;
  blockReason?: string;
}

/** The rule-engine output key that carries an employee's earned bonus. */
export const EMPLOYEE_BONUS_RULE_KEY = 'employeeBonus';

export function computeEmployeeDueAmount(
  db: Database.Database,
  employee: EmployeePayrollInput,
): EmployeeDueComputation {
  const baseSalary = Number(employee.base_salary) || 0;
  let result: ReturnType<typeof evaluateRules>;
  try {
    result = evaluateRules({
      category: 'payroll',
      branchId: employee.branch_id,
      data: { role: employee.role, baseSalary },
      dryRun: true,
    });
  } catch (cause) {
    throw new PayrollRuleConfigurationError(undefined, { cause });
  }

  const hasKey = Object.prototype.hasOwnProperty.call(result.finalOutputs, EMPLOYEE_BONUS_RULE_KEY);
  let bonus = 0;
  if (hasKey) {
    const raw = result.finalOutputs[EMPLOYEE_BONUS_RULE_KEY];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new PayrollRuleConfigurationError(
        `Active payroll rule produced a non-numeric ${EMPLOYEE_BONUS_RULE_KEY}.`,
      );
    }
    if (raw < 0) {
      // A negative bonus is a deduction — Wave 9 policy block F. Refuse the
      // whole calculation rather than silently clamping the configured value.
      throw new PayrollRuleConfigurationError(
        `Active payroll rule produced a negative ${EMPLOYEE_BONUS_RULE_KEY} (${raw}). Deductions are not authorized; correct or deactivate the rule.`,
      );
    }
    if (!Number.isInteger(raw)) {
      throw new PayrollRuleConfigurationError(
        `Active payroll rule produced a fractional ${EMPLOYEE_BONUS_RULE_KEY} (${raw}); payroll pays whole AFN.`,
      );
    }
    bonus = raw;
  }

  return {
    due: baseSalary + bonus,
    base: baseSalary,
    bonus,
    warnings: [...(result.warnings || [])],
    isBlocked: result.isBlocked,
    blockReason: result.blockReason,
  };
}
