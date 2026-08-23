import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import impactRouter from '../../../routes/impact.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { id, today } from '../../../utils/ids.js';
import { periodBoundaries } from '../../../core/calendar/periods.js';

const BRANCH = 'wp09_review_branch';
const OWNER = 'wp09_review_owner';
const DONOR = 'wp09_review_donor';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use('/api/impact', impactRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_review_campus', FIXED_ORG_ID, 'Review campus', 'WPRV');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Review branch', 'Kabul', 'wp09_review_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Review donor');
});

const auth = () => bearerFor(OWNER);

describe('WP-09 cold review · storage cannot contradict the command graph', () => {
  it('does not permit a direct rewrite of scholarship identity or a sponsorship return target', async () => {
    const scholarshipId = id('review_sch');
    const campaignA = id('review_campaign_a');
    const campaignB = id('review_campaign_b');
    db.prepare(`INSERT INTO funding_campaigns (id, name, target_amount, start_date, status, branch_id) VALUES (?, ?, 1000, ?, 'active', ?)`).run(campaignA, 'Review campaign A', today(), BRANCH);
    db.prepare(`INSERT INTO funding_campaigns (id, name, target_amount, start_date, status, branch_id) VALUES (?, ?, 1000, ?, 'active', ?)`).run(campaignB, 'Review campaign B', today(), BRANCH);
    db.prepare(`INSERT INTO scholarships (id, name, campaign_id, total_budget, criteria, status, branch_id) VALUES (?, 'Review scholarship', ?, 1000, '', 'active', ?)`).run(scholarshipId, campaignA, BRANCH);
    const agreement = await supertest(app).post('/api/funding/sponsorships').set(auth()).send({ donorId: DONOR, campaignId: campaignA, monthlyAmount: 0, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH }).expect(201);

    expect(() => db.prepare('UPDATE scholarships SET campaign_id = ? WHERE id = ?').run(campaignB, scholarshipId)).toThrow(/cannot be modified/i);
    expect(() => db.prepare('UPDATE sponsorship_agreements SET campaign_id = ? WHERE id = ?').run(campaignB, agreement.body.id)).toThrow(/cannot be modified/i);
  });

  it('returns a clean 400 instead of a storage error when an unrestricted donation is aimed at an incompatible scholarship', async () => {
    const campaignA = id('review_campaign');
    const scholarshipId = id('review_sch');
    db.prepare(`INSERT INTO funding_campaigns (id, name, target_amount, start_date, status, branch_id) VALUES (?, ?, 1000, ?, 'active', ?)`).run(campaignA, 'Review source campaign', today(), BRANCH);
    db.prepare(`INSERT INTO scholarships (id, name, campaign_id, total_budget, criteria, status, branch_id) VALUES (?, 'Review target', ?, 1000, '', 'active', ?)`).run(scholarshipId, campaignA, BRANCH);
    const donation = await supertest(app).post('/api/funding/donations').set(auth()).send({ donorId: DONOR, amount: 500, date: today(), branchId: BRANCH }).expect(201);
    const response = await supertest(app).post(`/api/funding/scholarships/${scholarshipId}/fundings`).set(auth()).send({ donationId: donation.body.id, amount: 500 });
    expect(response.status).toBe(201);

    const otherScholarship = id('review_other_sch');
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, 'Other target', 1000, '', 'active', ?)`).run(otherScholarship, BRANCH);
    const secondDonation = await supertest(app).post('/api/funding/donations').set(auth()).send({ donorId: DONOR, amount: 500, date: today(), branchId: BRANCH, restriction: { kind: 'campaign', targetId: campaignA } }).expect(201);
    const entry = db.prepare('SELECT id FROM campaign_funding_entries WHERE source_donation_id = ?').get(secondDonation.body.id) as { id: string };
    const invalid = await supertest(app).post(`/api/funding/scholarships/${otherScholarship}/fundings`).set(auth()).send({ campaignFundingEntryId: entry.id, amount: 100 });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.error)).not.toMatch(/sqlite|trigger|constraint/i);
  });

  it('keeps generated impact output immutable after the report snapshot is written', async () => {
    const report = await supertest(app).post('/api/impact/reports/generate').set(auth()).send({
      period: periodBoundaries('month', today()).periodKey, branchId: BRANCH, scopeKind: 'branch',
    }).expect(201);
    expect(() => db.prepare("UPDATE impact_reports SET narrative = 'forged' WHERE id = ?").run(report.body.id)).toThrow(/cannot be modified/i);
  });
});
