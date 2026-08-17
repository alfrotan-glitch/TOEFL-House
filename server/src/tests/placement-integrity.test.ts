/**
 * Placement Exam — integrity invariants (adversarial).
 * ============================================================================
 * Every test here is written to FAIL against the pre-remediation implementation
 * documented in docs/PLACEMENT_AUDIT_2026-08-17.md. They assert business
 * invariants, not implementation details:
 *
 *   P-1  a sitting that misses the policy (component minScore / overall
 *        passScore / missing required component) is recorded as FAILED and
 *        cannot be converted into an enrolled student
 *   P-2  allowRetake=false and maxAttempts survive sequential AND concurrent
 *        attempt creation; retake billing follows configured policy
 *   P-3  the waiver lifecycle is coherent end to end (skip -> convert)
 *   P-4  override / correct are atomic and recompute the authoritative outcome
 *
 * plus the standing guarantees the audit cleared and which must not regress:
 * one fee per attempt under parallel completion, score bounds, server
 * authority over client-supplied values, branch isolation and role separation.
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

const BRANCH = 'pint_branch';
const BRANCH_B = 'pint_branch_b';
const PROGRAM = 'pint_program';
const VERSION = 'pint_version';
const LEVEL_A1 = 'pint_a1';
const LEVEL_B1 = 'pint_b1';
const CLASS_ID = 'pint_class';

let owner: TokenPayload;
let manager: TokenPayload;
let registrar: TokenPayload;
let managerB: TokenPayload;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  return app;
}
let app: ReturnType<typeof createApp>;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let visitorSeq = 0;
function makeVisitor(branch = BRANCH, version: string | null = VERSION): string {
  visitorSeq += 1;
  const vid = `pint_v_${visitorSeq}`;
  db.prepare(`DELETE FROM visitors WHERE id = ?`).run(vid);
  db.prepare(
    `INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status)
     VALUES (?, ?, 'Integrity Candidate', '070000${String(visitorSeq).padStart(4, '0')}', 'male', 'social', ?, 'visited', ?, 'Integrity Program', ?, 'not_started')`
  ).run(vid, `V-INT-${visitorSeq}`, today(), branch, version);
  return vid;
}

/** Configure the shared program-version placement policy. */
const putProfile = (body: Record<string, unknown>, as: TokenPayload = owner) =>
  supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(as)).send(body);

/** A single required manual component; minScore/passScore vary per test. */
const singleComponentPolicy = (over: Record<string, unknown> = {}, component: Record<string, unknown> = {}) => ({
  enabled: true, required: true, requirementMode: 'required', method: 'written_test',
  scoringModel: 'weighted_average', maxScore: 100, passScore: 60, allowRetake: true,
  components: [{ key: 'main', type: 'written_test', label: 'Main', enabled: true, required: true, weight: 100, maxScore: 100, ...component }],
  ...over,
});

const startAttempt = (vid: string, as: TokenPayload = owner) =>
  supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(as)).send({});
const scoreMain = (vid: string, aid: string, score: number, as: TokenPayload = owner) =>
  supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${aid}/components/main`).set(authHeader(as)).send({ score });
const completeAttempt = (vid: string, aid: string, as: TokenPayload = owner, body: Record<string, unknown> = {}) =>
  supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/complete`).set(authHeader(as)).send(body);
const convert = (vid: string, as: TokenPayload = owner) =>
  supertest(app).post(`/api/visitors/${vid}/convert`).set(authHeader(as))
    .send({ classId: CLASS_ID, amountPaid: 0, semesterFee: 0, branchId: BRANCH, programVersionId: VERSION });

/** Run one full sitting and return the completion response. */
async function sit(vid: string, score: number) {
  const start = await startAttempt(vid);
  await scoreMain(vid, start.body.id, score);
  const complete = await completeAttempt(vid, start.body.id);
  return { aid: start.body.id as string, complete };
}

