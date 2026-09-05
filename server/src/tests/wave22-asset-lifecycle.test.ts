/**
 * WAVE 22 · ASSET LIFECYCLE ECONOMICS, LOAN INTEREST, SUPPLIER TERMS —
 * adversarial verification of the owner-decided policy (2026-09-05 mandate,
 * registered D-197).
 * ============================================================================
 *   · DEPRECIATION is systematic straight-line recognition over the stated
 *     useful life from the in-service point — NON-CASH: zero ledger rows, the
 *     P&L surfaces derive the expense from the fact rows; cumulative
 *     recognition ends at exactly the cost; a lost asset stops depreciating.
 *   · DISPOSAL is a separate economic event from custody loss: the carrying
 *     amount leaves the register, ACTUAL proceeds enter branch main as
 *     P&L-neutral 'disposal_proceeds' cash (never operating income), and the
 *     gain/loss (= proceeds − carrying) is recorded on the event.
 *   · LOAN INTEREST is a finance cost: real treasury cash out through a
 *     signed-negative 'loan_interest' row that reduces NO principal; lender,
 *     rate and schedule are stated contractual facts.
 *   · SUPPLIER TERMS are stated facts behind truthful due-status and aging.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import financeRouter from '../routes/finance.routes.js';
import bosRouter from '../routes/bos.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { depreciationSchedule, periodKeyFor } from '../core/finance/asset-lifecycle.js';

const OWNER = 'user_w22_sa';
const TEACHER = 'user_w22_t';
const BRANCH = 'branch_w22_sa';

const app = express();
app.use(express.json());
app.use('/api/finance', financeRouter);
app.use('/api/bos', bosRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacher = () => bearerFor(TEACHER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 320)}`);
};
const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);
const ftCount = () => (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
const incomeTotal = () =>
  Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);

/** Full production capex flow: treasury → budget line → expense → asset. */
async function registerAsset(name: string, cost: number, acquiredOn: string): Promise<string> {
  assertOk('treasury', await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 500000, notes: `W22 ${name} capex funding` }), 201);
  const bl = await request(app).post('/api/finance/budget-lines').set(owner())
    .send({ subcategoryId: 'sub_it_equipment', name: unique(`W22 ${name} Capex Line`), branchId: BRANCH });
  assertOk('budget line', bl, 201);
  assertOk('charge', await request(app).post(`/api/finance/budget-lines/${bl.body.id}/charge`).set(owner()).send({ amount: cost }), 201);
  const req = await request(app).post('/api/finance/expense-requests').set(owner())
    .send({ title: unique(`W22 ${name}`), amount: cost, budgetLineId: bl.body.id });
  assertOk('expense request', req, 200, 201);
  assertOk('decide', await request(app).post(`/api/finance/expense-requests/${req.body.id}/decide`).set(owner()).send({ isApproved: true }), 200);
  const row = db.prepare(`SELECT id FROM financial_transactions WHERE type='expense' AND amount = ? AND finance_category_id = 'sub_it_equipment' AND branch_id = ? ORDER BY rowid DESC LIMIT 1`).get(cost, BRANCH) as { id: string };
  const asset = await request(app).post('/api/finance/assets').set(owner())
    .send({ name: unique(name), branchId: BRANCH, categoryId: 'sub_it_equipment', cost, sourceTransactionId: row.id, acquiredOn });
  assertOk('asset', asset, 201);
  return asset.body.id as string;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W22') ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });
});

