/**
 * WP-07 · Scholarship funding authority (owner decisions D-120, D-121).
 * ============================================================================
 * The rules under test, as approved:
 *
 *   - a fund holds money it has RECEIVED, and receives it only through
 *     donations explicitly allocated to that fund (so an institution-funded
 *     scholarship is impossible: a fund nobody funded can award nothing);
 *   - an award commits fund money to one student; applying it allocates to a
 *     specific tuition obligation;
 *   - applying scholarship money settles the obligation and moves NO cash and
 *     NO income — the donor's money was recognised when the donation arrived,
 *     and recognising it again as tuition would count one afghani twice;
 *   - money never reaches the student: reversing an application returns it to
 *     its award, and closing the award returns the unapplied remainder to the
 *     fund;
 *   - a term a scholarship has settled cannot be collected again in cash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { getStudentBalance } from '../../../utils/studentBalance.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { getFinanceAccount } from '../../../utils/financeAccounts.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use('/api/students', studentsRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let otherBranch: string;
let studentId: string;
let otherStudentId: string;
let semesterId: string;
let scholarshipId: string;
let donorId: string;
let owner: { Authorization: string };
let phoneSeq = 0;
const nextPhone = () => `07${String(10000000 + (phoneSeq += 1) + (process.pid % 100000)).slice(-8)}`;

const post = (url: string, body: Record<string, unknown> = {}) =>
  supertest(app).post(url).set(owner).send(body);
const get = (url: string) => supertest(app).get(url).set(owner);

/** Cash into the branch, recognised as donation income exactly once. */
async function donate(amount: number): Promise<string> {
  const res = await post('/api/funding/donations', { donorId, amount }).expect(201);
  return res.body.id as string;
}

function fundScholarship(donationId: string, amount: number) {
  return post(`/api/funding/scholarships/${scholarshipId}/fundings`, { donationId, amount });
}

function award(amount: number, student = studentId) {
  return post('/api/funding/scholarships/award', { scholarshipId, studentId: student, amount });
}

async function obligationOf(student = studentId): Promise<{ id: string; outstanding: number; netAmount: number }> {
  const res = await get(`/api/funding/students/${student}/tuition-obligations`).expect(200);
  return res.body[0];
}