beforeAll(async () => {
  initSchema();
  app = createApp();
  bootstrapRbacCatalog(db);

  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')`).run(BRANCH, 'Integrity Branch');
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')`).run(BRANCH_B, 'Integrity Branch B');
  db.prepare(`INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES (?, 'Integrity Program', 'PINT', ?)`).run(PROGRAM, BRANCH);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')`).run(VERSION, PROGRAM);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, code, "order", is_active) VALUES (?, ?, ?, 'A1', 'A1', 1, 1)`).run(LEVEL_A1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, code, "order", is_active) VALUES (?, ?, ?, 'B1', 'B1', 2, 1)`).run(LEVEL_B1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee, program_id, level_id) VALUES (?, 'Integrity Class', ?, 50, 'active', 'A1', 5000, ?, ?)`)
    .run(CLASS_ID, BRANCH, PROGRAM, LEVEL_A1);
  // A configured placement fee so billing behaviour is observable.
  db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, 300)`).run(BRANCH);

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, branch_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 0)`);
  insertUser.run('pint_owner', 'pint_owner', pwd, 'Owner', 'owner', BRANCH);
  insertUser.run('pint_manager', 'pint_manager', pwd, 'Manager', 'manager', BRANCH);
  insertUser.run('pint_registrar', 'pint_registrar', pwd, 'Registrar', 'registrar', BRANCH);
  insertUser.run('pint_manager_b', 'pint_manager_b', pwd, 'Manager B', 'manager', BRANCH_B);
  syncLegacyUserRoles(db);
  owner = { userId: 'pint_owner', username: 'pint_owner', role: 'owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
  manager = { userId: 'pint_manager', username: 'pint_manager', role: 'manager', branchId: BRANCH, fullName: 'Manager' } as TokenPayload;
  registrar = { userId: 'pint_registrar', username: 'pint_registrar', role: 'registrar', branchId: BRANCH, fullName: 'Registrar' } as TokenPayload;
  managerB = { userId: 'pint_manager_b', username: 'pint_manager_b', role: 'manager', branchId: BRANCH_B, fullName: 'Manager B' } as TokenPayload;
});

describe('Placement integrity — P-1: policy compliance is enforced, not merely computed', () => {
  it('a component below minScore fails the sitting even when the overall score passes', async () => {
    await putProfile(singleComponentPolicy({ passScore: 10 }, { minScore: 80 }));
    const vid = makeVisitor();
    const { aid, complete } = await sit(vid, 50); // 50% > passScore 10, but < minScore 80

    expect(complete.status).toBe(200);
    expect(complete.body.outcome).toBe('failed');
    expect(complete.body.passed).toBe(false);
    expect(complete.body.unmetRequirements.join(' ')).toMatch(/below minimum score 80/);
    // Persisted, so downstream boundaries can trust it.
    expect((db.prepare('SELECT outcome FROM placement_assessment_attempts WHERE id=?').get(aid) as any).outcome).toBe('failed');
  });

  it('an overall score below passScore fails the sitting', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { complete } = await sit(vid, 40);

    expect(complete.body.outcome).toBe('failed');
    expect(complete.body.failureReasons.join(' ')).toMatch(/below the configured pass score/i);
  });

  it('a sitting meeting every requirement passes', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }, { minScore: 50 }));
    const vid = makeVisitor();
    const { complete } = await sit(vid, 75);

    expect(complete.body.outcome).toBe('passed');
    expect(complete.body.unmetRequirements).toEqual([]);
  });

  it('a missing required component blocks completion outright', async () => {
    await putProfile({
      ...singleComponentPolicy(),
      components: [
        { key: 'main', type: 'written_test', label: 'Main', enabled: true, required: true, weight: 50, maxScore: 100 },
        { key: 'second', type: 'interview', label: 'Second', enabled: true, required: true, weight: 50, maxScore: 100 },
      ],
    });
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    await scoreMain(vid, start.body.id, 90); // 'second' never scored
    const complete = await completeAttempt(vid, start.body.id);

    expect(complete.status).toBe(400);
    expect(String(complete.body.error)).toMatch(/Complete all required assessment sections/i);
    expect((db.prepare('SELECT status FROM placement_assessment_attempts WHERE id=?').get(start.body.id) as any).status).toBe('in_progress');
  });

  it('CONVERSION: a failed placement cannot become an enrolled student', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    await sit(vid, 30);

    const res = await convert(vid);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/did not meet the placement policy/i);
    expect(db.prepare('SELECT 1 FROM students WHERE lead_id=?').get(vid)).toBeUndefined();
  });

  it('CONVERSION: refuses even when the visitor status is forged to "completed" in the database', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    await sit(vid, 30);
    // Simulate a corrupted/legacy state: status says completed, result says failed.
    db.prepare(`UPDATE visitors SET placement_status='completed' WHERE id=?`).run(vid);

    const res = await convert(vid);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT 1 FROM students WHERE lead_id=?').get(vid)).toBeUndefined();
  });

  it('CONVERSION: a passing placement converts successfully', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    await sit(vid, 90);

    const res = await convert(vid);
    expect(res.status).toBe(201);
    expect(res.body.studentCode).toBeTruthy();
  });
});

