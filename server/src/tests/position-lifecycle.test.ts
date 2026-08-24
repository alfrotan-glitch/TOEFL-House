/**
 * Downstream contracts that couple a receptionist position to financial
 * traceability, reports, immutable audit records, and collision-safe IDs.
 * Identity and position lifecycle authority lives in the WP-02 package suites.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { financeRouter } from '../routes/finance.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { auditRouter } from '../routes/audit.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH_A = 'plc_branch_a';
const CAMPUS = 'plc_campus';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH_A, fullName: 'PLC User',
    sessionVersion: overrides.sessionVersion ?? 1,
  };
}

let app: express.Express;
let ownerA: TokenPayload;

async function seedUser(uid: string, uname: string, role: string, branch = BRANCH_A) {
  await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
    VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run(uid, uname, 'PLC ' + role, branch, await hashPassword('x'));
  assignRole(uid, role, branch);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(CAMPUS, FIXED_ORG_ID, 'PLC Campus', 'PLC-C');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_A, 'PLC Branch A', 'Loc A', CAMPUS);
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('plc_registration_fee', ?, 'registration', 'Registration fee', 0, 1, 1)
  `).run(BRANCH_A);

  // Three owner accounts.
  await seedUser('u_plc_owner_a', 'plc_owner_a', 'owner');

  ownerA = makeUser({ userId: 'u_plc_owner_a', branchId: BRANCH_A, username: 'plc_owner_a' });

  // Students + branch cash for payments.
  db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
    VALUES (?, 'TH-PLC-1', 'PLC Student', 'active', ?, ?, 'male', ?)`).run('plc_stu', today(), BRANCH_A, '0700000999');
  db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
    VALUES (?, 'plc_stu', 'Level A1', NULL, ?, 6000, 6000, 'active')`).run(id('sem'), today());
  const { getFinanceAccount, incrementMainBalance } = await import('../utils/financeAccounts.js');
  getFinanceAccount('branch', BRANCH_A);
  incrementMainBalance('branch', BRANCH_A, 50000);

  app = createApp();
});

async function freshOwnerToken(user: TokenPayload): Promise<string> {
  const v = (db.prepare('SELECT session_version v FROM users WHERE id = ?').get(user.userId) as { v: number }).v;
  return signToken({ ...user, sessionVersion: v });
}

// Identity/position lifecycle assertions moved to the WP-02 package suites.
// The remaining cases preserve downstream finance, audit, and identifier contracts.

describe('Female Reception separation + traceability', () => {
  let receptionist: TokenPayload;

  beforeAll(async () => {
    await seedUser('u_plc_recep', 'plc_recep', 'registrar');

    receptionist = makeUser({ userId: 'u_plc_recep', branchId: BRANCH_A });
  });

  it('reception collects a payment → income with position traceability (operator_role)', async () => {
    const tok = await freshOwnerToken(receptionist);
    const semId = (db.prepare("SELECT id FROM student_semesters WHERE student_id='plc_stu' LIMIT 1").get() as { id: string }).id;
    const res = await supertest(app).post('/api/students/plc_stu/payments').set('Authorization', `Bearer ${tok}`)
      .send({ amount: 2000, category: 'fee', semesterId: semId });
    expect(res.status).toBe(201);
    const row = db.prepare(`SELECT operator_name, operator_role, branch_id, amount, category FROM financial_transactions
      WHERE payment_id IS NOT NULL AND type='income' ORDER BY rowid DESC LIMIT 1`).get() as {
      operator_name: string; operator_role: string | null; branch_id: string; amount: number; category: string;
    };
    expect(row.operator_name).toBe('PLC registrar');
    expect(row.operator_role).toBe('receptionist');
    expect(row.branch_id).toBe(BRANCH_A);
    expect(row.amount).toBe(2000);
    expect(row.category).toBe('fee');
  });

  it('reception cannot budget, approve expenses or refund (no URL escalation)', async () => {
    const tok = await freshOwnerToken(receptionist);
    const bl = db.prepare('SELECT id FROM budget_lines LIMIT 1').get() as { id: string } | undefined;
    const charge = await supertest(app).post(`/api/finance/budget-lines/${bl?.id || 'none'}/charge`).set('Authorization', `Bearer ${tok}`).send({ amount: 100 });
    expect(charge.status).toBe(403);
    const refund = await supertest(app).post('/api/students/plc_stu/refund').set('Authorization', `Bearer ${tok}`).send({ amount: 10, reason: 'x' });
    expect(refund.status).toBe(403);
    const approve = await supertest(app).post('/api/finance/expense-requests/none/decide').set('Authorization', `Bearer ${tok}`).send({ isApproved: true });
    expect(approve.status).toBe(403);
    // And it cannot read the ledger or budget lines.
    const ledger = await supertest(app).get('/api/finance/transactions').set('Authorization', `Bearer ${tok}`);
    expect(ledger.status).toBe(403);
    const budgets = await supertest(app).get('/api/finance/budget-lines').set('Authorization', `Bearer ${tok}`);
    expect(budgets.status).toBe(403);
  });
});

describe('Report ↔ ledger reconciliation', () => {
  it('report operating income equals the ledger income for the period (excluding capital/transfers)', async () => {
    const tok = await freshOwnerToken(ownerA);
    const report = await supertest(app).get('/api/reports/overview?period=month').set('Authorization', `Bearer ${tok}`);
    expect(report.status).toBe(200);
    const repIncome = report.body.financial.income.total;
    const ledger = db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS s FROM financial_transactions
      WHERE type = 'income' AND category != 'capital_injection'
        AND date >= ? AND date <= ? AND branch_id = ?
    `).get(`${today().slice(0, 7)}-01`, today(), BRANCH_A) as { s: number };
    expect(repIncome).toBe(Number(ledger.s));
  });
});

describe('Audit append-only', () => {
  it('no API route mutates or deletes audit records', async () => {
    const tok = await freshOwnerToken(ownerA);
    const before = (db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
    // Attempt delete/patch on audit logs (no such routes → 404, nothing changes).
    const del = await supertest(app).delete('/api/audit-logs/some-id').set('Authorization', `Bearer ${tok}`);
    expect([404, 403]).toContain(del.status);
    const patch = await supertest(app).patch('/api/audit-logs/some-id').set('Authorization', `Bearer ${tok}`).send({ action: 'x' });
    expect([404, 403]).toContain(patch.status);
    const after = (db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('Concurrent identifier uniqueness', () => {
  it('receipt, invoice and student-code sequences never collide under concurrency', async () => {
    const tok = await freshOwnerToken(ownerA);
    const { nextReceiptNumber } = await import('../utils/receipt.js');
    const { nextInvoiceNumber } = await import('../utils/invoice.js');
    const { nextStudentCode } = await import('../utils/receipt.js');

    // Concurrent receipt generation through the atomic counter.
    const receipts = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => nextReceiptNumber())));
    expect(new Set(receipts).size).toBe(50);

    const invoices = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => nextInvoiceNumber(BRANCH_A))));
    expect(new Set(invoices).size).toBe(50);

    const codes = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => nextStudentCode())));
    expect(new Set(codes).size).toBe(50);

    // Concurrent student registration via API produces unique student codes.
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      supertest(app).post('/api/students/manual').set('Authorization', `Bearer ${tok}`)
        .send({ fullName: `Concurrent ${i}`, phone: `0701${String(30000000 + i)}`, gender: 'male', branchId: BRANCH_A })
    ));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const codesInDb = db.prepare(`SELECT student_code FROM students WHERE full_name LIKE 'Concurrent %'`).all() as { student_code: string }[];
    expect(new Set(codesInDb.map((r) => r.student_code)).size).toBe(10);
  });

  it('concurrent payments + refunds stay within the refundable balance (no double spend)', async () => {
    const tok = await freshOwnerToken(ownerA);
    const attempts = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      supertest(app).post('/api/students/plc_stu/refund').set('Authorization', `Bearer ${tok}`)
        .send({ amount: 100, reason: `race ${i}` })
    ));
    const ok = attempts.filter((r) => r.status === 201).length;
    const totalRefunded = (db.prepare(`SELECT COALESCE(SUM(-amount),0) AS s FROM payments WHERE student_id='plc_stu' AND category='refund'`).get() as { s: number }).s;
    const totalPaid = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id='plc_stu' AND status='completed' AND category!='refund'`).get() as { s: number }).s;
    // No double spend: refunds may never exceed the amount actually paid, and
    // every accepted refund wrote exactly its amount (no partial writes).
    expect(totalRefunded).toBeLessThanOrEqual(totalPaid);
    expect(totalRefunded).toBe(ok * 100);
    expect(ok).toBeLessThanOrEqual(15);
  });
});
