/**
 * Placement Exam — certification blockers C-1, C-3, C-4.
 * ============================================================================
 * Every test here fails against the pre-fix implementation. They encode the
 * exact exploits from docs/PLACEMENT_CERTIFICATION_2026-08-17.md:
 *
 *   C-1  CRITICAL  placement was enforced only on visitor→student conversion,
 *                  so POST /api/students/manual (and every other path reaching
 *                  EnrollmentService.enroll(), plus the extra-class raw INSERT)
 *                  enrolled a candidate into a placement-required class with no
 *                  assessment at all.
 *   C-3  HIGH      POST /api/placement/maintenance/expire ran unfiltered, so a
 *                  manager at one branch expired live attempts at every other.
 *   C-4  HIGH      mapAttempt() spread the raw row over the sanitized snapshot,
 *                  re-attaching snapshot_json with every answer key; and
 *                  auto-score feedback echoed `Expected: <answer>`.
 *
 * The C-1 cases deliberately drive the ALTERNATE paths, not the conversion
 * route, because the conversion route was already gated when these were found.
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
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';

const BRANCH = 'cb_branch_a';
const BRANCH_B = 'cb_branch_b';
const PROGRAM = 'cb_program';
const VERSION = 'cb_version';
const LEVEL_A1 = 'cb_a1';
const CLASS_GATED = 'cb_class_gated';   // level belongs to a placement-required version
const CLASS_FREE = 'cb_class_free';     // no level → no placement policy
const TEST_ID = 'cb_test';

let owner: TokenPayload;
let managerB: TokenPayload;
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

function createApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/visitors', visitorsRouter);
  a.use('/api/placement', placementRouter);
  a.use('/api/academic', academicRouter);
  a.use('/api/students', studentsRouter);
  a.use(errorHandler);
  return a;
}

let seq = 0;
function makeVisitor(branch = BRANCH): string {
  seq += 1;
  const vid = `cb_v_${seq}`;
  db.prepare(
    `INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, program_version_id, placement_status)
     VALUES (?, ?, 'Blocker Candidate', ?, 'male', 'social', ?, 'visited', ?, ?, 'not_started')`
  ).run(vid, `V-CB-${seq}`, `07000${String(seq).padStart(5, '0')}`, today(), branch, VERSION);
  return vid;
}

/** Configure the shared program-version placement policy. */
const putProfile = (body: Record<string, unknown>) =>
  supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send({
    enabled: true, required: true, requirementMode: 'required', method: 'written_test',
    scoringModel: 'weighted_average', maxScore: 100, passScore: 60, allowRetake: true,
    components: [{ key: 'main', type: 'written_test', label: 'Main', enabled: true, required: true, weight: 100, maxScore: 100 }],
    ...body,
  });

/** Run a full sitting for a visitor and return the completion response. */
async function sit(vid: string, score: number) {
  const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
  await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/main`).set(authHeader(owner)).send({ score });
  const complete = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/complete`).set(authHeader(owner)).send({});
  return { attemptId: start.body.id as string, complete };
}

let manualSeq = 0;
/** POST /api/students/manual — the C-1 bypass path. */
function manualStudent(classId: string | null, extra: Record<string, unknown> = {}) {
  manualSeq += 1;
  return supertest(app).post('/api/students/manual').set(authHeader(owner)).send({
    fullName: `Manual ${manualSeq}`, gender: 'male', phone: `07911${String(manualSeq).padStart(5, '0')}`,
    branchId: BRANCH, classId, tuitionAmount: 0, amountPaidNow: 0, ...extra,
  });
}

beforeAll(async () => {
  initSchema();
  app = createApp();
  bootstrapRbacCatalog(db);

  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, 'CB Branch A', 'T')`).run(BRANCH);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, 'CB Branch B', 'T')`).run(BRANCH_B);
  db.prepare(`INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES (?, 'CB Program', 'CBP', ?)`).run(PROGRAM, BRANCH);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')`).run(VERSION, PROGRAM);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, code, "order", is_active) VALUES (?, ?, ?, 'A1', 'A1', 1, 1)`).run(LEVEL_A1, PROGRAM, VERSION);
  // Gated class: carries the level of a placement-required program version.
  db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee, program_id, level_id) VALUES (?, 'Gated', ?, 90, 'active', 'A1', 5000, ?, ?)`)
    .run(CLASS_GATED, BRANCH, PROGRAM, LEVEL_A1);
  // Ungated class: no level_id, so no placement policy can attach.
  db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee) VALUES (?, 'Free', ?, 90, 'active', 'NA', 5000)`)
    .run(CLASS_FREE, BRANCH);
  db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, 300)`).run(BRANCH);

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 0)`);
  insertUser.run('cb_owner', 'cb_owner', pwd, 'Owner', 'owner', BRANCH);
  insertUser.run('cb_mgr_b', 'cb_mgr_b', pwd, 'Manager B', 'manager', BRANCH_B);
  syncLegacyUserRoles(db);
  owner = { userId: 'cb_owner', username: 'cb_owner', role: 'owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
  managerB = { userId: 'cb_mgr_b', username: 'cb_mgr_b', role: 'manager', branchId: BRANCH_B, fullName: 'Manager B' } as TokenPayload;

  await putProfile({});
});