describe('W22 · A. depreciation: systematic, straight-line, NON-CASH', () => {
  let assetId: string;
  const COST = 100000;
  const LIFE = 36;

  it('states lifecycle facts and refuses dishonest ones', async () => {
    assetId = await registerAsset('Server Rack', COST, '2026-01-05');
    assertOk('bad life refused', await request(app).post(`/api/finance/assets/${assetId}/lifecycle`).set(owner())
      .send({ usefulLifeMonths: 0 }), 400);
    assertOk('teacher cannot state facts', await request(app).post(`/api/finance/assets/${assetId}/lifecycle`).set(teacher())
      .send({ usefulLifeMonths: LIFE }), 403);
    assertOk('facts', await request(app).post(`/api/finance/assets/${assetId}/lifecycle`).set(owner())
      .send({ usefulLifeMonths: LIFE, inServiceOn: '2026-01-05' }), 200);

    // The schedule authority: whole-AFN straight line, remainder in the last period.
    const schedule = depreciationSchedule(COST, LIFE, '2026-01-05');
    expect(schedule.length).toBe(LIFE);
    expect(schedule.reduce((s, r) => s + r.amount, 0)).toBe(COST);
    expect(schedule.every((r) => r.periodKey >= '2026-01')).toBe(true);
    expect(schedule[LIFE - 1].periodKey).toBe(periodKeyFor(LIFE - 1, '2026-01-05'));
  });

  it('recognizes periods idempotently with ZERO ledger effect', async () => {
    assertOk('no-life asset refuses', await request(app).post(`/api/finance/assets/${(await registerAsset('Undef Asset', 5000, '2026-06-01'))}/depreciate`).set(owner()).send({}), 409);
    const before = ftCount();

    const run = await request(app).post(`/api/finance/assets/${assetId}/depreciate`).set(owner())
      .send({ throughPeriod: '2026-03' });
    assertOk('run', run, 200);
    const inserted = (run.body as { insertedPeriods: Array<{ amount: number; periodKey: string }> }).insertedPeriods;
    expect(inserted.length).toBe(3); // Jan, Feb, Mar 2026
    const monthly = Math.floor(COST / LIFE);
    expect(inserted.every((r) => r.amount === monthly)).toBe(true);
    expect(ftCount()).toBe(before); // NON-CASH: no ledger row, ever

    const replay = await request(app).post(`/api/finance/assets/${assetId}/depreciate`).set(owner()).send({ throughPeriod: '2026-03' });
    assertOk('replay', replay, 200);
    expect((replay.body as { insertedPeriods: unknown[] }).insertedPeriods.length).toBe(0);

    const position = (run.body as { position: { recognized: number; carryingValue: number } }).position;
    expect(position.recognized).toBe(monthly * 3);
    expect(position.carryingValue).toBe(COST - monthly * 3);
    checkerClean(); // I28 green

    // The P&L surface derives the expense from the facts.
    const summary = await request(app).get(`/api/finance/asset-lifecycle/summary?branchId=${BRANCH}`).set(owner());
    assertOk('summary', summary, 200);
    const body = summary.body as { periodExpense: { depreciationNonCash: number }; portfolio: { grossCost: number; accumulatedDepreciation: number; netCarryingValue: number } };
    expect(body.periodExpense.depreciationNonCash).toBe(monthly * 3);
    expect(body.portfolio.accumulatedDepreciation).toBe(monthly * 3);
    void body;
  });

  it('refuses over-life, over-cost and post-disposal recognition at DB level', async () => {
    // Direct-write attack: a period beyond the life.
    let refused = false;
    try {
      db.prepare(`INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by)
                  VALUES ('dep_attack_1', ?, ?, '2030-01', 1, date('now'), 'attacker')`).run(assetId, BRANCH);
    } catch { refused = true; }
    expect(refused).toBe(true);
    // Direct-write attack: cumulative beyond the cost (within-life period but huge amount).
    refused = false;
    try {
      db.prepare(`INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by)
                  VALUES ('dep_attack_2', ?, ?, '2026-04', 99000, date('now'), 'attacker')`).run(assetId, BRANCH);
    } catch { refused = true; }
    expect(refused).toBe(true);
    checkerClean();
  });
});

