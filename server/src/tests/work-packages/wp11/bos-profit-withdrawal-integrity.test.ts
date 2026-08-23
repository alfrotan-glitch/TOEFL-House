/**
 * BOS — management profit withdrawal integrity.
 *
 * `POST /api/bos/profit-distribution/withdraw` is the only money mutator in the
 * BOS router: it decrements branch cash and books an owner-drawing
 * expense. It had no dedicated test coverage.
 *
 * BOS-1 (the defect this suite is written against):
 *   The withdrawable ceiling is recomputed on every request as
 *       profit  = income - expense            (for the current month)
 *       maximum = profit * tierPercent        (tier from the profit margin)
 *   The withdrawal itself is booked as an expense, so it lowers profit — but
 *   only by 100% of the amount while the ceiling is 20% of profit. Each
 *   withdrawal therefore removes just a fifth of itself from the ceiling, and
 *   the limit REPLENISHES instead of closing.
 *
 *   Reproduced live against a fresh database: a branch whose stated monthly
 *   maximum was 32,000 AFN paid out 140,630 AFN across 10 sequential calls —
 *   4.4x the published cap, and 70% of all revenue for the period — while
 *   every individual request passed its own limit check. The reserve-fund
 *   guard stayed satisfied throughout, so nothing else stopped the drain.
 *
 * The invariant: the SUM of profit distributions taken in a period may never
 * exceed the maximum computed for that period.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { id, today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bosRouter } from '../../../routes/bos.routes.js';

const BR = 'bos_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bos', bosRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string, branchId: string): TokenPayload & { role: string } => ({ role,
  userId,
  username: userId,
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const OWNER = tok('bos_owner', 'owner', BR);
const FINANCE = tok('bos_fin', 'finance', BR);
const MANAGER = tok('bos_mgr', 'manager', BR);

let app: ReturnType<typeof createApp>;

const mainBalance = () =>
  (db.prepare("SELECT main_balance m FROM finance_accounts WHERE scope_type='branch' AND scope_id=?").get(BR) as { m: number }).m;

const withdrawnTotal = () =>
  (db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE finance_category_id='sub_owner_drawings' AND branch_id=?",
  ).get(BR) as { s: number }).s;

const calculate = async () =>
  (await supertest(app).get(`/api/bos/profit-distribution/calculate?branchId=${BR}`).set(auth(OWNER))).body;

const withdraw = async (amount: unknown, actor: TokenPayload = OWNER) =>
  supertest(app).post(`/api/bos/profit-distribution/withdraw?branchId=${BR}`).set(auth(actor)).send({ amount });

const warnings = async () =>
  (await supertest(app).get(`/api/bos/decision-warnings?branchId=${BR}`).set(auth(OWNER))).body
    .warnings as Array<{ title: string; message: string }>;

/** Rebuild a clean financial period: 200,000 income, 40,000 expense. */
function resetPeriod() {
  db.prepare('DELETE FROM financial_transactions WHERE branch_id = ?').run(BR);
  const d = today();
  for (let i = 0; i < 20; i++) {
    db.prepare(
      "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'income','fee',10000,?,'seed',?)",
    ).run(id('tx'), d, BR);
  }
  db.prepare(
    "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'expense','rent',40000,?,'seed',?)",
  ).run(id('tx'), d, BR);
  db.prepare(
    "INSERT OR REPLACE INTO finance_accounts (id,scope_type,scope_id,main_balance,saving_balance) VALUES ('fa_bos','branch',?,500000,50000)",
  ).run(BR);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('bos_campus', FIXED_ORG_ID, 'BOS Campus', 'BOSC');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'bos_campus');
  const pw = await hashPassword('testpass123');
  for (const u of [OWNER, FINANCE, MANAGER]) {
    db.prepare(
      `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(u.userId, u.username, u.fullName, u.branchId, pw);
    assignRole(u.userId, u.role, u.branchId);
  }

  // Small fixed cost so the 6-month reserve target is easily met and the
  // reserve guard is never the thing under test.
  db.prepare(
    "INSERT OR IGNORE INTO budget_lines (id,name,allocated_amount,cost_type,category_id,branch_id) VALUES ('bos_bl','Rent',1000,'fixed','sub_rent',?)",
  ).run(BR);
  app = createApp();
});

beforeEach(() => {
  resetPeriod();
  db.prepare('DELETE FROM teachers WHERE branch_id = ?').run(BR);
});

describe('BOS-1 · the period withdrawal ceiling is cumulative', () => {
  it('sequential withdrawals cannot exceed the ceiling published for the period', async () => {
    const initial = await calculate();
    const ceiling = initial.maxWithdrawable as number;
    expect(ceiling).toBeGreaterThan(0);

    // Drain aggressively: always ask for the currently reported maximum.
    for (let i = 0; i < 25; i++) {
      const max = Math.floor(((await calculate()).maxWithdrawable as number) - 1);
      if (max < 1) break;
      const res = await withdraw(max);
      if (res.status >= 400) break;
    }

    // The published ceiling is the promise. Honour it.
    expect(withdrawnTotal()).toBeLessThanOrEqual(ceiling + 0.01);
  });

  it('a second withdrawal is limited to the REMAINDER of the ceiling', async () => {
    const ceiling = (await calculate()).maxWithdrawable as number;
    const first = Math.floor(ceiling / 2);

    expect((await withdraw(first)).status).toBe(201);

    // Anything above the remaining headroom must be refused.
    const tooMuch = await withdraw(ceiling - first + 1);
    expect(tooMuch.status).toBe(409);

    // Exactly the remainder is still allowed.
    expect((await withdraw(ceiling - first)).status).toBe(201);
    expect(withdrawnTotal()).toBeLessThanOrEqual(ceiling + 0.01);

    // And nothing further.
    expect((await withdraw(1)).status).toBe(409);
  });

  it('the calculate endpoint reports the REMAINING headroom, not a replenished one', async () => {
    const ceiling = (await calculate()).maxWithdrawable as number;
    const take = Math.floor(ceiling / 4);
    expect((await withdraw(take)).status).toBe(201);

    const after = await calculate();
    // Previously this rose back towards the full ceiling because the payout
    // was subtracted from profit at only the tier percentage.
    expect(after.maxWithdrawable).toBeLessThanOrEqual(ceiling - take + 0.01);
  });

  it('cash actually leaves the account exactly once per accepted withdrawal', async () => {
    const before = mainBalance();
    const res = await withdraw(1000);
    expect(res.status).toBe(201);
    expect(mainBalance()).toBeCloseTo(before - 1000, 2);
    expect(withdrawnTotal()).toBeCloseTo(1000, 2);
  });

  it('a refused withdrawal moves no money at all', async () => {
    const ceiling = (await calculate()).maxWithdrawable as number;
    const before = mainBalance();
    const res = await withdraw(ceiling + 1);
    expect(res.status).toBe(409);
    expect(mainBalance()).toBe(before);
    expect(withdrawnTotal()).toBe(0);
  });

  it('serializes concurrent requests so only one can consume the published ceiling', async () => {
    const ceiling = (await calculate()).maxWithdrawable as number;
    const before = mainBalance();

    const responses = await Promise.all([withdraw(ceiling), withdraw(ceiling)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(withdrawnTotal()).toBe(ceiling);
    expect(mainBalance()).toBe(before - ceiling);
  });
});

describe('BOS · owner-approved warning thresholds', () => {
  it('warns only below three months of fixed costs', async () => {
    db.prepare(
      "UPDATE finance_accounts SET main_balance = 2999 WHERE scope_type='branch' AND scope_id=?",
    ).run(BR);
    expect((await warnings()).some((warning) => warning.title.includes('below 3 months'))).toBe(true);

    db.prepare(
      "UPDATE finance_accounts SET main_balance = 3000 WHERE scope_type='branch' AND scope_id=?",
    ).run(BR);
    expect((await warnings()).some((warning) => warning.title.includes('below 3 months'))).toBe(false);
  });

  it('warns below 80% teacher performance but not at the boundary', async () => {
    const insert = db.prepare(
      `INSERT INTO teachers (id, full_name, performance_score, branch_id, joined_date)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('bos_teacher_low', 'Low Teacher', 79.99, BR, today());
    insert.run('bos_teacher_boundary', 'Boundary Teacher', 80, BR, today());

    const titles = (await warnings()).map((warning) => warning.title);
    expect(titles.some((title) => title.includes('Low Teacher') && title.includes('below 80%'))).toBe(true);
    expect(titles.some((title) => title.includes('Boundary Teacher'))).toBe(false);
  });
});

