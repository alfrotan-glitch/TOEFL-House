/**
 * WAVE 12 · CROSS-DOMAIN — the three capabilities in ONE world, attacking the
 * seams between them.
 * ============================================================================
 *   · refund × income taxonomy × restricted aid: a refunded tuition payment
 *     nets against operating income while restricted aid allocations and the
 *     exposure report are untouched (aid is not the student's money to refund);
 *   · capital injection × exposure × P&L: the same cash event is equity on the
 *     P&L, invisible to the restricted pool, and absorbed by organization
 *     stores 1:1 (I13);
 *   · payroll bonus × treasury × P&L: bonus money travels treasury → envelope
 *     → expense, and the P&L's salary expense includes it while operating
 *     income does not silently grow to cover it;
 *   · calendar authority: the Jalali year boundary (1405-12 → 1406-01) keeps
 *     periods independent under the composed-due cap;
 *   · reversal × exposure × P&L: reversing an allocation restores exposure
 *     without restating income;
 *   · the full invariant checker stays green across every domain at once.
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
import rulesRouter from '../routes/rules.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { getRestrictedExposure } from '../core/funding/restricted-exposure.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w12_xd';
const BRANCH = 'branch_w12_xd';
const BASE = 20000;
const BONUS = 7000;

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
app.use('/api/rules', rulesRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0778${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
};

/** Independent P&L derivation: straight from financial_transactions. */
function independentPnl(from?: string, to?: string): { operatingIncome: number; donationLine: number; refundLine: number; salaryExpense: number } {
  const rows = db.prepare(
    `SELECT type, category, SUM(amount) AS total FROM financial_transactions
      WHERE (${from ? 'date >= ?' : '1=1'} AND ${to ? 'date <= ?' : '1=1'})
      GROUP BY type, category`,
  ).all(...[...(from ? [from] : []), ...(to ? [to] : [])]) as Array<{ type: string; category: string; total: number }>;
  let operatingIncome = 0, donationLine = 0, refundLine = 0, salaryExpense = 0;
  for (const r of rows) {
    if (r.type === 'income') {
      if (r.category === 'capital_injection') continue; // equity, not trading
      if (r.category === 'non_operating_other') continue; // declared non-operating
      operatingIncome += r.total;
      if (r.category === 'donation') donationLine += r.total;
      if (r.category === 'refund') refundLine += r.total;
    } else if (r.type === 'expense' && r.category === 'salary') {
      salaryExpense += r.total;
    }
  }
  return { operatingIncome, donationLine, refundLine, salaryExpense };
}

const pnlIncome = async (): Promise<number> => {
  const res = await request(app).get('/api/finance/pnl?scope=all').set(owner());
  assertOk('pnl', res, 200);
  return Number(res.body.income);
};

const exposure = () => getRestrictedExposure(db, BRANCH);

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W12 Cross-Domain Branch')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });

  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W12XD registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);

  // Payroll envelope through production surfaces.
  const dep = await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 500000, notes: 'W12XD capital' });
  assertOk('deposit', dep, 201);
  const bl = await request(app).post('/api/finance/budget-lines').set(owner())
    .send({ subcategoryId: 'sub_salaries_wages', name: 'W12XD Employee Salaries', branchId: BRANCH });
  assertOk('budget line', bl, 201);
  db.prepare('UPDATE budget_lines SET payroll_target = ? WHERE id = ?').run('employee', bl.body.id);
  const charge = await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: 400000 });
  assertOk('charge', charge, 201);

  // Bonus rule for the manager role.
  const bonus = await request(app).post('/api/rules').set(owner()).send({
    name: unique('W12XD Bonus'), category: 'payroll',
    conditions: [{ field: 'role', operator: 'eq', value: 'manager' }],
    actions: [{ type: 'set_value', targetKey: 'employeeBonus', value: BONUS }],
    isActive: true,
  });
  assertOk('bonus rule', bonus, 201);
});

