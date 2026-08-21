/** Canonical placement-policy validation and snapshot normalization. */
import { HttpError } from '../../middleware/errorHandler.js';
import { assertMoney } from '../../utils/money.js';
import {
  stmtAnyProfileForVersion,
  stmtGlobalProfile,
  stmtPlacementRules,
  stmtProfile,
  stmtProgramVersion,
  stmtVersionLevels,
  type PlacementComponentType,
  type PolicyComponent,
  type RequirementMode,
  type ScoringMethod,
} from './store.js';

const COMPONENT_TYPES = new Set<PlacementComponentType>([
  'skill_scores', 'written_test', 'interview', 'level_assessment', 'custom_score', 'content_test',
]);
const SKILLS = new Set(['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking']);
const SCORING_MODELS = new Set(['weighted_average', 'average']);
const CONDITION_FIELDS = new Set(['score', 'percentage']);
const CONDITION_OPERATORS = new Set(['gte', 'lte', 'eq']);

function finiteNumber(value: unknown, field: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (min != null && value < min) || (max != null && value > max)) {
    const range = min != null || max != null ? ` between ${min ?? '-∞'} and ${max ?? '∞'}` : '';
    throw new HttpError(400, `${field} must be a finite number${range}.`);
  }
  return value;
}

export function normalizeRequirementMode(value: unknown): RequirementMode {
  if (value !== 'required' && value !== 'optional' && value !== 'not_required') {
    throw new HttpError(400, 'requirementMode must be required, optional, or not_required.');
  }
  return value;
}

function scoringMethodFor(type: PlacementComponentType, value: unknown): ScoringMethod {
  const defaultMethod: ScoringMethod = type === 'content_test' ? 'hybrid' : 'manual';
  const method = value == null ? defaultMethod : String(value) as ScoringMethod;
  if (!['auto', 'manual', 'hybrid'].includes(method)) {
    throw new HttpError(400, 'scoringMethod must be auto, manual, or hybrid.');
  }
  if (type !== 'content_test' && method !== 'manual') {
    throw new HttpError(400, `${type} components use manual scoring.`);
  }
  return method;
}

