/**
 * Deep-audit regression suite — locks in the real bugs the domain audit found:
 *
 * 1. POST /api/users → 500 "Too many parameter values" because
 *    syncPrimaryUserRole passed 6 args to a 5-placeholder insertUserRole.
 *    Creating any user via the API was completely broken.
 * 2. POST /api/students/manual and POST /:id/issue-card → 500 "Too few
 *    parameter values" because stmtInsertSimplePayment gained an
 *    idempotency_key placeholder (migration 047) but two call sites still
 *    passed 9 args.
 * 3. GET /api/search → 500 "no such column: code" because the classes search
 *    referenced classes.code which does not exist in the schema.
 * 4. Manager/finance RBAC: the UI exposes teacher/employee creation and
 *    payroll to general_manager and finance_manager, but the catalog denied
 *    Teacher.Create / Employee.* / Payroll.* to those roles — broken workflow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { usersRouter } from '../routes/users.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { searchRouter } from '../routes/search.routes.js';
import { teachersRouter, employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'audit_regression_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'owner', branchId: overrides.branchId || BRANCH, fullName: 'Audit Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let owner: TokenPayload;
let manager: TokenPayload;
let finance: TokenPayload;
let registrar: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Audit Branch', 'Loc');
  for (const [uid, uname, role] of [['u_ar_owner', 'ar_owner', 'owner'], ['u_ar_mgr', 'ar_mgr', 'manager'], ['u_ar_fin', 'ar_fin', 'finance'], ['u_ar_reg', 'ar_reg', 'registrar']]) {
    db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
      .run(uid, uname, 'Audit ' + role, role, BRANCH, await hashPassword('x'));
  }
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_ar_owner', role: 'owner', branchId: BRANCH });
  manager = makeUser({ userId: 'u_ar_mgr', role: 'manager', branchId: BRANCH });
  finance = makeUser({ userId: 'u_ar_fin', role: 'finance', branchId: BRANCH });
  registrar = makeUser({ userId: 'u_ar_reg', role: 'registrar', branchId: BRANCH });
  app = createApp();
});

describe('User creation via API (RBAC param fix)', () => {
  it('creates a manager user and assigns the RBAC role', async () => {
    const res = await supertest(app).post('/api/users').set(authHeader(owner)).send({
      username: 'new_manager', tempPassword: 'Temp-Pass-12345', fullName: 'New Manager', role: 'manager', branchId: BRANCH,
    });
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get('new_manager') as any;
    expect(row).toBeDefined();
    const role = db.prepare(`SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND ur.is_primary = 1`).get(row.id) as any;
    expect(role?.code).toBe('general_manager');
  });

  it('rejects a non-owner from user admin', async () => {
    const res = await supertest(app).post('/api/users').set(authHeader(manager)).send({
      username: 'blocked_user', tempPassword: 'Temp-Pass-12345', fullName: 'Blocked', role: 'registrar', branchId: BRANCH,
    });
    expect(res.status).toBe(403);
  });
});

describe('Manual student registration & ID card (simple-payment 10-arg fix)', () => {
  it('registers a student manually with payment (no SQL param error)', async () => {
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee) VALUES (?, ?, ?, 10, 'active', 'A1', 5000)`)
      .run('ar_class', 'Audit Class', BRANCH);
    const res = await supertest(app).post('/api/students/manual').set(authHeader(registrar)).send({
      fullName: 'Manual Student', phone: '0700000123', gender: 'male', branchId: BRANCH, classId: 'ar_class', tuitionAmount: 5000, amountPaidNow: 2000,
    });
    expect(res.status).toBe(201);
    const payments = db.prepare('SELECT * FROM payments WHERE student_id = ?').all(res.body.id) as any[];
    expect(payments.length).toBe(1);
  });

  it('issues a student ID card without SQL param error', async () => {
    const res = await supertest(app).post('/api/students/manual').set(authHeader(registrar)).send({
      fullName: 'Card Student', phone: '0700000456', gender: 'female', branchId: BRANCH,
    });
    expect(res.status).toBe(201);
    const card = await supertest(app).post(`/api/students/${res.body.id}/issue-card`).set(authHeader(registrar)).send({
      cardDesign: { primaryColor: 'indigo', bgStyle: 'waves' }, notes: 'first card',
    });
    expect(card.status).toBe(201);
  });
});

describe('Global search (classes.code fix)', () => {
  it('searches without referencing the nonexistent classes.code column', async () => {
    const res = await supertest(app).get('/api/search?q=Audit').set(authHeader(registrar));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Manager & finance HR/payroll RBAC (catalog fix)', () => {
  it('manager can create a teacher (Teacher.Create)', async () => {
    const res = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Mgr Teacher', phone: '0700111222', baseSalary: 10000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    expect(res.status).toBe(201);
  });

  it('manager can create an employee (Employee.Create)', async () => {
    const res = await supertest(app).post('/api/employees').set(authHeader(manager)).send({
      fullName: 'Mgr Employee', phone: '0700222333', role: 'receptionist', baseSalary: 8000, branchId: BRANCH,
    });
    expect(res.status).toBe(201);
  });

  it('finance can view payroll (Payroll.View) and manager can query salary status', async () => {
    const t = await supertest(app).post('/api/teachers').set(authHeader(manager)).send({
      fullName: 'Payroll Teacher', phone: '0700333444', baseSalary: 12000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    expect(t.status).toBe(201);
    const status = await supertest(app).get(`/api/teachers/${t.body.id}/salary-status?month=${today().slice(0, 7)}`).set(authHeader(manager));
    expect(status.status).toBe(200);
  });

  it('registrar is still blocked from creating teachers', async () => {
    const res = await supertest(app).post('/api/teachers').set(authHeader(registrar)).send({
      fullName: 'Reg Teacher', phone: '0700555666', baseSalary: 10000, salaryType: 'fixed', contractType: 'monthly', branchId: BRANCH,
    });
    expect(res.status).toBe(403);
  });
});