describe('W12-XD · cross-domain seams', () => {
  let donor: string;
  let campaign: string;
  let scholarship: string;
  let funding: string;
  let student: string;
  let paymentId: string;
  let obligationId: string;
  let manager: string;

  it('world: restricted donation → scholarship → award; tuition paid by student', async () => {
    const d = await request(app).post('/api/funding/donors').set(owner()).send({ fullName: unique('W12XD Donor'), type: 'individual' });
    donor = d.body.id;
    const s = await request(app).post('/api/funding/scholarships').set(owner()).send({ name: unique('W12XD Scholarship'), totalBudget: 60000, branchId: BRANCH });
    assertOk('scholarship', s, 201);
    scholarship = s.body.id;
    const don = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor, amount: 50000, branchId: BRANCH, restriction: { kind: 'scholarship', targetId: scholarship } });
    assertOk('donation', don, 201);
    funding = (db.prepare('SELECT id FROM scholarship_fundings WHERE donation_id = ?').get(don.body.id) as { id: string }).id;

    const cls = await request(app).post('/api/classes').set(owner())
      .send({ name: unique('W12XD Class'), level: 'B1', capacity: 20, fee: 30000, startDate: '2026-09-01', branchId: BRANCH });
    assertOk('class', cls, 201);
    const st = await request(app).post('/api/students/manual').set(owner())
      .send({ fullName: unique('W12XD Student'), phone: phone(), branchId: BRANCH, gender: 'female' });
    assertOk('student', st, 201);
    student = st.body.student?.id ?? st.body.id;
    const list = await request(app).get(`/api/invoices?studentId=${student}`).set(owner());
    const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
    const reg = invoices.find((i: { chargeKind?: string; status?: string }) => i.chargeKind === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
    if (reg) {
      const paid = await request(app).post(`/api/invoices/${reg.id}/pay`).set(owner()).send({ amount: reg.netAmount, paymentMethod: 'cash' });
      assertOk('reg pay', paid, 200, 201);
    }
    const enrolled = await request(app).post(`/api/students/${student}/enroll-semester`).set(owner())
      .send({ classId: cls.body.id, semesterName: unique('W12XD Term'), startDate: '2026-09-01', endDate: '2026-12-20' });
    assertOk('enroll', enrolled, 201);

    // Student pays 12000 of tuition in cash.
    const pay = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'fee', semesterId: enrolled.body.semesterId, amount: 12000 });
    assertOk('tuition pay', pay, 200, 201);
    // The payment surface returns the receipt number (the student-facing
    // document); the refund surface names the payment row it reverses.
    paymentId = (db.prepare('SELECT id FROM payments WHERE receipt_number = ?').get(pay.body.receiptNumber) as { id: string }).id;

    // Restricted aid settles 10000 of the SAME obligation.
    const aw = await request(app).post('/api/funding/scholarships/award').set(owner())
      .send({ scholarshipId: scholarship, studentId: student, amount: 10000, branchId: BRANCH });
    assertOk('award', aw, 201);
    const awardId = aw.body.id;
    obligationId = (db.prepare('SELECT id FROM student_obligations WHERE student_id = ? AND kind = \'tuition\'').get(student) as { id: string }).id;
    const alloc = await request(app).post(`/api/funding/scholarship-awards/${awardId}/allocations`).set(owner())
      .send({ obligationId, scholarshipFundingId: funding, amount: 10000 });
    assertOk('allocation', alloc, 201);

    expect(exposure().restrictedSettled).toBe(10000);
  });

  it('refund × restricted: refunding the student nets income, never touches aid', async () => {
    const before = exposure();
    const pnlBefore = await pnlIncome();
    const refund = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 3000, reason: 'W12XD cross-domain refund probe' });
    assertOk('refund', refund, 200, 201);

    const after = exposure();
    expect(after.restrictedReceived).toBe(before.restrictedReceived);
    expect(after.restrictedSettled).toBe(before.restrictedSettled); // aid intact
    expect(after.restrictedRemaining).toBe(before.restrictedRemaining);

    const pnlAfter = await pnlIncome();
    expect(pnlBefore - pnlAfter).toBe(3000); // contra-revenue, exactly once
    const indep = independentPnl();
    expect(indep.refundLine).toBe(-3000);
    // The P&L route and the independent derivation agree to the afghani.
    expect(indep.operatingIncome).toBe(pnlAfter);
  });

  it('reversal × income: reversing aid restores exposure without restating income', async () => {
    const allocationId = (db.prepare(`SELECT id FROM obligation_allocations WHERE scholarship_funding_id = ? AND status='active'`).get(funding) as { id: string }).id;
    const awardId = (db.prepare('SELECT scholarship_award_id AS award_id FROM obligation_allocations WHERE id = ?').get(allocationId) as { award_id: string }).award_id;
    const pnlBefore = await pnlIncome();
    const expBefore = exposure();

    const rev = await request(app).post(`/api/funding/scholarship-awards/${awardId}/allocations/${allocationId}/reverse`).set(owner())
      .send({ reason: 'W12XD cross-domain reversal probe' });
    assertOk('reverse', rev, 200, 201);

    expect(exposure().restrictedSettled).toBe(expBefore.restrictedSettled - 10000);
    expect(exposure().restrictedRemaining).toBe(expBefore.restrictedRemaining + 10000);
    // Income was NEVER the scholarship's money: nothing restated.
    expect(await pnlIncome()).toBe(pnlBefore);
    expect(independentPnl().donationLine).toBe(50000);
  });

  it('capital injection × exposure × P&L: one event, three consistent views', async () => {
    const pnlBefore = await pnlIncome();
    const expBefore = exposure();
    const orgBefore = getRestrictedExposure(db, null);

    const dep = await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 250000, notes: 'W12XD capital × views' });
    assertOk('deposit', dep, 201);

    expect(await pnlIncome()).toBe(pnlBefore); // equity is not income
    const branch = exposure();
    expect(branch.restrictedRemaining).toBe(expBefore.restrictedRemaining); // pool untouched
    expect(branch.storesHeld).toBe(expBefore.storesHeld); // branch stores untouched
    const org = getRestrictedExposure(db, null);
    expect(org.storesHeld).toBe(orgBefore.storesHeld + 250000); // 1:1 in stores
    expect(org.restrictedExposure).toBe(0); // and it can only reduce exposure
    // I13: treasury == capital injections − budget funding (schema-verified by
    // the checker running green below).
  });

  it('payroll bonus × treasury × P&L: bonus money is a salary expense, not income', async () => {
    manager = `emp_w12xd_${++seq}`;
    db.prepare(
      `INSERT INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
       VALUES (?, 'W12XD Manager', 'manager', ?, ?, 'active', '2026-01-01')`,
    ).run(manager, BRANCH, BASE);

    const st = await request(app).get(`/api/employees/${manager}/salary-status`).set(owner());
    assertOk('status', st, 200);
    expect(st.body.due).toBe(BASE + BONUS);

    const pnlBefore = await pnlIncome();
    const pay = await request(app).post(`/api/employees/${manager}/pay-salary`).set(owner())
      .send({ monthName: '1405-06', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('pay', pay, 201);

    expect(await pnlIncome()).toBe(pnlBefore); // paying salaries creates no income
    const indep = independentPnl();
    expect(indep.salaryExpense).toBe(BASE + BONUS); // the bonus rides the salary line
    expect(indep.operatingIncome).toBe(await pnlIncome());
  });

  it('calendar authority: the Jalali year boundary keeps periods independent', async () => {
    const lastMonthOf1405 = await request(app).post(`/api/employees/${manager}/pay-salary`).set(owner())
      .send({ monthName: '1405-12', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('1405-12', lastMonthOf1405, 201);
    const newYear = await request(app).post(`/api/employees/${manager}/pay-salary`).set(owner())
      .send({ monthName: '1406-01', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('1406-01', newYear, 201);

    const periods = db.prepare(
      `SELECT period_key, SUM(paid_amount) s FROM employee_salary_ledger WHERE employee_id = ? AND status='posted' GROUP BY period_key`,
    ).all(manager) as Array<{ period_key: string; s: number }>;
    expect(periods).toHaveLength(3); // 1405-06, 1405-12, 1406-01 — no merge
    for (const p of periods) expect(p.s).toBe(BASE + BONUS);

    // Alias agreement: month and monthName must identify the same period or 400.
    const conflict = await request(app).get(`/api/employees/${manager}/salary-status?month=1406-02&monthName=1406-03`).set(owner());
    assertOk('month conflict', conflict, 400);
    const alias = await request(app).get(`/api/employees/${manager}/salary-status?month=1406-02`).set(owner());
    const alias2 = await request(app).get(`/api/employees/${manager}/salary-status?monthName=1406-02`).set(owner());
    assertOk('alias', alias, 200);
    assertOk('alias2', alias2, 200);
    expect(alias.body.remaining).toBe(alias2.body.remaining);
  });

  it('every domain at once: the full checker stays green', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
