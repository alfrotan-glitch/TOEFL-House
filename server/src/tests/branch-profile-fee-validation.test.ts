/**
 * CFG-2 / CFG-3 / CFG-4 — branch academic profile fee configuration.
 *
 * `PUT /api/catalog/branch-profile/:branchId` wrote request values straight
 * into `branch_academic_profiles` (REAL NOT NULL columns) with no validation:
 *   b.placementTestFee ?? null
 * Reproduced live: -100, 0.001, 1e20 and the TEXT values "abc" / "NaN" /
 * "Infinity" all persisted into a REAL money column.
 *
 * CFG-3: `resolveFee()` only checks Number.isFinite, so -100 and 0.001 became
 * authoritative money and failed LATE inside Finance — 0.001 produced a
 * HTTP 500 "payment amount must have at most two decimal places".
 * Invalid configuration must be rejected at the WRITE, not at the payment.
 *
 * CFG-4: a partial PUT against a branch with no existing row sent NULL into
 * NOT NULL columns; COALESCE only protects the ON CONFLICT branch, so the
 * first write for a branch returned HTTP 500.
 *
 * Boundaries below are the CANONICAL ones proven by executing assertMoney:
 *   -100 reject · 0 accept · 0.001 -> rounds to 0 · 1e6 accept
 *   1e15 reject (precision) · "500" accept · "abc"/bool/array/object reject
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import catalogRouter from '../routes/catalog.routes.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';

const BR_A = 'bpf_branch_a';
const BR_B = 'bpf_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/catalog', catalogRouter);
  app.use(errorHandler);
  return app;
}
const OWNER: TokenPayload = { userId: 'bpf_owner', username: 'bpf_owner', role: 'owner', branchId: BR_A, fullName: 'BPF Owner' };
const MGR_A: TokenPayload = { userId: 'bpf_mgr_a', username: 'bpf_mgr_a', role: 'manager', branchId: BR_A, fullName: 'BPF Manager A' };
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: ReturnType<typeof createApp>;

/** A complete, valid profile payload — the baseline every case mutates. */
const validProfile = () => ({
  placementTestFee: 300,
  registrationFee: 0,
  cardFee: 200,
  diplomaFee: 500,
  defaultPassMark: 60,
  defaultMinAttendance: 75,
  academicYearLabel: '2026',
  notes: 'baseline',
});

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('bpf_campus', FIXED_ORG_ID, 'BPF Campus', 'BPF');
  for (const b of [BR_A, BR_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
      .run(b, b, 'Loc', 'bpf_campus');
  }
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?,?,?,?,?,?,1,0)`,
  ).run(OWNER.userId, OWNER.username, OWNER.fullName, 'owner', BR_A, await hashPassword('testpass123'));
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?,?,?,?,?,?,1,0)`,
  ).run(MGR_A.userId, MGR_A.username, MGR_A.fullName, 'manager', BR_A, await hashPassword('testpass123'));
  syncLegacyUserRoles(db);
  app = createApp();
});

beforeEach(async () => {
  db.prepare('DELETE FROM branch_academic_profiles WHERE branch_id IN (?,?)').run(BR_A, BR_B);
  await supertest(app).put(`/api/catalog/branch-profile/${BR_A}`).set(auth(OWNER)).send(validProfile());
});

const feeOf = (branchId: string) =>
  db.prepare('SELECT placement_test_fee AS f FROM branch_academic_profiles WHERE branch_id = ?').get(branchId) as
    | { f: unknown }
    | undefined;

describe('CFG-2 · invalid fee values are rejected at the configuration write', () => {
  it.each([
    ['negative', -100],
    ['non-finite text "abc"', 'abc'],
    ['non-finite text "NaN"', 'NaN'],
    ['non-finite text "Infinity"', 'Infinity'],
    ['boolean true', true],
    ['boolean false', false],
    ['empty array', []],
    ['array [500]', [500]],
    ['object', {}],
    ['beyond monetary precision 1e15', 1e15],
    ['beyond monetary precision 1e20', 1e20],
  ])('rejects %s and leaves the stored fee untouched', async (_label, value) => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: value });

    expect(res.status).toBe(400);
    // The previous valid configuration must survive a rejected write.
    expect(feeOf(BR_A)?.f).toBe(300);
  });

  it.each([
    ['zero', 0, 0],
    ['integer', 1, 1],
    ['typical fee', 500, 500],
    ['two decimals', 500.25, 500.25],
    ['numeric string', '500', 500],
    ['numeric string with decimals', '500.00', 500],
    ['large but supported', 1e6, 1e6],
  ])('accepts %s and stores the canonical number', async (_label, value, expected) => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: value });

    expect(res.status).toBe(200);
    const stored = feeOf(BR_A)?.f;
    expect(stored).toBe(expected);
    expect(typeof stored).toBe('number');
  });

  it('a sub-cent fee cannot silently become a different amount', async () => {
    // 0.001 is not representable as money. Canonical rounding would turn it
    // into 0 — a free fee created by a typo. Either it is rejected, or it is
    // stored as exactly the canonical value; it may never persist as 0.001.
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: 0.001 });

    expect(res.status).toBe(400);
    expect(feeOf(BR_A)?.f).toBe(300);
  });

  it('every fee column is validated, not just the first', async () => {
    for (const field of ['placementTestFee', 'registrationFee', 'cardFee', 'diplomaFee']) {
      const res = await supertest(app)
        .put(`/api/catalog/branch-profile/${BR_A}`)
        .set(auth(OWNER))
        .send({ ...validProfile(), [field]: -1 });
      expect(res.status, `${field} must reject a negative fee`).toBe(400);
    }
  });

  it('a stored fee is always a number, never TEXT affinity', async () => {
    await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: 'abc' });
    const t = db
      .prepare('SELECT typeof(placement_test_fee) AS t FROM branch_academic_profiles WHERE branch_id = ?')
      .get(BR_A) as { t: string };
    expect(t.t).toBe('real');
  });
});

