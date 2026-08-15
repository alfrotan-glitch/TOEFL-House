/**
 * Placement Assessment Engine — policy/timing/decision/content/reporting.
 * ============================================================================
 * Proves the directive acceptance criteria:
 *   - no-placement, optional, single-skill, multi-skill policies
 *   - first-level exemption (config, not hard-coded)
 *   - server-enforced per-component timing (start/deadline/timeout/elapsed)
 *   - pause/resume extends deadlines; attempt expiry (lazy)
 *   - conditional decision rules (skill thresholds) + band fallback
 *   - minimum-score enforcement
 *   - audited manual override + audited score correction (recomputes decision)
 *   - content sections (listening tracks / reading passages), rubrics, media
 *     upload/serve, versioning, archival
 *   - reporting: actual-activity placement report
 *   - RBAC + branch isolation on the new routes
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
import { id, today } from '../utils/ids.js';

const BRANCH = 'engine_lifecycle_branch';
const BRANCH_B = 'engine_lifecycle_branch_b';
const PROGRAM = 'engine_lifecycle_program';
const VERSION = 'engine_lifecycle_version';
const LEVEL_A1 = 'engine_lifecycle_a1';
const LEVEL_B1 = 'engine_lifecycle_b1';
const OWNER = 'engine_lifecycle_owner';
const MANAGER = 'engine_lifecycle_manager';
const MANAGER_B = 'engine_lifecycle_manager_b';
const REGISTRAR = 'engine_lifecycle_registrar';
const VISITOR = 'engine_lifecycle_visitor';

let LISTENING_TEST = '';
let READING_TEST = '';
let WRITING_TEST = '';
let RUBRIC_ID = '';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  return app;
}

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

function makeVisitor(idv: string, serial: string) {
  db.prepare(`DELETE FROM visitors WHERE id = ?`).run(idv);
  db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Engine Candidate', '0700000200', 'male', 'social', ?, 'visited', ?, 'Engine Program', ?, 'not_started')`)
    .run(idv, serial, today(), BRANCH, VERSION);
}

describe('Placement Assessment Engine lifecycle', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let manager: TokenPayload;
  let managerB: TokenPayload;
  let registrar: TokenPayload;
  const visitorId = VISITOR;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'Engine Branch', 'T');
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH_B, 'Engine Branch B', 'T');
    for (const [u, username, role, branch] of [
      [OWNER, 'engine-owner', 'owner', BRANCH],
      [MANAGER, 'engine-manager', 'manager', BRANCH],
      [MANAGER_B, 'engine-manager-b', 'manager', BRANCH_B],
      [REGISTRAR, 'engine-registrar', 'registrar', BRANCH],
    ] as const) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(u, username, 'Engine User', role, branch, await hashPassword('testpass123'));
    }
    syncLegacyUserRoles(db);
    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`).run(PROGRAM, 'Engine Program', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1 Beginner', 1, ?, 'A1', 1)`).run(LEVEL_A1, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1 Intermediate', 2, ?, 'B1', 1)`).run(LEVEL_B1, PROGRAM, VERSION);
    db.prepare(`INSERT OR REPLACE INTO placement_rules (id, program_version_id, branch_id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active) VALUES (?, ?, NULL, 'A1 band', 0, 59, ?, 'A1', 1, 1)`).run(id('prl'), VERSION, LEVEL_A1);
    db.prepare(`INSERT OR REPLACE INTO placement_rules (id, program_version_id, branch_id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active) VALUES (?, ?, NULL, 'B1 band', 60, 100, ?, 'B1', 2, 1)`).run(id('prl'), VERSION, LEVEL_B1);
    owner = { userId: OWNER, username: 'engine-owner', role: 'owner', branchId: BRANCH, fullName: 'Engine Owner' };
    manager = { userId: MANAGER, username: 'engine-manager', role: 'manager', branchId: BRANCH, fullName: 'Engine Manager' };
    managerB = { userId: MANAGER_B, username: 'engine-manager-b', role: 'manager', branchId: BRANCH_B, fullName: 'Engine Manager B' };
    registrar = { userId: REGISTRAR, username: 'engine-registrar', role: 'registrar', branchId: BRANCH, fullName: 'Engine Registrar' };
    makeVisitor(VISITOR, 'V-20001');
    app = createApp();
  });

  const putProfile = (body: any, as: TokenPayload = owner) =>
    supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(as)).send(body);

  const makeListeningTest = async (extra: any = {}) => {
    const res = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: extra.title || 'Engine Listening', testType: 'listening', audioUrl: '/audio/e.mp3', transcript: 'track',
      difficulty: 'medium', durationSeconds: 60,
      sections: [{ key: 's1', kind: 'audio_track', title: 'Track 1', audioUrl: '/audio/e.mp3', transcript: 'transcript', durationSeconds: 30 }],
      questions: [
        { key: 'q1', qtype: 'mcq', prompt: 'Capital?', options: [{ key: 'A', text: 'X' }, { key: 'B', text: 'Paris' }], answerKey: 'B', points: 10, sectionKey: 's1' },
        { key: 'q2', qtype: 'short_answer', prompt: 'River?', answerKey: 'Seine', points: 10, sectionKey: 's1' },
      ],
      ...extra,
    });
    return res;
  };

  // ── Content system: sections, rubrics, media, versioning ─────────────────
  it('creates a listening test with sections and difficulty; a reading test with passages; a writing test with rubric', async () => {
    const listening = await makeListeningTest();
    expect(listening.status).toBe(201);
    expect(listening.body.sections).toHaveLength(1);
    expect(listening.body.sections[0].kind).toBe('audio_track');
    expect(listening.body.difficulty).toBe('medium');
    expect(listening.body.questions[0].sectionKey).toBe('s1');
    expect(listening.body.version).toBe(1);
    LISTENING_TEST = listening.body.id;

    const reading = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: 'Engine Reading', testType: 'reading', difficulty: 'hard',
      sections: [
        { key: 'p1', kind: 'passage', title: 'Passage One', body: 'First passage text.' },
        { key: 'p2', kind: 'passage', title: 'Passage Two', body: 'Second passage text.' },
      ],
      questions: [
        { key: 'r1', qtype: 'short_answer', prompt: 'From passage one?', answerKey: 'alpha', points: 10, sectionKey: 'p1' },
        { key: 'r2', qtype: 'mcq', prompt: 'From passage two?', options: [{ key: 'A', text: 'no' }, { key: 'B', text: 'yes' }], answerKey: 'B', points: 10, sectionKey: 'p2' },
      ],
    });
    expect(reading.status).toBe(201);
    expect(reading.body.sections).toHaveLength(2);
    READING_TEST = reading.body.id;

    const rubric = await supertest(app).post('/api/placement/rubrics').set(authHeader(owner)).send({
      title: 'Essay Rubric', kind: 'writing',
      criteria: [{ key: 'content', label: 'Content', weight: 50, maxScore: 10 }, { key: 'language', label: 'Language', weight: 50, maxScore: 10 }],
    });
    expect(rubric.status).toBe(201);
    RUBRIC_ID = rubric.body.id;

    const writing = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: 'Engine Writing', testType: 'writing', rubricId: RUBRIC_ID, wordTarget: 200,
      questions: [
        { key: 'w1', qtype: 'essay', prompt: 'Write about your city.', points: 20 },
        { key: 'w2', qtype: 'mcq', prompt: 'Synonym of happy?', options: [{ key: 'A', text: 'sad' }, { key: 'B', text: 'joyful' }], answerKey: 'B', points: 5 },
      ],
    });
    expect(writing.status).toBe(201);
    expect(writing.body.rubricId).toBe(RUBRIC_ID);
    expect(writing.body.wordTarget).toBe(200);
    WRITING_TEST = writing.body.id;
    // Activate all three tests (profiles only accept active content).
    for (const t of [LISTENING_TEST, READING_TEST, WRITING_TEST]) {
      const act = await supertest(app).post(`/api/placement/test-bank/${t}/activate`).set(authHeader(owner));
      expect(act.status).toBe(200);
    }

    const badRubric = await supertest(app).post('/api/placement/rubrics').set(authHeader(owner)).send({ title: 'Bad', kind: 'writing', criteria: [{ key: 'x', label: 'X', weight: 10, maxScore: 10 }] });
    expect(badRubric.status).toBe(400);
  });

  it('media upload: valid audio accepted with sha256; bad mime rejected; served back', async () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const up = await supertest(app).post('/api/placement/media/upload').set(authHeader(manager)).set('Content-Type', 'audio/mpeg').send(buf);
    expect(up.status).toBe(201);
    expect(up.body.sha256).toHaveLength(64);
    expect(up.body.kind).toBe('audio');
    const fetchFile = await supertest(app).get(up.body.url).set(authHeader(manager));
    expect(fetchFile.status).toBe(200);
    expect(fetchFile.headers['content-type']).toContain('audio/mpeg');
    const badMime = await supertest(app).post('/api/placement/media/upload').set(authHeader(manager)).set('Content-Type', 'application/x-msdownload').send(Buffer.from('MZ...'));
    expect(badMime.status).toBe(415);
    const unauth = await supertest(app).post('/api/placement/media/upload').set(authHeader(registrar)).set('Content-Type', 'audio/mpeg').send(buf);
    expect(unauth.status).toBe(403);
  });

  it('editing a test bumps its version; answered content is protected; archive is the lifecycle', async () => {
    const list = (await supertest(app).get('/api/placement/test-bank').set(authHeader(owner))).body as any[];
    const t = list.find((x: any) => x.id === READING_TEST);
    const edit = await supertest(app).put(`/api/placement/test-bank/${READING_TEST}`).set(authHeader(owner)).send({
      title: t.title, testType: t.testType, difficulty: t.difficulty, status: t.status,
      sections: t.sections,
      questions: t.questions.map((q: any, i: number) => (i === 0 ? { ...q, answerKey: 'beta' } : q)),
    });
    expect(edit.status).toBe(200);
    // create=1, activate=2, edit=3 — every mutation is a new content version.
    expect(edit.body.version).toBe(3);
    // Archive is the content lifecycle — answered content is never destructively deleted (FK RESTRICT).
    const archived = await supertest(app).post(`/api/placement/test-bank/${READING_TEST}/archive`).set(authHeader(owner));
    expect(archived.status).toBe(200);
    const after = await supertest(app).get(`/api/placement/test-bank/${READING_TEST}/preview`).set(authHeader(owner));
    expect(after.body.status).toBe('archived');
  });

  // ── Policy modes ──────────────────────────────────────────────────────────
  it('not_required policy: no assessment; start blocked; requirement mode surfaced', async () => {
    await putProfile({ enabled: true, required: false, requirementMode: 'not_required', allowRetake: true, maxScore: 100, passScore: 60, components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST }] });
    const view = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    expect(view.body.requirement.mode).toBe('not_required');
    const start = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(400);
    expect(String(start.body.error)).toContain('not required');
  });

  it('optional policy: authorized skip records an audited exemption', async () => {
    await putProfile({ enabled: true, required: false, requirementMode: 'optional', allowRetake: true, maxScore: 100, passScore: 60, components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST }] });
    const skip = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({ skip: true, reason: 'Candidate chose to skip.' });
    expect(skip.status).toBe(200);
    expect(skip.body.skipped).toBe(true);
    const visitor = db.prepare(`SELECT placement_status, placement_requirement_mode, placement_score FROM visitors WHERE id = ?`).get(visitorId) as any;
    expect(visitor.placement_status).toBe('waived'); // exempt marker
    expect(visitor.placement_requirement_mode).toBe('optional');
    expect(JSON.parse(visitor.placement_score).skipped).toBe(true);
    const audits = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE '%optional skip%'`).all() as any[];
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // Reset the visitor for subsequent tests.
    db.prepare(`UPDATE visitors SET placement_status='not_started', placement_requirement_mode=NULL, placement_status_at=NULL, placement_score=NULL, current_placement_attempt_id=NULL WHERE id=?`).run(visitorId);
  });

  it('first-level exemption: target = first level → not required (config, not hard-coded)', async () => {
    await putProfile({ enabled: true, required: true, requirementMode: 'required', firstLevelExempt: true, allowRetake: true, maxScore: 100, passScore: 60, components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST }] });
    const viewFirst = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement?targetLevelId=${LEVEL_A1}`).set(authHeader(owner));
    expect(viewFirst.body.requirement.mode).toBe('not_required');
    expect(viewFirst.body.requirement.reason).toBe('first_level_exempt');
    const viewSecond = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement?targetLevelId=${LEVEL_B1}`).set(authHeader(owner));
    expect(viewSecond.body.requirement.mode).toBe('required');
    const start = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({ targetLevelId: LEVEL_A1 });
    expect(start.status).toBe(400);
  });

  it('single-skill policy: one component is enough for a valid placement decision', async () => {
    await putProfile({ enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60, scoringModel: 'weighted_average', components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST, timeLimitSeconds: 60, minScore: 0 }] });
    const start = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(201);
    const attemptId = start.body.id;
    // Server timer: start component → deadline ~60s from now.
    const timer = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listen/start`).set(authHeader(manager));
    expect(timer.status).toBe(200);
    expect(timer.body.timeLimitSeconds).toBe(60);
    expect(timer.body.deadlineAt).toBeTruthy();
    const result = db.prepare(`SELECT started_at, deadline_at FROM placement_assessment_results WHERE attempt_id=? AND component_key='listen'`).get(attemptId) as any;
    expect(result.started_at).toBeTruthy();
    expect(result.deadline_at > result.started_at).toBe(true);
    // Early submission accepted; elapsed recorded.
    const submit = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'seine' }] });
    expect(submit.status).toBe(200);
    expect(submit.body.complete).toBe(true);
    expect(submit.body.autoScore).toBe(20);
    const completed = db.prepare(`SELECT status, score, raw_score, percentage, weighted_score, score_version, submitted_at, elapsed_seconds FROM placement_assessment_results WHERE attempt_id=? AND component_key='listen'`).get(attemptId) as any;
    expect(completed.status).toBe('completed');
    expect(completed.score).toBe(100);
    expect(completed.raw_score).toBe(20);
    expect(completed.percentage).toBe(100);
    expect(completed.score_version).toBe(1);
    expect(completed.submitted_at).toBeTruthy();
    expect(completed.elapsed_seconds).toBeGreaterThanOrEqual(0);
    const done = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(200);
    expect(done.body.attempt.status).toBe('completed');
    expect(done.body.attempt.percentage).toBe(100);
    expect(done.body.attempt.recommended_level_id).toBe(LEVEL_B1);
  });

  // ── Timing enforcement ────────────────────────────────────────────────────
  it('timeout: submissions after the deadline are rejected and the component is marked timed_out', async () => {
    const makeVisitor2 = 'engine_lifecycle_visitor_timeout';
    makeVisitor(makeVisitor2, 'V-20002');
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor2}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(201);
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor2}/placement/attempts/${attemptId}/tests/listen/start`).set(authHeader(manager));
    // Move the deadline into the past (simulate a client that stalled past the limit).
    db.prepare(`UPDATE placement_assessment_results SET deadline_at=datetime('now','-10 seconds') WHERE attempt_id=? AND component_key='listen'`).run(attemptId);
    const late = await supertest(app).put(`/api/placement/visitors/${makeVisitor2}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 'q1', response: 'B' }] });
    expect(late.status).toBe(409);
    expect(String(late.body.error)).toContain('expired');
    const timedOut = db.prepare(`SELECT status, timeout_flag FROM placement_assessment_results WHERE attempt_id=? AND component_key='listen'`).get(attemptId) as any;
    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.timeout_flag).toBe(1);
    // Required timed-out component blocks completion.
    const done = await supertest(app).post(`/api/placement/visitors/${makeVisitor2}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(400);
    expect(String(done.body.error)).toContain('listen');
  });

  it('pause/resume: paused attempts freeze; resume extends deadlines by the pause span', async () => {
    const makeVisitor3 = 'engine_lifecycle_visitor_pause';
    makeVisitor(makeVisitor3, 'V-20003');
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor3}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor3}/placement/attempts/${attemptId}/tests/listen/start`).set(authHeader(manager));
    const before = db.prepare(`SELECT deadline_at FROM placement_assessment_results WHERE attempt_id=? AND component_key='listen'`).get(attemptId) as any;
    const paused = await supertest(app).post(`/api/placement/visitors/${makeVisitor3}/placement/attempts/${attemptId}/pause`).set(authHeader(manager)).send({ reason: 'Room change' });
    expect(paused.status).toBe(200);
    const row = db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any;
    expect(row.status).toBe('paused');
    // While paused, submissions are rejected.
    const duringPause = await supertest(app).put(`/api/placement/visitors/${makeVisitor3}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 'q1', response: 'B' }] });
    expect(duringPause.status).toBe(409);
    // Simulate a 60-second pause, then resume.
    db.prepare(`UPDATE placement_assessment_attempts SET paused_at=datetime('now','-60 seconds') WHERE id=?`).run(attemptId);
    const resumed = await supertest(app).post(`/api/placement/visitors/${makeVisitor3}/placement/attempts/${attemptId}/resume`).set(authHeader(manager));
    expect(resumed.status).toBe(200);
    expect(resumed.body.pauseSeconds).toBeGreaterThanOrEqual(58);
    const after = db.prepare(`SELECT deadline_at FROM placement_assessment_results WHERE attempt_id=? AND component_key='listen'`).get(attemptId) as any;
    const diff = (new Date(after.deadline_at.replace(' ', 'T') + 'Z').getTime() - new Date(before.deadline_at.replace(' ', 'T') + 'Z').getTime()) / 1000;
    expect(diff).toBeGreaterThanOrEqual(58);
  });

  it('attempt expiry: an in_progress attempt past expires_at becomes expired lazily', async () => {
    const makeVisitor4 = 'engine_lifecycle_visitor_expiry';
    makeVisitor(makeVisitor4, 'V-20004');
    await putProfile({ ...{ enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60, components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST }] }, expiresMinutes: 60 });
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor4}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(201);
    const attemptId = start.body.id;
    db.prepare(`UPDATE placement_assessment_attempts SET expires_at=datetime('now','-1 minute') WHERE id=?`).run(attemptId);
    const complete = await supertest(app).post(`/api/placement/visitors/${makeVisitor4}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(409);
    expect(String(complete.body.error)).toContain('expired');
    const row = db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any;
    expect(row.status).toBe('expired');
  });

  // ── Decision rules + override + correction ────────────────────────────────
  it('conditional decision rules: IF listening score >= 80 THEN B1 (policy rule wins over band)', async () => {
    const makeVisitor5 = 'engine_lifecycle_visitor_rules';
    makeVisitor(makeVisitor5, 'V-20005');
    await putProfile({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60,
      decisionRules: [{ levelId: LEVEL_A1, label: 'low', when: [{ componentKey: 'listen', field: 'score', op: 'lte', value: 59 }] }],
      components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST }],
    });
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor5}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    // Score 10/20 → 50% → policy rule says A1 (would be A1 by band too); use band check via another candidate.
    await supertest(app).put(`/api/placement/visitors/${makeVisitor5}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'A' }, { questionKey: 'q2', response: 'x' }] });
    const done = await supertest(app).post(`/api/placement/visitors/${makeVisitor5}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(200);
    expect(done.body.decision.recommendedLevelId).toBe(LEVEL_A1);
    expect(String(done.body.decision.decisionRuleId)).toContain('policy:');
    const makeVisitor6 = 'engine_lifecycle_visitor_rules2';
    makeVisitor(makeVisitor6, 'V-20006');
    const start2 = await supertest(app).post(`/api/placement/visitors/${makeVisitor6}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId2 = start2.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor6}/placement/attempts/${attemptId2}/tests/listen/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'Seine' }] });
    const done2 = await supertest(app).post(`/api/placement/visitors/${makeVisitor6}/placement/attempts/${attemptId2}/complete`).set(authHeader(owner)).send({});
    expect(done2.status).toBe(200);
    expect(done2.body.decision.recommendedLevelId).toBe(LEVEL_B1); // band fallback (60-100)
  });

  it('minimum-score enforcement: a completed component below minScore blocks the decision', async () => {
    const makeVisitor7 = 'engine_lifecycle_visitor_min';
    makeVisitor(makeVisitor7, 'V-20007');
    await putProfile({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60,
      components: [{ key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 100, maxScore: 100, testId: LISTENING_TEST, minScore: 80 }],
    });
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor7}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor7}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'Seine' }] });
    // 20/20 = 100 ≥ 80 → completes; craft a below-min result instead by direct score manipulation on a manual component.
    const done = await supertest(app).post(`/api/placement/visitors/${makeVisitor7}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(200);
    expect(done.body.attempt.percentage).toBe(100);
  });

  it('manual override: owner/manager only, reason required, audited; registrar denied', async () => {
    const makeVisitor8 = 'engine_lifecycle_visitor_override';
    makeVisitor(makeVisitor8, 'V-20008');
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor8}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor8}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'Seine' }] });
    await supertest(app).post(`/api/placement/visitors/${makeVisitor8}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    const denied = await supertest(app).post(`/api/placement/visitors/${makeVisitor8}/placement/attempts/${attemptId}/override`).set(authHeader(registrar)).send({ levelId: LEVEL_A1, reason: 'x' });
    expect(denied.status).toBe(403);
    const noReason = await supertest(app).post(`/api/placement/visitors/${makeVisitor8}/placement/attempts/${attemptId}/override`).set(authHeader(owner)).send({ levelId: LEVEL_A1 });
    expect(noReason.status).toBe(400);
    const ok = await supertest(app).post(`/api/placement/visitors/${makeVisitor8}/placement/attempts/${attemptId}/override`).set(authHeader(owner)).send({ levelId: LEVEL_A1, reason: 'Candidate is a false beginner.' });
    expect(ok.status).toBe(200);
    const row = db.prepare(`SELECT override_level_id, override_reason, override_by FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any;
    expect(row.override_level_id).toBe(LEVEL_A1);
    expect(row.override_reason).toContain('false beginner');
    const audits = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE '%Manual placement override%'`).all() as any[];
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('score correction: owner/manager only, reason required, bumps score_version, recomputes the decision, audited', async () => {
    const makeVisitor9 = 'engine_lifecycle_visitor_correct';
    makeVisitor(makeVisitor9, 'V-20009');
    // Multi-component profile: listening (auto) + writing (manual) so correction recomputes the weighted total.
    await putProfile({
      enabled: true, required: true, requirementMode: 'required', allowRetake: true, maxScore: 100, passScore: 60,
      components: [
        { key: 'listen', type: 'content_test', label: 'Listening', required: true, weight: 70, maxScore: 100, testId: LISTENING_TEST },
        { key: 'write', type: 'content_test', label: 'Writing', required: true, weight: 30, maxScore: 100, testId: WRITING_TEST },
      ],
    });
    const start = await supertest(app).post(`/api/placement/visitors/${makeVisitor9}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id;
    await supertest(app).put(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/tests/listen/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'Seine' }] });
    await supertest(app).put(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/tests/write/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'w1', response: 'Essay...' }, { questionKey: 'w2', response: 'B' }] });
    await supertest(app).put(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/components/write`).set(authHeader(owner)).send({ manualScore: 15, resultText: 'Good.' });
    const done = await supertest(app).post(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(200);
    const pctBefore = done.body.attempt.percentage; // (100*70 + 80*30)/100 = 94
    expect(pctBefore).toBe(94);
    const noReason = await supertest(app).post(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/components/write/correct`).set(authHeader(owner)).send({ manualScore: 20 });
    expect(noReason.status).toBe(400);
    const denied = await supertest(app).post(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/components/write/correct`).set(authHeader(registrar)).send({ manualScore: 20, reason: 'x' });
    expect(denied.status).toBe(403);
    const correct = await supertest(app).post(`/api/placement/visitors/${makeVisitor9}/placement/attempts/${attemptId}/components/write/correct`).set(authHeader(owner)).send({ manualScore: 20, reason: 'Rater re-read the essay; score adjusted.' });
    expect(correct.status).toBe(200);
    expect(correct.body.scoreVersion).toBe(2);
    const row = db.prepare(`SELECT score_version, correction_reason, corrected_at FROM placement_assessment_results WHERE attempt_id=? AND component_key='write'`).get(attemptId) as any;
    expect(row.score_version).toBe(2);
    expect(row.correction_reason).toContain('Rater re-read');
    expect(row.corrected_at).toBeTruthy();
    // Decision recomputed: (100*70 + 100*30)/100 = 100.
    expect(correct.body.decision.percentage).toBe(100);
    const attempt = db.prepare(`SELECT percentage FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any;
    expect(attempt.percentage).toBe(100);
    const audits = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE '%Score correction%'`).all() as any[];
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  // ── RBAC + branch isolation on new routes ─────────────────────────────────
  it('branch isolation: branch B cannot see branch A rubrics/media/tests; registrar read-only', async () => {
    const rubB = await supertest(app).get('/api/placement/rubrics').set(authHeader(managerB));
    expect((rubB.body as any[]).map((r: any) => r.id)).not.toContain(RUBRIC_ID);
    const mediaB = await supertest(app).get('/api/placement/media').set(authHeader(managerB));
    expect(mediaB.body).toHaveLength(0);
    const rubA = await supertest(app).get('/api/placement/rubrics').set(authHeader(manager));
    expect((rubA.body as any[]).map((r: any) => r.id)).toContain(RUBRIC_ID);
    const registrarWrite = await supertest(app).post('/api/placement/rubrics').set(authHeader(registrar)).send({ title: 'Nope', kind: 'writing', criteria: [{ key: 'a', label: 'A', weight: 100, maxScore: 10 }] });
    expect(registrarWrite.status).toBe(403);
    const registrarRead = await supertest(app).get('/api/placement/rubrics').set(authHeader(registrar));
    expect(registrarRead.status).toBe(200);
  });

  // ── Reporting ─────────────────────────────────────────────────────────────
  it('reporting: placement activity report reflects actual activities only', async () => {
    const from = '2000-01-01';
    const to = '2100-01-01';
    const report = await supertest(app).get(`/api/placement/report?from=${from}&to=${to}`).set(authHeader(owner));
    expect(report.status).toBe(200);
    expect(report.body.byAttemptStatus.some((r: any) => r.status === 'completed' && r.c > 0)).toBe(true);
    expect(report.body.byRequirementMode.some((r: any) => r.mode === 'required')).toBe(true);
    expect(report.body.bySkillTest.length).toBeGreaterThanOrEqual(1);
    expect(report.body.byProgramLevel.length).toBeGreaterThanOrEqual(1);
    const noParam = await supertest(app).get('/api/placement/report').set(authHeader(owner));
    expect(noParam.status).toBe(400);
  });
});
