/**
 * Placement Assessment — Content-Driven Lifecycle (regression + integration)
 * ---------------------------------------------------------------------------
 * Proves the FULL placement lifecycle executes from real test-bank content:
 *
 *   Test Bank (content) → Profile (content_test component + testId)
 *     → Attempt (immutable snapshot of test + questions + answer keys)
 *     → Candidate Responses (auto-score MCQ/short_answer; manual essay/speaking)
 *     → Skill/Component scores → Weighted Total → Placement Rules
 *     → Placement Decision (visitor completed + recommended level)
 *     → History (retake, immutable past attempts, audit trail)
 *
 * Security/integrity properties verified:
 *   - RBAC: only owner/manager/HOD edit the test bank; staff may read/submit.
 *   - Branch isolation: branch tests invisible cross-branch; profiles cannot
 *     reference another branch's test; responses are visitor+branch scoped.
 *   - Answer-key secrecy: read/profile views never expose answer keys.
 *   - Duplicate submission is replay-safe (UNIQUE(attempt_id, question_id)).
 *   - Concurrent submissions are atomic (no dupes, no 500s).
 *   - Score manipulation: staff cannot rewrite auto-graded components and can
 *     only set the manual (essay/speaking) portion within its point bounds.
 *   - Historical immutability: editing the test bank never changes completed
 *     attempts (snapshot holds original questions + keys at start time).
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

const BRANCH = 'content_lifecycle_branch';
const BRANCH_B = 'content_lifecycle_branch_b';
const PROGRAM = 'content_lifecycle_program';
const VERSION = 'content_lifecycle_version';
const LEVEL_A1 = 'content_lifecycle_a1';
const LEVEL_B1 = 'content_lifecycle_b1';
const OWNER = 'content_lifecycle_owner';
const OWNER_B = 'content_lifecycle_owner_b';
const MANAGER = 'content_lifecycle_manager';
const MANAGER_B = 'content_lifecycle_manager_b';
const REGISTRAR = 'content_lifecycle_registrar';
const VISITOR = 'content_lifecycle_visitor';
const VISITOR_B = 'content_lifecycle_visitor_b';

let LISTENING_TEST = '';
let WRITING_TEST = '';
let BRANCH_B_TEST = '';
let DRAFT_TEST = '';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(user: TokenPayload) {
  return { Authorization: `Bearer ${signToken(user)}` };
}

describe('Placement content-driven lifecycle (test bank → responses → scoring → decision)', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let ownerB: TokenPayload;
  let manager: TokenPayload;
  let managerB: TokenPayload;
  let registrar: TokenPayload;
  let visitorId: string;
  let visitorBId: string;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH, 'Content Branch', 'Test');
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)`).run(BRANCH_B, 'Content Branch B', 'Test');
    for (const [u, username, role, branch] of [
      [OWNER, 'content-owner', 'owner', BRANCH],
      [OWNER_B, 'content-owner-b', 'owner', BRANCH_B],
      [MANAGER, 'content-manager', 'manager', BRANCH],
      [MANAGER_B, 'content-manager-b', 'manager', BRANCH_B],
      [REGISTRAR, 'content-registrar', 'registrar', BRANCH],
    ] as const) {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(u, username, 'Content User', role, branch, await hashPassword('testpass123'));
    }
    syncLegacyUserRoles(db);

    db.prepare(`INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)`).run(PROGRAM, 'Content Program', BRANCH);
    db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, 'v1', 1, 'published', 1)`).run(VERSION, PROGRAM);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1 Beginner', 1, ?, 'A1', 1)`).run(LEVEL_A1, PROGRAM, VERSION);
    db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1 Intermediate', 2, ?, 'B1', 1)`).run(LEVEL_B1, PROGRAM, VERSION);
    db.prepare(`INSERT OR REPLACE INTO placement_rules (id, program_version_id, branch_id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active) VALUES (?, ?, NULL, 'A1 band', 0, 59, ?, 'A1', 1, 1)`).run(id('prl'), VERSION, LEVEL_A1);
    db.prepare(`INSERT OR REPLACE INTO placement_rules (id, program_version_id, branch_id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active) VALUES (?, ?, NULL, 'B1 band', 60, 100, ?, 'B1', 2, 1)`).run(id('prl'), VERSION, LEVEL_B1);

    db.prepare(`DELETE FROM visitors WHERE id IN (?, ?)`).run(VISITOR, VISITOR_B);
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Content Candidate', '0700000100', 'female', 'social', ?, 'visited', ?, 'Content Program', ?, 'not_started')`)
      .run(VISITOR, 'V-10001', today(), BRANCH, VERSION);
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status) VALUES (?, ?, 'Branch B Candidate', '0700000101', 'male', 'social', ?, 'visited', ?, 'Content Program', ?, 'not_started')`)
      .run(VISITOR_B, 'V-10002', today(), BRANCH_B, VERSION);

    owner = { userId: OWNER, username: 'content-owner', role: 'owner', branchId: BRANCH, fullName: 'Content Owner' };
    ownerB = { userId: OWNER_B, username: 'content-owner-b', role: 'owner', branchId: BRANCH_B, fullName: 'Content Owner B' };
    manager = { userId: MANAGER, username: 'content-manager', role: 'manager', branchId: BRANCH, fullName: 'Content Manager' };
    managerB = { userId: MANAGER_B, username: 'content-manager-b', role: 'manager', branchId: BRANCH_B, fullName: 'Content Manager B' };
    registrar = { userId: REGISTRAR, username: 'content-registrar', role: 'registrar', branchId: BRANCH, fullName: 'Content Registrar' };
    visitorId = VISITOR;
    visitorBId = VISITOR_B;
    app = createApp();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST-BANK CRUD + RBAC + BRANCH ISOLATION
  // ─────────────────────────────────────────────────────────────────────────
  it('RBAC: registrar/counselor may read the test bank but not create/edit it', async () => {
    const read = await supertest(app).get('/api/placement/test-bank').set(authHeader(registrar));
    expect(read.status).toBe(200);
    expect(Array.isArray(read.body)).toBe(true);
    const create = await supertest(app).post('/api/placement/test-bank').set(authHeader(registrar)).send({ title: 'Nope', testType: 'listening' });
    expect(create.status).toBe(403);
  });

  it('creates a listening test with MCQ + short-answer questions (auto-gradeable)', async () => {
    const res = await supertest(app).post('/api/placement/test-bank').set(authHeader(manager)).send({
      title: 'Listening Test 1',
      testType: 'listening',
      instructions: 'Listen to the audio and answer.',
      audioUrl: '/audio/listening-1.mp3',
      transcript: 'Welcome to the airport. The train to the city leaves at eleven o\'clock.',
      questions: [
        { key: 'q1', qtype: 'mcq', prompt: 'What is the capital of France?', options: [{ key: 'A', text: 'London' }, { key: 'B', text: 'Paris' }, { key: 'C', text: 'Rome' }, { key: 'D', text: 'Berlin' }], answerKey: 'B', points: 10 },
        { key: 'q2', qtype: 'short_answer', prompt: 'Which river flows through Paris?', answerKey: 'Seine', points: 10 },
        { key: 'q3', qtype: 'mcq', prompt: 'What time does the train leave?', options: [{ key: 'A', text: '09:00' }, { key: 'B', text: '10:00' }, { key: 'C', text: '11:00' }, { key: 'D', text: '12:00' }], answerKey: 'C', points: 10 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('draft');
    // Default branch = caller's branch (isolation); never global by accident.
    const row = db.prepare('SELECT branch_id FROM placement_tests WHERE id = ?').get(res.body.id) as any;
    expect(row.branch_id).toBe(BRANCH);
    LISTENING_TEST = res.body.id;
  });

  it('creates a writing test with an essay (manual) + an MCQ (auto) section', async () => {
    const res = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({
      title: 'Writing Test 1',
      testType: 'writing',
      instructions: 'Write a short essay and answer the question.',
      questions: [
        { key: 'w1', qtype: 'essay', prompt: 'Describe your hometown and why you like it.', points: 20 },
        { key: 'w2', qtype: 'mcq', prompt: 'Which word is a synonym of "happy"?', options: [{ key: 'A', text: 'sad' }, { key: 'B', text: 'joyful' }], answerKey: 'B', points: 5 },
      ],
    });
    expect(res.status).toBe(201);
    WRITING_TEST = res.body.id;
  });

  it('creates a draft test and a branch-B test for validation/isolation scenarios', async () => {
    const draft = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({ title: 'Empty Draft', testType: 'reading', questions: [] });
    expect(draft.status).toBe(201);
    DRAFT_TEST = draft.body.id;
    const bTest = await supertest(app).post('/api/placement/test-bank').set(authHeader(ownerB)).send({
      title: 'Branch B Reading',
      testType: 'reading',
      passage: 'Branch B passage.',
      questions: [{ key: 'b1', qtype: 'short_answer', prompt: 'Branch B question', answerKey: 'alpha', points: 10 }],
    });
    expect(bTest.status).toBe(201);
    BRANCH_B_TEST = bTest.body.id;
    const activate = await supertest(app).post(`/api/placement/test-bank/${BRANCH_B_TEST}/activate`).set(authHeader(ownerB));
    expect(activate.status).toBe(200);
  });

  it('validates test-bank input: missing title/type, bad MCQ options, missing answer key', async () => {
    const noTitle = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({ testType: 'listening' });
    expect(noTitle.status).toBe(400);
    const badType = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({ title: 'X', testType: 'essay' });
    expect(badType.status).toBe(400);
    const badMcq = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({ title: 'X', testType: 'listening', questions: [{ key: 'q1', qtype: 'mcq', prompt: 'P', options: [{ key: 'A', text: 'only' }], answerKey: 'A', points: 5 }] });
    expect(badMcq.status).toBe(400);
    const noKey = await supertest(app).post('/api/placement/test-bank').set(authHeader(owner)).send({ title: 'X', testType: 'listening', questions: [{ key: 'q1', qtype: 'short_answer', prompt: 'P', points: 5 }] });
    expect(noKey.status).toBe(400);
  });

  it('activation: cannot activate a test with no questions; activates the listening + writing tests', async () => {
    const bad = await supertest(app).post(`/api/placement/test-bank/${DRAFT_TEST}/activate`).set(authHeader(owner));
    expect(bad.status).toBe(400);
    const ok1 = await supertest(app).post(`/api/placement/test-bank/${LISTENING_TEST}/activate`).set(authHeader(manager));
    expect(ok1.status).toBe(200);
    const ok2 = await supertest(app).post(`/api/placement/test-bank/${WRITING_TEST}/activate`).set(authHeader(manager));
    expect(ok2.status).toBe(200);
  });

  it('branch isolation: branch B cannot see branch A tests; global tests would be shared', async () => {
    const listB = await supertest(app).get('/api/placement/test-bank').set(authHeader(ownerB));
    expect(listB.status).toBe(200);
    const idsB = (listB.body as any[]).map((t) => t.id);
    expect(idsB).toContain(BRANCH_B_TEST);
    expect(idsB).not.toContain(LISTENING_TEST);
    expect(idsB).not.toContain(WRITING_TEST);
    const listA = await supertest(app).get('/api/placement/test-bank').set(authHeader(owner));
    const idsA = (listA.body as any[]).map((t) => t.id);
    expect(idsA).toContain(LISTENING_TEST);
    expect(idsA).not.toContain(BRANCH_B_TEST);
  });

  it('profile PUT: rejects inactive test, rejects another-branch test, accepts active same-branch test', async () => {
    const base = (testId: string, key: string) => ({
      enabled: true, required: true, allowRetake: true, maxScore: 100, passScore: 60, scoringModel: 'weighted_average',
      components: [
        { key: 'listening', type: 'content_test', label: 'Listening', required: true, weight: 40, maxScore: 100, testId },
        { key: 'writing', type: 'content_test', label: 'Writing', required: true, weight: 30, maxScore: 100, testId: WRITING_TEST },
        { key: 'interview', type: 'written_test', label: 'Interview', required: true, weight: 30, maxScore: 100 },
      ],
    });
    // draft test → 400
    const inactive = await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send(base(DRAFT_TEST, 'listening'));
    expect(inactive.status).toBe(400);
    expect(String(inactive.body.error)).toContain('not active');
    // branch B test → 400 (cross-branch reference)
    const crossBranch = await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send(base(BRANCH_B_TEST, 'listening'));
    expect(crossBranch.status).toBe(400);
    expect(String(crossBranch.body.error)).toContain('another branch');
    // active same-branch → 200
    const ok = await supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send(base(LISTENING_TEST, 'listening'));
    expect(ok.status).toBe(200);
    expect(ok.body.components.find((c: any) => c.key === 'listening').testId).toBe(LISTENING_TEST);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ATTEMPT + SNAPSHOT + RESPONSES + AUTO-SCORING
  // ─────────────────────────────────────────────────────────────────────────
  it('read view never exposes answer keys to staff screens', async () => {
    const res = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    expect(res.status).toBe(200);
    const tests = res.body.profile.contentTests as any[];
    expect(tests).toHaveLength(2);
    const serialized = JSON.stringify(tests);
    expect(serialized).not.toContain('answer_key');
    expect(serialized).not.toContain('answerKey');
    expect(tests[0].questions[0].prompt).toBeTruthy();
    expect(tests[0].questions[0].options).toHaveLength(4);
  });

  it('starts an attempt and snapshots the full test content + answer keys immutably', async () => {
    const start = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(201);
    const attempt = db.prepare(`SELECT snapshot_json FROM placement_assessment_attempts WHERE visitor_id = ? AND status='in_progress'`).get(visitorId) as any;
    const snapshot = JSON.parse(attempt.snapshot_json);
    expect(Array.isArray(snapshot.tests)).toBe(true);
    expect(snapshot.tests.map((t: any) => t.id)).toEqual([LISTENING_TEST, WRITING_TEST]);
    const listening = snapshot.tests.find((t: any) => t.id === LISTENING_TEST);
    expect(listening.questions).toHaveLength(3);
    // answer keys ARE inside the server-side snapshot (used by the auto-scorer)
    expect(listening.questions[0].answer_key).toBe('B');
    expect(listening.questions[1].answer_key).toBe('Seine');
    // profile component config carries testId
    expect(snapshot.profile.components.find((c: any) => c.key === 'listening').testId).toBe(LISTENING_TEST);
    // Client-facing attempts view (mapAttempt) must strip answer keys.
    const view = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    const currentSnapshot = view.body.current.snapshot;
    const viewListening = currentSnapshot.tests.find((t: any) => t.id === LISTENING_TEST);
    expect(viewListening.questions[0].answer_key).toBeUndefined();
    expect(JSON.stringify(currentSnapshot)).not.toContain('answer_key');
  });

  let attemptId = '';
  it('submits partial responses: auto-score applies per question, component stays pending', async () => {
    const cur = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    attemptId = cur.body.current.id;
    const res = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(registrar)).send({
      answers: [
        { questionKey: 'q1', response: 'B' },   // correct → 10
        { questionKey: 'q3', response: 'A' },   // wrong → 0
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.answered).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.complete).toBe(false);
    expect(res.body.autoScore).toBe(10);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?`).get(attemptId, LISTENING_TEST) as any;
    expect(rows.c).toBe(2);
    const result = db.prepare(`SELECT status, score, payload_json FROM placement_assessment_results WHERE attempt_id = ? AND component_key = 'listening'`).get(attemptId) as any;
    expect(result.status).toBe('pending');
    expect(JSON.parse(result.payload_json).answered).toBe(2);
  });

  it('completes the auto component when all questions are answered (30/30 → 100/100)', async () => {
    const res = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(manager)).send({
      answers: [
        { questionKey: 'q1', response: 'B' },
        { questionKey: 'q2', response: '  seine  ' },  // trimmed + case-insensitive → correct
        { questionKey: 'q3', response: 'C' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.answered).toBe(3);
    expect(res.body.complete).toBe(true);
    expect(res.body.autoScore).toBe(30);
    const result = db.prepare(`SELECT status, score, max_score FROM placement_assessment_results WHERE attempt_id = ? AND component_key = 'listening'`).get(attemptId) as any;
    expect(result.status).toBe('completed');
    expect(result.score).toBe(100);
    expect(result.max_score).toBe(100);
    const feedback = db.prepare(`SELECT feedback, auto_score FROM placement_assessment_responses WHERE attempt_id = ? AND question_key = 'q1'`).get(attemptId) as any;
    expect(feedback.feedback).toBe('Correct');
    expect(feedback.auto_score).toBe(10);
  });

  it('duplicate submission is replay-safe: no extra rows, idempotent auto-score', async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?`).get(attemptId, LISTENING_TEST) as any).c;
    const res = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(owner)).send({
      answers: [
        { questionKey: 'q1', response: 'B' },
        { questionKey: 'q2', response: 'Seine' },
        { questionKey: 'q3', response: 'C' },
      ],
    });
    expect(res.status).toBe(200);
    const after = (db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?`).get(attemptId, LISTENING_TEST) as any).c;
    expect(after).toBe(before);
    expect(after).toBe(3);
    expect(res.body.autoScore).toBe(30);
  });

  it('concurrent submissions are atomic: parallel PUTs never duplicate or 500', async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?`).get(attemptId, LISTENING_TEST) as any).c;
    const [a, b] = await Promise.all([
      supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q3', response: 'C' }] }),
      supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(manager)).send({ answers: [{ questionKey: 'q3', response: 'D' }] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = (db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?`).get(attemptId, LISTENING_TEST) as any).c;
    expect(after).toBe(before);
    expect(after).toBe(3);
    // Final state is one of the two submitted values (last writer wins), never corrupted.
    const q3 = db.prepare(`SELECT response_json, auto_score FROM placement_assessment_responses WHERE attempt_id = ? AND question_key = 'q3'`).get(attemptId) as any;
    expect(['"C"', '"D"']).toContain(q3.response_json);
    expect([10, 0]).toContain(q3.auto_score);
    // Restore the deterministic correct answer so later assertions hold.
    const restore = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(owner)).send({ answers: [{ questionKey: 'q3', response: 'C' }] });
    expect(restore.status).toBe(200);
    expect(restore.body.autoScore).toBe(30);
  });

  it('cross-student / cross-branch isolation: responses for another visitor or branch are rejected', async () => {
    // Branch B manager cannot touch branch A visitor's attempt (branch isolation).
    const foreignBranch = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(managerB)).send({ answers: [] });
    expect(foreignBranch.status).toBe(403);
    // Nor can they read branch A's test bank.
    const foreignList = await supertest(app).get('/api/placement/test-bank').set(authHeader(managerB));
    const foreignIds = (foreignList.body as any[]).map((t: any) => t.id);
    expect(foreignIds).not.toContain(LISTENING_TEST);
    // Attempt id of visitor A must not be reachable through visitor B's path.
    const foreignVisitor = await supertest(app).put(`/api/placement/visitors/${visitorBId}/placement/attempts/${attemptId}/tests/listening/responses`).set(authHeader(owner)).send({ answers: [] });
    expect(foreignVisitor.status).toBe(404);
  });

  it('score manipulation guard: pure-auto components reject staff score overrides', async () => {
    const res = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/listening`).set(authHeader(owner)).send({ score: 100, manualScore: 100 });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('fully auto-graded');
    const unchanged = db.prepare(`SELECT score FROM placement_assessment_results WHERE attempt_id = ? AND component_key = 'listening'`).get(attemptId) as any;
    expect(unchanged.score).toBe(100);
  });

  it('manual scoring: essay component requires all answers first, then merges manual into the auto portion', async () => {
    // Submit only the essay answer → component not complete; PUT manual score before all answered → 400
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/writing/responses`).set(authHeader(registrar)).send({ answers: [{ questionKey: 'w1', response: 'My hometown is a quiet valley.' }] });
    const early = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/writing`).set(authHeader(owner)).send({ manualScore: 15, resultText: 'Good structure.' });
    expect(early.status).toBe(400);
    // Answer the MCQ too (auto part) and submit again.
    const submit = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/tests/writing/responses`).set(authHeader(registrar)).send({ answers: [{ questionKey: 'w1', response: 'My hometown is a quiet valley.' }, { questionKey: 'w2', response: 'B' }] });
    expect(submit.status).toBe(200);
    expect(submit.body.complete).toBe(false); // manual question remains
    expect(submit.body.autoScore).toBe(5);
    // manualScore beyond manual bounds → 400
    const over = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/writing`).set(authHeader(owner)).send({ manualScore: 25 });
    expect(over.status).toBe(400);
    // Legitimate manual score 15/20 → combined (5+15)/25 = 80/100
    const manual = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/writing`).set(authHeader(owner)).send({ manualScore: 15, resultText: 'Good structure and vocabulary.' });
    expect(manual.status).toBe(200);
    const result = manual.body.find((r: any) => r.component_key === 'writing');
    expect(result.status).toBe('completed');
    expect(result.score).toBe(80);
    expect(JSON.parse(result.payload_json).manualScore).toBe(15);
  });

  it('blocks completion until every required component is done', async () => {
    const res = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('interview');
  });

  it('completes the full lifecycle: weighted total → placement rule → visitor completed + recommended level', async () => {
    await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/components/interview`).set(authHeader(owner)).send({ score: 90, resultText: 'Fluent.' });
    const res = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attemptId}/complete`).set(authHeader(owner)).send({});
    expect(res.status).toBe(200);
    expect(res.body.attempt.status).toBe('completed');
    // listening 100×40 + writing 80×30 + interview 90×30 = 40+24+27 = 91
    expect(res.body.attempt.percentage).toBe(91);
    const visitor = db.prepare(`SELECT placement_status, placement_score, current_placement_attempt_id FROM visitors WHERE id = ?`).get(visitorId) as any;
    expect(visitor.placement_status).toBe('completed');
    expect(visitor.current_placement_attempt_id).toBe(attemptId);
    const placement = JSON.parse(visitor.placement_score);
    expect(placement.recommendation.levelId).toBe(LEVEL_B1);
    const results = db.prepare(`SELECT component_key, score FROM placement_assessment_results WHERE attempt_id = ?`).all(attemptId) as any[];
    const byKey = Object.fromEntries(results.map((r) => [r.component_key, r.score]));
    expect(byKey).toEqual({ listening: 100, writing: 80, interview: 90 });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // IMMUTABILITY + RETAKE + AUDIT
  // ─────────────────────────────────────────────────────────────────────────
  it('historical immutability: editing the test bank never changes the completed attempt', async () => {
    // Edit the listening test: change q1 answer key B→A and q3 key C→D.
    const list = (await supertest(app).get('/api/placement/test-bank').set(authHeader(owner))).body as any[];
    const original = list.find((t: any) => t.id === LISTENING_TEST);
    const res = await supertest(app).put(`/api/placement/test-bank/${LISTENING_TEST}`).set(authHeader(owner)).send({
      title: original.title, testType: original.test_type, instructions: original.instructions,
      audioUrl: original.audio_url, transcript: original.transcript, passage: original.passage, status: 'active',
      questions: original.questions.map((q: any, i: number) => (i === 0 ? { ...q, answerKey: 'A' } : i === 2 ? { ...q, answerKey: 'D' } : q)),
    });
    expect(res.status).toBe(200);
    // Completed attempt snapshot is untouched (still B and C), results unchanged.
    const attempt = db.prepare(`SELECT snapshot_json FROM placement_assessment_attempts WHERE id = ?`).get(attemptId) as any;
    const snapshot = JSON.parse(attempt.snapshot_json);
    const listening = snapshot.tests.find((t: any) => t.id === LISTENING_TEST);
    expect(listening.questions[0].answer_key).toBe('B');
    expect(listening.questions[2].answer_key).toBe('C');
    const results = db.prepare(`SELECT score FROM placement_assessment_results WHERE attempt_id = ? AND component_key = 'listening'`).get(attemptId) as any;
    expect(results.score).toBe(100);
  });

  it('retake: a new attempt snapshots the EDITED test and scores against it', async () => {
    const start = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts`).set(authHeader(owner)).send({});
    expect(start.status).toBe(201);
    const cur = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    const attempt2 = cur.body.current.id;
    expect(attempt2).not.toBe(attemptId);
    const attemptRow = db.prepare(`SELECT attempt_number, snapshot_json FROM placement_assessment_attempts WHERE id = ?`).get(attempt2) as any;
    expect(attemptRow.attempt_number).toBe(2);
    const snapshot = JSON.parse(attemptRow.snapshot_json);
    const listening = snapshot.tests.find((t: any) => t.id === LISTENING_TEST);
    expect(listening.questions[0].answer_key).toBe('A'); // edited key applies to NEW attempts
    expect(listening.questions[2].answer_key).toBe('D');
    // Submit the OLD answers → q1 and q3 are now wrong (keys moved) → auto 10/30
    const res = await supertest(app).put(`/api/placement/visitors/${visitorId}/placement/attempts/${attempt2}/tests/listening/responses`).set(authHeader(owner)).send({
      answers: [
        { questionKey: 'q1', response: 'B' },
        { questionKey: 'q2', response: 'Seine' },
        { questionKey: 'q3', response: 'C' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.autoScore).toBe(10);
    expect(res.body.complete).toBe(true);
    expect(res.body.feedback.q1).toContain('Expected: A');
    // Cancel the retake so the visitor history stays tidy.
    const cancel = await supertest(app).post(`/api/placement/visitors/${visitorId}/placement/attempts/${attempt2}/cancel`).set(authHeader(owner)).send({ reason: 'retake test finished' });
    expect(cancel.status).toBe(200);
  });

  it('audit trail records test-bank creation, activation, edit and response submissions', async () => {
    const rows = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE '%placement test-bank%' ORDER BY rowid DESC`).all() as any[];
    const actions = rows.map((r: any) => r.action).join(' | ');
    expect(actions).toContain('Created placement test-bank entry "Listening Test 1"');
    expect(actions).toContain('Activated placement test-bank entry');
    expect(actions).toContain('Updated placement test-bank entry');
    const responseAudits = db.prepare(`SELECT action FROM audit_logs WHERE action LIKE '%Recorded content responses%' ORDER BY rowid DESC`).all() as any[];
    expect(responseAudits.length).toBeGreaterThanOrEqual(3);
  });

  it('complete lifecycle has produced an executable placement decision + result history', async () => {
    const history = await supertest(app).get(`/api/placement/visitors/${visitorId}/placement`).set(authHeader(owner));
    expect(history.status).toBe(200);
    const completed = history.body.attempts.filter((a: any) => a.status === 'completed');
    expect(completed.length).toBe(1);
    expect(completed[0].percentage).toBe(91);
  });
});
