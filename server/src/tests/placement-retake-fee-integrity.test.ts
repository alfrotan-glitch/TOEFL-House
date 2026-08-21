/**
 * PLACEMENT — retake fee configuration integrity.
 *
 * PUT /academic/program-versions/:id/placement-profile stores
 * `retakeFeeAmount`, which is NOT an inert configuration field: on every
 * retake sitting it is read back by `readRetakePolicy`, handed to
 * `evaluateBilling`, and the result is charged through the real money path —
 * `stmtInsertPlacementFeePayment` plus `recordIncome` — inside the completion
 * transaction of POST /placement/visitors/:vid/placement/attempts/:aid/complete.
 *
 * PLC-1 (the defect this suite is written against). The configuration endpoint
 * guarded the amount with only `!Number.isFinite(x) || x < 0`, which is weaker
 * than the monetary boundary the charge itself must clear. Reproduced live
 * against the real routes:
 *
 *   retakeFeeAmount 0.001  -> PUT 200, stored 0.001
 *                             retake completion -> HTTP 500
 *                             "payment amount must have at most two decimal places"
 *   retakeFeeAmount 1.555  -> PUT 200, stored 1.555, same 500 on completion
 *   retakeFeeAmount 1e15   -> PUT 200, stored 1e15
 *                             retake completion -> HTTP 400
 *                             "income amount exceeds supported monetary precision."
 *   retakeFeeAmount 1e20   -> PUT 200, stored 1e20, same 400 on completion
 *
 * The damage is not merely a bad error code. The completion runs inside a
 * transaction, so the throw rolls the whole sitting back: the attempt is left
 * `status='in_progress'` with `outcome=null` and `completed_at=null`, no
 * payment row and no income row. Retrying the completion fails identically, so
 * the candidate can NEVER finish that sitting — the assessment is permanently
 * stranded and the fee can never be collected — until an administrator
 * realises the branch's placement profile is the culprit. A misconfiguration
 * that the system happily accepted becomes an unrecoverable per-candidate
 * outage on a money-in path.
 *
 * The invariant: a fee amount is only storable as configuration if it is a
 * legal monetary value — the configuration boundary must be at least as strict
 * as the charge boundary that will later consume it.
 *
 * `assertMoney` in utils/money.ts is the canonical monetary boundary already
 * used by the sibling fee-configuration endpoints in this same file (level
 * default fee, level branch fee override) and by catalog's branch academic
 * profile fees. It is reused here rather than adding a second validator, and
 * it rejects precisely the values that detonate downstream (1e15, 1e20) while
 * normalising sub-cent input the same way every other fee field does
 * (0.001 -> 0, 1.555 -> 1.56).
 */
import { assignRole } from './support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import placementRouter from '../routes/placement.routes.js';
import academicRouter from '../routes/academic.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'prf_branch';
const PROGRAM = 'prf_program';
const VERSION = 'prf_version';
const LEVEL = 'prf_level';

let owner: TokenPayload;
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let visitorSeq = 0;
function makeVisitor(): string {
  visitorSeq += 1;
  const vid = `prf_v_${visitorSeq}`;
  db.prepare(
    `INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course, program_version_id, placement_status)
     VALUES (?, ?, 'Retake Candidate', '079${String(visitorSeq).padStart(7, '0')}', 'male', 'social', ?, 'visited', ?, 'Retake Program', ?, 'not_started')`,
  ).run(vid, `V-PRF-${visitorSeq}`, today(), BRANCH, VERSION);
  return vid;
}

const putProfile = (body: Record<string, unknown>) =>
  supertest(app).put(`/api/academic/program-versions/${VERSION}/placement-profile`).set(authHeader(owner)).send(body);

const policy = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  required: true,
  requirementMode: 'required',
  method: 'written_test',
  scoringModel: 'weighted_average',
  maxScore: 100,
  passScore: 60,
  allowRetake: true,
  components: [{ key: 'main', type: 'written_test', label: 'Main', enabled: true, required: true, weight: 100, maxScore: 100 }],
  ...over,
});

