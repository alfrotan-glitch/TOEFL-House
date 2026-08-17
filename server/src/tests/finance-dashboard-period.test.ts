/**
 * Finance command center — period semantics and money reconciliation (D-6).
 * ============================================================================
 * `GET /api/finance/dashboard` reported "this month" over a GREGORIAN window
 * while the UI labelled every date in Jalali. This suite pins the corrected
 * behaviour with money that lands specifically in the days the old window got
 * wrong: the 9-10 day gap between the start of the Gregorian month and the
 * start of the Shamsi month.
 *
 * The fixtures are dated relative to the REAL current Shamsi period, so the
 * suite keeps testing the boundary no matter when it runs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { periodBoundaries } from '../core/calendar/periods.js';
import { today } from '../utils/ids.js';

const BRANCH_A = 'fdp_a';
const BRANCH_B = 'fdp_b';
const TODAY = today();
const MONTH = periodBoundaries('month', TODAY);
const GREGORIAN_START = `${TODAY.slice(0, 7)}-01`;

let owner: TokenPayload;
let financeA: TokenPayload;
let app: express.Express;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

/** A date inside the Shamsi month but BEFORE the Gregorian month started. */
function dateInDivergenceGap(): string | null {
  if (MONTH.from >= GREGORIAN_START) return null; // no gap this month
  return MONTH.from;
}

