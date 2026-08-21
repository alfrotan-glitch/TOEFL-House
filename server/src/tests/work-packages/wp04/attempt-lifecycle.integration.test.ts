import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { createActiveTest, putProfile, seedContext, startAttempt } from './fixtures.js';

function contentComponent(testId: string, overrides: Record<string, unknown> = {}) {
  return {
    key: 'listening', type: 'content_test', label: 'Listening', required: true,
    weight: 100, maxScore: 10, scoringMethod: 'auto', testType: 'listening', testId,
    ...overrides,
  };
}

describe('WP-04 placement attempt lifecycle, immutable workspace, and timing', () => {
  it('fails closed when no applicable policy exists and records an explicit optional waiver reason', async () => {
    const noPolicy = seedContext();
    const denied = await startAttempt(noPolicy);
    expect(denied.status).toBe(400);

    const optional = seedContext();
    expect((await putProfile(optional, { requirementMode: 'optional' })).status).toBe(200);
    const missingReason = await supertest(optional.app)
      .post(`/api/placement/visitors/${optional.visitorId}/placement/attempts`)
      .set(optional.receptionistA).send({ skip: true });
    expect(missingReason.status).toBe(400);
    const waived = await supertest(optional.app)
      .post(`/api/placement/visitors/${optional.visitorId}/placement/attempts`)
      .set(optional.receptionistA).send({ skip: true, reason: 'Candidate elected direct enrollment' });
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
      .set(context.receptionistA).send({ reason: 'Candidate unavailable' });
    expect(cancelled.status).toBe(200);
    const visitor = db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId) as any;
    expect(visitor).toMatchObject({ placement_status: 'scheduled', current_placement_attempt_id: null });
  });

  it('captures immutable policy, test content, answer keys, and billing terms at start', async () => {
    const context = seedContext();
    const test = await createActiveTest(context);
    const profile = await putProfile(context, { components: [contentComponent(test.id)], passScore: 60 });
    expect(profile.status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);
    expect((db.prepare('SELECT placement_method FROM visitors WHERE id=?').get(context.visitorId) as any).placement_method).toBe('content_test');

    const testRow = db.prepare('SELECT version FROM placement_tests WHERE id=?').get(test.id) as any;
    const edited = await supertest(context.app).put(`/api/placement/test-bank/${test.id}`).set(context.managerA).send({
      version: testRow.version,
      questions: [{ key: 'q1', qtype: 'mcq', prompt: 'Changed prompt', options: ['A', 'B'], answerKey: 'B', points: 10 }],
    });
    expect(edited.status).toBe(200);
    expect((await putProfile(context, { components: [contentComponent(test.id)], passScore: 90 })).status).toBe(200);
    await supertest(context.app).put(`/api/catalog/branch-profile/${context.branchA}`).set(context.owner).send({ placementTestFee: 999 });

    const raw = db.prepare('SELECT snapshot_json FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any;
    const snapshot = JSON.parse(raw.snapshot_json);
    expect(snapshot.profile.passScore).toBe(60);
    expect(snapshot.tests[0].questions[0].prompt).toBe('Choose A');
    expect(snapshot.tests[0].questions[0].answer_key).toBe('A');
    expect(snapshot.billingTerms.baseFee).toBe(100);
    const operational = await supertest(context.app).get(`/api/placement/visitors/${context.visitorId}/placement`).set(context.receptionistA);
    expect(JSON.stringify(operational.body.current)).not.toContain('answer_key');
  });

  it('starts component timers idempotently and refuses submissions before a required timer starts', async () => {
    const context = seedContext();
    const test = await createActiveTest(context);
    expect((await putProfile(context, { components: [contentComponent(test.id, { timeLimitSeconds: 120 })] })).status).toBe(200);
    const started = await startAttempt(context);
    const responseUrl = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/responses`;
    const premature = await supertest(context.app).put(responseUrl).set(context.receptionistA).send({ answers: [{ questionKey: 'q1', response: 'A' }] });
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
    const test = await createActiveTest(context, { questions: [
      { key: 'q1', qtype: 'mcq', prompt: 'One', options: ['A', 'B'], answerKey: 'A', points: 5 },
      { key: 'q2', qtype: 'short_answer', prompt: 'Two', answerKey: 'yes', points: 5 },
    ] });
    expect((await putProfile(context, { components: [contentComponent(test.id)] })).status).toBe(200);
    const started = await startAttempt(context);
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/responses`;
    const bad = await supertest(context.app).put(url).set(context.receptionistA).send({ answers: [
      { questionKey: 'q1', response: 'A' }, { questionKey: 'missing', response: 'x' },
    ] });
    expect(bad.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) c FROM placement_assessment_responses WHERE attempt_id=?').get(started.body.id) as any).c).toBe(0);

    const partial = await supertest(context.app).put(url).set(context.receptionistA).send({ answers: [{ questionKey: 'q1', response: 'A' }] });
    expect(partial.status).toBe(200);
    expect(partial.body.complete).toBe(false);
    const retry = await supertest(context.app).put(url).set(context.receptionistA).send({ answers: [{ questionKey: 'q2', response: ' YES ' }] });
    expect(retry.status).toBe(200);
    expect(retry.body.complete).toBe(true);
    expect(retry.body.responses).toHaveLength(2);
    expect(retry.body.autoScore).toBe(10);
  });

  it('requires speaking responses to reference branch-correlated audio media rather than arbitrary files', async () => {
    const context = seedContext();
    const test = await createActiveTest(context, {
      testType: 'speaking',
      questions: [{ key: 'speak', qtype: 'speaking', prompt: 'Speak', points: 10 }],
    });
    expect((await putProfile(context, { components: [{
      key: 'speaking', type: 'content_test', label: 'Speaking', required: true,
      weight: 100, maxScore: 10, scoringMethod: 'manual', testType: 'speaking', testId: test.id,
    }] })).status).toBe(200);
    const started = await startAttempt(context);
    const url = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/speaking/responses`;
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({
      answers: [{ questionKey: 'speak', response: { audioMediaId: 'missing' } }],
    })).status).toBe(400);

    const imageId = `${context.key}_image`;
    const foreignAudioId = `${context.key}_foreign_audio`;
    db.prepare(`INSERT INTO placement_media (id,filename,mime,size_bytes,sha256,storage_path,kind,branch_id,created_by)
      VALUES (?,?,?,1,'x',?,'image',?,?)`).run(imageId, 'image.png', 'image/png', `${imageId}.png`, context.branchA, context.managerAId);
    db.prepare(`INSERT INTO placement_media (id,filename,mime,size_bytes,sha256,storage_path,kind,branch_id,created_by)
      VALUES (?,?,?,1,'x',?,'audio',?,?)`).run(foreignAudioId, 'audio.mp3', 'audio/mpeg', `${foreignAudioId}.mp3`, context.branchB, context.managerBId);
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({
      answers: [{ questionKey: 'speak', response: { audioMediaId: imageId } }],
    })).status).toBe(400);
    expect((await supertest(context.app).put(url).set(context.receptionistA).send({
      answers: [{ questionKey: 'speak', response: { audioMediaId: foreignAudioId } }],
    })).status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) c FROM placement_assessment_responses WHERE attempt_id=?').get(started.body.id) as any).c).toBe(0);
  });

  it('fails closed on component timeout and does not accept late responses', async () => {
    const context = seedContext();
    const test = await createActiveTest(context);
    expect((await putProfile(context, { components: [contentComponent(test.id, { timeLimitSeconds: 60 })] })).status).toBe(200);
    const started = await startAttempt(context);
    const timerUrl = `/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/start`;
    expect((await supertest(context.app).put(timerUrl).set(context.receptionistA).send({})).status).toBe(200);
    db.prepare("UPDATE placement_assessment_results SET deadline_at=datetime('now','-1 second') WHERE attempt_id=? AND component_key='listening'").run(started.body.id);
    const response = await supertest(context.app)
      .put(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/tests/listening/responses`)
      .set(context.receptionistA).send({ answers: [{ questionKey: 'q1', response: 'A' }] });
    expect(response.status).toBe(409);
    const result = db.prepare("SELECT status,timeout_flag FROM placement_assessment_results WHERE attempt_id=? AND component_key='listening'").get(started.body.id) as any;
    expect(result).toMatchObject({ status: 'timed_out', timeout_flag: 1 });
  });

  it('does not extend wall-clock attempt expiry across pause and resume', async () => {
    const context = seedContext();
    expect((await putProfile(context, { expiresMinutes: 30 })).status).toBe(200);
    const started = await startAttempt(context);
    const before = (db.prepare('SELECT expires_at FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).expires_at;
    expect((await supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/pause`).set(context.managerA).send({ reason: 'Break' })).status).toBe(200);
    db.prepare("UPDATE placement_assessment_attempts SET paused_at=datetime('now','-5 minutes') WHERE id=?").run(started.body.id);
    expect((await supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/resume`).set(context.managerA).send({})).status).toBe(200);
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
      placement_status: 'scheduled', current_placement_attempt_id: null,
    });
  });

  it('invalidates paused and in-progress attempts when the visitor program changes', async () => {
    for (const shouldPause of [false, true]) {
      const context = seedContext();
      expect((await putProfile(context)).status).toBe(200);
      const started = await startAttempt(context);
      if (shouldPause) {
        expect((await supertest(context.app).post(`/api/placement/visitors/${context.visitorId}/placement/attempts/${started.body.id}/pause`).set(context.managerA).send({})).status).toBe(200);
      }
      const program = `${context.key}_new_program`;
      const version = `${context.key}_new_version`;
      db.prepare('INSERT INTO programs (id,name,branch_id) VALUES (?,?,?)').run(program, 'New program', context.branchA);
      db.prepare("INSERT INTO program_versions (id,program_id,version_label,status) VALUES (?,?,?,'published')").run(version, program, 'v1');
      const changed = await supertest(context.app).patch(`/api/visitors/${context.visitorId}`).set(context.receptionistA).send({ programVersionId: version });
      expect(changed.status).toBe(200);
      expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(started.body.id) as any).status).toBe('cancelled');
      expect(db.prepare('SELECT placement_status,current_placement_attempt_id FROM visitors WHERE id=?').get(context.visitorId)).toMatchObject({
        placement_status: 'not_started', current_placement_attempt_id: null,
      });
    }
  });
});
