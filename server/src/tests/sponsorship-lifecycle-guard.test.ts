/**
 * SPL-1 — a terminated sponsorship agreement must never be resurrected.
 * ============================================================================
 * `PATCH /api/funding/sponsorships/:id` accepted any of
 * ('active','completed','terminated') with no transition check, so
 * `active -> terminated -> active` was permitted: a historical, closed
 * commitment could silently become live again.
 *
 * The state machine implied by the schema CHECK and the domain is:
 *
 *     active ──▶ completed   (ran its course)
 *     active ──▶ terminated  (ended early)
 *     completed / terminated ──▶ (nothing — both are terminal)
 *
 * Renewal is expressed the way the repository already expresses it: POST a NEW
 * agreement. There is no renewal/reactivation endpoint to reuse, and inventing
 * one would be inventing business policy — so the historical row stays
 * immutable and a fresh agreement carries the new commitment.
 *
 * Financial authority is unaffected either way: `resolveAuthorizedDiscount`
 * reads `student_discount_authorizations`, never `sponsorship_agreements`
 * (proven in system-closure-authorities.test.ts). This guard is about
 * lifecycle integrity and auditability of the funding record itself.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import fundingRouter from '../routes/funding.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { resolveAuthorizedDiscount } from '../core/configuration/discount-authority.js';

const BRANCH_A = 'spl_branch_a';
const BRANCH_B = 'spl_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/funding', fundingRouter);
  app.use(errorHandler);
  return app;
}
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: express.Express;
let ownerA: TokenPayload;
let ownerB: TokenPayload;

let seq = 0;
function seedAgreement(status: 'active' | 'completed' | 'terminated', branch = BRANCH_A): string {
  const id = `spl_sa_${++seq}`;
  db.prepare(
    `INSERT INTO sponsorship_agreements (id, donor_id, student_id, monthly_amount, start_date, end_date, status, branch_id)
     VALUES (?, 'spl_donor', 'spl_student', 1000, ?, ?, ?, ?)`
  ).run(id, today(), today(), status, branch);
  return id;
}
const statusOf = (id: string) =>
  (db.prepare('SELECT status FROM sponsorship_agreements WHERE id = ?').get(id) as { status: string }).status;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const b of [BRANCH_A, BRANCH_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, b, 'Loc');
  }
  const hash = await hashPassword('testpass123');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('spl_u_a', 'spl_u_a', 'Owner A', 'owner', ?, ?, 1, 0)`
  ).run(BRANCH_A, hash);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('spl_u_b', 'spl_u_b', 'Manager B', 'manager', ?, ?, 1, 0)`
  ).run(BRANCH_B, hash);
  syncLegacyUserRoles(db);
  db.prepare(`INSERT OR IGNORE INTO donors (id, full_name) VALUES ('spl_donor', 'SPL Donor')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES ('spl_student', 'TH-SPL-1', 'SPL Student', 'active', ?, ?, 'male', '0700444001')`
  ).run(today(), BRANCH_A);
  ownerA = { userId: 'spl_u_a', username: 'spl_u_a', role: 'owner', branchId: BRANCH_A, fullName: 'Owner A' } as TokenPayload;
  ownerB = { userId: 'spl_u_b', username: 'spl_u_b', role: 'manager', branchId: BRANCH_B, fullName: 'Manager B' } as TokenPayload;
  app = createApp();
});

describe('SPL-1 — legal transitions still work', () => {
  it('active -> terminated succeeds', async () => {
    const id = seedAgreement('active');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'terminated' });
    expect(res.status).toBe(200);
    expect(statusOf(id)).toBe('terminated');
  });

  it('active -> completed succeeds', async () => {
    const id = seedAgreement('active');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(statusOf(id)).toBe('completed');
  });

  it('a non-status edit on an ACTIVE agreement still works', async () => {
    const id = seedAgreement('active');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ monthlyAmount: 2500 });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT monthly_amount, status FROM sponsorship_agreements WHERE id = ?').get(id) as
      { monthly_amount: number; status: string };
    expect(row.monthly_amount).toBe(2500);
    expect(row.status).toBe('active');
  });
});

describe('SPL-1 — terminal states are terminal', () => {
  it('terminated -> active is REFUSED (this succeeded with 200 before)', async () => {
    const id = seedAgreement('terminated');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(statusOf(id)).toBe('terminated');
  });

  it('completed -> active is REFUSED', async () => {
    const id = seedAgreement('completed');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(statusOf(id)).toBe('completed');
  });

  it('terminated -> completed is REFUSED (no terminal-to-terminal laundering)', async () => {
    const id = seedAgreement('terminated');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'completed' });
    expect(res.status).toBe(409);
    expect(statusOf(id)).toBe('terminated');
  });

  it('a money edit cannot mutate a TERMINATED agreement either (history is immutable)', async () => {
    const id = seedAgreement('terminated');
    const before = db.prepare('SELECT monthly_amount FROM sponsorship_agreements WHERE id = ?').get(id) as { monthly_amount: number };
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ monthlyAmount: 999999 });
    expect(res.status).toBe(409);
    const after = db.prepare('SELECT monthly_amount FROM sponsorship_agreements WHERE id = ?').get(id) as { monthly_amount: number };
    expect(after.monthly_amount).toBe(before.monthly_amount);
  });

  it('re-terminating an already terminated agreement is refused, not a silent no-op', async () => {
    const id = seedAgreement('terminated');
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerA))
      .send({ status: 'terminated' });
    expect(res.status).toBe(409);
  });
});

describe('SPL-1 — renewal happens by creating a NEW agreement', () => {
  it('a fresh agreement can be created for the same donor+student after termination', async () => {
    const oldId = seedAgreement('terminated');
    const res = await supertest(app)
      .post('/api/funding/sponsorships')
      .set(authHeader(ownerA))
      .send({
        donorId: 'spl_donor', studentId: 'spl_student', monthlyAmount: 1500,
        startDate: today(), endDate: today(), branchId: BRANCH_A,
      });
    expect([200, 201]).toContain(res.status);
    // The historical row is untouched — auditability preserved.
    expect(statusOf(oldId)).toBe('terminated');
    const live = db
      .prepare(`SELECT COUNT(*) AS c FROM sponsorship_agreements WHERE student_id = 'spl_student' AND status = 'active'`)
      .get() as { c: number };
    expect(live.c).toBeGreaterThanOrEqual(1);
  });
});

describe('SPL-1 — authority and isolation are unchanged', () => {
  it('a terminated sponsorship grants no discount authority before or after the attempt', async () => {
    const id = seedAgreement('terminated');
    const before = resolveAuthorizedDiscount(db, 'spl_student', 100, { branchId: BRANCH_A }).percent;
    await supertest(app).patch(`/api/funding/sponsorships/${id}`).set(authHeader(ownerA)).send({ status: 'active' });
    const after = resolveAuthorizedDiscount(db, 'spl_student', 100, { branchId: BRANCH_A }).percent;
    expect(after).toBe(before);
    expect(after).toBeLessThanOrEqual(20); // ordinary ceiling; no sponsorship authorization exists
  });

  it('cross-branch manipulation is refused', async () => {
    const id = seedAgreement('active', BRANCH_A);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(authHeader(ownerB))
      .send({ status: 'terminated' });
    expect(res.status).toBe(403);
    expect(statusOf(id)).toBe('active');
  });
});

describe('SPL-1 — concurrent transitions cannot create an invalid state', () => {
  it('two simultaneous terminate/reactivate attempts leave exactly one terminal state', async () => {
    const id = seedAgreement('active');
    const [a, b] = await Promise.all([
      supertest(app).patch(`/api/funding/sponsorships/${id}`).set(authHeader(ownerA)).send({ status: 'terminated' }),
      supertest(app).patch(`/api/funding/sponsorships/${id}`).set(authHeader(ownerA)).send({ status: 'terminated' }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(200);   // exactly one winner
    expect(codes[1]).toBe(409);   // the loser sees a terminal state
    expect(statusOf(id)).toBe('terminated');
  });

  it('a reactivation racing a termination can never win', async () => {
    const id = seedAgreement('active');
    const [term, react] = await Promise.all([
      supertest(app).patch(`/api/funding/sponsorships/${id}`).set(authHeader(ownerA)).send({ status: 'terminated' }),
      supertest(app).patch(`/api/funding/sponsorships/${id}`).set(authHeader(ownerA)).send({ status: 'active' }),
    ]);
    expect(term.status).toBe(200);
    // 'active' -> 'active' is a no-op transition and 'terminated' -> 'active'
    // is refused; either way the agreement must not end up live.
    expect(statusOf(id)).toBe('terminated');
    expect([200, 409]).toContain(react.status);
  });
});