const ledgerRows = () =>
  db.prepare(`SELECT type, category, amount FROM financial_transactions WHERE branch_id = ? ORDER BY rowid`).all(branch) as Array<{
    type: string; category: string; amount: number;
  }>;

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7s_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  otherBranch = `${key}_ob`;
  for (const b of [branch, otherBranch]) {
    db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(b, b);
  }
  studentId = `${key}_s`;
  otherStudentId = `${key}_s2`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Scholar', 'active', ?, ?, 'female', ?)`,
  ).run(studentId, `TH-S${key.slice(-5)}`, today(), branch, nextPhone());
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Other', 'active', ?, ?, 'male', ?)`,
  ).run(otherStudentId, `TH-O${key.slice(-5)}`, today(), branch, nextPhone());
  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term One', ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, today());
  donorId = `${key}_donor`;
  db.prepare(`INSERT INTO donors (id, full_name, type) VALUES (?, 'Generous Donor', 'individual')`).run(donorId);
  scholarshipId = `${key}_sch`;
  db.prepare(
    `INSERT INTO scholarships (id, name, donor_id, total_budget, allocated_amount, branch_id)
     VALUES (?, 'Need-based fund', ?, 50000, 0, ?)`,
  ).run(scholarshipId, donorId, branch);
  seedUser({ id: `${key}_owner`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_owner`);
});

describe('WP-07 · a fund can only award money it has received', () => {
  it('D-121 · a declared budget is not money: an unfunded fund can award nothing', async () => {
    // The fund declares a 50,000 AFN target and has received nothing.
    const res = await award(1000);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/Received 0 AFN/);
    expect((db.prepare('SELECT COUNT(*) c FROM scholarship_awards WHERE scholarship_id = ?').get(scholarshipId) as { c: number }).c).toBe(0);
  });

  it('an award is bounded by received donations, not by the declared target', async () => {
    const donation = await donate(4000);
    await fundScholarship(donation, 4000).expect(201);

    expect((await award(4001)).status).toBe(409);
    await award(4000).expect(201);
    // The fund is now fully committed even though its declared target is 50,000.
    expect((await award(1)).status).toBe(409);
  });

  it('a donation cannot be allocated to funds beyond its own value', async () => {
    const donation = await donate(3000);
    await fundScholarship(donation, 2000).expect(201);
    const over = await fundScholarship(donation, 1001);
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toMatch(/1000 AFN of that donation is still unallocated/);
    await fundScholarship(donation, 1000).expect(201);

    const position = (await get(`/api/funding/scholarships/${scholarshipId}/position`).expect(200)).body;
    expect(position).toMatchObject({ received: 3000, committed: 0, available: 3000, declaredTarget: 50000 });
  });

  it('a fund may only be funded by a donation of its own branch', async () => {
    const donation = await donate(1000);
    db.prepare('UPDATE donations SET branch_id = ? WHERE id = ?').run(otherBranch, donation);
    const res = await fundScholarship(donation, 1000);
    expect(res.status).toBe(400);
  });
});

describe('WP-07 · applying an award settles tuition and moves no money', () => {
  beforeEach(async () => {
    const donation = await donate(10000);
    await fundScholarship(donation, 10000).expect(201);
  });

  it('D-120 · a scholarship-settled term is settled, and no cash or income moves', async () => {
    const cashBefore = getFinanceAccount('branch', branch);
    const ledgerBefore = ledgerRows().length;

    const awarded = await award(6000).expect(201);
    const obligation = await obligationOf();
    expect(obligation).toMatchObject({ netAmount: 10000, outstanding: 10000 });

    const applied = await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, {
      obligationId: obligation.id,
      amount: 6000,
    }).expect(201);
    expect(applied.body.obligation).toMatchObject({ settledAid: 6000, settledCash: 0, outstanding: 4000 });

    // No new ledger row, and branch cash is exactly where the donation left it.
    expect(ledgerRows().length).toBe(ledgerBefore);
    expect(getFinanceAccount('branch', branch)).toEqual(cashBefore);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);

    // The student's tuition position reflects it.
    expect(getStudentBalance(db, studentId, 'all')).toMatchObject({ tuitionDue: 10000, tuitionPaid: 6000, outstanding: 4000 });
  });

  it('the donor afghani is recognised exactly once', async () => {
    const income = ledgerRows().filter((r) => r.type === 'income');
    expect(income.map((r) => r.category)).toEqual(['donation']);
    const awarded = await award(10000).expect(201);
    const obligation = await obligationOf();
    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligation.id, amount: 10000 }).expect(201);

    const after = ledgerRows().filter((r) => r.type === 'income');
    expect(after.map((r) => r.category)).toEqual(['donation']);
    expect(after.reduce((s, r) => s + r.amount, 0)).toBe(10000);
  });

  it('a term the scholarship settled cannot be collected again in cash', async () => {
    const awarded = await award(10000).expect(201);
    const obligation = await obligationOf();
    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligation.id, amount: 10000 }).expect(201);

    const collect = await post(`/api/students/${studentId}/payments`, { category: 'fee', amount: 1, semesterId });
    expect(collect.status).toBe(400);
    expect(String(collect.body.error)).toMatch(/already fully paid/i);
  });

  it('cash and scholarship can share one term, never beyond it', async () => {
    await post(`/api/students/${studentId}/payments`, { category: 'fee', amount: 4000, semesterId }).expect(201);
    const awarded = await award(10000).expect(201);
    const obligation = await obligationOf();
    expect(obligation.outstanding).toBe(6000);

    const tooMuch = await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligation.id, amount: 6001 });
    expect(tooMuch.status).toBe(400);
    expect(String(tooMuch.body.error)).toMatch(/6000 AFN is still outstanding/);

    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligation.id, amount: 6000 }).expect(201);
    expect(getStudentBalance(db, studentId, 'all').outstanding).toBe(0);
  });

  it('one award may be applied across several obligations', async () => {
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, 'Term Two', ?, 10000, 10000, 'active')`,
    ).run(`${key}_sem2`, studentId, today());

    const awarded = await award(9000).expect(201);
    const obligations = (await get(`/api/funding/students/${studentId}/tuition-obligations`).expect(200)).body as Array<{ id: string }>;
    expect(obligations).toHaveLength(2);

    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligations[0].id, amount: 5000 }).expect(201);
    await post(`/api/funding/scholarship-awards/${awarded.body.id}/allocations`, { obligationId: obligations[1].id, amount: 4000 }).expect(201);

    const position = (await get(`/api/funding/scholarship-awards/${awarded.body.id}`).expect(200)).body;
    expect(position).toMatchObject({ amount: 9000, allocated: 9000, remaining: 0 });
    expect(getStudentBalance(db, studentId, 'all')).toMatchObject({ tuitionDue: 20000, tuitionPaid: 9000, outstanding: 11000 });
  });
});