describe('Placement integrity — P-2: retake and attempt limits are atomic', () => {
  it('allowRetake=false blocks a sequential second sitting', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: false, passScore: 60 }));
    const vid = makeVisitor();
    await sit(vid, 80);

    const second = await startAttempt(vid);
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/Retakes are not allowed/i);
  });

  it('allowRetake=false cannot be bypassed by opening attempts concurrently', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: false, passScore: 60 }));
    const vid = makeVisitor();

    // The original exploit: open many attempts BEFORE completing any, because
    // the guard counted only completed sittings.
    const results = await Promise.all(Array.from({ length: 8 }, () => startAttempt(vid)));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);
    const open = db.prepare(`SELECT COUNT(*) c FROM placement_assessment_attempts WHERE visitor_id=? AND status IN ('in_progress','paused')`).get(vid) as any;
    expect(open.c).toBe(1);
  });

  it('score-shopping is impossible: a second attempt cannot be opened while one is open', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const first = await startAttempt(vid);
    expect(first.status).toBe(201);

    const second = await startAttempt(vid);
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/already has an open placement attempt/i);
  });

  it('maxAttempts caps the number of sittings', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, maxAttempts: 2, passScore: 60 }));
    const vid = makeVisitor();
    await sit(vid, 80);
    await sit(vid, 85);

    const third = await startAttempt(vid);
    expect(third.status).toBe(409);
    expect(String(third.body.error)).toMatch(/at most 2 attempts/i);
  });

  it('a legitimate retake is allowed when the policy permits it', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const first = await sit(vid, 40);
    expect(first.complete.body.outcome).toBe('failed');

    const second = await sit(vid, 90);
    expect(second.complete.body.outcome).toBe('passed');
    // The corrected result is what conversion now sees.
    expect((await convert(vid)).status).toBe(201);
  });
});

