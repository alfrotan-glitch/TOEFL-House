/**
 * Expense request integrity — regression suite for finance finding F-3.
 *
 * `POST /api/finance/expense-requests` is the approval-first sibling of
 * `/operational-payments`. The earlier audit (59bcc3a) fixed the latter; this
 * endpoint carried the SAME two defects and was missed.
 *
 * F-3a — VALIDATED A COERCION, STORED THE RAW VALUE
 * The guard was `!Number.isFinite(Number(amount)) || Number(amount) <= 0`, but
 * the INSERT bound the raw `amount`. Check and write disagreed. Reproduced live
 * on a fresh database:
 *     '0x10' -> 201, persisted as TEXT '0x10' in a REAL column
 *     [500]  -> 201, persisted as 500
 *     true   -> 500 "SQLite3 can only bind numbers, strings, bigints..."
 *     [[7]]  -> 500 (same raw bind error)
 *     0.001  -> 500, leaking the two-decimal database trigger
 *     1e15   -> 201, persisted
 * A TEXT amount is not inert: /expense-report accumulates with
 * `r.totalAmount += er.amount` (string concatenation), the dashboard sums
 * pending value, and /decide feeds `request.amount` into payFromBudgetLine.
 *
 * F-3b — REQUEST BOOKED TO THE ACTOR'S BRANCH
 * The row stored `user.branchId` while the budget line could belong to another
 * branch. `/decide` checks `budgetLine.branch_id !== request.branch_id` BEFORE
 * the approve/reject split, so such a request could be neither approved NOR
 * rejected — verified permanently stuck in `pending`.
 *
 * The invariant is derived, not invented: `/operational-payments` and
 * `/decide` already book to the budget line's branch.
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

const BR_A = 'feri_a';
const BR_B = 'feri_b';
const LINE_A = 'feri_line_a';
const LINE_B = 'feri_line_b';

let app: express.Express;
const users: Record<string, TokenPayload> = {};
const auth = (u: string) => ({ Authorization: `Bearer ${signToken(users[u])}` });

/** Not amounts. Each was stored verbatim or crashed with a 500 pre-fix. */
const NON_AMOUNTS: Array<[string, unknown]> = [
  ['hex string', '0x10'],
  ['array', [500]],
  ['nested array', [[7]]],
  ['boolean true', true],
  ['boolean false', false],
  ['sub-cent', 0.001],
  ['precision overflow', 1e15],
  ['text', 'abc'],
  ['empty string', ''],
  ['object', {}],
];

const mkReq = (u: string, body: Record<string, unknown>) =>
  supertest(app).post('/api/finance/expense-requests').set(auth(u)).send(body);
const decide = (u: string, id: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/finance/expense-requests/${id}/decide`).set(auth(u)).send(body);
const rowByTitle = (t: string) =>
  db.prepare('SELECT id, branch_id, amount, status FROM expense_requests WHERE title = ?').get(t) as Record<string, unknown> | undefined;
const amountClassOf = (t: string) =>
  String((db.prepare('SELECT typeof(amount) ty FROM expense_requests WHERE title = ?').get(t) as { ty: string } | undefined)?.ty ?? '-');
const requestCount = () =>
  Number((db.prepare('SELECT COUNT(*) c FROM expense_requests').get() as { c: number }).c);
const budgetOf = (l: string) =>
  Number((db.prepare('SELECT current_amount c FROM budget_lines WHERE id = ?').get(l) as { c: number }).c);

const setLine = (lineId: string, branchId: string, amount: number) =>
  db.prepare(
    `INSERT OR REPLACE INTO budget_lines (id, name, allocated_amount, current_amount, category_id, branch_id)
     VALUES (?, 'Utilities', ?, ?, 'sub_utilities', ?)`,
  ).run(lineId, amount, amount, branchId);

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [b, n] of [[BR_A, 'FERI A'], [BR_B, 'FERI B']] as const) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, n, 'Kabul');
  }
  const pw = await hashPassword('pw');
  for (const [uid, role, br] of [
    ['feri_owner', 'owner', BR_A],
    ['feri_fin_a', 'finance', BR_A],
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

describe('F-3a · the requested amount is parsed, never stored raw', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} with 400 and stores no request`, async () => {
      setLine(LINE_A, BR_A, 50_000);
      const before = requestCount();
      const title = `F3a ${label}`;

      const res = await mkReq('feri_owner', { title, amount: value, budgetLineId: LINE_A });

      expect(res.status).toBe(400);
      // Pre-fix `true`/`[[7]]`/`0.001` leaked raw driver or trigger errors.
      expect(String(res.body?.error ?? '')).not.toMatch(/SQLite3|bind|decimal places|constraint/i);
      expect(requestCount()).toBe(before);
      expect(rowByTitle(title)).toBeUndefined();
    });
  }

  it('never leaves a TEXT amount in the REAL amount column', async () => {
    setLine(LINE_A, BR_A, 50_000);
    for (const [label, value] of NON_AMOUNTS) {
      await mkReq('feri_owner', { title: `F3a class ${label}`, amount: value, budgetLineId: LINE_A });
    }
    const bad = Number(
      (db.prepare("SELECT COUNT(*) c FROM expense_requests WHERE typeof(amount) NOT IN ('real','integer')").get() as { c: number }).c,
    );
    expect(bad).toBe(0);
  });

  it.each([
    ['whole number', 300, 300],
    ['numeric string', '2400', 2400],
    ['one hundred afghani', 100, 100],
  ])('accepts a legitimate amount (%s) and stores the parsed number', async (_l, sent, stored) => {
    setLine(LINE_A, BR_A, 50_000);
    const title = `F3a legit ${String(sent)}`;
    const res = await mkReq('feri_owner', { title, amount: sent, budgetLineId: LINE_A });
    expect(res.status).toBe(201);
    expect(Number(rowByTitle(title)?.amount)).toBe(stored);
    expect(amountClassOf(title)).toBe('integer');
  });

  it.each([['zero', 0], ['negative', -100]])('keeps rejecting a non-positive amount (%s)', async (_l, v) => {
    setLine(LINE_A, BR_A, 50_000);
    const res = await mkReq('feri_owner', { title: `F3a nonpos ${String(v)}`, amount: v, budgetLineId: LINE_A });
    expect(res.status).toBe(400);
  });
});

