import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import {
  attemptSnapshot,
  enterManualScore,
  putProfile,
  scoreAndComplete,
  seedContext,
  startAttempt,
  startTimer,
  submitDigitalAnswers,
} from './work-packages/wp04/fixtures.js';

async function answerAllObjectiveSections(context: ReturnType<typeof seedContext>, attemptId: string) {
  for (const componentKey of ['grammar', 'reading', 'listening'] as const) {
    const timer = await startTimer(context, attemptId, componentKey);
    expect(timer.status).toBe(200);
    const test = attemptSnapshot(attemptId).tests.find((candidate: any) => candidate.component_key === componentKey);
    const answers = test.questions.map((question: any) => ({ questionKey: question.question_key, response: 'A' }));
    const submitted = await submitDigitalAnswers(context, attemptId, componentKey, answers);
    expect(submitted.status).toBe(200);
    expect(submitted.body.complete).toBe(true);
  }
}

describe('Placement integrity', () => {
  it('converges DIGITAL and PHYSICAL delivery onto the same canonical decision outcome', async () => {
    const context = seedContext();
    const saved = await putProfile(context, { retakeBillable: false });
    expect(saved.status).toBe(200);

    const digital = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    expect(digital.status).toBe(201);
    await answerAllObjectiveSections(context, digital.body.id);
    await startTimer(context, digital.body.id, 'writing');
    await startTimer(context, digital.body.id, 'speaking');
    const digitalWriting = await enterManualScore(context, digital.body.id, 'writing', { score: 20, resultText: 'Strong draft' });
    const digitalSpeaking = await enterManualScore(context, digital.body.id, 'speaking', { score: 20, resultText: 'Strong fluency' });
    expect(digitalWriting.status).toBe(200);
    expect(digitalSpeaking.status).toBe(200);
    const digitalComplete = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${digital.body.id}/complete`)
      .set(context.receptionistA)
      .send({});
    expect(digitalComplete.status).toBe(200);

    const physical = await startAttempt(context, context.receptionistA, { deliveryMode: 'PHYSICAL' });
    expect(physical.status).toBe(201);
    const physicalScores = await scoreAndComplete(context, physical.body.id, {
      grammar: 30,
      reading: 20,
      listening: 20,
      writing: 20,
      speaking: 20,
    });
    expect(physicalScores.completed.status).toBe(200);

    expect(physicalScores.completed.body.decision.overallCefr).toBe(digitalComplete.body.decision.overallCefr);
    expect(physicalScores.completed.body.decision.recommendedLevelId).toBe(digitalComplete.body.decision.recommendedLevelId);
    expect(physicalScores.completed.body.decision.componentEvidence.map((row: any) => row.componentKey)).toEqual([
      'grammar',
      'reading',
      'listening',
      'writing',
      'speaking',
    ]);
  });

  it('recomputes the CEFR recommendation explainably after a canonical score correction', async () => {
    const context = seedContext();
    await putProfile(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    const completed = await scoreAndComplete(context, started.body.id, {
      grammar: 11,
      reading: 8,
      listening: 8,
      writing: 12,
      speaking: 12,
    });
    expect(completed.completed.status).toBe(200);
    expect(completed.completed.body.decision.recommendedLevelId).toBe(context.levelA1);

    const corrected = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/components/grammar/correct`)
      .set(context.managerA)
      .send({ score: 12, reason: 'Verified one additional correct answer', resultText: 'Regraded grammar sheet' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.scoreVersion).toBe(2);
    expect(corrected.body.decision.recommendedLevelId).toBe(context.levelA2);
    expect(corrected.body.decision.componentEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'grammar', cefrLevel: 'A2' }),
    ]));

    const grammar = db.prepare(`
      SELECT score_version, correction_reason
      FROM placement_assessment_results
      WHERE attempt_id=? AND component_key='grammar'
    `).get(started.body.id) as { score_version: number; correction_reason: string };
    expect(grammar.score_version).toBe(2);
    expect(grammar.correction_reason).toContain('Verified one additional correct answer');
  });
});