describe('WP-07 · reversal returns money to scholarship funding, never to the student', () => {
  let awardId: string;
  let obligationId: string;

  beforeEach(async () => {
    const donation = await donate(10000);
    await fundScholarship(donation, 10000).expect(201);
    awardId = (await award(8000).expect(201)).body.id;
    obligationId = (await obligationOf()).id;
    await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId, amount: 8000 }).expect(201);
  });

  it('reversing an application re-opens exactly that obligation and refunds nobody', async () => {
    const allocations = (await get(`/api/funding/scholarship-awards/${awardId}`).expect(200)).body.allocations as Array<{ id: string }>;
    const cashBefore = getFinanceAccount('branch', branch);

    const reversed = await post(`/api/funding/scholarship-awards/${awardId}/allocations/${allocations[0].id}/reverse`, {
      reason: 'Student withdrew before the term started',
    }).expect(200);

    expect(reversed.body.obligation).toMatchObject({ settledAid: 0, outstanding: 10000 });
    expect(reversed.body.award).toMatchObject({ allocated: 0, remaining: 8000 });
    // The money did not reach the student and did not reach the branch.
    expect(getFinanceAccount('branch', branch)).toEqual(cashBefore);
    expect((db.prepare(`SELECT COUNT(*) c FROM payments WHERE student_id = ?`).get(studentId) as { c: number }).c).toBe(0);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('the reversal is a state change, never a deletion', async () => {
    const allocations = (await get(`/api/funding/scholarship-awards/${awardId}`).expect(200)).body.allocations as Array<{ id: string }>;
    await post(`/api/funding/scholarship-awards/${awardId}/allocations/${allocations[0].id}/reverse`, { reason: 'Corrected entry' }).expect(200);
    const row = db.prepare('SELECT status, reversal_reason, reversed_by, reversed_at FROM obligation_allocations WHERE id = ?').get(allocations[0].id) as any;
    expect(row.status).toBe('reversed');
    expect(row.reversal_reason).toBe('Corrected entry');
    expect(row.reversed_by).toBe('Owner');
    expect(row.reversed_at).toBeTruthy();
  });

  it('closing an award returns only the unapplied remainder to the fund', async () => {
    const allocations = (await get(`/api/funding/scholarship-awards/${awardId}`).expect(200)).body.allocations as Array<{ id: string }>;
    await post(`/api/funding/scholarship-awards/${awardId}/allocations/${allocations[0].id}/reverse`, { reason: 'Withdrew from the term' }).expect(200);

    const closed = await post(`/api/funding/scholarship-awards/${awardId}/close`, { reason: 'Student left the institute' }).expect(200);
    expect(closed.body).toMatchObject({ returnedToFund: 8000 });
    expect(closed.body.fund).toMatchObject({ received: 10000, committed: 0, available: 10000 });

    // A closed award can no longer be applied.
    const reapply = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId, amount: 100 });
    expect(reapply.status).toBe(409);
  });

  it('closing an award leaves applied money where it was applied', async () => {
    const closed = await post(`/api/funding/scholarship-awards/${awardId}/close`, { reason: 'Remainder not needed' }).expect(200);
    expect(closed.body).toMatchObject({ returnedToFund: 0 });
    // The settled obligation stays settled.
    const obligation = await obligationOf();
    expect(obligation.outstanding).toBe(2000);
  });
});