describe('W22 · B. disposal: separate economics from custody loss', () => {
  it('disposes with proceeds: carrying leaves, cash enters, gain/loss is truthful', async () => {
    const COST = 48000;
    const assetId = await registerAsset('Projector', COST, '2026-01-05');
    assertOk('facts', await request(app).post(`/api/finance/assets/${assetId}/lifecycle`).set(owner())
      .send({ usefulLifeMonths: 24, inServiceOn: '2026-01-05' }), 200);
    assertOk('depreciate', await request(app).post(`/api/finance/assets/${assetId}/depreciate`).set(owner()).send({ throughPeriod: '2026-08' }), 200);
    const monthly = Math.floor(COST / 24);
    const recognized = monthly * 8;
    const carrying = COST - recognized;

    const incomeBefore = incomeTotal();
    const mainBefore = getFinanceAccount('branch', BRANCH).mainBalance;
    const proceeds = carrying + 7000; // a real gain

    assertOk('teacher cannot dispose', await request(app).post(`/api/finance/assets/${assetId}/dispose`).set(teacher())
      .send({ proceeds, reason: 'Teacher must not dispose of assets' }), 403);
    assertOk('short reason refused', await request(app).post(`/api/finance/assets/${assetId}/dispose`).set(owner())
      .send({ proceeds, reason: 'short' }), 400);

    const disposal = await request(app).post(`/api/finance/assets/${assetId}/dispose`).set(owner())
      .send({ proceeds, reason: 'Sold to another institute after upgrade', buyer: 'Kabul Prep' });
    assertOk('disposal', disposal, 201);
    const body = disposal.body as { disposalId: string; carryingValue: number; gainLoss: number; transactionId: string };
    expect(body.carryingValue).toBe(carrying);
    expect(body.gainLoss).toBe(7000);

    expect(getFinanceAccount('branch', BRANCH).mainBalance - mainBefore).toBe(proceeds);
    const row = db.prepare(`SELECT type, amount, branch_id FROM financial_transactions WHERE id = ?`).get(body.transactionId) as { type: string; amount: number; branch_id: string };
    expect(row).toMatchObject({ type: 'disposal_proceeds', amount: proceeds, branch_id: BRANCH });
    expect(incomeTotal()).toBe(incomeBefore); // NEVER operating income
    expect(db.prepare(`SELECT custody_status s FROM fixed_assets WHERE id = ?`).get(assetId)).toEqual({ s: 'disposed' });
    checkerClean(); // I28 green

    // Replay refused; depreciation after the disposal month refused.
    assertOk('replay refused', await request(app).post(`/api/finance/assets/${assetId}/dispose`).set(owner())
      .send({ proceeds: 0, reason: 'Disposing the same asset twice' }), 409);
    let refused = false;
    try {
      db.prepare(`INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by)
                  VALUES ('dep_attack_3', ?, ?, '2026-10', 100, date('now'), 'attacker')`).run(assetId, BRANCH);
    } catch { refused = true; }
    expect(refused).toBe(true);

    // Cash truth: reconciliation and the daily statement stay truthful.
    const rec = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(rec.cashVariance).toBe(0);
    const { getDailyCashActivity } = await import('../core/reporting/financial-observability.js');
    const { today } = await import('../utils/ids.js');
    const stmt = getDailyCashActivity(db, { branchId: BRANCH, date: today() });
    expect(stmt.movements.disposalProceeds).toBe(proceeds);
    expect(stmt.closing.main).toBe(getFinanceAccount('branch', BRANCH).mainBalance);

    // Tamper: a disposal row with a wrong gain/loss cannot be written.
    refused = false;
    try {
      db.prepare(`INSERT INTO asset_disposals (id, asset_id, branch_id, disposal_on, proceeds, carrying_value, gain_loss, reason, disposed_by)
                  VALUES ('dsp_attack', ?, ?, date('now'), 10, 10, 999, 'Tamper attempt with wrong gain', 'attacker')`).run(assetId, BRANCH);
    } catch { refused = true; }
    expect(refused).toBe(true);
    checkerClean();
  });

  it('retires with zero proceeds (no cash row, loss = carrying) and refuses lost assets', async () => {
    const COST = 12000;
    const assetId = await registerAsset('Old Printer', COST, '2026-01-05');
    assertOk('facts', await request(app).post(`/api/finance/assets/${assetId}/lifecycle`).set(owner())
      .send({ usefulLifeMonths: 12, inServiceOn: '2026-01-05' }), 200);
    assertOk('depreciate', await request(app).post(`/api/finance/assets/${assetId}/depreciate`).set(owner()).send({ throughPeriod: '2026-08' }), 200);
    const carrying = COST - Math.floor(COST / 12) * 8;

    const before = ftCount();
    const retirement = await request(app).post(`/api/finance/assets/${assetId}/dispose`).set(owner())
      .send({ proceeds: 0, reason: 'Scrapped: beyond economic repair' });
    assertOk('retirement', retirement, 201);
    const body = retirement.body as { gainLoss: number; transactionId: string | null };
    expect(body.gainLoss).toBe(-carrying);
    expect(body.transactionId).toBeNull();
    expect(ftCount()).toBe(before); // zero proceeds ⇒ zero cash evidence
    checkerClean();

    // A lost asset is governed by custody-loss semantics and cannot be disposed.
    const lostId = await registerAsset('Stolen Laptop', 3000, '2026-07-01');
    assertOk('declare loss', await request(app).post(`/api/finance/assets/${lostId}/declare-loss`).set(owner())
      .send({ reason: 'Stolen during the Eid break', evidenceReference: 'police-report-17' }), 201);
    assertOk('lost asset cannot dispose', await request(app).post(`/api/finance/assets/${lostId}/dispose`).set(owner())
      .send({ proceeds: 500, reason: 'Trying to sell a lost asset' }), 409);
    assertOk('lost asset cannot depreciate', await request(app).post(`/api/finance/assets/${lostId}/depreciate`).set(owner()).send({}), 409);
    checkerClean();
  });
});

