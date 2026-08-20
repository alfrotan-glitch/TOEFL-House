/**
 * Placement Scoring Engine — server-authoritative scoring.
 * Auto-grades deterministic question types (MCQ exact key, short-answer
 * trimmed + case-insensitive), normalizes component scores, and computes
 * scoring provenance (raw score, percentage, weighted score). Manual /
 * hybrid components are scored by staff through the attempt routes; no
 * client-supplied score is ever trusted.
 */
import { HttpError } from '../../middleware/errorHandler.js';
import { upsertResult, componentScore as legacyComponentScore, normalizeScore, type PolicyComponent } from './store.js';

export interface AutoScoreResult {
  score: number;
  feedback: string;
}

/** Deterministic auto-scoring for a single question. */
export function autoScoreQuestion(q: any, response: unknown): AutoScoreResult {
  if (q.qtype === 'mcq' || q.qtype === 'short_answer') {
    const expected = String(q.answer_key || '').trim().toLowerCase();
    const given = String(response ?? '').trim().toLowerCase();
    const score = expected && given === expected ? Number(q.points || 0) : 0;
    // The feedback string is returned to the client and persisted on the
    // response row, so it must never echo the expected answer. Returning
    // `Expected: <answer_key>` would hand the candidate the key for every
    // question they got wrong — one wrong pass through the exam would reveal
    // the whole paper (certification finding C-4).
    return { score, feedback: score > 0 ? 'Correct' : 'Incorrect' };
  }
  return { score: 0, feedback: '' }; // essay/speaking are manual
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
  const weightedScore = Math.round(((score / max) * weight) * 10000) / 100;
  return { rawScore: Math.round(score * 100) / 100, percentage, weightedScore };
}

/**
 * Score a manual/hybrid component body (staff entry). For content_test
 * components, only the manual portion (essay/speaking) is accepted; the auto
 * portion is read from stored responses so it can never be rewritten.
 */
export function scoreComponentBody(component: PolicyComponent, body: any, snapshotTests: any[], attemptId: string) {
  if (component.type === 'content_test') {
    const test = (snapshotTests || []).find((t: any) => t.id === component.testId);
    if (!test) throw new HttpError(409, 'Test content missing from the attempt snapshot.');
    const manualQuestions = test.questions.filter((q: any) => q.qtype === 'essay' || q.qtype === 'speaking');
    const autoEarned = Number((dbPreparedAutoSum.get(attemptId, test.id) as any)?.s || 0);
    if (manualQuestions.length === 0) {
      throw new HttpError(409, 'This content component is fully auto-graded; override its score through the responses endpoint only.');
    }
    const answeredCount = Number((dbPreparedAnsweredCount.get(attemptId, test.id) as any)?.c || 0);
    if (answeredCount < test.questions.length) throw new HttpError(400, `Record answers for all ${test.questions.length} questions before manual scoring (${answeredCount} answered).`);
    const manualMax = manualQuestions.reduce((sum: number, q: any) => sum + Number(q.points || 0), 0);
    // Rubric-driven manual scoring: criteriaScores [{ key, score }] are
    // validated against the linked rubric's criteria (weighted by weight and
    // bounded by each criterion's maxScore); the weighted total is normalized
    // to the manual point budget. A plain manualScore remains supported.
    let manualScore: number;
    let criteria: Record<string, number> | null = null;
    if (body?.criteriaScores && typeof body.criteriaScores === 'object') {
      if (!test.rubric_id) throw new HttpError(400, 'criteriaScores were provided but the test has no linked rubric.');
      const rubric = db.prepare('SELECT criteria_json FROM placement_rubrics WHERE id = ?').get(test.rubric_id) as { criteria_json: string } | undefined;
      if (!rubric) throw new HttpError(409, 'The linked rubric no longer exists.');
      const rubricCriteria = JSON.parse(rubric.criteria_json || '[]') as Array<{ key: string; weight: number; maxScore: number }>;
      if (!Array.isArray(rubricCriteria) || rubricCriteria.length === 0) throw new HttpError(409, 'The linked rubric has no criteria.');
      criteria = {};
      let weightedSum = 0;
      for (const c of rubricCriteria) {
        const given = Number(body.criteriaScores[c.key]);
        if (!Number.isFinite(given)) throw new HttpError(400, `Missing numeric score for rubric criterion "${c.key}".`);
        if (given < 0 || given > Number(c.maxScore)) throw new HttpError(400, `Criterion "${c.key}" score must be between 0 and ${c.maxScore}.`);
        criteria[c.key] = given;
        weightedSum += (given / Number(c.maxScore || 1)) * Number(c.weight || 0);
      }
      manualScore = Math.round((weightedSum / 100) * manualMax * 100) / 100;
    } else {
      manualScore = normalizeScore(body?.manualScore, manualMax);
    }
    const rawCombined = autoEarned + manualScore;
    const rawMax = test.questions.reduce((sum: number, q: any) => sum + Number(q.points || 0), 0) || component.maxScore;
    const score = Math.round((rawCombined / rawMax) * component.maxScore * 100) / 100;
    return {
      score,
      payload: { mode: 'manual', autoEarned, manualScore, manualMax, criteriaScores: criteria, combinedRaw: rawCombined, rawMax, feedback: body?.resultText || null },
      rawScore: rawCombined,
      rawMax,
    };
  }
  const result = legacyComponentScore(component, body);
  return { score: result.score, payload: result.payload, rawScore: result.score, rawMax: component.maxScore };
}

import { db } from '../../db/connection.js';
const dbPreparedAutoSum = db.prepare('SELECT COALESCE(SUM(auto_score), 0) AS s FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?');
const dbPreparedAnsweredCount = db.prepare('SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?');

export { upsertResult };