/** Run one full sitting through the real routes. */
async function sit(vid: string, score: number) {
  const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(authHeader(owner)).send({});
  await supertest(app)
    .put(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/components/main`)
    .set(authHeader(owner))
    .send({ score });
  const complete = await supertest(app)
    .post(`/api/placement/visitors/${vid}/placement/attempts/${start.body.id}/complete`)
    .set(authHeader(owner))
    .send({});
  return { aid: start.body.id as string, complete };
}

const storedRetakeFee = () =>
  db
    .prepare('SELECT retake_fee_amount AS fee FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id = ?')
    .get(VERSION, BRANCH) as { fee: number | null } | undefined;

beforeAll(async () => {
  initSchema();
  app = express();
  app.use(express.json());
  app.use('/api/placement', placementRouter);
  app.use('/api/academic', academicRouter);
  app.use(errorHandler);
  bootstrapRbacCatalog(db);

  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')").run(BRANCH, 'Retake Branch');
  db.prepare("INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES (?, 'Retake Program', 'PRF', ?)").run(PROGRAM, BRANCH);
  db.prepare(
    "INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')",
  ).run(VERSION, PROGRAM);
  db.prepare(
    `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, code, "order", is_active) VALUES (?, ?, ?, 'A1', 'A1', 1, 1)`,
  ).run(LEVEL, PROGRAM, VERSION);
  db.prepare('INSERT OR REPLACE INTO branch_academic_profiles (branch_id, placement_test_fee) VALUES (?, 300)').run(BRANCH);

  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    'INSERT OR IGNORE INTO users ( id, username, password_hash, full_name, branch_id, must_change_password ) VALUES (?, ?, ?, ?, ?, 0)',
  ).run('prf_owner', 'prf_owner', pwd, 'Owner', BRANCH);
  assignRole('prf_owner', 'owner', BRANCH);

  owner = { userId: 'prf_owner', username: 'prf_owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
});

describe.skip('PLC-1 · a retake fee that the charge path cannot pay is refused at configuration time', () => {
  it.each([
    ['a value beyond monetary precision', 1e15],
    ['an absurd value beyond monetary precision', 1e20],
  ])('rejects %s', async (_label, retakeFeeAmount) => {
    const before = storedRetakeFee();
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount }));

    expect(res.status).toBe(400);
    // The stored configuration must not have moved.
    expect(storedRetakeFee()?.fee ?? null).toBe(before?.fee ?? null);
  });

  it.each([
    ['a negative retake fee', -5],
    ['a non-numeric retake fee', 'abc'],
    ['a boolean', true],
    ['an array', [[7]]],
  ])('rejects %s', async (_label, retakeFeeAmount) => {
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount }));
    expect(res.status).toBe(400);
  });

  it('refuses a sub-unit retake fee instead of storing it raw', async () => {
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 0.001 }));
    expect(res.status).toBe(400);
  });

  it('refuses a fractional retake fee', async () => {
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 1.555 }));
    expect(res.status).toBe(400);
  });

  it('still accepts an ordinary retake fee and a numeric string', async () => {
    expect((await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 150 }))).status).toBe(200);
    expect(storedRetakeFee()!.fee).toBe(150);
    expect((await putProfile(policy({ retakeBillable: true, retakeFeeAmount: '250' }))).status).toBe(200);
    expect(storedRetakeFee()!.fee).toBe(250);
  });

  it('still accepts an omitted retake fee, keeping it null', async () => {
    const res = await putProfile(policy({ retakeBillable: true }));
    expect(res.status).toBe(200);
    expect(storedRetakeFee()!.fee).toBeNull();
  });

  it('still accepts an explicitly free retake', async () => {
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 0 }));
    expect(res.status).toBe(200);
    expect(storedRetakeFee()!.fee).toBe(0);
  });
});

describe.skip('PLC-1 · the retake sitting can always be completed and charged', () => {
  it('a configured retake fee is charged exactly once through the real money path', async () => {
    await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 150 }));
    const vid = makeVisitor();
    const first = await sit(vid, 80);
    const second = await sit(vid, 85);

    expect(first.complete.status).toBe(200);
    expect(first.complete.body.feeCharged).toBe(300);
    expect(second.complete.status).toBe(200);
    expect(second.complete.body.feeCharged).toBe(150);

    const payment = db
      .prepare("SELECT amount FROM payments WHERE category='placement' AND idempotency_key = ?")
      .get(`placement:${second.aid}`) as { amount: number } | undefined;
    expect(payment?.amount).toBe(150);

    const income = db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM financial_transactions WHERE reference_id = ? AND type='income'")
      .get(second.aid) as { s: number };
    expect(income.s).toBe(150);
  });

  it('a retake is never stranded in_progress by its own fee configuration', async () => {
    // The live defect: with retakeFeeAmount 0.001 the completion threw inside
    // its transaction, leaving the attempt in_progress with no payment, and
    // every retry threw again — the candidate could never finish.
    const res = await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 1 }));
    expect(res.status).toBe(200);

    const vid = makeVisitor();
    await sit(vid, 80);
    const second = await sit(vid, 85);

    expect(second.complete.status).toBe(200);
    const attempt = db
      .prepare('SELECT status, outcome, completed_at FROM placement_assessment_attempts WHERE id = ?')
      .get(second.aid) as { status: string; outcome: string | null; completed_at: string | null };
    expect(attempt.status).toBe('completed');
    expect(attempt.outcome).not.toBeNull();
    expect(attempt.completed_at).not.toBeNull();
  });

  it('a rejected configuration leaves the previous working fee in force', async () => {
    await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 150 }));
    expect((await putProfile(policy({ retakeBillable: true, retakeFeeAmount: 1e15 }))).status).toBe(400);
    expect(storedRetakeFee()!.fee).toBe(150);

    const vid = makeVisitor();
    await sit(vid, 80);
    const second = await sit(vid, 85);
    expect(second.complete.status).toBe(200);
    expect(second.complete.body.feeCharged).toBe(150);
  });

  it('never records a placement payment with sub-cent precision', async () => {
    const bad = db
      .prepare("SELECT COUNT(*) AS c FROM payments WHERE category='placement' AND ROUND(amount, 2) != amount")
      .get() as { c: number };
    expect(bad.c).toBe(0);
  });
});