describe('BOS · withdrawal authorization and input validation', () => {
  it('only an owner may withdraw', async () => {
    const before = mainBalance();
    for (const actor of [FINANCE, MANAGER]) {
      const res = await withdraw(100, actor);
      expect(res.status).toBe(403);
    }
    expect(mainBalance()).toBe(before);
    expect(withdrawnTotal()).toBe(0);
  });

  it.each([
    ['zero', 0],
    ['negative', -5000],
    ['sub-cent', 0.001],
    ['beyond precision', 1e15],
    ['text', 'abc'],
    ['array', [100]],
    ['object', {}],
    ['null', null],
    ['boolean', true],
  ])('rejects a %s amount and moves no money', async (_label, amount) => {
    const before = mainBalance();
    const res = await withdraw(amount);
    expect(res.status).toBe(400);
    expect(mainBalance()).toBe(before);
    expect(withdrawnTotal()).toBe(0);
  });

  it('blocks withdrawal while total branch liquidity is below its reserve target', async () => {
    db.prepare(
      "UPDATE finance_accounts SET main_balance = 5000, saving_balance = 0 WHERE scope_type='branch' AND scope_id=?",
    ).run(BR);
    const before = mainBalance();
    const res = await withdraw(100);
    expect(res.status).toBe(409);
    // TR-4 (kills bos mutant B5): the RESERVE pre-guard must answer with its
    // own contract. With the pre-guard removed, the liquidity-headroom guard
    // still refuses the withdrawal with 409 — money stays safe — but the
    // operator hears "0 AFN liquidity headroom" instead of the reserve
    // fund's actual state ("has not reached its 6-month minimum").
    expect(String(res.body?.error ?? '')).toMatch(/has not reached its 6-month minimum/);
    expect(mainBalance()).toBe(before);
  });

  it('allows only the liquidity headroom above the post-withdrawal reserve', async () => {
    // Fixed costs are 1,000 AFN, so the six-month reserve is 6,000 AFN.
    db.prepare(
      "UPDATE finance_accounts SET main_balance = 5000, saving_balance = 2000 WHERE scope_type='branch' AND scope_id=?",
    ).run(BR);

    const published = await calculate();
    expect(published.reserveFundTarget).toBe(6000);
    expect(published.reserveFundBalance).toBe(7000);
    expect(published.liquidityHeadroom).toBe(1000);
    expect(published.maxWithdrawable).toBe(1000);

    const tooMuch = await withdraw(1001);
    expect(tooMuch.status).toBe(409);
    expect(mainBalance()).toBe(5000);

    const exact = await withdraw(1000);
    expect(exact.status).toBe(201);
    expect(mainBalance()).toBe(4000);
    const account = db.prepare(
      "SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id=?",
    ).get(BR) as { main_balance: number; saving_balance: number };
    expect(account.main_balance + account.saving_balance).toBe(6000);
  });

  it('blocks withdrawal when the profit margin is below the lowest tier', async () => {
    // Push the margin under 10% so tierPercent is 0.
    db.prepare(
      "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'expense','rent',150000,?,'thin margin',?)",
    ).run(id('tx'), today(), BR);
    const res = await withdraw(100);
    expect(res.status).toBe(409);
    expect(withdrawnTotal()).toBe(0);
  });

  it('blocks a withdrawal larger than the cash actually in the main account', async () => {
    // The allowance is a share of PROFIT; cash on hand is a separate limit.
    // A profitable branch can still be short of cash (money already spent), and
    // the account has a CHECK (main_balance >= 0), so without this guard the
    // decrement would fail at the database instead of returning a clean 409.
    const ceiling = (await calculate()).maxWithdrawable as number;
    db.prepare("UPDATE finance_accounts SET main_balance = 10 WHERE scope_type='branch' AND scope_id=?").run(BR);

    const res = await withdraw(Math.min(ceiling, 5000));
    expect(res.status).toBe(409);
    expect(mainBalance()).toBe(10);
    expect(withdrawnTotal()).toBe(0);
  });

  it('historical distributions are never rewritten by a later withdrawal', async () => {
    expect((await withdraw(1000)).status).toBe(201);
    // Identify the row by its own id: ids are UUIDs, so ordering by id is not
    // insertion order and would compare different rows.
    const before = db
      .prepare("SELECT id, amount, date FROM financial_transactions WHERE finance_category_id='sub_owner_drawings' AND branch_id=?")
      .all(BR) as Array<{ id: string; amount: number; date: string }>;
    expect(before).toHaveLength(1);

    await withdraw(500);

    const after = db
      .prepare('SELECT id, amount, date FROM financial_transactions WHERE id = ?')
      .get(before[0].id);
    expect(after).toEqual(before[0]);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE finance_category_id='sub_owner_drawings' AND branch_id=?").get(BR) as { c: number }).c,
    ).toBe(2);
  });
});
