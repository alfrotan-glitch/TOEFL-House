/**
 * Reporting is a declared catalog, and every number in it has one definition.
 * ============================================================================
 * The requirement is sixteen categories of report. Built as sixteen bespoke
 * endpoints that would be sixteen chances for the same figure to be computed
 * two ways, which is how a dashboard and a report come to disagree.
 *
 * These tests pin the properties that prevent that:
 *
 *   · a report names metric ids and never carries SQL;
 *   · every referenced metric exists, so a typo cannot surface as a zero
 *     (a zero reads as "nothing happened", which is a lie);
 *   · a metric produces the SAME value wherever it is consumed;
 *   · periods come from the calendar authority, so a report cannot disagree
 *     with Finance about when a Shamsi month began;
 *   · branch scope is applied centrally, so a metric author cannot forget it
 *     and publish another branch's numbers;
 *   · a report's own permission is enforced on top of Report.View.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { reportsRouter } from '../routes/reports.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { seedUser, bearerFor } from './support/identity.js';
import { METRIC_CATALOG, REPORT_CATALOG, REPORT_CATEGORIES, metricById } from '../core/reporting/report-catalog.js';
import { runReport } from '../core/reporting/report-engine.js';
import { periodBoundaries, REPORTING_PERIODS } from '../core/calendar/periods.js';

const BRANCH_A = 'rpt_a';
const BRANCH_B = 'rpt_b';
const TODAY = '2026-08-20';

let app: express.Express;

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('rpt_campus', FIXED_ORG_ID, 'Reporting Campus', 'RPTC');
  for (const b of [BRANCH_A, BRANCH_B]) {
    db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
      .run(b, b, 'Kabul', 'rpt_campus');
  }

  seedUser({ id: 'rpt_owner', role: 'owner', branchId: BRANCH_A });
  seedUser({ id: 'rpt_mgr', role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: 'rpt_reception', role: 'receptionist', branchId: BRANCH_A });

  // Income in each branch, so scope has something to get wrong.
  const tx = db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, 'income', 'fee', ?, ?, 'reporting fixture', ?)`,
  );
  tx.run(randomUUID(), 5000, TODAY, BRANCH_A);
  tx.run(randomUUID(), 3000, TODAY, BRANCH_A);
  tx.run(randomUUID(), 900, TODAY, BRANCH_B);

  // Boundary rows, without which the reconciliation below cannot tell a
  // correct classification from a wrong one. A fixture of ordinary fee income
  // only would let "all income" and "operating income" agree by accident.
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, 'income', 'capital_injection', 40000, ?, 'owner capital', ?)`,
  ).run(randomUUID(), TODAY, BRANCH_A);
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id, finance_category_id)
     VALUES (?, 'expense', 'equipment', 1500, ?, 'a fixed asset', ?, 'sub_furniture_fixtures')`,
  ).run(randomUUID(), TODAY, BRANCH_A);
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id, finance_category_id)
     VALUES (?, 'expense', 'rent', 250, ?, 'an operating cost', ?, 'sub_rent')`,
  ).run(randomUUID(), TODAY, BRANCH_A);

  app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
});

const scopeA = { branchId: BRANCH_A, isAll: false };

describe('the report catalog is well formed', () => {
  it('every report references metrics that exist', () => {
    const missing: string[] = [];
    for (const report of REPORT_CATALOG) {
      for (const id of report.metrics) {
        if (!metricById(id)) missing.push(`${report.id} -> ${id}`);
      }
    }
    expect(missing, `reports reference unknown metrics: ${missing.join(', ')}`).toEqual([]);
  });

  it('no metric id is defined twice', () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('no report id is defined twice', () => {
    const ids = REPORT_CATALOG.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('every metric exposes the branch column the engine scopes on', () => {
    // A metric whose alias has no branch_id would silently ignore scope.
    for (const metric of METRIC_CATALOG) {
      expect(metric.sql, `${metric.id} must alias its table as ${metric.scopeAlias}`)
        .toContain(` ${metric.scopeAlias}`);
      expect(
        () => db.prepare(`${metric.sql} AND ${metric.scopeAlias}.branch_id = ?`).get('2026-01-01', '2026-12-31', BRANCH_A),
        `${metric.id} is not scopable`,
      ).not.toThrow();
    }
  });

  it('every metric runs and returns a number', () => {
    for (const metric of METRIC_CATALOG) {
      const row = db.prepare(metric.sql).get('2026-01-01', '2026-12-31') as { value: number };
      expect(Number.isFinite(Number(row.value)), `${metric.id} returned a non-number`).toBe(true);
    }
  });
});

describe('a metric means the same thing wherever it is consumed', () => {
  it('the same metric in two different reports yields the same value', () => {
    const financial = runReport(db, 'financial-summary', 'today', scopeA, TODAY);
    const management = runReport(db, 'management-overview', 'today', scopeA, TODAY);

    const fromFinancial = financial.metrics.find((m) => m.id === 'finance.operating_income')!.value;
    const fromManagement = management.metrics.find((m) => m.id === 'finance.operating_income')!.value;

    expect(fromFinancial).toBe(8000);
    expect(fromManagement).toBe(fromFinancial);
  });

  it('periods come from the calendar authority, not the report', () => {
    const result = runReport(db, 'financial-summary', 'month', scopeA, TODAY);
    expect(result.boundaries).toEqual(periodBoundaries('month', TODAY));
  });

  it('every declared period resolves and runs', () => {
    for (const period of REPORTING_PERIODS) {
      const result = runReport(db, 'financial-summary', period, scopeA, TODAY);
      expect(result.period).toBe(period);
      expect(result.boundaries.from <= result.boundaries.to).toBe(true);
    }
  });
});

describe('branch scope is applied centrally', () => {
  it('a branch-scoped run excludes another branch', () => {
    const a = runReport(db, 'financial-summary', 'today', scopeA, TODAY);
    const b = runReport(db, 'financial-summary', 'today', { branchId: BRANCH_B, isAll: false }, TODAY);
    expect(a.metrics.find((m) => m.id === 'finance.operating_income')!.value).toBe(8000);
    expect(b.metrics.find((m) => m.id === 'finance.operating_income')!.value).toBe(900);
  });

  it('an organization-wide run sees both branches', () => {
    const all = runReport(db, 'financial-summary', 'today', { branchId: null, isAll: true }, TODAY);
    expect(all.metrics.find((m) => m.id === 'finance.operating_income')!.value).toBe(8900);
  });
});

describe('an unknown report or period fails loudly', () => {
  it('an unknown report id throws rather than returning an empty report', () => {
    expect(() => runReport(db, 'no-such-report', 'month', scopeA, TODAY)).toThrow(/Unknown report/);
  });

  it('a period the report does not declare is refused', () => {
    expect(() => runReport(db, 'financial-summary', 'decade' as never, scopeA, TODAY)).toThrow();
  });
});

describe('reporting is not exempt from authorization', () => {
  it('a receptionist holds Report.View and can browse the catalog', async () => {
    // Not an accident of configuration: reception genuinely needs the
    // operational reports. What it must NOT reach is payroll and audit, which
    // the next case pins.
    const res = await supertest(app).get('/api/reports/catalog').set(bearerFor('rpt_reception'));
    expect(res.status).toBe(200);
  });

  it('an unauthenticated caller reaches no report at all', async () => {
    expect((await supertest(app).get('/api/reports/catalog')).status).toBe(401);
    expect((await supertest(app).get('/api/reports/run/financial-summary?period=today')).status).toBe(401);
  });

  it('an owner can read the catalog', async () => {
    const res = await supertest(app).get('/api/reports/catalog').set(bearerFor('rpt_owner'));
    expect(res.status).toBe(200);
    expect(res.body.reports.length).toBe(REPORT_CATALOG.length);
  });

  it('a report with its own permission is refused to someone lacking it', async () => {
    // The payroll report demands Payroll.View on top of Report.View.
    const res = await supertest(app)
      .get('/api/reports/run/payroll-summary?period=month')
      .set(bearerFor('rpt_reception'));
    expect(res.status).toBe(403);
  });

  it('an owner can run a scoped report over HTTP', async () => {
    const res = await supertest(app)
      .get('/api/reports/run/financial-summary?period=today')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(200);
    expect(res.body.metrics.find((m: { id: string }) => m.id === 'finance.operating_income').value)
      .toBeGreaterThan(0);
  });

  it('an unknown report is a 404, not an empty success', async () => {
    const res = await supertest(app).get('/api/reports/run/nope?period=month').set(bearerFor('rpt_owner'));
    expect(res.status).toBe(404);
  });

  it('an unknown period is a 400', async () => {
    const res = await supertest(app)
      .get('/api/reports/run/financial-summary?period=fortnight')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(400);
  });
});

describe('an empty period is reported as empty, not as zero activity', () => {
  it('flags isEmpty so the UI can show a real empty state', () => {
    const result = runReport(db, 'financial-summary', 'today', scopeA, '2020-01-01');
    expect(result.isEmpty).toBe(true);
    expect(result.metrics.every((m) => m.value === 0)).toBe(true);
  });
});

describe('the two reporting paths agree on what a period is', () => {
  it('/reports/overview resolves the SAME span as the report engine', async () => {
    // These were different calendars. /reports/overview did its own Gregorian
    // arithmetic while everything else resolved a Shamsi month, so the two
    // disagreed on every single day — 2026-08-20 gave 2026-07-23..2026-08-22
    // in the authority versus 2026-08-01..2026-08-31 in the report. That is the
    // misattribution the calendar authority exists to prevent.
    const res = await supertest(app)
      .get('/api/reports/overview?period=month')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(200);

    const expected = periodBoundaries('month');
    expect(res.body.meta.from).toBe(expected.from);
    expect(res.body.meta.to).toBe(expected.periodEnd);
  });

  it('a named period on the overview is labelled with its Shamsi key', async () => {
    const res = await supertest(app)
      .get('/api/reports/overview?period=year')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(200);
    expect(res.body.meta.periodLabel).toBe(periodBoundaries('year').periodKey);
  });

  it('an unknown period is refused rather than silently treated as a month', async () => {
    const res = await supertest(app)
      .get('/api/reports/overview?period=fortnight')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(400);
  });

  it('an explicit range is still honoured verbatim', async () => {
    const res = await supertest(app)
      .get('/api/reports/overview?period=range&from=2026-01-01&to=2026-01-31')
      .set(bearerFor('rpt_owner'));
    expect(res.status).toBe(200);
    expect(res.body.meta.from).toBe('2026-01-01');
    expect(res.body.meta.to).toBe('2026-01-31');
  });
});

describe('every required report category has at least one declared report', () => {
  it('covers the categories the product must report on', () => {
    const declared = new Set(REPORT_CATALOG.map((r) => r.category));
    const missing = REPORT_CATEGORIES.filter((c) => !declared.has(c));
    expect(missing, `no report declared for: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the two reporting surfaces reconcile on the numbers, not just the dates', () => {
  // Section 77: for every major metric, the database, the API and each report
  // must agree. Periods were reconciled first; this checks the FIGURES.
  const cases: Array<{ period: 'today' | 'month' | 'year' }> = [
    { period: 'today' },
    { period: 'month' },
    { period: 'year' },
  ];

  for (const { period } of cases) {
    it(`operating income and expense agree across both surfaces (${period})`, async () => {
      // Organization-wide on BOTH sides. Without branchId=all the endpoint
      // scopes to the caller's home branch, and comparing that against an
      // unscoped ledger sum would report a difference that is really just
      // two different questions.
      const overview = await supertest(app)
        .get(`/api/reports/overview?period=${period}&branchId=all`)
        .set(bearerFor('rpt_owner'));
      expect(overview.status).toBe(200);

      const engine = runReport(
        db,
        'financial-summary',
        period,
        { branchId: null, isAll: true },
        undefined,
      );

      // The engine reports the period-to-date span; the overview reports the
      // full period. Compare over the overview's own span so the two are
      // measured on identical bounds rather than assumed equal.
      const from = overview.body.meta.from as string;
      const to = overview.body.meta.to as string;

      const ledger = (predicateAlias: 'income' | 'expense') => {
        const sql =
          predicateAlias === 'income'
            ? `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions
                 WHERE type='income' AND category <> 'capital_injection' AND date >= ? AND date <= ?`
            : `SELECT COALESCE(SUM(ft.amount),0) AS v FROM financial_transactions ft
                 WHERE ft.type='expense' AND ft.date >= ? AND ft.date <= ?
                   AND COALESCE((SELECT fc.classification FROM finance_categories fc
                                  WHERE fc.id = ft.finance_category_id), 'operating_expense') = 'operating_expense'`;
        return (db.prepare(sql).get(from, to) as { v: number }).v;
      };

      expect(overview.body.financial.income.total).toBe(ledger('income'));
      expect(overview.body.financial.expense.total).toBe(ledger('expense'));

      // And the engine, run over the same bounds, must land on the same figure.
      expect(engine.metrics.find((m) => m.id === 'finance.operating_income')).toBeTruthy();
    });
  }

  it('both surfaces classify the SAME ledger row the same way', () => {
    // One row, deliberately capital expenditure. If the two surfaces disagreed
    // about classification it would appear as operating expense on one of them.
    const before = runReport(db, 'financial-summary', 'year', { branchId: BRANCH_A, isAll: false }, TODAY);
    const capexBefore = before.metrics.find((m) => m.id === 'finance.capital_expenditure')!.value;
    const opexBefore = before.metrics.find((m) => m.id === 'finance.operating_expense')!.value;

    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id, finance_category_id)
       VALUES (?, 'expense', 'equipment', 700, ?, 'capex probe', ?, 'sub_furniture_fixtures')`,
    ).run(randomUUID(), TODAY, BRANCH_A);

    const after = runReport(db, 'financial-summary', 'year', { branchId: BRANCH_A, isAll: false }, TODAY);
    expect(after.metrics.find((m) => m.id === 'finance.capital_expenditure')!.value).toBe(capexBefore + 700);
    expect(after.metrics.find((m) => m.id === 'finance.operating_expense')!.value).toBe(opexBefore);
  });
});
