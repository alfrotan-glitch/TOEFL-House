/**
 * WP-07 · TR4-R13 — cross-surface runtime money agreement (§77, §76).
 *
 * Stage 2 of the TR-4 review could NOT establish that the surfaces agree for one
 * student holding every funding instrument at once. This suite is that missing
 * check: one student, one tuition term, settled by cash, partially refunded,
 * a scholarship and a sponsorship — then every surface that reports what the
 * student owes must answer the SAME figures as the database authorities:
 *
 *   database truth   getObligationPosition (term) + getStudentBalance (student)
 *   profile API      GET /api/students/:id            (balance.lifetime + row)
 *   roster API       GET /api/students/balances       (the roster page)
 *   BOS dashboard    GET /api/bos/executive-dashboard (outstandingPayments)
 *   operations report GET /api/reports/overview       (financial.outstanding.tuition)
 *
 * Two surfaces deliberately carry no per-student tuition-debt metric and are
 * therefore out of scope here: the staff dashboard summary (population +
 * cash-flow only) and the per-term report catalog metrics.
 */
import { bearerFor, seedUser } from '../../support/identity.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { today } from '../../../utils/ids.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { ensureTuitionObligation, getObligationPosition } from '../../../core/finance/obligations.js';
import { getStudentBalance } from '../../../utils/studentBalance.js';
import { studentsRouter, paymentsRouter } from '../../../routes/students.routes.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { bosRouter } from '../../../routes/bos.routes.js';
import { reportsRouter } from '../../../routes/reports.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/funding', fundingRouter);
app.use('/api/bos', bosRouter);
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

const TUITION = 10000;
const CASH = 4000;
const REFUND = 1000;
const SCHOLARSHIP = 2000;
const SPONSORSHIP = 2000;
const NET_CASH = CASH - REFUND;
const SETTLED = NET_CASH + SCHOLARSHIP + SPONSORSHIP;
const OUTSTANDING = TUITION - SETTLED;

let key: string;
let branch: string;
let studentId: string;
let semesterId: string;
let obligationId: string;
let donorId: string;
let scholarshipId: string;
let agreementId: string;
let owner: Record<string, string>;
let seq = 0;

