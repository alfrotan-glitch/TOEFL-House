/**
 * Input error contract — regression suite for teacher-audit finding T-3.
 *
 * THE CONTRACT (the codebase's own documented standard, utils/money.ts):
 * "a malformed amount is INVALID CLIENT INPUT, not a server fault." Malformed
 * input must therefore produce a 4xx with a useful message, must never leak a
 * raw SqliteError as a 500, and must leave no database or financial residue.
 *
 * PRE-FIX BEHAVIOUR, reproduced live on a fresh database before any code was
 * changed:
 *
 *   POST /api/teachers/:id/evaluation
 *     score 'abc' / {} / '50abc'  -> 500 "NOT NULL constraint failed: teacher_evaluations.score"
 *     score true                  -> 201, silently STORED as 1
 *     score '0x10'                -> 201, silently STORED as 16, response echoed '0x10'
 *   POST /api/employees/:id/pay-salary
 *     amountPaid 0.001            -> 500 (two-decimal database trigger)
 *     amountPaid true             -> 201, a real 1 AFN payment
 *     amountPaid '0x10'           -> 201, a real 16 AFN payment
 *   POST /api/teachers/:id/pay-salary
 *     amountPaid 0.001            -> 500  (the audit recorded this path as a
 *                                          correct control; that was WRONG)
 *
 * Root cause: `score <= 0 || score > 100` is a comparison and `Number(x)` is a
 * coercion. Neither is a parse, so non-numbers reached SQLite and the database
 * constraint became the validator.
 *
 * The range rules themselves are UNCHANGED. Evaluation still accepts a positive
 * number 1..100; payment still accepts any amount greater than zero. Only the
 * enforcement layer moved from the database back to the HTTP boundary.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today, id as mkId } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { teachersRouter, employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'tec_branch';
const START_BUDGET = 500_000;

let app: express.Express;
let owner: TokenPayload;
let empBudgetId: string;
let teachBudgetId: string;

const auth = () => ({ Authorization: `Bearer ${signToken(owner)}` });

/** Values that are not numbers. Every one either crashed with a 500 or was
 *  silently coerced into a real value pre-fix. */
const NON_NUMBERS: Array<[string, unknown]> = [
  ['text', 'abc'],
  ['object', {}],
  ['array', []],
  ['boolean true', true],
  ['boolean false', false],
  ['empty string', ''],
  ['whitespace', '   '],
  ['hex string', '0x10'],
  ['trailing garbage', '50abc'],
  ['exponent string', '1e3'],
];

let seq = 0;
function mkTeacher(score = 40) {
  const tid = `tec_t${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO teachers (id, full_name, branch_id, base_salary, salary_type, status, joined_date, performance_score, default_skill_rate)
     VALUES (?, ?, ?, 10000, 'fixed', 'active', ?, ?, 0)`,
  ).run(tid, `Teacher ${tid}`, BRANCH, today(), score);
  return tid;
}
function mkEmployee() {
  const eid = `tec_e${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
     VALUES (?, ?, 'clerk', ?, 8000, 'active', ?)`,
  ).run(eid, `Employee ${eid}`, BRANCH, today());
  return eid;
}

const budgetOf = (lineId: string) =>
  Number((db.prepare('SELECT current_amount c FROM budget_lines WHERE id = ?').get(lineId) as { c: number }).c);
const evalRows = (tid: string) =>
  db.prepare('SELECT * FROM teacher_evaluations WHERE teacher_id = ?').all(tid) as Array<Record<string, unknown>>;
const scoreOf = (tid: string) =>
  Number((db.prepare('SELECT performance_score s FROM teachers WHERE id = ?').get(tid) as { s: number }).s);
const txRows = (ref: string) =>
  db.prepare('SELECT * FROM financial_transactions WHERE reference_id = ?').all(ref) as Array<Record<string, unknown>>;
