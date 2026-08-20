/**
 * Period totals are summed by the database, never by the client.
 * ============================================================================
 * F-8 (proven live, 2026-08-16 third audit pass):
 *
 *   The finance Ledger panel displayed "Period income / Period expenses / Net"
 *   computed as `rows.reduce(...)` over the CURRENT PAGE. With 90 transactions
 *   in the period and a 50-row page it reported 0 AFN income against a true
 *   700 AFN.
 *
 *   The failure mode is the dangerous kind: the number is understated, looks
 *   entirely plausible, needs no error to appear, and drifts further from
 *   reality with every transaction the institute records.
 *
 *   The file's own header comment claimed "the backend is the single source of
 *   financial truth" while the code below it did the opposite — and the very
 *   same defect had already been found and fixed on the dashboard KPI tiles,
 *   whose comment documents an identical 99,311 AFN shortfall. The pattern was
 *   known; this instance was simply missed.
 *
 * Fix: the panel takes rows from /finance/transactions (paginated, now with
 * includeTotal=1) and TOTALS from /finance/pnl, which aggregates the whole
 * period in SQL.
 *
 * These tests pin the backend half of that contract: /finance/pnl must equal a
 * full-ledger sum, and must NOT vary with pagination. A frontend that consumes
 * it then cannot silently drift.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import financeRouter from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'lpt_branch';
const FROM = '2026-01-01';
const TO = '2026-12-31';
/** Deliberately larger than one page so a page-sum and a true sum differ. */
const INCOME_ROWS = 120;
let INCOME_CATEGORIES: string[] = [];
let EXPENSE_CATEGORIES: string[] = [];
const INCOME_EACH = 250;
const EXPENSE_ROWS = 30;
const EXPENSE_EACH = 400;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
  return app;
}
const auth = () => ({
  Authorization: `Bearer ${signToken({
    userId: 'u_lpt', username: 'u_lpt', branchId: BRANCH, fullName: 'Ledger Owner',
  } as TokenPayload)}`,
});

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('u_lpt', 'u_lpt', 'Ledger Owner', ?, ?, 1, 0)`,
  ).run(BRANCH, pw);
  assignRole('u_lpt', 'owner', BRANCH);

  db.prepare(`DELETE FROM financial_transactions WHERE id LIKE 'lpt_%'`).run();
  const ins = db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // Several categories on purpose: /finance/pnl aggregates GROUP BY
  // type+category, so a single-category fixture cannot detect a truncated
  // aggregate (a LIMIT on that query would still return the only group).
  INCOME_CATEGORIES = ['fee', 'book', 'exam', 'card', 'installment'];
  EXPENSE_CATEGORIES = ['salary', 'rent', 'utilities'];
  const seed = db.transaction(() => {
    for (let i = 0; i < INCOME_ROWS; i++) {
      ins.run(`lpt_i${i}`, 'income', INCOME_CATEGORIES[i % INCOME_CATEGORIES.length], INCOME_EACH,
        `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, `income ${i}`, BRANCH);
    }
    for (let i = 0; i < EXPENSE_ROWS; i++) {
      ins.run(`lpt_e${i}`, 'expense', EXPENSE_CATEGORIES[i % EXPENSE_CATEGORIES.length], EXPENSE_EACH,
        `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, `expense ${i}`, BRANCH);
    }
  });
  seed();

  app = createApp();
});

const TRUE_INCOME = INCOME_ROWS * INCOME_EACH;
const TRUE_EXPENSE = EXPENSE_ROWS * EXPENSE_EACH;

describe('F-8: authoritative period totals', () => {
  it('/finance/pnl equals the full-ledger sum, not a page of it', async () => {
    const res = await supertest(app).get(`/api/finance/pnl?from=${FROM}&to=${TO}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.income).toBe(TRUE_INCOME);
    expect(res.body.expense).toBe(TRUE_EXPENSE);
    expect(res.body.net).toBe(TRUE_INCOME - TRUE_EXPENSE);

    // Every category must survive the aggregate. Asserting only the totals
    // lets a truncated GROUP BY pass whenever the fixture is thin.
    const cats = res.body.byCategory as { type: string; category: string }[];
    expect(new Set(cats.filter((c) => c.type === 'income').map((c) => c.category)))
      .toEqual(new Set(INCOME_CATEGORIES));
    expect(new Set(cats.filter((c) => c.type === 'expense').map((c) => c.category)))
      .toEqual(new Set(EXPENSE_CATEGORIES));
  });

  it('the totals do not change with the caller\'s page size', async () => {
    // The whole point: a consumer paging through the ledger must see one
    // stable set of period figures regardless of how it paginates.
    const base = await supertest(app).get(`/api/finance/pnl?from=${FROM}&to=${TO}`).set(auth());
    for (const limit of [1, 10, 50, 2000]) {
      const page = await supertest(app)
        .get(`/api/finance/transactions?from=${FROM}&to=${TO}&limit=${limit}&offset=0&includeTotal=1`)
        .set(auth());
      expect(page.status).toBe(200);
      expect(page.body.total, 'total must count the period, not the page').toBe(INCOME_ROWS + EXPENSE_ROWS);
      expect(page.body.rows.length).toBeLessThanOrEqual(limit);

      const again = await supertest(app).get(`/api/finance/pnl?from=${FROM}&to=${TO}`).set(auth());
      expect(again.body.income).toBe(base.body.income);
      expect(again.body.expense).toBe(base.body.expense);
    }
  });

  it('summing one page would be WRONG — the defect is real, not theoretical', async () => {
    const page = await supertest(app)
      .get(`/api/finance/transactions?from=${FROM}&to=${TO}&limit=50&offset=0&includeTotal=1`)
      .set(auth());
    const pageIncome = (page.body.rows as { type: string; amount: number }[])
      .filter((t) => t.type === 'income')
      .reduce((s, t) => s + t.amount, 0);

    // This is exactly what the UI used to render as "Period income".
    expect(pageIncome).not.toBe(TRUE_INCOME);
    expect(pageIncome).toBeLessThan(TRUE_INCOME);
  });

  it('includeTotal=1 returns a page plus the period count', async () => {
    const res = await supertest(app)
      .get(`/api/finance/transactions?from=${FROM}&to=${TO}&limit=50&offset=0&includeTotal=1`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBe(50);
    expect(res.body.total).toBe(INCOME_ROWS + EXPENSE_ROWS);
  });

  it('paging through the whole period reproduces the authoritative total exactly', async () => {
    // No approximation is acceptable in reconciliation: walking every page must
    // land on the same figure /finance/pnl reports in one query.
    let offset = 0;
    let income = 0;
    let seen = 0;
    for (;;) {
      const res = await supertest(app)
        .get(`/api/finance/transactions?from=${FROM}&to=${TO}&limit=40&offset=${offset}&includeTotal=1`)
        .set(auth());
      const rows = res.body.rows as { type: string; amount: number }[];
      if (rows.length === 0) break;
      income += rows.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      seen += rows.length;
      offset += 40;
      if (offset > 1000) break; // guard against a pagination bug looping forever
    }
    expect(seen).toBe(INCOME_ROWS + EXPENSE_ROWS);

    const pnl = await supertest(app).get(`/api/finance/pnl?from=${FROM}&to=${TO}`).set(auth());
    expect(income).toBe(pnl.body.income);
  });
});
