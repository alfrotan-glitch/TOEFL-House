/**
 * WP-07 · Sponsorship money is real money (owner decision S6).
 * ============================================================================
 * `sponsorship_agreements.monthly_amount` was a number with no financial
 * effect: an agreement promising 5,000 AFN a month settled nothing, reduced no
 * tuition, and appeared in no position. A promise is not money.
 *
 * What settles tuition is a RECEIPT — a donation from the sponsoring donor,
 * earmarked to the agreement — applied to a named tuition obligation through
 * `obligation_allocations`, the one settlement authority (D-120).
 *
 * The two rules that make this safe, and which these cases pin:
 *
 *   NO CASH IS CREATED. The donor's money was recognised as income when the
 *   donation arrived. Applying it to tuition writes no ledger row and moves no
 *   branch cash, exactly as a scholarship does — recognising it twice would
 *   break the derived cash position.
 *
 *   NO AFGHANI BACKS TWO COMMITMENTS. A donation may be earmarked to a
 *   scholarship fund or to a sponsorship agreement, and both compete for the
 *   same unallocated remainder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { getStudentBalance, getSemesterTuitionSettled } from '../../../utils/studentBalance.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { getFinanceAccount } from '../../../utils/financeAccounts.js';
import { ensureTuitionObligation } from '../../../core/finance/obligations.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let donorId: string;
let studentId: string;
let otherStudentId: string;
let semesterId: string;
let obligationId: string;
let agreementId: string;
let owner: { Authorization: string };
const SEMESTER = 'Sponsored Term';
let phoneSeq = 0;
const nextPhone = () => `07${String(2000000 + (phoneSeq += 1) + (process.pid % 100000)).slice(-8)}`;

/** A real donation from the sponsoring donor, recognised as income on arrival. */
function seedDonation(amount: number, donor = donorId): string {
  const id = `${key}_don${++phoneSeq}`;
  db.prepare(
    `INSERT INTO donations (id, donor_id, amount, date, receipt_no, branch_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, donor, amount, today(), `DON-${id.slice(-8)}`, branch, id);
  return id;
}

const position = () =>
  supertest(app).get(`/api/funding/sponsorships/${agreementId}/position`).set(owner);

const receipt = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/funding/sponsorships/${agreementId}/receipts`).set(owner).send(body);

const allocate = (body: Record<string, unknown>) =>
  supertest(app).post(`/api/funding/sponsorships/${agreementId}/allocations`).set(owner).send(body);

const ledgerRows = () =>
  db.prepare(`SELECT COUNT(*) AS c FROM financial_transactions WHERE branch_id = ?`).get(branch) as { c: number };

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7s_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);

  donorId = `${key}_donor`;
  db.prepare(
    `INSERT INTO donors (id, full_name, type) VALUES (?, 'Sponsor Donor', 'individual')`,
  ).run(donorId);

  studentId = `${key}_stu`;
  otherStudentId = `${key}_stu2`;
  for (const [sid, name] of [[studentId, 'Sponsored Student'], [otherStudentId, 'Unsponsored Student']]) {
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES (?, ?, ?, 'active', ?, ?, 'female', ?)`,
    ).run(sid, `TH-S${(phoneSeq += 1)}-${sid.slice(-6)}`, name, today(), branch, nextPhone());
  }

  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, 12000, 12000, 'active')`,
  ).run(semesterId, studentId, SEMESTER, today());
  obligationId = ensureTuitionObligation(db, semesterId).id;

  agreementId = `${key}_spon`;
  db.prepare(
    `INSERT INTO sponsorship_agreements (id, donor_id, student_id, monthly_amount, start_date, end_date, status, branch_id)
     VALUES (?, ?, ?, 5000, ?, '2099-12-31', 'active', ?)`,
  ).run(agreementId, donorId, studentId, today(), branch);

  seedUser({ id: `${key}_own`, role: 'owner', branchId: branch, fullName: 'Owner' });
  owner = bearerFor(`${key}_own`);
});