const ledgerRows = (eid: string) =>
  db.prepare('SELECT * FROM employee_salary_ledger WHERE employee_id = ?').all(eid) as Array<Record<string, unknown>>;
const teacherLedgerRows = (tid: string) =>
  db.prepare('SELECT * FROM teacher_salary_ledger WHERE teacher_id = ?').all(tid) as Array<Record<string, unknown>>;

const evaluate = (tid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/teachers/${tid}/evaluation`).set(auth()).send(body);
const payEmployee = (eid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/employees/${eid}/pay-salary`).set(auth()).send(body);
const payTeacher = (tid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/teachers/${tid}/pay-salary`).set(auth()).send(body);

/** A response is contract-compliant when it is a 4xx carrying a human-readable
 *  message that is NOT a leaked database error. */
function expectClientError(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  const message = String(res.body?.error ?? '');
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toMatch(/constraint failed|SqliteError|SQLITE_/i);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'TEC Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('tec_owner', 'tec_owner', 'TEC Owner', ?, ?, 1, 0)`,
  ).run(BRANCH, await hashPassword('pw'));
  assignRole('tec_owner', 'owner', BRANCH);

  owner = { userId: 'tec_owner', username: 'tec_owner', branchId: BRANCH, fullName: 'TEC Owner' };

  empBudgetId = mkId('bl');
  db.prepare('INSERT INTO budget_lines (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(empBudgetId, 'Employee Salaries', START_BUDGET, START_BUDGET, 'sub_salaries_wages', 'employee', BRANCH);
  teachBudgetId = mkId('bl');
  db.prepare('INSERT INTO budget_lines (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(teachBudgetId, 'Teacher Salaries', START_BUDGET, START_BUDGET, 'sub_salaries_wages', 'teacher', BRANCH);

  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
});

describe('T-3 · evaluation score returns 4xx, never 500, and stores nothing', () => {
  for (const [label, value] of NON_NUMBERS) {
    it(`rejects a ${label} score with a client error and no residue`, async () => {
      const tid = mkTeacher(40);
      const res = await evaluate(tid, { score: value });
      expectClientError(res);
      // Pre-fix: 'abc' leaked "NOT NULL constraint failed" as a 500, while
      // true and '0x10' were accepted and stored as 1 and 16.
      expect(evalRows(tid)).toHaveLength(0);
      expect(scoreOf(tid)).toBe(40);
    });
  }

  it('rejects a missing score', async () => {
    const tid = mkTeacher(40);
    const res = await evaluate(tid, {});
    expectClientError(res);
    expect(evalRows(tid)).toHaveLength(0);
    expect(scoreOf(tid)).toBe(40);
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -5],
    ['above 100', 101],
  ])('keeps rejecting an out-of-range score (%s)', async (_label, value) => {
    const tid = mkTeacher(40);
    const res = await evaluate(tid, { score: value });
    expect(res.status).toBe(400);
    expect(evalRows(tid)).toHaveLength(0);
    expect(scoreOf(tid)).toBe(40);
  });

  it('still rejects malformed criteria without residue', async () => {
    const tid = mkTeacher(40);
    for (const criteria of ['notanobject', [1, 2]]) {
      const res = await evaluate(tid, { score: 50, criteria });
      expect(res.status).toBe(400);
    }
    expect(evalRows(tid)).toHaveLength(0);
    expect(scoreOf(tid)).toBe(40);
  });
});

