import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'wp09_lifecycle_branch';
const OWNER = 'wp09_lifecycle_owner';
const DONOR = 'wp09_lifecycle_donor';
const CAMPAIGN = 'wp09_lifecycle_campaign';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_lifecycle_campus', FIXED_ORG_ID, 'Lifecycle campus', 'WPL');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Lifecycle branch', 'Kabul', 'wp09_lifecycle_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Lifecycle donor');
  db.prepare(`INSERT OR IGNORE INTO funding_campaigns (id, name, target_amount, start_date, status, branch_id) VALUES (?, 'Lifecycle campaign', 10000, '2026-08-01', 'active', ?)`).run(CAMPAIGN, BRANCH);
});

const auth = () => bearerFor(OWNER);

async function createAgreement(campaignId: string | null) {
  return supertest(app).post('/api/funding/sponsorships').set(auth()).send({
    donorId: DONOR, campaignId, monthlyAmount: 1000, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH,
  }).expect(201);
}

describe('WP-09 · sponsorship terminal state never hides received money', () => {
  it('returns an unspent targeted receipt to the linked campaign as a restricted fact', async () => {
    const agreement = await createAgreement(CAMPAIGN);
    const donation = await supertest(app).post('/api/funding/donations').set(auth()).send({
      donorId: DONOR, amount: 3000, date: today(), branchId: BRANCH,
      restriction: { kind: 'sponsorship', targetId: agreement.body.id },
    }).expect(201);

    const terminal = await supertest(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(auth()).send({
      status: 'terminated', reason: 'Donor contract ended before the remaining balance was applied.',
    }).expect(200);
    expect(terminal.body.returned).toBe(3000);
    const returned = db.prepare(
      `SELECT cfe.origin_kind, cfe.campaign_id, cfe.source_donation_id, cfe.amount, sa.terminal_reason
         FROM campaign_funding_entries cfe
         JOIN sponsorship_agreements sa ON sa.id = cfe.sponsorship_agreement_id
        WHERE cfe.sponsorship_agreement_id = ?`,
    ).get(agreement.body.id);
    expect(returned).toEqual({
      origin_kind: 'sponsorship_return', campaign_id: CAMPAIGN, source_donation_id: donation.body.id, amount: 3000,
      terminal_reason: 'Donor contract ended before the remaining balance was applied.',
    });
  });

  it('blocks terminal transition when an agreement has a positive balance but no campaign destination', async () => {
    const agreement = await createAgreement(null);
    await supertest(app).post('/api/funding/donations').set(auth()).send({
      donorId: DONOR, amount: 1000, date: today(), branchId: BRANCH,
      restriction: { kind: 'sponsorship', targetId: agreement.body.id },
    }).expect(201);
    await supertest(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(auth()).send({
      status: 'completed', reason: 'The agreement ended without a campaign destination.',
    }).expect(409);
    expect(db.prepare('SELECT status FROM sponsorship_agreements WHERE id = ?').get(agreement.body.id)).toEqual({ status: 'active' });
  });

  it('records a terminal actor/reason and never reactivates the historical agreement', async () => {
    const agreement = await createAgreement(CAMPAIGN);
    await supertest(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(auth()).send({
      status: 'completed', reason: 'The agreement completed with no received balance.',
    }).expect(200);
    expect(db.prepare('SELECT status, terminal_by, terminal_reason FROM sponsorship_agreements WHERE id = ?').get(agreement.body.id))
      .toEqual({ status: 'completed', terminal_by: OWNER, terminal_reason: 'The agreement completed with no received balance.' });
    await supertest(app).patch(`/api/funding/sponsorships/${agreement.body.id}`).set(auth()).send({ monthlyAmount: 2000 }).expect(409);
  });
});