describe('W22 · C. loan interest as a finance cost + contractual facts', () => {
  it('records a loan with rate/maturity facts, pays interest, reduces no principal', async () => {
    const treasuryBefore = getFinanceAccount('organization', 'global').mainBalance;
    const loan = await request(app).post('/api/finance/loans').set(owner()).send({
      lenderName: 'Kabul Community Fund', principal: 200000, purpose: 'W22 expansion',
      interestRateBps: 1200, maturityOn: '2027-09-01', scheduleNote: 'Quarterly interest, bullet principal',
    });
    assertOk('loan', loan, 201);
    const loanId = (loan.body as { id: string }).id;
    expect(getFinanceAccount('organization', 'global').mainBalance - treasuryBefore).toBe(200000);

    const register = await request(app).get('/api/finance/loans').set(owner());
    assertOk('register', register, 200);
    const entry = ((register.body as { loans: Array<Record<string, unknown>> }).loans).find((l) => l.id === loanId);
    expect(entry).toMatchObject({ interestRateBps: 1200, maturityOn: '2027-09-01', scheduleNote: 'Quarterly interest, bullet principal' });

    // Interest: real treasury cash out, a finance cost, principal untouched.
    const interest = await request(app).post(`/api/finance/loans/${loanId}/pay-interest`).set(owner()).send({ amount: 6000 });
    assertOk('interest', interest, 201);
    const txId = (interest.body as { transactionId: string }).transactionId;
    const row = db.prepare(`SELECT type, amount FROM financial_transactions WHERE id = ?`).get(txId) as { type: string; amount: number };
    expect(row).toMatchObject({ type: 'loan_interest', amount: -6000 });
    expect(treasuryBefore + 200000 - 6000 - getFinanceAccount('organization', 'global').mainBalance).toBe(0);

    const position = (interest.body as { position: { outstanding: number; interestPaid: number } }).position;
    expect(position.outstanding).toBe(200000); // principal reduced by NOTHING
    expect(position.interestPaid).toBe(6000);
    checkerClean(); // I13/I16/I29 green

    // Tamper: an interest payment without its cash evidence cannot be written.
    let refused = false;
    try {
      db.prepare(`INSERT INTO loan_interest_payments (id, loan_id, amount, transaction_id, paid_on, paid_by)
                  VALUES ('lip_attack', ?, 555, 'tx_nonexistent', date('now'), 'attacker')`).run(loanId);
    } catch { refused = true; }
    expect(refused).toBe(true);
    checkerClean();
  });
});

