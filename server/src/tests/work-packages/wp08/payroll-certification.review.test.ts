/**
 * WP-08 independent-review probes.
 *
 * This file reviews correction, reporting and direct-storage behavior through
 * paths that the first payroll attack suite does not share.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { runReport } from '../../../core/reporting/report-engine.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { employeesRouter, teachersRouter } from '../../../routes/teachers.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const BRANCH = `wp08_review_${runId}`;
const OWNER_ID = `wp08_review_owner_${runId}`;
const TEACHER_BUDGET_ID = `wp08_review_teacher_budget_${runId}`;
const EMPLOYEE_BUDGET_ID = `wp08_review_employee_budget_${runId}`;
const BUDGET = 100_000;
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');

let app: express.Express;
let owner: { Authorization: string };
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${runId}_${sequence}`;
}

function createTeacher(): string {
  const teacherId = nextId('teacher');
  db.prepare(
    `INSERT INTO teachers
       (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date, default_skill_rate)
     VALUES (?, ?, 10_000, 'fixed', 100, 'active', ?, '2020-01-01', 0)`,
  ).run(teacherId, `Review Teacher ${sequence}`, BRANCH);
  return teacherId;
}

function createEmployee(): string {
  const employeeId = nextId('employee');
  db.prepare(
    `INSERT INTO employees
       (id, full_name, role, base_salary, status, branch_id, joined_date)
     VALUES (?, ?, 'administrator', 10_000, 'active', ?, '2020-01-01')`,
  ).run(employeeId, `Review Employee ${sequence}`, BRANCH);
  return employeeId;
}

function teacherBudget(): number {
  return Number((db.prepare('SELECT current_amount AS amount FROM budget_lines WHERE id = ?').get(TEACHER_BUDGET_ID) as { amount: number }).amount);
}

function employeeBudget(): number {
  return Number((db.prepare('SELECT current_amount AS amount FROM budget_lines WHERE id = ?').get(EMPLOYEE_BUDGET_ID) as { amount: number }).amount);
}

function payrollMetric(id: 'payroll.teacher_paid' | 'payroll.employee_paid'): number {
  const report = runReport(db, 'payroll-summary', 'today', { branchId: BRANCH, isAll: false });
  return report.metrics.find((metric) => metric.id === id)!.value;
}

const payTeacher = (teacherId: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(owner).send(body);

const payEmployee = (employeeId: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/employees/${employeeId}/pay-salary`).set(owner).send(body);

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'WP-08 Review', 'Kabul');
  seedUser({ id: OWNER_ID, role: 'owner', branchId: BRANCH, fullName: 'WP-08 Review Owner' });
  owner = bearerFor(OWNER_ID);

  db.prepare(
    `INSERT INTO budget_lines
       (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id)
     VALUES (?, 'Teacher Salaries', ?, ?, 'sub_salaries_wages', 'teacher', ?)`,
  ).run(TEACHER_BUDGET_ID, BUDGET, BUDGET, BRANCH);
  db.prepare(
    `INSERT INTO budget_lines
       (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id)
     VALUES (?, 'Employee Salaries', ?, ?, 'sub_salaries_wages', 'employee', ?)`,
  ).run(EMPLOYEE_BUDGET_ID, BUDGET, BUDGET, BRANCH);

  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
});

describe('WP-08 independent review · employee correction and report reconciliation', () => {
  it('voids an employee payment atomically and removes it from payroll-paid reporting', async () => {
    const employeeId = createEmployee();
    const budgetBefore = employeeBudget();
    const metricBefore = payrollMetric('payroll.employee_paid');
    const paid = await payEmployee(employeeId, { monthName: '1405-05', amountPaid: 1_250, paymentType: 'partial' });
    expect(paid.status).toBe(201);
    expect(payrollMetric('payroll.employee_paid')).toBe(metricBefore + 1_250);

    const ledger = db.prepare(
      'SELECT id FROM employee_salary_ledger WHERE employee_id = ? AND status = \'posted\'',
    ).get(employeeId) as { id: string };
    const voided = await supertest(app)
      .post(`/api/employees/${employeeId}/payroll/${ledger.id}/void`)
      .set(owner)
      .send({ reason: 'Correct employee payroll entry.' });

    expect(voided.status).toBe(200);
    expect(db.prepare('SELECT status FROM employee_salary_ledger WHERE id = ?').get(ledger.id)).toEqual({ status: 'voided' });
    expect(employeeBudget()).toBe(budgetBefore);
    expect(payrollMetric('payroll.employee_paid')).toBe(metricBefore);
  });

  it('permits a corrected employee payment to reuse the voided request identity', async () => {
    const employeeId = createEmployee();
    const key = `employee-correction-${runId}`;
    const first = await supertest(app)
      .post(`/api/employees/${employeeId}/pay-salary`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ monthName: '1405-05', amountPaid: 900, paymentType: 'partial' });
    expect(first.status).toBe(201);
    const original = db.prepare('SELECT id FROM employee_salary_ledger WHERE employee_id = ? AND status = \'posted\'').get(employeeId) as { id: string };
    expect((await supertest(app)
      .post(`/api/employees/${employeeId}/payroll/${original.id}/void`)
      .set(owner)
      .send({ reason: 'Correct employee retry record.' })).status).toBe(200);

    const corrected = await supertest(app)
      .post(`/api/employees/${employeeId}/pay-salary`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ monthName: '1405-05', amountPaid: 900, paymentType: 'partial' });
    expect(corrected.status).toBe(201);
    expect(corrected.body.replayed).toBe(false);
    expect(db.prepare('SELECT status FROM employee_salary_ledger WHERE employee_id = ? ORDER BY rowid').all(employeeId)).toEqual([
      { status: 'voided' }, { status: 'posted' },
    ]);
  });

  it('reports a newly posted teacher payment in the same canonical day', async () => {
    const teacherId = createTeacher();
    const before = payrollMetric('payroll.teacher_paid');
    const paid = await payTeacher(teacherId, { monthName: '1405-05', amountPaid: 1_500, paymentType: 'partial' });

    expect(paid.status).toBe(201);
    expect(payrollMetric('payroll.teacher_paid')).toBe(before + 1_500);
  });
});

describe('WP-08 independent review · the operator contract matches the teacher payment authority', () => {
  it('does not offer a teacher advance that the server deliberately rejects', () => {
    const modal = fs.readFileSync(path.join(repoRoot, 'src', 'components', 'teachers', 'TeachersModals.tsx'), 'utf8');
    const teacherPaymentSurface = modal.split('{/* Pay Employee Salary Modal */}')[0];
    const store = fs.readFileSync(path.join(repoRoot, 'src', 'apiStore.ts'), 'utf8');

    expect(teacherPaymentSurface).not.toContain('<option value="advance">Advance</option>');
    expect(store).toMatch(/payTeacherSalary = async \([^\n]+paymentType: 'full' \| 'partial'/);
  });
});

