/**
 * BOS profit distribution resolves its period through the calendar authority.
 * ============================================================================
 * The withdrawable ceiling is computed over "this month". BOS decided what that
 * meant on its own:
 *
 *     const month = today().slice(0, 7);
 *     return { from: `${month}-01`, to: `${month}-31` };
 *
 * That is a GREGORIAN month. Finance, payroll, the dashboard and every report
 * resolve a SHAMSI month through `periodBoundaries` (D-28). Sampled across
 * eight dates the two windows disagreed 8/8 times — on 2026-08-20 the authority
 * gives 2026-07-23..2026-08-20 while BOS gives 2026-08-01..2026-08-31.
 *
 * This is the same defect already fixed once for `/reports/overview`, but here
 * it does not merely misreport: it decides HOW MUCH CASH AN OWNER MAY WITHDRAW.
 *
 * WHY THE DISAGREEMENT IS A MONEY DEFECT, NOT A DISPLAY ONE
 *
 * The ceiling is `profit * tierPercent` MINUS the distributions already taken
 * in the period — the subtraction is what closes the limit (BOS-1). Both halves
 * are queried with the same window, so if the window is wrong the subtraction
 * misses distributions that belong to the accounting period. On any day where
 * the Shamsi month began in the previous Gregorian month, every drawing taken
 * in those straddling days is invisible to the check and the ceiling re-opens.
 *
 * BOS's window is also unbounded at the end: it runs to the 31st, days into the
 * future, while the authority stops at today. A future-dated transaction is
 * inside BOS's period and outside the real one.
 *
 * The invariant: BOS's period IS the system's period, and total distributions
 * within an accounting period never exceed that period's computed ceiling.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { bosRouter } from '../routes/bos.routes.js';
import { periodBoundaries } from '../core/calendar/periods.js';
import { TREASURY_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { computeProfitDistribution, resolveDistributionTier } from '../core/finance/profit-distribution.js';

const BR = 'bos_cal_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bos', bosRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, branchId: string): TokenPayload => ({
  userId,
  username: userId,
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });
const OWNER = tok('bos_cal_owner', BR);

let app: ReturnType<typeof createApp>;

const calculate = async () =>
  (await supertest(app).get(`/api/bos/profit-distribution/calculate?branchId=${BR}`).set(auth(OWNER)))
    .body;

const withdraw = async (amount: number) =>
  supertest(app)
    .post(`/api/bos/profit-distribution/withdraw?branchId=${BR}`)
    .set(auth(OWNER))
    .send({ amount });

const drawingsTotal = () =>
  (
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE finance_category_id='sub_owner_drawings' AND branch_id=?",
      )
      .get(BR) as { s: number }
  ).s;

function income(amount: number, date: string) {
  db.prepare(
    "INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id) VALUES (?,'income','fee',?,?,'seed',?)",
  ).run(id('tx'), amount, date, BR);
}

/** A drawing recorded the way the withdraw endpoint records one. */
function seedDrawing(amount: number, date: string) {
  db.prepare(
    `INSERT INTO financial_transactions (id,type,category,finance_category_id,amount,date,description,branch_id)
     VALUES (?,'expense','owner_drawing','sub_owner_drawings',?,?,'prior drawing',?)`,
  ).run(id('tx'), amount, date, BR);
}

