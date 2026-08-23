import { randomUUID } from 'node:crypto';
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
import { today } from '../../../utils/ids.js';
import { periodBoundaries } from '../../../core/calendar/periods.js';

const BRANCH_A = 'wp09_a';
const BRANCH_B = 'wp09_b';
const OWNER = 'wp09_owner';
const FINANCE = 'wp09_finance';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use('/api/impact', impactRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const finance = () => bearerFor(FINANCE);
const run = () => randomUUID().replaceAll('-', '');

function insertDonor(id: string, name: string) {
  db.prepare("INSERT INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(id, name);
}

function insertCampaign(id: string, branchId: string, name = id) {
  db.prepare(
    `INSERT INTO funding_campaigns
      (id, name, target_amount, start_date, status, branch_id)
     VALUES (?, ?, 100000, '2026-08-22', 'active', ?)`,
  ).run(id, name, branchId);
}

function insertStudent(id: string, branchId: string) {
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, gender, status, registration_date, branch_id)
     VALUES (?, ?, ?, 'female', 'active', '2026-08-22', ?)`,
  ).run(id, `S-${id}`, `Student ${id.slice(-6)}`, branchId);
}

function insertSemester(id: string, studentId: string) {
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term 1', '2026-08-22', 10000, 10000, 'active')`,
  ).run(id, studentId);
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_campus', FIXED_ORG_ID, 'WP09 Campus', 'WP09');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH_A, 'WP09 A', 'A', 'wp09_campus');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH_B, 'WP09 B', 'B', 'wp09_campus');
  db.prepare(
    `INSERT OR REPLACE INTO finance_accounts (id, scope_type, scope_id, main_balance, saving_balance)
     VALUES ('wp09_finance_a', 'branch', ?, 0, 0), ('wp09_finance_b', 'branch', ?, 0, 0)`,
  ).run(BRANCH_A, BRANCH_B);

  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH_A, scopeType: 'organization', scopeId: null });
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BRANCH_A });
});

describe('WP-09 ATTACK · branch, permission and immutable donation facts', () => {
  it('books a selected-branch donation and its income fact to the campaign branch, not the operator home branch', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const campaignId = `camp_${key}`;
    insertDonor(donorId, 'Branch-safe donor');
    insertCampaign(campaignId, BRANCH_B);

    const res = await supertest(app)
      .post('/api/funding/donations')
      .set(owner())
      .send({ donorId, campaignId, amount: 5000, date: today(), branchId: BRANCH_B });

    expect(res.status).toBe(201);
    const donation = db.prepare('SELECT branch_id, transaction_id FROM donations WHERE id = ?').get(res.body.id) as {
      branch_id: string; transaction_id: string;
    };
    expect(donation.branch_id).toBe(BRANCH_B);
    expect(donation.transaction_id).toBeTruthy();
    const income = db.prepare('SELECT branch_id, amount, category FROM financial_transactions WHERE id = ?').get(donation.transaction_id) as {
      branch_id: string; amount: number; category: string;
    };
    expect(income).toEqual({ branch_id: BRANCH_B, amount: 5000, category: 'donation' });
  });

  it('allows Finance to register a donation but not mutate donor or Impact resources', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    insertDonor(donorId, 'Finance donation donor');

    await supertest(app)
      .post('/api/funding/donations')
      .set(finance())
      .send({ donorId, amount: 1200, date: today(), branchId: BRANCH_A })
      .expect(201);

    await supertest(app)
      .post('/api/funding/donors')
      .set(finance())
      .send({ fullName: 'Unauthorized donor', type: 'individual' })
      .expect(403);

    await supertest(app)
      .post('/api/impact/reports/generate')
      .set(finance())
      .send({ period: periodBoundaries('month', today()).periodKey, branchId: BRANCH_A })
      .expect(403);
  });

  it('materializes a mandatory scholarship restriction and refuses a raw free-text substitute', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const scholarshipId = `sch_${key}`;
    insertDonor(donorId, 'Restricted donor');
    db.prepare(
      `INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id)
       VALUES (?, ?, 4000, '', 'active', ?)`,
    ).run(scholarshipId, 'Restricted scholarship', BRANCH_A);

    const restricted = await supertest(app)
      .post('/api/funding/donations')
      .set(owner())
      .send({
        donorId,
        amount: 4000,
        date: today(),
        branchId: BRANCH_A,
        restriction: { kind: 'scholarship', targetId: scholarshipId },
      });
    expect(restricted.status).toBe(201);
    expect(
      db.prepare('SELECT scholarship_id FROM scholarship_fundings WHERE donation_id = ?').get(restricted.body.id),
    ).toEqual({ scholarship_id: scholarshipId });

    await supertest(app)
      .post('/api/funding/donations')
      .set(owner())
      .send({ donorId, amount: 500, date: today(), branchId: BRANCH_A, restricted: true, restrictionNote: 'Scholarship someday' })
      .expect(400);
  });
});