describe('CFG-3 · invalid configuration never becomes authoritative money', () => {
  it('resolveFee never returns a negative fee after a rejected write', async () => {
    await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: -100 });

    const fee = resolveFee(db, BR_A, 'placementTestFee');
    expect(fee).toBeGreaterThanOrEqual(0);
    expect(fee).toBe(300);
  });

  it('resolveFee never returns a sub-cent or precision-breaking fee', async () => {
    for (const bad of [0.001, 1e15, 1e20]) {
      await supertest(app)
        .put(`/api/catalog/branch-profile/${BR_A}`)
        .set(auth(OWNER))
        .send({ ...validProfile(), placementTestFee: bad });
    }
    const fee = resolveFee(db, BR_A, 'placementTestFee');
    expect(fee).toBe(300);
    // Two decimal places is the canonical monetary precision.
    expect(Math.round(fee * 100)).toBe(fee * 100);
  });

  it('valid configuration still resolves correctly', async () => {
    await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: 450 });
    expect(resolveFee(db, BR_A, 'placementTestFee')).toBe(450);
  });
});

describe('CFG-4 · branch-profile API contract', () => {
  it('the first write for a branch with no existing row succeeds', async () => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_B}`)
      .set(auth(OWNER))
      .send(validProfile());
    expect(res.status).toBe(200);
    expect(feeOf(BR_B)?.f).toBe(300);
  });

  it('a partial payload never returns a 500 — it is either applied or refused', async () => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_B}`)
      .set(auth(OWNER))
      .send({ placementTestFee: 300 });
    expect(res.status).not.toBe(500);
  });

  it('a partial payload on an EXISTING row preserves the untouched fees', async () => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ placementTestFee: 350 });
    expect(res.status).not.toBe(500);
    if (res.status === 200) {
      const row = db
        .prepare('SELECT placement_test_fee p, card_fee c, diploma_fee d FROM branch_academic_profiles WHERE branch_id = ?')
        .get(BR_A) as { p: number; c: number; d: number };
      expect(row.p).toBe(350);
      expect(row.c).toBe(200); // untouched
      expect(row.d).toBe(500); // untouched
    }
  });

  it('an invalid value in a partial payload is still rejected', async () => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ placementTestFee: -5 });
    expect(res.status).toBe(400);
    expect(feeOf(BR_A)?.f).toBe(300);
  });
});

describe('CFG-2 · historical money is never mutated by a configuration change', () => {
  it('changing a valid fee does not alter an already issued payment', async () => {
    const payId = 'bpf_pay_1';
    db.prepare(
      `INSERT INTO payments (id, student_id, amount, date, payment_method, category, notes, receipt_number, branch_id, idempotency_key)
       VALUES (?, NULL, 300, date('now'), 'cash', 'placement', 'historical', 'BPF-R1', ?, ?)`,
    ).run(payId, BR_A, 'bpf-idem-1');

    await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), placementTestFee: 900 });

    const after = db.prepare('SELECT amount FROM payments WHERE id = ?').get(payId) as { amount: number };
    expect(after.amount).toBe(300);
    expect(resolveFee(db, BR_A, 'placementTestFee')).toBe(900);
  });
});

describe('CFG-2 · non-money profile fields are bounded', () => {
  it.each([
    ['pass mark above 100', 'defaultPassMark', 150],
    ['negative pass mark', 'defaultPassMark', -1],
    ['attendance above 100', 'defaultMinAttendance', 101],
    ['negative attendance', 'defaultMinAttendance', -5],
  ])('rejects %s', async (_label, field, value) => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), [field]: value });
    expect(res.status).toBe(400);
  });

  it.each([
    ['text', 'abc'],
    ['boolean', true],
    ['array', [50]],
    ['object', {}],
  ])('rejects a non-finite pass mark (%s)', async (_label, value) => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), defaultPassMark: value });
    expect(res.status).toBe(400);
  });

  it('accepts valid pass mark and attendance bounds', async () => {
    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_A}`)
      .set(auth(OWNER))
      .send({ ...validProfile(), defaultPassMark: 0, defaultMinAttendance: 100 });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT default_pass_mark p, default_min_attendance a FROM branch_academic_profiles WHERE branch_id = ?')
      .get(BR_A) as { p: number; a: number };
    expect(row.p).toBe(0);
    expect(row.a).toBe(100);
  });
});

describe('CFG-2 · branch isolation on configuration writes', () => {
  it('a branch manager cannot write another branch profile', async () => {
    // Seed BR_B with a known value through the owner.
    await supertest(app).put(`/api/catalog/branch-profile/${BR_B}`).set(auth(OWNER)).send(validProfile());

    const res = await supertest(app)
      .put(`/api/catalog/branch-profile/${BR_B}`)
      .set(auth(MGR_A))
      .send({ ...validProfile(), placementTestFee: 999 });

    expect(res.status).toBe(403);
    const row = db
      .prepare('SELECT placement_test_fee f FROM branch_academic_profiles WHERE branch_id = ?')
      .get(BR_B) as { f: number };
    expect(row.f).toBe(300); // unchanged by the rejected cross-branch write
  });

  it('a branch manager cannot read another branch profile', async () => {
    const res = await supertest(app).get(`/api/catalog/branch-profile/${BR_B}`).set(auth(MGR_A));
    expect(res.status).toBe(403);
  });
});
