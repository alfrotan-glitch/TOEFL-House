/**
 * WAVE 15 · FINANCIAL OBSERVABILITY — adversarial verification.
 * ============================================================================
 * Two read-only views, attacked:
 *   · Receivables aging — correctness of every bucket boundary, payment/aid
 *     settlement, invoice status filtering, per-item vs per-student-netted
 *     grain (both disclosed), unattributed-payment disclosure, branch
 *     scoping, parameter validation, and agreement with an INDEPENDENT
 *     in-test derivation (different algorithm, same economics).
 *   · Daily cash-activity — opening+movements=closing algebra, closing(today)
 *     == the LIVE store balance, income by class vs raw rows, refund reclaim,
 *     sweep, drawings, equity-injection exclusion (memo only), empty day,
 *     historical reconstruction continuity (closing(D) == opening(D+1)),
 *     future/garbage dates, authorization.
 *
 * World shaping: production surfaces wherever a production writer exists
 * (enrollment, payments, refunds, treasury deposit). Fixture INSERTS are used
 * only where no production writer can set a past date (old semesters, old
 * invoices) or an abnormal state (unattributed payment, owner drawing without
 * the margin gate) — each is a row the AUTHORITY reads, not a writer being
 * tested; the writers themselves were adversarially verified in Waves 11–12.
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
import { getBranchOutstanding, getBranchNonTuitionOutstanding } from '../utils/studentBalance.js';
import { gregorianToJalali, jalaliToGregorian } from '../utils/jalali.js';
import { ensureTuitionObligation } from '../core/finance/obligations.js';
import { recordIncome } from '../utils/income.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w15_ob';
const TEACHER = 'user_w15_teach';
const BRANCH = 'branch_w15_ob';
const OTHER = 'branch_w15_other';

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
const phone = () => `0799${String(100000 + (seq % 900000)).slice(-6)}`;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
};

/** ISO date whose Jalali age relative to today is EXACTLY `m` whole months
 *  (or m−1 when the target day had to be clamped — returned so tests assert
 *  the observable, never the assumption). Independent of the module under
 *  test: pure calendar math via utils/jalali converters. */
function isoAged(m: number): { iso: string; expectedAge: number } {
  const [gy, gm, gd] = TODAY_ISO.split('-').map(Number);
  const t = gregorianToJalali(gy, gm, gd);
  const ordinal = t.jy * 12 + t.jm - m;
  const jy = Math.floor((ordinal - 1) / 12);
  const jm = ordinal - jy * 12;
  const firstNext = jalaliToGregorian(jm === 12 ? jy + 1 : jy, jm === 12 ? 1 : jm + 1, 1);
  const lastDayGreg = new Date(Date.UTC(firstNext.gy, firstNext.gm - 1, firstNext.gd - 1));
  const firstThis = jalaliToGregorian(jy, jm, 1);
  const daysInMonth = Math.round((lastDayGreg.getTime() - Date.UTC(firstThis.gy, firstThis.gm - 1, firstThis.gd)) / 86400000) + 1;
  const dd = Math.min(t.jd, daysInMonth);
  const g = jalaliToGregorian(jy, jm, dd);
  const iso = `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`;
  return { iso, expectedAge: dd <= t.jd ? m : m - 1 };
}

function fixtureSemester(studentId: string, name: string, enrollDate: string, fee: number): string {
  const id = `sem_w15_${++seq}`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
     VALUES (?, ?, ?, NULL, ?, ?, 'active')`,
  ).run(id, studentId, name, enrollDate, fee);
  return id;
}

function fixturePayment(studentId: string, amount: number, date: string, semester: string | null, category = 'fee', branch: string = BRANCH, invoiceId: string | null = null): string {
  const pid = `pay_w15_${++seq}`;
  // Payment row + its ledger twin through the REAL income write boundary, in
  // one transaction: the fixture bypasses no authority (I14 stays honest).
  db.transaction(() => {
    db.prepare(
      `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, semester, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'cash', 'completed', ?, ?, ?, ?, ?)`,
    ).run(pid, studentId, invoiceId, amount, date, category, `RFX-W15-${seq}`, branch, semester, `idem-w15-${seq}`);
    recordIncome({
      category, amount, date: TODAY_ISO, description: 'W15 fixture payment (ledger twin)',
      paymentId: pid, operatorName: 'W15 fixture', branchId: branch,
    });
  })();
  return pid;
}

function fixtureInvoice(purpose: string, chargeKind: string, net: number, issueDate: string, status: string, studentId: string | null, branch: string): string {
  const id = `inv_w15_${++seq}`;
  db.prepare(
    `INSERT INTO invoices (id, student_id, branch_id, purpose, charge_kind, invoice_number, net_amount, status, issue_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, studentId, branch, purpose, chargeKind, `W15-${seq}`, net, status, issueDate);
  return id;
}

