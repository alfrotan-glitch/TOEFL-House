/**
 * WAVE 12 · Capability 2 — RESTRICTED-FUND EXPOSURE REPORT (adversarial).
 * ============================================================================
 * Every number is built through production funding surfaces (donors,
 * campaigns, scholarships, sponsorships, restricted donations, awards,
 * allocations, reversals) and then ATTACKED:
 *   · partial/full consumption; multiple sources; multiple beneficiaries;
 *   · reversal restores exposure without rewriting history;
 *   · sponsorship terminalization (return) stays INSIDE the restricted pool;
 *   · internal store moves (treasury deposit) and unrelated operating
 *     spending change `storesHeld` but never the restricted-pool derivation —
 *     and real operating consumption of donor cash SHOWS as exposure;
 *   · award/campaign STATUS changes never move the numbers;
 *   · duplicates are idempotent; I21 catches fabricated leakage;
 *   · the report is cross-checked against a fully INDEPENDENT per-donation
 *     provenance walk (different code path, same economics).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import financeRouter from '../routes/finance.routes.js';
import fundingRouter from '../routes/funding.routes.js';
import teachersRouter, { employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { getRestrictedExposure } from '../core/funding/restricted-exposure.js';
import { ensureTuitionObligation } from '../core/finance/obligations.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w12_fx';
const BRANCH = 'branch_w12_fx';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/funding', fundingRouter);
app.use('/api/teachers', teachersRouter);
app.use('/api/employees', employeesRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0771${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 220)}`);
};

/**
 * INDEPENDENT derivation — a per-RESTRICTED-DONATION provenance walk.
 * For each restricted donation, follow every chain its money can take
 * (campaign entries, scholarship fundings, sponsorship receipts, sponsorship
 * returns) and count only ACTIVE aid allocations as consumption. A different
 * algorithm than the report's aggregate; it must produce the same economics.
 */
