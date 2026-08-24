import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import {
  attemptSnapshot,
  canonicalComponents,
  componentTest,
  createActiveTest,
  ensureLinkedStudent,
  putFixedFeeRule,
  putProfile,
  seedContext,
  startAttempt,
  startTimer,
  submitDigitalAnswers,
} from './fixtures.js';

describe('WP-04 placement attempt lifecycle, immutable workspace, and timing', () => {
  it('fails closed when no applicable policy exists and records an explicit optional waiver reason', async () => {
    const noPolicy = seedContext();
    const denied = await startAttempt(noPolicy);
    expect(denied.status).toBe(400);

    const optional = seedContext();
    expect((await putProfile(optional, { requirementMode: 'optional' })).status).toBe(200);
    ensureLinkedStudent(optional);
    const missingReason = await supertest(optional.app)
      .post(`/api/placement/visitors/${optional.visitorId}/placement/attempts`)
      .set(optional.receptionistA)
      .send({ deliveryMode: 'PHYSICAL', skip: true });
    expect(missingReason.status).toBe(400);
    const waived = await supertest(optional.app)
      .post(`/api/placement/visitors/${optional.visitorId}/placement/attempts`)
      .set(optional.receptionistA)
      .send({ deliveryMode: 'PHYSICAL', skip: true, reason: 'Candidate elected direct enrollment' });
    expect(waived.status).toBe(200);
    const visitor = db.prepare('SELECT placement_status,current_placement_attempt_id,placement_score FROM visitors WHERE id=?').get(optional.visitorId) as any;
    expect(visitor.placement_status).toBe('waived');
    expect(visitor.current_placement_attempt_id).toBeNull();
    expect(JSON.parse(visitor.placement_score).reason).toBe('Candidate elected direct enrollment');
  });

  it('enforces one open attempt and atomically resets the visitor when it is cancelled', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    expect((await startAttempt(context)).status).toBe(409);
    const cancelled = await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/cancel`)
      .set(context.receptionistA)
      .send({ reason: 'Candidate unavailable' });
    expect(cancelled.status).toBe(200);
    const visitor = db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId) as any;
    expect(visitor).toMatchObject({ placement_status: 'scheduled', current_placement_attempt_id: null });
  });

  it('captures immutable policy, test content, answer keys, and billing terms at start', async () => {
    const context = seedContext();
    const test = await createActiveTest(
      context,
      {
        testType: 'listening',
        questions: Array.from({ length: 20 }, (_, index) => ({
          key: `q${index + 1}`,
          qtype: 'mcq',
          prompt: index === 0 ? 'Choose A' : `Listening ${index + 1}`,
          options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
          answerKey: 'A',
          points: 1,
          difficulty: 'easy',
          cefrLevel: 'A1',
        })),
      },
    );
    const profile = await putProfile(context, {
      passScore: 60,
      components: canonicalComponents(context, {
        listening: {
          bankIds: [test.id],
          instructions: 'Snapshot me',
        },
      }),
    });
    expect(profile.status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    expect((db.prepare('SELECT placement_method FROM visitors WHERE id=?').get(context.visitorId) as any).placement_method).toBe('canonical_v1');

    const testRow = db.prepare('SELECT version FROM placement_tests WHERE id=?').get(test.id) as any;
    const edited = await supertest(context.app)
      .put(`/api/placement/test-bank/${test.id}`)
      .set(context.managerA)
      .send({
        version: testRow.version,
        questions: Array.from({ length: 20 }, (_, index) => ({
          key: `q${index + 1}`,
          qtype: 'mcq',
          prompt: index === 0 ? 'Changed prompt' : `Changed ${index + 1}`,
          options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
          answerKey: 'B',
          points: 1,
          difficulty: 'easy',
          cefrLevel: 'A1',
        })),
      });
    expect(edited.status).toBe(200);
    expect((await putProfile(context, { passScore: 90 })).status).toBe(200);
    await putFixedFeeRule(context, { feeType: 'placement', amount: 999, programVersionId: context.versionA });

    const snapshot = attemptSnapshot(started.body.id);
    const listening = snapshot.tests.find((row: any) => row.component_key === 'listening');
    const preserved = listening.questions.find((question: any) => question.prompt === 'Choose A');
    expect(snapshot.profile.passScore).toBe(60);
    expect(preserved).toBeDefined();
    expect(preserved.answer_key).toBe('A');
    expect(snapshot.billingTerms.baseFee).toBe(100);
    const operational = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.receptionistA);
    expect(JSON.stringify(operational.body.current)).not.toContain('answer_key');
  });

  it('starts component timers idempotently and refuses submissions before a required timer starts', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      components: canonicalComponents(context, { listening: { timeLimitSeconds: 120, durationMinutes: 2 } }),
    })).status).toBe(200);
    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    const listening = componentTest(started.body.id, 'listening');
    const responseUrl = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/responses`;
    const premature = await supertest(context.app)
      .put(responseUrl)
      .set(context.receptionistA)
      .send({ answers: [{ questionKey: listening.questions[0].question_key, response: 'A' }] });
    expect(premature.status).toBe(409);
    const timerUrl = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/start`;
    const first = await supertest(context.app).put(timerUrl).set(context.receptionistA).send({});
    const second = await supertest(context.app).put(timerUrl).set(context.receptionistA).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.startedAt).toBe(first.body.startedAt);
    expect(second.body.deadlineAt).toBe(first.body.deadlineAt);
  });

  it('validates typed answers atomically and recovers saved responses after retry', async () => {
    const context = seedContext();
    const test = await createActiveTest(context, {
      testType: 'reading',
      questions: [
        { key: 'q1', qtype: 'mcq', prompt: 'One', options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], answerKey: 'A', points: 1, difficulty: 'easy', cefrLevel: 'A1' },
        { key: 'q2', qtype: 'short_answer', prompt: 'Two', answerKey: 'yes', points: 1, difficulty: 'easy', cefrLevel: 'A1' },
        ...Array.from({ length: 18 }, (_, index) => ({
          key: `q${index + 3}`,
          qtype: 'mcq',
          prompt: `Extra ${index + 3}`,
          options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }],
          answerKey: 'A',
          points: 1,
          difficulty: 'easy',
          cefrLevel: 'A1',
        })),
      ],
    });
    expect((await putProfile(context, {
      components: canonicalComponents(context, {
        reading: {
          bankIds: [test.id],
          blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq', 'short_answer'] }],
        },
      }),
    })).status).toBe(200);
    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    await startTimer(context, started.body.id, 'reading');
    const reading = componentTest(started.body.id, 'reading');
    const mcq = reading.questions.find((question: any) => question.qtype === 'mcq');
    const shortAnswer = reading.questions.find((question: any) => question.qtype === 'short_answer');
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/reading/responses`;
    const bad = await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({ answers: [
        { questionKey: mcq.question_key, response: 'A' },
        { questionKey: 'missing', response: 'x' },
      ] });
    expect(bad.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) c FROM placement_assessment_responses WHERE attempt_id=?').get(started.body.id) as any).c).toBe(0);

    const partial = await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({ answers: [{ questionKey: mcq.question_key, response: 'A' }] });
    expect(partial.status).toBe(200);
    expect(partial.body.complete).toBe(false);
    const retry = await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({
        answers: reading.questions
          .filter((question: any) => question.question_key !== mcq.question_key)
          .map((question: any) => ({
            questionKey: question.question_key,
            response: question.qtype === 'short_answer' ? ' YES ' : 'A',
          })),
      });
    expect(retry.status).toBe(200);
    expect(retry.body.complete).toBe(true);
    expect(retry.body.responses).toHaveLength(20);
    expect(retry.body.autoScore).toBe(20);
    expect(retry.body.responses.find((row: any) => row.questionKey === shortAnswer.question_key)?.response).toBe('YES');
  });

  it('requires speaking responses to reference branch-correlated audio media rather than arbitrary files', async () => {
    const context = seedContext();
    expect((await putProfile(context)).status).toBe(200);
    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    await startTimer(context, started.body.id, 'speaking');
    const speaking = componentTest(started.body.id, 'speaking');
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/speaking/responses`;
    expect((await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({ answers: [{ questionKey: speaking.questions[0].question_key, response: { audioMediaId: 'missing' } }] })).status).toBe(400);

    const imageId = `${context.key}_image`;
    const foreignAudioId = `${context.key}_foreign_audio`;
    db.prepare(`INSERT INTO placement_media (id,filename,mime,size_bytes,sha256,storage_path,kind,branch_id,created_by)
      VALUES (?,?,?,1,'x',?,'image',?,?)`).run(imageId, 'image.png', 'image/png', `${imageId}.png`, context.branchA, context.managerAId);
    db.prepare(`INSERT INTO placement_media (id,filename,mime,size_bytes,sha256,storage_path,kind,branch_id,created_by)
      VALUES (?,?,?,1,'x',?,'audio',?,?)`).run(foreignAudioId, 'audio.mp3', 'audio/mpeg', `${foreignAudioId}.mp3`, context.branchB, context.managerBId);
    expect((await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({ answers: [{ questionKey: speaking.questions[0].question_key, response: { audioMediaId: imageId } }] })).status).toBe(400);
    expect((await supertest(context.app)
      .put(url)
      .set(context.receptionistA)
      .send({ answers: [{ questionKey: speaking.questions[0].question_key, response: { audioMediaId: foreignAudioId } }] })).status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) c FROM placement_assessment_responses WHERE attempt_id=?').get(started.body.id) as any).c).toBe(0);
  });

  it('fails closed on component timeout and does not accept late responses', async () => {
    const context = seedContext();
    expect((await putProfile(context, {
      components: canonicalComponents(context, { listening: { timeLimitSeconds: 60, durationMinutes: 1 } }),
    })).status).toBe(200);
    const started = await startAttempt(context, context.receptionistA, { deliveryMode: 'DIGITAL' });
    const listening = componentTest(started.body.id, 'listening');
    expect((await startTimer(context, started.body.id, 'listening')).status).toBe(200);
    db.prepare("UPDATE placement_assessment_results SET deadline_at=datetime('now','-1 second') WHERE attempt_id=? AND component_key='listening'").run(started.body.id);
    const response = await submitDigitalAnswers(context, started.body.id, 'listening', [
      { questionKey: listening.questions[0].question_key, response: 'A' },
    ]);
    expect(response.status).toBe(409);
    const result = db.prepare("SELECT status,timeout_flag FROM placement_assessment_results WHERE attempt_id=? AND component_key='listening'").get(started.body.id) as any;
    expect(result).toMatchObject({ status: 'timed_out', timeout_flag: 1 });
  });

  it('does not extend wall-clock attempt expiry across pause and resume', async () => {
    const context = seedContext();
    expect((await putProfile(context, { expiresMinutes: 30 })).status).toBe(200);
    const started = await startAttempt(context);
    const before = (db.prepare('SELECT expires_at FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).expires_at;
    expect((await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/pause`)
      .set(context.managerA)
      .send({ reason: 'Break' })).status).toBe(200);
    db.prepare("UPDATE placement_assessment_attempts SET paused_at=datetime('now','-5 minutes') WHERE id=?").run(started.body.id);
    expect((await supertest(context.app)
      .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/resume`)
      .set(context.managerA)
      .send({})).status).toBe(200);
    const after = (db.prepare('SELECT expires_at FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).expires_at;
    expect(after).toBe(before);
  });

  it('lazily expires the overall attempt and atomically resets the visitor link', async () => {
    const context = seedContext();
    expect((await putProfile(context, { expiresMinutes: 30 })).status).toBe(200);
    const started = await startAttempt(context);
    db.prepare("UPDATE placement_assessment_attempts SET expires_at=datetime('now','-1 second') WHERE id=?").run(started.body.id);
    const view = await supertest(context.app).get(`/api/placement/visitors/${context.visitorId}/placement`).set(context.receptionistA);
    expect(view.status).toBe(200);
    expect(view.body.current).toBeNull();
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).status).toBe('expired');
    expect(db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId)).toMatchObject({
      placement_status: 'scheduled',
      current_placement_attempt_id: null,
    });
  });

  it('invalidates paused and in-progress attempts when the visitor program changes', async () => {
    for (const shouldPause of [false, true]) {
      const context = seedContext();
      expect((await putProfile(context)).status).toBe(200);
      const started = await startAttempt(context);
      if (shouldPause) {
        expect((await supertest(context.app)
          .post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/pause`)
          .set(context.managerA)
          .send({})).status).toBe(200);
      }
      const program = `${context.key}_new_program`;
      const version = `${context.key}_new_version`;
      db.prepare('INSERT INTO programs (id,name,branch_id) VALUES (?,?,?)').run(program, 'New program', context.branchA);
      db.prepare("INSERT INTO program_versions (id,program_id,version_label,status) VALUES (?,?,?,'published')").run(version, program, 'v1');
      const changed = await supertest(context.app)
        .patch(`/api/visitors/${context.visitorId}`)
        .set(context.receptionistA)
        .send({ programVersionId: version });
      expect(changed.status).toBe(200);
      expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).status).toBe('cancelled');
      expect(db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId)).toMatchObject({
        placement_status: 'not_started',
        current_placement_attempt_id: null,
      });
    }
  });
});
