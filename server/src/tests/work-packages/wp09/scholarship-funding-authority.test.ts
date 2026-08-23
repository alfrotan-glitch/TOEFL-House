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

const BRANCH = 'wp09_scholar_branch';
const OWNER = 'wp09_scholar_owner';
const DONOR = 'wp09_scholar_donor';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_scholar_campus', FIXED_ORG_ID, 'Scholar campus', 'WPS');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Scholar branch', 'Kabul', 'wp09_scholar_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Scholar donor');
});

const auth = () => bearerFor(OWNER);

function seedStudentWithTerm() {
  const studentId = id('wp09_student');
  const semesterId = id('wp09_semester');
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, gender, status, registration_date, branch_id)
     VALUES (?, ?, 'Scholar student', 'female', 'active', ?, ?)`,
  ).run(studentId, `ST-${studentId.slice(-8)}`, today(), BRANCH);
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term One', ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, today());
  return studentId;
}

describe('WP-09 · scholarship funding retains source and commitment truth', () => {
  it('cannot award an unfunded declared target', async () => {
    const scholarshipId = id('wp09_unfunded');
    const studentId = seedStudentWithTerm();
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, 'Unfunded', 50000, '', 'active', ?)`).run(scholarshipId, BRANCH);
    await supertest(app).post('/api/funding/scholarships/award').set(auth()).send({ scholarshipId, studentId, amount: 1000, branchId: BRANCH }).expect(409);
  });

  it('requires a received source, preserves applied money after award close, and blocks a closed-award reversal', async () => {
    const scholarshipId = id('wp09_scholarship');
    const studentId = seedStudentWithTerm();
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, 'Source scholarship', 10000, '', 'active', ?)`).run(scholarshipId, BRANCH);
    const donation = await supertest(app).post('/api/funding/donations').set(auth()).send({
      donorId: DONOR, amount: 10000, date: today(), branchId: BRANCH,
      restriction: { kind: 'scholarship', targetId: scholarshipId },
    }).expect(201);
    const source = db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(donation.body.id) as { id: string };
    const award = await supertest(app).post('/api/funding/scholarships/award').set(auth()).send({ scholarshipId, studentId, amount: 10000, awardDate: today(), branchId: BRANCH }).expect(201);
    const obligations = await supertest(app).get(`/api/funding/students/${studentId}/tuition-obligations`).set(auth()).expect(200);
    const application = await supertest(app).post(`/api/funding/scholarship-awards/${award.body.id}/allocations`).set(auth()).send({
      obligationId: obligations.body[0].id, scholarshipFundingId: source.id, amount: 4000,
    }).expect(201);

    expect(() => db.prepare('DELETE FROM obligation_allocations WHERE id = ?').run(application.body.id)).toThrow(/cannot be deleted/i);
    await supertest(app).post(`/api/funding/scholarship-awards/${award.body.id}/close`).set(auth()).send({ reason: 'Student needs no further support this term.' }).expect(200);
    const position = await supertest(app).get(`/api/funding/scholarships/${scholarshipId}/position`).set(auth()).expect(200);
    expect(position.body.committed).toBe(4000);
    expect(position.body.available).toBe(6000);

    await supertest(app).post(`/api/funding/scholarship-awards/${award.body.id}/allocations/${application.body.id}/reverse`).set(auth()).send({ reason: 'This must not re-open a closed award.' }).expect(409);
    await supertest(app).post('/api/funding/scholarships/award').set(auth()).send({ scholarshipId, studentId, amount: 6001, branchId: BRANCH }).expect(409);
  });
});
