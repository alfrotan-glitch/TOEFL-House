/**
 * Placement Decision Engine — maps component scores to a recommended level
 * using configurable rules (conditional skill thresholds first, score-band
 * fallback) plus required-component and minimum-score checks. No thresholds
 * are hard-coded here; everything comes from placement_rules + policy
 * decision_rules_json.
 */
import { HttpError } from '../../middleware/errorHandler.js';
import type { PolicyComponent } from './store.js';

export interface DecisionCondition {
  componentKey: string;
  field: 'score' | 'percentage';
  op: 'gte' | 'lte' | 'eq';
  value: number;
}

export interface DecisionRule {
  levelId: string;
  levelCode?: string | null;
  label?: string;
  when: DecisionCondition[];
}

export interface DecisionEvaluation {
  percentage: number | null;
  recommendedLevelId: string | null;
  decisionRuleId: string | null;
  recommendationText: string;
  belowPass: boolean;
  unmetRequirements: string[];
}

function satisfiesCondition(cond: DecisionCondition, results: any[]): boolean {
  const row = results.find((r) => r.component_key === cond.componentKey && (r.status === 'completed' || r.status === 'waived'));
  if (!row) return false;
  const actual = cond.field === 'percentage' ? Number(row.percentage ?? (Number(row.score) / Number(row.max_score || 100)) * 100) : Number(row.score);
  if (!Number.isFinite(actual)) return false;
  switch (cond.op) {
    case 'gte': return actual >= cond.value;
    case 'lte': return actual <= cond.value;
    case 'eq': return Math.abs(actual - cond.value) < 1e-6;
    default: return false;
  }
}

function matchesConditionalRule(rule: DecisionRule, results: any[]): boolean {
  return rule.when.every((cond) => satisfiesCondition(cond, results));
}

export function evaluateDecision(opts: {
  components: PolicyComponent[];
  results: any[];
  rules: any[];              // placement_rules rows (band + conditions_json)
  decisionRulesJson: string | null | undefined; // policy decision_rules_json
  levels: any[];
  scoringModel: string;
  passScore: number;
}): DecisionEvaluation {
  const { components, results, rules, levels, scoringModel, passScore } = opts;
  const completed = results.filter((r) => r.status === 'completed' || r.status === 'waived');
  const doneKeys = new Set(completed.map((r) => r.component_key));
  const unmetRequirements = components
    .filter((c) => c.required && !doneKeys.has(c.key))
    .map((c) => c.key);

  // Minimum-score enforcement: a completed component below its policy minScore
  // blocks the placement decision (required components) or is flagged.
  const minScoreFailures = components.filter((c) => c.required && c.minScore != null && c.minScore > 0).filter((c) => {
    const row = completed.find((r) => r.component_key === c.key);
    if (!row || row.score == null) return true;
    return Number(row.score) < Number(c.minScore);
  });
  for (const c of minScoreFailures) {
    if (!unmetRequirements.includes(c.key)) unmetRequirements.push(`${c.key} (below minimum score ${c.minScore})`);
  }

  const scored = results.filter((r) => r.status === 'completed' && Number(r.weight) > 0 && r.score != null);
  const explicitLevels = [...new Set(results.filter((r) => (r.status === 'completed' || r.status === 'waived') && r.selected_level_id).map((r) => String(r.selected_level_id)))];
  const explicitLevel = explicitLevels.length === 1 ? explicitLevels[0] : null;
  const weightTotal = scored.reduce((sum, r) => sum + Number(r.weight), 0);
  const normalizedScores = scored.map((r) => (Number(r.score) / Number(r.max_score || 100)) * 100);
  const percentage = scored.length > 0 && weightTotal > 0
    ? Math.round((scoringModel === 'average'
      ? normalizedScores.reduce((sum, value) => sum + value, 0) / normalizedScores.length
      : (scored.reduce((sum, r) => sum + ((Number(r.score) / Number(r.max_score || 100)) * Number(r.weight)), 0) / weightTotal) * 100) * 100) / 100
    : null;

  // 1) Policy decision rules (conditional skill thresholds).
  let policyRules: DecisionRule[] = [];
  try { policyRules = opts.decisionRulesJson ? JSON.parse(opts.decisionRulesJson) : []; } catch { policyRules = []; }
  if (Array.isArray(policyRules) && policyRules.length > 0 && percentage != null) {
    for (const rule of policyRules) {
      if (matchesConditionalRule(rule, results)) {
        const level = (levels || []).find((l: any) => l.id === rule.levelId);
        const belowPass = percentage < Number(passScore);
        return {
          percentage,
          recommendedLevelId: rule.levelId,
          decisionRuleId: `policy:${rule.label || rule.levelId}`,
          recommendationText: level
            ? `${level.name}${belowPass ? ' — below the configured pass threshold' : ''}`
            : `Policy rule matched${belowPass ? ' — below the configured pass threshold' : ''}`,
          belowPass,
          unmetRequirements,
        };
      }
    }
  }

  // 2) Score-band rules (legacy placement_rules, optionally with conditions_json).
  const sorted = [...(rules || [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const rule of sorted) {
    const bandOk = percentage != null && percentage >= Number(rule.min_score) && percentage <= Number(rule.max_score);
    if (!bandOk) continue;
    let condOk = true;
    if (rule.conditions_json) {
      try {
        const conds = JSON.parse(rule.conditions_json) as DecisionCondition[];
        condOk = conds.every((cond) => satisfiesCondition(cond, results));
      } catch { condOk = true; }
    }
    if (condOk) {
      const belowPass = percentage < Number(passScore);
      return {
        percentage,
        recommendedLevelId: rule.recommended_level_id || null,
        decisionRuleId: rule.id,
        recommendationText: rule.recommended_level_code
          ? `${rule.recommended_level_code}${belowPass ? ' — below the configured pass threshold' : ''}`
          : `Rule: ${rule.name}${belowPass ? ' — below the configured pass threshold' : ''}`,
        belowPass,
        unmetRequirements,
      };
    }
  }

  // 3) Explicit level from a level_assessment component.
  if (explicitLevel) {
    const level = (levels || []).find((l: any) => l.id === explicitLevel);
    return {
      percentage,
      recommendedLevelId: explicitLevel,
      decisionRuleId: null,
      recommendationText: level ? `${level.name} — explicit level assessment` : 'Level recommendation recorded',
      belowPass: percentage != null && percentage < Number(passScore),
      unmetRequirements,
    };
  }

  // 4) No rule matched.
  return {
    percentage,
    recommendedLevelId: null,
    decisionRuleId: null,
    recommendationText: percentage != null ? `Overall assessment ${percentage}%` : 'No placement rule matched the assessment result',
    belowPass: percentage != null && percentage < Number(passScore),
    unmetRequirements,
  };
}

export function assertNoConflictingLevels(results: any[]): string | null {
  const explicitLevels = [...new Set(results.filter((r) => (r.status === 'completed' || r.status === 'waived') && r.selected_level_id).map((r) => String(r.selected_level_id)))];
  if (explicitLevels.length > 1) throw new HttpError(400, 'Assessment sections contain conflicting level recommendations.');
  return explicitLevels[0] || null;
}
