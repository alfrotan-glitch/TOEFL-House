import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { createActiveTest, putProfile, scoreAndComplete, scoreComponent, seedContext, startAttempt } from './fixtures.js';

async function score(context: ReturnType<typeof seedContext>, attemptId: string, componentKey: string, value: number, auth = context.receptionistA, extra: Record<string, unknown> = {}) {
  return supertest(context.app)
    .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${attemptId}/components/${componentKey}`)
    .set(auth).send({ score: value, ...extra });
}

describe('WP-04 scoring, decisions, corrections, and reporting', () => {
  it('computes the overall result as weighted percentages while preserving configurable component maxima', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      components: [
        scoreComponent({ key: 'oral', label: 'Oral', weight: 25, maxScore: 40 }),
        scoreComponent({ key: 'written', label: 'Written', weight: 75, maxScore: 60 }),
      ],
      passScore: 60,
    })).status).toBe(200);
    const started = await startAttempt(context);
    expect((await score(context, started.body.id, 'oral', 20)).status).toBe(200);
    expect((await score(context, started.body.id, 'written', 45)).status).toBe(200);
    const completed = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA).send({});
    expect(completed.status).toBe(200);
    expect(completed.body.decision.percentage).toBe(68.75);
    expect(completed.body.outcome).toBe('passed');
    expect(completed.body.attempt.max_score).toBe(100);
  });

  it('rejects client score aliases, out-of-range values, and re-scoring a final component', async () => {
    const context = seedContext();
    expect((await putProfile(context, { components: [scoreComponent({ maxScore: 40 })] })).status).toBe(200);
    const started = await startAttempt(context);
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/main`;
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({ manualScore: 20 })).status).toBe(400);
    expect((await score(context, started.body.id, 'main', 41)).status).toBe(400);
    expect((await score(context, started.body.id, 'main', 30)).status).toBe(200);
    expect((await score(context, started.body.id, 'main', 35)).status).toBe(409);
  });

  it('combines server-derived automatic points with the bounded manual portion for hybrid content', async () => {
    const context = seedContext();
    const test = await createActiveTest(context, { testType: 'writing', questions: [
      { key: 'auto', qtype: 'mcq', prompt: 'Auto', options: ['A', 'B'], answerKey: 'A', points: 5 },
      { key: 'essay', qtype: 'essay', prompt: 'Essay', points: 5 },
    ] });
    expect((await putProfile(context, { components: [{
      key: 'hybrid', type: 'content_test', label: 'Hybrid', required: true,
      weight: 100, maxScore: 100, scoringMethod: 'hybrid', testType: 'writing', testId: test.id,
    }] })).status).toBe(200);
    const started = await startAttempt(context);
    const responses = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/hybrid/responses`)
      .set(context.receptionistA).send({ answers: [
        { questionKey: 'auto', response: 'A' }, { questionKey: 'essay', response: 'Candidate essay' },
      ] });
    expect(responses.status).toBe(200);
    expect(responses.body).toMatchObject({ autoScore: 5, complete: false });
    const manual = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/hybrid`)
      .set(context.receptionistA).send({ manualScore: 5 });
    expect(manual.status).toBe(200);
    expect(manual.body[0]).toMatchObject({ score: 100, raw_score: 10, percentage: 100, status: 'completed' });
  });

  it('scores against the immutable rubric snapshot after the authoring rubric changes', async () => {
    const context = seedContext();
    const rubric = await supertest(context.app).post('/api/placement/rubrics').set(context.managerA).send({
      title: 'Essay rubric', kind: 'writing', criteria: [{ key: 'content', label: 'Content', weight: 100, maxScore: 5 }],
    });
    expect(rubric.status).toBe(201);
    const test = await createActiveTest(context, {
      testType: 'writing', rubricId: rubric.body.id,
      questions: [{ key: 'essay', qtype: 'essay', prompt: 'Write', points: 10 }],
    });
    expect((await putProfile(context, { components: [{
      key: 'writing', type: 'content_test', label: 'Writing', required: true,
      weight: 100, maxScore: 10, scoringMethod: 'manual', testType: 'writing', testId: test.id,
    }] })).status).toBe(200);
    const started = await startAttempt(context);
    const changed = await supertest(context.app).put(`/api/placement/rubrics/${rubric.body.id}`).set(context.managerA).send({
      version: rubric.body.version,
      criteria: [{ key: 'new-criterion', label: 'New', weight: 100, maxScore: 20 }],
    });
    expect(changed.status).toBe(200);
    expect((await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/writing/responses`)
      .set(context.receptionistA).send({ answers: [{ questionKey: 'essay', response: 'Essay response' }] })).status).toBe(200);
    const scored = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing`)
      .set(context.receptionistA).send({ criteriaScores: { content: 5 } });
    expect(scored.status).toBe(200);
    expect(scored.body[0]).toMatchObject({ score: 10, percentage: 100 });
    expect((await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA).send({})).status).toBe(200);
    const forgedNewCriterion = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/writing/correct`)
      .set(context.managerA).send({ criteriaScores: { 'new-criterion': 20 }, reason: 'Forged current rubric' });
    expect(forgedNewCriterion.status).toBe(400);
  });

  it('fails a required component minimum even when the overall weighted percentage passes', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      components: [
        scoreComponent({ key: 'required', label: 'Required', required: true, weight: 10, minScore: 80 }),
        scoreComponent({ key: 'other', label: 'Other', required: true, weight: 90 }),
      ], passScore: 60,
    })).status).toBe(200);
    const started = await startAttempt(context);
    await score(context, started.body.id, 'required', 70);
    await score(context, started.body.id, 'other', 100);
    const completed = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA).send({});
    expect(completed.status).toBe(200);
    expect(completed.body.decision.percentage).toBe(97);
    expect(completed.body.outcome).toBe('failed');
    expect(completed.body.unmetRequirements).toContain('required (below minimum score 80)');
  });

  it('uses immutable decision rules before score-band fallback and rejects conflicting explicit levels', async () => {
    const context = seedContext();
    const components = [
      scoreComponent({ key: 'first', label: 'First', weight: 50 }),
      scoreComponent({ key: 'second', label: 'Second', weight: 50 }),
    ];
    expect((await putProfile(context, {
      components,
      decisionRules: [{ levelId: context.levelA2, levelCode: 'A2', label: 'Strong first section', when: [{ componentKey: 'first', field: 'percentage', op: 'gte', value: 80 }] }],
    })).status).toBe(200);
    db.prepare(`INSERT INTO placement_rules
      (id,program_version_id,name,min_score,max_score,recommended_level_id,recommended_level_code,branch_id,sort_order,is_active,version)
      VALUES (?,?,?,0,100,?,?,?,1,1,1)`)
      .run(`${context.key}_fallback`, context.versionA, 'Fallback', context.levelA1, 'A1', context.branchA);
    const started = await startAttempt(context);
    await score(context, started.body.id, 'first', 90);
    await score(context, started.body.id, 'second', 50);
    const completed = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/complete`)
      .set(context.receptionistA).send({});
    expect(completed.status).toBe(200);
    expect(completed.body.decision.recommendedLevelId).toBe(context.levelA2);
    expect(completed.body.decision.decisionRuleId).toBe('policy:Strong first section');
  });

  it('records a failed sitting but resets the visitor for a retake instead of presenting it as enrollment-ready', async () => {
    const context = seedContext();
    expect((await putProfile(context, { passScore: 80 })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, 40);
    expect(completed.status).toBe(200);
    expect(completed.body.outcome).toBe('failed');
    expect(db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId)).toMatchObject({
      placement_status: 'scheduled', current_placement_attempt_id: null,
    });
    expect((db.prepare('SELECT status,outcome FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any)).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  it('requires management and a reason to waive a required component', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/main`;
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({ status: 'waived', notes: 'Approved exception' })).status).toBe(403);
    expect((await supertest(context.app).put(url).set(context.managerA).send({ status: 'waived' })).status).toBe(400);
    const allowed = await supertest(context.app).put(url).set(context.managerA).send({ status: 'waived', notes: 'Documented accommodation' });
    expect(allowed.status).toBe(200);
    expect(allowed.body[0].status).toBe('waived');
  });

  it('recomputes a correction atomically, tracks provenance, and preserves an authorized override', async () => {
    const context = seedContext();
    expect((await putProfile(context, { passScore: 60 })).status).toBe(200);
    const started = await startAttempt(context);
    const { completed } = await scoreAndComplete(context, started.body.id, 80);
    expect(completed.body.outcome).toBe('passed');
    const override = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/override`)
      .set(context.managerA).send({ levelId: context.levelA2, reason: 'Verified interview evidence' });
    expect(override.status).toBe(200);

    const missingReason = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/main/correct`)
      .set(context.managerA).send({ score: 20 });
    expect(missingReason.status).toBe(400);
    const corrected = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/main/correct`)
      .set(context.managerA).send({ score: 20, reason: 'Data-entry transcription correction' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.outcome).toBe('failed');
    expect(corrected.body.decision.recommendedLevelId).toBe(context.levelA2);
    const result = db.prepare("SELECT score,score_version,corrected_by,correction_reason FROM placement_assessment_results WHERE attempt_id=? AND component_key='main'").get(started.body.id) as any;
    expect(result).toMatchObject({ score: 20, score_version: 2, corrected_by: context.managerAId, correction_reason: 'Data-entry transcription correction' });
    expect(db.prepare('SELECT outcome,override_level_id,recommended_level_id FROM placement_assessment_attempts WHERE id=?').get(started.body.id)).toMatchObject({
      outcome: 'failed', override_level_id: context.levelA2, recommended_level_id: context.levelA2,
    });
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(context.visitorId) as any).placement_status).toBe('scheduled');
  });

  it('validates report dates and keeps branch/program filtering parameterized and authorized', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    expect((await scoreAndComplete(context, started.body.id, 75)).completed.status).toBe(200);
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
