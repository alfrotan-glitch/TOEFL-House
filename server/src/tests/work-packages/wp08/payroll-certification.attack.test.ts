/**
 * WP-08 payroll certification — adversarial boundary tests.
 *
 * These cases exercise the payroll writer where ordinary happy-path tests are
 * least informative: a derived retry crossing its time bucket, a corrected
 * payment, malformed period input, scoped HR transfer, corrupt active policy,
 * direct ledger writes, and canonical-schema duplication.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { IDEMPOTENCY_WINDOW_SECONDS } from '../../../utils/idempotency.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { employeesRouter, teachersRouter } from '../../../routes/teachers.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const BRANCH_A = `wp08_attack_a_${runId}`;
const BRANCH_B = `wp08_attack_b_${runId}`;
const OWNER_ID = `wp08_owner_${runId}`;
const MANAGER_ID = `wp08_manager_${runId}`;
const TEACHER_BUDGET_ID = `wp08_teacher_budget_${runId}`;
const EMPLOYEE_BUDGET_ID = `wp08_employee_budget_${runId}`;
const MALFORMED_RULE_ID = `wp08_bad_rule_${runId}`;
const BUDGET = 1_000_000;

let app: express.Express;
let owner: { Authorization: string };
let manager: { Authorization: string };
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${runId}_${sequence}`;
}

function createTeacher(baseSalary = 10_000): string {
  const teacherId = nextId('teacher');
  db.prepare(
    `INSERT INTO teachers
       (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate)
     VALUES (?, ?, ?, 'fixed', 100, 'active', ?, '2020-01-01', 0)`,
  ).run(teacherId, `WP-08 Teacher ${sequence}`, baseSalary, BRANCH_A);
  return teacherId;
}

function createEmployee(branchId = BRANCH_A): string {
  const employeeId = nextId('employee');
  db.prepare(
    `INSERT INTO employees
       (id, full_name, role, base_salary, status, branch_id, joined_date)
     VALUES (?, ?, 'administrator', 10_000, 'active', ?, '2020-01-01')`,
  ).run(employeeId, `WP-08 Employee ${sequence}`, branchId);
  return employeeId;
}

function teacherBudget(): number {
  return Number((db.prepare('SELECT current_amount AS amount FROM budget_lines WHERE id = ?').get(TEACHER_BUDGET_ID) as { amount: number }).amount);
}

function employeeBudget(): number {
  return Number((db.prepare('SELECT current_amount AS amount FROM budget_lines WHERE id = ?').get(EMPLOYEE_BUDGET_ID) as { amount: number }).amount);
}

function teacherLedgerRows(teacherId: string): Array<{ id: string; status: string; paid_amount: number }> {
  return db.prepare(
    'SELECT id, status, paid_amount FROM teacher_salary_ledger WHERE teacher_id = ? ORDER BY paid_at, rowid',
  ).all(teacherId) as Array<{ id: string; status: string; paid_amount: number }>;
}

function employeeLedgerRows(employeeId: string): Array<{ id: string; paid_amount: number }> {
  return db.prepare(
    'SELECT id, paid_amount FROM employee_salary_ledger WHERE employee_id = ? ORDER BY paid_at, rowid',
  ).all(employeeId) as Array<{ id: string; paid_amount: number }>;
}

function teacherTransactions(teacherId: string): Array<{ amount: number }> {
  return db.prepare(
    `SELECT amount FROM financial_transactions
      WHERE type = 'expense' AND (
        reference_id = ? OR reference_id IN (
          SELECT id FROM teacher_salary_ledger WHERE teacher_id = ?
        )
      )
      ORDER BY rowid`,
  ).all(teacherId, teacherId) as Array<{ amount: number }>;
}

function employeeTransactions(employeeId: string): Array<{ amount: number }> {
  return db.prepare(
    "SELECT amount FROM financial_transactions WHERE reference_id = ? AND type = 'expense' ORDER BY rowid",
  ).all(employeeId) as Array<{ amount: number }>;
}

const payTeacher = (teacherId: string, body: Record<string, unknown>, key?: string) => {
  const request = supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(owner);
  if (key) request.set('Idempotency-Key', key);
  return request.send(body);
};

const payEmployee = (employeeId: string, body: Record<string, unknown>, key?: string) => {
  const request = supertest(app).post(`/api/employees/${employeeId}/pay-salary`).set(owner);
  if (key) request.set('Idempotency-Key', key);
  return request.send(body);
};

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'WP-08 Attack A', 'Kabul');
  db.prepare('INSERT INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'WP-08 Attack B', 'Kabul');
  seedUser({ id: OWNER_ID, role: 'owner', branchId: BRANCH_A, fullName: 'WP-08 Owner' });
  seedUser({ id: MANAGER_ID, role: 'general_manager', branchId: BRANCH_A, fullName: 'WP-08 Manager' });
  owner = bearerFor(OWNER_ID);
  manager = bearerFor(MANAGER_ID);

  db.prepare(
    `INSERT INTO budget_lines
       (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id)
     VALUES (?, 'Teacher Salaries', ?, ?, 'sub_salaries_wages', 'teacher', ?)`,
  ).run(TEACHER_BUDGET_ID, BUDGET, BUDGET, BRANCH_A);
  db.prepare(
    `INSERT INTO budget_lines
       (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id)
     VALUES (?, 'Employee Salaries', ?, ?, 'sub_salaries_wages', 'employee', ?)`,
  ).run(EMPLOYEE_BUDGET_ID, BUDGET, BUDGET, BRANCH_A);

  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
});

afterAll(() => {
  db.prepare('DELETE FROM rule_definitions WHERE id = ?').run(MALFORMED_RULE_ID);
});

describe('WP-08 ATTACK · a derived retry survives the idempotency bucket edge', () => {
  it('does not pay a teacher twice when a retry lands on the next 90-second bucket', async () => {
    const teacherId = createTeacher();
    const beforeBudget = teacherBudget();
    const window = IDEMPOTENCY_WINDOW_SECONDS * 1000;
    const clock = vi.spyOn(Date, 'now');

    try {
      clock.mockReturnValue(window * 1_000 + window - 1);
      const first = await payTeacher(teacherId, { monthName: '1405-05', amountPaid: 1_000, paymentType: 'partial' });
      clock.mockReturnValue(window * 1_001 + 1);
      const retry = await payTeacher(teacherId, { monthName: '1405-05', amountPaid: 1_000, paymentType: 'partial' });

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body.replayed).toBe(true);
      expect(teacherLedgerRows(teacherId)).toHaveLength(1);
      expect(teacherTransactions(teacherId)).toEqual([{ amount: 1_000 }]);
      expect(beforeBudget - teacherBudget()).toBe(1_000);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not pay an employee twice when a retry lands on the next 90-second bucket', async () => {
    const employeeId = createEmployee();
    const beforeBudget = employeeBudget();
    const window = IDEMPOTENCY_WINDOW_SECONDS * 1000;
    const clock = vi.spyOn(Date, 'now');

    try {
      clock.mockReturnValue(window * 2_000 + window - 1);
      const first = await payEmployee(employeeId, { monthName: '1405-05', amountPaid: 1_000, paymentType: 'partial' });
      clock.mockReturnValue(window * 2_001 + 1);
      const retry = await payEmployee(employeeId, { monthName: '1405-05', amountPaid: 1_000, paymentType: 'partial' });

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.body.replayed).toBe(true);
      expect(employeeLedgerRows(employeeId)).toHaveLength(1);
      expect(employeeTransactions(employeeId)).toEqual([{ amount: 1_000 }]);
      expect(beforeBudget - employeeBudget()).toBe(1_000);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('WP-08 ATTACK · correcting a teacher payment cannot turn into a false replay', () => {
  it('posts a new live payment after the original payment is voided', async () => {
    const teacherId = createTeacher();
    const beforeBudget = teacherBudget();
    const key = `wp08-correction-${runId}`;

    const first = await payTeacher(teacherId, { monthName: '1405-06', amountPaid: 2_000, paymentType: 'partial' }, key);
    expect(first.status).toBe(201);
    const original = teacherLedgerRows(teacherId)[0];
    const voided = await supertest(app)
      .post(`/api/teachers/${teacherId}/payroll/${original.id}/void`)
      .set(owner)
      .send({ reason: 'Correct the original payroll entry.' });
    expect(voided.status).toBe(200);

    const corrected = await payTeacher(teacherId, { monthName: '1405-06', amountPaid: 2_000, paymentType: 'partial' }, key);
    expect(corrected.status).toBe(201);
    expect(corrected.body.replayed).not.toBe(true);
    expect(teacherLedgerRows(teacherId).map((row) => row.status)).toEqual(['voided', 'posted']);
    expect(teacherTransactions(teacherId).map((row) => row.amount)).toEqual([2_000, -2_000, 2_000]);
    expect(beforeBudget - teacherBudget()).toBe(2_000);
  });
});

describe('WP-08 ATTACK · every payroll period is canonical', () => {
  it('refuses an employee salary payment with a non-period object and writes no money', async () => {
    const employeeId = createEmployee();
    const beforeBudget = employeeBudget();
    const result = await payEmployee(employeeId, {
      monthName: { key: '1405-05' },
      amountPaid: 500,
      paymentType: 'partial',
    });

    expect(result.status).toBe(400);
    expect(employeeLedgerRows(employeeId)).toEqual([]);
    expect(employeeTransactions(employeeId)).toEqual([]);
    expect(employeeBudget()).toBe(beforeBudget);
  });

  it('refuses a supplied invalid teacher computed-salary period instead of calculating the current one', async () => {
    const teacherId = createTeacher();
    const result = await supertest(app)
      .get(`/api/teachers/${teacherId}/computed-salary?month=not-a-payroll-period`)
      .set(owner);

    expect(result.status).toBe(400);
  });
});

describe('WP-08 ATTACK · payroll configuration failure fails closed', () => {
  it('does not substitute neutral multipliers when an active payroll rule is malformed', async () => {
    const teacherId = createTeacher();
    const beforeBudget = teacherBudget();
    db.prepare(
      `INSERT INTO rule_definitions
         (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, last_modified_by)
       VALUES (?, 'Malformed payroll rule', '', 'payroll', ?, ?, 99_999, 1, ?, 1, 'attack')`,
    ).run(
      MALFORMED_RULE_ID,
      JSON.stringify([{ field: '', operator: 'eq', value: 'x' }]),
      JSON.stringify([{ type: 'set_value', targetKey: 'performanceMultiplier', value: 2 }]),
      BRANCH_A,
    );

    const result = await payTeacher(teacherId, { monthName: '1405-07', amountPaid: 500, paymentType: 'partial' });
    expect(result.status).toBe(409);
    expect(teacherLedgerRows(teacherId)).toEqual([]);
    expect(teacherTransactions(teacherId)).toEqual([]);
    expect(teacherBudget()).toBe(beforeBudget);
  });
});

describe('WP-08 ATTACK · no branch-scoped manager can move an employee into another branch', () => {
  it('rejects a target branch outside the manager\'s effective scope', async () => {
    const employeeId = createEmployee();
    const result = await supertest(app)
      .post(`/api/employees/${employeeId}/transfer`)
      .set(manager)
      .send({ targetBranchId: BRANCH_B });

    expect(result.status).toBe(403);
    const row = db.prepare('SELECT branch_id FROM employees WHERE id = ?').get(employeeId) as { branch_id: string };
    expect(row.branch_id).toBe(BRANCH_A);
  });
});

describe('WP-08 ATTACK · the database rejects malformed payroll facts', () => {
  it('refuses a negative teacher salary ledger row even when a writer bypasses HTTP', () => {
    const teacherId = createTeacher();
    let inserted = false;
    const probe = db.transaction(() => {
      db.prepare(
        `INSERT INTO teacher_salary_ledger
           (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, branch_id, operator_name, status)
         VALUES (?, ?, '1405-08', 'اسد ۱۴۰۵', 10_000, -1, 'partial', ?, 'attack', 'posted')`,
      ).run(nextId('ledger'), teacherId, BRANCH_A);
      inserted = true;
      throw new Error('rollback direct-write probe');
    });

    try {
      probe();
    } catch {
      // A rejected write and the intentional rollback both leave no fact.
    }
    expect(inserted).toBe(false);
  });

  it('contains only one canonical covering index for teacher period lookups', () => {
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'teacher_salary_ledger'
         AND sql LIKE '%teacher_id, period_key, paid_at%'`,
    ).all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });
});