export function validatePolicyComponents(input: unknown, requirementMode: RequirementMode = 'required'): PolicyComponent[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'components must be an array.');
  if (requirementMode !== 'not_required' && input.length === 0) {
    throw new HttpError(400, 'At least one placement component is required.');
  }
  if (requirementMode === 'not_required' && input.length > 0) {
    throw new HttpError(400, 'A not_required placement policy cannot define assessment components.');
  }

  const keys = new Set<string>();
  const components = input.map((raw: any, index): PolicyComponent => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Component ${index + 1} is invalid.`);
    if (typeof raw.key !== 'string' || typeof raw.label !== 'string') throw new HttpError(400, `Component ${index + 1} key and label must be text.`);
    const key = raw.key.trim();
    const label = raw.label.trim();
    const type = raw.type as PlacementComponentType;
    if (!key || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new HttpError(400, `Component ${index + 1} requires a valid key.`);
    if (keys.has(key)) throw new HttpError(400, `Duplicate component key: ${key}.`);
    keys.add(key);
    if (!label || label.length > 160) throw new HttpError(400, `Component ${key} requires a label no longer than 160 characters.`);
    if (!COMPONENT_TYPES.has(type)) throw new HttpError(400, `Unsupported component type for ${key}.`);

    if (raw.required !== undefined && typeof raw.required !== 'boolean') throw new HttpError(400, `${key}.required must be boolean.`);
    const maxScore = finiteNumber(raw.maxScore, `${key}.maxScore`, 0.000001);
    const weight = finiteNumber(raw.weight, `${key}.weight`, 0, 100);
    const order = raw.order == null ? index : finiteNumber(raw.order, `${key}.order`, 0);
    if (!Number.isSafeInteger(order)) throw new HttpError(400, `${key}.order must be a non-negative integer.`);
    const minScore = raw.minScore == null ? null : finiteNumber(raw.minScore, `${key}.minScore`, 0, maxScore);
    const durationMinutes = raw.durationMinutes == null ? undefined : finiteNumber(raw.durationMinutes, `${key}.durationMinutes`, 0.000001);
    const timeLimitSeconds = raw.timeLimitSeconds == null
      ? (durationMinutes == null ? null : Math.round(durationMinutes * 60))
      : finiteNumber(raw.timeLimitSeconds, `${key}.timeLimitSeconds`, 1);
    if (timeLimitSeconds != null && (!Number.isSafeInteger(timeLimitSeconds) || timeLimitSeconds < 1)) {
      throw new HttpError(400, `${key}.timeLimitSeconds must be a positive whole number of seconds.`);
    }
    const testId = raw.testId == null ? undefined : String(raw.testId).trim();
    if (type === 'content_test' && !testId) throw new HttpError(400, `Content-test component ${key} requires testId.`);
    if (type !== 'content_test' && testId) throw new HttpError(400, `Only content-test components may reference testId.`);

    if (raw.instructions !== undefined && raw.instructions !== null && typeof raw.instructions !== 'string') {
      throw new HttpError(400, `${key}.instructions must be text.`);
    }
    if (typeof raw.instructions === 'string' && raw.instructions.length > 2000) {
      throw new HttpError(400, `${key}.instructions must be no longer than 2000 characters.`);
    }

    let skills: PolicyComponent['skills'];
    if (raw.skills != null) {
      if (type !== 'skill_scores' || !Array.isArray(raw.skills) || raw.skills.length === 0) {
        throw new HttpError(400, `${key}.skills is only valid as a non-empty skill_scores list.`);
      }
      const values = raw.skills.map((skill: unknown) => String(skill));
      if (new Set(values).size !== values.length || values.some((skill: string) => !SKILLS.has(skill))) {
        throw new HttpError(400, `${key}.skills contains an invalid or duplicate skill.`);
      }
      skills = values as PolicyComponent['skills'];
    }

    return {
      key,
      type,
      label,
      required: raw.required !== false,
      order,
      weight,
      maxScore,
      minScore,
      scoringMethod: scoringMethodFor(type, raw.scoringMethod),
      durationMinutes,
      timeLimitSeconds,
      instructions: raw.instructions == null ? null : raw.instructions,
      skills,
      testId,
    };
  });

  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  if (components.length > 0 && Math.abs(totalWeight - 100) > 0.01) {
    throw new HttpError(400, `Component weights must total 100; received ${totalWeight}.`);
  }
  return components.sort((a, b) => a.order - b.order);
}

export function validateDecisionRules(input: unknown, components: PolicyComponent[], levelIds: Set<string>) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'decisionRules must be an array.');
  const componentKeys = new Set(components.map((component) => component.key));
  return input.map((raw: any, ruleIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Decision rule ${ruleIndex + 1} is invalid.`);
    const levelId = String(raw.levelId || '').trim();
    if (!levelIds.has(levelId)) throw new HttpError(400, `Decision rule ${ruleIndex + 1} references a level outside this program.`);
    if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().length > 160)) {
      throw new HttpError(400, `Decision rule ${ruleIndex + 1} label must be non-empty text no longer than 160 characters.`);
    }
    if (!Array.isArray(raw.when) || raw.when.length === 0) throw new HttpError(400, `Decision rule ${ruleIndex + 1} requires conditions.`);
    const when = raw.when.map((condition: any, conditionIndex: number) => {
      const componentKey = String(condition?.componentKey || '').trim();
      const field = String(condition?.field || 'percentage');
      const op = String(condition?.op || 'gte');
      if (!componentKeys.has(componentKey)) throw new HttpError(400, `Decision condition references unknown component ${componentKey}.`);
      if (!CONDITION_FIELDS.has(field) || !CONDITION_OPERATORS.has(op)) throw new HttpError(400, `Decision condition ${conditionIndex + 1} is invalid.`);
      const value = finiteNumber(condition?.value, `Decision condition ${conditionIndex + 1}.value`);
      if (field === 'percentage' && (value < 0 || value > 100)) throw new HttpError(400, 'Decision percentages must be between 0 and 100.');
      const component = components.find((candidate) => candidate.key === componentKey)!;
      if (field === 'score' && (value < 0 || value > component.maxScore)) throw new HttpError(400, `Decision score for ${componentKey} must be within its component range.`);
      return { componentKey, field, op, value };
    });
    return {
      levelId,
      // levelId is the authority. A client-supplied levelCode would duplicate
      // the level row and could drift; recommendation projections read the
      // snapshotted level identified above.
      label: raw.label == null ? undefined : raw.label.trim(),
      when,
    };
  });
}