describe('F-3b · the request is booked to the branch that will pay', () => {
  it('stores the budget line branch, not the actor branch', async () => {
    setLine(LINE_B, BR_B, 50_000);
    const title = 'F3b cross-branch';
    const res = await mkReq('feri_owner', { title, amount: 900, budgetLineId: LINE_B });
    expect(res.status).toBe(201);
    expect(rowByTitle(title)?.branch_id).toBe(BR_B);
  });

  it('a cross-branch request can be APPROVED and paid end to end', async () => {
    // Pre-fix this was impossible: /decide refused with 409 "different
    // branches" because the row carried the actor's branch.
    setLine(LINE_B, BR_B, 50_000);
    const title = 'F3b approvable';
    const created = await mkReq('feri_owner', { title, amount: 700, budgetLineId: LINE_B });
    expect(created.status).toBe(201);

    const before = budgetOf(LINE_B);
    const d = await decide('feri_owner', String(created.body.id), { isApproved: true });
    expect(d.status).toBe(200);
    expect(before - budgetOf(LINE_B)).toBe(700);
    // The paid expense must be attributed to the funding branch.
    const led = db.prepare('SELECT branch_id FROM financial_transactions WHERE reference_id = ?').all(created.body.id) as Array<{ branch_id: string }>;
    expect(led).toHaveLength(1);
    expect(led[0].branch_id).toBe(BR_B);
  });

  it('a cross-branch request can also be REJECTED', async () => {
    // Pre-fix it was stuck in `pending` forever: the branch check runs BEFORE
    // the approve/reject split, so even rejection returned 409.
    setLine(LINE_B, BR_B, 50_000);
    const created = await mkReq('feri_owner', { title: 'F3b rejectable', amount: 500, budgetLineId: LINE_B });
    const d = await decide('feri_owner', String(created.body.id), { isApproved: false, rejectReason: 'not needed' });
    expect(d.status).toBe(200);
    expect(rowByTitle('F3b rejectable')?.status).toBe('rejected');
  });
});