describe('C-1 — placement is a server-side invariant on EVERY enrollment path', () => {
  it('POST /students/manual cannot enroll into a placement-required class (the original exploit)', async () => {
    const res = await manualStudent(CLASS_GATED);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/placement/i);
    // Nothing partially created.
    expect(db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE class_id=?`).get(CLASS_GATED)).toEqual({ c: 0 });
  });

  it('POST /students/manual still works for a class with no placement policy', async () => {
    const res = await manualStudent(CLASS_FREE);
    expect(res.status).toBe(201);
  });

  it('POST /students/manual still works with no class at all', async () => {
    const res = await manualStudent(null);
    expect(res.status).toBe(201);
  });

  it('a student whose visitor FAILED placement cannot be enrolled via the manual path', async () => {
    const vid = makeVisitor();
    await sit(vid, 20); // fails passScore 60
    // Create the student without a class, then link them to the failed lead.
    const created = await manualStudent(null);
    db.prepare(`UPDATE students SET lead_id=? WHERE id=?`).run(vid, created.body.id);

    const enrolled = await supertest(app).post(`/api/students/${created.body.id}/enroll-class`).set(authHeader(owner)).send({ classId: CLASS_GATED });
    expect(enrolled.status).toBe(400);
    expect(String(enrolled.body.error)).toMatch(/did not meet the placement policy/i);
  });

  it('a student whose visitor PASSED placement can be enrolled via the alternate path', async () => {
    const vid = makeVisitor();
    const { complete } = await sit(vid, 90);
    expect(complete.body.outcome).toBe('passed');
    const created = await manualStudent(null);
    db.prepare(`UPDATE students SET lead_id=? WHERE id=?`).run(vid, created.body.id);

    const enrolled = await supertest(app).post(`/api/students/${created.body.id}/enroll-class`).set(authHeader(owner)).send({ classId: CLASS_GATED });
    expect(enrolled.status).toBe(201);
  });

  it('extra-class enrollment (raw INSERT path) is gated for an unlinked student', async () => {
    const created = await manualStudent(null);
    const enrolled = await supertest(app).post(`/api/students/${created.body.id}/enroll-class`).set(authHeader(owner)).send({ classId: CLASS_GATED });
    expect(enrolled.status).toBe(400);
    expect(String(enrolled.body.error)).toMatch(/placement/i);
    expect(db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE student_id=? AND class_id=?`).get(created.body.id, CLASS_GATED)).toEqual({ c: 0 });
  });

  it('the normal conversion route still works end to end (no regression)', async () => {
    const vid = makeVisitor();
    await sit(vid, 85);
    const res = await supertest(app).post(`/api/visitors/${vid}/convert`).set(authHeader(owner))
      .send({ classId: CLASS_GATED, amountPaid: 0, semesterFee: 0, branchId: BRANCH, programVersionId: VERSION });
    expect(res.status).toBe(201);
  });

  it('an optional policy still refuses an unassessed candidate but accepts a waiver', async () => {
    await putProfile({ required: false, requirementMode: 'optional' });
    const created = await manualStudent(null);
    const blocked = await supertest(app).post(`/api/students/${created.body.id}/enroll-class`).set(authHeader(owner)).send({ classId: CLASS_GATED });
    expect(blocked.status).toBe(400);

    const vid = makeVisitor();
    await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({ skip: true, reason: 'opted out' });
    const created2 = await manualStudent(null);
    db.prepare(`UPDATE students SET lead_id=? WHERE id=?`).run(vid, created2.body.id);
    const waived = await supertest(app).post(`/api/students/${created2.body.id}/enroll-class`).set(authHeader(owner)).send({ classId: CLASS_GATED });
    expect(waived.status).toBe(201);
    await putProfile({}); // restore required
  });
});

