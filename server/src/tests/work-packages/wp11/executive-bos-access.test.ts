import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bosRouter } from '../../../routes/bos.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { seedUser, bearerFor } from '../../support/identity.js';

const BRANCH = 'wp11_bos_branch';
const TODAY = '2026-08-20';

let app: express.Express;

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp11_bos_campus', FIXED_ORG_ID, 'WP11 BOS Campus', 'WP11B');
  db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'WP11 BOS Branch', 'Kabul', 'wp11_bos_campus');

  seedUser({ id: 'wp11_bos_owner', role: 'owner', branchId: BRANCH });
  seedUser({ id: 'wp11_bos_manager', role: 'general_manager', branchId: BRANCH });
  seedUser({ id: 'wp11_bos_finance', role: 'finance_manager', branchId: BRANCH });
  seedUser({ id: 'wp11_bos_reception', role: 'receptionist', branchId: BRANCH });

  app = express();
  app.use(express.json());
  app.use('/api/bos', bosRouter);
  app.use(errorHandler);
});

beforeEach(() => {
  db.prepare('DELETE FROM permission_overrides WHERE user_id IN (?, ?, ?, ?)')
    .run('wp11_bos_owner', 'wp11_bos_manager', 'wp11_bos_finance', 'wp11_bos_reception');
  db.prepare('DELETE FROM financial_transactions WHERE branch_id = ?').run(BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO finance_accounts (id, scope_type, scope_id, main_balance, saving_balance)
     VALUES ('wp11_bos_finance_account', 'branch', ?, 500000, 500000)`,
  ).run(BRANCH);
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, 'income', 'fee', 100000, ?, 'wp11 bos revenue', ?)`,
  ).run(randomUUID(), TODAY, BRANCH);
});

describe('WP-11 executive BOS access', () => {
  it('admits Owner, General Manager and Finance Manager, but not Receptionist', async () => {
    const owner = await supertest(app)
      .get(`/api/bos/executive-dashboard?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_owner'));
    const manager = await supertest(app)
      .get(`/api/bos/executive-dashboard?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_manager'));
    const finance = await supertest(app)
      .get(`/api/bos/executive-dashboard?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_finance'));
    const reception = await supertest(app)
      .get(`/api/bos/executive-dashboard?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_reception'));

    expect(owner.status).toBe(200);
    expect(manager.status).toBe(200);
    expect(finance.status).toBe(200);
    expect(reception.status).toBe(403);
  });

  it('follows the permission catalog, not the role label, for BOS reads', async () => {
    const permission = db.prepare("SELECT id FROM permissions WHERE code = 'Dashboard.Executive'").get() as { id: string };
    db.prepare(`INSERT INTO permission_overrides
      (id, user_id, permission_id, effect, scope_type, scope_id, granted_by)
      VALUES (?, 'wp11_bos_finance', ?, 'deny', 'branch', ?, 'wp11_bos_owner')`)
      .run(randomUUID(), permission.id, BRANCH);

    const res = await supertest(app)
      .get(`/api/bos/executive-dashboard?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_finance'));

    expect(res.status).toBe(403);
  });

  it('keeps profit withdrawal restricted to the Global Owner', async () => {
    const finance = await supertest(app)
      .post(`/api/bos/profit-distribution/withdraw?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_finance'))
      .send({ amount: 1 });
    const owner = await supertest(app)
      .post(`/api/bos/profit-distribution/withdraw?branchId=${BRANCH}`)
      .set(bearerFor('wp11_bos_owner'))
      .send({ amount: 1 });

    expect(finance.status).toBe(403);
    expect(owner.status).not.toBe(403);
  });
});
