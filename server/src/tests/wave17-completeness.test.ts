/**
 * WAVE 17 · COMPLETENESS — adversarial verification of the four policy-free
 * closures found by the post-W16 architecture audit.
 * ============================================================================
 *   A. Third-party payer attribution (W14 F9, "no gate"): optional DETAIL on
 *      the payment fact — recorded by both principal collection paths, exposed
 *      on the payment read surface, bounded by text limits, and economically
 *      INERT (ownership stays the student; invariants and income untouched).
 *   B. Student branch-transfer history: the W16 event row becomes readable —
 *      append-only facts, branch-scoped, no mutation counterpart.
 *   C. Donation clawback register: individual repayment obligations with
 *      status and cash evidence, aggregating consistently with the exposure
 *      view; permission-gated.
 *   D. Bank reconciliation matched PAIRS: which line was tied to which ledger
 *      row, by whom and when — not just a count; still a read-only control.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter, { paymentsRouter } from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import financeRouter from '../routes/finance.routes.js';
import fundingRouter from '../routes/funding.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w17_sa';
const TEACHER_HOME = 'user_w17_th';
const BRANCH = 'branch_w17_sa';
const OTHER = 'branch_w17_other';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/finance', financeRouter);
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacherHome = () => bearerFor(TEACHER_HOME);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0791${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 260)}`);
};
const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);

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

const settleAndGetRow = async (label: string, body: Record<string, unknown>) => {
  const sid = await createStudentReady(label);
  const list = await request(app).get(`/api/invoices?studentId=${sid}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  if (reg) {
    assertOk('reg paid', await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'cash' }), 200, 201);
  }
  const pay = await request(app).post(`/api/students/${sid}/payments`).set(owner()).send({ category: 'other', amount: 1000, notes: 'W17 ad-hoc desk charge', ...body });
  return { sid, pay };
};

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  for (const [id, name] of [[BRANCH, 'W17 Home'], [OTHER, 'W17 Other']] as const) {
    db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', ?) ON CONFLICT(id) DO NOTHING`).run(id, name);
  }
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER_HOME, role: 'teacher', branchId: BRANCH });

  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W17 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
  assertOk('sweep off', await request(app).put('/api/invoices/config/settings').set(owner()).send({ dailySavingPercent: 0 }), 200, 201);
});


const createPlainStudentWithRegInvoice = async (label: string) => {
  const st = await request(app).post('/api/students/manual').set(owner())
    .send({ fullName: unique(label), phone: phone(), branchId: BRANCH, gender: 'male' });
  assertOk('student', st, 201);
  const sid = st.body.student?.id ?? st.body.id;
  const list = await request(app).get(`/api/invoices?studentId=${sid}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  if (!reg) throw new Error('no payable registration invoice found');
  return { sid, invoice: reg };
};

describe('W17 · A. third-party payer attribution (F9)', () => {
  it('records attribution from the invoice path and exposes it on the payment read surface', async () => {
    const { invoice } = await createPlainStudentWithRegInvoice('W17 Invoice Attribution');
    const pay = await request(app).post(`/api/invoices/${invoice.id}/pay`).set(owner())
      .send({ amount: invoice.netAmount, paymentMethod: 'cash', payerName: 'Ahmad Rahimi', payerRelation: 'guardian — paternal uncle' });
    assertOk('invoice pay with attribution', pay, 200, 201);

    const payments = await request(app).get(`/api/payments?branchId=${BRANCH}&limit=50`).set(owner());
    assertOk('payments list', payments, 200);
    const row = (payments.body as Array<{ id: string; payerName: string | null }>).find((p) => p.id === (pay.body as { paymentId: string }).paymentId);
    expect(row?.payerName).toBe('Ahmad Rahimi');
    checkerClean();
  });

  it('records attribution from the student payments path; omitted attribution stays NULL', async () => {
    const attributed = await settleAndGetRow('W17 Smart Attribution', { paymentMethod: 'cash', payerName: '  Fatima Noori  ', payerRelation: 'guardian — mother' });
    assertOk('smart pay with attribution', attributed.pay, 200, 201);
    const plain = await settleAndGetRow('W17 Smart Plain', { paymentMethod: 'cash' });
    assertOk('smart pay plain', plain.pay, 200, 201);
    const attributedReceipt = (attributed.pay.body as { receiptNumber: string }).receiptNumber;
    const plainReceipt = (plain.pay.body as { receiptNumber: string }).receiptNumber;

    const payments = await request(app).get(`/api/payments?branchId=${BRANCH}&limit=100`).set(owner());
    assertOk('payments list', payments, 200);
    const rows = payments.body as Array<{ receiptNumber: string | null; payerName: string | null; payerRelation: string | null }>;
    const aRow = rows.find((p) => p.receiptNumber === attributedReceipt);
    const pRow = rows.find((p) => p.receiptNumber === plainReceipt);
    expect(aRow).toBeTruthy();
    expect(pRow).toBeTruthy();
    expect(aRow!.payerName).toBe('Fatima Noori'); // trimmed, not stored raw
    expect(aRow!.payerRelation).toBe('guardian — mother');
    // No attribution supplied ⇒ NULL: the pre-W17 semantics, never a
    // fabricated placeholder.
    expect(pRow!.payerName).toBeNull();
    expect(pRow!.payerRelation).toBeNull();
    checkerClean();
  });

  it('refuses over-long attribution instead of truncating silently', async () => {
    const tooLongName = await settleAndGetRow('W17 Long Name', { paymentMethod: 'cash', payerName: 'x'.repeat(201) });
    assertOk('payer name length enforced', tooLongName.pay, 400);
    const tooLongRelation = await settleAndGetRow('W17 Long Relation', { paymentMethod: 'cash', payerRelation: 'y'.repeat(61) });
    assertOk('payer relation length enforced', tooLongRelation.pay, 400);
  });

  it('is economically inert: attribution changes no ledger, balance or invariant figure', async () => {
    const totalIncome = () =>
      Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);
    const sid = await createStudentReady('W17 Inert Student');
    const before = totalIncome();
    const pay = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'other', amount: 1000, notes: 'W17 inertness probe', paymentMethod: 'cash', payerName: 'Sponsor Org', payerRelation: 'sponsor' });
    assertOk('inert pay', pay, 200, 201);
    expect(totalIncome() - before).toBe(1000); // exactly the payment, nothing more
    checkerClean();
  });
});

describe('W17 · B. student branch-transfer history', () => {
  it('lists the append-only custody trail, scoped to the current branch', async () => {
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W17 Class'), level: 'A2', capacity: 20, fee: 25000, startDate: '2026-09-01', branchId: BRANCH });
    assertOk('class', cls, 201);
    const sid = await createStudentReady('W17 Moving Student');
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W17 Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll', enrolled, 201);

    // Before the move: the trail exists and is empty.
    const before = await request(app).get(`/api/students/${sid}/transfer-history`).set(owner());
    assertOk('history before', before, 200);
    expect((before.body as { transfers: unknown[] }).transfers).toEqual([]);

    const move = await request(app).post(`/api/students/${sid}/transfer-branch`).set(owner())
      .send({ toBranchId: OTHER, reason: 'W17 family relocated for work' });
    assertOk('transfer', move, 200);

    const history = await request(app).get(`/api/students/${sid}/transfer-history`).set(owner());
    assertOk('history after', history, 200);
    const body = history.body as {
      currentBranchId: string;
      transfers: Array<{ fromBranchId: string; toBranchId: string; reason: string; operatorName: string | null }>;
    };
    expect(body.currentBranchId).toBe(OTHER);
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0].fromBranchId).toBe(BRANCH);
    expect(body.transfers[0].toBranchId).toBe(OTHER);
    expect(body.transfers[0].reason).toBe('W17 family relocated for work');

    // The student now belongs to OTHER: the home-branch teacher loses the read.
    assertOk('home teacher scoped out', await request(app).get(`/api/students/${sid}/transfer-history`).set(teacherHome()), 403);
    checkerClean();
  });
});

describe('W17 · C. donation clawback register', () => {
  it('lists open and repaid obligations with cash evidence, aggregating like the exposure view', async () => {
    // Fund branch cash for the repayment (real income, sweep is off).
    const payerId = await createStudentReady('W17 Clawback Payer');
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W17 Payer Class'), level: 'B1', capacity: 20, fee: 40000, startDate: '2026-09-01', branchId: BRANCH });
    const enrolled = await request(app).post(`/api/students/${payerId}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W17 Payer Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('payer enroll', enrolled, 201);
    assertOk('payer cash', await request(app).post(`/api/students/${payerId}/payments`).set(owner())
      .send({ category: 'fee', semesterId: enrolled.body.semesterId, amount: 40000 }), 200, 201);

    const donor = await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W17 Donor'), type: 'ngo' });
    const sch = await request(app).post('/api/funding/scholarships').set(owner()).send({ name: unique('W17 Scholarship'), totalBudget: 80000, branchId: BRANCH });
    assertOk('scholarship', sch, 201);
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor.body.id, amount: 60000, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: sch.body.id } });
    assertOk('donation', don, 201);

    const declared = await request(app).post(`/api/funding/donations/${don.body.id}/clawback`).set(owner())
      .send({ amount: 20000, reason: 'W17 grant reallocation by the funder' });
    assertOk('declare', declared, 201);
    const clawbackId = declared.body.id;

    const listOpen = await request(app).get(`/api/funding/donation-clawbacks?branchId=${BRANCH}`).set(owner());
    assertOk('register open', listOpen, 200);
    const open = listOpen.body as {
      counts: { open: number; repaid: number };
      totals: { open: number; repaid: number };
      clawbacks: Array<{ id: string; status: string; donorName: string | null; donationAmount: number; repaidTransactionId: string | null }>;
    };
    const rowOpen = open.clawbacks.find((c) => c.id === clawbackId);
    expect(rowOpen).toBeTruthy();
    expect(rowOpen!.status).toBe('open');
    expect(rowOpen!.donorName).toContain('W17 Donor');
    expect(rowOpen!.donationAmount).toBe(60000);
    expect(rowOpen!.repaidTransactionId).toBeNull();
    expect(open.counts.open).toBe(1);
    expect(open.totals.open).toBe(20000);

    assertOk('repay', await request(app).post(`/api/funding/donation-clawbacks/${clawbackId}/repay`).set(owner()).send({}), 200);
    const listRepaid = await request(app).get(`/api/funding/donation-clawbacks?branchId=${BRANCH}`).set(owner());
    const repaid = listRepaid.body as typeof open;
    const rowRepaid = repaid.clawbacks.find((c) => c.id === clawbackId);
    expect(rowRepaid!.status).toBe('repaid');
    expect(rowRepaid!.repaidTransactionId).toBeTruthy();
    expect(repaid.counts.open).toBe(0);
    expect(repaid.totals.repaid).toBe(20000);

    // The register's aggregates agree with the exposure view's figures.
    const exposure = await request(app).get(`/api/funding/restricted-exposure?branchId=${BRANCH}`).set(owner());
    const exp = exposure.body as { openClawbackLiability: number; restrictedReclaimed: number };
    expect(exp.openClawbackLiability).toBe(0);
    expect(exp.restrictedReclaimed).toBe(20000);
    checkerClean();
  });
});

describe('W17 · D. bank reconciliation matched pairs', () => {
  it('shows WHICH line was tied to WHICH ledger row, and restores on unmatch', async () => {
    const { invoice } = await createPlainStudentWithRegInvoice('W17 Bank Student');
    const pay = await request(app).post(`/api/invoices/${invoice.id}/pay`).set(owner()).send({ amount: invoice.netAmount, paymentMethod: 'bank_transfer' });
    assertOk('bank pay', pay, 200, 201);
    const txId = (db.prepare('SELECT id FROM financial_transactions WHERE payment_id = ? AND type = \'income\'').get((pay.body as { paymentId: string }).paymentId) as { id: string }).id;

    const imp = await request(app).post('/api/finance/bank-statement-lines').set(owner())
      .send({ branchId: BRANCH, statementDate: '2026-09-05', lineDate: '2026-09-04', description: 'W17 INCOMING REF 77341', amount: invoice.netAmount, externalRef: '77341' });
    assertOk('import', imp, 201);
    assertOk('match', await request(app).post('/api/finance/bank-statement-matches').set(owner())
      .send({ lineId: imp.body.id, transactionId: txId }), 201);

    const during = await request(app).get(`/api/finance/bank-reconciliation?branchId=${BRANCH}`).set(owner());
    assertOk('report', during, 200);
    const d = during.body as {
      matchedCount: number;
      matches: Array<{ id: string; line: { externalRef: string | null; amount: number }; transaction: { id: string; type: string } | null }>;
      unmatchedLines: unknown[];
    };
    expect(d.matchedCount).toBe(1);
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0].line.externalRef).toBe('77341');
    expect(d.matches[0].transaction?.id).toBe(txId);
    expect(d.matches[0].transaction?.type).toBe('income');
    expect(d.unmatchedLines).toEqual([]);

    const matchId = d.matches[0].id;
    assertOk('unmatch', await request(app).delete(`/api/finance/bank-statement-matches/${matchId}`).set(owner()), 200);
    const after = await request(app).get(`/api/finance/bank-reconciliation?branchId=${BRANCH}`).set(owner());
    const a = after.body as { matchedCount: number; matches: unknown[]; unmatchedLines: unknown[] };
    expect(a.matchedCount).toBe(0);
    expect(a.matches).toEqual([]);
    expect(a.unmatchedLines.length).toBe(1);
    checkerClean();
  });
});