const GAP_DATE = dateInDivergenceGap();
const GAP_INCOME = 77_000;
const IN_BOTH_INCOME = 25_000;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'FDP A', 'T')`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'FDP B', 'T')`).run(BRANCH_B);

  const insT = db.prepare(`INSERT INTO financial_transactions (id,type,category,amount,date,description,branch_id)
    VALUES (?,?,?,?,?,?,?)`);
  // Money inside the Shamsi month but outside the Gregorian one.
  if (GAP_DATE) insT.run('fdp_gap', 'income', 'fee', GAP_INCOME, GAP_DATE, 'gap income', BRANCH_A);
  // Money inside both windows.
  insT.run('fdp_both', 'income', 'fee', IN_BOTH_INCOME, TODAY, 'today income', BRANCH_A);
  insT.run('fdp_exp', 'expense', 'operational', 4_000, TODAY, 'today expense', BRANCH_A);
  // Another branch must never leak in.
  insT.run('fdp_b1', 'income', 'fee', 999_000, TODAY, 'branch B', BRANCH_B);
  // Money BEFORE the Shamsi month started must be excluded by both.
  const before = new Date(`${MONTH.from}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  const beforeMonth = before.toISOString().slice(0, 10);
  insT.run('fdp_prev', 'income', 'fee', 555_000, beforeMonth, 'previous month', BRANCH_A);

  // Payments drive `collectedThisMonth`. Without rows here, widening that
  // window is undetectable — the figure stays 0 either way.
  db.prepare(`INSERT OR IGNORE INTO students (id,student_code,full_name,status,registration_date,branch_id,gender,discount_percent)
    VALUES ('fdp_stu','FDP-1','FDP Student','active',?,?,'male',0)`).run(TODAY, BRANCH_A);
  const insP = db.prepare(`INSERT INTO payments (id,student_id,amount,date,payment_method,status,category,receipt_number,branch_id,idempotency_key)
    VALUES (?,'fdp_stu',?,?,'cash','completed','other',?,?,hex(randomblob(16)))`);
  insP.run('fdp_pay_now', 12_000, TODAY, 'R-FDP-1', BRANCH_A);
  if (GAP_DATE) insP.run('fdp_pay_gap', 8_000, GAP_DATE, 'R-FDP-2', BRANCH_A);
  // A payment BEFORE the Shamsi month must never be counted as collected now.
  insP.run('fdp_pay_old', 400_000, beforeMonth, 'R-FDP-3', BRANCH_A);
  // A large collection in ANOTHER branch. Without this row, dropping the branch
  // filter from collectedThisMonth is undetectable.
  db.prepare(`INSERT OR IGNORE INTO students (id,student_code,full_name,status,registration_date,branch_id,gender,discount_percent)
    VALUES ('fdp_stu_b','FDP-B1','FDP B Student','active',?,?,'male',0)`).run(TODAY, BRANCH_B);
  db.prepare(`INSERT INTO payments (id,student_id,amount,date,payment_method,status,category,receipt_number,branch_id,idempotency_key)
    VALUES ('fdp_pay_b','fdp_stu_b',333_000,?,'cash','completed','other','R-FDP-B1',?,hex(randomblob(16)))`).run(TODAY, BRANCH_B);

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insU = db.prepare(`INSERT OR IGNORE INTO users (id,username,password_hash,full_name,role,branch_id,must_change_password) VALUES (?,?,?,?,?,?,0)`);
  insU.run('fdp_owner', 'fdp_owner', pwd, 'Owner', 'owner', BRANCH_A);
  insU.run('fdp_fin', 'fdp_fin', pwd, 'Fin A', 'finance', BRANCH_A);
  syncLegacyUserRoles(db);
  owner = { userId: 'fdp_owner', username: 'fdp_owner', role: 'owner', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;
  financeA = { userId: 'fdp_fin', username: 'fdp_fin', role: 'finance', branchId: BRANCH_A, fullName: 'Fin A' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
});

describe('D-6 — "this month" is the Shamsi month', () => {
  it('reports the window it actually summed', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.status).toBe(200);
    expect(res.body.month.from).toBe(MONTH.from);
    expect(res.body.month.to).toBe(MONTH.to);
    expect(res.body.month.periodKey).toBe(MONTH.periodKey);
  });

  it('includes income from the days the Gregorian window wrongly excluded', async () => {
    if (!GAP_DATE) return; // Shamsi and Gregorian starts coincide this month
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.body.month.income).toBe(GAP_INCOME + IN_BOTH_INCOME);
    // The old Gregorian window would have reported only the later slice.
    expect(res.body.month.income).not.toBe(IN_BOTH_INCOME);
  });

  it('reconciles exactly with a direct SQL sum over the same window', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    for (const type of ['income', 'expense'] as const) {
      const truth = (db.prepare(
        `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions
          WHERE type=? AND branch_id=? AND date >= ? AND date <= ?`
      ).get(type, BRANCH_A, MONTH.from, MONTH.to) as { v: number }).v;
      expect(res.body.month[type]).toBe(truth);
    }
    expect(res.body.month.net).toBe(res.body.month.income - res.body.month.expense);
  });

  it('excludes money from before the Shamsi month began', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.body.month.income).toBeLessThan(555_000);
  });

  it('never sums a window that extends past today', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.body.month.to <= TODAY).toBe(true);
  });

  it('collectedThisMonth uses the same window as month income', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    const truth = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM payments
        WHERE status='completed' AND branch_id=? AND date >= ? AND date <= ?`
    ).get(BRANCH_A, MONTH.from, MONTH.to) as { v: number }).v;
    expect(res.body.receivables.collectedThisMonth).toBe(truth);
    expect(truth).toBeGreaterThan(0); // the assertion must have teeth
  });

  it('collectedThisMonth excludes payments from before the Shamsi month', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    // 400,000 was collected the day before the month opened.
    expect(res.body.receivables.collectedThisMonth).toBeLessThan(400_000);
    expect(res.body.receivables.collectedThisMonth).toBe(GAP_DATE ? 20_000 : 12_000);
  });

  it('collectedThisMonth includes the Gregorian-gap days (D-6)', async () => {
    if (!GAP_DATE) return;
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    // 8,000 was collected inside the Shamsi month but before 1 Gregorian.
    expect(res.body.receivables.collectedThisMonth).toBe(20_000);
    expect(res.body.receivables.collectedThisMonth).not.toBe(12_000);
  });

  it('collectedThisMonth is branch-scoped and excludes other branches', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    // Branch B collected 333,000 today; branch A must not see a cent of it.
    expect(res.body.receivables.collectedThisMonth).toBeLessThan(333_000);
    expect(res.body.receivables.collectedThisMonth).toBe(GAP_DATE ? 20_000 : 12_000);
    const all = await supertest(app).get('/api/finance/dashboard?branchId=all').set(authHeader(owner));
    expect(all.body.receivables.collectedThisMonth).toBe(res.body.receivables.collectedThisMonth + 333_000);
  });

  it('keeps branch isolation on every month figure', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(res.body.month.income).toBeLessThan(999_000);
    const all = await supertest(app).get('/api/finance/dashboard?branchId=all').set(authHeader(owner));
    expect(all.body.month.income).toBeGreaterThanOrEqual(res.body.month.income + 999_000);
  });
});

