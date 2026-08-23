import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { reportsRouter } from '../../../routes/reports.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import { periodBoundaries, periodBoundariesForKey } from '../../../core/calendar/periods.js';

const BRANCH = 'wp11_report_branch';
const TODAY = '2026-08-20';

let app: express.Express;

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp11_report_campus', FIXED_ORG_ID, 'WP11 Reporting Campus', 'WP11R');
  db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'WP11 Reporting Branch', 'Kabul', 'wp11_report_campus');

  seedUser({ id: 'wp11_report_owner', role: 'owner', branchId: BRANCH });
  seedUser({ id: 'wp11_report_reception', role: 'receptionist', branchId: BRANCH });

  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, 'income', 'fee', 1200, ?, 'wp11 reporting fixture', ?)`,
  ).run(randomUUID(), TODAY, BRANCH);

  app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  app.use(errorHandler);
});

describe('WP-11 reporting window and catalog contracts', () => {
  it('filters the catalog by each report definition permission', async () => {
    const res = await supertest(app)
      .get('/api/reports/catalog')
      .set(bearerFor('wp11_report_reception'));

    expect(res.status).toBe(200);
    expect(res.body.maxRangeDays).toBe(366);
    expect(res.body.reports.some((report: { id: string }) => report.id === 'financial-summary')).toBe(true);
    expect(res.body.reports.some((report: { id: string }) => report.id === 'payroll-summary')).toBe(false);
    expect(res.body.reports.some((report: { id: string }) => report.id === 'audit-activity')).toBe(false);
  });

  it('accepts a historical Shamsi key and resolves the full named window', async () => {
    const key = periodBoundaries('month', TODAY).periodKey;
    const expected = periodBoundariesForKey(key);

    const res = await supertest(app)
      .get(`/api/reports/run/financial-summary?period=month&key=${encodeURIComponent(key)}`)
      .set(bearerFor('wp11_report_owner'));

    expect(res.status).toBe(200);
    expect(res.body.period).toBe('month');
    expect(res.body.boundaries.periodKey).toBe(key);
    expect(res.body.boundaries.from).toBe(expected.from);
    expect(res.body.boundaries.to).toBe(expected.periodEnd);
  });

  it('accepts an explicit bounded range and echoes that exact window', async () => {
    const res = await supertest(app)
      .get(`/api/reports/run/financial-summary?period=range&from=${TODAY}&to=${TODAY}`)
      .set(bearerFor('wp11_report_owner'));

    expect(res.status).toBe(200);
    expect(res.body.period).toBe('range');
    expect(res.body.boundaries.from).toBe(TODAY);
    expect(res.body.boundaries.to).toBe(TODAY);
    expect(res.body.boundaries.periodKey).toBe(`range-${TODAY}_to_${TODAY}`);
    expect(res.body.metrics.find((metric: { id: string }) => metric.id === 'finance.operating_income')?.value).toBe(1200);
  });

  it('refuses malformed or overlong explicit ranges', async () => {
    const missingBound = await supertest(app)
      .get('/api/reports/run/financial-summary?period=range&from=2026-01-01')
      .set(bearerFor('wp11_report_owner'));
    expect(missingBound.status).toBe(400);

    const tooLong = await supertest(app)
      .get('/api/reports/run/financial-summary?period=range&from=2025-01-01&to=2026-12-31')
      .set(bearerFor('wp11_report_owner'));
    expect(tooLong.status).toBe(400);
  });
});
