/**
 * Finance command center — GET /api/finance/dashboard regression suite
 * ============================================================================
 * The finance manager's landing view must be computed server-side from the
 * database (backend-only financials), honor branch scope, and surface the
 * exact figures the finance desk needs to start their day:
 *
 *   balances  → main/saving from finance_accounts
 *   today     → ledger income/expense/net for today
 *   month     → ledger income/expense/net for the current month
 *   budget    → allocated / remaining / utilization + exhausted + at-risk lines
 *   receivables → open & overdue invoice value (net minus completed payments)
 *   approvals → pending expense requests (count + value + items)
 *   reconciliation → payment↔ledger health
 *   trend     → 14-day income/expense series
 *
 * Scope: a finance manager must only ever see their own branch; the owner
 * sees the whole organization.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH_A = 'dash_branch_a';
const BRANCH_B = 'dash_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'finance', branchId: overrides.branchId || BRANCH_A, fullName: 'Dashboard Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let financeA: TokenPayload;
let financeB: TokenPayload;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'Dashboard Branch A', 'Loc A');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'Dashboard Branch B', 'Loc B');

  for (const [uid, uname, role, branch] of [
    ['u_dash_fin_a', 'dash_fin_a', 'finance', BRANCH_A],
    ['u_dash_fin_b', 'dash_fin_b', 'finance', BRANCH_B],
    ['u_dash_owner', 'dash_owner', 'owner', BRANCH_A],
  ] as const) {
    await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
      .run(uid, uname, 'Dashboard ' + role, role, branch, await hashPassword('x'));
  }
  syncLegacyUserRoles(db);

  financeA = makeUser({ userId: 'u_dash_fin_a', role: 'finance', branchId: BRANCH_A });
  financeB = makeUser({ userId: 'u_dash_fin_b', role: 'finance', branchId: BRANCH_B });
  owner = makeUser({ userId: 'u_dash_owner', role: 'owner', branchId: BRANCH_A });

  // Seed ledger movement for branch A: one income + one expense today.
  const date = today();
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
    VALUES (?, 'income', 'fee', 10000, ?, 'Registration fee', ?, 'Tester', ?)`).run(id('tx'), date, id('ref'), BRANCH_A);
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
    VALUES (?, 'expense', 'utility', 2500, ?, 'Electricity bill', ?, 'Tester', ?)`).run(id('tx'), date, id('ref'), BRANCH_A);
  // Branch B has its own income — must never leak into A's dashboard.
  db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
    VALUES (?, 'income', 'fee', 99999, ?, 'Other branch fee', ?, 'Tester', ?)`).run(id('tx'), date, id('ref'), BRANCH_B);

  // Budget: one funded line (charge from a seeded organization treasury).
  db.prepare(`INSERT OR IGNORE INTO budget_lines (id, name, branch_id, allocated_amount, current_amount, purpose, cost_type, is_marketing)
    VALUES (?, 'Utilities', ?, 20000, 15000, 'utility', 'variable', 0)`).run('dash_budget_util', BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO budget_lines (id, name, branch_id, allocated_amount, current_amount, purpose, cost_type, is_marketing)
    VALUES (?, 'Exhausted Line', ?, 5000, 0, 'marketing', 'variable', 1)`).run('dash_budget_exh', BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO budget_lines (id, name, branch_id, allocated_amount, current_amount, purpose, cost_type, is_marketing)
    VALUES (?, 'Other Branch Budget', ?, 7000, 7000, 'utility', 'fixed', 0)`).run('dash_budget_b', BRANCH_B);

  // Pending approval in branch A.
  db.prepare(`INSERT INTO expense_requests (id, title, amount, budget_line_id, requester, status, date, branch_id, expense_kind, payment_method, auto_approved, requester_user_id, approved_by_user_id)
    VALUES (?, 'Office chairs', 3000, 'dash_budget_util', 'Receptionist', 'pending', ?, ?, 'one_time_purchase', 'cash', 0, 'u_dash_fin_a', NULL)`).run(id('req'), date, BRANCH_A);

  // Invoice + partial payment in branch A (receivable), and a fully paid one.
  // The branch-guard triggers require invoice.student_id to live in the same branch.
  db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
    VALUES (?, 'TH-DASH-1', 'Dashboard Student', 'active', ?, ?, 'male')`).run('stu_dash_1', date, BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
    VALUES (?, 'TH-DASH-2', 'Dashboard Student 2', 'active', ?, ?, 'male')`).run('stu_dash_2', date, BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
    VALUES (?, 'stu_dash_1', 12000, 0, 12000, 'partial', ?, ?, ?, 'INV-DASH-1')`).run('dash_inv_open', date, date, BRANCH_A);
  db.prepare(`INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, 'stu_dash_1', 'dash_inv_open', 4000, ?, 'cash', 'completed', 'fee', 'R-DASH-1', ?, hex(randomblob(16)))`).run(id('pay'), date, BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
    VALUES (?, 'stu_dash_2', 5000, 0, 5000, 'paid', ?, ?, ?, 'INV-DASH-2')`).run('dash_inv_paid', date, date, BRANCH_A);

  app = createApp();
});

describe('GET /api/finance/dashboard', () => {
  it('returns the full command-center payload for a finance manager (branch scope)', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('branch');
    expect(res.body.branchId).toBe(BRANCH_A);

    // Today's ledger movement (branch A only).
    expect(res.body.today.income).toBe(10000);
    expect(res.body.today.expense).toBe(2500);
    expect(res.body.today.net).toBe(7500);
    expect(res.body.month.income).toBe(10000);

    // Budget: A has two lines (15000 remaining + 0 remaining), B's line excluded.
    expect(res.body.budget.lines).toBe(2);
    expect(res.body.budget.remaining).toBe(15000);
    expect(res.body.budget.allocated).toBe(25000);
    expect(res.body.budget.exhausted.length).toBe(1);
    expect(res.body.budget.exhausted[0].id).toBe('dash_budget_exh');
    expect(res.body.budget.atRisk.length).toBe(0);

    // Receivables: partial invoice 12000 - 4000 paid = 8000 open; not overdue today.
    expect(res.body.receivables.openInvoices).toBe(1);
    expect(res.body.receivables.openValue).toBe(8000);
    expect(res.body.receivables.overdueInvoices).toBe(0);
    expect(res.body.receivables.collectedThisMonth).toBe(4000);

    // Approvals.
    expect(res.body.approvals.pendingCount).toBe(1);
    expect(res.body.approvals.pendingValue).toBe(3000);
    expect(res.body.approvals.items[0].title).toBe('Office chairs');

    // Reconciliation + trend shape.
    expect(typeof res.body.reconciliation.healthy).toBe('boolean');
    expect(res.body.trend).toHaveLength(14);
    expect(res.body.settings.dailySavingPercent).toBeGreaterThanOrEqual(0);
  });

  it('keeps branch B numbers out of branch A and vice versa', async () => {
    const resA = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    const resB = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeB));
    expect(resB.body.today.income).toBe(99999);
    expect(resA.body.today.income).toBe(10000);
    expect(resB.body.budget.lines).toBe(1);
  });

  it('owner scope aggregates both branches (branchId=all)', async () => {
    const res = await supertest(app).get('/api/finance/dashboard?branchId=all').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('organization');
    expect(res.body.today.income).toBe(10000 + 99999);
    expect(res.body.today.expense).toBe(2500);
    // The budget-line catalog seeds default lines too, so assert membership
    // rather than an exact count at organization scope.
    expect(res.body.budget.lines).toBeGreaterThanOrEqual(3);
    expect(res.body.budget.exhausted.some((e: { id: string }) => e.id === 'dash_budget_exh')).toBe(true);
    expect(res.body.receivables.openValue).toBe(8000);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await supertest(app).get('/api/finance/dashboard');
    expect(res.status).toBe(401);
  });

  it('reconciliation works at organization scope too (RangeError regression)', async () => {
    // Owner + branchId=all used to crash with "Too many parameter values"
    // because the handler bound `undefined` to a zero-placeholder statement.
    const res = await supertest(app).get('/api/finance/reconciliation?branchId=all').set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('organization');
    expect(typeof res.body.healthy).toBe('boolean');
  });
});
