import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import impactRouter from '../../../routes/impact.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { seedLinkedDonation } from '../../support/funding.js';
import { id, today } from '../../../utils/ids.js';
import { periodBoundaries, periodBoundariesForKey } from '../../../core/calendar/periods.js';

const BRANCH = 'wp09_impact_branch';
const OWNER = 'wp09_impact_owner';
const DONOR_A = 'wp09_impact_donor_a';
const DONOR_B = 'wp09_impact_donor_b';

const app = express();
app.use(express.json());
app.use('/api/impact', impactRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_impact_campus', FIXED_ORG_ID, 'Impact campus', 'WPI');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Impact branch', 'Kabul', 'wp09_impact_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR_A, 'Impact donor A');
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR_B, 'Impact donor B');
});

const auth = () => bearerFor(OWNER);
const metric = (body: any, metricId: string) => (body.metrics as Array<{ id: string; value: number }>).find((entry) => entry.id === metricId)?.value;

describe('WP-09 · impact periods and scope are canonical', () => {
  it('uses the canonical Shamsi month boundaries for a branch snapshot', async () => {
    const key = periodBoundaries('month', today()).periodKey;
    const span = periodBoundariesForKey(key);
    const donationId = id('dn_impact_month');
    seedLinkedDonation(db, { id: donationId, donorId: DONOR_A, amount: 7000, date: span.from, receiptNo: `R-${donationId}`, branchId: BRANCH });

    const report = await supertest(app).post('/api/impact/reports/generate').set(auth()).send({ period: key, branchId: BRANCH, scopeKind: 'branch' }).expect(201);
    expect(report.body.periodFrom).toBe(span.from);
    expect(report.body.periodTo).toBe(span.to);
    expect(metric(report.body, 'funding.donations_received')).toBeGreaterThanOrEqual(7000);
  });

  it('never pools another donor into a donor-scoped snapshot', async () => {
    const key = periodBoundaries('month', today()).periodKey;
    const a = id('dn_impact_a');
    const b = id('dn_impact_b');
    seedLinkedDonation(db, { id: a, donorId: DONOR_A, amount: 1100, date: today(), receiptNo: `R-${a}`, branchId: BRANCH });
    seedLinkedDonation(db, { id: b, donorId: DONOR_B, amount: 2300, date: today(), receiptNo: `R-${b}`, branchId: BRANCH });

    const report = await supertest(app).post('/api/impact/reports/generate').set(auth()).send({ period: key, branchId: BRANCH, scopeKind: 'donor', scopeId: DONOR_A }).expect(201);
    expect(metric(report.body, 'funding.donations_received')).toBe(1100 + 7000);
  });

  it('refuses a Gregorian-looking period rather than silently changing calendar meaning', async () => {
    await supertest(app).post('/api/impact/reports/generate').set(auth()).send({ period: '2026-Q1', branchId: BRANCH, scopeKind: 'branch' }).expect(400);
  });
});

describe('WP-09 · derived-only impact storage', () => {
  it('has no manual Impact Metric or Success Story table/endpoint authority', async () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('impact_metrics', 'success_stories')").all();
    expect(names).toEqual([]);
    await supertest(app).get('/api/impact/metrics').set(auth()).expect(404);
    await supertest(app).get('/api/impact/stories').set(auth()).expect(404);
  });
});
