/**
 * BOS — management profit withdrawal integrity.
 *
 * `POST /api/bos/profit-distribution/withdraw` is the only money mutator in the
 * BOS router: it decrements branch cash and books a `profit_distribution`
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
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { bosRouter } from '../routes/bos.routes.js';

const BR = 'bos_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bos', bosRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string, branchId: string): TokenPayload => ({
  userId,
  username: userId,
  role: role as TokenPayload['role'],
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
    "SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='profit_distribution' AND branch_id=?",
  ).get(BR) as { s: number }).s;

const calculate = async () =>
  (await supertest(app).get(`/api/bos/profit-distribution/calculate?branchId=${BR}`).set(auth(OWNER))).body;

const withdraw = async (amount: unknown, actor: TokenPayload = OWNER) =>
  supertest(app).post(`/api/bos/profit-distribution/withdraw?branchId=${BR}`).set(auth(actor)).send({ amount });

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
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.role, u.branchId, pw);
  }
  syncLegacyUserRoles(db);
  // Small fixed cost so the 6-month reserve target is easily met and the
  // reserve guard is never the thing under test.
  db.prepare(
    "INSERT OR IGNORE INTO budget_lines (id,name,allocated_amount,cost_type,branch_id) VALUES ('bos_bl','Rent',1000,'fixed',?)",
  ).run(BR);
  app = createApp();
});

beforeEach(() => {
  resetPeriod();
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

  it('blocks withdrawal while the contingency reserve is below its target', async () => {
    db.prepare("UPDATE finance_accounts SET saving_balance = 0 WHERE scope_type='branch' AND scope_id=?").run(BR);
    const before = mainBalance();
    const res = await withdraw(100);
    expect(res.status).toBe(409);
    expect(mainBalance()).toBe(before);
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
      .prepare("SELECT id, amount, date FROM financial_transactions WHERE category='profit_distribution' AND branch_id=?")
      .all(BR) as Array<{ id: string; amount: number; date: string }>;
    expect(before).toHaveLength(1);

    await withdraw(500);

    const after = db
      .prepare('SELECT id, amount, date FROM financial_transactions WHERE id = ?')
      .get(before[0].id);
    expect(after).toEqual(before[0]);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE category='profit_distribution' AND branch_id=?").get(BR) as { c: number }).c,
    ).toBe(2);
  });
});