describe('Placement integrity — fee behaviour follows configured policy', () => {
  it('default policy: first sitting billed, retakes free', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const first = await sit(vid, 80);
    const second = await sit(vid, 85);

    expect(first.complete.body.feeCharged).toBe(300);
    expect(second.complete.body.feeCharged).toBe(0);
  });

  it('retakeBillable: retakes are billed at the configured retake price', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60, retakeBillable: true, retakeFeeAmount: 150 }));
    const vid = makeVisitor();
    const first = await sit(vid, 80);
    const second = await sit(vid, 85);

    expect(first.complete.body.feeCharged).toBe(300);
    expect(second.complete.body.feeCharged).toBe(150);
    const rows = db.prepare(`SELECT amount FROM payments WHERE category='placement' AND branch_id=? AND idempotency_key IN (?, ?) ORDER BY amount`)
      .all(BRANCH, `placement:${first.aid}`, `placement:${second.aid}`) as any[];
    expect(rows.map((r) => r.amount)).toEqual([150, 300]);
  });

  it('firstAttemptBillable=false: the first sitting is free', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60, firstAttemptBillable: false }));
    const vid = makeVisitor();
    const { aid, complete } = await sit(vid, 80);

    expect(complete.body.feeCharged).toBe(0);
    expect(db.prepare(`SELECT 1 FROM payments WHERE idempotency_key=?`).get(`placement:${aid}`)).toBeUndefined();
  });

  it('a failed sitting is still billed (it consumed exam resources)', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { complete } = await sit(vid, 20);

    expect(complete.body.outcome).toBe('failed');
    expect(complete.body.feeCharged).toBe(300);
  });

  it('parallel completion books exactly one fee and one ledger entry', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    const aid = start.body.id as string;
    await scoreMain(vid, aid, 80);

    const results = await Promise.all(Array.from({ length: 8 }, () => completeAttempt(vid, aid)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const payments = db.prepare(`SELECT COUNT(*) c FROM payments WHERE idempotency_key=?`).get(`placement:${aid}`) as any;
    const ledger = db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE reference_id=? AND category='placement'`).get(aid) as any;
    expect(payments.c).toBe(1);
    expect(ledger.c).toBe(1);
  });

  it('duplicate sequential completion is refused and does not double-charge', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    const aid = start.body.id as string;
    await scoreMain(vid, aid, 80);

    expect((await completeAttempt(vid, aid)).status).toBe(200);
    const replay = await completeAttempt(vid, aid);
    expect(replay.status).toBe(409);
    expect((db.prepare(`SELECT COUNT(*) c FROM payments WHERE idempotency_key=?`).get(`placement:${aid}`) as any).c).toBe(1);
  });
});

describe('Placement integrity — P-3: one coherent waiver lifecycle', () => {
  it('an optional-policy skip records a waiver and that waiver converts', async () => {
    await putProfile(singleComponentPolicy({ requirementMode: 'optional', required: false, passScore: 60 }));
    const vid = makeVisitor();

    const skip = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({ skip: true, reason: 'Candidate opted out' });
    expect(skip.status).toBe(200);
    expect(skip.body.skipped).toBe(true);
    // Canonical status is the one the schema CHECK permits.
    expect((db.prepare('SELECT placement_status FROM visitors WHERE id=?').get(vid) as any).placement_status).toBe('waived');
    // The audited skip must not be a dead end (it was, before this work).
    expect((await convert(vid)).status).toBe(201);
  });

  it('an untouched optional placement still blocks conversion', async () => {
    await putProfile(singleComponentPolicy({ requirementMode: 'optional', required: false, passScore: 60 }));
    const vid = makeVisitor();

    const res = await convert(vid);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/optional/i);
  });

  it('a management waiver of a required component does not fail its minScore', async () => {
    // Two components: one scored (completion requires at least one scored
    // section), one waived by management despite carrying a minScore. The
    // waiver is an authorised exemption, so it must not register as a
    // below-minimum failure.
    await putProfile({
      ...singleComponentPolicy({ passScore: 0 }),
      components: [
        { key: 'main', type: 'written_test', label: 'Main', enabled: true, required: true, weight: 50, maxScore: 100 },
        { key: 'second', type: 'interview', label: 'Second', enabled: true, required: true, weight: 50, maxScore: 100, minScore: 80 },
      ],
    });
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    await scoreMain(vid, start.body.id, 70);
    const waive = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/second`)
      .set(authHeader(owner)).send({ status: 'waived', notes: 'Medical exemption, approved by management.' });
    expect(waive.status).toBe(200);

    const complete = await completeAttempt(vid, start.body.id);
    expect(complete.status).toBe(200);
    expect(complete.body.outcome).toBe('passed');
    expect(complete.body.unmetRequirements).toEqual([]);
  });
});

describe('Placement integrity — P-4: corrections and overrides are atomic and re-derive the outcome', () => {
  it('a score correction can flip a failed sitting to passed and unblock conversion', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid, complete } = await sit(vid, 30);
    expect(complete.body.outcome).toBe('failed');
    expect((await convert(vid)).status).toBe(400);

    const corrected = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/components/main/correct`)
      .set(authHeader(owner)).send({ score: 88, reason: 'Marking error on section 2.' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.outcome).toBe('passed');
    expect((db.prepare('SELECT outcome FROM placement_assessment_attempts WHERE id=?').get(aid) as any).outcome).toBe('passed');
    expect((await convert(vid)).status).toBe(201);
  });

  it('a correction that lowers the score flips passed to failed and re-blocks conversion', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid, complete } = await sit(vid, 90);
    expect(complete.body.outcome).toBe('passed');

    const corrected = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/components/main/correct`)
      .set(authHeader(owner)).send({ score: 20, reason: 'Wrong candidate paper marked.' });
    expect(corrected.body.outcome).toBe('failed');
    expect((await convert(vid)).status).toBe(400);
  });

  it('a rejected correction leaves NO partial state behind', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid } = await sit(vid, 70);
    const before = db.prepare('SELECT total_score, percentage, outcome, recommendation_text FROM placement_assessment_attempts WHERE id=?').get(aid) as any;
    const resultBefore = db.prepare('SELECT score, score_version, corrected_at FROM placement_assessment_results WHERE attempt_id=? AND component_key=?').get(aid, 'main') as any;
    const visitorBefore = db.prepare('SELECT placement_score FROM visitors WHERE id=?').get(vid) as any;

    // Out-of-range score: rejected by validation before anything is written.
    const bad = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/components/main/correct`)
      .set(authHeader(owner)).send({ score: 999, reason: 'Attempted tamper.' });
    expect(bad.status).toBe(400);

    expect(db.prepare('SELECT total_score, percentage, outcome, recommendation_text FROM placement_assessment_attempts WHERE id=?').get(aid)).toEqual(before);
    expect(db.prepare('SELECT score, score_version, corrected_at FROM placement_assessment_results WHERE attempt_id=? AND component_key=?').get(aid, 'main')).toEqual(resultBefore);
    expect(db.prepare('SELECT placement_score FROM visitors WHERE id=?').get(vid)).toEqual(visitorBefore);
  });

  it('an override keeps the attempt row and the visitor copy consistent', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid } = await sit(vid, 80);

    const ok = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/override`)
      .set(authHeader(owner)).send({ levelId: LEVEL_B1, reason: 'Interview indicates a false beginner.' });
    expect(ok.status).toBe(200);

    const row = db.prepare('SELECT override_level_id, recommended_level_id FROM placement_assessment_attempts WHERE id=?').get(aid) as any;
    const visitorScore = JSON.parse((db.prepare('SELECT placement_score FROM visitors WHERE id=?').get(vid) as any).placement_score);
    expect(row.override_level_id).toBe(LEVEL_B1);
    expect(row.recommended_level_id).toBe(LEVEL_B1);
    // Both stores of the same decision agree — the P-4 divergence risk.
    expect(visitorScore.recommendation.levelId).toBe(LEVEL_B1);
    expect(visitorScore.recommendation.overridden).toBe(true);
  });
});

