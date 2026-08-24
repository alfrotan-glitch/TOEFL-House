/** Canonical placement-policy validation and snapshot normalization. */
import { HttpError } from '../../middleware/errorHandler.js';
import { assertMoney } from '../../utils/money.js';
import {
  stmtAnyProfileForVersion,
  stmtGlobalProfile,
  stmtProfile,
  stmtProgramVersion,
  stmtVersionLevels,
  type PlacementDecisionRule,
  type PolicyComponent,
  type RequirementMode,
} from './store.js';
import {
  CEFR_LEVELS,
  type PlacementComponentType,
  type PlacementDeliveryMode,
  CANONICAL_COMPONENT_KEYS,
  CANONICAL_COMPONENT_WEIGHTS,
  componentSpec,
  isCefrLevel,
  isDeliveryMode,
} from './v1.js';
import { assertBlueprintComponentShape } from './blueprint-engine.js';

const SCORING_MODELS = new Set(['canonical']);
const DELIVERY_MODE_SET = new Set<PlacementDeliveryMode>(['DIGITAL', 'PHYSICAL']);

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

function scoringMethodFor(type: PlacementComponentType): 'auto' | 'manual' {
  return type === 'grammar' || type === 'reading' || type === 'listening' ? 'auto' : 'manual';
}

function normalizeDeliveryModes(input: unknown): PlacementDeliveryMode[] {
  if (input == null) return ['DIGITAL', 'PHYSICAL'];
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, 'deliveryModes must be a non-empty array.');
  const modes = input.map((mode) => String(mode)) as PlacementDeliveryMode[];
  if (modes.some((mode) => !isDeliveryMode(mode))) {
    throw new HttpError(400, 'deliveryModes must contain only DIGITAL and PHYSICAL.');
  }
  const unique = [...new Set(modes)];
  if (unique.length !== 2 || !unique.every((mode) => DELIVERY_MODE_SET.has(mode))) {
    throw new HttpError(400, 'Placement V1 must enable exactly DIGITAL and PHYSICAL delivery modes.');
  }
  return unique;
}

