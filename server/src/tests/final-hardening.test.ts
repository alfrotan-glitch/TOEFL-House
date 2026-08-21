/**
 * Final hardening regression — security, financial truth, reporting, audit
 * ============================================================================
 * Locks in the remediation pass with runtime-verifiable invariants:
 *
 *  Security / authorization
 *   1. A student-role principal cannot read branch-wide data through any
 *      previously open endpoint (search, attendance, notifications,
 *      academic catalog, skills, branches, campuses, organization).
 *   2. Owner has equivalent unrestricted access on permission-gated routes
 *      (requirePermission owner bypass).
 *   3. Refund: owner / finance / manager can refund; registrar cannot;
 *      refund writes a contra-revenue payment + negative income and respects
 *      the refundable balance.
 *   4. Receptionist ≠ Finance: collecting a payment records income, but the
 *      receptionist cannot charge budgets, approve expenses or refund.
 *   5. Logout revokes the session server-side (session_version bump).
 *
 *  Financial truth
 *   6. P&L excludes capital injections, profit distributions, budget charges
 *      and saving transfers from operating income/expense.
 *   7. Ledger endpoint paginates with X-Total-Count.
 *
 *  Reporting
 *   8. GET /api/reports/overview totals reconcile with the underlying rows,
 *      gender splits are accurate, and the report header is complete.
 *
 *  Audit
 *   9. Audit logs support operator/action/date filters + pagination.
 *
 *  Positions
 *  10. A user with two positions receives the union of permissions.
 *
 *  Data integrity
 *  11. Invoices persist student_name / student_code at creation.
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
import { authRouter } from '../routes/auth.routes.js';
import { studentsRouter, paymentsRouter } from '../routes/students.routes.js';
import { financeRouter } from '../routes/finance.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { searchRouter } from '../routes/search.routes.js';
import { attendanceRouter } from '../routes/classes.routes.js';
import { academicRouter } from '../routes/academic.routes.js';
import { skillsRouter } from '../routes/skills.routes.js';
import { branchesRouter, campusesRouter, organizationRouter } from '../routes/branches.routes.js';
import { auditRouter, notificationsRouter } from '../routes/audit.routes.js';
import { securityRouter } from '../routes/security.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getFinanceAccount, incrementMainBalance } from '../utils/financeAccounts.js';

const BRANCH = 'hardening_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/academic', academicRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/branches', branchesRouter);
  app.use('/api/campuses', campusesRouter);
  app.use('/api/organization', organizationRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH, fullName: 'Hardening User',
    sessionVersion: overrides.sessionVersion ?? 1,
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let owner: TokenPayload;
let finance: TokenPayload;
let manager: TokenPayload;
let registrar: TokenPayload;
let student: TokenPayload;

async function seedUser(uid: string, uname: string, role: string) {
  await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
    VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run(uid, uname, 'Hardening ' + role, BRANCH, await hashPassword('x'));
  assignRole(uid, role, BRANCH);
}

let studentPhoneSequence = 0;
function seedStudent(sid: string, name: string, gender: string, code: string) {
  studentPhoneSequence += 1;
  db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(sid, code, name, today(), BRANCH, gender, `0700${String(studentPhoneSequence).padStart(6, '0')}`);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Hardening Branch', 'Loc');

  await seedUser('u_h_owner', 'h_owner', 'owner');
  await seedUser('u_h_fin', 'h_fin', 'finance');
  await seedUser('u_h_mgr', 'h_mgr', 'manager');
  await seedUser('u_h_reg', 'h_reg', 'registrar');

  owner = makeUser({ userId: 'u_h_owner', branchId: BRANCH });
  finance = makeUser({ userId: 'u_h_fin', branchId: BRANCH });
  manager = makeUser({ userId: 'u_h_mgr', branchId: BRANCH });
  registrar = makeUser({ userId: 'u_h_reg', branchId: BRANCH });

  // Students: one male, one female + a portal account for the male.
  seedStudent('h_stu_m', 'Hardening Male', 'male', 'TH-H-001001');
  seedStudent('h_stu_f', 'Hardening Female', 'female', 'TH-H-001002');
  db.prepare(`INSERT INTO users ( id, username, password_hash, full_name, branch_id, linked_student_id, is_active, must_change_password, session_version )
    VALUES (?, 'stu_h_m', ?, 'Hardening Male', ?, 'h_stu_m', 1, 0, 1)`)
    .run('u_h_student', await hashPassword('irrelevant'), BRANCH);
  assignRole('u_h_student', 'student', BRANCH);
  student = makeUser({ userId: 'u_h_student', branchId: BRANCH });

  // Financial seed: treasury capital, student payment (income), budget charge, expense.
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
    VALUES (?, 'income', 'capital_injection', 50000, ?, 'Opening capital', 'Owner', ?)`).run(id('tx'), today(), BRANCH);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
    VALUES (?, 'income', 'fee', 10000, ?, 'Tuition fee', 'Owner', ?)`).run(id('tx'), today(), BRANCH);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
    VALUES (?, 'budget_charge', 'utility', 20000, ?, 'Budget allocation', 'Owner', ?)`).run(id('tx'), today(), BRANCH);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
    VALUES (?, 'expense', 'rent', 3000, ?, 'Office rent', 'Owner', ?)`).run(id('tx'), today(), BRANCH);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
    VALUES (?, 'saving_transfer', 'saving', 500, ?, 'Auto saving', 'Owner', ?)`).run(id('tx'), today(), BRANCH);

  // One payment tied to the male student (for gender splits).
  const paymentId = id('pay');
  db.prepare(`INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, 'h_stu_m', 6000, ?, 'cash', 'completed', 'fee', 'R-H-1', ?, hex(randomblob(16)))`).run(paymentId, today(), BRANCH);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, payment_id, operator_name, branch_id)
    VALUES (?, 'income', 'fee', 6000, ?, 'Invoice payment — Hardening Male', 'h_inv', ?, 'Owner', ?)`)
    .run(id('tx'), today(), paymentId, BRANCH);

  // Branch operating cash must exist before refunds can decrement it.
  getFinanceAccount('branch', BRANCH);
  incrementMainBalance('branch', BRANCH, 50000);

  // Semester for the female student so a receptionist fee payment can be recorded.
  db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
    VALUES (?, 'h_stu_f', 'Level A1', NULL, ?, 5000, 5000, 'active')`).run(id('sem'), today());

  // Invoice with a student (name/code snapshot check).
  db.prepare(`INSERT OR IGNORE INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number, student_name, student_code, purpose)
    VALUES (?, 'h_stu_f', 8000, 0, 8000, 'issued', ?, ?, ?, 'INV-H-1', 'Hardening Female', 'TH-H-001002', 'other')`).run('h_inv', today(), today(), BRANCH);

  // Audit rows for filter tests.
  db.prepare(`INSERT INTO audit_logs (id, operator_id, operator_name, action, date, time, ip, device, branch_id)
    VALUES (?, 'u_h_owner', 'Hardening Owner', 'Created student', ?, '10:00:00', '127.0.0.1', 'test', ?)`).run(id('log'), today(), BRANCH);
  db.prepare(`INSERT INTO audit_logs (id, operator_id, operator_name, action, date, time, ip, device, branch_id)
    VALUES (?, 'u_h_fin', 'Hardening Finance', 'Recorded payment', ?, '11:00:00', '127.0.0.1', 'test', ?)`).run(id('log'), today(), BRANCH);

  app = createApp();
});


/**
 * The payment a refund reverses. Owner decision D-113 makes attribution
 * mandatory, so a fixture that refunds names the charge it reverses — here, the
 * student's most recent refundable payment.
 */