function resetPeriod() {
  db.prepare('DELETE FROM financial_transactions WHERE branch_id = ?').run(BR);
  db.prepare(
    "INSERT OR REPLACE INTO finance_accounts (id,scope_type,scope_id,main_balance,saving_balance) VALUES ('fa_bos_cal','branch',?,5000000,5000000)",
  ).run(BR);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare(
    'INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)',
  ).run('bos_cal_campus', FIXED_ORG_ID, 'BOS Cal Campus', 'BOSCC');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)').run(
    BR,
    BR,
    'Loc',
    'bos_cal_campus',
  );
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
     VALUES (?,?,?,?,?,1,0)`,
  ).run(OWNER.userId, OWNER.username, OWNER.fullName, BR, await hashPassword('x'.repeat(12)));
  assignRole(OWNER.userId, 'owner', null);
  // No fixed-cost budget lines, so the reserve target is 0 and the reserve gate
  // is satisfied — this suite is about the PERIOD, not the reserve.
  app = createApp();
});

beforeEach(() => {
  resetPeriod();
});

describe('BOS resolves "this month" through the calendar authority', () => {
  it('the period BOS reports is the period the authority defines', async () => {
    const canonical = periodBoundaries('month', today());
    const body = await calculate();
    expect(body.periodFrom).toBe(canonical.from);
    expect(body.periodTo).toBe(canonical.to);
  });

  it('the period never extends past today', async () => {
    const body = await calculate();
    expect(body.periodTo <= today()).toBe(true);
  });
});

describe('the ceiling accounts for drawings taken earlier in the accounting month', () => {
  /**
   * The straddle: on any date whose Shamsi month began in the previous
   * Gregorian month, these days belong to the accounting period but fall
   * outside a `YYYY-MM-01..YYYY-MM-31` window.
   */
  const canonical = periodBoundaries('month', today());
  const gregorianFrom = `${today().slice(0, 7)}-01`;
  const straddleDate = canonical.from;
  const straddles = straddleDate < gregorianFrom;

  it('the calendars genuinely disagree on this date (guards the test itself)', () => {
    // If this ever fails the suite below proves nothing, so it is asserted
    // rather than assumed.
    expect(canonical.from === gregorianFrom && canonical.to === `${today().slice(0, 7)}-31`).toBe(
      false,
    );
  });

  it('a drawing inside the accounting month reduces the remaining ceiling', async () => {
    income(1_000_000, today());
    const before = await calculate();
    expect(before.maxWithdrawable).toBeGreaterThan(0);

    const prior = 50_000;
    seedDrawing(prior, straddles ? straddleDate : today());

    const after = await calculate();
    // Gross profit adds distributions back, so the allowance is unchanged and
    // the whole reduction must come from the subtraction.
    expect(after.maxWithdrawable).toBe(before.maxWithdrawable - prior);
  });

  it('total drawings in the accounting month cannot exceed the published ceiling', async () => {
    income(1_000_000, today());
    const published = (await calculate()).maxWithdrawable;
    expect(published).toBeGreaterThan(0);

    // A drawing already taken earlier in the SAME accounting month.
    const prior = Math.floor(published / 2);
    seedDrawing(prior, straddles ? straddleDate : today());

    // Ask for the full published ceiling again. Only the remainder may pass.
    const res = await withdraw(published);
    if (res.status === 201 || res.status === 200) {
      expect(drawingsTotal()).toBeLessThanOrEqual(published);
    } else {
      expect(res.status).toBe(409);
      expect(drawingsTotal()).toBe(prior);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE TIER TABLE IS DECLARED POLICY, NOT A CONSTANT IN A ROUTE (A-10)
// ══════════════════════════════════════════════════════════════════════════
/**
 * LAW 7 forbids an unexplained business number. The withdrawal tiers, the
 * six-month reserve multiple and the warning thresholds lived as literals
 * inside `bos.routes.ts` — numbers that decide how much cash leaves the
 * building, findable only by reading the handler.
 *
 * They are now declared in the configuration catalog at exactly the values the
 * route used. This states the policy; it does not decide it. Whether 20% and
 * six months are the RIGHT numbers remains an owner question (A-10) — but it is
 * now a question about a visible, named, changeable default rather than about a
 * hidden constant.
 *
 * These tests pin the values so a change to them is a deliberate, reviewed edit
 * rather than a silent one.
 */
describe('treasury policy is declared, and the tiers behave as declared', () => {
  it('the declared tiers are the ones the product has always applied', () => {
    expect(TREASURY_DEFAULTS.profitDistributionTiers).toEqual([
      { minMarginPercent: 30, sharePercent: 20 },
      { minMarginPercent: 20, sharePercent: 15 },
      { minMarginPercent: 10, sharePercent: 10 },
    ]);
    expect(TREASURY_DEFAULTS.reserveFundMonths).toBe(6);
  });

  it('bands are ordered highest-first, or the first match would be wrong', () => {
    const mins = TREASURY_DEFAULTS.profitDistributionTiers.map((b) => b.minMarginPercent);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });

  /** Reproduces the original if/else chain exactly, including its boundaries. */
  it.each([
    [-50, 0],
    [0, 0],
    [9.99, 0],
    [10, 10],
    [19.99, 10],
    [20, 15],
    [29.99, 15],
    [30, 20],
    [100, 20],
  ])('a %s%% margin earns a %s%% share', (margin, expected) => {
    expect(resolveDistributionTier(margin)).toBe(expected);
  });

  it('a loss distributes nothing', () => {
    const position = computeProfitDistribution({
      revenue: 100_000,
      expense: 150_000,
      distributed: 0,
      fixedTotal: 0,
      reserveBalance: 0,
    });
    expect(position.profit).toBeLessThan(0);
    expect(position.tierPercent).toBe(0);
    expect(position.maxWithdrawable).toBe(0);
  });

  it('the reserve target is the declared multiple of fixed cost', () => {
    const position = computeProfitDistribution({
      revenue: 0,
      expense: 0,
      distributed: 0,
      fixedTotal: 10_000,
      reserveBalance: 0,
    });
    expect(position.reserveFundTarget).toBe(10_000 * TREASURY_DEFAULTS.reserveFundMonths);
  });

  it('an unmet reserve closes the ceiling entirely, it does not merely warn', () => {
    const base = {
      revenue: 1_000_000,
      expense: 500_000,
      distributed: 0,
      fixedTotal: 10_000,
    };
    const short = computeProfitDistribution({ ...base, reserveBalance: 0 });
    const met = computeProfitDistribution({ ...base, reserveBalance: 10_000_000 });
    expect(short.periodAllowance).toBeGreaterThan(0);
    expect(short.maxWithdrawable).toBe(0);
    expect(met.maxWithdrawable).toBe(met.periodAllowance);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE PUBLISHED CEILING IS THE ENFORCED CEILING (§77)
// ══════════════════════════════════════════════════════════════════════════
describe('publish and enforce cannot be different numbers', () => {
  it('the route publishes exactly what the authority computes', async () => {
    income(800_000, today());
    const published = await calculate();

    const direct = computeProfitDistribution({
      revenue: 800_000,
      expense: 0,
      distributed: 0,
      fixedTotal: 0,
      reserveBalance: 5_000_000,
    });

    expect(published.maxWithdrawable).toBe(direct.maxWithdrawable);
    expect(published.tierPercent).toBe(direct.tierPercent);
    expect(published.periodAllowance).toBe(direct.periodAllowance);
  });

  it('withdrawing exactly the published ceiling succeeds, and one afghani more does not', async () => {
    income(800_000, today());
    const ceiling = (await calculate()).maxWithdrawable;
    expect(ceiling).toBeGreaterThan(0);

    const tooMuch = await withdraw(ceiling + 1);
    expect(tooMuch.status).toBe(409);
    expect(drawingsTotal()).toBe(0);

    const exact = await withdraw(ceiling);
    expect(exact.status).toBe(201);
    expect(drawingsTotal()).toBe(ceiling);

    // And the ceiling is now closed rather than replenished (BOS-1).
    expect((await calculate()).maxWithdrawable).toBe(0);
  });
});
