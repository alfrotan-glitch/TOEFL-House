/**
 * Central treasury & budget funding chain — regression suite
 * ============================================================================
 * On a fresh install the organization treasury ("central capital") starts at
 * 0 with no funding path, which made the entire budget → salary → month-end
 * chain unreachable ("Insufficient organization treasury balance"). This
 * locks in the owner-only capital deposit endpoint and the full chain:
 *
 *   deposit capital → charge budget line → pay teacher salary
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';

const BRANCH = 'treasury_branch';
const DEFAULT_BRANCH = '1'; // seeded by the organization hierarchy at initSchema

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use('/api/teachers', teachersRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'owner', branchId: overrides.branchId || BRANCH, fullName: 'Treasury Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let owner: TokenPayload;
let manager: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Treasury Branch', 'Loc');
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`)
    .run('u_tr_owner', 'tr_owner', 'Treasury Owner', BRANCH, await hashPassword('x'));
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`)
    .run('u_tr_mgr', 'tr_mgr', 'Treasury Mgr', BRANCH, await hashPassword('x'));
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_tr_owner', role: 'owner', branchId: BRANCH });
  manager = makeUser({ userId: 'u_tr_mgr', role: 'manager', branchId: BRANCH });
  app = createApp();
});

describe('Treasury capital deposit', () => {
  it('owner can deposit capital into the central treasury (recorded + balanced)', async () => {
    const before = getFinanceAccount('organization', 'global').mainBalance;
    const res = await supertest(app).post('/api/finance/treasury/deposit').set(authHeader(owner)).send({ amount: 50000, notes: 'Opening capital' });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(before + 50000);
    const tx = db.prepare("SELECT * FROM financial_transactions WHERE category = 'capital_injection'").get() as any;
    expect(tx).toBeDefined();
    expect(Number(tx.amount)).toBe(50000);
    expect(tx.description).toContain('Opening capital');
  });

  it('rejects a non-positive amount', async () => {
    const res = await supertest(app).post('/api/finance/treasury/deposit').set(authHeader(owner)).send({ amount: 0 });
    expect(res.status).toBe(400);
    const res2 = await supertest(app).post('/api/finance/treasury/deposit').set(authHeader(owner)).send({ amount: -5 });
    expect(res2.status).toBe(400);
  });

  it('rejects non-owner roles (owner-only endpoint)', async () => {
    const res = await supertest(app).post('/api/finance/treasury/deposit').set(authHeader(manager)).send({ amount: 1000 });
    expect(res.status).toBe(403);
  });
});

describe('Budget → salary chain (previously unreachable on fresh install)', () => {
  it('funds a budget line from the treasury and pays a teacher salary from it', async () => {
    // Ensure treasury has funds for this chain.
    const balance = getFinanceAccount('organization', 'global').mainBalance;
    if (balance < 30000) {
      await supertest(app).post('/api/finance/treasury/deposit').set(authHeader(owner)).send({ amount: 30000 });
    }

    // The teacher pay-salary route reads the budget line with purpose
    // 'teacher_salary' for the teacher's branch (seeded by the budget catalog).
    const salaryLine = db.prepare("SELECT * FROM budget_lines WHERE purpose = 'teacher_salary' AND branch_id = ? LIMIT 1").get(DEFAULT_BRANCH) as { id: string } | undefined;
    expect(salaryLine).toBeDefined();

    const charge = await supertest(app).post(`/api/finance/budget-lines/${salaryLine!.id}/charge`).set(authHeader(owner)).send({ amount: 20000 });
    expect(charge.status).toBe(201);

    const line = db.prepare('SELECT current_amount FROM budget_lines WHERE id = ?').get(salaryLine!.id) as { current_amount: number };
    expect(Number(line.current_amount)).toBeGreaterThanOrEqual(20000);

    // Teacher + salary payment
    const teacherRes = await supertest(app).post('/api/teachers').set(authHeader(owner)).send({
      fullName: 'Chain Teacher', phone: '0744556677', email: 'chain@example.com', baseSalary: 15000, salaryType: 'fixed', contractType: 'monthly', branchId: DEFAULT_BRANCH,
    });
    expect(teacherRes.status).toBe(201);
    const teacherId = teacherRes.body.id as string;

    const pay = await supertest(app).post(`/api/teachers/${teacherId}/pay-salary`).set(authHeader(owner)).send({
      monthName: 'August 2026', amountPaid: 15000, paymentType: 'full',
    });
    expect(pay.status).toBe(201);
    expect(pay.body.ok).toBe(true);
    expect(pay.body.amountPaid).toBe(15000);

    const ledger = db.prepare("SELECT * FROM financial_transactions WHERE category = 'salary' ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(ledger).toBeDefined();
    expect(Number(ledger.amount)).toBe(15000);
  });
});