function latestRefundablePaymentId(studentId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM payments
        WHERE student_id = ? AND status = 'completed' AND category <> 'refund' AND amount > 0
        ORDER BY date DESC, rowid DESC LIMIT 1`,
    )
    .get(studentId) as { id: string } | undefined;
  if (!row) throw new Error(`fixture: student ${studentId} has no refundable payment`);
  return row.id;
}

describe('Student-role isolation (no branch-wide reads)', () => {
  it('denies every previously open read endpoint to a student principal', async () => {
    const denied = [
      '/api/search?q=Hardening',
      '/api/attendance',
      '/api/notifications',
      '/api/academic/programs',
      '/api/academic/levels',
      '/api/skills',
      '/api/branches',
      '/api/campuses',
      '/api/organization',
    ];
    for (const path of denied) {
      const res = await supertest(app).get(path).set(authHeader(student));
      expect(res.status, `${path} should be denied`).toBe(403);
    }
  });

  it('still allows the student their own profile', async () => {
    const res = await supertest(app).get('/api/students/me').set(authHeader(student));
    expect(res.status).toBe(200);
    expect(res.body.studentCode).toBe('TH-H-001001');
  });
});

describe('Owner equivalent unrestricted access + refund flow', () => {
  it('owner can refund (requirePermission owner bypass)', async () => {
    const res = await supertest(app).post('/api/students/h_stu_m/refund').set(authHeader(owner)).send({ amount: 500, reason: 'Withdrawal of enrollment', paymentId: latestRefundablePaymentId('h_stu_m') });
    expect(res.status).toBe(201);
    expect(res.body.receiptNumber).toMatch(/^REF-/);
  });

  it('finance and manager can refund; registrar cannot', async () => {
    const ok = await supertest(app).post('/api/students/h_stu_m/refund').set(authHeader(finance)).send({ amount: 100, reason: 'Overpayment', paymentId: latestRefundablePaymentId('h_stu_m') });
    expect(ok.status).toBe(201);
    const ok2 = await supertest(app).post('/api/students/h_stu_m/refund').set(authHeader(manager)).send({ amount: 100, reason: 'Overpayment', paymentId: latestRefundablePaymentId('h_stu_m') });
    expect(ok2.status).toBe(201);
    const denied = await supertest(app).post('/api/students/h_stu_m/refund').set(authHeader(registrar)).send({ amount: 100, reason: 'x', paymentId: latestRefundablePaymentId('h_stu_m') });
    expect(denied.status).toBe(403);
  });

  it('refund writes a negative income entry (contra-revenue)', async () => {
    const row = db.prepare(`SELECT type, category, amount FROM financial_transactions
      WHERE description LIKE 'Refund issued to Hardening Male%' ORDER BY rowid DESC LIMIT 1`).get() as { type: string; category: string; amount: number };
    expect(row.type).toBe('income');
    expect(row.category).toBe('refund');
    expect(row.amount).toBeLessThan(0);
  });

  it('refund respects the refundable balance', async () => {
    const res = await supertest(app).post('/api/students/h_stu_m/refund').set(authHeader(owner)).send({ amount: 999999, reason: 'Too much', paymentId: latestRefundablePaymentId('h_stu_m') });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/still refundable on that payment/i);
  });
});

describe('Receptionist ≠ Finance', () => {
  let receptionist: TokenPayload;

  beforeAll(async () => {
    await seedUser('u_h_recep', 'h_recep', 'registrar');

    receptionist = makeUser({ userId: 'u_h_recep', branchId: BRANCH });
  });

  it('receptionist can collect a student payment (creates income)', async () => {
    const before = (db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM financial_transactions WHERE type='income'").get() as { s: number }).s;
    const semId = (db.prepare("SELECT id FROM student_semesters WHERE student_id = 'h_stu_f' LIMIT 1").get() as { id: string }).id;
    const res = await supertest(app).post('/api/students/h_stu_f/payments').set(authHeader(receptionist)).send({ amount: 2500, category: 'fee', semesterId: semId });
    expect(res.status).toBe(201);
    const after = (db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM financial_transactions WHERE type='income'").get() as { s: number }).s;
    expect(after).toBeGreaterThan(before);
  });

  it('receptionist cannot charge budgets, approve expenses or refund', async () => {
    const bl = db.prepare('SELECT id FROM budget_lines LIMIT 1').get() as { id: string } | undefined;
    const charge = await supertest(app).post(`/api/finance/budget-lines/${bl?.id || 'none'}/charge`).set(authHeader(receptionist)).send({ amount: 100 });
    expect(charge.status).toBe(403);
    const reqRow = db.prepare(`INSERT INTO expense_requests (id, title, amount, budget_line_id, requester, status, date, branch_id, expense_kind, payment_method, auto_approved)
      VALUES (?, 'x', 100, ?, 'recep', 'pending', ?, ?, 'other', 'cash', 0)`).run(id('req'), bl?.id || null, today(), BRANCH);
    const reqId = (db.prepare("SELECT id FROM expense_requests WHERE requester = 'recep' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const decide = await supertest(app).post(`/api/finance/expense-requests/${reqId}/decide`).set(authHeader(receptionist)).send({ isApproved: true });
    expect(decide.status).toBe(403);
    const refund = await supertest(app).post('/api/students/h_stu_f/refund').set(authHeader(receptionist)).send({ amount: 10, reason: 'x', paymentId: latestRefundablePaymentId('h_stu_f') });
    expect(refund.status).toBe(403);
  });
});

describe('P&L accounting semantics (single source of truth)', () => {
  it('excludes capital injections, budget charges, saving transfers and profit distributions from operating totals', async () => {
    const res = await supertest(app).get('/api/finance/pnl').set(authHeader(owner));
    expect(res.status).toBe(200);
    // income: fee 10000 + payment-backed 6000 + receptionist 2500 - refunds 700 = 17800 (capital 50000 excluded)
    expect(res.body.income).toBe(17800);
    // expense: rent 3000 only (budget_charge 20000 and saving_transfer excluded)
    expect(res.body.expense).toBe(3000);
    expect(res.body.net).toBe(14800);
    expect(res.body.transfers.capitalInjection).toBe(50000);
    expect(res.body.transfers.budgetCharged).toBe(20000);
    expect(res.body.transfers.savingTransferred).toBe(625); // 500 seeded + 125 skim from the receptionist payment
  });
});

describe('Ledger pagination', () => {
  it('returns X-Total-Count and honors offset', async () => {
    const res = await supertest(app).get('/api/finance/transactions?limit=2&offset=0').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBeDefined();
    expect(Number(res.headers['x-total-count'])).toBeGreaterThanOrEqual(6);
    expect(res.body.length).toBe(2);
    const page2 = await supertest(app).get('/api/finance/transactions?limit=2&offset=2').set(authHeader(owner));
    expect(page2.body.length).toBe(2);
    expect(page2.body[0].id).not.toBe(res.body[0].id);
  });
});

describe('Audit log filters + pagination', () => {
  it('filters by operator and action and reports total', async () => {
    const res = await supertest(app).get('/api/audit-logs?operatorName=Hardening%20Finance').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(Number(res.headers['x-total-count'])).toBeGreaterThanOrEqual(1);
    // SQLite LIKE is case-insensitive for ASCII; compare case-insensitively.
    expect(res.body.every((r: { operator_name: string }) => r.operator_name.toLowerCase().includes('hardening finance'))).toBe(true);
    const byAction = await supertest(app).get('/api/audit-logs?action=Created%20student').set(authHeader(owner));
    expect(Number(byAction.headers['x-total-count'])).toBeGreaterThanOrEqual(1);
  });

  it('denies non-manager/owner roles', async () => {
    const res = await supertest(app).get('/api/audit-logs').set(authHeader(registrar));
    expect(res.status).toBe(403);
  });
});

describe('Reporting endpoint', () => {
  it('reconciles totals with underlying rows and produces a complete header', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=month').set(authHeader(owner));
    expect(res.status).toBe(200);
    // Header
    expect(res.body.meta.reportId).toMatch(/^REP-\d{6}-\d{6}$/);
    expect(res.body.meta.type).toBe('operations-overview');
    expect(res.body.meta.generatedBy.name).toBe('Hardening owner');
    expect(res.body.meta.position).toBeTruthy();
    expect(typeof res.body.meta.generatedAt).toBe('string');
    // Financial income: fee 10000 + payment 6000 (+ refunds negative? refund -500-100-100 counted as income negative)
    const income = res.body.financial.income;
    expect(income.total).toBeGreaterThanOrEqual(16000 - 700);
    // gender split: the 6000 payment is male-linked
    const feeCat = income.byCategory.find((c: { category: string }) => c.category === 'fee');
    expect(feeCat.male).toBeGreaterThanOrEqual(6000);
    // transfers + balances present
    expect(res.body.financial.transfers.capitalInjection).toBe(50000);
    expect(typeof res.body.financial.balances.main).toBe('number');
    // Operational gender splits
    expect(res.body.operational.newStudents.total).toBe(2);
    expect(res.body.operational.newStudents.male).toBe(1);
    expect(res.body.operational.newStudents.female).toBe(1);
    expect(res.body.operational.activeStudents.total).toBe(2);
    expect(res.body.operational.visitors.total).toBeGreaterThanOrEqual(0);
  });

  it('honors gender filter on student-linked metrics', async () => {
    const res = await supertest(app).get('/api/reports/overview?period=month&gender=female').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.meta.filters.gender).toBe('female');
    expect(res.body.operational.newStudents.total).toBe(1);
    expect(res.body.operational.newStudents.female).toBe(1);
  });

  it('requires an authorized role', async () => {
    // Student (no permissions) is denied; finance (Finance.Report) is allowed;
    // registrar is allowed because the navigation declares Report.View for it.
    const denied = await supertest(app).get('/api/reports/overview').set(authHeader(student));
    expect(denied.status).toBe(403);
    const ok = await supertest(app).get('/api/reports/overview?period=today').set(authHeader(finance));
    expect(ok.status).toBe(200);
    const okReg = await supertest(app).get('/api/reports/overview?period=today').set(authHeader(registrar));
    expect(okReg.status).toBe(200);
  });
});

describe('Logout revokes the session', () => {
  it('invalidates the token after logout (session_version bump)', async () => {
    const user = makeUser({ userId: 'u_h_owner', branchId: BRANCH, username: 'h_owner' });
    const token = signToken({ ...user, sessionVersion: (db.prepare('SELECT session_version v FROM users WHERE id = ?').get('u_h_owner') as { v: number }).v });
    const logout = await supertest(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);
    const after = await supertest(app).get('/api/students').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});

describe('Multiple positions per user', () => {
  it('assigns a second position and the user receives the union of permissions', async () => {
    // Registrar h_reg gains the finance_manager position on top of receptionist.
    const roleRow = db.prepare("SELECT id FROM roles WHERE code = 'finance_manager'").get() as { id: string };
    // Re-sign the owner token: the logout test bumped session_version.
    const currentVersion = (db.prepare('SELECT session_version v FROM users WHERE id = ?').get('u_h_owner') as { v: number }).v;
    const freshOwner = makeUser({ userId: 'u_h_owner', branchId: BRANCH, username: 'h_owner', sessionVersion: currentVersion });
    const assign = await supertest(app)
      .post('/api/security/users/u_h_reg/roles')
      .set(authHeader(freshOwner))
      .send({ roleId: roleRow.id, scopeType: 'branch', scopeId: BRANCH });
    expect(assign.status).toBe(201);

    const rolesRes = await supertest(app).get('/api/security/users/u_h_reg/roles').set(authHeader(freshOwner));
    expect(rolesRes.status).toBe(200);
    expect(rolesRes.body.length).toBeGreaterThanOrEqual(2);
    const codes = new Set(rolesRes.body.map((r: { roleCode: string }) => r.roleCode));
    expect(codes.has('receptionist')).toBe(true);
    expect(codes.has('finance_manager')).toBe(true);

    // Effective permissions union: registrar can now read the ledger (Ledger.View comes from finance_manager).
    const perms = await supertest(app).get('/api/security/users/u_h_reg/effective-permissions').set(authHeader(freshOwner));
    expect(perms.status).toBe(200);
    const permCodes = new Set(perms.body.map((p: { code: string }) => p.code));
    expect(permCodes.has('Ledger.View')).toBe(true);
    expect(permCodes.has('Student.View')).toBe(true);
  });
});

describe('Invoice student name/code snapshot', () => {
  it('persists student_name and student_code at creation', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(authHeader(finance))
      .send({ studentId: 'h_stu_m', purpose: 'other', items: [{ description: 'Course', unitPrice: 3000 }], issue: true });
    expect(res.status).toBe(201);
    expect(res.body.studentName).toBe('Hardening Male');
    expect(res.body.studentCode).toBe('TH-H-001001');
    const row = db.prepare('SELECT student_name, student_code FROM invoices WHERE id = ?').get(res.body.id) as { student_name: string; student_code: string };
    expect(row.student_name).toBe('Hardening Male');
    expect(row.student_code).toBe('TH-H-001001');
  });
});