describe('WP-07 · attack · scholarship money cannot be misdirected', () => {
  let awardId: string;

  beforeEach(async () => {
    const donation = await donate(10000);
    await fundScholarship(donation, 10000).expect(201);
    awardId = (await award(5000).expect(201)).body.id;
  });

  it("refuses an obligation belonging to another student", async () => {
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, 'Other Term', ?, 5000, 5000, 'active')`,
    ).run(`${key}_sem_o`, otherStudentId, today());
    const theirs = (await get(`/api/funding/students/${otherStudentId}/tuition-obligations`).expect(200)).body[0];

    const res = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: theirs.id, amount: 1000 });
    expect(res.status).toBe(403);
  });

  it('refuses an allocation naming no obligation, and a zero or fractional amount', async () => {
    const obligation = await obligationOf();
    expect((await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { amount: 100 })).status).toBe(400);
    for (const amount of [0, -100, 10.5, 'abc', [100], true, null]) {
      const res = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount });
      expect(res.status).toBe(400);
    }
    // Scoped to this award: the suite shares one database file across cases.
    expect(
      (db.prepare('SELECT COUNT(*) c FROM obligation_allocations WHERE scholarship_award_id = ?').get(awardId) as { c: number }).c,
    ).toBe(0);
  });

  it('refuses more than the award still holds', async () => {
    const obligation = await obligationOf();
    await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 3000 }).expect(201);
    const over = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 2001 });
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toMatch(/2000 AFN of this award is still unapplied/);
  });

  it('two concurrent applications cannot together exceed the award', async () => {
    const obligation = await obligationOf();
    const [a, b] = await Promise.all([
      post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 5000 }),
      post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 5000 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const applied = db.prepare(
      `SELECT COALESCE(SUM(amount),0) t FROM obligation_allocations WHERE scholarship_award_id = ? AND status = 'active'`,
    ).get(awardId) as { t: number };
    expect(applied.t).toBe(5000);
  });

  it('two concurrent awards cannot together exceed the fund', async () => {
    // 10,000 received, 5,000 already committed by the fixture award.
    const [a, b] = await Promise.all([award(5000), award(5000, otherStudentId)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const fund = (await get(`/api/funding/scholarships/${scholarshipId}/position`).expect(200)).body;
    expect(fund).toMatchObject({ received: 10000, committed: 10000, available: 0 });
  });

  it('refuses a reversal without a reason, and a double reversal', async () => {
    const obligation = await obligationOf();
    const applied = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 1000 }).expect(201);

    expect((await post(`/api/funding/scholarship-awards/${awardId}/allocations/${applied.body.id}/reverse`, { reason: 'short' })).status).toBe(400);
    await post(`/api/funding/scholarship-awards/${awardId}/allocations/${applied.body.id}/reverse`, { reason: 'Duplicate entry corrected' }).expect(200);
    expect((await post(`/api/funding/scholarship-awards/${awardId}/allocations/${applied.body.id}/reverse`, { reason: 'Duplicate entry corrected' })).status).toBe(409);
  });

  it("refuses to reverse an allocation through another award", async () => {
    const obligation = await obligationOf();
    const applied = await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 1000 }).expect(201);
    const secondAward = (await award(2000, otherStudentId)).body.id;
    const res = await post(`/api/funding/scholarship-awards/${secondAward}/allocations/${applied.body.id}/reverse`, { reason: 'Attempted cross-award reversal' });
    expect(res.status).toBe(400);
  });

  it('the database refuses an allocation naming two instruments, or none', () => {
    const obligation = db.prepare(
      `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
       VALUES (?, ?, ?, 'tuition', ?, 'open') RETURNING id`,
    ).get(`${key}_obl_raw`, studentId, branch, semesterId) as { id: string };

    const insert = (sourceKind: string, paymentId: string | null, awardRef: string | null) =>
      db.prepare(
        `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, payment_id, scholarship_award_id, date)
         VALUES (?, ?, 100, ?, ?, ?, ?)`,
      ).run(`alloc_${randomUUID()}`, obligation.id, sourceKind, paymentId, awardRef, today());

    expect(() => insert('scholarship', null, null)).toThrow(/CHECK/i);
    expect(() => insert('payment', null, awardId)).toThrow(/CHECK/i);
    expect(() => insert('scholarship', 'pay_x', awardId)).toThrow(/CHECK|FOREIGN/i);
  });

  it('the database refuses a second obligation for one semester', () => {
    db.prepare(
      `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
       VALUES (?, ?, ?, 'tuition', ?, 'open')`,
    ).run(`${key}_obl_a`, studentId, branch, semesterId);
    expect(() =>
      db.prepare(
        `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
         VALUES (?, ?, ?, 'tuition', ?, 'open')`,
      ).run(`${key}_obl_b`, studentId, branch, semesterId),
    ).toThrow(/UNIQUE/i);
  });

  it("the database refuses an obligation over another student's semester", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
         VALUES (?, ?, ?, 'tuition', ?, 'open')`,
      ).run(`${key}_obl_x`, otherStudentId, branch, semesterId),
    ).toThrow(/another student/i);
  });

  it('a funded donation and an applied award cannot be deleted away', async () => {
    const obligation = await obligationOf();
    await post(`/api/funding/scholarship-awards/${awardId}/allocations`, { obligationId: obligation.id, amount: 1000 }).expect(201);
    const donation = db.prepare('SELECT id FROM donations LIMIT 1').get() as { id: string };
    expect(() => db.prepare('DELETE FROM donations WHERE id = ?').run(donation.id)).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare('DELETE FROM student_obligations WHERE id = ?').run(obligation.id)).toThrow(/FOREIGN KEY/i);
  });
});

describe('WP-07 · the funding screen renders server truth, it does not compute it', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'src', 'components', 'funding', 'FundingView.tsx'),
    'utf8',
  );

  it('reads the fund position from the server instead of subtracting in the browser', () => {
    expect(source).toContain('/funding/scholarships/${sc.id}/position');
    // The retired client arithmetic: a declared target minus a mirrored total.
    expect(source).not.toContain('const remaining = sc.totalBudget - sc.allocatedAmount;');
    expect(source).not.toContain('awardingScholarship.totalBudget - awardingScholarship.allocatedAmount');
  });

  it('offers the operator the whole approved lifecycle', () => {
    expect(source).toContain('/funding/scholarships/${fundingScholarship.id}/fundings');
    expect(source).toContain('/funding/scholarship-awards/${managingAward.id}/allocations');
    expect(source).toContain('/allocations/${allocationId}/reverse');
    expect(source).toContain('/funding/scholarship-awards/${managingAward.id}/close');
    expect(source).toContain('/funding/students/${award.studentId}/tuition-obligations');
  });

  it('states where reversed money goes, so the operator is not guessing', () => {
    expect(source).toMatch(/Reversing an application returns the money to this award/);
    expect(source).toMatch(/never paid to a student/i);
  });
});
