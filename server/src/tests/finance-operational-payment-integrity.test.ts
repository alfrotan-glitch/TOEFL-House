/**
 * Operational payment integrity — regression suite for finance-audit findings
 * F-1 (branch misattribution) and F-2 (amount coercion).
 *
 * F-1 — EXPENSE BOOKED TO THE WRONG BRANCH
 * `POST /api/finance/operational-payments` debited the budget line's branch but
 * wrote the `expense_requests` row and the `financial_transactions` row with
 * `user.branchId`. A global owner spending another branch's line therefore
 * drained THAT branch's budget while the expense landed on their own.
 * Reproduced live: 1,200 AFN left branch B's line; branch A's expense total
 * rose to 1,200 and branch B's stayed 0.
 *
 * The intended invariant is not invented here — the sibling caller of
 * `payFromBudgetLine`, `POST /expense-requests/:id/decide`, already enforces it:
 * it rejects a request whose budget line belongs to another branch (409) and
 * pays with `branchId: budgetLine.branch_id`. This suite pins both paths.
 *
 * Blast radius: branch-scoped expense totals feed /finance/overview,
 * /finance/dashboard, the reports P&L and the BOS break-even KPIs.
 *
 * F-2 — AMOUNT COERCION
 * `Number(amount)` is a coercion, not a parse. Reproduced live:
 *     true   -> 201, 1 AFN actually paid
 *     [500]  -> 201, 500 AFN actually paid
 *     '0x10' -> 201, 16 AFN actually paid
 *     [[7]]  -> 201, 7 AFN actually paid
 *     0.001  -> 500, leaking the two-decimal database trigger
 * Fixed with `assertMoney`, the boundary `/treasury/deposit` on this same
 * router already uses. No new rule: the accepted range is unchanged and any
 * amount >= 0.01 behaves exactly as before.
 *
 * NOT A DEFECT (verified, recorded so it is not re-reported): a non-global role
 * spending another branch's budget line is correctly refused with 403
 * ("Budget line belongs to another branch"). Only a global owner may cross
 * branches, which is the intended RBAC design.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { incrementMainBalance } from '../utils/financeAccounts.js';

const BR_A = 'fopi_a';
const BR_B = 'fopi_b';
const LINE_A = 'fopi_line_a';
const LINE_B = 'fopi_line_b';

let app: express.Express;
const users: Record<string, TokenPayload> = {};
const auth = (u: string) => ({ Authorization: `Bearer ${signToken(users[u])}` });

/** Values that are not amounts. Each was a real payment or a 500 pre-fix. */
const NON_AMOUNTS: Array<[string, unknown]> = [
  ['boolean true', true],
  ['array [500]', [500]],
  ['nested array', [[7]]],
  ['numeric-string array', ['12']],
  ['hex string', '0x10'],
  ['text', 'abc'],
  ['empty string', ''],
  ['object', {}],
  ['sub-cent', 0.001],
];

const budgetOf = (lineId: string) =>
  Number((db.prepare('SELECT current_amount c FROM budget_lines WHERE id = ?').get(lineId) as { c: number }).c);
const expenseTotalOf = (branchId: string) =>
  Number((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE type='expense' AND branch_id = ?").get(branchId) as { s: number }).s);
const ledgerRowsFor = (title: string) =>
  db.prepare('SELECT branch_id, amount, type, category FROM financial_transactions WHERE description LIKE ?').all(`%${title}%`) as Array<Record<string, unknown>>;
const requestRow = (title: string) =>
  db.prepare('SELECT branch_id, amount, status FROM expense_requests WHERE title = ?').get(title) as Record<string, unknown> | undefined;
const requestCount = () =>
  Number((db.prepare('SELECT COUNT(*) c FROM expense_requests').get() as { c: number }).c);

const opPay = (u: string, body: Record<string, unknown>) =>
  supertest(app).post('/api/finance/operational-payments').set(auth(u)).send(body);

const setLine = (lineId: string, branchId: string, amount: number) =>
  db.prepare(
    `INSERT OR REPLACE INTO budget_lines (id, name, allocated_amount, current_amount, category_id, branch_id)
     VALUES (?, 'Utilities', ?, ?, 'sub_utilities', ?)`,
  ).run(lineId, amount, amount, branchId);

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [b, n] of [[BR_A, 'FOPI A'], [BR_B, 'FOPI B']] as const) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, n, 'Kabul');
  }
  const pw = await hashPassword('pw');
  // Legacy role codes are what `users.role` CHECK accepts; syncLegacyUserRoles
  // maps them onto the RBAC identities (finance -> finance_manager, etc).
  for (const [uid, role, br] of [
    ['fopi_owner', 'owner', BR_A],
    ['fopi_fin_a', 'finance', BR_A],
    ['fopi_mgr_a', 'manager', BR_A],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(uid, uid, uid, br, pw);
    assignRole(uid, role, br);
    users[uid] = { userId: uid, username: uid, branchId: br, fullName: uid };
  }

  incrementMainBalance('organization', 'global', 5_000_000);

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
});

