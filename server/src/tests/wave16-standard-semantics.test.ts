/**
 * WAVE 16 · STANDARD ACCOUNTING SEMANTICS — adversarial verification.
 * ============================================================================
 * Four capabilities, each attacked on its money/event truth:
 *   · Fixed-asset custody register — capex-node guard, source-tx guard, cost
 *     ceiling, custody trail, scoping, authorization.
 *   · Bank statement matching — control layer ONLY: matching never writes a
 *     financial row, cross-branch matches refused, duplicates refused,
 *     unmatch restores, variance report truthful.
 *   · Student branch transfer — the explicit event relocates OPEN state
 *     atomically, keeps HISTORY at the originating branch, and every surface
 *     (aging, obligations, invoices) agrees afterwards.
 *   · Donation clawback — liability-not-revenue semantics end to end:
 *     consumption-based guard, attribution uniqueness, fund-capacity
 *     reduction, P&L neutrality, cash evidence (I22), exposure/report
 *     coherence, repayment idempotency, reconciliation + daily-statement
 *     coherence after repayment.
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
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { getRestrictedExposure } from '../core/funding/restricted-exposure.js';
import { ensureTuitionObligation } from '../core/finance/obligations.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w16_sa';
const TEACHER = 'user_w16_teach';
const BRANCH = 'branch_w16_sa';
const OTHER = 'branch_w16_other';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/funding', fundingRouter);
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacher = () => bearerFor(TEACHER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0790${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 260)}`);
};

const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  for (const [id, name] of [[BRANCH, 'W16 Semantics'], [OTHER, 'W16 Other']] as const) {
    db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', ?) ON CONFLICT(id) DO NOTHING`).run(id, name);
  }
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });

  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W16 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
});

describe('W16 · fixed-asset custody register', () => {
  let capexTxId: string;

  it('creates a real capex cash flow through the production approval path', async () => {
    const dep = await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 300000, notes: 'W16 asset capex funding' });
    assertOk('deposit', dep, 201);
    const bl = await request(app).post('/api/finance/budget-lines').set(owner())
      .send({ subcategoryId: 'sub_it_equipment', name: unique('W16 IT Capex'), branchId: BRANCH });
    assertOk('budget line', bl, 201);
    const charge = await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: 200000 });
    assertOk('charge', charge, 201);
    const req = await request(app).post('/api/finance/expense-requests').set(owner())
      .send({ title: unique('W16 projector'), amount: 90000, budgetLineId: bl.body.id });
    assertOk('expense request', req, 200, 201);
    const decide = await request(app).post(`/api/finance/expense-requests/${req.body.id}/decide`).set(owner())
      .send({ isApproved: true });
    assertOk('decide', decide, 200, 200);
    const row = db.prepare(`SELECT id FROM financial_transactions WHERE type='expense' AND amount = 90000 AND finance_category_id = 'sub_it_equipment' AND branch_id = ?`).get(BRANCH) as { id: string };
    capexTxId = row.id;
    expect(capexTxId).toBeTruthy();
  });

  it('registers an asset against the capex row and refuses every dishonest shape', async () => {
    const ok = await request(app).post('/api/finance/assets').set(owner())
      .send({ name: unique('W16 Projector'), branchId: BRANCH, categoryId: 'sub_it_equipment', cost: 90000, sourceTransactionId: capexTxId, notes: 'Classroom A' });
    assertOk('asset', ok, 201);

    const wrongNode = await request(app).post('/api/finance/assets').set(owner())
      .send({ name: unique('W16 Rent Disguise'), branchId: BRANCH, categoryId: 'sub_rent', cost: 500 });
    assertOk('non-capex node refused', wrongNode, 400);

    const overCost = await request(app).post('/api/finance/assets').set(owner())
      .send({ name: unique('W16 Gold Projector'), branchId: BRANCH, categoryId: 'sub_it_equipment', cost: 90001, sourceTransactionId: capexTxId });
    assertOk('cost above source refused', overCost, 409);

    const noSource = await request(app).post('/api/finance/assets').set(owner())
      .send({ name: unique('W16 Gifted Whiteboard'), branchId: BRANCH, categoryId: 'sub_furniture_fixtures', cost: 5000 });
    assertOk('sourceless registration allowed (cost basis only)', noSource, 201);

    assertOk('teacher cannot register', await request(app).post('/api/finance/assets').set(teacher())
      .send({ name: 'x', branchId: BRANCH, categoryId: 'sub_it_equipment', cost: 1 }), 403);
  });

  it('custody transfer moves the asset and keeps the append-only trail', async () => {
    const list = await request(app).get(`/api/finance/assets?branchId=${BRANCH}`).set(owner());
    assertOk('list', list, 200);
    const asset = (list.body as Array<{ id: string; name: string; transfers: unknown[] }>).find((a) => a.name.includes('Projector'));
    expect(asset).toBeTruthy();

    const bad = await request(app).post(`/api/finance/assets/${asset!.id}/transfer`).set(owner())
      .send({ toBranchId: OTHER, reason: 'short' });
    assertOk('reason length enforced', bad, 400);

    const move = await request(app).post(`/api/finance/assets/${asset!.id}/transfer`).set(owner())
      .send({ toBranchId: OTHER, reason: 'W16 new campus classroom setup' });
    assertOk('transfer', move, 200);
    const after = await request(app).get(`/api/finance/assets?branchId=${OTHER}`).set(owner());
    const moved = (after.body as Array<{ id: string; transfers: Array<{ to_branch_id: string }> }>).find((a) => a.id === asset!.id);
    expect(moved).toBeTruthy();
    expect(moved!.transfers).toHaveLength(1);
    expect(moved!.transfers[0].to_branch_id).toBe(OTHER);
    checkerClean();
  });
});

describe('W16 · bank statement matching (control layer only)', () => {
  let lineId: string;
  let txId: string;

  it('imports a line and refuses duplicate import', async () => {
    const imp = await request(app).post('/api/finance/bank-statement-lines').set(owner())
      .send({ branchId: BRANCH, statementDate: '2026-09-05', lineDate: '2026-09-04', description: 'INCOMING TRANSFER REF 99182', amount: 12000, externalRef: '99182' });
    assertOk('import', imp, 201);
    lineId = imp.body.id;
    const dup = await request(app).post('/api/finance/bank-statement-lines').set(owner())
      .send({ branchId: BRANCH, statementDate: '2026-09-05', lineDate: '2026-09-04', description: 'INCOMING TRANSFER REF 99182', amount: 12000, externalRef: '99182' });
    assertOk('duplicate refused', dup, 409);
  });

  it('matches a real ledger row, never writes financial truth, and refuses cross-branch', async () => {
    // A real bank-transfer income row via the production desk.
    const st = await request(app).post('/api/students/manual').set(owner())
      .send({ fullName: unique('W16 Bank Student'), phone: phone(), branchId: BRANCH, gender: 'male' });
    assertOk('student', st, 201);
    const sid = st.body.student?.id ?? st.body.id;
    const list = await request(app).get(`/api/invoices?studentId=${sid}`).set(owner());
    const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
    const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
    const regPay = await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'bank_transfer' });
    assertOk('reg pay', regPay, 200, 201);
    const paymentId = regPay.body.paymentId ?? regPay.body.payment?.id ?? regPay.body.id;
    const incomeRow = db.prepare(
      `SELECT id FROM financial_transactions WHERE payment_id = ? AND type = 'income'`,
    ).get(paymentId) as { id: string };
    expect(incomeRow).toBeTruthy();
    txId = incomeRow.id;

    const before = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    const match = await request(app).post('/api/finance/bank-statement-matches').set(owner())
      .send({ lineId, transactionId: txId });
    assertOk('match', match, 201);
    const after = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    expect(after).toBe(before); // control layer: zero financial writes

    const again = await request(app).post('/api/finance/bank-statement-matches').set(owner())
      .send({ lineId, transactionId: txId });
    assertOk('re-match refused', again, 409);

    const otherLine = await request(app).post('/api/finance/bank-statement-lines').set(owner())
      .send({ branchId: OTHER, statementDate: '2026-09-05', lineDate: '2026-09-04', description: 'OTHER BRANCH LINE', amount: 500 });
    assertOk('other import', otherLine, 201);
    const cross = await request(app).post('/api/finance/bank-statement-matches').set(owner())
      .send({ lineId: otherLine.body.id, transactionId: txId });
    assertOk('cross-branch refused', cross, 409);
  });

  it('unmatch restores, and the variance report tells the truth', async () => {
    const during = await request(app).get(`/api/finance/bank-reconciliation?branchId=${BRANCH}`).set(owner());
    assertOk('report matched', during, 200);
    expect((during.body as { matchedCount: number }).matchedCount).toBe(1);

    const matches = db.prepare(`SELECT m.id FROM bank_statement_matches m JOIN bank_statement_lines l ON l.id = m.line_id WHERE l.branch_id = ?`).all(BRANCH) as Array<{ id: string }>;
    const unmatch = await request(app).delete(`/api/finance/bank-statement-matches/${matches[0].id}`).set(owner());
    assertOk('unmatch', unmatch, 200);
    const after = await request(app).get(`/api/finance/bank-reconciliation?branchId=${BRANCH}`).set(owner());
    expect((after.body as { matchedCount: number; unmatchedLines: unknown[] }).matchedCount).toBe(0);
    expect((after.body as { unmatchedLines: unknown[] }).unmatchedLines.length).toBeGreaterThanOrEqual(1);
    assertOk('teacher cannot see control report', await request(app).get(`/api/finance/bank-reconciliation?branchId=${BRANCH}`).set(teacher()), 403);
    checkerClean();
  });
});

const createStudentReady = async (label: string) => {
  const st = await request(app).post('/api/students/manual').set(owner())
    .send({ fullName: unique(label), phone: phone(), branchId: BRANCH, gender: 'female' });
  assertOk('student', st, 201);
  const sid = st.body.student?.id ?? st.body.id;
  const list = await request(app).get(`/api/invoices?studentId=${sid}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  assertOk('reg settled', await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'cash' }), 200, 201);
  return sid;
};

describe('W16 · student branch transfer', () => {
  it('relocates OPEN state atomically and preserves HISTORY at the origin', async () => {
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W16 Class'), level: 'A2', capacity: 20, fee: 25000, startDate: '2026-09-01', branchId: BRANCH });
    assertOk('class', cls, 201);
    const sid = await createStudentReady('W16 Moving Student');
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W16 Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll', enrolled, 201);
    const paid = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: enrolled.body.semesterId, amount: 5000 });
    assertOk('pay', paid, 200, 201);
    ensureTuitionObligation(db, enrolled.body.semesterId as string);

    const beforeLedger = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE branch_id = ?`).get(BRANCH) as { c: number }).c;
    const beforePayments = (db.prepare(`SELECT COUNT(*) c FROM payments WHERE branch_id = ?`).get(BRANCH) as { c: number }).c;

    const move = await request(app).post(`/api/students/${sid}/transfer-branch`).set(owner())
      .send({ toBranchId: OTHER, reason: 'W16 family relocated to new district' });
    assertOk('transfer', move, 200);

    expect((db.prepare('SELECT branch_id b FROM students WHERE id = ?').get(sid) as { b: string }).b).toBe(OTHER);
    expect((db.prepare(`SELECT COUNT(*) c FROM student_branch_transfers WHERE student_id = ? AND from_branch_id = ? AND to_branch_id = ?`).get(sid, BRANCH, OTHER) as { c: number }).c).toBe(1);
    // Open state followed…
    const obligations = db.prepare(`SELECT branch_id FROM student_obligations WHERE student_id = ? AND status = 'open'`).all(sid) as Array<{ branch_id: string }>;
    expect(obligations.length).toBeGreaterThanOrEqual(1);
    for (const o of obligations) expect(o.branch_id).toBe(OTHER);
    // …history stayed.
    expect((db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE branch_id = ?`).get(BRANCH) as { c: number }).c).toBe(beforeLedger);
    expect((db.prepare(`SELECT COUNT(*) c FROM payments WHERE branch_id = ?`).get(BRANCH) as { c: number }).c).toBe(beforePayments);

    // Every surface agrees: the aging report now finds the debt at OTHER.
    const agingOther = await request(app).get(`/api/reports/receivables-aging?branchId=${OTHER}`).set(owner());
    assertOk('aging other', agingOther, 200);
    expect((agingOther.body as { rows: Array<{ studentId: string }> }).rows.some((r) => r.studentId === sid)).toBe(true);
    const agingHome = await request(app).get(`/api/reports/receivables-aging?branchId=${BRANCH}`).set(owner());
    expect((agingHome.body as { rows: Array<{ studentId: string }> }).rows.some((r) => r.studentId === sid)).toBe(false);

    const sameBranch = await request(app).post(`/api/students/${sid}/transfer-branch`).set(owner())
      .send({ toBranchId: OTHER, reason: 'W16 no-op transfer attempt' });
    assertOk('same-branch refused', sameBranch, 400);
    assertOk('teacher refused', await request(app).post(`/api/students/${sid}/transfer-branch`).set(teacher())
      .send({ toBranchId: BRANCH, reason: 'W16 unauthorized attempt' }), 403);
    checkerClean();
  });
});

describe('W16 · donation clawback (liability, never negative revenue)', () => {
  const INCOME_BEFORE = { value: 0 };
  let donationId: string;
  let scholarshipId: string;
  let awardId: string;
  let clawbackId: string;

  it('world: restricted scholarship donation with partial consumption', async () => {
    // Fund the branch store through the production treasury path so the later
    // repayment has real cash to leave from (the account row is created lazily).
    assertOk('treasury', await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 200000, notes: 'W16 clawback repayment funding' }), 201);
    const donor = await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W16 Donor'), type: 'ngo' });
    const sch = await request(app).post('/api/funding/scholarships').set(owner()).send({ name: unique('W16 Scholarship'), totalBudget: 80000, branchId: BRANCH });
    assertOk('scholarship', sch, 201);
    scholarshipId = sch.body.id;
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor.body.id, amount: 60000, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: scholarshipId } });
    assertOk('donation', don, 201);
    donationId = don.body.id;

    const sid = await createStudentReady('W16 Aided Student');
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W16 Aid Class'), level: 'B1', capacity: 20, fee: 40000, startDate: '2026-09-01', branchId: BRANCH });
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W16 Aid Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll', enrolled, 201);
    const obligationId = ensureTuitionObligation(db, enrolled.body.semesterId as string).id;

    // A second student pays real cash into the branch store so a 30000 AFN
    // repayment has money to leave from (branch stores are funded by income,
    // not by the central treasury).
    assertOk('sweep off', await request(app).put('/api/invoices/config/settings').set(owner()).send({ dailySavingPercent: 0 }), 200, 201);
    const payerId = await createStudentReady('W16 Paying Student');
    const payerEnrolled = await request(app).post(`/api/students/${payerId}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W16 Payer Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('payer enroll', payerEnrolled, 201);
    assertOk('payer cash', await request(app).post(`/api/students/${payerId}/payments`).set(owner())
      .send({ category: 'fee', semesterId: payerEnrolled.body.semesterId, amount: 38000 }), 200, 201);

    const fundingId = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(donationId) as { id: string }).id;
    const aw = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId, studentId: sid, amount: 20000, branchId: BRANCH });
    assertOk('award', aw, 201);
    awardId = aw.body.id;
    const alloc = await request(app).post(`/api/funding/scholarship-awards/${awardId}/allocations`).set(owner())
      .send({ obligationId, scholarshipFundingId: fundingId, amount: 5000 });
    assertOk('allocation', alloc, 201);

    INCOME_BEFORE.value = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);
  });

  it('declares a clawback of the unconsumed remainder and refuses over-reclamation', async () => {
    const over = await request(app).post(`/api/funding/donations/${donationId}/clawback`).set(owner())
      .send({ amount: 60000, reason: 'W16 over-reclamation probe' });
    assertOk('over-reclaim refused (consumed 5000)', over, 409);

    const decl = await request(app).post(`/api/funding/donations/${donationId}/clawback`).set(owner())
      .send({ amount: 30000, reason: 'W16 grant agreement terminated early' });
    assertOk('declare', decl, 201);
    clawbackId = decl.body.id;

    // Liability open; restricted pool shrinks; income untouched.
    const exposure = getRestrictedExposure(db, BRANCH);
    expect(exposure.restrictedReceived).toBe(60000);
    expect(exposure.restrictedSettled).toBe(5000);
    expect(exposure.restrictedReclaimed).toBe(30000);
    expect(exposure.openClawbackLiability).toBe(30000);
    expect(exposure.restrictedRemaining).toBe(25000);
    const incomeNow = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);
    expect(incomeNow).toBe(INCOME_BEFORE.value);
  });

  it('reduces fund capacity so no new promise can spend returned money', async () => {
    // received 60000 − active award 20000 − clawed 30000 → 10000 available.
    const award2 = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId, studentId: (db.prepare('SELECT student_id FROM scholarship_awards WHERE id = ?').get(awardId) as { student_id: string }).student_id, amount: 15000, branchId: BRANCH });
    assertOk('award beyond reduced capacity refused', award2, 409);
    const awardOk = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId, studentId: (db.prepare('SELECT student_id FROM scholarship_awards WHERE id = ?').get(awardId) as { student_id: string }).student_id, amount: 10000, branchId: BRANCH });
    assertOk('award within reduced capacity accepted', awardOk, 201);
  });

  it('repayment moves cash through the P&L-neutral reclaim type, exactly once', async () => {
    const mainBefore = getFinanceAccount('branch', BRANCH).mainBalance;
    const repay = await request(app).post(`/api/funding/donation-clawbacks/${clawbackId}/repay`).set(owner()).send({});
    assertOk('repay', repay, 200);
    const mainAfter = getFinanceAccount('branch', BRANCH).mainBalance;
    expect(mainBefore - mainAfter).toBe(30000);

    const reclaimRow = db.prepare(`SELECT amount FROM financial_transactions WHERE type='restricted_reclaim' AND branch_id = ?`).get(BRANCH) as { amount: number };
    expect(reclaimRow.amount).toBe(-30000);
    // No negative-income fabrication anywhere.
    const negIncome = db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE type='income' AND amount < 0 AND description LIKE '%clawback%'`).get() as { c: number };
    expect(negIncome.c).toBe(0);
    const incomeNow = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);
    expect(incomeNow).toBe(INCOME_BEFORE.value);

    const replay = await request(app).post(`/api/funding/donation-clawbacks/${clawbackId}/repay`).set(owner()).send({});
    assertOk('repay replay refused', replay, 409);

    const exposure = getRestrictedExposure(db, BRANCH);
    expect(exposure.openClawbackLiability).toBe(0);
    expect(exposure.restrictedReclaimed).toBe(30000);
  });

  it('keeps every conservation identity green: I16/I21/I22, reconciliation, daily statement', async () => {
    checkerClean(); // includes I16 (reclaim in explained) and I21/I22

    const rec = await request(app).get(`/api/finance/reconciliation?branchId=${BRANCH}`).set(owner());
    assertOk('reconciliation', rec, 200);
    expect((rec.body as { cashVariance: number }).cashVariance).toBe(0);

    const daily = await request(app).get(`/api/reports/cash-activity/daily?branchId=${BRANCH}`).set(owner());
    assertOk('daily', daily, 200);
    const d = daily.body as { movements: { restrictedReclaims: number }; closing: { main: number } };
    expect(d.movements.restrictedReclaims).toBe(-30000);
    const live = getFinanceAccount('branch', BRANCH).mainBalance;
    expect(d.closing.main).toBe(live);
  });
});
