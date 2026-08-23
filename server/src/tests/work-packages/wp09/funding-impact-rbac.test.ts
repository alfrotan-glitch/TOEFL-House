import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import impactRouter from '../../../routes/impact.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';
import { periodBoundaries } from '../../../core/calendar/periods.js';

const BRANCH = 'wp09_rbac_branch';
const FINANCE = 'wp09_rbac_finance';
const DONOR_MANAGER = 'wp09_rbac_donor_manager';
const RECEPTIONIST = 'wp09_rbac_receptionist';
const DONOR = 'wp09_rbac_donor';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use('/api/impact', impactRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_rbac_campus', FIXED_ORG_ID, 'RBAC campus', 'WPR');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'RBAC branch', 'Kabul', 'wp09_rbac_campus');
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BRANCH });
  seedUser({ id: DONOR_MANAGER, role: 'donor_manager', branchId: BRANCH });
  seedUser({ id: RECEPTIONIST, role: 'receptionist', branchId: BRANCH });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'RBAC donor');
});

const finance = () => bearerFor(FINANCE);
const donorManager = () => bearerFor(DONOR_MANAGER);
const receptionist = () => bearerFor(RECEPTIONIST);

describe('WP-09 · permission-based financial separation', () => {
  it('lets Finance select the organization donor reference, record a donation, and refuses every broader funding/Impact mutation', async () => {
    const donorReferences = await supertest(app).get('/api/funding/donors').set(finance()).expect(200);
    expect(donorReferences.body.some((donor: { id: string }) => donor.id === DONOR)).toBe(true);
    await supertest(app).post('/api/funding/donations').set(finance()).send({ donorId: DONOR, amount: 1000, date: today(), branchId: BRANCH }).expect(201);
    await supertest(app).post('/api/funding/donors').set(finance()).send({ fullName: 'No authority', type: 'individual' }).expect(403);
    await supertest(app).post('/api/funding/campaigns').set(finance()).send({ name: 'No authority', targetAmount: 1000, branchId: BRANCH }).expect(403);
    await supertest(app).post('/api/impact/reports/generate').set(finance()).send({ period: periodBoundaries('month', today()).periodKey, branchId: BRANCH, scopeKind: 'branch' }).expect(403);
  });

  it('lets Donor Manager manage campaign and generate a derived Impact report', async () => {
    const campaign = await supertest(app).post('/api/funding/campaigns').set(donorManager()).send({ name: 'Permitted campaign', targetAmount: 2000, startDate: today(), branchId: BRANCH }).expect(201);
    expect(campaign.body.id).toBeTruthy();
    await supertest(app).post('/api/impact/reports/generate').set(donorManager()).send({ period: periodBoundaries('month', today()).periodKey, branchId: BRANCH, scopeKind: 'branch' }).expect(201);
  });

  it('does not mistake a receptionist role name for Funding.View', async () => {
    await supertest(app).get('/api/funding/scholarships').set(receptionist()).expect(403);
    await supertest(app).get('/api/impact/reports').set(receptionist()).expect(403);
  });
});