export function validatePolicyComponents(input: unknown, requirementMode: RequirementMode = 'required'): PolicyComponent[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'components must be an array.');
  if (requirementMode !== 'not_required' && input.length !== CANONICAL_COMPONENT_KEYS.length) {
    throw new HttpError(400, 'Placement Test V1 requires exactly five canonical components.');
  }
  if (requirementMode === 'not_required' && input.length > 0) {
    throw new HttpError(400, 'A not_required placement policy cannot define assessment components.');
  }
  if (requirementMode === 'not_required') return [];

  const components = input.map((raw: any, index): PolicyComponent => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Component ${index + 1} is invalid.`);
    const type = String(raw.type || raw.key || '').trim() as PlacementComponentType;
    if (!(CANONICAL_COMPONENT_KEYS as readonly string[]).includes(type)) {
      throw new HttpError(400, `Placement component ${index + 1} must be one of ${CANONICAL_COMPONENT_KEYS.join(', ')}.`);
    }
    const spec = componentSpec(type);
    const key = String(raw.key || type).trim();
    if (key !== type) throw new HttpError(400, `${type} key must equal its canonical component code.`);
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : spec.label;
    const durationMinutes = raw.durationMinutes == null ? spec.defaultDurationMinutes : finiteNumber(raw.durationMinutes, `${key}.durationMinutes`, 0.000001);
    const timeLimitSeconds = raw.timeLimitSeconds == null ? Math.round(durationMinutes * 60) : finiteNumber(raw.timeLimitSeconds, `${key}.timeLimitSeconds`, 1);
    if (!Number.isSafeInteger(timeLimitSeconds)) throw new HttpError(400, `${key}.timeLimitSeconds must be a positive whole number of seconds.`);
    const bankIds = Array.isArray(raw.bankIds) ? raw.bankIds.map((bankId: unknown) => String(bankId).trim()).filter(Boolean) : [];
    const blueprintBuckets = Array.isArray(raw.blueprintBuckets) ? raw.blueprintBuckets : [];
    const component: PolicyComponent = {
      key,
      type,
      label,
      required: raw.required !== false,
      order: index,
      weight: CANONICAL_COMPONENT_WEIGHTS[type],
      maxScore: spec.maxScore,
      minScore: null,
      scoringMethod: scoringMethodFor(type),
      durationMinutes,
      timeLimitSeconds,
      instructions: raw.instructions == null ? null : String(raw.instructions),
      bankIds,
      blueprintBuckets,
    };
    assertBlueprintComponentShape(component);
    return component;
  });

  for (const key of CANONICAL_COMPONENT_KEYS) {
    const matched = components.filter((component) => component.key === key);
    if (matched.length !== 1) throw new HttpError(400, `Placement V1 requires exactly one ${key} component.`);
    if (matched[0].required !== true) throw new HttpError(400, `${key} must be required in Placement Test V1.`);
    const spec = componentSpec(key);
    if (matched[0].maxScore !== spec.maxScore) throw new HttpError(400, `${key} maxScore must be ${spec.maxScore}.`);
  }

  return components;
}

export function validateDecisionRules(input: unknown, components: PolicyComponent[], levelIds: Set<string>): PlacementDecisionRule[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, 'decisionRules must define the explicit CEFR placement rule set for A1 through C1.');
  }
  const componentKeys = new Set(components.map((component) => component.key));
  const seenLevels = new Set<string>();
  const normalized = input.map((raw: any, ruleIndex): PlacementDecisionRule => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Decision rule ${ruleIndex + 1} is invalid.`);
    const cefrLevel = String(raw.cefrLevel || '').trim();
    if (!isCefrLevel(cefrLevel)) throw new HttpError(400, `Decision rule ${ruleIndex + 1} must declare CEFR level A1/A2/B1/B2/C1.`);
    if (seenLevels.has(cefrLevel)) throw new HttpError(400, `Decision rule ${cefrLevel} is duplicated.`);
    seenLevels.add(cefrLevel);
    const recommendedLevelId = String(raw.recommendedLevelId || '').trim();
    if (!levelIds.has(recommendedLevelId)) {
      throw new HttpError(400, `Decision rule ${cefrLevel} references a recommended level outside this program.`);
    }
    const minimumScores = raw.minimumScores;
    if (!minimumScores || typeof minimumScores !== 'object' || Array.isArray(minimumScores)) {
      throw new HttpError(400, `Decision rule ${cefrLevel} requires minimumScores for all five components.`);
    }
    const normalizedScores = {} as Record<PlacementComponentType, number>;
    for (const component of components) {
      const key = component.key as PlacementComponentType;
      if (!componentKeys.has(key)) throw new HttpError(400, `Unknown component ${key}.`);
      normalizedScores[key] = finiteNumber((minimumScores as Record<string, unknown>)[key], `${cefrLevel}.${key}`, 0, component.maxScore);
    }
    if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.trim().length > 160)) {
      throw new HttpError(400, `Decision rule ${cefrLevel} label must be non-empty text no longer than 160 characters.`);
    }
    return {
      cefrLevel,
      recommendedLevelId,
      minimumScores: normalizedScores,
      label: raw.label == null ? undefined : raw.label.trim(),
    };
  });

  for (const cefrLevel of CEFR_LEVELS) {
    if (!seenLevels.has(cefrLevel)) throw new HttpError(400, `The CEFR rule set must include ${cefrLevel}.`);
  }

  const ordered = [...normalized].sort((left, right) => CEFR_LEVELS.indexOf(left.cefrLevel) - CEFR_LEVELS.indexOf(right.cefrLevel));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    for (const component of components) {
      const key = component.key as PlacementComponentType;
      if (current.minimumScores[key] < previous.minimumScores[key]) {
        throw new HttpError(400, `Decision rule ${current.cefrLevel} cannot lower the ${key} threshold below ${previous.cefrLevel}.`);
      }
    }
  }
  return ordered;
}

export function validateScoringModel(value: unknown): 'canonical' {
  const model = value == null ? 'canonical' : String(value);
  if (!SCORING_MODELS.has(model)) throw new HttpError(400, 'scoringModel must be canonical.');
  return 'canonical';
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
  return { version, profile, rules: [], requirement };
}

export { normalizeDeliveryModes };
