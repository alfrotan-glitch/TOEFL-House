/**
 * FUNDING — recurring-commitment and campaign-target amount integrity.
 *
 * The funding subsystem validates money on the way IN through `assertMoney`
 * for donations, scholarship budgets and scholarship awards. Three money
 * columns escaped that boundary. All three were reproduced live on a fresh
 * database before this suite was written:
 *
 * FND-1 · POST /funding/sponsorships
 *   The handler computed `validatedMonthly = assertMoney(monthlyAmount, ...)`
 *   and then inserted the RAW body value instead. `assertMoney(1.555)` is 2
 *   in the canonical whole-afghani unit, but 1.555 was what landed in
 *   `sponsorship_agreements.monthly_amount` (HTTP 201, stored 1.555). The
 *   validated value was computed and discarded,
 *   so the column held sub-cent precision the money authority forbids.
 *
 * FND-2 · PATCH /funding/sponsorships/:id
 *   `monthlyAmount` was written with no validation whatsoever:
 *     -99999 -> HTTP 200, stored -99999  (a negative recurring commitment)
 *     'abc'  -> HTTP 200, stored 'abc'   (typeof text in a REAL NOT NULL column)
 *     0.001  -> HTTP 200, stored 0.001
 *     true   -> HTTP 500, driver text "SQLite3 can only bind numbers..." leaked
 *
 * FND-3 · PATCH /funding/campaigns/:id
 *   Identical hole on `targetAmount`: 'abc', -5000 and 0.001 all stored, and
 *   `true` produced the same leaked 500.
 *
 * Why this is a real defect and not cosmetic: `monthly_amount` and
 * `target_amount` are declared `REAL NOT NULL` with no CHECK, so SQLite's
 * dynamic typing stores the string happily and there is no DB backstop. A
 * poisoned row then corrupts every aggregate over the column. Proven live:
 * with targets of 100000 and 50000, `SUM(target_amount)` is 150000; after one
 * PATCH of 'abc' onto the first campaign, `SUM(target_amount)` returns 50000 —
 * SQLite coerces the text to 0 and the 100000 target silently VANISHES from
 * the total. The JSON reads return the raw string, so the client-side reducer
 * `campaigns.reduce((s, c) => s + c.targetAmount, 0)` produces the string
 * "0abc50000" instead of a number.
 *
 * The invariant: every stored funding amount is a validated monetary value —
 * the same value that was validated is the value that is persisted, on create
 * and on update alike.
 *
 * `assertMoney` in utils/money.ts is the canonical monetary boundary already
 * used by this very file for donations, scholarship budgets and awards. It is
 * reused here rather than adding a second validator. Amounts on these two
 * endpoints are commitments/targets rather than cash movements, so zero stays
 * legal (a paused sponsorship, an untargeted campaign) while negatives,
 * non-finite values, non-numeric types and sub-cent precision are rejected —
 * exactly what assertMoney enforces.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { fundingRouter } from '../routes/funding.routes.js';

const BR = 'fnd_branch';
const DONOR = 'fnd_donor';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/funding', fundingRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string, branchId = BR): TokenPayload & { role: string } => ({ role,
  userId,
  username: userId,
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const OWNER = tok('fnd_owner', 'owner');

let app: ReturnType<typeof createApp>;
let seq = 0;

async function makeSponsorship(monthlyAmount: unknown = 1000) {
  const res = await supertest(app)
    .post('/api/funding/sponsorships')
    .set(auth(OWNER))
    .send({ donorId: DONOR, monthlyAmount, startDate: '2026-01-01', endDate: '2026-12-31' });
  return res;
}

async function makeCampaign(targetAmount: unknown = 100000) {
  const res = await supertest(app)
    .post('/api/funding/campaigns')
    .set(auth(OWNER))
    .send({ name: `FND Campaign ${++seq}`, targetAmount, startDate: '2026-01-01' });
  return res;
}

const sponsorshipRow = (id: string) =>
  db.prepare('SELECT monthly_amount, typeof(monthly_amount) AS ty, status FROM sponsorship_agreements WHERE id = ?').get(id) as
    | { monthly_amount: unknown; ty: string; status: string }
    | undefined;

const campaignRow = (id: string) =>
  db.prepare('SELECT target_amount, typeof(target_amount) AS ty FROM funding_campaigns WHERE id = ?').get(id) as
    | { target_amount: unknown; ty: string }
    | undefined;

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('fnd_campus', FIXED_ORG_ID, 'FND Campus', 'FND');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'fnd_campus');
  const pw = await hashPassword('testpass123');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(OWNER.userId, OWNER.username, OWNER.fullName, OWNER.branchId, pw);
  assignRole(OWNER.userId, OWNER.role, OWNER.branchId);

  db.prepare('INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?,?,?)').run(DONOR, 'FND Donor', 'individual');
  db.prepare(
    "INSERT OR REPLACE INTO finance_accounts (id,scope_type,scope_id,main_balance,saving_balance) VALUES ('fa_fnd','branch',?,100000,10000)",
  ).run(BR);
  app = createApp();
});

describe('FND-1 · a created sponsorship persists the validated amount', () => {
  it('refuses a fractional monthly amount rather than storing a different one', async () => {
    const res = await makeSponsorship(1.555);
    expect(res.status).toBe(400);
  });

  it('refuses another fractional monthly amount', async () => {
    const res = await makeSponsorship(2.999);
    expect(res.status).toBe(400);
  });

  it('stores a numeric string as a number', async () => {
    const res = await makeSponsorship('750');
    expect(res.status).toBe(201);
    const row = sponsorshipRow(res.body.id)!;
    expect(row.monthly_amount).toBe(750);
    expect(row.ty).toBe('integer');
  });

  it('keeps an ordinary amount exactly as given', async () => {
    const res = await makeSponsorship(1000);
    expect(res.status).toBe(201);
    expect(sponsorshipRow(res.body.id)!.monthly_amount).toBe(1000);
  });
});

describe('FND-2 · PATCH /funding/sponsorships/:id validates the monthly amount', () => {
  it.each([
    ['a negative recurring commitment', -99999],
    ['a non-numeric string', 'abc'],
    ['a boolean', true],
    ['an array', [[7]]],
    ['a value beyond monetary precision', 1e15],
  ])('rejects %s and leaves the stored amount untouched', async (_label, monthlyAmount) => {
    const created = await makeSponsorship(1000);
    expect(created.status).toBe(201);
    const id = created.body.id;

    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount });

    expect(res.status).toBe(400);
    const row = sponsorshipRow(id)!;
    expect(row.monthly_amount).toBe(1000);
    expect(row.ty).toBe('integer');
  });

  it('stores a numeric string on update as a number, never as TEXT', async () => {
    // Class-R probe (TR-4): the VALIDATED value must be what the update writes.
    // If the raw body string were written instead (funding mutant F3), only the
    // column's affinity would hide it — this pin keeps that observable.
    const created = await makeSponsorship(1000);
    const id = created.body.id;
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: '1250' });
    expect(res.status).toBe(200);
    const row = sponsorshipRow(id)!;
    expect(row.monthly_amount).toBe(1250);
    expect(row.ty).toBe('integer');
  });

  it('treats a JSON-untransmittable Infinity (which arrives as null) as an absent field', async () => {
    // JSON.stringify(Infinity) is `null`, so a client cannot actually transmit
    // Infinity over HTTP. Null is the "leave this field alone" signal, which is
    // the fail-safe reading: the stored amount must not change.
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: Number.POSITIVE_INFINITY });
    expect(res.status).toBe(200);
    expect(sponsorshipRow(created.body.id)!.monthly_amount).toBe(1000);
  });

  it('does not leak SQLite driver internals as a 500', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SQLite3');
  });

  it('refuses a fractional update instead of storing a different amount', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: 1.555 });
    expect(res.status).toBe(400);
  });

  it('still accepts a legitimate amount change', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: 2500 });
    expect(res.status).toBe(200);
    expect(sponsorshipRow(created.body.id)!.monthly_amount).toBe(2500);
  });

  it('accepts zero — a paused commitment is legal, a negative one is not', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ monthlyAmount: 0 });
    expect(res.status).toBe(200);
    expect(sponsorshipRow(created.body.id)!.monthly_amount).toBe(0);
  });

  it('leaves the amount alone when the field is absent from the patch', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ endDate: '2027-06-30' });
    expect(res.status).toBe(200);
    const row = sponsorshipRow(created.body.id)!;
    expect(row.monthly_amount).toBe(1000);
    expect(
      (db.prepare('SELECT end_date FROM sponsorship_agreements WHERE id = ?').get(created.body.id) as { end_date: string }).end_date,
    ).toBe('2027-06-30');
  });

  it('still rejects an invalid status', async () => {
    const created = await makeSponsorship(1000);
    const res = await supertest(app)
      .patch(`/api/funding/sponsorships/${created.body.id}`)
      .set(auth(OWNER))
      .send({ status: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

describe('FND-3 · PATCH /funding/campaigns/:id validates the target amount', () => {
  it.each([
    ['a non-numeric string', 'abc'],
    ['a negative target', -5000],
    ['a boolean', true],
    ['an array', [[7]]],
    ['a value beyond monetary precision', 1e15],
  ])('rejects %s and leaves the stored target untouched', async (_label, targetAmount) => {
    const created = await makeCampaign(100000);
    expect(created.status).toBe(201);
    const id = created.body.id;

    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${id}`)
      .set(auth(OWNER))
      .send({ targetAmount });

    expect(res.status).toBe(400);
    const row = campaignRow(id)!;
    expect(row.target_amount).toBe(100000);
    expect(row.ty).toBe('integer');
  });

  it('stores a numeric string target on update as a number, never as TEXT', async () => {
    // Class-R probe (TR-4): same discipline as the sponsorship update — the
    // validated value must be what is written (funding mutant F7).
    const created = await makeCampaign(100000);
    const id = created.body.id;
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${id}`)
      .set(auth(OWNER))
      .send({ targetAmount: '150000' });
    expect(res.status).toBe(200);
    const row = campaignRow(id)!;
    expect(row.target_amount).toBe(150000);
    expect(row.ty).toBe('integer');
  });

  it('treats a JSON-untransmittable Infinity (which arrives as null) as an absent field', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ targetAmount: Number.POSITIVE_INFINITY });
    expect(res.status).toBe(200);
    expect(campaignRow(created.body.id)!.target_amount).toBe(100000);
  });

  it('does not leak SQLite driver internals as a 500', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ targetAmount: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SQLite3');
  });

  it('refuses a fractional target instead of storing a different amount', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ targetAmount: 1.555 });
    expect(res.status).toBe(400);
  });

  it('still accepts a legitimate target change', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ targetAmount: 250000 });
    expect(res.status).toBe(200);
    expect(campaignRow(created.body.id)!.target_amount).toBe(250000);
  });

  it('leaves the target alone when the field is absent from the patch', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(campaignRow(created.body.id)!.target_amount).toBe(100000);
  });

  it('still rejects an invalid status', async () => {
    const created = await makeCampaign(100000);
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${created.body.id}`)
      .set(auth(OWNER))
      .send({ status: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

describe('the aggregate corruption these amounts caused', () => {
  it('keeps SUM(target_amount) numerically intact after a rejected poisoning attempt', async () => {
    const a = await makeCampaign(100000);
    const b = await makeCampaign(50000);
    const ids = [a.body.id, b.body.id];
    const sumOf = () =>
      (db
        .prepare(
          `SELECT SUM(target_amount) AS s FROM funding_campaigns WHERE id IN (${ids.map(() => '?').join(',')})`,
        )
        .get(...ids) as { s: number }).s;

    expect(sumOf()).toBe(150000);

    // The live defect: this PATCH returned 200 and SUM silently dropped to
    // 50000 because SQLite coerced the stored text 'abc' to 0.
    const res = await supertest(app)
      .patch(`/api/funding/campaigns/${a.body.id}`)
      .set(auth(OWNER))
      .send({ targetAmount: 'abc' });
    expect(res.status).toBe(400);
    expect(sumOf()).toBe(150000);
  });

  it('never stores a non-numeric type in either money column', async () => {
    const poisonedSponsorships = db
      .prepare("SELECT COUNT(*) AS c FROM sponsorship_agreements WHERE typeof(monthly_amount) != 'real' AND typeof(monthly_amount) != 'integer'")
      .get() as { c: number };
    const poisonedCampaigns = db
      .prepare("SELECT COUNT(*) AS c FROM funding_campaigns WHERE typeof(target_amount) != 'real' AND typeof(target_amount) != 'integer'")
      .get() as { c: number };
    expect(poisonedSponsorships.c).toBe(0);
    expect(poisonedCampaigns.c).toBe(0);
  });

  it('never stores a negative commitment or target', async () => {
    const negSponsorships = db.prepare('SELECT COUNT(*) AS c FROM sponsorship_agreements WHERE monthly_amount < 0').get() as { c: number };
    const negCampaigns = db.prepare('SELECT COUNT(*) AS c FROM funding_campaigns WHERE target_amount < 0').get() as { c: number };
    expect(negSponsorships.c).toBe(0);
    expect(negCampaigns.c).toBe(0);
  });
});
