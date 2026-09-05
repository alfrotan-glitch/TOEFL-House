/**
 * WAVE 12 · Capability 3 — EMPLOYEE BONUS → PAYROLL (adversarial).
 * ============================================================================
 * The defect being repaired (W9 §10.7): payroll rules could compute a bonus
 * into an employee's due, but the pay-salary cap ignored it — so the bonus was
 * silently unpayable and operators falsified base salaries to work around it.
 * The cap is now the COMPOSED due (base + rule bonus), computed inside the
 * write lock. Attacked here:
 *   · salary-status preview == the enforced cap (one authority, two surfaces);
 *   · bonus is payable, ledgered with due_amount = composed due, and shown
 *     in the payment trail;
 *   · advance×bonus: no mix of advance+salary extracts more than the due;
 *   · void restores the payable and the budget; bonus survives a void;
 *   · budget exhaustion refuses the whole payment (no partial spend);
 *   · month boundary: periods are independent, no leakage either way;
 *   · idempotent replay never pays the bonus twice;
 *   · identity: the rule keys on role — another role earns no bonus;
 *   · malformed rules (fractional / negative) refuse the whole calculation;
 *   · dryRun parity: the rule engine's dry-run output IS the enforced number,
 *     and salary payments never write rule-execution logs (teacher parity).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import teachersRouter, { employeesRouter } from '../routes/teachers.routes.js';
import rulesRouter from '../routes/rules.routes.js';
import financeRouter from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w12_bn';
const BRANCH = 'branch_w12_bn';
const BONUS = 5000;
const BASE = 20000;
const ROLE = 'manager';
const OTHER_ROLE = 'receptionist';

const app = express();
app.use(express.json());
app.use('/api/teachers', teachersRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/finance', financeRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
};

const pay = (eid: string, body: Record<string, unknown>, key?: string) => {
  const req = request(app).post(`/api/employees/${eid}/pay-salary`).set(owner());
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
const status = (eid: string) => request(app).get(`/api/employees/${eid}/salary-status`).set(owner());
const ledger = (eid: string) =>
  db.prepare('SELECT * FROM employee_salary_ledger WHERE employee_id = ? ORDER BY paid_at').all(eid) as Array<Record<string, unknown>>;
const budgetNow = () =>
  Number((db.prepare(`SELECT current_amount c FROM budget_lines WHERE payroll_target='employee' AND branch_id=?`).get(BRANCH) as { c: number }).c);
const setBudget = (v: number) =>
  db.prepare(`UPDATE budget_lines SET current_amount = ? WHERE payroll_target='employee' AND branch_id=?`).run(v, BRANCH);

let manager: string;
let receptionist: string;
let bonusRuleId: string;

async function seedEmployee(name: string, role: string, base: number): Promise<string> {
  const eid = `emp_w12bn_${++seq}`;
  db.prepare(
    `INSERT INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
     VALUES (?, ?, ?, ?, ?, 'active', '2026-01-01')`,
  ).run(eid, name, role, BRANCH, base);
  return eid;
}

async function makeBonusRule(value: number | string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post('/api/rules').set(owner()).send({
    name: unique('W12BN Bonus'),
    description: 'W12 adversarial employeeBonus rule',
    category: 'payroll',
    conditions: [{ field: 'role', operator: 'eq', value: ROLE }],
    actions: [{ type: 'set_value', targetKey: 'employeeBonus', value }],
    isActive: true,
    ...extra,
  });
  assertOk('rule create', res, 201);
  return res.body.id as string;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W12 Bonus Branch')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });

  // Envelope funded through production surfaces.
  const dep = await request(app).post('/api/finance/treasury/deposit').set(owner())
    .send({ amount: 1000000, notes: 'W12BN envelope funding' });
  assertOk('deposit', dep, 201);
  const bl = await request(app).post('/api/finance/budget-lines').set(owner())
    .send({ subcategoryId: 'sub_salaries_wages', name: 'W12BN Employee Salaries', branchId: BRANCH });
  assertOk('budget line', bl, 201);
  db.prepare('UPDATE budget_lines SET payroll_target = ? WHERE id = ?').run('employee', bl.body.id);
  const charge = await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: 1000000 });
  assertOk('charge', charge, 201);

  manager = await seedEmployee(unique('W12BN Manager'), ROLE, BASE);
  receptionist = await seedEmployee(unique('W12BN Reception'), OTHER_ROLE, BASE);
  bonusRuleId = await makeBonusRule(BONUS);
});

describe('W12-3 · employee bonus → payroll', () => {
  it('salary-status and the enforced cap share one authority (base + bonus)', async () => {
    const st = await status(manager);
    assertOk('status', st, 200);
    expect(st.body.due).toBe(BASE + BONUS);
    expect(st.body.base).toBe(BASE);
    expect(st.body.bonus).toBe(BONUS);
    expect(st.body.paid).toBe(0);
    expect(st.body.remaining).toBe(BASE + BONUS);
    expect(st.body.canPayFull).toBe(true);
    // The rule engine's own dry-run — the same call the cap performs — must
    // produce the same number. Closes the dryRun-vs-enforcement question.
    const engine = evaluateRules({ category: 'payroll', branchId: BRANCH, data: { role: ROLE, baseSalary: BASE }, dryRun: true });
    expect(engine.finalOutputs.employeeBonus).toBe(st.body.bonus);
  });

  it('identity: the rule keys on role — another role earns no bonus', async () => {
    const st = await status(receptionist);
    assertOk('status other', st, 200);
    expect(st.body.bonus).toBe(0);
    expect(st.body.due).toBe(BASE);
    const engine = evaluateRules({ category: 'payroll', branchId: BRANCH, data: { role: OTHER_ROLE, baseSalary: BASE }, dryRun: true });
    expect(Object.prototype.hasOwnProperty.call(engine.finalOutputs, 'employeeBonus')).toBe(false);
  });

  it('the bonus is payable — partial, then the remainder, never more', async () => {
    const partial = await pay(manager, { monthName: '1405-06', amountPaid: BASE, paymentType: 'partial' });
    assertOk('partial', partial, 201);
    expect(partial.body.bonus).toBe(BONUS);
    expect(partial.body.due).toBe(BASE + BONUS);
    const row = ledger(manager).at(-1) as { due_amount: number; paid_amount: number; notes: string | null; status: string };
    expect(row.due_amount).toBe(BASE + BONUS); // ledger carries the composed due
    expect(row.notes).toContain(String(BONUS)); // payment trail names the bonus

    const over = await pay(manager, { monthName: '1405-06', amountPaid: BONUS + 1, paymentType: 'partial' });
    assertOk('over-cap refused', over, 400);
    expect(over.body.error).toContain('cannot exceed');

    const rest = await pay(manager, { monthName: '1405-06', amountPaid: BONUS, paymentType: 'partial' });
    assertOk('rest incl. bonus', rest, 201);
    const st = await status(manager);
    expect(st.body.remaining).toBe(0);
    expect(st.body.canPayFull).toBe(false);

    const again = await pay(manager, { monthName: '1405-06', amountPaid: 1, paymentType: 'partial' });
    assertOk('nothing remains', again, 409);
    // Nothing remains can never resurrect the bonus as extra pay.
    const fullAgain = await pay(manager, { monthName: '1405-06', amountPaid: BASE, paymentType: 'full' });
    assertOk('full refused', fullAgain, 409);
  });

  it('a month boundary starts a fresh due — no leakage either direction', async () => {
    const st = await status(manager);
    assertOk('status next month', st, 200);
    const next = await pay(manager, { monthName: '1405-07', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('full next month', next, 201);
    expect((ledger(manager).at(-1) as { due_amount: number }).due_amount).toBe(BASE + BONUS);
    // And the settled month did not pay twice into the new one.
    const totalPosted = (db.prepare(
      `SELECT COALESCE(SUM(paid_amount),0) s FROM employee_salary_ledger WHERE employee_id = ? AND status='posted'`,
    ).get(manager) as { s: number }).s;
    expect(totalPosted).toBe(2 * (BASE + BONUS));
  });

  it('advance×bonus: no mix of advance and salary extracts more than the due', async () => {
    const e = await seedEmployee(unique('W12BN Advance'), ROLE, BASE);
    const advance = await pay(e, { monthName: '1405-08', amountPaid: BASE + BONUS, paymentType: 'advance' });
    assertOk('advance', advance, 201);
    // The advance consumed the month's capacity: the composed due (bonus
    // included) is the ceiling for the TOTAL, not for each type separately.
    const st = await status(e);
    expect(st.body.due).toBe(BASE + BONUS);
    const trySalary = await pay(e, { monthName: '1405-08', amountPaid: 1, paymentType: 'partial' });
    assertOk('advance exhausted the month', trySalary, 409);
    expect(String(trySalary.body.error)).toContain('Nothing remains payable');
    // Total extracted can never exceed composed due.
    const posted = (db.prepare(
      `SELECT COALESCE(SUM(paid_amount),0) s FROM employee_salary_ledger WHERE employee_id = ? AND status='posted'`,
    ).get(e) as { s: number }).s;
    expect(posted).toBe(BASE + BONUS);
  });

  it('void restores the payable and the budget; the bonus survives', async () => {
    const e = await seedEmployee(unique('W12BN Void'), ROLE, BASE);
    const p1 = await pay(e, { monthName: '1405-09', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('pay full', p1, 201);
    const ledgerId = p1.body.ledgerId as string;
    const budgetAfterPay = budgetNow();

    const badReason = await request(app).post(`/api/employees/${e}/payroll/${ledgerId}/void`).set(owner()).send({ reason: 'short' });
    assertOk('void needs a real reason', badReason, 400);

    const v = await request(app).post(`/api/employees/${e}/payroll/${ledgerId}/void`).set(owner())
      .send({ reason: 'W12BN void probe — restore payable' });
    assertOk('void', v, 200, 201);
    expect(budgetNow()).toBe(budgetAfterPay + BASE + BONUS); // budget restored

    const st = await status(e);
    assertOk('status after void', st, 200);
    expect(st.body.paid).toBe(0); // voided row no longer counts
    expect(st.body.remaining).toBe(BASE + BONUS); // bonus is payable AGAIN…

    // …and paying it again does not double-count anywhere.
    const again = await pay(e, { monthName: '1405-09', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('re-pay after void', again, 201);
    const posted = (db.prepare(
      `SELECT COALESCE(SUM(paid_amount),0) s FROM employee_salary_ledger WHERE employee_id = ? AND status='posted'`,
    ).get(e) as { s: number }).s;
    expect(posted).toBe(BASE + BONUS); // exactly one live payment
    const doubleVoid = await request(app).post(`/api/employees/${e}/payroll/${ledgerId}/void`).set(owner())
      .send({ reason: 'W12BN second void must fail' });
    assertOk('cannot void twice', doubleVoid, 409);
  });

  it('budget exhaustion refuses the whole payment — no partial spend, no ledger row', async () => {
    const e = await seedEmployee(unique('W12BN Budget'), ROLE, BASE);
    const saved = budgetNow();
    setBudget(BASE + BONUS - 1); // one AFN short of the composed due
    const refused = await pay(e, { monthName: '1405-10', amountPaid: BASE + BONUS, paymentType: 'full' });
    assertOk('budget refused', refused, 409);
    expect(refused.body.error).toContain('Insufficient employee salary budget');
    expect(ledger(e)).toHaveLength(0); // nothing ledgered
    expect(budgetNow()).toBe(BASE + BONUS - 1); // nothing spent
    setBudget(saved); // restore for the rest of the suite
  });

  it('idempotent replay never pays the bonus twice', async () => {
    const e = await seedEmployee(unique('W12BN Idem'), ROLE, BASE);
    const key = `w12bn-idem-${seq}`;
    const first = await pay(e, { monthName: '1405-11', amountPaid: BASE + BONUS, paymentType: 'full' }, key);
    assertOk('first pay', first, 201);
    expect(first.body.replayed).toBe(false);
    const replay = await pay(e, { monthName: '1405-11', amountPaid: BASE + BONUS, paymentType: 'full' }, key);
    assertOk('replay', replay, 200, 201);
    expect(replay.body.replayed).toBe(true);
    const posted = (db.prepare(
      `SELECT COALESCE(SUM(paid_amount),0) s FROM employee_salary_ledger WHERE employee_id = ? AND status='posted'`,
    ).get(e) as { s: number }).s;
    expect(posted).toBe(BASE + BONUS);
  });

  it('malformed bonus rules refuse the whole calculation (no silent clamp)', async () => {
    const e = await seedEmployee(unique('W12BN Malformed'), ROLE, BASE);
    const st = await status(e);
    assertOk('status with honest rule', st, 200);
    expect(st.body.bonus).toBe(BONUS);

    // Fractional: payroll pays whole AFN.
    const fracRule = await makeBonusRule(0.5);
    const fracStatus = await status(e);
    assertOk('fractional refused', fracStatus, 409);
    expect(String(fracStatus.body.error)).toContain('configuration');
    const fracPay = await pay(e, { monthName: '1405-12', amountPaid: BASE, paymentType: 'partial' });
    assertOk('fractional pay refused', fracPay, 409);
    await request(app).patch(`/api/rules/${fracRule}`).set(owner()).send({ isActive: false });

    // Negative: a deduction in disguise — W9 policy block F.
    const negRule = await makeBonusRule(-100);
    const negStatus = await status(e);
    assertOk('negative refused', negStatus, 409);
    const negPay = await pay(e, { monthName: '1405-12', amountPaid: BASE, paymentType: 'partial' });
    assertOk('negative pay refused', negPay, 409);
    await request(app).patch(`/api/rules/${negRule}`).set(owner()).send({ isActive: false });

    // Deactivated → base only, payments work again.
    await request(app).patch(`/api/rules/${bonusRuleId}`).set(owner()).send({ isActive: false });
    const after = await status(e);
    assertOk('status after deactivate', after, 200);
    expect(after.body.bonus).toBe(0);
    expect(after.body.due).toBe(BASE);
    const p = await pay(e, { monthName: '1405-12', amountPaid: BASE, paymentType: 'full' });
    assertOk('base-only pay', p, 201);
  });

  it('salary payments never write rule-execution logs (dry-run parity with teachers)', () => {
    const logs = db.prepare(`SELECT COUNT(*) c FROM rule_evaluation_logs`).get() as { c: number };
    expect(logs.c).toBe(0);
  });

  it('the full invariant checker stays green', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