describe('F-1 · the expense follows the budget line that paid for it', () => {
  it('books a cross-branch payment to the branch whose budget was debited', async () => {
    setLine(LINE_B, BR_B, 50_000);
    const title = 'F1 cross-branch attribution';
    const bBudgetBefore = budgetOf(LINE_B);
    const aExpenseBefore = expenseTotalOf(BR_A);
    const bExpenseBefore = expenseTotalOf(BR_B);

    // A global owner whose own branch is A spends branch B's budget line.
    const res = await opPay('fopi_owner', { title, amount: 1200, budgetLineId: LINE_B });
    expect(res.status).toBe(201);

    // The cash left branch B...
    expect(bBudgetBefore - budgetOf(LINE_B)).toBe(1200);
    // ...so the expense must be branch B's, not the actor's branch A.
    expect(expenseTotalOf(BR_B) - bExpenseBefore).toBe(1200);
    expect(expenseTotalOf(BR_A) - aExpenseBefore).toBe(0);

    const rows = ledgerRowsFor(title);
    expect(rows).toHaveLength(1);
    expect(rows[0].branch_id).toBe(BR_B);
    expect(Number(rows[0].amount)).toBe(1200);
    expect(rows[0].type).toBe('expense');
    // The request row must agree with the ledger row.
    expect(requestRow(title)?.branch_id).toBe(BR_B);
  });

  it('books a pending (approval-required) request to the budget line branch too', async () => {
    // Otherwise /decide would later refuse its own request with the
    // "different branches" 409 it enforces.
    setLine(LINE_B, BR_B, 50_000);
    const title = 'F1 pending attribution';
    const res = await opPay('fopi_owner', { title, amount: 900, budgetLineId: LINE_B, requireApproval: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(requestRow(title)?.branch_id).toBe(BR_B);
    // Nothing is paid until it is approved.
    expect(ledgerRowsFor(title)).toHaveLength(0);
  });

  it('a pending cross-branch request can still be approved and paid end to end', async () => {
    setLine(LINE_B, BR_B, 50_000);
    const title = 'F1 pending then approved';
    const created = await opPay('fopi_owner', { title, amount: 700, budgetLineId: LINE_B, requireApproval: true });
    expect(created.status).toBe(201);

    const before = budgetOf(LINE_B);
    const decided = await supertest(app)
      .post(`/api/finance/expense-requests/${created.body.id}/decide`)
      .set(auth('fopi_owner')).send({ isApproved: true });
    // Pre-fix the request carried branch A while the line was branch B, so
    // /decide rejected it with 409 "different branches" — a payment that could
    // be created but never approved.
    expect(decided.status).toBe(200);
    expect(before - budgetOf(LINE_B)).toBe(700);
    const rows = ledgerRowsFor(title);
    expect(rows).toHaveLength(1);
    expect(rows[0].branch_id).toBe(BR_B);
  });

  it('same-branch payments are unaffected', async () => {
    setLine(LINE_A, BR_A, 50_000);
    const title = 'F1 same branch';
    const before = budgetOf(LINE_A);
    const aExpenseBefore = expenseTotalOf(BR_A);
    const res = await opPay('fopi_owner', { title, amount: 450, budgetLineId: LINE_A });
    expect(res.status).toBe(201);
    expect(before - budgetOf(LINE_A)).toBe(450);
    expect(expenseTotalOf(BR_A) - aExpenseBefore).toBe(450);
    expect(ledgerRowsFor(title)[0].branch_id).toBe(BR_A);
  });

  it('NOT A DEFECT · a non-global role still cannot spend another branch line', async () => {
    setLine(LINE_B, BR_B, 50_000);
    const before = budgetOf(LINE_B);
    for (const u of ['fopi_fin_a', 'fopi_mgr_a']) {
      const res = await opPay(u, { title: `F1 denied ${u}`, amount: 500, budgetLineId: LINE_B });
      expect(res.status).toBe(403);
      expect(String(res.body?.error ?? '')).toMatch(/another branch/i);
    }
    expect(budgetOf(LINE_B)).toBe(before);
  });
});

describe('F-2 · the amount is parsed, never coerced', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} with 400 and moves no money`, async () => {
      setLine(LINE_A, BR_A, 50_000);
      const before = budgetOf(LINE_A);
      const requestsBefore = requestCount();
      const expenseBefore = expenseTotalOf(BR_A);

      const res = await opPay('fopi_owner', { title: `F2 ${label}`, amount: value, budgetLineId: LINE_A });

      expect(res.status).toBe(400);
      // Pre-fix, 0.001 surfaced the raw two-decimal database trigger as a 500.
      expect(String(res.body?.error ?? '')).not.toMatch(/decimal places|constraint|SQLITE_/i);
      expect(budgetOf(LINE_A)).toBe(before);
      expect(requestCount()).toBe(requestsBefore);
      expect(expenseTotalOf(BR_A)).toBe(expenseBefore);
    });
  }

  it('rejects a coerced amount on the approval-required path as well', async () => {
    // Pre-fix `requireApproval: true` with amount `true` stored a 1 AFN
    // pending request awaiting a real approval.
    setLine(LINE_A, BR_A, 50_000);
    const requestsBefore = requestCount();
    const res = await opPay('fopi_owner', { title: 'F2 pending coerce', amount: true, budgetLineId: LINE_A, requireApproval: true });
    expect(res.status).toBe(400);
    expect(requestCount()).toBe(requestsBefore);
    expect(requestRow('F2 pending coerce')).toBeUndefined();
  });

  it.each([
    ['zero', 0],
    ['negative', -500],
    ['negative string', '-500'],
  ])('keeps rejecting a non-positive amount (%s)', async (_label, value) => {
    setLine(LINE_A, BR_A, 50_000);
    const before = budgetOf(LINE_A);
    const res = await opPay('fopi_owner', { title: 'F2 nonpositive', amount: value, budgetLineId: LINE_A });
    expect(res.status).toBe(400);
    expect(budgetOf(LINE_A)).toBe(before);
  });

  it('rejects an amount beyond monetary precision without touching the budget', async () => {
    setLine(LINE_A, BR_A, 50_000);
    const before = budgetOf(LINE_A);
    const res = await opPay('fopi_owner', { title: 'F2 precision', amount: 1e15, budgetLineId: LINE_A });
    expect(res.status).toBe(400);
    expect(budgetOf(LINE_A)).toBe(before);
  });

  it.each([
    ['whole number', 1500, 1500],
    ['numeric string', '2400.50', 2400.5],
    ['two decimals', 999.99, 999.99],
    ['rounds to two decimals', 100.005, 100.01],
  ])('still pays a legitimate amount (%s)', async (_label, sent, expected) => {
    setLine(LINE_A, BR_A, 50_000);
    const before = budgetOf(LINE_A);
    const title = `F2 legit ${String(sent)}`;
    const res = await opPay('fopi_owner', { title, amount: sent, budgetLineId: LINE_A });
    expect(res.status).toBe(201);
    expect(before - budgetOf(LINE_A)).toBeCloseTo(expected, 2);
    expect(Number(ledgerRowsFor(title)[0].amount)).toBe(expected);
    expect(Number(requestRow(title)?.amount)).toBe(expected);
  });

  it('still refuses to overspend a budget line', async () => {
    setLine(LINE_A, BR_A, 1000);
    const res = await opPay('fopi_owner', { title: 'F2 overspend', amount: 2000, budgetLineId: LINE_A });
    expect(res.status).toBe(409);
    expect(budgetOf(LINE_A)).toBe(1000);
  });

  it('never drives a budget line negative under concurrent payments', async () => {
    // The application-level `budgetLine.current_amount < resolvedAmount`
    // pre-check is a read-then-act: several concurrent requests all read the
    // same healthy balance and pass it together. The conditional
    // `UPDATE ... WHERE current_amount >= ?` inside payFromBudgetLine is the
    // only thing that stops the line going negative, and mutation testing
    // showed nothing exercised it — the single-request overspend test above is
    // absorbed by the pre-check and never reaches the debit.
    setLine(LINE_A, BR_A, 1000);
    const results = await Promise.all(
      [1000, 1000, 1000, 1000, 1000].map((amount, i) =>
        opPay('fopi_owner', { title: `F2 race ${i}`, amount, budgetLineId: LINE_A })),
    );
    const paid = results.filter((r) => r.status === 201);
    expect(paid).toHaveLength(1);
    expect(budgetOf(LINE_A)).toBe(0);
    expect(budgetOf(LINE_A)).toBeGreaterThanOrEqual(0);
    // Exactly one ledger row may exist across the whole race.
    const rows = db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE description LIKE '%F2 race%'").get() as { c: number };
    expect(Number(rows.c)).toBe(1);
  });
});

describe('F-1/F-2 · reconciliation of a mixed run', () => {
  it('every paid expense is attributable to the branch that funded it', async () => {
    setLine(LINE_A, BR_A, 20_000);
    setLine(LINE_B, BR_B, 20_000);
    const aBefore = expenseTotalOf(BR_A);
    const bBefore = expenseTotalOf(BR_B);
    const aBudget = budgetOf(LINE_A);
    const bBudget = budgetOf(LINE_B);

    await opPay('fopi_owner', { title: 'mix a1', amount: 100, budgetLineId: LINE_A });
    await opPay('fopi_owner', { title: 'mix b1', amount: 250, budgetLineId: LINE_B });
    await opPay('fopi_owner', { title: 'mix b2', amount: 325.75, budgetLineId: LINE_B });
    // Rejected attempts must contribute nothing to either side.
    await opPay('fopi_owner', { title: 'mix bad', amount: 'abc', budgetLineId: LINE_B });
    await opPay('fopi_owner', { title: 'mix bad2', amount: [999], budgetLineId: LINE_B });

    // Budget drained per branch == expense recorded per branch.
    expect(aBudget - budgetOf(LINE_A)).toBeCloseTo(100, 2);
    expect(bBudget - budgetOf(LINE_B)).toBeCloseTo(575.75, 2);
    expect(expenseTotalOf(BR_A) - aBefore).toBeCloseTo(100, 2);
    expect(expenseTotalOf(BR_B) - bBefore).toBeCloseTo(575.75, 2);
  });
});
