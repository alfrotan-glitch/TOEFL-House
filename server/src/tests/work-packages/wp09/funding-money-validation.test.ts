import express from 'express';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { fundingRouter } from '../../../routes/funding.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'wp09_money_branch';
const OWNER = 'wp09_money_owner';
const DONOR = 'wp09_money_donor';
const SCHOLARSHIP = 'wp09_money_scholarship';

const app = express();
app.use(express.json());
app.use('/api/funding', fundingRouter);
app.use(errorHandler);

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('wp09_money_campus', FIXED_ORG_ID, 'Money campus', 'WPM');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
    .run(BRANCH, 'Money branch', 'Kabul', 'wp09_money_campus');
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization', scopeId: null });
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, ?, 'individual')").run(DONOR, 'Money donor');
  db.prepare(`INSERT OR IGNORE INTO scholarships (id, name, total_budget, criteria, status, branch_id) VALUES (?, ?, 8000, '', 'active', ?)`).run(SCHOLARSHIP, 'Money scholarship', BRANCH);
});

const auth = () => bearerFor(OWNER);

function donate(body: Record<string, unknown>) {
  return supertest(app).post('/api/funding/donations').set(auth()).send({ donorId: DONOR, amount: 3000, date: today(), branchId: BRANCH, ...body });
}

describe('WP-09 · donation is one linked cash fact', () => {
  it('creates matching donation and income records exactly once', async () => {
    const response = await donate({ amount: 3000 }).expect(201);
    const pair = db.prepare(
      `SELECT d.amount AS donation_amount, d.branch_id AS donation_branch,
              ft.amount AS transaction_amount, ft.branch_id AS transaction_branch,
              ft.category, ft.donation_id
         FROM donations d JOIN financial_transactions ft ON ft.id = d.transaction_id
        WHERE d.id = ?`,
    ).get(response.body.id);
    expect(pair).toEqual({
      donation_amount: 3000, donation_branch: BRANCH,
      transaction_amount: 3000, transaction_branch: BRANCH,
      category: 'donation', donation_id: response.body.id,
    });
  });

  it('refuses a free-text restricted claim', async () => {
    await donate({ restricted: true, restrictionNote: 'Only scholarship' }).expect(400);
  });

  it('rejects malformed or nonpositive donation amounts without a cash fact', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS count FROM donations').get() as { count: number }).count;
    for (const amount of [0, -1, 1.5, 'not-money', true]) {
      await donate({ amount }).expect(400);
    }
    expect((db.prepare('SELECT COUNT(*) AS count FROM donations').get() as { count: number }).count).toBe(before);
  });

  it('does not let a linked donation or its cash fact be rewritten', async () => {
    const response = await donate({ amount: 1100 }).expect(201);
    const row = db.prepare('SELECT transaction_id FROM donations WHERE id = ?').get(response.body.id) as { transaction_id: string };
    expect(() => db.prepare('UPDATE donations SET amount = 1 WHERE id = ?').run(response.body.id)).toThrow(/cannot be modified/i);
    expect(() => db.prepare('UPDATE financial_transactions SET amount = 1 WHERE id = ?').run(row.transaction_id)).toThrow();
    expect(() => db.prepare('DELETE FROM donations WHERE id = ?').run(response.body.id)).toThrow();
    expect(() => db.prepare('DELETE FROM financial_transactions WHERE id = ?').run(row.transaction_id)).toThrow(/cannot be deleted/i);
  });

  it('materializes a scholarship restriction before the donation command succeeds', async () => {
    const response = await donate({ amount: 2500, restriction: { kind: 'scholarship', targetId: SCHOLARSHIP } }).expect(201);
    expect(db.prepare('SELECT scholarship_id, amount FROM scholarship_fundings WHERE donation_id = ?').get(response.body.id))
      .toEqual({ scholarship_id: SCHOLARSHIP, amount: 2500 });
  });
});
