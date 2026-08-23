import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';

const BRANCH = 'wp09_amount_branch';
const OWNER = 'wp09_amount_owner';
const DONOR = 'wp09_amount_donor';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_amount_campus', FIXED_ORG_ID, 'Amount campus', 'WPA');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Amount branch', 'Kabul', 'wp09_amount_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Amount donor');
});

const auth = () => bearerFor(OWNER);
const createSponsorship = (monthlyAmount: unknown) => supertest(app)
  .post('/api/funding/sponsorships')
  .set(auth())
  .send({ donorId: DONOR, monthlyAmount, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH });

describe('WP-09 · monetary boundaries are one whole-AFN authority', () => {
  it.each([['fractional', 100.5], ['negative', -1], ['text', 'wrong'], ['array', [10]], ['boolean', true]])(
    'refuses %s sponsorship promise before storage',
    async (_label, monthlyAmount) => {
      await createSponsorship(monthlyAmount).expect(400);
    },
  );

  it('stores the validated numeric amount, not an untyped body value', async () => {
    const created = await createSponsorship('1200').expect(201);
    expect(db.prepare('SELECT monthly_amount, typeof(monthly_amount) AS kind FROM sponsorship_agreements WHERE id = ?').get(created.body.id))
      .toEqual({ monthly_amount: 1200, kind: 'integer' });
  });

  it('rejects malformed campaign targets and keeps the prior target unchanged', async () => {
    const campaign = await supertest(app).post('/api/funding/campaigns').set(auth()).send({
      name: 'Target boundary', targetAmount: 10000, startDate: '2026-08-01', branchId: BRANCH,
    }).expect(201);
    await supertest(app).patch(`/api/funding/campaigns/${campaign.body.id}`).set(auth()).send({ targetAmount: 1.5 }).expect(400);
    expect(db.prepare('SELECT target_amount FROM funding_campaigns WHERE id = ?').get(campaign.body.id)).toEqual({ target_amount: 10000 });
  });

  it('requires real, ordered sponsorship dates rather than accepting raw text', async () => {
    await supertest(app).post('/api/funding/sponsorships').set(auth()).send({
      donorId: DONOR, monthlyAmount: 100, startDate: 'not-a-date', endDate: '2026-12-01', branchId: BRANCH,
    }).expect(400);
    await supertest(app).post('/api/funding/sponsorships').set(auth()).send({
      donorId: DONOR, monthlyAmount: 100, startDate: '2026-12-02', endDate: '2026-12-01', branchId: BRANCH,
    }).expect(400);
  });
});

describe('WP-09 · PATCH preserves absent monetary fields', () => {
  it('does not turn an omitted sponsorship promise into zero', async () => {
    const created = await createSponsorship(1700).expect(201);
    await supertest(app).patch(`/api/funding/sponsorships/${created.body.id}`).set(auth()).send({}).expect(200);
    expect(db.prepare('SELECT monthly_amount FROM sponsorship_agreements WHERE id = ?').get(created.body.id)).toEqual({ monthly_amount: 1700 });
  });

  it('does not turn an omitted campaign target into zero', async () => {
    const campaign = await supertest(app).post('/api/funding/campaigns').set(auth()).send({
      name: 'Preserve target', targetAmount: 7300, startDate: '2026-08-01', branchId: BRANCH,
    }).expect(201);
    await supertest(app).patch(`/api/funding/campaigns/${campaign.body.id}`).set(auth()).send({}).expect(200);
    expect(db.prepare('SELECT target_amount FROM funding_campaigns WHERE id = ?').get(campaign.body.id)).toEqual({ target_amount: 7300 });
  });
});
