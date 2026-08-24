import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../db/connection.js';
import {
  componentTest,
  enterManualScore,
  putProfile,
  seedContext,
  startAttempt,
  startTimer,
  submitDigitalAnswers,
} from './work-packages/wp04/fixtures.js';

describe('Placement engine extensions', () => {
  it('accepts speaking DIGITAL responses via branch-scoped audio media ids', async () => {
    const context = seedContext();
    await putProfile(context);
    const mediaId = `${context.key}_audio_${randomUUID().slice(0, 6)}`;
    db.prepare(`
      INSERT INTO placement_media (id, filename, mime, size_bytes, sha256, storage_path, kind, branch_id, created_by)
      VALUES (?, 'sample.wav', 'audio/wav', 1234, 'abc123', '/tmp/sample.wav', 'audio', ?, ?)
    `).run(mediaId, context.branchA, context.managerAId);

    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    expect(started.status).toBe(201);
    const timer = await startTimer(context, started.body.id, 'speaking');
    expect(timer.status).toBe(200);

    const speakingQuestion = componentTest(started.body.id, 'speaking').questions[0];
    const submitted = await submitDigitalAnswers(context, started.body.id, 'speaking', [{
      questionKey: speakingQuestion.question_key,
      response: { audioMediaId: mediaId },
    }]);
    expect(submitted.status).toBe(200);
    expect(submitted.body.complete).toBe(false);
    expect(submitted.body.responses[0].questionKey).toBe(speakingQuestion.question_key);
  });

  it('stores rubric-derived criteria scores for writing and speaking', async () => {
    const context = seedContext();
    await putProfile(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    await startTimer(context, started.body.id, 'writing');
    const writing = await enterManualScore(context, started.body.id, 'writing', {
      criteriaScores: { content: 4 },
      resultText: 'Organized response',
    });
    expect(writing.status).toBe(200);

    await startTimer(context, started.body.id, 'speaking');
    const speaking = await enterManualScore(context, started.body.id, 'speaking', {
      criteriaScores: { delivery: 5 },
      resultText: 'Clear fluency',
    });
    expect(speaking.status).toBe(200);

    const rows = db.prepare(`
      SELECT component_key, payload_json
      FROM placement_assessment_results
      WHERE attempt_id=? AND component_key IN ('writing','speaking')
      ORDER BY component_key
    `).all(started.body.id) as Array<{ component_key: string; payload_json: string }>;
    const payloads = rows.map((row) => ({ component: row.component_key, payload: JSON.parse(row.payload_json) }));
    expect(payloads).toEqual([
      { component: 'speaking', payload: { mode: 'rubric', criteriaScores: { delivery: 5 }, feedback: 'Clear fluency' } },
      { component: 'writing', payload: { mode: 'rubric', criteriaScores: { content: 4 }, feedback: 'Organized response' } },
    ]);
  });

  it('rejects unknown rubric criteria during canonical human scoring', async () => {
    const context = seedContext();
    await putProfile(context);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    await startTimer(context, started.body.id, 'writing');
    const invalid = await enterManualScore(context, started.body.id, 'writing', {
      criteriaScores: { unknown: 3 },
      resultText: 'Invalid rubric payload',
    });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.error || '')).toContain('unknown rubric criterion');
  });
});
