import { beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import { studentsRouter, paymentsRouter } from '../../../routes/students.routes.js';
import { invoicesRouter } from '../../../routes/invoices.routes.js';
import { financeRouter } from '../../../routes/finance.routes.js';
import { writeAudit } from '../../../middleware/audit.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const CAMPUS = 'wp01_dep_campus';
const BRANCH_A = 'wp01_dep_branch_a';
const BRANCH_B = 'wp01_dep_branch_b';
const MANAGER_A = 'wp01_dep_manager_a';
const MANAGER_B = 'wp01_dep_manager_b';
const OWNER = 'wp01_dep_owner';
const STUDENT_A = 'wp01_dep_student_a';
const STUDENT_B = 'wp01_dep_student_b';
const B_INCOME = 87321;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
  return app;
}

function fakeRequest(overrides: Partial<Request> & { user?: unknown }): Request {
  return {
    body: {}, query: {}, headers: {}, ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

let http: ReturnType<typeof supertest>;
const as = (userId: string) => bearerFor(userId);

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(
    `INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active)
     VALUES (?, 'org_toefl_house', 'WP-01 Dependents', 'WP01-DEP', 1)`,
  ).run(CAMPUS);
  for (const id of [BRANCH_A, BRANCH_B]) {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, campus_id, name, code, location, is_active)
       VALUES (?, ?, ?, ?, 'Kabul', 1)`,
    ).run(id, CAMPUS, id, `CODE-${id}`);
  }
  seedUser({ id: MANAGER_A, role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: MANAGER_B, role: 'general_manager', branchId: BRANCH_B });
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH_A });

  for (const [id, code, name, phone, branch] of [
    [STUDENT_A, 'WP01-A', 'WP01 Alpha Student', '0700550001', BRANCH_A],
    [STUDENT_B, 'WP01-B', 'WP01 Beta Student', '0700550002', BRANCH_B],
  ]) {
    db.prepare(
      `INSERT OR IGNORE INTO students
         (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
       VALUES (?, ?, ?, 'male', ?, 'active', '2031-01-01', ?)`,
    ).run(id, code, name, phone, branch);
  }
  db.prepare(
    `INSERT OR REPLACE INTO payments
       (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES ('wp01_dep_payment_a', ?, 12345, '2031-01-01', 'cash', 'completed', 'fee', 'WP01-RA', ?, 'wp01-dep-a')`,
  ).run(STUDENT_A, BRANCH_A);
  db.prepare(
    `INSERT OR REPLACE INTO payments
       (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES ('wp01_dep_payment_b', ?, 67890, '2031-01-01', 'cash', 'completed', 'fee', 'WP01-RB', ?, 'wp01-dep-b')`,
  ).run(STUDENT_B, BRANCH_B);
  db.prepare(
    `INSERT OR REPLACE INTO financial_transactions
       (id, type, category, amount, date, description, branch_id)
     VALUES ('wp01_dep_income_a', 'income', 'fee', 14321, '2031-01-01', 'A income', ?)`,
  ).run(BRANCH_A);
  db.prepare(
    `INSERT OR REPLACE INTO financial_transactions
       (id, type, category, amount, date, description, branch_id)
     VALUES ('wp01_dep_income_b', 'income', 'fee', ?, '2031-01-01', 'B income', ?)`,
  ).run(B_INCOME, BRANCH_B);

  http = supertest(makeApp());
});

describe('WP-01 branch selection cannot widen dependent HTTP consumers', () => {
  it('filters student and payment collections to the assigned branch', async () => {
    const students = await http.get('/api/students').set(as(MANAGER_A));
    expect(students.status).toBe(200);
    expect(JSON.stringify(students.body)).toContain('WP01 Alpha Student');
    expect(JSON.stringify(students.body)).not.toContain('WP01 Beta Student');

    const payments = await http.get('/api/payments').set(as(MANAGER_A));
    expect(payments.status).toBe(200);
    expect(JSON.stringify(payments.body)).toContain('12345');
    expect(JSON.stringify(payments.body)).not.toContain('67890');
  });

  it('does not honor an unauthorized branch query parameter', async () => {
    const response = await http.get(`/api/payments?branchId=${BRANCH_B}`).set(as(MANAGER_A));
    if (response.status === 200) expect(JSON.stringify(response.body)).not.toContain('67890');
    else expect([400, 403]).toContain(response.status);
  });

  it('denies foreign object reads and leaves foreign money unchanged', async () => {
    expect([403, 404]).toContain((await http.get(`/api/students/${STUDENT_B}`).set(as(MANAGER_A))).status);
    const before = (db.prepare('SELECT COUNT(*) c FROM payments WHERE student_id = ?').get(STUDENT_B) as { c: number }).c;
    const response = await http.post(`/api/students/${STUDENT_B}/payments`).set(as(MANAGER_A))
      .send({ amount: 500, category: 'other', notes: 'cross-branch attack' });
    expect([403, 404]).toContain(response.status);
    expect((db.prepare('SELECT COUNT(*) c FROM payments WHERE student_id = ?').get(STUDENT_B) as { c: number }).c).toBe(before);
  });

  it('denies invoicing a student in another branch', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM invoices WHERE student_id = ?').get(STUDENT_B) as { c: number }).c;
    const response = await http.post('/api/invoices').set(as(MANAGER_A)).send({
      studentId: STUDENT_B,
      items: [{ description: 'cross-branch attack', quantity: 1, unitPrice: 100 }],
    });
    expect([403, 404]).toContain(response.status);
    expect((db.prepare('SELECT COUNT(*) c FROM invoices WHERE student_id = ?').get(STUDENT_B) as { c: number }).c).toBe(before);
  });

  it('keeps dashboard aggregates branch-scoped despite a forged branch query', async () => {
    const own = await http.get('/api/finance/dashboard').set(as(MANAGER_A));
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(String(B_INCOME));

    const forged = await http.get(`/api/finance/dashboard?branchId=${BRANCH_B}`).set(as(MANAGER_A));
    if (forged.status === 200) expect(JSON.stringify(forged.body)).not.toContain(String(B_INCOME));
    else expect([400, 403]).toContain(forged.status);
  });
});

describe('WP-01 audit attribution follows the authorized target branch', () => {
  const lastBranch = (action: string) =>
    (db.prepare('SELECT branch_id FROM audit_logs WHERE action = ? ORDER BY rowid DESC LIMIT 1').get(action) as { branch_id: string }).branch_id;

  it('uses an authorized target in the body or query rather than owner home branch', () => {
    const bodyAction = 'wp01 audit body target';
    const queryAction = 'wp01 audit query target';
    const owner = { userId: OWNER, username: OWNER, fullName: OWNER, branchId: BRANCH_A };
    writeAudit(fakeRequest({ user: owner, body: { branchId: BRANCH_B } }), bodyAction);
    writeAudit(fakeRequest({ user: owner, query: { branchId: BRANCH_B } as never }), queryAction);
    expect(lastBranch(bodyAction)).toBe(BRANCH_B);
    expect(lastBranch(queryAction)).toBe(BRANCH_B);
  });

  it('treats all as a selector, never as an attributable branch', () => {
    const action = 'wp01 audit all selector';
    const owner = { userId: OWNER, username: OWNER, fullName: OWNER, branchId: BRANCH_A };
    writeAudit(fakeRequest({ user: owner, query: { branchId: 'all' } as never }), action);
    expect(lastBranch(action)).toBe(BRANCH_A);
  });

  it('refuses forged target attribution by a branch-scoped principal', () => {
    const action = 'wp01 audit forged target';
    const manager = { userId: MANAGER_A, username: MANAGER_A, fullName: MANAGER_A, branchId: BRANCH_A };
    writeAudit(fakeRequest({ user: manager, body: { branchId: BRANCH_B } }), action);
    expect(lastBranch(action)).toBe(BRANCH_A);
  });
});