describe('WP-07 · S6 — a promise settles nothing, received money settles tuition', () => {
  it('an agreement with a monthly amount but no receipts can settle nothing', async () => {
    const res = await position().expect(200);
    expect(res.body.monthlyAmount).toBe(5000);
    expect(res.body.received).toBe(0);
    expect(res.body.available).toBe(0);

    const attempt = await allocate({ obligationId, amount: 5000 });
    expect(attempt.status).toBe(400);
    expect(String(attempt.body.error)).toMatch(/received no money/i);
    expect(getStudentBalance(db, studentId).outstanding).toBe(12000);
  });

  it('a receipt backs the agreement and applying it settles the named term', async () => {
    const donation = seedDonation(5000);
    const cashBefore = getFinanceAccount('branch', branch);
    const ledgerBefore = ledgerRows().c;

    const funded = await receipt({ donationId: donation, amount: 5000 }).expect(201);
    expect(funded.body.received).toBe(5000);
    expect(funded.body.available).toBe(5000);

    const applied = await allocate({ obligationId, amount: 5000 }).expect(201);
    expect(applied.body.obligation.settledAid).toBe(5000);
    expect(applied.body.obligation.outstanding).toBe(7000);

    // The term and the student both know about the money.
    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(5000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(7000);

    // And no cash was created: the donor's money was recognised on arrival.
    const cashAfter = getFinanceAccount('branch', branch);
    expect(cashAfter.mainBalance).toBe(cashBefore.mainBalance);
    expect(cashAfter.savingBalance).toBe(cashBefore.savingBalance);
    expect(ledgerRows().c).toBe(ledgerBefore);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a sponsorship cannot apply more than it has received', async () => {
    await receipt({ donationId: seedDonation(3000), amount: 3000 }).expect(201);
    const res = await allocate({ obligationId, amount: 3001 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/3000 AFN of this sponsorship is still unapplied/i);
  });

  it('a sponsorship cannot apply more than the term still owes', async () => {
    await receipt({ donationId: seedDonation(20000), amount: 20000 }).expect(201);
    const res = await allocate({ obligationId, amount: 12001 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/12000 AFN is still outstanding/i);
  });

  it('an agreement that names a student cannot settle another student\u2019s tuition', async () => {
    const otherSemester = `${key}_sem2`;
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, 'Other Term', ?, 8000, 8000, 'active')`,
    ).run(otherSemester, otherStudentId, today());
    const otherObligation = ensureTuitionObligation(db, otherSemester).id;

    await receipt({ donationId: seedDonation(8000), amount: 8000 }).expect(201);
    const res = await allocate({ obligationId: otherObligation, amount: 8000 });
    expect(res.status).toBe(403);
    expect(getStudentBalance(db, otherStudentId).outstanding).toBe(8000);
  });

  it('a receipt must come from the donor who signed the agreement', async () => {
    const stranger = `${key}_donor2`;
    db.prepare(
      `INSERT INTO donors (id, full_name, type) VALUES (?, 'Unrelated Donor', 'individual')`,
    ).run(stranger);
    const res = await receipt({ donationId: seedDonation(5000, stranger), amount: 5000 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/donor who signed/i);
  });

  it('one afghani cannot back both a scholarship fund and a sponsorship', async () => {
    const scholarshipId = `${key}_sch`;
    db.prepare(
      `INSERT INTO scholarships (id, name, total_budget, branch_id) VALUES (?, 'Fund', 50000, ?)`,
    ).run(scholarshipId, branch);

    const donation = seedDonation(5000);
    await supertest(app)
      .post(`/api/funding/scholarships/${scholarshipId}/fundings`)
      .set(owner)
      .send({ donationId: donation, amount: 4000 })
      .expect(201);

    // Only 1,000 of that donation is left, whichever instrument asks for it.
    const res = await receipt({ donationId: donation, amount: 2000 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/1000 AFN of that donation is still unallocated/i);

    await receipt({ donationId: donation, amount: 1000 }).expect(201);
    const after = await supertest(app).get(`/api/funding/donations/${donation}/allocation`).set(owner).expect(200);
    expect(after.body.unallocated).toBe(0);
  });

  it('reversing an allocation returns the money to its agreement and re-opens the term', async () => {
    await receipt({ donationId: seedDonation(12000), amount: 12000 }).expect(201);
    const applied = await allocate({ obligationId, amount: 12000 }).expect(201);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);

    const reversed = await supertest(app)
      .post(`/api/funding/sponsorship-allocations/${applied.body.id}/reverse`)
      .set(owner)
      .send({ reason: 'sponsor withdrew for this term' })
      .expect(200);

    // Back to the AGREEMENT — still the donor's money, still earmarked.
    expect(reversed.body.sponsorship.available).toBe(12000);
    expect(reversed.body.obligation.outstanding).toBe(12000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(12000);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);

    // It is re-applicable, and cannot be reversed twice.
    const again = await supertest(app)
      .post(`/api/funding/sponsorship-allocations/${applied.body.id}/reverse`)
      .set(owner)
      .send({ reason: 'attempting the same reversal twice' });
    expect(again.status).toBe(409);
  });

  it('a reversal needs a stated reason', async () => {
    await receipt({ donationId: seedDonation(1000), amount: 1000 }).expect(201);
    const applied = await allocate({ obligationId, amount: 1000 }).expect(201);
    const res = await supertest(app)
      .post(`/api/funding/sponsorship-allocations/${applied.body.id}/reverse`)
      .set(owner)
      .send({ reason: 'short' });
    expect(res.status).toBe(400);
  });

  it('a terminated agreement receives nothing and settles nothing', async () => {
    await receipt({ donationId: seedDonation(5000), amount: 5000 }).expect(201);
    db.prepare("UPDATE sponsorship_agreements SET status = 'terminated' WHERE id = ?").run(agreementId);

    expect((await receipt({ donationId: seedDonation(1000), amount: 1000 })).status).toBe(409);
    expect((await allocate({ obligationId, amount: 5000 })).status).toBe(409);
  });
});

describe('WP-07 · S6 · ATTACK — money that must not appear', () => {
  const amounts: Array<[string, unknown]> = [
    ['text', 'abc'],
    ['boolean', true],
    ['array', [5000]],
    ['sub-afghani', 0.5],
    ['negative', -5000],
    ['zero', 0],
    ['Infinity', Infinity],
    ['null', null],
  ];

  it.each(amounts)('a receipt of %s is refused and backs nothing', async (_label, amount) => {
    const res = await receipt({ donationId: seedDonation(5000), amount });
    expect(res.status).toBe(400);
    expect((await position()).body.received).toBe(0);
  });

  it.each(amounts)('an allocation of %s is refused and settles nothing', async (_label, amount) => {
    await receipt({ donationId: seedDonation(5000), amount: 5000 }).expect(201);
    const res = await allocate({ obligationId, amount });
    expect(res.status).toBe(400);
    expect(getStudentBalance(db, studentId).outstanding).toBe(12000);
  });

  it('the database refuses an allocation that names two instruments at once', () => {
    const scholarshipId = `${key}_sch2`;
    db.prepare(`INSERT INTO scholarships (id, name, total_budget, branch_id) VALUES (?, 'F', 0, ?)`).run(scholarshipId, branch);
    const awardId = `${key}_awd`;
    db.prepare(
      `INSERT INTO scholarship_awards (id, scholarship_id, student_id, amount, status, branch_id, award_date)
       VALUES (?, ?, ?, 1000, 'active', ?, ?)`,
    ).run(awardId, scholarshipId, studentId, branch, today());

    expect(() =>
      db
        .prepare(
          `INSERT INTO obligation_allocations
             (id, obligation_id, amount, source_kind, sponsorship_agreement_id, scholarship_award_id, status, date)
           VALUES (?, ?, 1000, 'sponsorship', ?, ?, 'active', ?)`,
        )
        .run(`${key}_bad`, obligationId, agreementId, awardId, today()),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('the database refuses a sponsorship allocation that names no agreement', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, status, date)
           VALUES (?, ?, 1000, 'sponsorship', 'active', ?)`,
        )
        .run(`${key}_bad2`, obligationId, today()),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('sponsorship money never lets a term be collected in cash a second time', async () => {
    await receipt({ donationId: seedDonation(12000), amount: 12000 }).expect(201);
    await allocate({ obligationId, amount: 12000 }).expect(201);

    // The term is settled, so nothing of it remains to be billed or collected.
    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(12000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });
});

// ── S5 — the boundary the owner ruled on ───────────────────────────────────
//
// The owner ruled that the 100% `SPONSORSHIP` discount category and a
// sponsorship agreement are DIFFERENT CONCEPTS and both stay. They are easy to
// confuse and their money behaves in opposite ways, so the difference is
// asserted here rather than left to a reader's memory.
//
//   DISCOUNT `SPONSORSHIP`   reduces what the student is CHARGED. The term
//                            bills less. No donor money exists; the institute
//                            forgoes revenue. Requires owner authorization.
//
//   SPONSORSHIP AGREEMENT    leaves the charge alone and SETTLES it with a
//                            donor's real, received money through
//                            `obligation_allocations`.
describe('WP-07 · S5 — a sponsorship discount and a sponsorship agreement are different things', () => {
  it('a sponsorship agreement changes what the term is charged: nothing', async () => {
    const chargedBefore = (db.prepare('SELECT net_fee_amount FROM student_semesters WHERE id = ?').get(semesterId) as { net_fee_amount: number }).net_fee_amount;

    await receipt({ donationId: seedDonation(12000), amount: 12000 }).expect(201);
    await allocate({ obligationId, amount: 12000 }).expect(201);

    const chargedAfter = (db.prepare('SELECT net_fee_amount FROM student_semesters WHERE id = ?').get(semesterId) as { net_fee_amount: number }).net_fee_amount;
    expect(chargedAfter).toBe(chargedBefore);

    // The debt is gone because it was PAID, not because it was reduced.
    const settled = db
      .prepare(
        `SELECT source_kind, amount FROM obligation_allocations WHERE obligation_id = ? AND status = 'active'`,
      )
      .all(obligationId) as Array<{ source_kind: string; amount: number }>;
    expect(settled).toEqual([{ source_kind: 'sponsorship', amount: 12000 }]);
  });

  it('the two concepts live in different tables and neither can stand in for the other', () => {
    // The discount category is a configuration value; the agreement is money.
    const allocationKinds = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='obligation_allocations'").get() as { sql: string }
    ).sql;
    expect(allocationKinds).toContain("'sponsorship'");
    expect(allocationKinds).not.toContain('discount');

    const agreementColumns = (db.prepare('PRAGMA table_info(sponsorship_agreements)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(agreementColumns).not.toContain('discount_percent');
    expect(agreementColumns).toContain('monthly_amount');
  });
});

// ── S6 operator surface ────────────────────────────────────────────────────
//
// The API above is proven, but proven server code nobody can reach is not a
// delivered capability. These cases are structural — they cannot prove pixels —
// but they pin the architectural invariants the funding screen must hold, the
// same way D-124 pinned them for the scholarship lifecycle:
//
//   LAW 2 / §28  the screen RENDERS the server's position and never derives one
//   §35          money that changes a student's tuition position invalidates
//                the datasets that publish it, not just this screen's state
import { readFileSync as readSource } from 'node:fs';
import { dirname as dirOf, join as joinPath } from 'node:path';
import { fileURLToPath as urlToPath } from 'node:url';

describe('WP-07 · S6 — the funding screen can actually run a sponsorship', () => {
  const source = readSource(
    joinPath(dirOf(urlToPath(import.meta.url)), '..', '..', '..', '..', '..', 'src', 'components', 'funding', 'FundingView.tsx'),
    'utf8',
  );

  it('reads the sponsorship position from the server instead of showing only the promise', () => {
    expect(source).toContain('/funding/sponsorships/${sp.id}/position');
    // received / applied / available are the server's words, rendered as-is.
    expect(source).toMatch(/sponsorshipPosition[\s\S]*received/);
    expect(source).toMatch(/available/);
  });

  it('offers the whole approved sponsorship lifecycle', () => {
    expect(source).toContain('/receipts');
    expect(source).toContain('/funding/sponsorships/${managingSponsorship.id}/allocations');
    expect(source).toContain('/funding/sponsorship-allocations/${allocationId}/reverse');
    expect(source).toContain('/funding/students/${');
  });

  it('invalidates the datasets a sponsorship application changes', () => {
    // Applying sponsorship money settles tuition, so the student and payment
    // datasets are stale the moment it succeeds.
    const applyBlock = source.slice(source.indexOf('submitSponsorshipApplication'));
    expect(applyBlock).toMatch(/invalidate\('students', 'payments', 'funding'\)/);
  });

  it('states that a promise is not money, so the operator is not misled', () => {
    expect(source).toMatch(/promise/i);
    expect(source).toMatch(/settles nothing|not money|until it is received/i);
  });

  it('never computes a sponsorship position in the browser', () => {
    // The retired client arithmetic pattern: deriving a balance from the
    // monthly promise instead of reading what was received.
    expect(source).not.toMatch(/monthlyAmount\s*[-*]\s*/);
    expect(source).not.toMatch(/received\s*-\s*applied/);
  });
});

describe('WP-07 · S6 · ATTACK — the operator surface cannot invent or overstate money', () => {
  const source = readSource(
    joinPath(dirOf(urlToPath(import.meta.url)), '..', '..', '..', '..', '..', 'src', 'components', 'funding', 'FundingView.tsx'),
    'utf8',
  );

  it('the apply action is unavailable while the agreement has received nothing', () => {
    expect(source).toMatch(/disabled=\{sponsorshipPosition\.available <= 0\}/);
    expect(source).toMatch(/Nothing received yet to apply/);
  });

  it('only donations from the signing donor are offered as backing', () => {
    expect(source).toMatch(/donations\s*\n?\s*\.filter\(\(d\) => d\.donorId === managingSponsorship\.donorId\)/);
  });

  it('a reversal cannot be issued without a stated reason', () => {
    const block = source.slice(source.indexOf('reverseSponsorshipApplication'));
    expect(block).toMatch(/window\.prompt\(/);
    expect(block).toMatch(/if \(!reason\) return;/);
  });

  it('the promise and the money are shown as different things', () => {
    expect(source).toMatch(/Promised \/ month/);
    expect(source).toMatch(/Received/);
    // The promise must never be rendered as the agreement's money.
    expect(source).not.toMatch(/available.*=.*monthlyAmount/);
  });

  it('an obligation position reports AID, not "scholarship", now that a sponsorship settles tuition', () => {
    // A field named for one instrument would report a donor's sponsorship as
    // scholarship money on every screen that reads it.
    expect(source).toContain('settledAid');
    expect(source).not.toContain('settledScholarship');
  });
});

// ── C-2 re-expression: the newer money writers join the sweeps ─────────────
//
// `finance-money-writer-parity` sweeps four writers (invoice payment, ad-hoc
// payment, refund, donation desk) and `money-writer-idempotency` covers retries
// for two of them. Slices E–G added four more money writers, and neither sweep
// reached them. Parity and retry safety for the sponsorship writers are
// asserted here, beside the authority they belong to, rather than by widening a
// suite whose fixtures know nothing about agreements.
describe('WP-07 · C-2 · the sponsorship writers hold the money-writer contract', () => {
  it('a retried receipt earmarks the money once, not twice', async () => {
    const donation = seedDonation(5000);
    const body = { donationId: donation, amount: 5000 };

    await receipt(body).expect(201);
    const retry = await receipt(body);

    // The second attempt must not double the backing. It is refused because the
    // donation has nothing left, which is the bound that matters.
    expect(retry.status).toBe(400);
    expect((await position()).body.received).toBe(5000);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM sponsorship_receipts WHERE agreement_id = ?').get(agreementId),
    ).toEqual({ c: 1 });
  });

  it('a retried application settles the term once, not twice', async () => {
    await receipt({ donationId: seedDonation(12000), amount: 12000 }).expect(201);
    const body = { obligationId, amount: 12000 };

    await allocate(body).expect(201);
    const retry = await allocate(body);

    expect(retry.status).toBe(400);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
    expect(
      db.prepare(
        `SELECT COUNT(*) AS c FROM obligation_allocations
          WHERE sponsorship_agreement_id = ? AND status = 'active'`,
      ).get(agreementId),
    ).toEqual({ c: 1 });
  });

  it('neither writer moves branch cash, and both keep the books balanced', async () => {
    const before = getFinanceAccount('branch', branch);
    await receipt({ donationId: seedDonation(6000), amount: 6000 }).expect(201);
    await allocate({ obligationId, amount: 6000 }).expect(201);
    const after = getFinanceAccount('branch', branch);

    expect(after.mainBalance).toBe(before.mainBalance);
    expect(after.savingBalance).toBe(before.savingBalance);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a rejected write leaves no trace in either table', async () => {
    const donation = seedDonation(5000);
    expect((await receipt({ donationId: donation, amount: 'abc' })).status).toBe(400);
    expect((await allocate({ obligationId, amount: 'abc' })).status).toBe(400);

    // Scoped: the test database persists across cases in a run, so a global
    // count would read other cases' rows.
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM sponsorship_receipts WHERE agreement_id = ?').get(agreementId),
    ).toEqual({ c: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM obligation_allocations WHERE obligation_id = ?').get(obligationId),
    ).toEqual({ c: 0 });
  });
});