describe('WP-08 independent review · ledger facts are linked and immutable', () => {
  it('does not admit a valid-looking teacher ledger row without its financial transaction', () => {
    const teacherId = createTeacher();
    let inserted = false;
    const probe = db.transaction(() => {
      db.prepare(
        `INSERT INTO teacher_salary_ledger
           (id, teacher_id, period_key, period_label, due_amount, paid_amount, payment_type, branch_id, operator_name, status)
         VALUES (?, ?, '1405-06', 'سنبله ۱۴۰۵', 1_000, 1_000, 'full', ?, 'review', 'posted')`,
      ).run(nextId('ledger'), teacherId, BRANCH);
      inserted = true;
      throw new Error('rollback missing-transaction probe');
    });
    try { probe(); } catch { /* rejection and rollback both leave no row */ }
    expect(inserted).toBe(false);
  });

  it('does not admit a valid-looking employee ledger row without its financial transaction', () => {
    const employeeId = createEmployee();
    let inserted = false;
    const probe = db.transaction(() => {
      db.prepare(
        `INSERT INTO employee_salary_ledger
           (id, employee_id, period_key, period_label, paid_amount, payment_type, branch_id, operator_name, status)
         VALUES (?, ?, '1405-06', 'سنبله ۱۴۰۵', 1_000, 'partial', ?, 'review', 'posted')`,
      ).run(nextId('ledger'), employeeId, BRANCH);
      inserted = true;
      throw new Error('rollback missing-transaction probe');
    });
    try { probe(); } catch { /* rejection and rollback both leave no row */ }
    expect(inserted).toBe(false);
  });

  it('rejects a negative employee ledger amount even when a matching transaction is supplied', () => {
    const employeeId = createEmployee();
    let inserted = false;
    const probe = db.transaction(() => {
      const transactionId = nextId('transaction');
      db.prepare(
        `INSERT INTO financial_transactions
           (id, type, category, finance_category_id, amount, date, description, reference_id, operator_name, branch_id)
         VALUES (?, 'expense', 'salary', 'sub_salaries_wages', -1, '2026-08-22', 'probe', ?, 'review', ?)`,
      ).run(transactionId, employeeId, BRANCH);
      db.prepare(
        `INSERT INTO employee_salary_ledger
           (id, employee_id, period_key, period_label, paid_amount, payment_type, transaction_id, branch_id, operator_name, status)
         VALUES (?, ?, '1405-06', 'سنبله ۱۴۰۵', -1, 'partial', ?, ?, 'review', 'posted')`,
      ).run(nextId('ledger'), employeeId, transactionId, BRANCH);
      inserted = true;
      throw new Error('rollback negative-amount probe');
    });
    try { probe(); } catch { /* rejection and rollback both leave no row */ }
    expect(inserted).toBe(false);
  });

  it('does not allow a posted teacher payment to be rewritten or deleted directly', async () => {
    const teacherId = createTeacher();
    const paid = await payTeacher(teacherId, { monthName: '1405-07', amountPaid: 1_000, paymentType: 'partial' });
    expect(paid.status).toBe(201);
    const ledger = db.prepare('SELECT id FROM teacher_salary_ledger WHERE teacher_id = ?').get(teacherId) as { id: string };

    let mutated = false;
    const updateProbe = db.transaction(() => {
      db.prepare('UPDATE teacher_salary_ledger SET paid_amount = 500 WHERE id = ?').run(ledger.id);
      mutated = true;
      throw new Error('rollback update probe');
    });
    try { updateProbe(); } catch { /* rejection and rollback both leave no change */ }
    expect(mutated).toBe(false);

    let deleted = false;
    const deleteProbe = db.transaction(() => {
      db.prepare('DELETE FROM teacher_salary_ledger WHERE id = ?').run(ledger.id);
      deleted = true;
      throw new Error('rollback delete probe');
    });
    try { deleteProbe(); } catch { /* rejection and rollback both retain history */ }
    expect(deleted).toBe(false);
    expect(teacherBudget()).toBeLessThan(BUDGET);
  });

  it('does not allow the financial transaction linked to a salary fact to be deleted directly', async () => {
    const teacherId = createTeacher();
    const paid = await payTeacher(teacherId, { monthName: '1405-08', amountPaid: 1_000, paymentType: 'partial' });
    expect(paid.status).toBe(201);
    const ledger = db.prepare('SELECT transaction_id FROM teacher_salary_ledger WHERE teacher_id = ?').get(teacherId) as { transaction_id: string };

    let deleted = false;
    const probe = db.transaction(() => {
      db.prepare('DELETE FROM financial_transactions WHERE id = ?').run(ledger.transaction_id);
      deleted = true;
      throw new Error('rollback linked-transaction probe');
    });
    try { probe(); } catch { /* rejection and rollback both preserve the link */ }
    expect(deleted).toBe(false);
  });
});
