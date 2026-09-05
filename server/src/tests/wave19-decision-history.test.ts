/**
 * WAVE 19 · DECISION-HISTORY RECONCILIATION — adversarial verification.
 * ============================================================================
 * The wave searched the full decision history and found that two "open" queue
 * items were already answered by binding owner decisions:
 *
 *   · D-11 (Owner, Q1): AFN is the SOLE currency — "no secondary currency, no
 *     FX rate, no multi-currency columns or conversion logic anywhere". The
 *     D-FX gate is therefore DECIDED-NO. This suite proves storage-level
 *     conformance: the two currency label columns now carry
 *     CHECK (currency = 'AFN'), converged for pre-W19 databases, and a
 *     non-AFN write is refused by the DATABASE, not by convention.
 *
 *   · D-61 (Owner, A-10 checkpoint): the margin-tiered, reserve-guarded
 *     profit distribution is the ONE owner-approved treasury outflow channel.
 *     Return of capital outside it is decided-not-provided; this suite proves
 *     the approved policy still enforces (a withdrawal beyond the ceiling is
 *     refused), i.e. the binding decision is live, not just documented.
 *
 *   · D-14 (Owner, option 11-C): employee advances remain receivables
 *     (non-expense cash movement). Verified as a standing classification
 *     fact.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import catalogRouter from '../routes/catalog.routes.js';
import bosRouter from '../routes/bos.routes.js';
import studentsRouter from '../routes/students.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w19_sa';
const BRANCH = 'branch_w19_sa';

const app = express();
app.use(express.json());
app.use('/api/catalog', catalogRouter);
app.use('/api/bos', bosRouter);
app.use('/api/students', studentsRouter);
app.use('/api/invoices', invoicesRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 260)}`);
};

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W19') ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  assertOk('fee rule', await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W19 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  }), 200, 201);
});

describe('W19 · D-11 single currency enforced at the storage boundary', () => {
  it('both fee currency columns refuse a second currency at the DB level', () => {
    db.prepare(`INSERT INTO programs (id, name, branch_id) VALUES ('prog_w19', 'W19 Program', ?) ON CONFLICT(id) DO NOTHING`).run(BRANCH);
    db.prepare(`INSERT INTO levels (id, program_id, name) VALUES ('lvl_w19', 'prog_w19', 'W19 Level') ON CONFLICT(id) DO NOTHING`);
    expect(() => db.prepare(
      `INSERT INTO level_branch_fees (id, level_id, branch_id, fee, currency) VALUES ('lbf_usd', 'lvl_w19', ?, 100, 'USD')`,
    ).run(BRANCH)).toThrow(/AFN/);
    expect(() => db.prepare(
      `INSERT INTO fee_rules (id, branch_id, fee_type, name, amount, currency) VALUES ('fr_eur', ?, 'registration', 'X', 100, 'EUR')`,
    ).run(BRANCH)).toThrow(/AFN/);
  });

  it('the canonical DDL carries the CHECK for fresh databases', () => {
    for (const table of ['level_branch_fees', 'fee_rules']) {
      const sql = (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql;
      expect(sql).toContain("CHECK (currency = 'AFN')");
    }
  });

  it('the fee-rule route still writes AFN facts (no writer regression)', async () => {
    const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
      branchId: BRANCH, feeType: 'placement', name: unique('W19 placement'),
      amount: 350, isActive: true, effectiveFrom: '2026-01-01',
    });
    assertOk('fee rule', rule, 200, 201);
    const row = db.prepare('SELECT currency FROM fee_rules WHERE id = ?').get(rule.body.id) as { currency: string };
    expect(row.currency).toBe('AFN');
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});

describe('W19 · D-61 treasury policy is the live, single distribution authority', () => {
  it('refuses a withdrawal beyond the owner-approved ceiling', async () => {
    // A fresh branch has no profit and no reserve coverage: any withdrawal
    // must be refused by the D-61 policy, proving the decided channel still
    // enforces rather than merely existing.
    const attempt = await request(app).post('/api/bos/profit-distribution/withdraw').set(owner()).send({ branchId: BRANCH, amount: 1000 });
    expect([409, 400]).toContain(attempt.status);
    expect(String((attempt.body as { error?: string }).error ?? '')).toMatch(/not allowed|liquidity|ceiling|reserve/i);
  });

  it('employee advances remain receivables — the non-expense classification stands (D-14)', () => {
    const row = db.prepare(
      `SELECT classification FROM finance_categories WHERE id = 'sub_salary_advances'`,
    ).get() as { classification: string };
    expect(row.classification).toBe('non_expense_cash_movement');
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
