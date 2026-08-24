import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import {
  canonicalComponents,
  canonicalDecisionRules,
  componentTest,
  createActiveTest,
  enterManualScore,
  putProfile,
  scoreAndComplete,
  seedContext,
  startAttempt,
  startTimer,
  submitDigitalAnswers,
} from './fixtures.js';

async function score(context: ReturnType<typeof seedContext>, attemptId: string, componentKey: 'grammar' | 'reading' | 'listening' | 'writing' | 'speaking', value: number, auth = context.receptionistA, extra: Record<string, unknown> = {}) {
  return enterManualScore(context, attemptId, componentKey, { score: value, ...extra }, auth);
}

describe('WP-04 scoring, decisions, corrections, and reporting', () => {
  it('computes the canonical 120-point overall result while preserving fixed component maxima', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, {
      grammar: 15,
      reading: 10,
      listening: 10,
      writing: 12.5,
      speaking: 12.5,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.decision.percentage).toBe(50);
    expect(completed.body.attempt.max_score).toBe(120);
  });

  it('validates score ranges, accepts manualScore for rubric/manual flows, and rejects re-scoring a final component', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    await startTimer(context, started.body.id, 'grammar');
    await startTimer(context, started.body.id, 'writing');
    expect((await score(context, started.body.id, 'grammar', 31)).status).toBe(400);
    const writingAlias = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing`)
      .set(context.receptionistA)
      .send({ manualScore: 20 });
    expect(writingAlias.status).toBe(200);
    expect((await score(context, started.body.id, 'grammar', 30)).status).toBe(200);
    expect((await score(context, started.body.id, 'grammar', 25)).status).toBe(409);
  });

  it('auto-scores objective digital components and leaves productive skills pending until human scoring', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    await startTimer(context, started.body.id, 'grammar');
    await startTimer(context, started.body.id, 'writing');
    const grammar = componentTest(started.body.id, 'grammar');
    const writing = componentTest(started.body.id, 'writing');

    const responses = await submitDigitalAnswers(
      context,
      started.body.id,
      'grammar',
      grammar.questions.map((question: any) => ({ questionKey: question.question_key, response: 'A' })),
    );
    expect(responses.status).toBe(200);
    expect(responses.body).toMatchObject({ autoScore: 30, complete: true });

    const writingResponse = await submitDigitalAnswers(context, started.body.id, 'writing', [
      { questionKey: writing.questions[0].question_key, response: 'Candidate essay' },
    ]);
    expect(writingResponse.status).toBe(200);
    expect(writingResponse.body).toMatchObject({ autoScore: 0, complete: false });

    const manual = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing`)
      .set(context.receptionistA)
      .send({ criteriaScores: { content: 5 } });
    expect(manual.status).toBe(200);
    expect(manual.body.find((row: any) => row.component_key === 'writing')).toMatchObject({ score: 25, raw_score: 25, percentage: 100, status: 'completed' });
  });

  it('scores against the immutable rubric snapshot after the authoring rubric changes', async () => {
    const context = seedContext();
    const rubric = await supertest(context.app)
      .post('/api/placement/rubrics')
      .set(context.managerA)
      .send({
        title: 'Essay rubric',
        kind: 'writing',
        criteria: [{ key: 'content', label: 'Content', weight: 100, maxScore: 5 }],
      });
    expect(rubric.status).toBe(201);
    const test = await createActiveTest(context, {
      testType: 'writing',
      rubricId: rubric.body.id,
      questions: [{ key: 'essay', qtype: 'essay', prompt: 'Write', points: 25 }],
    });
    expect((await putProfile(context, {
      components: canonicalComponents(context, { writing: { bankIds: [test.id] } }),
    })).status).toBe(200);
    const started = await startAttempt(context);
    const changed = await supertest(context.app)
      .put(`/api/placement/rubrics/${rubric.body.id}`)
      .set(context.managerA)
      .send({
        version: rubric.body.version,
        criteria: [{ key: 'new-criterion', label: 'New', weight: 100, maxScore: 20 }],
      });
    expect(changed.status).toBe(200);
    await startTimer(context, started.body.id, 'writing');
    const scored = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing`)
      .set(context.receptionistA)
      .send({ criteriaScores: { content: 5 } });
    expect(scored.status).toBe(200);
    expect(scored.body.find((row: any) => row.component_key === 'writing')).toMatchObject({ score: 25, percentage: 100 });

    await startTimer(context, started.body.id, 'grammar');
    await startTimer(context, started.body.id, 'reading');
    await startTimer(context, started.body.id, 'listening');
    await startTimer(context, started.body.id, 'speaking');
    await score(context, started.body.id, 'grammar', 20);
    await score(context, started.body.id, 'reading', 16);
    await score(context, started.body.id, 'listening', 16);
    await score(context, started.body.id, 'speaking', 18);
    expect((await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA)
      .send({})).status).toBe(200);
    const forgedNewCriterion = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing/correct`)
      .set(context.managerA)
      .send({ criteriaScores: { 'new-criterion': 20 }, reason: 'Forged current rubric' });
    expect(forgedNewCriterion.status).toBe(400);
  });

  it('fails placement when one canonical component misses the CEFR ladder even if the total percentage remains high', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, {
      grammar: 0,
      reading: 20,
      listening: 20,
      writing: 25,
      speaking: 25,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.decision.percentage).toBe(75);
    expect(completed.body.outcome).toBe('failed');
    expect(completed.body.decision.overallCefr).toBeNull();
  });

  it('uses the immutable CEFR rule ladder from the profile snapshot to produce the recommendation', async () => {
    const context = seedContext();
    expect((await putProfile(context, { decisionRules: canonicalDecisionRules(context) })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, {
      grammar: 15,
      reading: 10,
      listening: 10,
      writing: 12,
      speaking: 12,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.decision.recommendedLevelId).toBe(context.levelA2);
    expect(completed.body.decision.decisionRuleId).toBe('A2');
  });

  it('records a failed sitting but resets the visitor for a retake instead of presenting it as enrollment-ready', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, { grammar: 0, reading: 0, listening: 0, writing: 0, speaking: 0 });
    expect(completed.status).toBe(200);
    expect(completed.body.outcome).toBe('failed');
    expect(db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId)).toMatchObject({
      placement_status: 'scheduled',
      current_placement_attempt_id: null,
    });
    expect((db.prepare('SELECT status,outcome FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any)).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  it('requires management and a reason to waive a required component', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/grammar`;
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({ status: 'waived', notes: 'Approved exception' })).status).toBe(403);
    expect((await supertest(context.app).put(url).set(context.managerA).send({ status: 'waived' })).status).toBe(400);
    const allowed = await supertest(context.app).put(url).set(context.managerA).send({ status: 'waived', notes: 'Documented accommodation' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.find((row: any) => row.component_key === 'grammar').status).toBe('waived');
  });

  it('recomputes a correction atomically, tracks provenance, and preserves an authorized override', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, {
      grammar: 20,
      reading: 16,
      listening: 16,
      writing: 18,
      speaking: 18,
    });
    expect(completed.body.outcome).toBe('passed');
    const override = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/override`)
      .set(context.managerA)
      .send({ levelId: context.levelA2, reason: 'Verified interview evidence' });
    expect(override.status).toBe(200);

    const missingReason = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/grammar/correct`)
      .set(context.managerA)
      .send({ score: 0 });
    expect(missingReason.status).toBe(400);
    const corrected = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/grammar/correct`)
      .set(context.managerA)
      .send({ score: 0, reason: 'Data-entry transcription correction' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.outcome).toBe('failed');
    expect(corrected.body.decision.recommendedLevelId).toBe(context.levelA2);
    const result = db.prepare("SELECT score,score_version,corrected_by,correction_reason FROM placement_assessment_results WHERE attempt_id=? AND component_key='grammar'").get(started.body.id) as any;
    expect(result).toMatchObject({ score: 0, score_version: 2, corrected_by: context.managerAId, correction_reason: 'Data-entry transcription correction' });
    expect(db.prepare('SELECT outcome,override_level_id,recommended_level_id FROM placement_assessment_attempts WHERE id=?').get(started.body.id)).toMatchObject({
      outcome: 'failed',
      override_level_id: context.levelA2,
      recommended_level_id: context.levelA2,
    });
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(context.visitorId) as any).placement_status).toBe('scheduled');
  });

  it('validates report dates and keeps branch/program filtering parameterized and authorized', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    expect((await scoreAndComplete(context, started.body.id, { grammar: 20, reading: 15, listening: 15, writing: 20, speaking: 20 })).completed.status).toBe(200);
    expect((await supertest(context.app).get('/api/placement/report?from=bad&to=2026-12-31').set(context.managerA)).status).toBe(400);
    expect((await supertest(context.app).get('/api/placement/report?from=2026-02-30&to=2026-12-31').set(context.managerA)).status).toBe(400);
    expect((await supertest(context.app).get('/api/placement/report?from=2026-12-31&to=2026-01-01').set(context.managerA)).status).toBe(400);

    const report = await supertest(context.app)
      .get(`/api/placement/report?from=2000-01-01&to=2100-01-01&programVersionId=${encodeURIComponent(context.versionA)}`)
      .set(context.managerA);
    expect(report.status).toBe(200);
    expect(report.body.summary).toMatchObject({ total: 1, completed: 1, passed: 1, failed: 0, averagePercentage: 75 });
    const foreign = await supertest(context.app)
      .get(`/api/placement/report?from=2000-01-01&to=2100-01-01&programVersionId=${encodeURIComponent(context.versionA)}`)
      .set(context.managerB);
    expect(foreign.status).toBe(200);
    expect(foreign.body.summary.total).toBe(0);
    const injected = await supertest(context.app)
      .get('/api/placement/report?from=2000-01-01&to=2100-01-01&programVersionId=%27%20OR%201%3D1--')
      .set(context.managerA);
    expect(injected.status).toBe(200);
    expect(injected.body.summary.total).toBe(0);
  });
});