describe('T-3 · evaluation still accepts every legitimate score', () => {
  it.each([
    ['minimum 1', 1, 1],
    ['mid 50', 50, 50],
    ['fractional 87.5', 87.5, 87.5],
    ['maximum 100', 100, 100],
    ['numeric string "75"', '75', 75],
  ])('accepts %s', async (_label, sent, stored) => {
    const tid = mkTeacher(40);
    const res = await evaluate(tid, { score: sent });
    expect(res.status).toBe(201);
    expect(evalRows(tid)).toHaveLength(1);
    expect(scoreOf(tid)).toBe(stored);
    // The response and the stored row must agree. Pre-fix a '0x10' request
    // answered score:'0x10' while the row actually held 16.
    expect(res.body.score).toBe(stored);
    expect(Number(evalRows(tid)[0].score)).toBe(stored);
  });

  it('records a full evaluation with criteria and notes', async () => {
    const tid = mkTeacher(40);
    const res = await evaluate(tid, { score: 88, criteria: { teaching: 90 }, notes: 'Good' });
    expect(res.status).toBe(201);
    const [row] = evalRows(tid);
    expect(Number(row.score)).toBe(88);
    expect(String(row.criteria)).toContain('teaching');
    expect(row.notes).toBe('Good');
    expect(scoreOf(tid)).toBe(88);
  });
});