beforeAll(() => {
  // silence express 404 noise for unmatched funding subpaths
  app.set('x-disable-powered-by', true);
});

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `r13_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);

  studentId = `${key}_s`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Agreement Probe', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-R13-${++seq}-${key.slice(-6)}`, today(), branch, `079${String(1000000 + seq).slice(-7)}`);

  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term One', ?, ?, ?, 'active')`,
  ).run(semesterId, studentId, today(), TUITION, TUITION);
  obligationId = ensureTuitionObligation(db, semesterId).id;

  donorId = `${key}_donor`;
  db.prepare(`INSERT INTO donors (id, full_name, type) VALUES (?, 'Cross-Surface Donor', 'individual')`).run(donorId);

  scholarshipId = `${key}_sch`;
  db.prepare(
    `INSERT INTO scholarships (id, name, donor_id, total_budget, allocated_amount, branch_id)
     VALUES (?, 'Cross-surface fund', ?, 50000, 0, ?)`,
  ).run(scholarshipId, donorId, branch);

  agreementId = `${key}_spon`;
  db.prepare(
    `INSERT INTO sponsorship_agreements (id, donor_id, student_id, monthly_amount, start_date, end_date, status, branch_id)
     VALUES (?, ?, ?, 5000, ?, '2099-12-31', 'active', ?)`,
  ).run(agreementId, donorId, studentId, today(), branch);

  seedUser({ id: `${key}_own`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_own`);
});

const post = (url: string, body: Record<string, unknown> = {}) =>
  supertest(app).post(url).set(owner).send(body);
const get = (url: string) => supertest(app).get(url).set(owner);

/** Sponsorship receipts are backed by donation rows (a promise settles nothing). */
function seedDonation(amount: number): string {
  const id = `${key}_don${++seq}`;
  db.prepare(
    `INSERT INTO donations (id, donor_id, amount, date, receipt_no, branch_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, donorId, amount, today(), `DON-${id.slice(-8)}`, branch, id);
  return id;
}

describe('WP-07 · TR4-R13 — every surface agrees for cash + refund + scholarship + sponsorship', () => {
  it('profile, roster, BOS dashboard and operations report answer the authority figures exactly', async () => {
    // ── the money: cash, a refund of part of it, a scholarship, a sponsorship ──
    await post(`/api/students/${studentId}/payments`, { category: 'fee', amount: CASH, semesterId }).expect(201);
    const paymentId = (db.prepare(
      `SELECT id FROM payments WHERE student_id = ? AND status = 'completed' AND category <> 'refund' AND amount > 0 ORDER BY rowid DESC LIMIT 1`,
    ).get(studentId) as { id: string }).id;

    const refund = await post(`/api/students/${studentId}/refund`, { reason: 'cross-surface probe', paymentId, amount: REFUND });
    expect({ status: refund.status, body: refund.body }).toEqual({ status: 201, body: refund.body });

    const donation = await post('/api/funding/donations', { donorId, amount: SCHOLARSHIP }).expect(201);
    await post(`/api/funding/scholarships/${scholarshipId}/fundings`, { donationId: donation.body.id, amount: SCHOLARSHIP }).expect(201);
    const awarded = await post('/api/funding/scholarships/award', { scholarshipId, studentId, amount: SCHOLARSHIP }).expect(201);
    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId, amount: SCHOLARSHIP }).expect(201);

    await post(`/api/funding/sponsorships/${agreementId}/receipts`, { donationId: seedDonation(SPONSORSHIP), amount: SPONSORSHIP }).expect(201);
    await post(`/api/funding/sponsorships/${agreementId}/allocations`, { obligationId, amount: SPONSORSHIP }).expect(201);

    // ── database truth ──
    const position = getObligationPosition(db, obligationId);
    expect(position.settledCash).toBe(NET_CASH);
    expect(position.settledAid).toBe(SCHOLARSHIP + SPONSORSHIP);
    expect(position.settled).toBe(SETTLED);
    expect(position.outstanding).toBe(OUTSTANDING);

    const balance = getStudentBalance(db, studentId, 'all');
    expect(balance.tuitionDue).toBe(TUITION);
    expect(balance.tuitionPaid).toBe(SETTLED);
    expect(balance.outstanding).toBe(OUTSTANDING);

    // ── profile API: the balance ships WITH the student ──
    const profile = await get(`/api/students/${studentId}`).expect(200);
    // The profile's money contract is its explicit balance block (the route's
    // own comment: the balance ships WITH the student so no client re-derives).
    expect(profile.body.balance.lifetime).toMatchObject({
      tuitionDue: TUITION, tuitionPaid: SETTLED, outstanding: OUTSTANDING,
    });
    expect(profile.body.balance.current).toMatchObject({
      tuitionDue: TUITION, tuitionPaid: SETTLED, outstanding: OUTSTANDING,
    });

    // ── roster API: the roster page is the same definition, not a copy ──
    const roster = await get(`/api/payments/balances?branchId=${branch}&limit=50`).expect(200);
    const row = (roster.body as Array<Record<string, unknown>>).find((r) => r.studentId === studentId);
    expect(row).toBeTruthy();
    expect(Number(row!.tuitionDue)).toBe(TUITION);
    expect(Number(row!.tuitionPaid)).toBe(SETTLED);
    expect(Number(row!.outstanding)).toBe(OUTSTANDING);

    // ── BOS dashboard: the branch figure is the same student truth, summed ──
    const bos = await get(`/api/bos/executive-dashboard?branchId=${branch}`).expect(200);
    expect(Number(bos.body.outstandingPayments)).toBe(OUTSTANDING);

    // ── operations report: aid-settled terms excluded from what is owed ──
    const report = await get(`/api/reports/overview?branchId=${branch}`).expect(200);
    expect(Number(report.body.financial.outstanding.tuition)).toBe(OUTSTANDING);
    expect(Number(report.body.financial.outstanding.total)).toBe(OUTSTANDING);
  });
});
