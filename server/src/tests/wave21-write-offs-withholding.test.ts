/**
 * WAVE 21 · WRITE-OFFS AND PAYROLL WITHHOLDING — adversarial verification.
 * ============================================================================
 * Owner-directed semantics (2026-09-05), implemented without inventing one
 * numeric policy:
 *   · TUITION WRITE-OFF is a MEMO discharge — unpaid tuition was never
 *     revenue, so the discharge writes NO ledger row and moves NO cash. It is
 *     one append-only event + one write_off allocation; the obligation is
 *     final (I25), its open invoices are written_off, and every balance
 *     derivation (student, roster, branch outstanding, aging, academic hold)
 *     stops counting the discharged remainder.
 *   · EMPLOYEE-ADVANCE WRITE-OFF moves no money either — the cash left at
 *     advance time. The write-off pins the existing salary_advance fact as
 *     uncollectible, so the operating-expense lens counts it as a staff cost
 *     while the non-expense lens stops counting it (I27).
 *   · WITHHOLDING is a LIABILITY until remittance: wage facts book GROSS; the
 *     declaration states what was withheld (a fact, not a rate); remittance
 *     hands the cash over through a signed-negative P&L-neutral
 *     'withholding_remittance' row at branch main (I26), with reconciliation,
 *     daily statement and conservation (I11/I16) in agreement throughout.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import financeRouter from '../routes/finance.routes.js';
import { teachersRouter, employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';
import { ensureTuitionObligation } from '../core/finance/obligations.js';
import { getStudentBalance, getBranchOutstanding } from '../utils/studentBalance.js';
import { getReceivablesAging } from '../core/reporting/financial-observability.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { operatingExpenseSql, nonExpenseCashMovementSql } from '../core/finance/ledger-classification.js';

const OWNER = 'user_w21_sa';
const TEACHER = 'user_w21_t';
const BRANCH = 'branch_w21_sa';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/teachers', teachersRouter);
app.use('/api/employees', employeesRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacher = () => bearerFor(TEACHER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0791${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
};
const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);
const ftCount = () => (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
const scalar = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as { v: number }).v);

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

// Payroll pays from a payroll-target envelope. The MONEY moves only through
// the one budget authority (create + charge from the treasury), so I12 holds;
// payroll_target itself is branch configuration, set directly.
const ensurePayrollEnvelopes = async () => {
  for (const [target, label] of [['employee', 'W21 Employee Salaries'], ['teacher', 'W21 Teacher Salaries']] as const) {
    if (db.prepare(`SELECT 1 FROM budget_lines WHERE payroll_target = ? AND branch_id = ?`).get(target, BRANCH)) continue;
    assertOk('treasury', await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 50000000, notes: `W21 ${label} funding` }), 201);
    const bl = await request(app).post('/api/finance/budget-lines').set(owner())
      .send({ subcategoryId: 'sub_salaries_wages', name: unique(label), branchId: BRANCH });
    assertOk('budget line', bl, 201);
    assertOk('charge', await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: 50000000 }), 201);
    db.prepare(`UPDATE budget_lines SET payroll_target = ? WHERE id = ?`).run(target, bl.body.id);
  }
};

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W21') ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });
  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W21 registration', amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
});

describe('W21 · A. tuition write-off is a memo discharge', () => {
  let sid: string;
  let semesterId: string;
  let obligationId: string;
  let invoiceId: string;

  it('builds a term with a 10 000 debt, a 3 000 payment and an open tuition invoice', async () => {
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W21 Class'), level: 'B1', capacity: 20, fee: 10000, startDate: '2026-09-01', branchId: BRANCH });
    assertOk('class', cls, 201);
    sid = await createStudentReady('W21 Debtor Student');
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W21 Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll', enrolled, 201);
    semesterId = enrolled.body.semesterId;
    obligationId = ensureTuitionObligation(db, semesterId).id;

    // I4: a live tuition invoice nets exactly its term's net fee — bill the
    // full term, then pay part of it (the invoice goes 'partial').
    const inv = await request(app).post('/api/invoices').set(owner())
      .send({ studentId: sid, purpose: 'tuition', semesterId, issue: true, items: [{ description: 'Tuition term', quantity: 1, unitPrice: 10000 }] });
    assertOk('tuition invoice', inv, 201);
    invoiceId = inv.body.id as string;
    const paid = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId, amount: 3000 });
    assertOk('part pay', paid, 200, 201);

    expect(getStudentBalance(db, sid, 'all').outstanding).toBe(7000);
    checkerClean();
  });

  it('discharges the remainder with ZERO ledger effect and final state everywhere', async () => {
    const before = ftCount();
    const bad = await request(app).post(`/api/finance/obligations/${obligationId}/write-off`).set(owner()).send({ reason: 'short' });
    assertOk('short reason refused', bad, 400);
    assertOk('teacher cannot discharge', await request(app).post(`/api/finance/obligations/${obligationId}/write-off`).set(teacher())
      .send({ reason: 'teacher must not discharge debt' }), 403);

    const wo = await request(app).post(`/api/finance/obligations/${obligationId}/write-off`).set(owner())
      .send({ reason: 'Student left the country; debt declared uncollectible' });
    assertOk('discharge', wo, 201);
    expect(wo.body.amount).toBe(7000);
    expect(ftCount()).toBe(before); // MEMO: no ledger row, no cash, no income, no expense

    // Obligation final; invoice written off; derivations all agree.
    expect(db.prepare(`SELECT status s FROM student_obligations WHERE id = ?`).get(obligationId)).toEqual({ s: 'discharged' });
    expect(db.prepare(`SELECT status s FROM invoices WHERE id = ?`).get(invoiceId)).toEqual({ s: 'written_off' });
    const bal = getStudentBalance(db, sid, 'all');
    expect(bal.outstanding).toBe(0);
    expect(bal.tuitionDischarged).toBe(7000);
    expect(bal.tuitionPaid).toBe(3000); // a discharge is never reported as paid
    expect(getBranchOutstanding(db, BRANCH)).toBe(0);
    const aging = getReceivablesAging(db, { branchId: BRANCH, asOf: '2026-09-05' });
    expect(aging.rows.length).toBe(0);
    checkerClean(); // I6/I25 green

    // Replay and re-settlement refused: discharge is final.
    assertOk('re-discharge refused', await request(app).post(`/api/finance/obligations/${obligationId}/write-off`).set(owner())
      .send({ reason: 'Trying to discharge again' }), 409);
    assertOk('pay on written-off invoice refused', await request(app).post(`/api/invoices/${invoiceId}/pay`).set(owner())
      .send({ amount: 100, paymentMethod: 'cash' }), 400, 409);
    checkerClean();

    const reg = await request(app).get(`/api/finance/tuition-write-offs?branchId=${BRANCH}`).set(owner());
    assertOk('register', reg, 200);
    expect((reg.body as { totals: { discharged: number; count: number } }).totals).toEqual({ discharged: 7000, count: 1 });
  });

  it('refuses to discharge a settled obligation and blocks settlements on a discharged one at DB level', async () => {
    // A second student pays in full, then cannot be "discharged".
    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W21 Class B'), level: 'B1', capacity: 20, fee: 5000, startDate: '2026-09-01', branchId: BRANCH });
    assertOk('class b', cls, 201);
    const sid2 = await createStudentReady('W21 Full Payer');
    const enrolled = await request(app).post(`/api/students/${sid2}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W21 Term B'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll b', enrolled, 201);
    const ob2 = ensureTuitionObligation(db, enrolled.body.semesterId as string).id;
    assertOk('full pay', await request(app).post(`/api/students/${sid2}/payments`).set(owner())
      .send({ category: 'fee', semesterId: enrolled.body.semesterId, amount: 5000 }), 200, 201);
    assertOk('nothing to discharge', await request(app).post(`/api/finance/obligations/${ob2}/write-off`).set(owner())
      .send({ reason: 'Nothing left to discharge here' }), 409);

    // Direct-write attack on the discharged obligation: the DB refuses.
    let refused = false;
    try {
      db.prepare(`INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, payment_id, status, date)
                  SELECT 'alloc_attack_w21', ?, 100, 'payment', (SELECT id FROM payments LIMIT 1), 'active', date('now')`, ).run(obligationId);
    } catch { refused = true; }
    expect(refused).toBe(true);
    checkerClean();
  });
});

describe('W21 · B. employee-advance write-off reclassifies, never re-spends', () => {
  it('pays an advance, writes it off, and proves both lenses flip with zero ledger writes', async () => {
    await ensurePayrollEnvelopes();
    const eid = 'emp_w21_adv';
    db.prepare(
      `INSERT OR REPLACE INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
       VALUES (?, 'W21 Advance Clerk', 'clerk', ?, 8000, 'active', date('now'))`,
    ).run(eid, BRANCH);

    const advance = await request(app).post(`/api/employees/${eid}/pay-salary`).set(owner())
      .send({ monthName: 'Sunbula 1405', amountPaid: 5000, paymentType: 'advance' });
    assertOk('advance', advance, 201);
    const txId = (db.prepare(`SELECT transaction_id t FROM employee_salary_ledger WHERE employee_id = ? ORDER BY paid_at DESC LIMIT 1`).get(eid) as { t: string }).t;

    const operatingBefore = scalar(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions ft WHERE ${operatingExpenseSql('ft')} AND ft.branch_id = ?`, BRANCH);
    const nonExpenseBefore = scalar(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions ft WHERE ${nonExpenseCashMovementSql('ft')} AND ft.branch_id = ?`, BRANCH);
    expect(nonExpenseBefore).toBeGreaterThanOrEqual(5000);

    assertOk('teacher cannot write off', await request(app).post('/api/finance/payroll/advance-write-offs').set(teacher())
      .send({ transactionId: txId, reason: 'Teacher must not write off advances' }), 403);
    const before = ftCount();
    const wo = await request(app).post('/api/finance/payroll/advance-write-offs').set(owner())
      .send({ transactionId: txId, reason: 'Clerk left; advance unrecoverable' });
    assertOk('write-off', wo, 201);
    expect(ftCount()).toBe(before); // classification truth only — no money moved

    const operatingAfter = scalar(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions ft WHERE ${operatingExpenseSql('ft')} AND ft.branch_id = ?`, BRANCH);
    const nonExpenseAfter = scalar(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions ft WHERE ${nonExpenseCashMovementSql('ft')} AND ft.branch_id = ?`, BRANCH);
    expect(operatingAfter - operatingBefore).toBe(5000); // now a staff cost
    expect(nonExpenseBefore - nonExpenseAfter).toBe(5000); // no longer a receivable-class outflow
    checkerClean(); // I27 green

    assertOk('replay refused', await request(app).post('/api/finance/payroll/advance-write-offs').set(owner())
      .send({ transactionId: txId, reason: 'Writing off the same advance twice' }), 409);
    assertOk('non-advance refused', await request(app).post('/api/finance/payroll/advance-write-offs').set(owner())
      .send({ transactionId: 'tx_does_not_exist', reason: 'No such advance fact exists' }), 404);

    // Direct tamper: a partial amount cannot sneak in (trigger bound).
    const salaryTx = db.prepare(`SELECT id FROM financial_transactions WHERE branch_id = ? AND category = 'salary' LIMIT 1`).get(BRANCH) as { id: string } | undefined;
    let tampered = false;
    try {
      db.prepare(`INSERT INTO advance_write_offs (id, transaction_id, branch_id, employee_id, amount, reason, declared_by)
                  VALUES ('awo_attack', ?, ?, 'emp_w21_adv', 1, 'Partial amount tamper attempt', 'attacker')`,
      ).run(salaryTx?.id ?? 'tx_missing', BRANCH);
    } catch { tampered = true; }
    expect(tampered).toBe(true);
    checkerClean();
  });
});

describe('W21 · C. payroll withholding is a liability until remittance', () => {
  it('declares withholding on a gross wage, remits it, and keeps every conservation layer green', async () => {
    await ensurePayrollEnvelopes();
    const tid = 'teach_w21_wh';
    db.prepare(
      `INSERT OR REPLACE INTO teachers (id, full_name, branch_id, base_salary, salary_type, status, joined_date, performance_score, default_skill_rate)
       VALUES (?, 'W21 Wage Teacher', ?, 12000, 'fixed', 'active', date('now'), 0, 0)`,
    ).run(tid, BRANCH);
    const wage = await request(app).post(`/api/teachers/${tid}/pay-salary`).set(owner())
      .send({ monthName: 'Sunbula 1405', amountPaid: 12000, paymentType: 'full' });
    assertOk('wage', wage, 201);
    const txId = (db.prepare(`SELECT id FROM financial_transactions WHERE category = 'salary' AND reference_id = ? ORDER BY rowid DESC LIMIT 1`).get(tid) as { id: string }).id;

    // Refusals first.
    assertOk('over-gross refused', await request(app).post('/api/finance/payroll/withholdings').set(owner())
      .send({ transactionId: txId, amount: 12001 }), 400);
    assertOk('teacher cannot declare', await request(app).post('/api/finance/payroll/withholdings').set(teacher())
      .send({ transactionId: txId, amount: 1000 }), 403);
    assertOk('advance cannot host withholding', await request(app).post('/api/finance/payroll/withholdings').set(owner())
      .send({ transactionId: (db.prepare(`SELECT id FROM financial_transactions WHERE category = 'salary_advance' LIMIT 1`).get() as { id: string }).id, amount: 100 }), 404);

    const declaration = await request(app).post('/api/finance/payroll/withholdings').set(owner())
      .send({ transactionId: txId, amount: 2400, note: 'Wage tax withheld at source per payslip' });
    assertOk('declare', declaration, 201);
    const whId = (declaration.body as { withholdingId: string }).withholdingId;

    // The drawer keeps the cash until remittance; income unchanged; I11 still green.
    const register = await request(app).get(`/api/finance/payroll/withholdings?branchId=${BRANCH}`).set(owner());
    assertOk('register', register, 200);
    const body = register.body as { totals: { openLiability: number; remitted: number }; declarations: Array<{ withheld: number; gross: number; netPaid: number; status: string }> };
    expect(body.totals.openLiability).toBe(2400);
    expect(body.declarations.find((d) => d.status === 'open')).toMatchObject({ withheld: 2400, gross: 12000, netPaid: 9600 });
    checkerClean();

    // Remit: cash leaves branch main through the signed-negative P&L-neutral row.
    const mainBefore = getFinanceAccount('branch', BRANCH).mainBalance;
    assertOk('remit', await request(app).post(`/api/finance/payroll/withholdings/${whId}/remit`).set(owner()).send({}), 200);
    const remitTx = (db.prepare(`SELECT id FROM financial_transactions WHERE type = 'withholding_remittance' ORDER BY rowid DESC LIMIT 1`).get() as { id: string }).id;
    const row = db.prepare(`SELECT type, amount, branch_id FROM financial_transactions WHERE id = ?`).get(remitTx) as { type: string; amount: number; branch_id: string };
    expect(row).toMatchObject({ type: 'withholding_remittance', amount: -2400, branch_id: BRANCH });
    expect(mainBefore - getFinanceAccount('branch', BRANCH).mainBalance).toBe(2400);
    checkerClean(); // I11/I16/I26 green

    assertOk('replay refused', await request(app).post(`/api/finance/payroll/withholdings/${whId}/remit`).set(owner()).send({}), 409);
    assertOk('duplicate declaration refused', await request(app).post('/api/finance/payroll/withholdings').set(owner())
      .send({ transactionId: txId, amount: 100 }), 409);

    // Reconciliation and the daily statement stay truthful after remittance.
    const rec = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(rec.cashVariance).toBe(0);
    const { getDailyCashActivity } = await import('../core/reporting/financial-observability.js');
    const { today } = await import('../utils/ids.js');
    const stmt = getDailyCashActivity(db, { branchId: BRANCH, date: today() });
    expect(stmt.movements.withholdingRemitted).toBe(-2400);
    expect(stmt.closing.main).toBe(getFinanceAccount('branch', BRANCH).mainBalance);
  });
});
