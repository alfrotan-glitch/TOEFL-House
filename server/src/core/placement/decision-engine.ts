/**
 * Placement decision engine.
 *
 * Placement Test V1 is governed by one explicit CEFR ladder. Each rule row
 * defines the minimum score required in every canonical component for a target
 * CEFR level. Component CEFR evidence is derived from the same ladder, and the
 * overall placement is the highest level whose full five-component threshold is
 * satisfied.
 */
import { HttpError } from '../../middleware/errorHandler.js';
import type { PlacementDecisionRule, PolicyComponent } from './store.js';
import { CEFR_LEVELS, placementPercentageFromResults, type PlacementComponentType } from './v1.js';

export interface ComponentEvidence {
  componentKey: PlacementComponentType;
  score: number | null;
  cefrLevel: string | null;
  matchedRuleId: string | null;
  unmetAgainstTarget: string[];
}

export interface DecisionEvaluation {
  percentage: number | null;
  recommendedLevelId: string | null;
  decisionRuleId: string | null;
  recommendationText: string;
  belowPass: boolean;
  unmetRequirements: string[];
  overallCefr: string | null;
  componentEvidence: ComponentEvidence[];
}

function sortedRules(input: PlacementDecisionRule[]): PlacementDecisionRule[] {
  return [...input].sort((left, right) => CEFR_LEVELS.indexOf(left.cefrLevel) - CEFR_LEVELS.indexOf(right.cefrLevel));
}

function scoreForComponent(results: any[], key: string): number | null {
  const row = results.find((result) => result.component_key === key && (result.status === 'completed' || result.status === 'waived'));
  if (!row || row.status === 'waived' || row.score == null) return null;
  return Number(row.score);
}

function explainThresholdFailures(rule: PlacementDecisionRule, components: PolicyComponent[], results: any[]): string[] {
  const failures: string[] = [];
  for (const component of components) {
    const key = component.key as PlacementComponentType;
    const actual = scoreForComponent(results, key);
    const required = Number(rule.minimumScores[key]);
    if (actual == null || actual < required) {
      failures.push(`${component.label} ${actual ?? 0}/${component.maxScore} is below the ${rule.cefrLevel} threshold ${required}/${component.maxScore}`);
    }
  }
  return failures;
}

function componentEvidenceForRuleLadder(component: PolicyComponent, rules: PlacementDecisionRule[], results: any[]): ComponentEvidence {
  const key = component.key as PlacementComponentType;
  const score = scoreForComponent(results, key);
  if (score == null) {
    return {
      componentKey: key,
      score: null,
      cefrLevel: null,
      matchedRuleId: null,
      unmetAgainstTarget: [],
    };
  }
  let cefrLevel: string | null = null;
  let matchedRuleId: string | null = null;
  for (const rule of rules) {
    if (score >= Number(rule.minimumScores[key])) {
      cefrLevel = rule.cefrLevel;
      matchedRuleId = rule.cefrLevel;
    }
  }
  return {
    componentKey: key,
    score,
    cefrLevel,
    matchedRuleId,
    unmetAgainstTarget: [],
  };
}

export function evaluateDecision(opts: {
  components: PolicyComponent[];
  results: any[];
  rules: any[];
  decisionRulesJson: string | null | undefined;
  levels: any[];
  scoringModel: string;
  passScore: number;
}): DecisionEvaluation {
  const { components, results, levels } = opts;
  const completed = results.filter((result) => result.status === 'completed' || result.status === 'waived');
  const doneKeys = new Set(completed.map((result) => result.component_key));
  const unmetRequirements = components
    .filter((component) => component.required && !doneKeys.has(component.key))
    .map((component) => component.key);

  let decisionRules: PlacementDecisionRule[];
  try {
    decisionRules = opts.decisionRulesJson ? JSON.parse(opts.decisionRulesJson) : [];
  } catch {
    throw new HttpError(409, 'The CEFR placement rule set is invalid.');
  }
  if (!Array.isArray(decisionRules) || decisionRules.length === 0) {
    throw new HttpError(409, 'No CEFR placement rule set is configured for this placement profile.');
  }
  const orderedRules = sortedRules(decisionRules);

  const componentEvidence = components.map((component) => componentEvidenceForRuleLadder(component, orderedRules, results));
  const percentage = placementPercentageFromResults(results.filter((result) => result.status === 'completed' && result.score != null));

  let matchedRule: PlacementDecisionRule | null = null;
  for (const rule of orderedRules) {
    const failures = explainThresholdFailures(rule, components, results);
    if (failures.length === 0) matchedRule = rule;
  }

  if (!matchedRule) {
    return {
      percentage,
      recommendedLevelId: null,
      decisionRuleId: null,
      recommendationText: 'No CEFR placement rule matched the completed assessment.',
      belowPass: true,
      unmetRequirements,
      overallCefr: null,
      componentEvidence: componentEvidence.map((evidence) => ({
        ...evidence,
        unmetAgainstTarget: orderedRules.length > 0 ? explainThresholdFailures(orderedRules[0], components.filter((component) => component.key === evidence.componentKey), results) : [],
      })),
    };
  }

  if (!(levels || []).some((level: any) => level.id === matchedRule.recommendedLevelId)) {
    throw new HttpError(409, `The ${matchedRule.cefrLevel} placement rule references a level outside the attempt snapshot.`);
  }
  const level = (levels || []).find((candidate: any) => candidate.id === matchedRule.recommendedLevelId);
  return {
    percentage,
    recommendedLevelId: matchedRule.recommendedLevelId,
    decisionRuleId: matchedRule.cefrLevel,
    recommendationText: `${matchedRule.cefrLevel}${level ? ` — ${level.name}` : ''}`,
    belowPass: false,
    unmetRequirements,
    overallCefr: matchedRule.cefrLevel,
    componentEvidence,
  };
}

export type PlacementOutcome = 'passed' | 'failed';

export interface OutcomeEvaluation {
  outcome: PlacementOutcome;
  reasons: string[];
}

export function evaluateOutcome(decision: DecisionEvaluation): OutcomeEvaluation {
  const reasons: string[] = [];
  for (const unmet of decision.unmetRequirements) {
    reasons.push(`Required assessment section not satisfied: ${unmet}.`);
  }
  if (!decision.overallCefr) {
    reasons.push('No CEFR placement rule matched the completed assessment.');
  }
  return { outcome: reasons.length === 0 ? 'passed' : 'failed', reasons };
}

export function assertNoConflictingLevels(_results: any[]): string | null {
  return null;
}