let S1: string;
let S2: string;
let semToday: string;
let agedIds: Array<{ semId: string; fee: number; age: number }> = [];

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W15 Observability')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W15 Other')
              ON CONFLICT(id) DO NOTHING`).run(OTHER);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' }); // organization-scoped owner: branchId=all must resolve
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });

  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W15 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);

  // ── Production-surface world ──
  const cls = await request(app).post('/api/classes').set(owner())
    .send({ name: unique('W15 Class'), level: 'A1', capacity: 30, fee: 30000, startDate: '2026-09-01', branchId: BRANCH });
  assertOk('class', cls, 201);

  const addStudent = async () => {
    const res = await request(app).post('/api/students/manual').set(owner())
      .send({ fullName: unique('W15 Student'), phone: phone(), branchId: BRANCH, gender: 'male' });
    assertOk('student', res, 201);
    return res.body.student?.id ?? res.body.id as string;
  };
  S1 = await addStudent();
  S2 = await addStudent();
  for (const s of [S1, S2]) {
    const list = await request(app).get(`/api/invoices?studentId=${s}`).set(owner());
    const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
    const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
    if (reg) {
      const paid = await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'cash' });
      assertOk('reg pay', paid, 200, 201);
    }
  }

  // S1: enroll today's term, pay 10 000 of 30 000 via the production desk path.
  const enrolled = await request(app).post(`/api/students/${S1}/enroll-semester`).set(owner())
    .send({ classId: cls.body.id, semesterName: unique('W15 Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
  assertOk('enroll', enrolled, 201);
  semToday = enrolled.body.semesterId as string;
  const paid = await request(app).post(`/api/students/${S1}/payments`).set(owner())
    .send({ category: 'fee', semesterId: semToday, amount: 10000 });
  assertOk('tuition pay', paid, 200, 201);

  // ── Fixture world-shaping (past dates no production writer can set) ──
  // S1 old terms across every bucket boundary; one carries an old payment.
  for (const m of [0, 1, 3, 4, 6, 7, 12, 13]) {
    const { iso, expectedAge } = isoAged(m);
    const fee = 2000 + m * 100;
    const semId = fixtureSemester(S1, unique(`W15 Age ${m}m`), iso, fee);
    agedIds.push({ semId, fee, age: expectedAge });
  }
  // Partial payment against the 13-month term.
  const old13 = agedIds.find((a) => a.age >= 13)!;
  const oldSemRow = db.prepare('SELECT semester_name FROM student_semesters WHERE id = ?').get(old13.semId) as { semester_name: string };
  fixturePayment(S1, 300, TODAY_ISO, oldSemRow.semester_name);

  // Aid settles 500 of TODAY's term through the FULL production funding chain
  // (donor → scholarship → restricted donation → award → allocation); the
  // state-layer trigger refuses a bare allocation row, correctly.
  const obligationId = ensureTuitionObligation(db, semToday).id;
  {
    const donor = await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W15 Donor'), type: 'individual' });
    assertOk('donor', donor, 201);
    const sch = await request(app).post('/api/funding/scholarships').set(owner()).send({ name: unique('W15 Scholarship'), totalBudget: 5000, branchId: BRANCH });
    assertOk('scholarship', sch, 201);
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor.body.id, amount: 500, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: sch.body.id } });
    assertOk('donation', don, 201);
    const fundingId = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(don.body.id) as { id: string }).id;
    const aw = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId: sch.body.id, studentId: S1, amount: 500, branchId: BRANCH });
    assertOk('award', aw, 201);
    const alloc = await request(app).post(`/api/funding/scholarship-awards/${aw.body.id}/allocations`).set(owner())
      .send({ obligationId, scholarshipFundingId: fundingId, amount: 500 });
    assertOk('allocation', alloc, 201);
  }

  // Invoices: open+old (in), open+older (in), paid (out), cancelled (out), draft (out), overpaid (out, floored).
  fixtureInvoice('books', 'books', 1500, isoAged(2).iso, 'issued', S2, BRANCH);
  const partialInv = fixtureInvoice('exam', 'exam', 800, isoAged(5).iso, 'partial', S1, BRANCH);
  fixturePayment(S1, 300, TODAY_ISO, null, 'exam', BRANCH, partialInv);
  const paidInv = fixtureInvoice('books', 'books', 700, isoAged(2).iso, 'paid', S2, BRANCH);
  fixturePayment(S2, 700, TODAY_ISO, null, 'book', BRANCH, paidInv);
  fixtureInvoice('books', 'books', 600, isoAged(2).iso, 'cancelled', S2, BRANCH);
  fixtureInvoice('books', 'books', 600, isoAged(2).iso, 'draft', S2, BRANCH);
  // An OPEN overpaid invoice is unrepresentable in an honest world: I5
  // (invoice status agrees with money collected) forces it to 'paid'. So the
  // invoice-side floor-at-zero cannot be reached through status; it is
  // exercised on the tuition side instead (the netting test's overpaid term).
  const fullyPaidInv = fixtureInvoice('exam', 'exam', 500, isoAged(3).iso, 'paid', S2, BRANCH);
  fixturePayment(S2, 500, TODAY_ISO, null, 'exam', BRANCH, fullyPaidInv);

  // Other-branch rows (scoping) + an unattributed (semester NULL) tuition payment there.
  const otherStudent = `stu_w15_other_${++seq}`;
  db.prepare(`INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, 'W15 Other Student', 'active', date('now'), ?, 'male')`)
    .run(otherStudent, `SC-W15-O${seq}`, OTHER);
  fixtureSemester(otherStudent, unique('W15 Other Term'), isoAged(9).iso, 5000);
  // semester deliberately NULL: the unattributed-payment disclosure probe.
  fixturePayment(otherStudent, 1234, TODAY_ISO, null, 'fee', OTHER);

  // Daily world: owner drawing today (the margin-gated writer cannot run
  // without profit; the fixture performs the production writer's exact two
  // steps — expense row + branch main debit — both of which the authority reads).
  db.prepare(`INSERT INTO financial_transactions (id, type, category, finance_category_id, amount, date, description, operator_name, branch_id)
              VALUES (?, 'expense', 'owner_drawing', 'sub_owner_drawings', 400, ?, 'W15 drawing fixture', 'W15', ?)`)
    .run(`tx_w15_${++seq}`, TODAY_ISO, BRANCH);
  db.prepare(`UPDATE finance_accounts SET main_balance = main_balance - 400 WHERE scope_type='branch' AND scope_id = ?`).run(BRANCH);

  // Equity injection today, stamped with BRANCH (credits ORG treasury).
  const dep = await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 50000, notes: 'W15 memo probe' });
  assertOk('deposit', dep, 201);

  // Refund 2 000 of today's tuition payment through the production surface.
  const tuitionPayment = db.prepare(`SELECT id FROM payments WHERE student_id = ? AND semester IS NOT NULL AND category = 'fee' AND status = 'completed' ORDER BY created_at DESC LIMIT 1`).get(S1) as { id: string };
  const refund = await request(app).post(`/api/students/${S1}/refund`).set(owner())
    .send({ paymentId: tuitionPayment.id, amount: 2000, reason: 'W15 daily-statement refund probe' });
  assertOk('refund', refund, 200, 201);
});

const agingRoute = (qs: string) => request(app).get(`/api/reports/receivables-aging${qs}`).set(owner());

/** Independent aging derivation — a different algorithm over the raw tables. */
function independentAging(branchId: string | null): Array<{ key: string; outstanding: number; age: number }> {
  const sems = db.prepare(
    `SELECT sem.id, sem.student_id, st.branch_id, sem.enroll_date, sem.semester_name,
            COALESCE(sem.net_fee_amount, sem.fee_amount) AS billed
       FROM student_semesters sem JOIN students st ON st.id = sem.student_id ${branchId ? 'WHERE st.branch_id = ?' : ''}`,
  ).all(...(branchId ? [branchId] : [])) as Array<{ id: string; student_id: string; branch_id: string; enroll_date: string; semester_name: string; billed: number }>;
  // Same attribution RULE as the authority (charges + refunds of charges),
  // implemented independently here.
  const payments = db.prepare(`SELECT student_id, semester, SUM(amount) AS total FROM payments
      WHERE status='completed' AND (
        category IN ('fee','installment')
        OR (category='refund' AND (SELECT t.category FROM payments t WHERE t.id = payments.refunds_payment_id) IN ('fee','installment'))
      ) GROUP BY student_id, semester`).all() as Array<{ student_id: string; semester: string; total: number }>;
  const aid = db.prepare(`SELECT o.semester_id, SUM(a.amount) AS total FROM obligation_allocations a JOIN student_obligations o ON o.id = a.obligation_id WHERE a.status='active' AND a.source_kind IN ('scholarship','sponsorship') GROUP BY o.semester_id`).all() as Array<{ semester_id: string; total: number }>;
  const invoices = db.prepare(`SELECT i.id, i.invoice_number, i.student_id, i.branch_id, i.issue_date, i.net_amount, (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.invoice_id = i.id AND p.status='completed') AS paid FROM invoices i WHERE i.purpose <> 'tuition' AND i.status IN ('issued','partial','overdue') ${branchId ? 'AND i.branch_id = ?' : ''}`).all(...(branchId ? [branchId] : [])) as Array<{ id: string; invoice_number: string; student_id: string | null; branch_id: string; issue_date: string; net_amount: number; paid: number }>;
  const out: Array<{ key: string; outstanding: number; age: number }> = [];
  for (const s of sems) {
    const paid = payments.find((p) => p.student_id === s.student_id && p.semester === s.semester_name)?.total ?? 0;
    const aided = aid.find((a) => a.semester_id === s.id)?.total ?? 0;
    const outstanding = Math.max(0, Number(s.billed) - Number(paid) - Number(aided));
    if (outstanding > 0) out.push({ key: `tuition:${s.student_id}:${s.semester_name}`, outstanding, age: Math.max(0, jalaliMonthsInTest(s.enroll_date.slice(0, 10))) });
  }
  for (const i of invoices) {
    const outstanding = Math.max(0, Number(i.net_amount) - Number(i.paid));
    if (outstanding > 0) out.push({ key: `invoice:${i.student_id ?? ''}:${i.invoice_number}`, outstanding, age: Math.max(0, jalaliMonthsInTest(i.issue_date.slice(0, 10))) });
  }
  return out;
}

function jalaliMonthsInTest(fromIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = TODAY_ISO.split('-').map(Number);
  const from = gregorianToJalali(fy, fm, fd);
  const to = gregorianToJalali(ty, tm, td);
  const months = (to.jy - from.jy) * 12 + (to.jm - from.jm);
  return td < fd ? months - 1 : months;
}

const bucketOf = (age: number): string => (age <= 0 ? 'current' : age <= 3 ? '1-3m' : age <= 6 ? '4-6m' : age <= 12 ? '7-12m' : '12m+');

describe('W15 · receivables aging', () => {
  it('serves exactly the independent derivation (rows, buckets, totals)', async () => {
    const res = await agingRoute('');
    assertOk('aging', res, 200);
    const body = res.body as { rows: Array<{ kind: string; studentId: string; reference: string; outstanding: number; ageMonths: number; bucket: string }>; buckets: Array<{ key: string; tuition: number; nonTuition: number; total: number; itemCount: number }>; totals: { tuition: number; nonTuition: number; total: number } };
    const indep = independentAging(BRANCH);
    expect(body.rows.map((r) => `${r.kind}:${r.studentId}:${r.reference}`).sort())
      .toEqual(indep.map((r) => r.key).sort());
    for (const row of body.rows) {
      const match = indep.find((r) => r.key === `${row.kind}:${row.studentId}:${row.reference}`)!;
      expect(row.outstanding).toBe(match.outstanding);
      expect(row.ageMonths).toBe(match.age);
      expect(row.bucket).toBe(bucketOf(match.age));
    }
    expect(body.totals.total).toBe(indep.reduce((s, r) => s + r.outstanding, 0));
    for (const b of body.buckets) {
      const inBucket = indep.filter((r) => bucketOf(r.age) === b.key);
      expect(b.total).toBe(inBucket.reduce((s, r) => s + r.outstanding, 0));
      expect(b.itemCount).toBe(inBucket.length);
    }
  });

  it('lands every bucket boundary age in its declared bucket', async () => {
    const res = await agingRoute('');
    assertOk('aging', res, 200);
    const tuitionRows = (res.body as { rows: Array<{ kind: string; reference: string; bucket: string; ageMonths: number }> }).rows.filter((r) => r.kind === 'tuition');
    const seenAges = new Set(tuitionRows.map((r) => r.ageMonths));
    for (const expected of [0, 1, 3, 4, 6, 7, 12, 13]) {
      if (seenAges.has(expected)) {
        const row = tuitionRows.find((r) => r.ageMonths === expected)!;
        expect(row.bucket).toBe(bucketOf(expected));
      }
    }
    // The fixture semesters exist for every boundary age; each with a
    // positive outstanding must appear.
    expect(seenAges).toEqual(new Set([0, 1, 3, 4, 6, 7, 12, 13]));
  });

  it('settlement is truthful: payment, aid, refund-of-outstanding; floored at zero', async () => {
    const res = await agingRoute('');
    assertOk('aging', res, 200);
    const rows = (res.body as { rows: Array<{ kind: string; reference: string; billed: number; settled: number; outstanding: number }> }).rows;
    // Today's term: 30 000 billed − (10 000 paid − 2 000 refund) − 500 aid = 21 500.
    const today = rows.find((r) => r.kind === 'tuition' && r.outstanding === 21500);
    expect(today).toBeTruthy();
    expect(today!.settled).toBe(8500); // 10 000 − 2 000 refund + 500 aid
    // The 13-month term: fee − 300 partial payment.
    const term13 = agedIds.find((a) => a.age >= 13)!;
    const fee13 = Number((db.prepare('SELECT COALESCE(net_fee_amount, fee_amount) f FROM student_semesters WHERE id = ?').get(term13.semId) as { f: number }).f);
    expect(rows.find((r) => r.kind === 'tuition' && r.outstanding === fee13 - 300)).toBeTruthy();
    // Fully-paid invoice excluded by status (an open overpaid invoice is
    // unrepresentable — I5 forces it closed).
    expect(rows.find((r) => r.kind === 'invoice' && r.billed === 500)).toBeFalsy();
    // Partial invoice included with its residual.
    expect(rows.find((r) => r.kind === 'invoice' && r.outstanding === 500)).toBeTruthy();
  });

  it('cross-foots: non-tuition EXACTLY equals the aggregate authority; tuition per-item disclosed beside per-student netted', async () => {
    const res = await agingRoute('');
    assertOk('aging', res, 200);
    const cf = (res.body as { crossFoot: { perItemTuition: number; perStudentNettedTuition: number; nonTuition: number; unattributedTuitionPayments: number } }).crossFoot;
    expect(cf.nonTuition).toBe(getBranchNonTuitionOutstanding(db, BRANCH));
    expect(cf.perStudentNettedTuition).toBe(getBranchOutstanding(db, BRANCH));
    expect(cf.unattributedTuitionPayments).toBe(0); // production writers always attribute
    // In this world every student's payments ≤ their terms (no netting), so
    // per-item and per-student-netted coincide.
    expect(cf.perItemTuition).toBe(cf.perStudentNettedTuition);
  });

  it('discloses the grain difference honestly when a student overpays one term and owes another', async () => {
    const s3 = `stu_w15_net_${++seq}`;
    db.prepare(`INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, 'W15 Netting Student', 'active', date('now'), ?, 'male')`).run(s3, `SC-W15-N${seq}`, BRANCH);
    const overTerm = fixtureSemester(s3, unique('W15 Overpaid'), isoAged(2).iso, 5000);
    fixtureSemester(s3, unique('W15 Open'), isoAged(0).iso, 4000);
    // Overpayment is unreachable through production (payments are capped at
    // the term's outstanding), so this is a deliberate fixture state — paid
    // through the real income boundary so the ledger stays consistent.
    fixturePayment(s3, 8000, TODAY_ISO, (db.prepare('SELECT semester_name FROM student_semesters WHERE id = ?').get(overTerm) as { semester_name: string }).semester_name);

    const res = await agingRoute('');
    assertOk('aging', res, 200);
    const cf = (res.body as { crossFoot: { perItemTuition: number; perStudentNettedTuition: number } }).crossFoot;
    // Authority nets: (5000+4000) − 8000 = 1000. Per item: 0 + 4000 = 4000.
    expect(cf.perStudentNettedTuition).toBe(getBranchOutstanding(db, BRANCH));
    expect(cf.perItemTuition).toBe(getBranchOutstanding(db, BRANCH) + 3000); // disclosed, not hidden
  });

  it('scopes by branch and surfaces unattributed payments instead of guessing', async () => {
    const scoped = await agingRoute('');
    assertOk('scoped', scoped, 200);
    expect((scoped.body as { rows: Array<{ branchId: string }> }).rows.every((r) => r.branchId === BRANCH)).toBe(true);

    const other = await request(app).get('/api/reports/receivables-aging').set(owner()).query({ branchId: OTHER });
    assertOk('other', other, 200);
    const otherBody = other.body as { rows: Array<{ branchId: string }>; crossFoot: { unattributedTuitionPayments: number } };
    expect(otherBody.rows.every((r) => r.branchId === OTHER)).toBe(true);
    expect(otherBody.crossFoot.unattributedTuitionPayments).toBe(1234); // the semester-NULL fixture, disclosed
    // And it was NOT allocated into any term row.
    expect((otherBody.rows as Array<{ settled: number }>).every((r) => r.settled !== 1234)).toBe(true);
  });

  it('validates asOf: garbage 400, future 400, past OK', async () => {
    assertOk('garbage', await agingRoute('?asOf=banana'), 400);
    assertOk('future', await agingRoute('?asOf=2999-01-01'), 400);
    const past = await agingRoute('?asOf=2020-01-01');
    assertOk('past', past, 200);
    // Everything predating 2020 has age clamped at 0 months → current bucket only.
    const b = (past.body as { buckets: Array<{ key: string; itemCount: number }> }).buckets;
    expect(b.filter((x) => x.itemCount > 0).every((x) => x.key === 'current')).toBe(true);
  });
});

describe('W15 · daily cash-activity statement', () => {
  const daily = (qs: string) => request(app).get(`/api/reports/cash-activity/daily${qs}`).set(owner());

  const rawSum = (sql: string, ...params: unknown[]): number =>
    Number((db.prepare(sql).get(...params) as { v: number }).v) || 0;

  it('today: algebra holds and closing equals the LIVE store balance', async () => {
    const res = await daily('');
    assertOk('daily', res, 200);
    const s = res.body as { opening: { main: number; saving: number }; movements: { incomeTotal: number; savingMovement: number; ownerDrawings: number }; closing: { main: number; saving: number }; memoEquityInjectionsThisBranch: Array<{ amount: number }> };
    expect(s.closing.main).toBe(s.opening.main + s.movements.incomeTotal - s.movements.savingMovement - s.movements.ownerDrawings);
    expect(s.closing.saving).toBe(s.opening.saving + s.movements.savingMovement);
    const live = db.prepare(`SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id=?`).get(BRANCH) as { main_balance: number; saving_balance: number };
    expect(s.closing.main).toBe(live.main_balance);
    expect(s.closing.saving).toBe(live.saving_balance);
    // The equity injection is memo'd, not math'd.
    expect(s.memoEquityInjectionsThisBranch.map((m) => m.amount)).toContain(50000);
  });

  it('movements match the raw ledger row-for-row (income by class, refund, sweep, drawing)', async () => {
    const res = await daily('');
    assertOk('daily', res, 200);
    const s = res.body as { movements: { incomeByCategory: Array<{ category: string; amount: number }>; incomeTotal: number; refundsTotal: number; savingMovement: number; ownerDrawings: number } };
    const rawIncome = rawSum(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income' AND COALESCE(category,'') NOT IN ('capital_injection') AND branch_id=? AND date=?`, BRANCH, TODAY_ISO);
    expect(s.movements.incomeTotal).toBe(rawIncome);
    for (const c of s.movements.incomeByCategory) {
      expect(c.amount).toBe(rawSum(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income' AND category=? AND branch_id=? AND date=?`, c.category, BRANCH, TODAY_ISO));
    }
    expect(s.movements.refundsTotal).toBe(rawSum(`SELECT COALESCE(SUM(CASE WHEN amount<0 THEN amount ELSE 0 END),0) v FROM financial_transactions WHERE type='income' AND branch_id=? AND date=?`, BRANCH, TODAY_ISO));
    expect(s.movements.savingMovement).toBe(rawSum(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='saving_transfer' AND branch_id=? AND date=?`, BRANCH, TODAY_ISO));
    expect(s.movements.ownerDrawings).toBe(400);
  });

  it('historical dates reconstruct: empty day is all zeros and closing(D) == opening(D+1)', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const before = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const emptyRes = await daily(`?date=${before}&branchId=${BRANCH}`);
    assertOk('empty day', emptyRes, 200);
    const empty = emptyRes.body as { opening: { main: number }; movements: { incomeTotal: number; savingMovement: number; ownerDrawings: number }; closing: { main: number; saving: number } };
    expect(empty.movements.incomeTotal).toBe(0);
    expect(empty.movements.ownerDrawings).toBe(0);
    expect(empty.closing.main).toBe(empty.opening.main);

    const d1 = await daily(`?date=${before}&branchId=${BRANCH}`);
    const d2 = await daily(`?date=${yesterday}&branchId=${BRANCH}`);
    const c1 = (d1.body as { closing: { main: number; saving: number } }).closing;
    const o2 = (d2.body as { opening: { main: number; saving: number } }).opening;
    expect(c1.main).toBe(o2.main);
    expect(c1.saving).toBe(o2.saving);
  });

  it('validates date: garbage 400, future 400; organization scope returns per-branch statements', async () => {
    assertOk('garbage', await daily('?date=not-a-date'), 400);
    assertOk('future', await daily('?date=2999-01-01'), 400);
    const all = await request(app).get('/api/reports/cash-activity/daily?branchId=all').set(owner()); // the all-branches switch is branchId=all
    assertOk('org', all, 200);
    const body = all.body as { scope: string; branches: Array<{ branchId: string; closing: { main: number } }> };
    expect(body.scope).toBe('organization');
    expect(body.branches.length).toBeGreaterThanOrEqual(2);
    for (const b of body.branches) {
      const live = db.prepare(`SELECT main_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id=?`).get(b.branchId) as { main_balance: number } | undefined;
      expect(b.closing.main).toBe(Number(live?.main_balance ?? 0));
    }
  });
});

describe('W15 · authorization', () => {
  it('rejects principals without report authority on both surfaces', async () => {
    const a = await request(app).get('/api/reports/receivables-aging').set(teacher());
    expect(a.status).toBe(403);
    const b = await request(app).get('/api/reports/cash-activity/daily').set(teacher());
    expect(b.status).toBe(403);
  });
});

describe('W15 · no regression', () => {
  it('the full invariant checker stays green', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });

  it('the reports are read-only: no financial row was written by any report call', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    await agingRoute('');
    await request(app).get('/api/reports/cash-activity/daily').set(owner());
    const after = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