describe('W22 · D. supplier terms and due-status aging', () => {
  it('represents terms truthfully and reports overdue exposure', async () => {
    const sup = await request(app).post('/api/finance/suppliers').set(owner()).send({ name: unique('W22 Hardware Supplier') });
    assertOk('supplier', sup, 201);
    const supplierId = (sup.body as { id: string }).id;

    const fresh = await request(app).post('/api/finance/supplier-invoices').set(owner())
      .send({ supplierId, branchId: BRANCH, amount: 40000, description: 'Chairs delivered on 30-day credit', receivedOn: '2026-09-01', terms: 'net 30', termsDays: 30 });
    assertOk('fresh payable', fresh, 201);
    const stale = await request(app).post('/api/finance/supplier-invoices').set(owner())
      .send({ supplierId, branchId: BRANCH, amount: 15000, description: 'Whiteboards from last spring', receivedOn: '2026-05-01', terms: 'net 30', termsDays: 30 });
    assertOk('stale payable', stale, 201);
    const bare = await request(app).post('/api/finance/supplier-invoices').set(owner())
      .send({ supplierId, branchId: BRANCH, amount: 7000, description: 'Cables, terms to be confirmed' });
    assertOk('bare payable', bare, 201);

    const dueOn = (db.prepare(`SELECT due_on d FROM supplier_invoices WHERE id = ?`).get(fresh.body.id) as { d: string }).d;
    expect(dueOn).toBe('2026-10-01');

    const reg = await request(app).get(`/api/finance/payables?branchId=${BRANCH}`).set(owner());
    assertOk('register', reg, 200);
    const body = reg.body as {
      totals: { openPayables: number; overdue: number };
      aging: { current: number; d1_30: number; d31_60: number; d60plus: number };
      invoices: Array<{ amount: number; dueStatus: string; daysOverdue: number | null; terms: string | null }>;
    };
    expect(body.totals.openPayables).toBe(62000);
    expect(body.totals.overdue).toBe(15000); // the spring invoice is >60 days late
    expect(body.aging.d60plus).toBe(15000);
    expect(body.aging.current).toBe(47000); // fresh + no-terms invoice
    const freshRow = body.invoices.find((i) => i.amount === 40000);
    expect(freshRow).toMatchObject({ dueStatus: 'not_due', terms: 'net 30' });
    const staleRow = body.invoices.find((i) => i.amount === 15000);
    expect(staleRow?.dueStatus).toBe('overdue');
    expect((staleRow?.daysOverdue ?? 0)).toBeGreaterThan(60);
    const bareRow = body.invoices.find((i) => i.amount === 7000);
    expect(bareRow).toMatchObject({ dueStatus: 'no_terms', terms: null });
    checkerClean();
  });
});

describe('W22 · E. the distribution authority sees the complete period cost', () => {
  it('BOS position counts depreciation (non-cash) and finance cost as real expense', async () => {
    const position = await request(app).get(`/api/bos/profit-distribution/calculate?branchId=${BRANCH}`).set(owner());
    assertOk('position', position, 200);
    const body = position.body as { depreciation: number; financeCost: number; expense: number; cashExpense: number };
    expect(body.depreciation).toBeGreaterThan(0); // the W22 asset facts flow through
    expect(body.financeCost).toBeGreaterThan(0); // the 6 000 AFN interest payment
    expect(body.expense).toBe(body.cashExpense + body.depreciation + body.financeCost);
    checkerClean();
  });
});