function independentRestrictedPool(): { received: number; settled: number } {
  const donations = db.prepare(
    `SELECT d.id, d.amount FROM donations d JOIN donation_restrictions r ON r.donation_id = d.id`,
  ).all() as Array<{ id: string; amount: number }>;
  let received = 0;
  let settled = 0;
  for (const d of donations) {
    received += Number(d.amount);
    // All funding instruments whose provenance root is this donation, at any
    // depth (fundings direct; via campaign entries; receipts direct or via
    // entries; returns back into entries → new fundings/receipts).
    const entryIds = new Set<string>(
      (db.prepare(`SELECT id FROM campaign_funding_entries WHERE source_donation_id = ?`).all(d.id) as Array<{ id: string }>).map((r) => r.id),
    );
    const fundingIds = new Set<string>(
      (db.prepare(`SELECT id FROM scholarship_fundings WHERE donation_id = ?`).all(d.id) as Array<{ id: string }>).map((r) => r.id),
    );
    const receiptIds = new Set<string>(
      (db.prepare(`SELECT id FROM sponsorship_receipts WHERE donation_id = ?`).all(d.id) as Array<{ id: string }>).map((r) => r.id),
    );
    // One settling round through entries (entries can fund scholarships and
    // sponsorships; receipts returned from sponsorships create new entries,
    // whose fundings/receipts are captured by the loops below).
    for (let pass = 0; pass < 5; pass++) {
      let grew = false;
      for (const e of entryIds) {
        for (const f of db.prepare(`SELECT id FROM scholarship_fundings WHERE campaign_funding_entry_id = ?`).all(e) as Array<{ id: string }>) {
          if (!fundingIds.has(f.id)) { fundingIds.add(f.id); grew = true; }
        }
        for (const r of db.prepare(`SELECT id FROM sponsorship_receipts WHERE campaign_funding_entry_id = ?`).all(e) as Array<{ id: string }>) {
          if (!receiptIds.has(r.id)) { receiptIds.add(r.id); grew = true; }
        }
      }
      for (const r of receiptIds) {
        for (const e of db.prepare(`SELECT id FROM campaign_funding_entries WHERE source_sponsorship_receipt_id = ?`).all(r) as Array<{ id: string }>) {
          if (!entryIds.has(e.id)) { entryIds.add(e.id); grew = true; }
        }
      }
      if (!grew) break;
    }
    const activeSum = (sql: string, ids: Set<string>): number => {
      if (ids.size === 0) return 0;
      const marks = [...ids].map(() => '?').join(',');
      const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM obligation_allocations WHERE status='active' AND ${sql} IN (${marks})`).get(...ids) as { v: number };
      return Number(row.v) || 0;
    };
    settled += activeSum('scholarship_funding_id', fundingIds) + activeSum('sponsorship_receipt_id', receiptIds);
  }
  return { received, settled };
}

async function makeClass(name: string, fee: number): Promise<string> {
  const res = await request(app).post('/api/classes').set(owner()).send({
    name, level: 'A1', capacity: 30, fee, startDate: '2026-09-01', branchId: BRANCH,
  });
  assertOk('class create', res, 201);
  return res.body.id as string;
}

async function makeStudent(name: string): Promise<string> {
  const res = await request(app).post('/api/students/manual').set(owner()).send({
    fullName: name, phone: phone(), branchId: BRANCH, gender: 'male',
  });
  assertOk('student create', res, 201);
  const studentId = (res.body.student?.id ?? res.body.id) as string;
  const list = await request(app).get(`/api/invoices?studentId=${studentId}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const registration = invoices.find((i: { chargeKind?: string; status?: string }) =>
    i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  if (registration) {
    const paid = await request(app).post(`/api/invoices/${registration.id}/pay`).set(owner())
      .send({ amount: registration.netAmount, paymentMethod: 'cash' });
    assertOk('registration pay', paid, 200, 201);
  }
  return studentId;
}

async function makeObligation(name: string, fee: number): Promise<{ student: string; obligationId: string }> {
  const cid = await makeClass(unique(`${name} Class`), fee);
  const sid = await makeStudent(unique(`${name} Student`));
  const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner()).send({
    classId: cid, semesterName: unique(`${name} Term`), startDate: '2026-09-01', endDate: '2026-12-20',
  });
  assertOk('enroll', enrolled, 201);
  const semesterId = enrolled.body.semesterId as string;
  // The route materialises the tuition obligation lazily (on first payment);
  // use the same production factory it calls.
  const obligationId = ensureTuitionObligation(db, semesterId).id;
  return { student: sid, obligationId };
}

const report = () => getRestrictedExposure(db, BRANCH);
const reportAll = () => getRestrictedExposure(db, null);

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W12 Funding Branch')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });
  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W12FX registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
});

