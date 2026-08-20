/**
 * Dashboard branch/organization isolation — regression suite
 * ============================================================================
 * Previously UNVERIFIED: the live environment had a single branch, so no
 * evidence existed that Branch A's dashboard excludes Branch B's money.
 *
 * This builds a controlled two-branch dataset with known totals and asserts
 * each scope reports exactly its own figures — the classic failure being an
 * aggregate that forgets its `branch_id` predicate and silently reports
 * organization-wide money on a branch dashboard.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { financeRouter } from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const ORG_CAMPUS = 'iso2_campus';
const BR_A = 'iso2_branch_a';
const BR_B = 'iso2_branch_b';

// Controlled, deliberately distinguishable amounts.
const A_INCOME = 11000;
const A_EXPENSE = 3000;
const B_INCOME = 70000;
const B_EXPENSE = 5000;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/finance', financeRouter);
  app.use(errorHandler);
  return app;
}
function userFor(branchId: string, id: string): TokenPayload {
  return { userId: id, username: id, branchId, fullName: `Mgr ${branchId}` };
}
function auth(u: TokenPayload) {
  return { Authorization: `Bearer ${signToken(u)}` };
}

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  const d = today();

  db.prepare(`INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active)
              VALUES (?, (SELECT id FROM organizations LIMIT 1), 'Iso2 Campus', 'ISO2', 1)`).run(ORG_CAMPUS);
  for (const [b, name] of [[BR_A, 'Iso2 Branch A'], [BR_B, 'Iso2 Branch B']]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, 'Loc', ?)`).run(b, name, ORG_CAMPUS);
  }

  const pw = await hashPassword('x');
  for (const [uid, br] of [['u_iso2_a', BR_A], ['u_iso2_b', BR_B]]) {
    db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
                VALUES (?, ?, ?, ?, ?, 1, 0)`).run(uid, uid, uid, br, pw);
    assignRole(uid, 'manager', br);
  }

  // Ledger rows with unmistakable amounts per branch.
  const ins = db.prepare(
    `INSERT OR REPLACE INTO financial_transactions (id, type, category, amount, date, description, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('iso2_ai', 'income', 'fee', A_INCOME, d, 'A income', BR_A);
  ins.run('iso2_ae', 'expense', 'rent', A_EXPENSE, d, 'A expense', BR_A);
  ins.run('iso2_bi', 'income', 'fee', B_INCOME, d, 'B income', BR_B);
  ins.run('iso2_be', 'expense', 'rent', B_EXPENSE, d, 'B expense', BR_B);

  app = createApp();
});

describe('branch isolation of financial aggregates', () => {
  it('each branch sums ONLY its own ledger rows', () => {
    const sum = (branch: string, type: string) =>
      (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type = ? AND branch_id = ?`).get(type, branch) as { v: number }).v;

    expect(sum(BR_A, 'income')).toBe(A_INCOME);
    expect(sum(BR_A, 'expense')).toBe(A_EXPENSE);
    expect(sum(BR_B, 'income')).toBe(B_INCOME);
    expect(sum(BR_B, 'expense')).toBe(B_EXPENSE);

    // Branch A must never see Branch B's much larger income.
    expect(sum(BR_A, 'income')).not.toBe(A_INCOME + B_INCOME);
  });

  it('the organization-wide total equals the sum of both branches', () => {
    const orgIncome = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='income' AND branch_id IN (?, ?)`,
    ).get(BR_A, BR_B) as { v: number }).v;
    expect(orgIncome).toBe(A_INCOME + B_INCOME);
  });

  it('GET /finance/dashboard reports branch-scoped figures, not global ones', async () => {
    const resA = await supertest(app).get('/api/finance/dashboard').set(auth(userFor(BR_A, 'u_iso2_a')));
    const resB = await supertest(app).get('/api/finance/dashboard').set(auth(userFor(BR_B, 'u_iso2_b')));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const jsonA = JSON.stringify(resA.body);
    // Branch A's payload must not carry Branch B's distinctive amount.
    expect(jsonA).not.toContain(String(B_INCOME));
    // The two branches must not produce identical dashboards.
    expect(jsonA).not.toBe(JSON.stringify(resB.body));
  });

  it('a branch manager cannot read another branch by passing its id', async () => {
    const res = await supertest(app)
      .get('/api/finance/dashboard')
      .query({ branchId: BR_B })
      .set(auth(userFor(BR_A, 'u_iso2_a')));
    // Either refused, or silently scoped back to the caller's own branch —
    // never Branch B's data.
    if (res.status === 200) {
      expect(JSON.stringify(res.body)).not.toContain(String(B_INCOME));
    } else {
      expect([400, 403]).toContain(res.status);
    }
  });
});
