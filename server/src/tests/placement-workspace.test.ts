import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { componentTest, putProfile, seedContext, startAttempt, startTimer, submitDigitalAnswers } from './work-packages/wp04/fixtures.js';

describe('Placement workspace surface', () => {
  it('returns the canonical profile with both delivery modes and five components', async () => {
    const context = seedContext();
    const saved = await putProfile(context);
    expect(saved.status).toBe(200);

    const view = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.receptionistA);
    expect(view.status).toBe(200);
    expect(view.body.profile.requirementMode).toBe('required');
    expect(view.body.profile.deliveryModes).toEqual(['DIGITAL', 'PHYSICAL']);
    expect(view.body.profile.components.map((component: any) => component.key)).toEqual([
      'grammar',
      'reading',
      'listening',
      'writing',
      'speaking',
    ]);
  });

  it('shows sanitized DIGITAL attempt snapshots and persisted response capture', async () => {
    const context = seedContext();
    await putProfile(context);
    const attempt = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    expect(attempt.status).toBe(201);

    const started = await startTimer(context, attempt.body.id, 'grammar');
    expect(started.status).toBe(200);
    const grammarQuestion = componentTest(attempt.body.id, 'grammar').questions[0];
    const submitted = await submitDigitalAnswers(context, attempt.body.id, 'grammar', [{ questionKey: grammarQuestion.question_key, response: 'A' }]);
    expect(submitted.status).toBe(200);

    const view = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.receptionistA);
    expect(view.status).toBe(200);
    expect(view.body.current.delivery_mode).toBe('DIGITAL');
    const grammarTest = view.body.current.snapshot.tests.find((test: any) => test.component_key === 'grammar');
    expect(grammarTest.questions[0].answer_key).toBeUndefined();
    expect(view.body.current.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionKey: grammarQuestion.question_key, response: 'A', autoScore: 1 }),
    ]));
  });

  it('keeps PHYSICAL delivery on the same domain surface and blocks direct digital response capture', async () => {
    const context = seedContext();
    await putProfile(context);
    const attempt = await startAttempt(context, context.receptionistA, { deliveryMode: 'PHYSICAL' });
    expect(attempt.status).toBe(201);

    const started = await startTimer(context, attempt.body.id, 'grammar');
    expect(started.status).toBe(200);
    const grammarQuestion = componentTest(attempt.body.id, 'grammar').questions[0];
    const denied = await submitDigitalAnswers(context, attempt.body.id, 'grammar', [{ questionKey: grammarQuestion.question_key, response: 'A' }]);
    expect(denied.status).toBe(409);
    expect(String(denied.body.error || '')).toContain('DIGITAL delivery mode');
  });
});