describe('T-3 · employee pay-salary returns 4xx, never 500, and moves no money', () => {
  for (const [label, value] of NON_NUMBERS) {
    it(`rejects a ${label} amount with a client error and no financial residue`, async () => {
      const eid = mkEmployee();
      const before = budgetOf(empBudgetId);
      const res = await payEmployee(eid, { monthName: 'Asad 1405', amountPaid: value, paymentType: 'partial' });
      expectClientError(res);
      // Pre-fix: true became a real 1 AFN payment and '0x10' a real 16 AFN one.
      expect(budgetOf(empBudgetId)).toBe(before);
      expect(txRows(eid)).toHaveLength(0);
      expect(ledgerRows(eid)).toHaveLength(0);
    });
  }

  it('rejects a sub-cent amount with 400 instead of a 500 from the database trigger', async () => {
    const eid = mkEmployee();
    const before = budgetOf(empBudgetId);
    const res = await payEmployee(eid, { monthName: 'Asad 1405', amountPaid: 0.001, paymentType: 'partial' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).not.toMatch(/two decimal|constraint/i);
    expect(budgetOf(empBudgetId)).toBe(before);
    expect(txRows(eid)).toHaveLength(0);
    expect(ledgerRows(eid)).toHaveLength(0);
  });

  it('rejects an amount beyond monetary precision without touching the budget', async () => {
    const eid = mkEmployee();
    const before = budgetOf(empBudgetId);
    const res = await payEmployee(eid, { monthName: 'Asad 1405', amountPaid: 1e15, paymentType: 'partial' });
    expectClientError(res);
    expect(budgetOf(empBudgetId)).toBe(before);
    expect(txRows(eid)).toHaveLength(0);
  });

  it('still pays a legitimate amount, including one needing two-decimal rounding', async () => {
    const eid = mkEmployee();
    const before = budgetOf(empBudgetId);
    const res = await payEmployee(eid, { monthName: 'Asad 1405', amountPaid: 1234.567, paymentType: 'partial' });
    expect(res.status).toBe(201);
    // 1234.567 rounds to 1234.57 — accepted, not rejected, and the ledger,
    // the expense row and the budget debit must all agree on the rounded value.
    expect(res.body.amountPaid).toBe(1234.57);
    // Float subtraction of two REAL columns is not exact (500000 - 498765.43
    // yields 1234.570000000007), so the DEBIT is compared with a tolerance
    // while the stored ledger and expense values are asserted exactly below.
    expect(before - budgetOf(empBudgetId)).toBeCloseTo(1234.57, 2);
    expect(Number(ledgerRows(eid)[0].paid_amount)).toBe(1234.57);
    expect(Number(txRows(eid)[0].amount)).toBe(1234.57);
  });

  it('still pays a plain whole amount', async () => {
    const eid = mkEmployee();
    const before = budgetOf(empBudgetId);
    const res = await payEmployee(eid, { monthName: 'Jadi 1405', amountPaid: 2000, paymentType: 'partial' });
    expect(res.status).toBe(201);
    expect(before - budgetOf(empBudgetId)).toBe(2000);
  });
});

describe('T-3 · teacher pay-salary honours the same contract', () => {
  // The audit recorded this path as a correct control. Live reproduction
  // refuted that: 0.001 returned 500 here too.
  it('rejects a sub-cent amount with 400 instead of 500', async () => {
    const tid = mkTeacher();
    const before = budgetOf(teachBudgetId);
    const res = await payTeacher(tid, { monthName: '1405-05', amountPaid: 0.001, paymentType: 'partial' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).not.toMatch(/two decimal|constraint/i);
    expect(budgetOf(teachBudgetId)).toBe(before);
    expect(teacherLedgerRows(tid)).toHaveLength(0);
  });

  it.each(NON_NUMBERS)('rejects a %s amount with no residue', async (_label, value) => {
    const tid = mkTeacher();
    const before = budgetOf(teachBudgetId);
    const res = await payTeacher(tid, { monthName: '1405-05', amountPaid: value, paymentType: 'partial' });
    expectClientError(res);
    expect(budgetOf(teachBudgetId)).toBe(before);
    expect(teacherLedgerRows(tid)).toHaveLength(0);
  });

  it.each([
    ['explicit zero', 0],
    ['string zero', '0'],
    ['sub-cent that rounds to zero', 0.001],
  ])('rejects a zero-value payment (%s) and writes no ledger row', async (_label, value) => {
    // assertMoney legitimately ROUNDS 0.001 down to 0 (established, test-locked
    // behaviour in money-boundary-property.test.ts). Parsing alone therefore
    // does not stop a zero-amount payment — the endpoint's own "greater than
    // zero" rule is what refuses it, and mutation testing showed nothing
    // covered that. A zero payment would post a ledger row and an expense row
    // for no money at all.
    const tid = mkTeacher();
    const before = budgetOf(teachBudgetId);
    const res = await payTeacher(tid, { monthName: '1405-08', amountPaid: value, paymentType: 'partial' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/greater than zero/i);
    expect(budgetOf(teachBudgetId)).toBe(before);
    expect(teacherLedgerRows(tid)).toHaveLength(0);
  });

  it('preserves the optional-amount contract: omitting amountPaid pays the full balance', async () => {
    // `amountPaid` is optional on this endpoint — omitting it means "pay what
    // is owed". Parsing must not turn a missing value into a 400.
    const tid = mkTeacher();
    const res = await payTeacher(tid, { monthName: '1405-06', paymentType: 'full' });
    expect(res.status).toBe(201);
    expect(teacherLedgerRows(tid)).toHaveLength(1);
  });

  it('still pays a legitimate partial amount', async () => {
    const tid = mkTeacher();
    const before = budgetOf(teachBudgetId);
    const res = await payTeacher(tid, { monthName: '1405-07', amountPaid: 1500, paymentType: 'partial' });
    expect(res.status).toBe(201);
    expect(before - budgetOf(teachBudgetId)).toBe(1500);
  });
});

describe('T-3 · no raw database error can reach the client from these routes', () => {
  it('never leaks a SqliteError across the whole malformed-input matrix', async () => {
    const leaks: string[] = [];
    for (const [, value] of NON_NUMBERS) {
      const t1 = mkTeacher();
      const r1 = await evaluate(t1, { score: value });
      const e1 = mkEmployee();
      const r2 = await payEmployee(e1, { monthName: 'Asad 1405', amountPaid: value, paymentType: 'partial' });
      const t2 = mkTeacher();
      const r3 = await payTeacher(t2, { monthName: '1405-05', amountPaid: value, paymentType: 'partial' });
      for (const [name, r] of [['evaluation', r1], ['employee-pay', r2], ['teacher-pay', r3]] as const) {
        if (r.status >= 500) leaks.push(`${name}(${JSON.stringify(value)}) -> ${r.status}`);
        if (/constraint failed|SqliteError/i.test(String(r.body?.error ?? ''))) {
          leaks.push(`${name}(${JSON.stringify(value)}) leaked: ${String(r.body?.error)}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