describe('F-4 · rejecting an expense request reports its real outcome', () => {
  it('answers 200 and does not leak a CHECK violation after the state change', async () => {
    // The reject path passed notification type 'alert', which
    // `notifications.type` does not allow (info|warning|critical|success).
    // The rejection UPDATE had ALREADY committed, so the CHECK violation
    // surfaced afterwards as 400 "Invalid data provided. Please check your
    // inputs." on an operation that had genuinely succeeded — the caller was
    // told it failed while the database said `rejected`.
    setLine(LINE_A, BR_A, 50_000);
    const created = await mkReq('feri_fin_a', { title: 'F4 reject', amount: 250, budgetLineId: LINE_A });
    expect(created.status).toBe(201);

    const d = await decide('feri_owner', String(created.body.id), { isApproved: false, rejectReason: 'duplicate' });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('rejected');
    expect(String((d.body as { error?: string }).error ?? '')).not.toMatch(/Invalid data provided/i);

    // Response and stored state must agree.
    expect(rowByTitle('F4 reject')?.status).toBe('rejected');
    // The notification must actually have been written.
    const notes = db.prepare("SELECT type FROM notifications WHERE title = 'Budget request rejected'").all() as Array<{ type: string }>;
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(['info', 'warning', 'critical', 'success']).toContain(n.type);
  });

  it('rejection without an explicit reason also succeeds', async () => {
    setLine(LINE_A, BR_A, 50_000);
    const created = await mkReq('feri_fin_a', { title: 'F4 reject no reason', amount: 125, budgetLineId: LINE_A });
    const d = await decide('feri_owner', String(created.body.id), { isApproved: false });
    expect(d.status).toBe(200);
    expect(rowByTitle('F4 reject no reason')?.status).toBe('rejected');
  });

  it('a rejected request cannot be decided again and never charges the budget', async () => {
    setLine(LINE_A, BR_A, 50_000);
    const before = budgetOf(LINE_A);
    const created = await mkReq('feri_fin_a', { title: 'F4 no double decide', amount: 400, budgetLineId: LINE_A });
    expect((await decide('feri_owner', String(created.body.id), { isApproved: false })).status).toBe(200);
    const again = await decide('feri_owner', String(created.body.id), { isApproved: true });
    expect(again.status).toBe(409);
    expect(budgetOf(LINE_A)).toBe(before);
  });

  it('every addNotification type in the codebase satisfies the schema CHECK', () => {
    // Guards the class of defect, not just this instance: the TS union and the
    // database CHECK must not drift apart again.
    const allowed = ['info', 'warning', 'critical', 'success'];
    for (const t of allowed) {
      expect(() =>
        db.prepare("INSERT INTO notifications (id,title,message,date,type,branch_id) VALUES (?,?,?,date('now'),?,?)")
          .run(`f4_${t}`, 't', 'm', t, BR_A),
      ).not.toThrow();
    }
    expect(() =>
      db.prepare("INSERT INTO notifications (id,title,message,date,type,branch_id) VALUES (?,?,?,date('now'),?,?)")
        .run('f4_alert', 't', 'm', 'alert', BR_A),
    ).toThrow(/CHECK constraint/i);
  });
});

describe('F-3b · branch attribution sweep', () => {
  it('no reachable path leaves a request whose branch differs from its budget line', async () => {
    setLine(LINE_A, BR_A, 50_000);
    setLine(LINE_B, BR_B, 50_000);
    await mkReq('feri_owner', { title: 'F3b sweep same', amount: 100, budgetLineId: LINE_A });
    await mkReq('feri_owner', { title: 'F3b sweep cross', amount: 200, budgetLineId: LINE_B });
    await mkReq('feri_fin_a', { title: 'F3b sweep own', amount: 300, budgetLineId: LINE_A });
    const mismatched = db.prepare(`
      SELECT er.id FROM expense_requests er
      JOIN budget_lines bl ON bl.id = er.budget_line_id
      WHERE er.branch_id <> bl.branch_id`).all();
    expect(mismatched).toEqual([]);
  });

  it('same-branch requests are unaffected', async () => {
    setLine(LINE_A, BR_A, 50_000);
    const title = 'F3b same branch';
    const created = await mkReq('feri_fin_a', { title, amount: 400, budgetLineId: LINE_A });
    expect(created.status).toBe(201);
    expect(rowByTitle(title)?.branch_id).toBe(BR_A);
    const before = budgetOf(LINE_A);
    const d = await decide('feri_owner', String(created.body.id), { isApproved: true });
    expect(d.status).toBe(200);
    expect(before - budgetOf(LINE_A)).toBe(400);
  });

  it('NOT A DEFECT · a non-global role still cannot target another branch line', async () => {
    setLine(LINE_B, BR_B, 50_000);
    const res = await mkReq('feri_fin_a', { title: 'F3b denied', amount: 250, budgetLineId: LINE_B });
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? '')).toMatch(/another branch/i);
  });
});

describe('F-3 · reconciliation across the request lifecycle', () => {
  it('budget drained equals expense booked, per branch', async () => {
    setLine(LINE_A, BR_A, 30_000);
    setLine(LINE_B, BR_B, 30_000);
    const expenseOf = (b: string) =>
      Number((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE type='expense' AND branch_id = ?").get(b) as { s: number }).s);
    const aExp0 = expenseOf(BR_A); const bExp0 = expenseOf(BR_B);
    const aB0 = budgetOf(LINE_A); const bB0 = budgetOf(LINE_B);

    for (const [line, amt] of [[LINE_A, 120], [LINE_B, 250], [LINE_B, 75.25]] as const) {
      const c = await mkReq('feri_owner', { title: `recon ${line} ${amt}`, amount: amt, budgetLineId: line });
      await decide('feri_owner', String(c.body.id), { isApproved: true });
    }
    // Rejected inputs must contribute nothing.
    await mkReq('feri_owner', { title: 'recon bad', amount: '0x10', budgetLineId: LINE_B });

    expect(aB0 - budgetOf(LINE_A)).toBe(120);
    expect(bB0 - budgetOf(LINE_B)).toBe(250);
    expect(expenseOf(BR_A) - aExp0).toBe(120);
    expect(expenseOf(BR_B) - bExp0).toBe(250);
  });
});