describe('WP-09 ATTACK · source provenance and terminal sponsorship money', () => {
  it('requires an exact scholarship funding source for a tuition application', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const scholarshipId = `sch_${key}`;
    const studentId = `student_${key}`;
    const semesterId = `semester_${key}`;
    insertDonor(donorId, 'Provenance donor');
    insertStudent(studentId, BRANCH_A);
    insertSemester(semesterId, studentId);
    db.prepare(
      `INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id)
       VALUES (?, ?, 10000, '', 'active', ?)`,
    ).run(scholarshipId, 'Source scholarship', BRANCH_A);

    const donation = await supertest(app)
      .post('/api/funding/donations')
      .set(owner())
      .send({
        donorId, amount: 10000, date: today(), branchId: BRANCH_A,
        restriction: { kind: 'scholarship', targetId: scholarshipId },
      })
      .expect(201);
    const funding = db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(donation.body.id) as { id: string };
    const award = await supertest(app)
      .post('/api/funding/scholarships/award')
      .set(owner())
      .send({ scholarshipId, studentId, amount: 6000, awardDate: today(), branchId: BRANCH_A })
      .expect(201);
    const obligations = await supertest(app)
      .get(`/api/funding/students/${studentId}/tuition-obligations`)
      .set(owner())
      .expect(200);

    const application = await supertest(app)
      .post(`/api/funding/scholarship-awards/${award.body.id}/allocations`)
      .set(owner())
      .send({ obligationId: obligations.body[0].id, amount: 6000, sourceKind: 'scholarshipFunding', sourceId: funding.id });
    expect(application.status).toBe(201);
    expect(
      db.prepare('SELECT scholarship_funding_id FROM obligation_allocations WHERE id = ?').get(application.body.id),
    ).toEqual({ scholarship_funding_id: funding.id });
  });

  it('returns every unspent sponsorship receipt to its linked campaign or blocks a terminal transition', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const campaignId = `camp_${key}`;
    insertDonor(donorId, 'Sponsorship donor');
    insertCampaign(campaignId, BRANCH_A);

    const agreement = await supertest(app)
      .post('/api/funding/sponsorships')
      .set(owner())
      .send({ donorId, campaignId, monthlyAmount: 3000, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH_A })
      .expect(201);
    const donation = await supertest(app)
      .post('/api/funding/donations')
      .set(owner())
      .send({
        donorId, amount: 3000, date: today(), branchId: BRANCH_A,
        restriction: { kind: 'sponsorship', targetId: agreement.body.id },
      })
      .expect(201);

    const terminal = await supertest(app)
      .patch(`/api/funding/sponsorships/${agreement.body.id}`)
      .set(owner())
      .send({ status: 'terminated', reason: 'The donor ended this sponsorship agreement.' });
    expect(terminal.status).toBe(200);
    expect(
      db.prepare(
        `SELECT amount, campaign_id, source_donation_id
           FROM campaign_funding_entries
          WHERE sponsorship_agreement_id = ?`,
      ).get(agreement.body.id),
    ).toEqual({ amount: 3000, campaign_id: campaignId, source_donation_id: donation.body.id });
  });
});