describe('W22 · F. migration convergence: a pre-W22 database upgrades in place', () => {
  it('converges the W21 schema losslessly and the migrated triggers refuse hostile rows', () => {
    // The pre-W22 world is pinned to the W21 release commit so this test
    // stays meaningful after W22 itself is committed.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const oldSchema = spawnSync('git', ['-C', repoRoot, 'show', '2a696cb:server/src/db/schema.sql'], { encoding: 'utf8' });
    expect(oldSchema.status).toBe(0);
    expect(oldSchema.stdout).not.toContain('asset_depreciations');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w22-conv-'));
    const dbFile = path.join(dir, 'old.sqlite');
    const raw = new Database(dbFile);
    raw.exec(oldSchema.stdout);
    raw.prepare(`INSERT INTO organizations (id, name) VALUES ('convorg','Conv Org')`).run();
    raw.prepare(`INSERT INTO campuses (id, organization_id, name, code) VALUES ('campus_kbl','convorg','Kabul','KBL')`).run();
    raw.prepare(`INSERT INTO branches (id, campus_id, name) VALUES ('convb','campus_kbl','conv')`).run();
    raw.prepare(`INSERT INTO finance_categories (id, name, level, classification) VALUES ('convcat','Conv','category','capital_expenditure')`).run();
    raw.prepare(`INSERT INTO fixed_assets (id, branch_id, category_id, name, cost, custody_status, acquired_on)
                 VALUES ('conv_a1','convb','convcat','Conv Printer',12000,'in_service','2026-01-01')`).run();
    raw.close();

    // Open the SAME pre-W22 file through the W22 layer in a child process
    // (the connection module binds one database at import time).
    const probe = path.join(dir, 'probe.ts');
    const connectionModule = path.resolve(__dirname, '..', 'db', 'connection.js');
    fs.writeFileSync(probe, `
      import Database from 'better-sqlite3';
      process.env.DB_PATH = ${JSON.stringify(dbFile)};
      import(${JSON.stringify(connectionModule)}).then(({ db }) => {
        const g = (sql) => db.prepare(sql).get();
        const out = {
          // NB: 'disposed' is a custody_status VALUE (CHECK widened), not a column.
          faCols: g("SELECT count(*) c FROM pragma_table_info('fixed_assets') WHERE name IN ('useful_life_months','in_service_on')").c,
          custodyCheck: g("SELECT sql s FROM sqlite_master WHERE type='table' AND name='fixed_assets'").s.includes("'disposed'") ? 1 : 0,
          supplierCols: g("SELECT count(*) c FROM pragma_table_info('supplier_invoices') WHERE name IN ('terms','due_on')").c,
          loanCols: g("SELECT count(*) c FROM pragma_table_info('loans') WHERE name IN ('interest_rate_bps','maturity_on','schedule_note')").c,
          w22Triggers: g("SELECT count(*) c FROM sqlite_master WHERE type='trigger' AND (tbl_name IN ('asset_depreciations','asset_disposals','loan_interest_payments') OR name='trg_fixed_assets_disposal_guard')").c,
          preserved: g("SELECT cost, custody_status FROM fixed_assets WHERE id='conv_a1'"),
          fkViolations: db.prepare('PRAGMA foreign_key_check').all().length,
        };
        db.prepare("UPDATE fixed_assets SET useful_life_months = 12, in_service_on = '2026-01-01' WHERE id = 'conv_a1'").run();
        const tryRun = (sql) => { try { db.prepare(sql).run(); return 'accepted'; } catch { return 'refused'; } };
        out.legal = tryRun("INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by) VALUES ('c1','conv_a1','convb','2026-01',1000,'2026-01-31','probe')");
        out.overLife = tryRun("INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by) VALUES ('c2','conv_a1','convb','2027-01',100,'2027-01-15','probe')");
        out.overCost = tryRun("INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by) VALUES ('c3','conv_a1','convb','2026-02',99000,'2026-02-15','probe')");
        out.replay = tryRun("INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by) VALUES ('c4','conv_a1','convb','2026-01',1000,'2026-01-28','probe')");
        console.log('CONV_RESULT ' + JSON.stringify(out));
        db.close();
      }).catch((e) => { console.error('PROBE_FAIL ' + e.message); process.exit(3); });
    `);
    const ran = spawnSync(path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx'), [probe], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    const line = (ran.stdout || '').split('\n').find((l) => l.startsWith('CONV_RESULT'));
    expect(line).toBeTruthy();
    const result = JSON.parse(line!.slice('CONV_RESULT '.length));
    expect(result.faCols).toBe(2);
    expect(result.custodyCheck).toBe(1);
    expect(result.supplierCols).toBe(2);
    expect(result.loanCols).toBe(3);
    expect(result.w22Triggers).toBe(8);
    expect(result.preserved).toEqual({ cost: 12000, custody_status: 'in_service' });
    expect(result.fkViolations).toBe(0);
    expect(result.legal).toBe('accepted');
    expect(result.overLife).toBe('refused');
    expect(result.overCost).toBe('refused');
    expect(result.replay).toBe('refused');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
