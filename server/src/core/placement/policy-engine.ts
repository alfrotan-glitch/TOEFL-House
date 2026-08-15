/**
 * Placement Policy Engine — resolves whether a candidate/program/level
 * requires placement, and which components apply. Purely configuration-driven:
 * required / optional / not_required, first-level exemption, level
 * applicability. No hard-coded thresholds or four-skill assumptions.
 */
import { db } from '../../db/connection.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { stmtProfile, stmtGlobalProfile, stmtProgramVersion, stmtVersionLevels, stmtPlacementRules, stmtTestById, type RequirementMode, type PolicyComponent } from './store.js';

export interface PlacementRequirement {
  mode: RequirementMode;
  profile: any | null;
  reason: string;
  firstLevelExemptApplied: boolean;
}

/** Resolve the placement requirement for a program version + branch + target level. */
export function resolvePlacementRequirement(
  programVersionId: string | null,
  branchId: string | null | undefined,
  targetLevelId?: string | null
): PlacementRequirement {
  if (!programVersionId) return { mode: 'not_required', profile: null, reason: 'no_program_selected', firstLevelExemptApplied: false };
  const version = stmtProgramVersion.get(programVersionId) as any;
  if (!version) return { mode: 'not_required', profile: null, reason: 'program_version_not_found', firstLevelExemptApplied: false };

  let profile = (branchId ? stmtProfile.get(programVersionId, branchId) : undefined) as any;
  if (!profile) profile = stmtGlobalProfile.get(programVersionId) as any;
  if (!profile) return { mode: 'not_required', profile: null, reason: 'no_policy', firstLevelExemptApplied: false };

  const mode = String(profile.requirement_mode || (profile.required ? 'required' : 'not_required')) as RequirementMode;
  if (mode === 'not_required') return { mode, profile, reason: 'policy_not_required', firstLevelExemptApplied: false };

  // First-level exemption: target is the program version's first level and the
  // policy opts into first-level exemption → placement not required.
  if (mode === 'required' && Number(profile.first_level_exempt) === 1 && targetLevelId) {
    const levels = stmtVersionLevels.all(programVersionId, programVersionId) as any[];
    const first = levels.filter((l) => Number(l.is_active) !== 0).sort((a, b) => Number(a.order) - Number(b.order))[0];
    if (first && String(first.id) === String(targetLevelId)) {
      return { mode: 'not_required', profile, reason: 'first_level_exempt', firstLevelExemptApplied: true };
    }
  }
  return { mode, profile, reason: mode === 'optional' ? 'policy_optional' : 'policy_required', firstLevelExemptApplied: false };
}

/** Is the given level the first (lowest-order) level of the program version? */
export function isFirstLevel(programVersionId: string, levelId: string | null | undefined): boolean {
  if (!levelId) return false;
  const levels = stmtVersionLevels.all(programVersionId, programVersionId) as any[];
  const first = levels.filter((l) => Number(l.is_active) !== 0).sort((a, b) => Number(a.order) - Number(b.order))[0];
  return !!first && String(first.id) === String(levelId);
}

/** Full policy view for a visitor (profile + rules + resolved requirement). */
export function resolvePolicyForVisitor(visitor: any, targetLevelId?: string | null) {
  const version = stmtProgramVersion.get(visitor.program_version_id) as any;
  let profile = (visitor.branch_id ? stmtProfile.get(visitor.program_version_id, visitor.branch_id) : undefined) as any;
  if (!profile) profile = stmtGlobalProfile.get(visitor.program_version_id) as any;
  const rules = stmtPlacementRules.all(visitor.program_version_id, visitor.branch_id) as any[];
  const requirement = resolvePlacementRequirement(visitor.program_version_id, visitor.branch_id, targetLevelId);
  return { version, profile, rules, requirement };
}

/**
 * Validate policy component configs (used by the academic placement-profile
 * PUT). Extends the legacy validator with the new policy fields.
 */
