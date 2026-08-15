import type { RuleAction, RuleCondition, RuleCategory } from './rule-engine.js';

export const SYSTEM_DEFAULTS = {
  invoiceDueDays: 30,
  dailySavingPercent: 5,
  registrationFee: 0,
  placementTestFee: 300,
  diplomaFee: 500,
  cardIssuanceFee: 200,
  expenseAutoApproveThreshold: 5000,
} as const;

export const ACADEMIC_DEFAULTS = {
  levelDurationMonths: 1,
  levelDefaultFee: 0,
  levelPassMark: 70,
  levelMinViableSize: 5,
  defaultMinAttendance: 75,
  halfAbsenceThresholdMinutes: 30,
  lateThresholdMinutes: 15,
  maxConsecutiveAbsences: 3,
  certificateMinPercentage: 60,
  freezeMaxDurationDays: 90,
  freezeMaxPerEnrollment: 2,
  makeupWindowDays: 14,
  maxAutomaticRetakes: 2,
  maxConditionalPasses: 1,
  transferMinDaysBeforeAutoApprove: 0,
  letterGradeBands: [
    { min: 90, grade: 'A' },
    { min: 80, grade: 'B' },
    { min: 70, grade: 'C' },
    { min: 60, grade: 'D' },
    { min: 0, grade: 'F' },
  ],
} as const;

export const PLACEMENT_DEFAULTS = {
  enabled: false,
  required: false,
  method: 'skill_scores',
  sections: ['grammar','vocabulary','reading','listening','writing','speaking'],
  components: [{ key:'skill_scores', type:'skill_scores', label:'Skills Assessment', required:true, weight:100, maxScore:100, durationMinutes:30, skills:['grammar','vocabulary','reading','listening','writing','speaking'], instructions:'Score each skill using the examiner rubric.' }],
  scoringModel: 'weighted_average',
  allowRetake: true,
  maxScore: 100,
  passScore: 60,
} as const;

export interface DefaultRuleCatalogItem {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  conditions: RuleCondition[];
  actions: RuleAction[];
  priority: number;
}

export const DEFAULT_RULE_CATALOG: DefaultRuleCatalogItem[] = [
  { id: 'rule_default_friend_discount', name: 'Friend Referral Discount', description: 'Apply the configured referral discount when a lead is referred by a friend.', category: 'discount', conditions: [{ field: 'leadSource', operator: 'eq', value: 'friend' }], actions: [{ type: 'add_discount', targetKey: 'discountPercent', value: 10 }], priority: 80 },
  { id: 'rule_default_discount_cap', name: 'Discount Cap 30%', description: 'Never allow cumulative discount above 30%.', category: 'discount', conditions: [{ field: 'discountPercent', operator: 'gt', value: 30 }], actions: [{ type: 'set_value', targetKey: 'discountPercent', value: 30 }, { type: 'warn', targetKey: '__warning', message: 'Discount capped at 30%.' }], priority: 200 },
  { id: 'rule_default_promotion_pass', name: 'Promotion Pass', description: 'Promotion threshold rule.', category: 'promotion', conditions: [{ field: 'examScore', operator: 'gte', value: 90 }], actions: [{ type: 'set_value', targetKey: 'promotionStatus', value: 'pass' }], priority: 100 },
  { id: 'rule_default_auto_savings', name: 'Auto Savings', description: 'Transfer the configured savings percentage from qualifying income.', category: 'finance', conditions: [{ field: 'transactionType', operator: 'eq', value: 'income' }], actions: [{ type: 'calculate', targetKey: 'savingAmount', formula: `amount * ${SYSTEM_DEFAULTS.dailySavingPercent / 100}` }], priority: 100 },
  { id: 'rule_default_per_skill_salary', name: 'Per-Skill Salary Calculation', description: 'Use the sum of skill rates for per-skill teachers.', category: 'payroll', conditions: [{ field: 'salaryType', operator: 'eq', value: 'per_skill' }], actions: [{ type: 'calculate', targetKey: 'monthlySalary', formula: 'totalSkillRates' }], priority: 500 },
  { id: 'rule_default_reserve_guard', name: 'Profit Withdrawal Reserve Guard', description: 'Block profit withdrawal until the reserve requirement is met.', category: 'finance', conditions: [{ field: 'reserveFundMet', operator: 'eq', value: false }], actions: [{ type: 'block', targetKey: '__blocked', message: 'Profit withdrawal blocked: reserve fund requirement has not been met.' }], priority: 600 },
];