export function validateScoringModel(value: unknown): 'weighted_average' | 'average' {
  const model = value == null ? 'weighted_average' : String(value);
  if (!SCORING_MODELS.has(model)) throw new HttpError(400, 'scoringModel must be weighted_average or average.');
  return model as 'weighted_average' | 'average';
}

export function validatePositiveInteger(value: unknown, field: string, nullable = true, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value == null && nullable) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new HttpError(400, `${field} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

export function validateMoney(value: unknown, field: string, nullable = true): number | null {
  if ((value == null || value === '') && nullable) return null;
  return assertMoney(value, field);
}

export type PlacementDecision = 'REQUIRED' | 'NOT_REQUIRED' | 'EXEMPT' | 'CONFIGURATION_ERROR' | 'INVALID_CONTEXT';

export interface PlacementRequirement {
  mode: RequirementMode;
  decision: PlacementDecision;
  profile: any | null;
  reason: string;
  firstLevelExemptApplied: boolean;
  policySource: 'branch' | 'program_branch' | 'global' | 'none';
}

export function isAuthoritativeDecision(requirement: PlacementRequirement): boolean {
  return requirement.decision !== 'CONFIGURATION_ERROR';
}

export function resolvePlacementRequirement(
  programVersionId: string | null,
  branchId: string | null | undefined,
  targetLevelId?: string | null,
): PlacementRequirement {
  if (!programVersionId) {
    return { mode: 'not_required', decision: 'INVALID_CONTEXT', profile: null, reason: 'no_program_selected', firstLevelExemptApplied: false, policySource: 'none' };
  }
  const version = stmtProgramVersion.get(programVersionId) as any;
  if (!version) {
    return { mode: 'not_required', decision: 'INVALID_CONTEXT', profile: null, reason: 'program_version_not_found', firstLevelExemptApplied: false, policySource: 'none' };
  }

  let policySource: PlacementRequirement['policySource'] = 'none';
  let profile = (branchId ? stmtProfile.get(programVersionId, branchId) : undefined) as any;
  if (profile) policySource = 'branch';
  if (!profile && version.program_branch_id && version.program_branch_id !== branchId) {
    profile = stmtProfile.get(programVersionId, version.program_branch_id) as any;
    if (profile) policySource = 'program_branch';
  }
  if (!profile) {
    profile = stmtGlobalProfile.get(programVersionId) as any;
    if (profile) policySource = 'global';
  }
  if (!profile) {
    return stmtAnyProfileForVersion.get(programVersionId)
      ? { mode: 'not_required', decision: 'CONFIGURATION_ERROR', profile: null, reason: 'policy_not_applicable_to_branch', firstLevelExemptApplied: false, policySource: 'none' }
      : { mode: 'not_required', decision: 'NOT_REQUIRED', profile: null, reason: 'no_policy_configured', firstLevelExemptApplied: false, policySource: 'none' };
  }

  const mode = normalizeRequirementMode(profile.requirement_mode);
  if (mode === 'not_required') {
    return { mode, decision: 'NOT_REQUIRED', profile, reason: 'policy_not_required', firstLevelExemptApplied: false, policySource };
  }
  if (mode === 'required' && Number(profile.first_level_exempt) === 1 && targetLevelId) {
    const first = (stmtVersionLevels.all(programVersionId, programVersionId) as any[])
      .sort((a, b) => Number(a.order) - Number(b.order))[0];
    if (first && String(first.id) === String(targetLevelId)) {
      return { mode: 'not_required', decision: 'EXEMPT', profile, reason: 'first_level_exempt', firstLevelExemptApplied: true, policySource };
    }
  }
  return {
    mode,
    decision: 'REQUIRED',
    profile,
    reason: mode === 'optional' ? 'policy_optional' : 'policy_required',
    firstLevelExemptApplied: false,
    policySource,
  };
}

export function resolvePolicyForVisitor(visitor: any, targetLevelId?: string | null) {
  const version = stmtProgramVersion.get(visitor.program_version_id) as any;
  const requirement = resolvePlacementRequirement(visitor.program_version_id, visitor.branch_id, targetLevelId);
  const profile = requirement.profile;
  const ruleBranch = profile?.branch_id ?? visitor.branch_id;
  const rules = version ? stmtPlacementRules.all(visitor.program_version_id, ruleBranch) as any[] : [];
  return { version, profile, rules, requirement };
}
