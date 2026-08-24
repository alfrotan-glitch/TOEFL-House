import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import {
  attemptSnapshot,
  createActiveTest,
  putProfile,
  seedContext,
  startAttempt,
} from './work-packages/wp04/fixtures.js';

describe('Placement content lifecycle', () => {
  it('keeps attempt snapshots immutable after test-bank content changes', async () => {
    const context = seedContext();
    const readingBank = await createActiveTest(context, {
      testType: 'reading',
      questions: Array.from({ length: 20 }, (_, index) => ({
        key: `r${index + 1}`,
        qtype: 'mcq',
        prompt: index === 0 ? 'Original reading prompt' : `Reading prompt ${index + 1}`,
        options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
        answerKey: 'A',
        points: 1,
        difficulty: 'easy',
        cefrLevel: 'A1',
      })),
    });
    const saved = await putProfile(context, {
      componentOverrides: {
        reading: {
          bankIds: [readingBank.id],
        },
      },
    });
    expect(saved.status).toBe(200);

    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    expect(started.status).toBe(201);
    const beforePrompts = attemptSnapshot(started.body.id).tests.find((test: any) => test.component_key === 'reading').questions.map((question: any) => question.prompt);
    expect(beforePrompts).toContain('Original reading prompt');

    db.prepare(`UPDATE placement_test_questions SET prompt='Mutated reading prompt' WHERE test_id=?`).run(readingBank.id);

    const afterPrompts = attemptSnapshot(started.body.id).tests.find((test: any) => test.component_key === 'reading').questions.map((question: any) => question.prompt);
    expect(afterPrompts).toEqual(beforePrompts);
    expect(afterPrompts).toContain('Original reading prompt');
  });

  it('strips answer keys from operational snapshots while preserving authoring preview access', async () => {
    const context = seedContext();
    await putProfile(context);

    const authorPreview = await supertest(context.app)
      .get(`/api/placement/test-bank/${context.assets.grammarBankId}/preview`)
      .set(context.managerA);
    expect(authorPreview.status).toBe(200);
    expect(authorPreview.body.questions[0].answerKey).toBe('A');

    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    expect(started.status).toBe(201);

    const view = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.receptionistA);
    expect(view.status).toBe(200);
    const grammarTest = view.body.current.snapshot.tests.find((test: any) => test.component_key === 'grammar');
    expect(grammarTest.questions[0].answer_key).toBeUndefined();
  });

  it('refuses to start a new attempt when a configured canonical bank has been archived', async () => {
    const context = seedContext();
    const grammarBank = await createActiveTest(context, {
      testType: 'grammar',
      questions: Array.from({ length: 30 }, (_, index) => ({
        key: `g${index + 1}`,
        qtype: 'mcq',
        prompt: `Grammar ${index + 1}`,
        options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
        answerKey: 'A',
        points: 1,
        difficulty: 'easy',
        cefrLevel: 'A1',
      })),
    });
    const saved = await putProfile(context, {
      componentOverrides: {
        grammar: {
          bankIds: [grammarBank.id],
        },
      },
    });
    expect(saved.status).toBe(200);

    const archived = await supertest(context.app)
      .post(`/api/placement/test-bank/${grammarBank.id}/archive`)
      .set(context.managerA)
      .send({ version: grammarBank.version });
    expect(archived.status).toBe(200);

    const start = await startAttempt(context);
    expect(start.status).toBe(409);
    expect(String(start.body.error || '')).toContain('is not active');
  });
});
