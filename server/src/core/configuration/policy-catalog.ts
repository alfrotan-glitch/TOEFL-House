import type { RuleAction, RuleCondition, RuleCategory } from './rule-engine.js';

export const SYSTEM_DEFAULTS = {
  invoiceDueDays: 30,
  dailySavingPercent: 5,
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

/**
 * Owner-approved treasury policy governing profit distributions and warnings.
 * `profitDistributionTiers` is read highest-first; a margin below every band,
 * including a loss, permits no distribution.
 */
export const TREASURY_DEFAULTS = {
  profitDistributionTiers: [
    { minMarginPercent: 30, sharePercent: 15 },
    { minMarginPercent: 20, sharePercent: 10 },
    { minMarginPercent: 10, sharePercent: 5 },
  ],
  /** Minimum post-withdrawal liquidity, as months of fixed costs. */
  reserveFundMonths: 6,
  /** Main cash below this many months of fixed costs raises a warning. */
  cashReserveWarningMonths: 3,
  /** Teacher performance below this percentage raises an advisory warning. */
  teacherPerformanceWarningPercent: 80,
} as const;

export const PLACEMENT_DEFAULTS = {
  enabled: false,
  required: false,
  method: 'canonical_v1',
  deliveryModes: ['DIGITAL', 'PHYSICAL'],
  sections: ['grammar', 'reading', 'listening', 'writing', 'speaking'],
  components: [
    {
      key: 'grammar',
      type: 'grammar',
      label: 'Grammar',
      required: true,
      weight: 25,
      maxScore: 30,
      durationMinutes: 30,
      bankIds: [],
      blueprintBuckets: [{ count: 30, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }],
      instructions: 'Digital: answer in the system. Physical: enter the authoritative objective score.',
    },
    {
      key: 'reading',
      type: 'reading',
      label: 'Reading',
      required: true,
      weight: 16.67,
      maxScore: 20,
      durationMinutes: 25,
      bankIds: [],
      blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }],
      instructions: 'Digital: answer in the system. Physical: enter the authoritative objective score.',
    },
    {
      key: 'listening',
      type: 'listening',
      label: 'Listening',
      required: true,
      weight: 16.67,
      maxScore: 20,
      durationMinutes: 25,
      bankIds: [],
      blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }],
      instructions: 'Digital: answer in the system. Physical: enter the authoritative objective score.',
    },
    {
      key: 'writing',
      type: 'writing',
      label: 'Writing',
      required: true,
      weight: 20.83,
      maxScore: 25,
      durationMinutes: 30,
      bankIds: [],
      blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['essay'] }],
      instructions: 'Digital: the student types the response in the system. Physical: the examiner enters the same rubric scores.',
    },
    {
      key: 'speaking',
      type: 'speaking',
      label: 'Speaking',
      required: true,
      weight: 20.83,
      maxScore: 25,
      durationMinutes: 15,
      bankIds: [],
      blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['speaking'] }],
      instructions: 'Structured face-to-face speaking evaluation. Recording is not required; the examiner records rubric scores in the system.',
    },
  ],
  scoringModel: 'canonical',
  allowRetake: true,
  maxScore: 120,
  passScore: 0,
  decisionRules: [],
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
  { id: 'rule_default_per_skill_salary', name: 'Per-Skill Salary Calculation', description: 'Use the sum of skill rates for per-skill teachers.', category: 'payroll', conditions: [{ field: 'salaryType', operator: 'eq', value: 'per_skill' }], actions: [{ type: 'calculate', targetKey: 'monthlySalary', formula: 'totalSkillRates' }], priority: 500 },
];
