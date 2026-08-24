/**
 * Placement Scoring Engine — server-authoritative scoring.
 *
 * Objective question types are auto-graded. Writing and speaking are
 * human-scored through rubric criteria. No client-supplied aggregate score is
 * trusted.
 */
import { HttpError } from '../../middleware/errorHandler.js';
import { componentScore as manualEntryScore, normalizeScore, type PolicyComponent } from './store.js';

export interface AutoScoreResult {
  score: number;
  feedback: string;
}

const OBJECTIVE_TYPES = new Set(['mcq', 'short_answer', 'fill_blank', 'sentence_completion', 'error_identification']);

/** Deterministic auto-scoring for a single question. */
export function autoScoreQuestion(q: any, response: unknown): AutoScoreResult {
  if (OBJECTIVE_TYPES.has(String(q.qtype))) {
    const expected = String(q.answer_key || '').trim().toLowerCase();
    const given = String(response ?? '').trim().toLowerCase();
    const score = expected && given === expected ? Number(q.points || 0) : 0;
    return { score, feedback: score > 0 ? 'Correct' : 'Incorrect' };
  }
  return { score: 0, feedback: '' };
}

/** Normalize a component's auto score to the policy component max score. */
export function normalizeAutoScore(earned: number, rawMax: number, componentMaxScore: number): number {
  const base = rawMax || componentMaxScore;
  return Math.round((earned / base) * componentMaxScore * 100) / 100;
}

export interface ScoreProvenance {
  rawScore: number;
  percentage: number;
  weightedScore: number;
}

/** Compute scoring provenance for a result row. */
export function scoreProvenance(score: number, maxScore: number, weight: number): ScoreProvenance {
  const max = maxScore || 100;
  const percentage = Math.round((score / max) * 10000) / 100;
  const weightedScore = Math.round(((score / max) * weight) * 100) / 100;
  return { rawScore: Math.round(score * 100) / 100, percentage, weightedScore };
}

function manualScoreFromRubric(component: PolicyComponent, rubric: any, criteriaScores: Record<string, number>) {
  const rubricCriteria = rubric?.criteria as Array<{ key: string; weight: number; maxScore: number }> | undefined;
  if (!Array.isArray(rubricCriteria) || rubricCriteria.length === 0) {
    throw new HttpError(409, `The ${component.label} rubric has no criteria.`);
  }
  const expectedKeys = new Set(rubricCriteria.map((criterion) => criterion.key));
  const suppliedKeys = Object.keys(criteriaScores || {});
  if (suppliedKeys.some((key) => !expectedKeys.has(key))) throw new HttpError(400, 'criteriaScores contains an unknown rubric criterion.');
  let weightedSum = 0;
  const normalized: Record<string, number> = {};
  for (const criterion of rubricCriteria) {
    const given = criteriaScores[criterion.key];
    if (typeof given !== 'number' || !Number.isFinite(given)) {
      throw new HttpError(400, `Missing numeric score for rubric criterion "${criterion.key}".`);
    }
    if (given < 0 || given > Number(criterion.maxScore)) {
      throw new HttpError(400, `Criterion "${criterion.key}" score must be between 0 and ${criterion.maxScore}.`);
    }
    normalized[criterion.key] = given;
    weightedSum += (given / Number(criterion.maxScore || 1)) * Number(criterion.weight || 0);
  }
  const score = Math.round((weightedSum / 100) * component.maxScore * 100) / 100;
  return { score, normalized };
}

/**
 * Score a manual/hybrid component body (staff entry).
 *
 * Objective sections accept direct manual entry for PHYSICAL delivery mode.
 * Writing and speaking require rubric criteria when a rubric is linked.
 */
export function scoreComponentBody(component: PolicyComponent, body: any, snapshotTests: any[], _attemptId: string) {
  if (component.type === 'writing' || component.type === 'speaking') {
    const test = (snapshotTests || []).find((candidate: any) => candidate.id === component.testId);
    if (!test) throw new HttpError(409, `${component.label} content is missing from the attempt snapshot.`);
    if (body?.criteriaScores && typeof body.criteriaScores === 'object') {
      const { score, normalized } = manualScoreFromRubric(component, test.rubric, body.criteriaScores as Record<string, number>);
      return {
        score,
        payload: { mode: 'rubric', criteriaScores: normalized, feedback: body?.resultText || null },
        rawScore: score,
        rawMax: component.maxScore,
      };
    }
    const score = normalizeScore(body?.score ?? body?.manualScore, component.maxScore);
    return {
      score,
      payload: { mode: 'manual', feedback: body?.resultText || null },
      rawScore: score,
      rawMax: component.maxScore,
    };
  }

  if (component.type === 'grammar' || component.type === 'reading' || component.type === 'listening') {
    const score = normalizeScore(body?.score ?? body?.manualScore, component.maxScore);
    return {
      score,
      payload: { mode: 'objective_manual_entry', deliveryMode: body?.deliveryMode ?? null, feedback: body?.resultText || null },
      rawScore: score,
      rawMax: component.maxScore,
    };
  }

  const result = manualEntryScore(component, body);
  return { score: result.score, payload: result.payload, rawScore: result.score, rawMax: component.maxScore };
}
