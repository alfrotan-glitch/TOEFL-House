/**
 * Placement Engine extensions — speaking audio responses, rubric-driven
 * manual scoring, expiry maintenance sweep.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import visitorsRouter from '../routes/visitors.routes.js';
import placementRouter from '../routes/placement.routes.js';
import academicRouter from '../routes/academic.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'ext_lifecycle_branch';
const BRANCH_B = 'ext_lifecycle_branch_b';
const PROGRAM = 'ext_lifecycle_program';
const VERSION = 'ext_lifecycle_version';
const LEVEL_A1 = 'ext_lifecycle_a1';
const LEVEL_B1 = 'ext_lifecycle_b1';
const OWNER = 'ext_lifecycle_owner';
const MANAGER = 'ext_lifecycle_manager';
const MANAGER_B = 'ext_lifecycle_manager_b';
const REGISTRAR = 'ext_lifecycle_registrar';

let SPEAKING_TEST = '';
let WRITING_TEST = '';
let RUBRIC_ID = '';
let MEDIA_ID = '';
let MEDIA_B_ID = '';

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  return app;
};
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const makeVisitor = (idv: string, serial: string) => {
  db.prepare(`DELETE FROM visitors WHERE id = ?`).run(idv);
  db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Ext Candidate', '0700000300', 'male', 'social', ?, 'visited', ?, 'Ext Program', ?, 'not_started')`)
    .run(idv, serial, today(), BRANCH, VERSION);
};

describe('Placement Engine extensions (speaking audio, rubric scoring, expiry sweep)', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let manager: TokenPayload;
  let managerB: TokenPayload;
  let registrar: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'Ext Branch', 'T');
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH_B, 'Ext Branch B', 'T');
    for (const [u, username, role, branch] of [
      [OWNER, 'ext-owner', 'owner', BRANCH],
      [MANAGER, 'ext-manager', 'manager', BRANCH],
      [MANAGER_B, 'ext-manager-b', 'manager', BRANCH_B],
      [REGISTRAR, 'ext-registrar', 'registrar', BRANCH],
    ] as const) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(u, username, 'Ext User', role, branch, await hashPassword('testpass123'));
    }
    syncLegacyUserRoles(db);
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`).run(PROGRAM, 'Ext Program', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1', 1, ?, 'A1', 1)`).run(LEVEL_A1, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 2, ?, 'B1', 1)`).run(LEVEL_B1, PROGRAM, VERSION);
    owner = { userId: OWNER, username: 'ext-owner', role: 'owner', branchId: BRANCH, fullName: 'Ext Owner' };
    manager = { userId: MANAGER, username: 'ext-manager', role: 'manager', branchId: BRANCH, fullName: 'Ext Manager' };
    managerB = { userId: MANAGER_B, username: 'ext-manager-b', role: 'manager', branchId: BRANCH_B, fullName: 'Ext Manager B' };
    registrar = { userId: REGISTRAR, username: 'ext-registrar', role: 'registrar', branchId: BRANCH, fullName: 'Ext Registrar' };
    app = createApp();

    // Media: one in branch A, one in branch B.
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
    const upA = await supertest(app).post('/api/placement/media/upload').set(authHeader(manager)).set('Content-Type', 'audio/webm').send(buf);
    MEDIA_ID = upA.body.id;
    const upB = await supertest(app).post('/api/placement/media/upload').set(authHeader(managerB)).set('Content-Type', 'audio/webm').send(buf);
    MEDIA_B_ID = upB.body.id;

    // Speaking test (prompt block + speaking question).
    const speaking = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: 'Ext Speaking', testType: 'speaking', instructions: 'Record your answer.',
      sections: [{ key: 'sp', kind: 'prompt_block', title: 'Speak about your hometown', body: 'Describe your hometown.' }],
      questions: [{ key: 's1', qtype: 'speaking', prompt: 'Speak for 60 seconds about your hometown.', points: 20, sectionKey: 'sp' }],
    });
    SPEAKING_TEST = speaking.body.id;
    await supertest(app).post(`/api/placement/test-bank/${SPEAKING_TEST}/activate`).set(authHeader(owner));

    // Writing test with rubric.
    const rubric = await supertest(app).post('/api/placement/rubrics').set(authHeader(owner)).send({
      title: 'Ext Essay Rubric', kind: 'writing',
      criteria: [{ key: 'content', label: 'Content', weight: 60, maxScore: 10 }, { key: 'language', label: 'Language', weight: 40, maxScore: 10 }],
    });
    RUBRIC_ID = rubric.body.id;
    const writing = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: 'Ext Writing', testType: 'writing', rubricId: RUBRIC_ID,
      questions: [
        { key: 'w1', qtype: 'essay', prompt: 'Write about your city.', points: 20 },
        { key: 'w2', qtype: 'mcq', prompt: 'Synonym of happy?', options: [{ key: 'A', text: 'sad' }, { key: 'B', text: 'joyful' }], answerKey: 'B', points: 5 },
      ],
    });
    WRITING_TEST = writing.body.id;
    await supertest(app).post(`/api/placement/test-bank/${WRITING_TEST}/activate`).set(authHeader(owner));
  });

  it('speaking answer attaches a validated audio media reference; invalid/cross-branch media rejected', async () => {
    makeVisitor('ext_v_speak', 'V-30001');
    await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60,
      components: [{ key: 'speak', type: 'content_test', label: 'Speaking', required: true, weight: 100, maxScore: 100, testId: SPEAKING_TEST }],
    });
    const start = await supertest(app).post(`/api/placement/visitors/ext_v_speak/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;

    const invalid = await supertest(app).put(`/api/placement/visitors/ext_v_speak/placement/attempts/${attemptId}/tests/speak/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 's1', response: { audioMediaId: 'pmd_nope' } }] });
    expect(invalid.status).toBe(400);

    const crossBranch = await supertest(app).put(`/api/placement/visitors/ext_v_speak/placement/attempts/${attemptId}/tests/speak/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 's1', response: { audioMediaId: MEDIA_B_ID } }] });
    expect(crossBranch.status).toBe(403);

    const ok = await supertest(app).put(`/api/placement/visitors/ext_v_speak/placement/attempts/${attemptId}/tests/speak/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 's1', response: { audioMediaId: MEDIA_ID } }] });
    expect(ok.status).toBe(200);
    expect(ok.body.complete).toBe(false); // speaking is manual — stays pending
    const row = db.prepare(`SELECT response_json FROM placement_assessment_responses WHERE attempt_id=? AND question_key='s1'`).get(attemptId) as any;
    expect(JSON.parse(row.response_json).audioMediaId).toBe(MEDIA_ID);
    // Manual score completes it.
    const manual = await supertest(app).put(`/api/placement/visitors/ext_v_speak/placement/attempts/${attemptId}/components/speak`).set(authHeader(owner)).send({ manualScore: 16, resultText: 'Good fluency.' });
    expect(manual.status).toBe(200);
    const completed = manual.body.find((r: any) => r.component_key === 'speak');
    expect(completed.status).toBe('completed');
    expect(completed.score).toBe(80); // 16/20 → 80/100
  });

  it('rubric-driven manual scoring: criteriaScores weighted → manual score; validation enforced', async () => {
    makeVisitor('ext_v_write', 'V-30002');
    await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60,
      components: [{ key: 'write', type: 'content_test', label: 'Writing', required: true, weight: 100, maxScore: 100, testId: WRITING_TEST }],
    });
    const start = await supertest(app).post(`/api/placement/visitors/ext_v_write/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/ext_v_write/placement/attempts/${attemptId}/tests/write/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 'w1', response: 'My city...' }, { questionKey: 'w2', response: 'B' }] });

    // Missing criterion → 400.
    const missing = await supertest(app).put(`/api/placement/visitors/ext_v_write/placement/attempts/${attemptId}/components/write`).set(authHeader(owner)).send({ criteriaScores: { content: 8 }, resultText: 'x' });
    expect(missing.status).toBe(400);
    // Criterion above max → 400.
    const over = await supertest(app).put(`/api/placement/visitors/ext_v_write/placement/attempts/${attemptId}/components/write`).set(authHeader(owner)).send({ criteriaScores: { content: 8, language: 11 }, resultText: 'x' });
    expect(over.status).toBe(400);
    // content 8/10 (60%) + language 6/10 (40%) → 0.8*60 + 0.6*40 = 72% → manual 0.72*20 = 14.4 → auto 5 + 14.4 = 19.4/25 → 77.6/100.
    const ok = await supertest(app).put(`/api/placement/visitors/ext_v_write/placement/attempts/${attemptId}/components/write`).set(authHeader(owner)).send({ criteriaScores: { content: 8, language: 6 }, resultText: 'Good structure.' });
    expect(ok.status).toBe(200);
    const result = ok.body.find((r: any) => r.component_key === 'write');
    expect(result.status).toBe('completed');
    expect(result.score).toBe(77.6);
    const payload = JSON.parse(result.payload_json);
    expect(payload.criteriaScores).toEqual({ content: 8, language: 6 });
    expect(payload.manualScore).toBe(14.4);
    // Profile read view exposes the rubric for the UI.
    const view = await supertest(app).get(`/api/placement/visitors/ext_v_write/placement`).set(authHeader(owner));
    const contentTest = view.body.profile.contentTests.find((t: any) => t.id === WRITING_TEST);
    expect(contentTest.rubric.criteria).toHaveLength(2);
  });

  it('expiry maintenance sweep marks overdue attempts expired and resets visitors; registrar denied', async () => {
    makeVisitor('ext_v_expire', 'V-30003');
    await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, expiresMinutes: 60, maxScore: 100, passScore: 60,
      components: [{ key: 'write', type: 'content_test', label: 'Writing', required: true, weight: 100, maxScore: 100, testId: WRITING_TEST }],
    });
    const start = await supertest(app).post(`/api/placement/visitors/ext_v_expire/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    db.prepare(`UPDATE placement_assessment_attempts SET expires_at=datetime('now','-1 minute') WHERE id=?`).run(attemptId);
    const denied = await supertest(app).post('/api/placement/maintenance/expire').set(authHeader(registrar));
    expect(denied.status).toBe(403);
    const sweep = await supertest(app).post('/api/placement/maintenance/expire').set(authHeader(owner));
    expect(sweep.status).toBe(200);
    expect(sweep.body.expired).toBeGreaterThanOrEqual(1);
    const row = db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any;
    expect(row.status).toBe('expired');
    // A PAUSED attempt past its expiry is also swept (pause does not extend the overall deadline).
    makeVisitor('ext_v_expire_paused', 'V-30004');
    const startP = await supertest(app).post(`/api/placement/visitors/ext_v_expire_paused/placement/attempts`).set(authHeader(owner)).send({});
    const pausedAttempt = startP.body.id;
    await supertest(app).post(`/api/placement/visitors/ext_v_expire_paused/placement/attempts/${pausedAttempt}/pause`).set(authHeader(manager)).send({ reason: 'x' });
    db.prepare(`UPDATE placement_assessment_attempts SET expires_at=datetime('now','-1 minute') WHERE id=?`).run(pausedAttempt);
    const sweep2 = await supertest(app).post('/api/placement/maintenance/expire').set(authHeader(owner));
    expect(sweep2.status).toBe(200);
    const pausedRow = db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(pausedAttempt) as any;
    expect(pausedRow.status).toBe('expired');
    const visitor = db.prepare(`SELECT placement_status, current_placement_attempt_id FROM visitors WHERE id='ext_v_expire'`).get() as any;
    expect(visitor.placement_status).toBe('not_started');
    expect(visitor.current_placement_attempt_id).toBeNull();
    // Report now distinguishes expired attempts.
    const report = await supertest(app).get('/api/placement/report?from=2000-01-01&to=2100-01-01').set(authHeader(owner));
    expect(report.body.byAttemptStatus.some((r: any) => r.status === 'expired' && r.c > 0)).toBe(true);
  });
});