describe('C-3 — the expiry sweep is branch-scoped', () => {
  it('a manager at another branch cannot expire this branch\'s live attempts', async () => {
    const vid = makeVisitor();
    await putProfile({ expiresMinutes: 60 });
    const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    const attemptId = start.body.id as string;
    // Backdate the deadline so the attempt is genuinely due for expiry.
    db.prepare(`UPDATE placement_assessment_attempts SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?`).run(attemptId);

    const sweep = await supertest(app).post('/api/placement/maintenance/expire').set(authHeader(managerB)).send({});
    expect(sweep.status).toBe(200);
    expect(sweep.body.expired).toBe(0); // nothing in branch B was due
    expect((db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any).status).toBe('in_progress');

    // The owning branch can still expire it.
    const own = await supertest(app).post('/api/placement/maintenance/expire').set(authHeader(owner)).send({});
    expect(own.body.expired).toBe(1);
    expect((db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(attemptId) as any).status).toBe('expired');
    await putProfile({});
  });

  it('a foreign ?branchId= is silently re-scoped, not honoured', async () => {
    const vid = makeVisitor();
    await putProfile({ expiresMinutes: 60 });
    const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    db.prepare(`UPDATE placement_assessment_attempts SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?`).run(start.body.id);

    const sweep = await supertest(app).post(`/api/placement/maintenance/expire?branchId=${BRANCH}`).set(authHeader(managerB)).send({});
    expect(sweep.body.expired).toBe(0);
    expect((db.prepare(`SELECT status FROM placement_assessment_attempts WHERE id=?`).get(start.body.id) as any).status).toBe('in_progress');
    await putProfile({});
  });
});

describe('C-4 — exam secrets never reach the client', () => {
  beforeAll(async () => {
    // A content test with real answer keys, wired into the policy.
    db.prepare(`INSERT OR IGNORE INTO placement_tests (id, title, test_type, status, branch_id) VALUES (?, 'Leak Test', 'listening', 'active', ?)`).run(TEST_ID, BRANCH);
    db.prepare(`INSERT OR IGNORE INTO placement_test_questions (id, test_id, question_key, qtype, prompt, options_json, answer_key, points, order_index) VALUES (?, ?, 'q1', 'mcq', 'Capital of France?', ?, 'B', 10, 0)`)
      .run(id('ptq'), TEST_ID, JSON.stringify([{ key: 'A', text: 'Rome' }, { key: 'B', text: 'Paris' }]));
    db.prepare(`INSERT OR IGNORE INTO placement_test_questions (id, test_id, question_key, qtype, prompt, answer_key, points, order_index) VALUES (?, ?, 'q2', 'short_answer', 'River?', 'SEINE_SECRET', 10, 1)`)
      .run(id('ptq'), TEST_ID);
    await putProfile({
      method: 'content_test',
      components: [{ key: 'listen', type: 'content_test', label: 'Listen', enabled: true, required: true, weight: 100, maxScore: 100, testId: TEST_ID }],
    });
  });

  it('POST /attempts does not return snapshot_json or any answer key', async () => {
    const vid = makeVisitor();
    const res = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    expect(res.status).toBe(201);
    const body = JSON.stringify(res.body);
    expect(res.body).not.toHaveProperty('snapshot_json');
    expect(body).not.toContain('SEINE_SECRET');
    expect(body).not.toContain('answer_key');
  });

  it('GET /placement (view + current + attempts) leaks no answer key', async () => {
    const vid = makeVisitor();
    await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    const res = await supertest(app).get(`/api/placement/visitors/${vid}/placement`).set(authHeader(owner));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(res.body.current).not.toHaveProperty('snapshot_json');
    expect(body).not.toContain('SEINE_SECRET');
    expect(body).not.toContain('answer_key');
  });

  it('the attempts history endpoint leaks no answer key', async () => {
    const vid = makeVisitor();
    await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    const res = await supertest(app).get(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SEINE_SECRET');
    expect(body).not.toContain('answer_key');
  });

  it('auto-score feedback states correctness without revealing the answer', async () => {
    const vid = makeVisitor();
    const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    const res = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/tests/listen/responses`)
      .set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'WRONG' }, { questionKey: 'q2', response: 'WRONG' }] });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(res.body.feedback.q1).toBe('Incorrect');
    expect(body).not.toContain('SEINE_SECRET');
    expect(body).not.toContain('Expected:');
  });

  it('the persisted feedback column never stores the answer either', async () => {
    const rows = db.prepare(`SELECT feedback FROM placement_assessment_responses WHERE feedback IS NOT NULL`).all() as Array<{ feedback: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.feedback).not.toContain('SEINE_SECRET');
      expect(r.feedback).not.toMatch(/Expected:/);
    }
  });

  it('completion response leaks no answer key', async () => {
    const vid = makeVisitor();
    const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/tests/listen/responses`)
      .set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'SEINE_SECRET' }] });
    const done = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/complete`).set(authHeader(owner)).send({});
    expect(done.status).toBe(200);
    expect(JSON.stringify(done.body)).not.toContain('answer_key');
    expect(done.body.attempt).not.toHaveProperty('snapshot_json');
  });

  it('the server still scores against the real key (secrecy did not break scoring)', async () => {
    const vid = makeVisitor();
    const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
    const res = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/tests/listen/responses`)
      .set(authHeader(owner)).send({ answers: [{ questionKey: 'q1', response: 'B' }, { questionKey: 'q2', response: 'SEINE_SECRET' }] });
    expect(res.body.autoScore).toBe(20);
    expect(res.body.feedback.q1).toBe('Correct');
  });
});