describe('14-day trend — axis and window share one date basis', () => {
  it('returns 14 contiguous days ending today', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    const trend = res.body.trend as Array<{ date: string }>;
    expect(trend).toHaveLength(14);
    expect(trend[13].date).toBe(TODAY);
    for (let i = 1; i < trend.length; i += 1) {
      const prev = new Date(`${trend[i - 1].date}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + 1);
      expect(trend[i].date).toBe(prev.toISOString().slice(0, 10));
    }
  });

  it('each trend day reconciles with the ledger for that day', async () => {
    const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    for (const row of res.body.trend as Array<{ date: string; income: number; expense: number }>) {
      const truth = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) inc,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) exp
           FROM financial_transactions WHERE date=? AND branch_id=?`
      ).get(row.date, BRANCH_A) as { inc: number; exp: number };
      expect(row.income).toBe(truth.inc);
      expect(row.expense).toBe(truth.exp);
    }
  });
});

describe('D-4 — the trend axis is correct in a non-UTC timezone', () => {
  /**
   * The test runner executes in UTC, where a Date round trip through a local
   * formatter happens to give the right answer. Under a zone behind UTC it does
   * not, and the whole 14-day axis shifts back a day while the SQL window stays
   * put. That is a live production risk (Kabul is UTC+4:30, and the app may be
   * operated from elsewhere), so the axis is asserted with the process zone
   * switched, which is the only way this class of bug is visible.
   */
  const withTZ = async <T>(tz: string, fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try { return await fn(); } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  };

  for (const tz of ['America/New_York', 'Asia/Kabul', 'Pacific/Apia']) {
    it(`ends on today and stays contiguous in ${tz}`, async () => {
      await withTZ(tz, async () => {
        const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
        const trend = res.body.trend as Array<{ date: string }>;
        expect(trend).toHaveLength(14);
        expect(trend[13].date).toBe(TODAY);
        expect(new Set(trend.map((t) => t.date)).size).toBe(14);
        for (let i = 1; i < trend.length; i += 1) {
          const prev = new Date(`${trend[i - 1].date}T00:00:00Z`);
          prev.setUTCDate(prev.getUTCDate() + 1);
          expect(trend[i].date).toBe(prev.toISOString().slice(0, 10));
        }
      });
    });

    it(`still reconciles each day with the ledger in ${tz}`, async () => {
      await withTZ(tz, async () => {
        const res = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
        const total = (res.body.trend as Array<{ income: number }>).reduce((a, r) => a + r.income, 0);
        const truth = (db.prepare(
          `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions
            WHERE type='income' AND branch_id=? AND date >= ? AND date <= ?`
        ).get(BRANCH_A, (res.body.trend as Array<{ date: string }>)[0].date, TODAY) as { v: number }).v;
        expect(total).toBe(truth);
      });
    });
  }
});

describe('D-10 — cached statements did not change behaviour', () => {
  it('returns identical payloads across repeated calls', async () => {
    const a = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    const b = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(a.body.month).toEqual(b.body.month);
    expect(a.body.today).toEqual(b.body.today);
    expect(a.body.budget).toEqual(b.body.budget);
    expect(a.body.receivables).toEqual(b.body.receivables);
  });

  it('a branch-scoped call after an all-branch call is still branch-scoped', async () => {
    // Shared prepared statements must not leak scope between callers.
    await supertest(app).get('/api/finance/dashboard?branchId=all').set(authHeader(owner));
    const scoped = await supertest(app).get('/api/finance/dashboard').set(authHeader(financeA));
    expect(scoped.body.scope).toBe('branch');
    expect(scoped.body.branchId).toBe(BRANCH_A);
    expect(scoped.body.month.income).toBeLessThan(999_000);
  });

  it('interleaved scopes stay independent under concurrency', async () => {
    const calls = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? supertest(app).get('/api/finance/dashboard').set(authHeader(financeA))
        : supertest(app).get('/api/finance/dashboard?branchId=all').set(authHeader(owner))
    );
    const results = await Promise.all(calls);
    results.forEach((r, i) => {
      if (i % 2 === 0) {
        expect(r.body.scope).toBe('branch');
        expect(r.body.month.income).toBeLessThan(999_000);
      } else {
        expect(r.body.scope).toBe('organization');
      }
    });
  });
});