export function validatePolicyComponents(rawComponents: any[], versionBranchId: string): { components: PolicyComponent[]; method: string; sections: string[] } {
  if (!Array.isArray(rawComponents) || rawComponents.length === 0) throw new HttpError(400, 'At least one assessment component is required when placement is enabled.');
  const seen = new Set<string>();
  let totalWeight = 0;
  const normalized = rawComponents.map((raw: any, index: number) => {
    const c: PolicyComponent = {
      key: String(raw.key || '').trim(),
      type: String(raw.type || 'custom_score') as PolicyComponent['type'],
      label: String(raw.label || '').trim(),
      required: raw.required !== false,
      enabled: raw.enabled !== false,
      order: raw.order == null ? index : Number(raw.order),
      weight: Number(raw.weight),
      maxScore: Number(raw.maxScore),
      durationMinutes: raw.durationMinutes == null ? undefined : Number(raw.durationMinutes),
      timeLimitSeconds: raw.timeLimitSeconds == null ? (raw.durationMinutes == null ? undefined : Number(raw.durationMinutes) * 60) : Number(raw.timeLimitSeconds),
      minScore: raw.minScore == null ? undefined : Number(raw.minScore),
      scoringMethod: (['auto', 'manual', 'hybrid'].includes(raw.scoringMethod) ? raw.scoringMethod : raw.type === 'content_test' ? 'hybrid' : 'manual') as PolicyComponent['scoringMethod'],
      retryPolicy: (['none', 'once', 'unlimited'].includes(raw.retryPolicy) ? raw.retryPolicy : 'none') as PolicyComponent['retryPolicy'],
      passFail: (['none', 'pass', 'fail'].includes(raw.passFail) ? raw.passFail : 'none') as PolicyComponent['passFail'],
      skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
      instructions: raw.instructions ? String(raw.instructions) : undefined,
      testId: raw.testId == null ? undefined : String(raw.testId),
    };
    if (!c.key || !c.label || seen.has(c.key)) throw new HttpError(400, 'Assessment component keys must be unique and labels are required.');
    seen.add(c.key);
    if (!['skill_scores','written_test','interview','level_assessment','custom_score','content_test'].includes(c.type)) throw new HttpError(400, `Unsupported assessment component type: ${c.type}.`);
    if (c.type === 'content_test') {
      if (!c.testId) throw new HttpError(400, `Content component ${c.label} requires a testId from the placement test bank.`);
      const test = db.prepare('SELECT id, status, branch_id FROM placement_tests WHERE id = ?').get(c.testId) as { id: string; status: string; branch_id: string | null } | undefined;
      if (!test) throw new HttpError(400, `Content component ${c.label} references a test that does not exist.`);
      if (test.status !== 'active') throw new HttpError(400, `Content component ${c.label} references test "${c.testId}" which is not active.`);
      if (test.branch_id !== null && test.branch_id !== versionBranchId) throw new HttpError(400, `Content component ${c.label} references a test from another branch.`);
    }
    if (!Number.isFinite(c.weight) || c.weight < 0) throw new HttpError(400, `Invalid weight for ${c.label}.`);
    if (!Number.isFinite(c.maxScore) || c.maxScore <= 0) throw new HttpError(400, `Invalid maximum score for ${c.label}.`);
    if (c.timeLimitSeconds != null && (!Number.isFinite(c.timeLimitSeconds) || c.timeLimitSeconds < 0)) throw new HttpError(400, `Invalid time limit for ${c.label}.`);
    if (c.minScore != null && (!Number.isFinite(c.minScore) || c.minScore < 0 || c.minScore > c.maxScore)) throw new HttpError(400, `Invalid minimum score for ${c.label}.`);
    totalWeight += c.weight;
    return c;
  });
  if (Math.abs(totalWeight - 100) > 0.01) throw new HttpError(400, `Assessment component weights must total 100%. Current total: ${totalWeight}%.`);
  const types = new Set(normalized.map((c) => c.type));
  const method = types.size > 1 ? 'hybrid' : (normalized[0]?.type || 'skill_scores');
  const allowedDerived = new Set(['skill_scores','level_assessment','written_test','interview','hybrid','content_test']);
  if (!allowedDerived.has(method)) throw new HttpError(400, `Unsupported placement method derived from components: ${method}.`);
  const sections = Array.from(new Set(normalized.flatMap((c) => c.skills || [])));
  return { components: normalized, method, sections };
}

/** Validate conditional decision rules against the component set. */
export function validateDecisionRules(rulesJson: unknown, components: PolicyComponent[]): any[] {
  if (rulesJson == null) return [];
  let rules: any;
  if (Array.isArray(rulesJson)) rules = rulesJson;
  else { try { rules = JSON.parse(String(rulesJson)); } catch { throw new HttpError(400, 'decisionRules must be a JSON array.'); } }
  if (!Array.isArray(rules)) throw new HttpError(400, 'decisionRules must be an array.');
  const keys = new Set(components.map((c) => c.key));
  for (const rule of rules) {
    if (!rule.levelId || !Array.isArray(rule.when) || rule.when.length === 0) throw new HttpError(400, 'Each decision rule needs levelId and a non-empty when[] array.');
    for (const cond of rule.when) {
      if (!keys.has(cond.componentKey) || !['score', 'percentage'].includes(cond.field || 'score') || !['gte', 'lte', 'eq'].includes(cond.op)) {
        throw new HttpError(400, `Invalid decision condition: ${JSON.stringify(cond)}.`);
      }
      if (!Number.isFinite(Number(cond.value))) throw new HttpError(400, `Decision condition value must be numeric: ${JSON.stringify(cond)}.`);
    }
  }
  return rules;
}
