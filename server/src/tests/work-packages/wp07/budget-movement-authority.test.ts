/**
 * WP-07 · Budget and treasury movement authority.
 * ============================================================================
 * These cases pin the convention declared in
 * `server/src/core/finance/budget-movements.ts`: a budget movement is one
 * SIGNED `budget_charge` row, referencing the line that moved, booked to the
 * branch that owns the line, and `saving_transfer` means the branch savings
 * account and nothing else.
 *
 * Four defects were reproduced against the previous implementation before it
 * was changed, and each has a case here:
 *
 *   WP07-F1  a month-end RETURN of 10,000 AFN left budgetVariance at -20,000
 *            and reconciliation permanently unhealthy, because a return was
 *            written as another positive `budget_charge`.
 *   WP07-F2  a month-end TRANSFER between two lines of ONE branch was written
 *            as a `saving_transfer`, producing cashVariance +8,000 /
 *            savingVariance -8,000 and 8,000 AFN of savings that never
 *            happened in every savings figure.
 *   WP07-F3  a settlement performed by an owner on ANOTHER branch's line was
 *            booked to the operator's branch, so neither branch reconciled.
 *   WP07-F4  a funded-then-returned line reported 100% budget utilization,
 *            because `allocated_amount` was never reduced.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { financeRouter } from '../../../routes/finance.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { postBudgetMovement, BUDGET_MOVEMENT_CATEGORY } from '../../../core/finance/budget-movements.js';
import { recordIncome } from '../../../utils/income.js';
import { setSetting } from '../../../utils/settings.js';

const app = express();
app.use(express.json());
app.use('/api/finance', financeRouter);
app.use(errorHandler);

let key: string;
let branchA: string;
let branchB: string;
let owner: { Authorization: string };

function makeLine(id: string, name: string, branch: string, active = true) {
  db.prepare(
    `INSERT OR REPLACE INTO budget_lines (id, name, category_id, allocated_amount, current_amount, branch_id, cost_type, is_active)
     VALUES (?, ?, 'sub_rent', 0, 0, ?, 'fixed', ?)`,
  ).run(id, name, branch, active ? 1 : 0);
  return id;
}

function line(id: string) {
  return db.prepare('SELECT id, current_amount, allocated_amount, branch_id FROM budget_lines WHERE id = ?').get(id) as {
    id: string; current_amount: number; allocated_amount: number; branch_id: string;
  };
}

function movements(branch?: string) {
  const sql = branch
    ? `SELECT type, category, amount, reference_id, branch_id FROM financial_transactions WHERE branch_id = ? ORDER BY rowid`
    : `SELECT type, category, amount, reference_id, branch_id FROM financial_transactions ORDER BY rowid`;
  return (branch ? db.prepare(sql).all(branch) : db.prepare(sql).all()) as Array<{
    type: string; category: string; amount: number; reference_id: string | null; branch_id: string;
  }>;
}

async function deposit(amount: number) {
  await supertest(app).post('/api/finance/treasury/deposit').set(owner).send({ amount }).expect(201);
}

function charge(lineId: string, amount: unknown) {
  return supertest(app).post(`/api/finance/budget-lines/${lineId}/charge`).set(owner).send({ amount });
}

function monthEnd(lineId: string, body: Record<string, unknown>) {
  return supertest(app).post(`/api/finance/budget-lines/${lineId}/month-end`).set(owner).send(body);
}

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7_${process.pid}_${randomUUID().slice(0, 6)}`;
  branchA = `${key}_a`;
  branchB = `${key}_b`;
  for (const b of [branchA, branchB]) {
    db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(b, b);
  }
  db.prepare("DELETE FROM finance_accounts WHERE scope_type = 'organization'").run();
  seedUser({ id: `${key}_owner`, role: 'owner', branchId: branchA, fullName: 'Owner' });
  owner = bearerFor(`${key}_owner`);
  setSetting('daily_saving_percent', '5');
});

describe('WP-07 · a budget movement is one signed row on the line it moved', () => {
  it('funding a line writes a positive movement booked to the line branch', async () => {
    makeLine(`${key}_l1`, 'Rent', branchA);
    await deposit(10000);
    await charge(`${key}_l1`, 6000).expect(201);

    const rows = movements(branchA).filter((r) => r.type === 'budget_charge');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: BUDGET_MOVEMENT_CATEGORY.allocation,
      amount: 6000,
      reference_id: `${key}_l1`,
      branch_id: branchA,
    });
    expect(line(`${key}_l1`)).toMatchObject({ current_amount: 6000, allocated_amount: 6000 });
    expect(computeReconciliation({ branchId: branchA, isAll: false }).budgetVariance).toBe(0);
  });

  it('WP07-F1 · a month-end return writes a NEGATIVE movement and reconciles', async () => {
    makeLine(`${key}_l2`, 'Rent', branchA);
    await deposit(10000);
    await charge(`${key}_l2`, 10000).expect(201);
    await monthEnd(`${key}_l2`, { decision: 'return' }).expect(200);

    const rows = movements(branchA).filter((r) => r.type === 'budget_charge');
    expect(rows.map((r) => r.amount)).toEqual([10000, -10000]);
    expect(rows[1]).toMatchObject({ category: BUDGET_MOVEMENT_CATEGORY.return, reference_id: `${key}_l2` });

    const after = computeReconciliation({ branchId: branchA, isAll: false });
    expect(after.budgetVariance).toBe(0);
    expect(after.healthy).toBe(true);
  });

  it('WP07-F4 · a returned line reports no utilization, because allocation follows the money', async () => {
    makeLine(`${key}_l3`, 'Rent', branchA);
    await deposit(4000);
    await charge(`${key}_l3`, 4000).expect(201);
    await monthEnd(`${key}_l3`, { decision: 'return' }).expect(200);

    const row = line(`${key}_l3`);
    expect(row).toMatchObject({ current_amount: 0, allocated_amount: 0 });

    const dash = await supertest(app).get(`/api/finance/dashboard?branchId=${branchA}`).set(owner).expect(200);
    expect(dash.body.budget.allocated).toBe(0);
    expect(dash.body.budget.used).toBe(0);
    expect(dash.body.budget.utilizationPercent).toBe(0);
  });

  it('WP07-F2 · a month-end transfer is two movements that net to zero, and no savings', async () => {
    makeLine(`${key}_src`, 'Source', branchA);
    makeLine(`${key}_dst`, 'Target', branchA);
    await deposit(8000);
    await charge(`${key}_src`, 8000).expect(201);
    await monthEnd(`${key}_src`, { decision: 'transfer', targetBudgetLineId: `${key}_dst` }).expect(200);

    const rows = movements(branchA).filter((r) => r.type === 'budget_charge');
    expect(rows.map((r) => [r.category, r.amount, r.reference_id])).toEqual([
      [BUDGET_MOVEMENT_CATEGORY.allocation, 8000, `${key}_src`],
      [BUDGET_MOVEMENT_CATEGORY.transfer_out, -8000, `${key}_src`],
      [BUDGET_MOVEMENT_CATEGORY.transfer_in, 8000, `${key}_dst`],
    ]);
    expect(movements(branchA).filter((r) => r.type === 'saving_transfer')).toHaveLength(0);

    expect(line(`${key}_src`)).toMatchObject({ current_amount: 0, allocated_amount: 0 });
    expect(line(`${key}_dst`)).toMatchObject({ current_amount: 8000, allocated_amount: 8000 });

    const after = computeReconciliation({ branchId: branchA, isAll: false });
    expect([after.cashVariance, after.savingVariance, after.budgetVariance]).toEqual([0, 0, 0]);
    expect(after.healthy).toBe(true);
  });

  it('a budget transfer never appears in any savings figure', async () => {
    makeLine(`${key}_s1`, 'Source', branchA);
    makeLine(`${key}_s2`, 'Target', branchA);
    await deposit(5000);
    await charge(`${key}_s1`, 5000).expect(201);
    await monthEnd(`${key}_s1`, { decision: 'transfer', targetBudgetLineId: `${key}_s2` }).expect(200);

    const engine = await supertest(app).post('/api/finance/saving-engine/run').set(owner).expect(200);
    expect(engine.body.alreadyTransferredToday).toBe(0);
    const savedToday = db
      .prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='saving_transfer' AND branch_id = ?`)
      .get(branchA) as { v: number };
    expect(savedToday.v).toBe(0);
  });

  it('WP07-F3 · settling another branch line books the movement to that branch', async () => {
    makeLine(`${key}_b1`, 'B Rent', branchB);
    await deposit(5000);
    await charge(`${key}_b1`, 5000).expect(201);
    await monthEnd(`${key}_b1`, { decision: 'return' }).expect(200);

    const rowsB = movements(branchB).filter((r) => r.type === 'budget_charge');
    expect(rowsB.map((r) => r.amount)).toEqual([5000, -5000]);
    expect(movements(branchA).filter((r) => r.type === 'budget_charge')).toHaveLength(0);

    expect(computeReconciliation({ branchId: branchB, isAll: false }).healthy).toBe(true);
    expect(computeReconciliation({ branchId: branchA, isAll: false }).healthy).toBe(true);
    expect(computeReconciliation({ branchId: null, isAll: true }).healthy).toBe(true);
  });
});

describe('WP-07 · budget movement inputs are parsed, not coerced', () => {
  beforeEach(async () => {
    makeLine(`${key}_v`, 'Validated', branchA);
    await deposit(20000);
  });

  it.each([
    ['a fractional amount', 10.5],
    ['an array', [700]],
    ['a boolean', true],
    ['a hex string', '0x10'],
    ['an empty string', ''],
    ['null', null],
    ['zero', 0],
    ['a negative amount', -500],
  ])('rejects %s with 400 and writes nothing', async (_label, amount) => {
    const res = await charge(`${key}_v`, amount);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/charge amount/i);
    expect(line(`${key}_v`).current_amount).toBe(0);
    expect(movements(branchA).filter((r) => r.type === 'budget_charge')).toHaveLength(0);
  });

  it('accepts a numeric string as the whole AFN it spells', async () => {
    await charge(`${key}_v`, '750').expect(201);
    expect(line(`${key}_v`)).toMatchObject({ current_amount: 750, allocated_amount: 750 });
    const row = movements(branchA).find((r) => r.type === 'budget_charge')!;
    expect(row.amount).toBe(750);
    expect(db.prepare(`SELECT typeof(amount) t FROM financial_transactions WHERE id = ?`).get(
      (db.prepare(`SELECT id FROM financial_transactions WHERE reference_id = ?`).get(`${key}_v`) as { id: string }).id,
    )).toEqual({ t: 'integer' });
  });

  it('refuses to fund a line the treasury cannot cover, leaving both untouched', async () => {
    const res = await charge(`${key}_v`, 999999);
    expect(res.status).toBe(409);
    expect(line(`${key}_v`).current_amount).toBe(0);
    expect(computeReconciliation({ branchId: branchA, isAll: false }).healthy).toBe(true);
  });
});

describe('WP-07 · month-end settlement rejects incoherent instructions', () => {
  beforeEach(async () => {
    makeLine(`${key}_m`, 'Source', branchA);
    await deposit(3000);
    await charge(`${key}_m`, 3000).expect(201);
  });

  it('refuses a transfer to the line itself', async () => {
    const res = await monthEnd(`${key}_m`, { decision: 'transfer', targetBudgetLineId: `${key}_m` });
    expect(res.status).toBe(400);
    expect(line(`${key}_m`).current_amount).toBe(3000);
    expect(movements(branchA).filter((r) => r.category.startsWith('budget_transfer'))).toHaveLength(0);
  });

  it('refuses a transfer that would cross a branch boundary', async () => {
    makeLine(`${key}_far`, 'Other branch', branchB);
    const res = await monthEnd(`${key}_m`, { decision: 'transfer', targetBudgetLineId: `${key}_far` });
    expect(res.status).toBe(400);
    expect(line(`${key}_m`).current_amount).toBe(3000);
    expect(line(`${key}_far`).current_amount).toBe(0);
  });

  it('refuses a transfer into a retired line', async () => {
    makeLine(`${key}_dead`, 'Retired', branchA, false);
    const res = await monthEnd(`${key}_m`, { decision: 'transfer', targetBudgetLineId: `${key}_dead` });
    expect(res.status).toBe(409);
    expect(line(`${key}_m`).current_amount).toBe(3000);
  });

  it('refuses a settlement of an empty line', async () => {
    await monthEnd(`${key}_m`, { decision: 'return' }).expect(200);
    const res = await monthEnd(`${key}_m`, { decision: 'return' });
    expect(res.status).toBe(400);
    expect(computeReconciliation({ branchId: branchA, isAll: false }).healthy).toBe(true);
  });

  it('a repeated return cannot drain the line twice', async () => {
    const [first, second] = await Promise.all([
      monthEnd(`${key}_m`, { decision: 'return' }),
      monthEnd(`${key}_m`, { decision: 'return' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(line(`${key}_m`)).toMatchObject({ current_amount: 0, allocated_amount: 0 });

    const returns = movements(branchA).filter((r) => r.category === BUDGET_MOVEMENT_CATEGORY.return);
    expect(returns).toHaveLength(1);
    expect(computeReconciliation({ branchId: branchA, isAll: false }).healthy).toBe(true);
  });
});

describe('WP-07 · the movement writer refuses to be used unsafely', () => {
  it('will not write outside a transaction', () => {
    makeLine(`${key}_t`, 'Line', branchA);
    expect(() =>
      postBudgetMovement({
        line: { id: `${key}_t`, name: 'Line', branch_id: branchA },
        kind: 'allocation', amount: 100, date: '2026-06-01',
        description: 'no transaction', operatorName: 'Test',
      }),
    ).toThrow(/outside a transaction/i);
    expect(movements(branchA)).toHaveLength(0);
  });

  it('will not take money out of a line that does not hold it', () => {
    makeLine(`${key}_u`, 'Line', branchA);
    expect(() =>
      db.transaction(() =>
        postBudgetMovement({
          line: { id: `${key}_u`, name: 'Line', branch_id: branchA },
          kind: 'return', amount: 100, date: '2026-06-01',
          description: 'overdraw', operatorName: 'Test',
        }),
      )(),
    ).toThrow(/Insufficient budget/i);
    expect(movements(branchA)).toHaveLength(0);
  });
});

describe('WP-07 · the P&L discloses each budget movement by what an operator did', () => {
  it('separates funding, returns and reassignment instead of netting them', async () => {
    makeLine(`${key}_p1`, 'Line one', branchA);
    makeLine(`${key}_p2`, 'Line two', branchA);
    await deposit(10000);
    await charge(`${key}_p1`, 10000).expect(201);
    await monthEnd(`${key}_p1`, { decision: 'transfer', targetBudgetLineId: `${key}_p2` }).expect(200);
    await monthEnd(`${key}_p2`, { decision: 'return' }).expect(200);

    const pnl = await supertest(app).get(`/api/finance/pnl?branchId=${branchA}`).set(owner).expect(200);
    expect(pnl.body.transfers).toMatchObject({
      budgetCharged: 10000,
      budgetReturned: 10000,
      budgetTransferred: 10000,
      savingTransferred: 0,
    });
    // None of it is trading activity.
    expect(pnl.body.income).toBe(0);
    expect(pnl.body.expense).toBe(0);
  });
});

describe('WP-07 · reconciliation compares whole AFN exactly', () => {
  it('reports a one-afghani break rather than tolerating it', () => {
    db.transaction(() =>
      recordIncome({
        category: 'fee', amount: 1000, date: '2026-06-01', description: 'fee',
        operatorName: 'Test', operatorRole: 'owner', branchId: branchA,
      }),
    )();
    expect(computeReconciliation({ branchId: branchA, isAll: false }).healthy).toBe(true);

    db.prepare(`UPDATE finance_accounts SET main_balance = main_balance + 1 WHERE scope_type='branch' AND scope_id = ?`).run(branchA);
    const broken = computeReconciliation({ branchId: branchA, isAll: false });
    expect(broken.cashVariance).toBe(1);
    expect(broken.healthy).toBe(false);
  });
});

describe('WP-07 · the savings rate is configuration, and it is validated', () => {
  it('rejects a percentage that is not a number instead of storing it', async () => {
    const res = await supertest(app).put('/api/finance/saving-engine/settings').set(owner).send({ percent: 'abc' });
    expect(res.status).toBe(400);
    const stored = db.prepare(`SELECT value FROM system_settings WHERE key = 'daily_saving_percent'`).get() as { value: string };
    expect(stored.value).toBe('5');
  });

  it.each([[-1], [101], [true], [null]])('rejects %s', async (percent) => {
    const res = await supertest(app).put('/api/finance/saving-engine/settings').set(owner).send({ percent });
    expect(res.status).toBe(400);
  });

  it('accepts a valid rate and applies exactly that rate to income', async () => {
    await supertest(app).put('/api/finance/saving-engine/settings').set(owner).send({ percent: 10 }).expect(200);
    db.transaction(() =>
      recordIncome({
        category: 'fee', amount: 1000, date: '2026-06-01', description: 'fee',
        operatorName: 'Test', operatorRole: 'owner', branchId: branchA,
      }),
    )();
    const acct = db.prepare(`SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id = ?`).get(branchA) as
      { main_balance: number; saving_balance: number };
    expect(acct).toEqual({ main_balance: 900, saving_balance: 100 });
  });

  it('refuses to record income against a corrupt stored rate rather than silently using another one', () => {
    // Only a direct database edit can produce this now; the write path rejects it.
    setSetting('daily_saving_percent', '150');
    expect(() =>
      db.transaction(() =>
        recordIncome({
          category: 'fee', amount: 1000, date: '2026-06-01', description: 'fee',
          operatorName: 'Test', operatorRole: 'owner', branchId: branchA,
        }),
      )(),
    ).toThrow(/outside 0-100/i);
    const acct = db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE branch_id = ?`).get(branchA) as { c: number };
    expect(acct.c).toBe(0);
  });
});