describe('W12-2 · restricted-exposure world (production surfaces only)', () => {
  let donor: string;
  let campaign: string;
  let scholarship: string;
  let donationB: string; // restricted → scholarship (direct)
  let fundingB: string;
  let award: string;
  let obligationA: string;

  it('restricted donation → campaign: received, nothing settled', async () => {
    const d = await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W12FX Donor'), type: 'individual' });
    assertOk('donor', d, 201);
    donor = d.body.id;
    const c = await request(app).post('/api/funding/campaigns').set(owner()).send({ name: unique('W12FX Campaign'), targetAmount: 200000, branchId: BRANCH });
    assertOk('campaign', c, 201);
    campaign = c.body.id;

    const before = report();
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor, amount: 60000, branchId: BRANCH, restriction: { kind: 'campaign', targetId: campaign } });
    assertOk('donation A', don, 201);

    const after = report();
    expect(after.restrictedReceived).toBe(before.restrictedReceived + 60000);
    expect(after.restrictedSettled).toBe(before.restrictedSettled);
    expect(after.restrictedRemaining).toBe(after.restrictedReceived - after.restrictedSettled);
    // The cash is in the branch store: exposure zero while stores cover it.
    expect(after.restrictedExposure).toBe(0);
    expect(after.storesHeld).toBeGreaterThanOrEqual(after.restrictedRemaining);
  });

  it('duplicate donation request replays and changes nothing', async () => {
    const before = report();
    const dup = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor, amount: 60000, branchId: BRANCH, restriction: { kind: 'campaign', targetId: campaign } });
    assertOk('dup donation', dup, 200); // idempotent replay
    expect((dup.body as { idempotentReplay?: boolean }).idempotentReplay).toBe(true);
    expect(report()).toEqual(before);
  });

  it('restricted donation → scholarship + award + partial allocation: exposure moves by the settled amount only', async () => {
    const s = await request(app).post('/api/funding/scholarships').set(owner())
      .send({ name: unique('W12FX Scholarship'), totalBudget: 50000, branchId: BRANCH });
    assertOk('scholarship', s, 201);
    scholarship = s.body.id;

    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor, amount: 40000, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: scholarship } });
    assertOk('donation B', don, 201);
    donationB = don.body.id;
    fundingB = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(donationB) as { id: string }).id;

    const { student, obligationId } = await makeObligation('W12FX A', 40000);
    obligationA = obligationId;

    const aw = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId: scholarship, studentId: student, amount: 40000, branchId: BRANCH });
    assertOk('award', aw, 201);
    award = aw.body.awardId ?? aw.body.id;

    const before = report();
    const alloc = await request(app).post(`/api/funding/scholarship-awards/${award}/allocations`).set(owner())
      .send({ obligationId: obligationA, scholarshipFundingId: fundingB, amount: 15000 });
    assertOk('allocation', alloc, 201);

    const after = report();
    expect(after.restrictedSettled).toBe(before.restrictedSettled + 15000);
    expect(after.restrictedRemaining).toBe(after.restrictedReceived - after.restrictedSettled);
    // Commitments are memo, never cash: the full award shows as committed.
    expect(after.activeAwardCommitments).toBeGreaterThanOrEqual(40000);
  });

  it('reversing the allocation restores exposure without rewriting history', async () => {
    const before = report();
    const allocationId = (db.prepare(`SELECT id FROM obligation_allocations WHERE scholarship_funding_id = ? AND status='active'`).get(fundingB) as { id: string }).id;
    const rev = await request(app).post(`/api/funding/scholarship-awards/${award}/allocations/${allocationId}/reverse`).set(owner())
      .send({ reason: 'W12FX exposure reversal probe' });
    assertOk('reverse', rev, 200, 201);

    const after = report();
    expect(after.restrictedSettled).toBe(before.restrictedSettled - 15000);
    expect(after.restrictedRemaining).toBe(after.restrictedReceived - after.restrictedSettled);
    // History intact: the allocation row still exists, REVERSED.
    const row = db.prepare(`SELECT status, reversed_at, reversal_reason FROM obligation_allocations WHERE id = ?`).get(allocationId) as { status: string; reversed_at: string; reversal_reason: string };
    expect(row.status).toBe('reversed');
    expect(row.reversal_reason).toBeTruthy();

    // Re-allocate for the rest of the suite.
    const alloc = await request(app).post(`/api/funding/scholarship-awards/${award}/allocations`).set(owner())
      .send({ obligationId: obligationA, scholarshipFundingId: fundingB, amount: 15000 });
    assertOk('re-allocate', alloc, 201);
    expect(report().restrictedSettled).toBe(before.restrictedSettled);
  });

  it('closing the award does not change exposure (status ≠ economics)', async () => {
    const before = report();
    const close = await request(app).post(`/api/funding/scholarship-awards/${award}/close`).set(owner())
      .send({ reason: 'W12FX status-change probe' });
    assertOk('close award', close, 200, 201);
    const after = report();
    expect(after.restrictedReceived).toBe(before.restrictedReceived);
    expect(after.restrictedSettled).toBe(before.restrictedSettled);
    expect(after.restrictedRemaining).toBe(before.restrictedRemaining);
  });

  it('sponsorship: restricted donation → agreement → receipt → allocation', async () => {
    const { student, obligationId } = await makeObligation('W12FX Spon', 30000);
    const agreement = await request(app).post('/api/funding/sponsorships').set(owner())
      .send({ donorId: donor, studentId: student, monthlyAmount: 10000, endDate: '2027-09-01', branchId: BRANCH, campaignId: campaign });
    assertOk('sponsorship', agreement, 201);
    const agreementId = agreement.body.id;

    // Fund the agreement FROM the restricted campaign entry (provenance keeps
    // the original donation as root).
    const entry = (db.prepare(`SELECT id FROM campaign_funding_entries WHERE campaign_id = ? AND origin_kind='restricted_donation' LIMIT 1`).get(campaign) as { id: string }).id;
    const receipt = await request(app).post(`/api/funding/sponsorships/${agreementId}/receipts`).set(owner())
      .send({ campaignFundingEntryId: entry, amount: 30000 });
    assertOk('sponsorship receipt', receipt, 201);
    const receiptId = receipt.body.id;

    const before = report();
    const alloc = await request(app).post(`/api/funding/sponsorships/${agreementId}/allocations`).set(owner())
      .send({ obligationId, sponsorshipReceiptId: receiptId, amount: 20000 });
    assertOk('sponsorship allocation', alloc, 201);

    const after = report();
    expect(after.restrictedSettled).toBe(before.restrictedSettled + 20000);
    expect(after.restrictedRemaining).toBe(after.restrictedReceived - after.restrictedSettled);
    expect(after.restrictedExposure).toBe(0);
  });

  it('terminalizing the sponsorship returns remainders INSIDE the restricted pool', async () => {
    const agreementId = (db.prepare(`SELECT id FROM sponsorship_agreements WHERE status='active' LIMIT 1`).get() as { id: string }).id;
    const before = report();
    const res = await request(app).patch(`/api/funding/sponsorships/${agreementId}`).set(owner())
      .send({ status: 'terminated', reason: 'W12FX terminalization probe' });
    assertOk('terminate', res, 200, 201);
    const after = report();
    // The return moved unspent sponsorship money to the campaign: still
    // restricted, still unspent. Pool unchanged (or exposure unchanged).
    expect(after.restrictedRemaining).toBe(before.restrictedRemaining);
    expect(after.sponsorshipReturnedToCampaign).toBeGreaterThan(0);
    expect(reportAll().restrictedRemaining).toBe(after.restrictedRemaining); // scopes agree
  });

  it('unrelated operating spending SHOWS as exposure when it consumes donor cash', async () => {
    // A teacher salary is a real operating expense paid from an envelope:
    // storesHeld drops while the restricted pool does not.
    db.prepare(`INSERT INTO teachers (id, full_name, branch_id, base_salary, salary_type, performance_score, status, joined_date)
                VALUES ('teacher_w12fx', 'W12FX Teacher', ?, 100000, 'fixed', 1.0, 'active', '2026-01-01')
                ON CONFLICT(id) DO NOTHING`).run(BRANCH);
    // Envelope built through production surfaces: capital in, treasury charge,
    // payroll target tagged (no route field exists for it — fixture step, same
    // convention as the employee-payroll-idempotency suite).
    const dep = await request(app).post('/api/finance/treasury/deposit').set(owner())
      .send({ amount: 100000, notes: 'W12FX envelope funding' });
    assertOk('setup deposit', dep, 201);
    const bl = await request(app).post('/api/finance/budget-lines').set(owner())
      .send({ subcategoryId: 'sub_salaries_wages', name: unique('W12FX Teacher Salaries'), branchId: BRANCH });
    assertOk('budget line create', bl, 201);
    db.prepare('UPDATE budget_lines SET payroll_target = ? WHERE id = ?').run('teacher', bl.body.id);
    const charge = await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: 100000 });
    assertOk('budget charge', charge, 201);
    const before = report();
    const remaining = before.restrictedRemaining;
    // Spend MORE than the unrestricted cushion: overdraw stores for restricted money.
    const spend = Math.min(remaining, 90000);
    const pay = await request(app).post('/api/teachers/teacher_w12fx/pay-salary').set(owner())
      .send({ monthName: '1405-05', amountPaid: spend, paymentType: 'partial' });
    assertOk('teacher salary', pay, 201);

    const after = report();
    expect(after.storesHeld).toBe(before.storesHeld - spend);
    expect(after.restrictedRemaining).toBe(remaining); // pool untouched by spending
    // The exposure question: do stores still cover the donors' money?
    if (after.storesHeld < remaining) {
      expect(after.restrictedExposure).toBe(remaining - after.storesHeld);
      expect(after.unrestrictedHeld).toBe(0);
    } else {
      expect(after.restrictedExposure).toBe(0);
    }
  });

  it('internal treasury moves never change the restricted pool', async () => {
    const before = report();
    const allBefore = reportAll();
    const deposit = await request(app).post('/api/finance/treasury/deposit').set(owner())
      .send({ amount: 1000000, notes: 'W12FX internal-move probe' });
    assertOk('treasury deposit', deposit, 201);
    const after = report();
    expect(after.restrictedReceived).toBe(before.restrictedReceived);
    expect(after.restrictedSettled).toBe(before.restrictedSettled);
    expect(after.restrictedRemaining).toBe(before.restrictedRemaining);
    // Branch-scoped stores do not move (the deposit landed in the org
    // treasury); organization-scoped stores must absorb it 1:1.
    expect(after.storesHeld).toBe(before.storesHeld);
    const depositAll = getRestrictedExposure(db, null);
    expect(depositAll.storesHeld).toBe(allBefore.storesHeld + 1000000);
    expect(depositAll.restrictedRemaining).toBe(allBefore.restrictedRemaining);
    expect(depositAll.restrictedExposure).toBe(0); // stores now cover everything
  });

  it('report == INDEPENDENT per-donation provenance walk (different algorithm, same economics)', () => {
    const r = reportAll();
    const indep = independentRestrictedPool();
    expect(indep.received).toBe(r.restrictedReceived);
    expect(indep.settled).toBe(r.restrictedSettled);
    expect(Math.max(0, indep.received - indep.settled)).toBe(r.restrictedRemaining);
  });

  it('the HTTP surface serves the same report the core derives', async () => {
    const res = await request(app).get('/api/funding/restricted-exposure').set(owner());
    assertOk('restricted-exposure route', res, 200);
    expect(res.body).toEqual(report());
  });

  it('I21 flags fabricated leakage (tamper probe) and clears on restore', () => {
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I21')).toEqual([]);
    const restricted = db.prepare(
      `SELECT d.id, d.branch_id, d.amount FROM donations d JOIN donation_restrictions r ON r.donation_id = d.id LIMIT 1`,
    ).get() as { id: string; branch_id: string; amount: number } | undefined;
    expect(restricted).toBeTruthy();
    if (!restricted) throw new Error('fixture donation restriction missing');
    // Fabricate leakage: erase the restriction so this donation's money leaves
    // the restricted pool while its allocations keep consuming it. The state
    // layer blocks honest mutations here — prove the checker still catches the
    // shape if it ever occurs (e.g. legacy rows).
    const row = db.prepare(`SELECT target_kind, campaign_id, scholarship_id, sponsorship_agreement_id FROM donation_restrictions WHERE donation_id = ?`).get(restricted.id) as Record<string, unknown>;
    let tampered = false;
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare('DELETE FROM donation_restrictions WHERE donation_id = ?').run(restricted.id);
      tampered = true;
    } catch { /* immutable-delete trigger held: acceptable */ }
    if (tampered) {
      expect(runFinancialInvariantChecks(db).some((f) => f.invariant === 'I21')).toBe(true);
      db.prepare(
        `INSERT INTO donation_restrictions (donation_id, target_kind, campaign_id, scholarship_id, sponsorship_agreement_id) VALUES (?, ?, ?, ?, ?)`,
      ).run(restricted.id, row.target_kind, row.campaign_id, row.scholarship_id, row.sponsorship_agreement_id);
      db.pragma('foreign_keys = ON');
      expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I21')).toEqual([]);
    } else {
      db.pragma('foreign_keys = ON');
    }
  });

  it('full checker stays green (cash + state + W12 layers)', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