describe('WP-09 ATTACK · donor/campaign reports never pool branch impact', () => {
  it('reports only source-traceable donor facts when a donor scope is selected', async () => {
    const key = run();
    const donorA = `dn_a_${key}`;
    const donorB = `dn_b_${key}`;
    insertDonor(donorA, 'Attributed donor');
    insertDonor(donorB, 'Unrelated donor');
    const period = periodBoundaries('month', today()).periodKey;

    await supertest(app).post('/api/funding/donations').set(owner()).send({ donorId: donorA, amount: 7000, date: today(), branchId: BRANCH_A }).expect(201);
    await supertest(app).post('/api/funding/donations').set(owner()).send({ donorId: donorB, amount: 9000, date: today(), branchId: BRANCH_A }).expect(201);

    const report = await supertest(app)
      .post('/api/impact/reports/generate')
      .set(owner())
      .send({ period, branchId: BRANCH_A, scopeKind: 'donor', scopeId: donorA });
    expect(report.status).toBe(201);
    expect(
      (report.body.metrics as Array<{ id: string; value: number }>).find((metric) => metric.id === 'funding.donations_received')?.value,
    ).toBe(7000);
  });
});

describe('WP-09 ATTACK · database backstops and campaign provenance', () => {
  it('rejects a direct paired donation whose campaign belongs to another branch', () => {
    const key = run();
    const donorId = `dn_${key}`;
    const campaignId = `camp_${key}`;
    const donationId = `dn_bad_${key}`;
    const transactionId = `tx_bad_${key}`;
    insertDonor(donorId, 'Direct-write donor');
    insertCampaign(campaignId, BRANCH_B, 'Foreign branch campaign');

    expect(() => db.transaction(() => {
      db.prepare(
        `INSERT INTO financial_transactions
           (id, type, category, amount, date, description, reference_id, donation_id, operator_name, branch_id)
         VALUES (?, 'income', 'donation', 1000, ?, 'attack', ?, ?, 'attack', ?)`,
      ).run(transactionId, today(), donationId, donationId, BRANCH_A);
      db.prepare(
        `INSERT INTO donations
           (id, campaign_id, donor_id, amount, date, receipt_no, branch_id, transaction_id, idempotency_key)
         VALUES (?, ?, ?, 1000, ?, ?, ?, ?, ?)`,
      ).run(donationId, campaignId, donorId, today(), `R-${key}`, BRANCH_A, transactionId, `attack-${key}`);
    })()).toThrow(/campaign must belong/i);
  });

  it('does not let a direct writer erase a structured restriction after the donation exists', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const scholarshipId = `sch_${key}`;
    insertDonor(donorId, 'Restriction immutability donor');
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, 'Restriction fund', 500, '', 'active', ?)`).run(scholarshipId, BRANCH_A);
    const donation = await supertest(app).post('/api/funding/donations').set(owner()).send({
      donorId, amount: 500, date: today(), branchId: BRANCH_A,
      restriction: { kind: 'scholarship', targetId: scholarshipId },
    }).expect(201);
    expect(() => db.prepare('DELETE FROM donation_restrictions WHERE donation_id = ?').run(donation.body.id)).toThrow(/cannot be deleted/i);
  });

  it('attributes campaign aid only through a concrete campaign funding source', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const campaignId = `camp_${key}`;
    const scholarshipId = `sch_${key}`;
    const studentId = `student_${key}`;
    const semesterId = `semester_${key}`;
    insertDonor(donorId, 'Campaign provenance donor');
    insertCampaign(campaignId, BRANCH_A, 'Campaign provenance');
    insertStudent(studentId, BRANCH_A);
    insertSemester(semesterId, studentId);
    db.prepare(
      `INSERT INTO scholarships (id, name, campaign_id, total_budget, criteria, status, branch_id)
       VALUES (?, 'Campaign scholarship', ?, 5000, '', 'active', ?)`,
    ).run(scholarshipId, campaignId, BRANCH_A);

    const donation = await supertest(app).post('/api/funding/donations').set(owner()).send({
      donorId, amount: 5000, date: today(), branchId: BRANCH_A,
      restriction: { kind: 'campaign', targetId: campaignId },
    }).expect(201);
    const campaignEntry = db.prepare('SELECT id FROM campaign_funding_entries WHERE source_donation_id = ?').get(donation.body.id) as { id: string };
    await supertest(app).post(`/api/funding/scholarships/${scholarshipId}/fundings`).set(owner())
      .send({ campaignFundingEntryId: campaignEntry.id, amount: 2500 }).expect(201);
    const funding = db.prepare('SELECT id FROM scholarship_fundings WHERE campaign_funding_entry_id = ?').get(campaignEntry.id) as { id: string };
    const award = await supertest(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId, studentId, amount: 2500, branchId: BRANCH_A }).expect(201);
    const obligations = await supertest(app).get(`/api/funding/students/${studentId}/tuition-obligations`).set(owner()).expect(200);
    await supertest(app).post(`/api/funding/scholarship-awards/${award.body.id}/allocations`).set(owner())
      .send({ obligationId: obligations.body[0].id, scholarshipFundingId: funding.id, amount: 2500 }).expect(201);

    const report = await supertest(app).post('/api/impact/reports/generate').set(owner()).send({
      period: periodBoundaries('month', today()).periodKey,
      branchId: BRANCH_A,
      scopeKind: 'campaign',
      scopeId: campaignId,
    }).expect(201);
    const metric = (report.body.metrics as Array<{ id: string; value: number }>).find((entry) => entry.id === 'funding.scholarship_aid_applied');
    expect(metric?.value).toBe(2500);
  });
});

describe('WP-09 ATTACK · concurrent source consumption', () => {
  it('does not let two award commands reserve more than a fund received', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const scholarshipId = `sch_${key}`;
    const studentA = `student_a_${key}`;
    const studentB = `student_b_${key}`;
    insertDonor(donorId, 'Concurrent award donor');
    insertStudent(studentA, BRANCH_A);
    insertStudent(studentB, BRANCH_A);
    insertSemester(`semester_a_${key}`, studentA);
    insertSemester(`semester_b_${key}`, studentB);
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, 'Concurrent fund', 5000, '', 'active', ?)`).run(scholarshipId, BRANCH_A);
    await supertest(app).post('/api/funding/donations').set(owner()).send({
      donorId, amount: 5000, date: today(), branchId: BRANCH_A,
      restriction: { kind: 'scholarship', targetId: scholarshipId },
    }).expect(201);

    const attempts = await Promise.all([
      supertest(app).post('/api/funding/scholarships/award').set(owner()).send({ scholarshipId, studentId: studentA, amount: 3000, branchId: BRANCH_A }),
      supertest(app).post('/api/funding/scholarships/award').set(owner()).send({ scholarshipId, studentId: studentB, amount: 3000, branchId: BRANCH_A }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM scholarship_awards WHERE scholarship_id = ? AND status = 'active'`).get(scholarshipId)).toEqual({ total: 3000 });
  });
});

describe('WP-09 ATTACK · idempotency includes restriction identity', () => {
  it('does not replay an explicit key onto a different restricted target', async () => {
    const key = run();
    const donorId = `dn_${key}`;
    const scholarshipA = `sch_a_${key}`;
    const scholarshipB = `sch_b_${key}`;
    insertDonor(donorId, 'Restriction replay donor');
    for (const scholarshipId of [scholarshipA, scholarshipB]) {
      db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, ?, 1000, '', 'active', ?)`).run(scholarshipId, scholarshipId, BRANCH_A);
    }
    const replayKey = `restricted-replay-${key}`;
    await supertest(app).post('/api/funding/donations').set(owner()).set('Idempotency-Key', replayKey).send({
      donorId, amount: 1000, date: today(), branchId: BRANCH_A,
      restriction: { kind: 'scholarship', targetId: scholarshipA },
    }).expect(201);
    await supertest(app).post('/api/funding/donations').set(owner()).set('Idempotency-Key', replayKey).send({
      donorId, amount: 1000, date: today(), branchId: BRANCH_A,
      restriction: { kind: 'scholarship', targetId: scholarshipB },
    }).expect(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM donations WHERE donor_id = ?').get(donorId)).toEqual({ count: 1 });
  });
});