describe('Placement integrity — server authority, authorization and isolation', () => {
  it('client-supplied outcome, percentage and fee are ignored', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    await scoreMain(vid, start.body.id, 10);

    const complete = await completeAttempt(vid, start.body.id, owner, {
      outcome: 'passed', passed: true, percentage: 99, feeCharged: 0, unmetRequirements: [], recommendedLevelId: LEVEL_B1,
    });
    expect(complete.body.outcome).toBe('failed');
    expect(complete.body.decision.percentage).toBe(10);
    expect(complete.body.feeCharged).toBe(300);
  });

  it('scores outside the component range are rejected on scoring and on correction', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    for (const bad of [-1, 101, 'abc', null]) {
      const res = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/main`)
        .set(authHeader(owner)).send({ score: bad });
      if (bad === null) continue; // null is an explicit "not yet scored"
      expect(res.status).toBe(400);
    }
    await scoreMain(vid, start.body.id, 70);
    await completeAttempt(vid, start.body.id);
    const badCorrection = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/main/correct`)
      .set(authHeader(owner)).send({ score: 500, reason: 'tamper' });
    expect(badCorrection.status).toBe(400);
  });

  it('registrar cannot override or correct; manager can', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid } = await sit(vid, 80);

    const deniedOverride = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/override`).set(authHeader(registrar)).send({ levelId: LEVEL_A1, reason: 'x' });
    const deniedCorrect = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/components/main/correct`).set(authHeader(registrar)).send({ score: 90, reason: 'x' });
    expect(deniedOverride.status).toBe(403);
    expect(deniedCorrect.status).toBe(403);

    const allowed = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/override`).set(authHeader(manager)).send({ levelId: LEVEL_A1, reason: 'Manager decision.' });
    expect(allowed.status).toBe(200);
  });

  it('another branch cannot read or mutate this branch placement data', async () => {
    await putProfile(singleComponentPolicy({ passScore: 60 }));
    const vid = makeVisitor();
    const { aid } = await sit(vid, 80);

    const view = await supertest(app).get(`/api/placement/visitors/${vid}/placement`).set(authHeader(managerB));
    const start = await startAttempt(vid, managerB);
    const override = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/override`).set(authHeader(managerB)).send({ levelId: LEVEL_A1, reason: 'x' });
    for (const res of [view, start, override]) expect(res.status).toBe(403);
  });

  it('an attempt cannot be scored or completed after cancellation', async () => {
    await putProfile(singleComponentPolicy({ allowRetake: true, passScore: 60 }));
    const vid = makeVisitor();
    const start = await startAttempt(vid);
    const aid = start.body.id as string;
    await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${aid}/cancel`).set(authHeader(owner)).send({ reason: 'Candidate left.' });

    expect((await scoreMain(vid, aid, 90)).status).toBe(409);
    expect((await completeAttempt(vid, aid)).status).toBe(409);
  });
});
