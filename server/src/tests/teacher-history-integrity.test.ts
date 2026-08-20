/**
 * Teacher employment and pay history is immutable
 * ============================================================================
 * ISSUE 7 asked for a complete historical record. An audit against the running
 * API found the infrastructure already present and working — this suite exists
 * to LOCK that behaviour, because it is exactly the kind of history a later
 * "simplification" silently destroys by turning an append into an UPDATE.
 *
 * Each test states the destructive change it is designed to catch:
 *
 *   - a raise that OVERWRITES the previous compensation row instead of
 *     appending a new effective period,
 *   - a partial payment recorded as though it settled the period, erasing the
 *     outstanding balance the academy still owes,
 *   - a void implemented as DELETE, which would erase both the original
 *     payment and the reason it was reversed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'th_branch';
let app: express.Express;
let seq = 0;

function user(): TokenPayload {
  return { userId: 'u_th', username: 'th_owner', role: 'owner', branchId: BRANCH, fullName: 'TH Owner' };
}
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

async function hire(baseSalary: number): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/teachers').set(auth()).send({
    fullName: `History Teacher ${seq}`,
    phone: `0777${String(300000 + seq).slice(-6)}`,
    gender: 'male',
    branchId: BRANCH,
    contractType: 'monthly',
    salaryType: 'fixed',
    baseSalary,
    hireDate: '2026-01-01',
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

function compensationRows(teacherId: string) {
  return db.prepare(
    `SELECT base_salary, reason FROM teacher_compensation_history
      WHERE teacher_id = ? ORDER BY created_at ASC, rowid ASC`
  ).all(teacherId) as Array<{ base_salary: number; reason: string }>;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'TH Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`
  ).run('u_th', 'th_owner', 'TH Owner', BRANCH, await hashPassword('x'));
  syncLegacyUserRoles(db);

  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use(errorHandler);
});

describe('teacher compensation history is append-only', () => {
  it('records the initial contract as the first effective period', async () => {
    const id = await hire(30000);
    const rows = compensationRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].base_salary).toBe(30000);
  });

  it('a raise APPENDS a period and preserves the previous salary', async () => {
    const id = await hire(30000);
    const res = await supertest(app).put(`/api/teachers/${id}`).set(auth())
      .send({ baseSalary: 35000, compensationReason: 'Annual review' });
    expect(res.status).toBe(200);

    const rows = compensationRows(id);
    // Catches a raise implemented as UPDATE: the 30,000 period must survive.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.base_salary)).toEqual([30000, 35000]);
    expect(rows[1].reason).toBe('Annual review');
  });

  it('exposes the full history through the API, newest first', async () => {
    const id = await hire(20000);
    await supertest(app).put(`/api/teachers/${id}`).set(auth())
      .send({ baseSalary: 24000, compensationReason: 'Promotion' });

    const res = await supertest(app).get(`/api/teachers/${id}/compensation-history`).set(auth());
    expect(res.status).toBe(200);
    const list = (Array.isArray(res.body) ? res.body : res.body.items) as Array<{ baseSalary: number }>;
    expect(list.map((r) => r.baseSalary)).toEqual([24000, 20000]);
  });
});

describe('payroll history survives partial payment and reversal', () => {
  /** Funds the salary budget line this branch pays from. */
  function fundSalaryBudget(amount: number) {
    const lineId = `budget_teacher_salary_${BRANCH}`;
    db.prepare(
      `INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, category_id, payroll_target, branch_id)
       VALUES (?, 'Teacher Salaries', 0, 0, 'sub_salaries_wages', 'teacher', ?)`
    ).run(lineId, BRANCH);
    db.prepare('UPDATE budget_lines SET current_amount = current_amount + ? WHERE id = ?').run(amount, lineId);
  }

  it('a partial payment preserves the outstanding balance instead of settling the period', async () => {
    fundSalaryBudget(100000);
    const id = await hire(30000);

    const pay = await supertest(app).post(`/api/teachers/${id}/pay-salary`).set(auth())
      .send({ monthName: '1405-05', amountPaid: 20000, paymentType: 'partial' });
    expect(pay.status).toBe(201);

    // The academy still owes 10,000 — the entitlement was NOT rewritten to
    // match what was actually paid.
    expect(pay.body.due).toBe(30000);
    expect(pay.body.remainingAfter).toBe(10000);

    const status = await supertest(app).get(`/api/teachers/${id}/salary-status?monthName=1405-05`).set(auth());
    expect(status.body.due).toBe(30000);
    expect(status.body.paid).toBe(20000);
    expect(status.body.remaining).toBe(10000);
    expect(status.body.fullPaid).toBe(false);
  });

  it('voiding payroll keeps the original row and records who, when and why', async () => {
    fundSalaryBudget(100000);
    const id = await hire(30000);
    await supertest(app).post(`/api/teachers/${id}/pay-salary`).set(auth())
      .send({ monthName: '1405-06', amountPaid: 30000, paymentType: 'full' });

    const ledger = db.prepare(
      `SELECT id FROM teacher_salary_ledger WHERE teacher_id = ? AND period_key = '1405-06'`
    ).get(id) as { id: string };

    const res = await supertest(app).post(`/api/teachers/${id}/payroll/${ledger.id}/void`).set(auth())
      .send({ reason: 'Duplicate entry' });
    expect(res.status).toBe(200);

    const after = db.prepare(
      `SELECT status, paid_amount, void_reason, voided_at, voided_by FROM teacher_salary_ledger WHERE id = ?`
    ).get(ledger.id) as { status: string; paid_amount: number; void_reason: string; voided_at: string; voided_by: string } | undefined;

    // Catches a void implemented as DELETE.
    expect(after).toBeDefined();
    expect(after!.status).toBe('voided');
    expect(after!.paid_amount).toBe(30000);
    expect(after!.void_reason).toBe('Duplicate entry');
    expect(after!.voided_at).toBeTruthy();
    expect(after!.voided_by).toBeTruthy();
  });
});
