import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { id, today } from '../../../utils/ids.js';

const BRANCH = 'wp09_sponsor_branch';
const OWNER = 'wp09_sponsor_owner';
const DONOR = 'wp09_sponsor_donor';
const OTHER_DONOR = 'wp09_sponsor_other';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_sponsor_campus', FIXED_ORG_ID, 'Sponsor campus', 'WPP');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Sponsor branch', 'Kabul', 'wp09_sponsor_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Sponsor donor');
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(OTHER_DONOR, 'Other donor');
});

const auth = () => bearerFor(OWNER);

function seedStudent() {
  const studentId = id('wp09_sponsor_student');
  const semesterId = id('wp09_sponsor_semester');
  db.prepare(`INSERT INTO students (id, student_code, full_name, gender, status, registration_date, branch_id) VALUES (?, ?, 'Sponsor student', 'male', 'active', ?, ?)`).run(studentId, `SS-${studentId.slice(-8)}`, today(), BRANCH);
  db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, ?, 'Term One', ?, 8000, 8000, 'active')`).run(semesterId, studentId, today());
  return studentId;
}

describe('WP-09 · sponsorship receipts are exact sources, not promises', () => {
  it('turns a restricted donation into a receipt, applies exactly that receipt, and moves no second cash fact', async () => {
    const studentId = seedStudent();
    const agreement = await supertest(app).post('/api/funding/sponsorships').set(auth()).send({
      donorId: DONOR, studentId, monthlyAmount: 1000, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH,
    }).expect(201);
    const beforeCashFacts = (db.prepare("SELECT COUNT(*) AS count FROM financial_transactions WHERE category = 'donation'").get() as { count: number }).count;
    const donation = await supertest(app).post('/api/funding/donations').set(auth()).send({
      donorId: DONOR, amount: 5000, date: today(), branchId: BRANCH,
      restriction: { kind: 'sponsorship', targetId: agreement.body.id },
    }).expect(201);
    const receipt = db.prepare('SELECT id FROM sponsorship_receipts WHERE donation_id = ?').get(donation.body.id) as { id: string };
    const obligations = await supertest(app).get(`/api/funding/students/${studentId}/tuition-obligations`).set(auth()).expect(200);
    const allocation = await supertest(app).post(`/api/funding/sponsorships/${agreement.body.id}/allocations`).set(auth()).send({
      obligationId: obligations.body[0].id, sponsorshipReceiptId: receipt.id, amount: 5000,
    }).expect(201);
    expect(db.prepare('SELECT sponsorship_receipt_id FROM obligation_allocations WHERE id = ?').get(allocation.body.id)).toEqual({ sponsorship_receipt_id: receipt.id });
    expect((db.prepare("SELECT COUNT(*) AS count FROM financial_transactions WHERE category = 'donation'").get() as { count: number }).count).toBe(beforeCashFacts + 1);
  });

  it('refuses a donation from another donor for a named sponsorship target', async () => {
    const agreement = await supertest(app).post('/api/funding/sponsorships').set(auth()).send({
      donorId: DONOR, monthlyAmount: 1000, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH,
    }).expect(201);
    await supertest(app).post('/api/funding/donations').set(auth()).send({
      donorId: OTHER_DONOR, amount: 1000, date: today(), branchId: BRANCH,
      restriction: { kind: 'sponsorship', targetId: agreement.body.id },
    }).expect(400);
  });

  it('reverses an active application once and returns availability to the same receipt', async () => {
    const studentId = seedStudent();
    const agreement = await supertest(app).post('/api/funding/sponsorships').set(auth()).send({ donorId: DONOR, studentId, monthlyAmount: 1, startDate: '2026-08-01', endDate: '2026-12-01', branchId: BRANCH }).expect(201);
    const donation = await supertest(app).post('/api/funding/donations').set(auth()).send({ donorId: DONOR, amount: 2000, date: today(), branchId: BRANCH, restriction: { kind: 'sponsorship', targetId: agreement.body.id } }).expect(201);
    const receipt = db.prepare('SELECT id FROM sponsorship_receipts WHERE donation_id = ?').get(donation.body.id) as { id: string };
    const obligations = await supertest(app).get(`/api/funding/students/${studentId}/tuition-obligations`).set(auth()).expect(200);
    const allocation = await supertest(app).post(`/api/funding/sponsorships/${agreement.body.id}/allocations`).set(auth()).send({ obligationId: obligations.body[0].id, sponsorshipReceiptId: receipt.id, amount: 2000 }).expect(201);
    await supertest(app).post(`/api/funding/sponsorship-allocations/${allocation.body.id}/reverse`).set(auth()).send({ reason: 'Duplicate sponsorship application correction.' }).expect(200);
    await supertest(app).post(`/api/funding/sponsorship-allocations/${allocation.body.id}/reverse`).set(auth()).send({ reason: 'Duplicate sponsorship application correction.' }).expect(409);
    const position = await supertest(app).get(`/api/funding/sponsorships/${agreement.body.id}/position`).set(auth()).expect(200);
    expect(position.body.receipts.find((entry: any) => entry.id === receipt.id).source.available).toBe(2000);
  });
});
