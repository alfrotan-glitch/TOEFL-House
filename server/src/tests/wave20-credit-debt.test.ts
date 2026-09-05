/**
 * WAVE 20 · CREDIT/DEBT SUBSYSTEM — adversarial verification.
 * ============================================================================
 * The W16 owner directive decided the semantics (registered D-181); this wave
 * implements them completely:
 *   · A credit purchase is a PAYABLE at receipt — no ledger row, no income,
 *     no expense until settled in cash through the ONE budget authority.
 *   · Settlement pays via the budget path and links its expense evidence
 *     (I23); a return reduces the open debt (no cash) or raises a refund
 *     receivable; a received refund is P&L-neutral 'supplier_refund' cash-in,
 *     never income.
 *   · A loan is a principal-only LIABILITY: proceeds credit the organization
 *     treasury through 'loan_proceeds' (never income, never capital); principal
 *     repayment debits it through a signed-negative 'loan_repayment' row
 *     (I24); interest has NO surface (a rate is owner policy).
 * Every conservation layer (I11/I12/I13/I16/I23/I24), the reconciliation and
 * the daily statement must stay green throughout.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import financeRouter from '../routes/finance.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';

const OWNER = 'user_w20_sa';
const TEACHER = 'user_w20_t';
const BRANCH = 'branch_w20_sa';

const app = express();
app.use(express.json());
app.use('/api/finance', financeRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
const teacher = () => bearerFor(TEACHER);
const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
};
const checkerClean = () => expect(runFinancialInvariantChecks(db)).toEqual([]);
const incomeTotal = () =>
  Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE type='income'`).get() as { v: number }).v);

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W20') ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH, scopeType: 'organization' });
  seedUser({ id: TEACHER, role: 'teacher', branchId: BRANCH });
  // No income is raised in this suite, so the saving sweep never fires; the
  // branch cash reconciliation is exercised directly via supplier refunds.
});

describe('W20 · A. supplier credit purchases (payables)', () => {
  let supplierId: string;
  let invoiceId: string;
  let budgetLineId: string;

  it('declares a payable with ZERO ledger effect — a liability, not P&L', async () => {
    const sup = await request(app).post('/api/finance/suppliers').set(owner()).send({ name: 'Kabul Book Supply', phone: '0700111222' });
    assertOk('supplier', sup, 201);
    supplierId = sup.body.id;

    const ftBefore = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    const incomeBefore = incomeTotal();
    const inv = await request(app).post('/api/finance/supplier-invoices').set(owner())
      .send({ supplierId, branchId: BRANCH, amount: 60000, description: '200 textbooks on 30-day credit' });
    assertOk('payable', inv, 201);
    invoiceId = inv.body.id;

    expect((db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c).toBe(ftBefore); // nothing moved
    expect(incomeTotal()).toBe(incomeBefore);
    const reg = await request(app).get(`/api/finance/payables?branchId=${BRANCH}`).set(owner());
    assertOk('register', reg, 200);
    const body = reg.body as { totals: { openPayables: number }; invoices: Array<{ id: string; outstanding: number; status: string }> };
    expect(body.totals.openPayables).toBe(60000);
    expect(body.invoices.find((i) => i.id === invoiceId)?.outstanding).toBe(60000);
    assertOk('teacher cannot declare', await request(app).post('/api/finance/supplier-invoices').set(teacher())
      .send({ supplierId, branchId: BRANCH, amount: 1000, description: 'unauthorized payable' }), 403);
    checkerClean();
  });

  it('settles through the ONE budget authority and links its expense evidence', async () => {
    assertOk('treasury', await request(app).post('/api/finance/treasury/deposit').set(owner()).send({ amount: 200000, notes: 'W20 payable funding' }), 201);
    const bl = await request(app).post('/api/finance/budget-lines').set(owner())
      .send({ subcategoryId: 'sub_it_equipment', name: 'W20 Books Credit Line', branchId: BRANCH });
    assertOk('budget line', bl, 201);
    budgetLineId = bl.body.id;
    assertOk('charge', await request(app).post(`/api/finance/budget-lines/${budgetLineId}/charge`).set(owner()).send({ amount: 100000 }), 201);

    const incomeBefore = incomeTotal();
    const over = await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/settle`).set(owner())
      .send({ amount: 60001, budgetLineId });
    assertOk('over-settle refused', over, 409);

    const settle = await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/settle`).set(owner())
      .send({ amount: 40000, budgetLineId, paymentMethod: 'bank_transfer' });
    assertOk('settle', settle, 200);
    const pos = (settle.body as { position: { settled: number; outstanding: number } }).position;
    expect(pos.settled).toBe(40000);
    expect(pos.outstanding).toBe(20000);
    expect(incomeTotal()).toBe(incomeBefore); // a settlement is an EXPENSE event, never income
    // I23 satisfied: the payment links an equal expense row.
    checkerClean();
  });

  it('reduces the open debt on return, and refuses mixed part-debt/part-refund returns', async () => {
    const ret = await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/return`).set(owner())
      .send({ amount: 5000, reason: '30 damaged copies returned to the supplier' });
    assertOk('return reduces debt', ret, 201);
    expect((ret.body as { kind: string }).kind).toBe('payable_reduction');
    expect((ret.body as { position: { outstanding: number } }).position.outstanding).toBe(15000);

    const mixed = await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/return`).set(owner())
      .send({ amount: 20000, reason: 'More than the remaining open debt' });
    assertOk('mixed return refused', mixed, 409);
    checkerClean();
  });

  it('a return after settlement raises a refund receivable, received as P&L-neutral cash-in', async () => {
    // settle the remainder first
    assertOk('final settle', await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/settle`).set(owner())
      .send({ amount: 15000, budgetLineId }), 200);

    const ret = await request(app).post(`/api/finance/supplier-invoices/${invoiceId}/return`).set(owner())
      .send({ amount: 8000, reason: 'Printer took back the misdelivered atlas set' });
    assertOk('refund-due return', ret, 201);
    expect((ret.body as { kind: string }).kind).toBe('refund_due');
    const returnId = (ret.body as { id: string }).id;

    const incomeBefore = incomeTotal();
    const mainBefore = getFinanceAccount('branch', BRANCH).mainBalance;
    const recv = await request(app).post(`/api/finance/supplier-returns/${returnId}/receive-refund`).set(owner()).send({});
    assertOk('receive refund', recv, 200);
    const txId = (recv.body as { transactionId: string }).transactionId;

    expect(getFinanceAccount('branch', BRANCH).mainBalance - mainBefore).toBe(8000);
    const row = db.prepare(`SELECT type, amount FROM financial_transactions WHERE id = ?`).get(txId) as { type: string; amount: number };
    expect(row.type).toBe('supplier_refund');
    expect(row.amount).toBe(8000);
    expect(incomeTotal()).toBe(incomeBefore); // NEVER income
    assertOk('refund replay refused', await request(app).post(`/api/finance/supplier-returns/${returnId}/receive-refund`).set(owner()).send({}), 409);
    checkerClean(); // I11/I16 already know supplier_refund

    const rec = await request(app).get(`/api/finance/reconciliation?branchId=${BRANCH}`).set(owner());
    assertOk('reconciliation', rec, 200);
    expect((rec.body as { cashVariance: number }).cashVariance).toBe(0);
  });
});

describe('W20 · B. loans (principal-only liabilities)', () => {
  it('records proceeds into the treasury as P&L-neutral cash — never income, never capital', async () => {
    const incomeBefore = incomeTotal();
    const treasuryBefore = getFinanceAccount('organization', 'global').mainBalance;
    const loan = await request(app).post('/api/finance/loans').set(owner())
      .send({ lenderName: 'Herat Family Fund', principal: 150000, purpose: 'Second classroom buildout' });
    assertOk('loan', loan, 201);

    expect(getFinanceAccount('organization', 'global').mainBalance - treasuryBefore).toBe(150000);
    const txId = (loan.body as { transactionId: string }).transactionId;
    const row = db.prepare(`SELECT type, category, amount FROM financial_transactions WHERE id = ?`).get(txId) as { type: string; category: string; amount: number };
    expect(row.type).toBe('loan_proceeds');
    expect(row.category).toBe('loan_principal');
    expect(row.amount).toBe(150000);
    expect(incomeTotal()).toBe(incomeBefore);
    checkerClean(); // I13/I16/I24 green

    const list = await request(app).get('/api/finance/loans').set(owner());
    assertOk('loan register', list, 200);
    expect((list.body as { totals: { outstanding: number } }).totals.outstanding).toBe(150000);
    assertOk('teacher cannot borrow', await request(app).post('/api/finance/loans').set(teacher())
      .send({ lenderName: 'X Fund', principal: 1000 }), 403);
  });

  it('repays principal through a signed-negative P&L-neutral row; over-repay and replay refused', async () => {
    const loansRes = await request(app).get('/api/finance/loans').set(owner());
    assertOk('loan register', loansRes, 200);
    const loanId = ((loansRes.body as { loans: Array<{ id: string }> }).loans[0]).id;
    const treasuryBefore = getFinanceAccount('organization', 'global').mainBalance;

    const over = await request(app).post(`/api/finance/loans/${loanId}/repay`).set(owner()).send({ amount: 150001 });
    assertOk('over-repay refused', over, 409);

    const part = await request(app).post(`/api/finance/loans/${loanId}/repay`).set(owner()).send({ amount: 50000 });
    assertOk('partial repay', part, 200);
    expect(treasuryBefore - getFinanceAccount('organization', 'global').mainBalance).toBe(50000);
    const txId = (part.body as { transactionId: string }).transactionId;
    const row = db.prepare(`SELECT type, amount FROM financial_transactions WHERE id = ?`).get(txId) as { type: string; amount: number };
    expect(row.type).toBe('loan_repayment');
    expect(row.amount).toBe(-50000);
    checkerClean();

    assertOk('final repay', await request(app).post(`/api/finance/loans/${loanId}/repay`).set(owner()).send({ amount: 100000 }), 200);
    assertOk('replay refused', await request(app).post(`/api/finance/loans/${loanId}/repay`).set(owner()).send({ amount: 1 }), 409);
    checkerClean();
  });

  it('keeps the daily statement truthful after a supplier refund', async () => {
    const daily = await request(app).get(`/api/reports/cash-activity/daily`).set(owner()).query({ branchId: BRANCH });
    // The reports router is not mounted here; query the core directly instead.
    void daily;
    const { getDailyCashActivity } = await import('../core/reporting/financial-observability.js');
    const today = String(await import('../utils/ids.js').then((m) => m.today()));
    const stmt = getDailyCashActivity(db, { branchId: BRANCH, date: today });
    expect(stmt.movements.supplierRefunds).toBe(8000);
    expect(stmt.closing.main).toBe(getFinanceAccount('branch', BRANCH).mainBalance);
    checkerClean();
  });
});
