import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { db } from '../../../db/connection.js';
import { createActiveTest, putProfile, seedContext, startAttempt } from './fixtures.js';

const question = (key = 'q1') => ({
  key,
  qtype: 'mcq',
  prompt: `Prompt ${key}`,
  options: ['A', 'B'],
  answerKey: 'A',
  points: 10,
});

describe('WP-04 test-bank, rubric, and media security boundary', () => {
  it('normalizes string MCQ options to canonical keyed objects', async () => {
    const context = seedContext();
    const created = await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
      title: 'Normalized', testType: 'listening', questions: [question()], sections: [],
    });
    expect(created.status).toBe(201);
    expect(created.body.questions[0].options).toEqual([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]);
    expect(JSON.parse((db.prepare('SELECT options_json FROM placement_test_questions WHERE test_id=?').get(created.body.id) as any).options_json))
      .toEqual([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]);
  });

  it('rejects malformed questions and section references before writing any content', async () => {
    const context = seedContext();
    const invalidQuestions = [
      [{ ...question(), answerKey: 'C' }],
      [{ ...question(), options: ['A', 'A'] }],
      [{ ...question(), points: 0 }],
      [{ ...question(), sectionKey: 'missing' }],
    ];
    for (const questions of invalidQuestions) {
      const response = await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
        title: 'Invalid', testType: 'listening', questions, sections: [],
      });
      expect(response.status).toBe(400);
    }
    expect((await supertest(context.app).post('/api/placement/test-bank').set(context.managerA)
      .send({ title: 'Invalid questions', testType: 'listening', questions: {}, sections: [] })).status).toBe(400);
    expect((await supertest(context.app).post('/api/placement/test-bank').set(context.managerA)
      .send({ title: 'Invalid sections', testType: 'listening', questions: [question()], sections: {} })).status).toBe(400);
  });

  it('requires CAS for test updates and lifecycle transitions', async () => {
    const context = seedContext();
    const created = await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
      title: 'CAS', testType: 'reading', questions: [question()], sections: [],
    });
    expect(created.status).toBe(201);
    expect((await supertest(context.app).put(`/api/placement/test-bank/${created.body.id}`).set(context.managerA).send({ title: 'No version' })).status).toBe(409);
    const updated = await supertest(context.app).put(`/api/placement/test-bank/${created.body.id}`).set(context.managerA).send({ version: created.body.version, title: 'Updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(created.body.version + 1);
    expect((await supertest(context.app).post(`/api/placement/test-bank/${created.body.id}/activate`).set(context.managerA).send({ version: created.body.version })).status).toBe(409);
  });

  it('preserves stable question ids for retained keys and deletes stale questions transactionally', async () => {
    const context = seedContext();
    const created = await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
      title: 'Question replacement', testType: 'reading', questions: [{ ...question('keep'), sectionKey: 'passage' }, question('remove')],
      sections: [{ key: 'passage', kind: 'passage', body: 'Read this.' }],
    });
    const before = db.prepare('SELECT id,question_key FROM placement_test_questions WHERE test_id=? ORDER BY question_key').all(created.body.id) as any[];
    const orphaning = await supertest(context.app).put(`/api/placement/test-bank/${created.body.id}`).set(context.managerA).send({
      version: created.body.version,
      sections: [{ key: 'replacement', kind: 'passage', body: 'Replacement.' }],
    });
    expect(orphaning.status).toBe(400);
    const updated = await supertest(context.app).put(`/api/placement/test-bank/${created.body.id}`).set(context.managerA).send({
      version: created.body.version,
      questions: [{ ...question('keep'), prompt: 'Revised' }, question('new')],
    });
    expect(updated.status).toBe(200);
    const after = db.prepare('SELECT id,question_key,prompt FROM placement_test_questions WHERE test_id=? ORDER BY question_key').all(created.body.id) as any[];
    expect(after.find((row) => row.question_key === 'keep').id).toBe(before.find((row) => row.question_key === 'keep').id);
    expect(after.some((row) => row.question_key === 'remove')).toBe(false);
    expect(after.find((row) => row.question_key === 'keep').prompt).toBe('Revised');
  });

  it('rejects cross-branch test mutation and answer-key preview by object id', async () => {
    const context = seedContext();
    const active = await createActiveTest(context);
    const preview = await supertest(context.app).get(`/api/placement/test-bank/${active.id}/preview`).set(context.managerB);
    expect(preview.status).toBe(403);
    const archive = await supertest(context.app).post(`/api/placement/test-bank/${active.id}/archive`).set(context.managerB).send({ version: active.version });
    expect(archive.status).toBe(403);
  });

  it('allows only an organization-scoped owner to mutate a global asset', async () => {
    const context = seedContext();
    const globalId = `${context.key}_global_test`;
    db.prepare(`INSERT INTO placement_tests (id,title,test_type,status,branch_id,version) VALUES (?,?,'reading','draft',NULL,1)`).run(globalId, 'Global');
    db.prepare(`INSERT INTO placement_test_questions (id,test_id,question_key,qtype,prompt,options_json,answer_key,points,order_index)
      VALUES (?,?,?,'mcq','Prompt','[{"key":"A","text":"A"},{"key":"B","text":"B"}]','A',10,0)`)
      .run(`${context.key}_gq`, globalId, 'q1');
    const denied = await supertest(context.app).put(`/api/placement/test-bank/${globalId}`).set(context.managerA).send({ version: 1, title: 'Manager write' });
    expect(denied.status).toBe(403);
    const allowed = await supertest(context.app).put(`/api/placement/test-bank/${globalId}`).set(context.owner).send({ version: 1, title: 'Owner write' });
    expect(allowed.status).toBe(200);
  });

  it('honors authorized explicit and all-branch list scopes', async () => {
    const context = seedContext();
    await createActiveTest(context, { branchId: context.branchA });
    await createActiveTest(context, { branchId: context.branchB }, context.owner);
    const branchA = await supertest(context.app).get(`/api/placement/test-bank?branchId=${context.branchA}`).set(context.managerA);
    expect(branchA.status).toBe(200);
    expect(branchA.body.some((row: any) => row.branchId === context.branchB)).toBe(false);
    const all = await supertest(context.app).get('/api/placement/test-bank?branchId=all').set(context.owner);
    expect(all.status).toBe(200);
    expect(all.body.some((row: any) => row.branchId === context.branchA)).toBe(true);
    expect(all.body.some((row: any) => row.branchId === context.branchB)).toBe(true);
  });

  it('enforces rubric validation, CAS, branch mutation, and test/rubric scope correlation', async () => {
    const context = seedContext();
    const invalid = await supertest(context.app).post('/api/placement/rubrics').set(context.managerA).send({
      title: 'Bad', kind: 'writing', criteria: [{ key: 'x', label: 'X', weight: 90, maxScore: 5 }],
    });
    expect(invalid.status).toBe(400);
    const rubric = await supertest(context.app).post('/api/placement/rubrics').set(context.managerA).send({
      title: 'Writing', kind: 'writing', criteria: [{ key: 'content', label: 'Content', weight: 100, maxScore: 5 }],
    });
    expect(rubric.status).toBe(201);
    expect((await supertest(context.app).put(`/api/placement/rubrics/${rubric.body.id}`).set(context.managerA).send({ title: 'No CAS' })).status).toBe(409);
    expect((await supertest(context.app).put(`/api/placement/rubrics/${rubric.body.id}`).set(context.managerB).send({ version: 1, title: 'Foreign' })).status).toBe(403);
    expect((await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
      title: 'Wrong kind', testType: 'speaking', rubricId: rubric.body.id,
      questions: [{ key: 'spoken', qtype: 'speaking', prompt: 'Speak', points: 10 }], sections: [],
    })).status).toBe(400);
    const linked = await supertest(context.app).post('/api/placement/test-bank').set(context.managerA).send({
      title: 'Linked writing', testType: 'writing', rubricId: rubric.body.id,
      questions: [{ key: 'essay', qtype: 'essay', prompt: 'Write', points: 10 }], sections: [],
    });
    expect(linked.status).toBe(201);
    expect((await supertest(context.app).put(`/api/placement/rubrics/${rubric.body.id}`).set(context.managerA)
      .send({ version: rubric.body.version, kind: 'speaking' })).status).toBe(409);
    const correlated = await supertest(context.app).post('/api/placement/test-bank').set(context.owner).send({
      title: 'Wrong scope', testType: 'writing', branchId: context.branchB, rubricId: rubric.body.id,
      questions: [{ key: 'essay', qtype: 'essay', prompt: 'Write', points: 10 }], sections: [],
    });
    expect(correlated.status).toBe(400);
  });

  it('rejects media MIME spoofing and confines stored paths before file access', async () => {
    const context = seedContext();
    const spoofed = await supertest(context.app)
      .post('/api/placement/media/upload')
      .set(context.managerA)
      .set('Content-Type', 'audio/mpeg')
      .send(Buffer.from('not an mp3'));
    expect(spoofed.status).toBe(415);

    const mediaId = `${context.key}_media`;
    db.prepare(`INSERT INTO placement_media
      (id,filename,mime,size_bytes,sha256,storage_path,kind,branch_id,created_by)
      VALUES (?,?, 'audio/mpeg',1,'x','../outside.mp3','audio',?,?)`)
      .run(mediaId, 'outside.mp3', context.branchA, context.managerAId);
    const escaped = await supertest(context.app).get(`/api/placement/media/${mediaId}/file`).set(context.managerA);
    expect(escaped.status).toBe(409);
    const foreign = await supertest(context.app).get(`/api/placement/media/${mediaId}/file`).set(context.managerB);
    expect(foreign.status).toBe(403);
  });

  it('keeps answer keys on the authoring surface but removes them from operational attempt projections', async () => {
    const context = seedContext();
    const test = await createActiveTest(context);
    const profile = await putProfile(context, {
      components: [{
        key: 'listening', type: 'content_test', label: 'Listening', required: true,
        weight: 100, maxScore: 10, scoringMethod: 'auto', testType: 'listening', testId: test.id,
      }],
    });
    expect(profile.status).toBe(200);
    const started = await startAttempt(context);
    expect(started.status).toBe(201);

    const preview = await supertest(context.app).get(`/api/placement/test-bank/${test.id}/preview`).set(context.managerA);
    expect(preview.body.questions[0].answerKey).toBe('A');
    const current = await supertest(context.app)
      .get(`/api/placement/visitors/${context.visitorId}/placement`)
      .set(context.receptionistA);
    expect(current.status).toBe(200);
    expect(JSON.stringify(current.body.current)).not.toContain('answer_key');
    expect(current.body.current.snapshot.tests[0].questions[0].prompt).toBe('Choose A');
  });
});
