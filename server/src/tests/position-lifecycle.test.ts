/**
 * Position lifecycle, multi-position safety, three-owner model, female
 * reception separation, traceability and concurrency — gap-closure suite.
 * ============================================================================
 * 1. An Owner can create a custom position, edit its permissions, deactivate
 *    it (permissions stop flowing immediately), reactivate it, and the
 *    deactivation survives a boot catalog re-sync.
 * 2. A user can hold several positions; permissions combine; one position
 *    cannot expand another's data scope; removing a position removes its
 *    permissions immediately; inactive positions contribute nothing.
 * 3. Three Owner accounts are equivalent and can administer each other.
 * 4. Female Reception (reception function) collects payments that become
 *    authoritative income with position traceability, yet cannot budget,
 *    approve expenses or refund.
 * 5. Report totals reconcile with the underlying ledger.
 * 6. Audit records are append-only via the API.
 * 7. Receipt / invoice / student-code sequences are collision-safe under
 *    concurrent creation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { authRouter } from '../routes/auth.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { financeRouter } from '../routes/finance.routes.js';
import { securityRouter } from '../routes/security.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { auditRouter } from '../routes/audit.routes.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { usersRouter } from '../routes/users.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH_A = 'plc_branch_a';
const BRANCH_B = 'plc_branch_b';
const CAMPUS = 'plc_campus';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/users', usersRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'owner', branchId: overrides.branchId || BRANCH_A, fullName: 'PLC User',
    sessionVersion: overrides.sessionVersion ?? 1,
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let ownerA: TokenPayload;
let ownerB: TokenPayload;
let ownerC: TokenPayload;

async function seedUser(uid: string, uname: string, role: string, branch = BRANCH_A) {
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
    .run(uid, uname, 'PLC ' + role, role, branch, await hashPassword('x'));
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(CAMPUS, FIXED_ORG_ID, 'PLC Campus', 'PLC-C');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_A, 'PLC Branch A', 'Loc A', CAMPUS);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH_B, 'PLC Branch B', 'Loc B', CAMPUS);

  // Three owner accounts.
  await seedUser('u_plc_owner_a', 'plc_owner_a', 'owner');
  await seedUser('u_plc_owner_b', 'plc_owner_b', 'owner');
  await seedUser('u_plc_owner_c', 'plc_owner_c', 'owner');
  syncLegacyUserRoles(db);
  ownerA = makeUser({ userId: 'u_plc_owner_a', role: 'owner', branchId: BRANCH_A, username: 'plc_owner_a' });
  ownerB = makeUser({ userId: 'u_plc_owner_b', role: 'owner', branchId: BRANCH_A, username: 'plc_owner_b' });
  ownerC = makeUser({ userId: 'u_plc_owner_c', role: 'owner', branchId: BRANCH_A, username: 'plc_owner_c' });

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

describe('Position lifecycle (create / edit / activate / deactivate)', () => {
  let customRoleId = '';

  it('owner creates a custom position with permissions', async () => {
    const token = await freshOwnerToken(ownerA);
    const perms = db.prepare("SELECT id FROM permissions WHERE code IN ('Student.Export','Student.Print','Payment.Create','Payment.View')").all() as { id: string }[];
    const res = await supertest(app)
      .post('/api/security/roles')
      .set(authHeader({ ...ownerA, sessionVersion: 0 }))
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Female Receptionist',
        description: 'Reception desk — female section',
        permissions: perms.map((p) => ({ permissionId: p.id, scope: 'branch' })),
      });
    expect(res.status).toBe(201);
    expect(res.body.code).toContain('custom_');
    expect(res.body.isActive).toBe(true);
    customRoleId = res.body.id;
  });

  it('rejects a duplicate position name', async () => {
    const token = await freshOwnerToken(ownerA);
    const res = await supertest(app).post('/api/security/roles').set('Authorization', `Bearer ${token}`).send({ name: 'Female Receptionist' });
    expect(res.status).toBe(409);
  });

  it('assigning the position grants its permissions; deactivating removes them immediately', async () => {
    const token = await freshOwnerToken(ownerA);
    await seedUser('u_plc_fr', 'plc_fr', 'registrar'); // identity role: receptionist
    syncLegacyUserRoles(db);
    const assign = await supertest(app).post('/api/security/users/u_plc_fr/roles').set('Authorization', `Bearer ${token}`).send({ roleId: customRoleId, scopeType: 'branch', scopeId: BRANCH_A });
    expect(assign.status).toBe(201);

    // Effective permissions include the custom position's codes.
    const eff = await supertest(app).get('/api/security/users/u_plc_fr/effective-permissions').set('Authorization', `Bearer ${token}`);
    expect(eff.status).toBe(200);
    const codes = new Set(eff.body.map((p: { code: string }) => p.code));
    expect(codes.has('Student.Export')).toBe(true);
    expect(codes.has('Student.Print')).toBe(true);

    // Deactivate → permissions disappear immediately.
    const deact = await supertest(app).patch(`/api/security/roles/${customRoleId}`).set('Authorization', `Bearer ${token}`).send({ isActive: false });
    expect(deact.status).toBe(200);
    const eff2 = await supertest(app).get('/api/security/users/u_plc_fr/effective-permissions').set('Authorization', `Bearer ${token}`);
    const codes2 = new Set(eff2.body.map((p: { code: string }) => p.code));
    expect(codes2.has('Student.Export')).toBe(false);

    // Reactivate → permissions return.
    const react = await supertest(app).patch(`/api/security/roles/${customRoleId}`).set('Authorization', `Bearer ${token}`).send({ isActive: true });
    expect(react.status).toBe(200);
    const eff3 = await supertest(app).get('/api/security/users/u_plc_fr/effective-permissions').set('Authorization', `Bearer ${token}`);
    expect(new Set(eff3.body.map((p: { code: string }) => p.code)).has('Student.Export')).toBe(true);
  });

  it('deactivation survives a boot catalog re-sync (bootstrap preserves is_active)', async () => {
    const token = await freshOwnerToken(ownerA);
    await supertest(app).patch(`/api/security/roles/${customRoleId}`).set('Authorization', `Bearer ${token}`).send({ isActive: false });
    // Simulate process restart: catalog bootstrap + legacy role sync run again.
    bootstrapRbacCatalog(db);
    syncLegacyUserRoles(db);
    const row = db.prepare('SELECT is_active FROM roles WHERE id = ?').get(customRoleId) as { is_active: number };
    expect(row.is_active).toBe(0);
  });

  it('the Owner identity position cannot be deactivated', async () => {
    const token = await freshOwnerToken(ownerA);
    const ownerRole = db.prepare("SELECT id FROM roles WHERE code = 'owner'").get() as { id: string };
    const res = await supertest(app).patch(`/api/security/roles/${ownerRole.id}`).set('Authorization', `Bearer ${token}`).send({ isActive: false });
    expect(res.status).toBe(409);
  });

  it('non-owner cannot create positions', async () => {
    await seedUser('u_plc_mgr', 'plc_mgr', 'manager');
    syncLegacyUserRoles(db);
    const mgr = makeUser({ userId: 'u_plc_mgr', role: 'manager', branchId: BRANCH_A });
    const res = await supertest(app).post('/api/security/roles').set(authHeader(mgr)).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('Multiple positions — combine, scope, removal', () => {
  it('finance + reception combined; finance removal drops ledger access; scope stays branch-A', async () => {
    const token = await freshOwnerToken(ownerA);
    await seedUser('u_plc_multi', 'plc_multi', 'registrar');
    syncLegacyUserRoles(db);
    const finRole = db.prepare("SELECT id FROM roles WHERE code = 'finance_manager'").get() as { id: string };

    // Assign finance_manager (branch A) on top of receptionist (branch A).
    const assign = await supertest(app).post('/api/security/users/u_plc_multi/roles').set('Authorization', `Bearer ${token}`).send({ roleId: finRole.id, scopeType: 'branch', scopeId: BRANCH_A });
    expect(assign.status).toBe(201);
    const assignmentId = assign.body.id;

    // Combined: can read ledger (finance) and create students (reception).
    const eff = await supertest(app).get('/api/security/users/u_plc_multi/effective-permissions').set('Authorization', `Bearer ${token}`);
    const codes = new Set(eff.body.map((p: { code: string }) => p.code));
    expect(codes.has('Ledger.View')).toBe(true);
    expect(codes.has('Student.Create')).toBe(true);

    // The combined scope must NOT expand: finance(branch A) cannot read branch B students.
    const multi = makeUser({ userId: 'u_plc_multi', role: 'registrar', branchId: BRANCH_A });
    const multiTok = await freshOwnerToken(multi);
    const bStudent = await supertest(app)
      .post('/api/students/manual').set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'B Student', phone: '0799999000', gender: 'female', branchId: BRANCH_B });
    expect(bStudent.status).toBe(201);
    const readB = await supertest(app).get(`/api/students?branchId=${BRANCH_B}`).set('Authorization', `Bearer ${multiTok}`);
    expect(readB.body.some((s: { fullName: string }) => s.fullName === 'B Student')).toBe(false);

    // Remove finance position → Ledger.View disappears immediately.
    const remove = await supertest(app).delete(`/api/security/users/u_plc_multi/roles/${assignmentId}`).set('Authorization', `Bearer ${token}`);
    expect(remove.status).toBe(200);
    const eff2 = await supertest(app).get('/api/security/users/u_plc_multi/effective-permissions').set('Authorization', `Bearer ${token}`);
    expect(new Set(eff2.body.map((p: { code: string }) => p.code)).has('Ledger.View')).toBe(false);
    expect(new Set(eff2.body.map((p: { code: string }) => p.code)).has('Student.Create')).toBe(true);
  });
});

describe('Three-owner model', () => {
  it('all three owners have equivalent unrestricted access and can administer each other', async () => {
    for (const o of [ownerA, ownerB, ownerC]) {
      const tok = await freshOwnerToken(o);
      const me = await supertest(app).get('/api/auth/me').set('Authorization', `Bearer ${tok}`);
      expect(me.status).toBe(200);
      expect(me.body.role).toBe('owner');
      // Each can create another owner account and read the user list.
      const create = await supertest(app).post('/api/users').set('Authorization', `Bearer ${tok}`)
        .send({ username: `sub_owner_${o.userId.slice(-4)}`, tempPassword: 'Sub-Owner-2026-Pass!', fullName: 'Sub Owner', role: 'owner', branchId: BRANCH_A });
      expect(create.status).toBe(201);
      const list = await supertest(app).get('/api/users').set('Authorization', `Bearer ${tok}`);
      expect(list.status).toBe(200);
      expect(list.body.filter((u: { role: string }) => u.role === 'owner').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('owner accounts appear uniformly as "Owner" in the label mapping', async () => {
    // Frontend label source (config/roles.ts) maps owner -> "Owner"; the
    // RBAC catalog name is also "Owner" so the report position reads "Owner".
    const roleRow = db.prepare("SELECT name FROM roles WHERE code = 'owner'").get() as { name: string };
    expect(roleRow.name).toBe('Owner');
  });
});

describe('Female Reception separation + traceability', () => {
  let receptionist: TokenPayload;

  beforeAll(async () => {
    await seedUser('u_plc_recep', 'plc_recep', 'registrar');
    syncLegacyUserRoles(db);
    receptionist = makeUser({ userId: 'u_plc_recep', role: 'registrar', branchId: BRANCH_A });
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
    expect(row.operator_role).toBe('registrar');
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
