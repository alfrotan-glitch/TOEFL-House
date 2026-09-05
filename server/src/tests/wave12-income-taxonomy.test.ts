/**
 * WAVE 12 · Capability 1 — INCOME TAXONOMY (adversarial verification).
 * ============================================================================
 * Attacks the conservative boundary from every direction:
 *   · an unknown/undeclared inflow category is REJECTED at the write boundary;
 *   · if one ever reaches the ledger anyway (drift), it is EXCLUDED from
 *     operating income on every surface and flagged by I20;
 *   · declared non-operating classes (capital_injection, non_operating_other)
 *     never contaminate trading results;
 *   · refunds preserve the original economic classification (contra-revenue);
 *   · every operating-income surface agrees because they share ONE predicate —
 *     proven by deriving the figure independently from raw rows and comparing
 *     it against the P&L route and the checker's own SQL.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import financeRouter from '../routes/finance.routes.js';
import fundingRouter from '../routes/funding.routes.js';
import rulesRouter from '../routes/rules.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import {
  OPERATING_INCOME_SQL,
  classifyIncomeRow,
  isOperatingIncome,
} from '../core/finance/ledger-classification.js';
import {
  CANONICAL_INCOME_CATEGORIES,
  assertCanonicalIncomeCategory,
} from '../core/finance/category-taxonomy.js';
import { recordIncome } from '../utils/income.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bearerFor, seedUser } from './support/identity.js';

const OWNER = 'user_w12_owner';
const BRANCH = 'branch_w12_inc';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/finance', financeRouter);
app.use('/api/funding', fundingRouter);
app.use('/api/rules', rulesRouter);
app.use(errorHandler);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0770${String(100000 + (seq % 900000)).slice(-6)}`;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
};

const operatingIncomeSum = (): number => {
  const rows = db.prepare('SELECT type, category, amount FROM financial_transactions').all() as Array<{ type: string; category: string; amount: number }>;
  // Independent: in-memory classification of raw rows, no SQL predicate reuse.
  return rows.filter((r) => classifyIncomeRow(r) !== null
    && CANONICAL_INCOME_CATEGORIES.find((c) => c.id === r.category)?.inOperatingResult === true
    && r.type === 'income')
    .reduce((sum, r) => sum + Number(r.amount), 0);
};

async function makeClass(name: string, fee: number): Promise<string> {
  const res = await request(app).post('/api/classes').set(owner()).send({
    name, level: 'A1', capacity: 30, fee, startDate: '2026-09-01', branchId: BRANCH,
  });
  assertOk('class create', res, 201);
  return res.body.id as string;
}

async function makeStudent(name: string): Promise<string> {
  const res = await request(app).post('/api/students/manual').set(owner()).send({
    fullName: name, phone: phone(), branchId: BRANCH, gender: 'male',
  });
  assertOk('student create', res, 201);
  const studentId = (res.body.student?.id ?? res.body.id) as string;
  const list = await request(app).get(`/api/invoices?studentId=${studentId}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const registration = invoices.find((i: { chargeKind?: string; purpose?: string; status?: string }) =>
    (i.chargeKind ?? i.purpose) === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  if (registration) {
    const paid = await request(app).post(`/api/invoices/${registration.id}/pay`).set(owner())
      .send({ amount: registration.netAmount, paymentMethod: 'cash' });
    assertOk('registration pay', paid, 200, 201);
  }
  return studentId;
}

async function enroll(studentId: string, classId: string, term: string): Promise<string> {
  const res = await request(app).post(`/api/students/${studentId}/enroll-semester`).set(owner()).send({
    classId, semesterName: term, startDate: '2026-09-01', endDate: '2026-12-20',
  });
  assertOk('enroll', res, 201);
  return res.body.semesterId as string;
}

const pnlIncome = async (): Promise<number> => {
  const res = await request(app).get('/api/finance/pnl').set(owner());
  assertOk('pnl', res, 200);
  return Number(res.body.income);
};

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W12 Income Branch')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });
  const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
    branchId: BRANCH, feeType: 'registration', name: 'W12 registration',
    amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
  });
  assertOk('fee rule', rule, 200, 201);
});

describe('W12-1 · income taxonomy — writer inventory & freeze', () => {
  it('the canonical vocabulary is exactly the audited writer set plus the conservative class', () => {
    // Every writer inventoried in the audit (recordIncome call sites + treasury
    // deposit) plus the one declared-but-unwritten conservative class.
    expect([...CANONICAL_INCOME_CATEGORIES.map((c) => c.id)].sort()).toEqual([
      'book', 'capital_injection', 'card', 'chapter', 'diploma', 'donation',
      'exam', 'fee', 'installment', 'non_operating_other', 'other', 'placement', 'refund',
    ].sort());
  });

  it('each declared class carries an explicit accounting treatment', () => {
    for (const c of CANONICAL_INCOME_CATEGORIES) {
      expect(c.note.length).toBeGreaterThan(10);
      expect(['operating_revenue', 'funding_income', 'contra_revenue', 'equity_contribution', 'non_operating_inflow'])
        .toContain(c.classification);
      // The operating-result flag follows the classification semantics.
      if (c.classification === 'equity_contribution' || c.classification === 'non_operating_inflow') {
        expect(c.inOperatingResult).toBe(false);
      } else {
        expect(c.inOperatingResult).toBe(true);
      }
    }
  });
});

describe('W12-1 · the write boundary refuses undeclared inflows', () => {
  it('recordIncome throws for an unknown category and writes nothing', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
    for (const bad of ['misc', 'Misc', 'revenue', '', 'other ', 'salary_rebate']) {
      const write = db.transaction(() => {
        recordIncome({
          category: bad, amount: 500, description: 'probe', operatorName: 'probe', branchId: BRANCH,
        });
      });
      expect(() => write()).toThrow(/Unknown income category/);
      const after = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;
      expect(after).toBe(before);
    }
  });

  it('assertCanonicalIncomeCategory accepts every canonical code and rejects everything else', () => {
    for (const c of CANONICAL_INCOME_CATEGORIES) expect(() => assertCanonicalIncomeCategory(c.id)).not.toThrow();
    for (const bad of ['unknown', 'fee2', 'FEE'] as const) expect(() => assertCanonicalIncomeCategory(bad)).toThrow();
  });
});

describe('W12-1 · drift is excluded everywhere and flagged (I20)', () => {
  it('a rogue income row never reaches the P&L and is named by I20', async () => {
    const before = await pnlIncome();
    const rogueId = 'tx_w12_rogue';
    try {
      // Direct insert = the only way a drift row can exist (boundary rejects
      // it at every writer). Schema-legal: income has no FK on category.
      db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
                  VALUES (?, 'income', 'mystery_inflow', 7777, '2026-09-05', 'W12 drift probe', ?)`).run(rogueId, BRANCH);

      // 1. Excluded from operating income on the shared predicate…
      const byPredicate = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE ${OPERATING_INCOME_SQL}`).get() as { v: number }).v);
      // 2. …and in the in-memory derivation…
      expect(operatingIncomeSum()).toBe(byPredicate);
      // 3. …and on the P&L route.
      expect(await pnlIncome()).toBe(before);

      // 4. Flagged by I20, naming the row.
      const findings = runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I20');
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.entityId === rogueId)).toBe(true);
    } finally {
      db.prepare('DELETE FROM financial_transactions WHERE id = ?').run(rogueId);
    }
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I20')).toEqual([]);
  });
});

describe('W12-1 · declared non-operating classes stay out of trading results', () => {
  it('a capital injection credits the treasury but is not operating income', async () => {
    const before = await pnlIncome();
    const deposit = await request(app).post('/api/finance/treasury/deposit').set(owner())
      .send({ amount: 50000, notes: 'W12 equity probe' });
    assertOk('treasury deposit', deposit, 201);
    expect(await pnlIncome()).toBe(before); // unchanged
    // …but it IS held in stores (equity, not revenue).
    const held = Number((db.prepare(`SELECT COALESCE(SUM(main_balance + saving_balance),0) v FROM finance_accounts WHERE scope_type='organization'`).get() as { v: number }).v);
    expect(held).toBeGreaterThan(0);
  });

  it('a non_operating_other inflow (no writer today) is reportable but non-operating', async () => {
    const before = await pnlIncome();
    const id = 'tx_w12_nonop';
    try {
      db.prepare(`INSERT INTO financial_transactions (id, type, category, amount, date, description, branch_id)
                  VALUES (?, 'income', 'non_operating_other', 1234, '2026-09-05', 'W12 declared non-operating probe', ?)`).run(id, BRANCH);
      expect(await pnlIncome()).toBe(before); // excluded from trading result
      // It is a DECLARED class: I20 must NOT flag it.
      expect(runFinancialInvariantChecks(db).some((f) => f.invariant === 'I20' && f.entityId === id)).toBe(false);
      // And the P&L shows it on its own (non-income) line, not silently hidden.
      const pnl = await request(app).get('/api/finance/pnl').set(owner());
      const flat = JSON.stringify(pnl.body);
      expect(flat).toContain('1234');
    } finally {
      db.prepare('DELETE FROM financial_transactions WHERE id = ?').run(id);
    }
  });
});

describe('W12-1 · production writers land in the right class', () => {
  let student: string;
  let semesterId: string;
  let paymentId: string;

  it('fee income (via enroll-semester) is operating and on the fee line', async () => {
    const cid = await makeClass(unique('W12 Tax Class'), 4000);
    student = await makeStudent(unique('W12 Tax Student'));
    const before = await pnlIncome();
    semesterId = await enroll(student, cid, 'W12 Tax Term');
    // paidNow at enrollment is 0 by default in this harness (no paidNow sent);
    // create a real fee payment through the payments surface.
    const pay = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'fee', semesterId, amount: 1500 });
    assertOk('fee pay', pay, 201);
    paymentId = (db.prepare('SELECT id FROM payments WHERE receipt_number = ?').get(pay.body.receiptNumber) as { id: string }).id;
    const rows = db.prepare('SELECT type, category, amount FROM financial_transactions WHERE payment_id = ?').all(paymentId) as Array<{ type: string; category: string; amount: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'income', category: 'fee', amount: 1500 });
    expect(await pnlIncome()).toBe(before + 1500);
  });

  it('refund preserves the original classification as contra-revenue (not a new class)', async () => {
    const before = await pnlIncome();
    const refund = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 500, reason: 'W12 taxonomy refund probe' });
    assertOk('refund', refund, 200, 201);
    // Original fee row untouched; a NEGATIVE refund row was added.
    const original = db.prepare('SELECT category, amount FROM financial_transactions WHERE payment_id = ?').get(paymentId) as { category: string; amount: number };
    expect(original).toMatchObject({ category: 'fee', amount: 1500 });
    const refundRow = db.prepare(`SELECT category, amount FROM financial_transactions WHERE type='income' AND amount < 0 ORDER BY rowid DESC LIMIT 1`).get() as { category: string; amount: number };
    expect(refundRow).toMatchObject({ category: 'refund', amount: -500 });
    // Operating income nets the contra exactly.
    expect(await pnlIncome()).toBe(before - 500);
  });

  it('ad-hoc desk income keeps its reason and the operating class', async () => {
    const before = await pnlIncome();
    const adhoc = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'other', amount: 300, notes: 'W12 replacement handout' });
    assertOk('ad-hoc pay', adhoc, 201);
    const row = db.prepare(`SELECT category, amount FROM financial_transactions WHERE payment_id = (SELECT id FROM payments WHERE receipt_number = ?)`).get(adhoc.body.receiptNumber) as { category: string; amount: number };
    expect(row).toMatchObject({ category: 'other', amount: 300 });
    expect(await pnlIncome()).toBe(before + 300);
  });

  it('a restricted donation is operating funding income on its own line', async () => {
    const before = await pnlIncome();
    const donor = await request(app).post('/api/funding/donors').set(owner())
      .send({ fullName: unique('W12 Donor'), type: 'individual' });
    assertOk('donor', donor, 201);
    const campaign = await request(app).post('/api/funding/campaigns').set(owner())
      .send({ name: unique('W12 Campaign'), targetAmount: 100000, branchId: BRANCH });
    assertOk('campaign', campaign, 201);
    const donation = await request(app).post('/api/funding/donations').set(owner())
      .send({ donorId: donor.body.id, amount: 10000, branchId: BRANCH, restriction: { kind: 'campaign', targetId: campaign.body.id } });
    assertOk('donation', donation, 201);

    expect(await pnlIncome()).toBe(before + 10000); // funding income IS operating (W9: funding line)
    // …displayed as its own funding line, not merged into fees.
    const pnl = await request(app).get('/api/finance/pnl').set(owner());
    const donationLine = JSON.stringify(pnl.body);
    expect(donationLine).toContain('"donation"');
  });
});

describe('W12-1 · surfaces agree because they share one authority', () => {
  it('P&L route == shared SQL predicate == independent in-memory derivation', async () => {
    const a = await pnlIncome();
    const b = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE ${OPERATING_INCOME_SQL}`).get() as { v: number }).v);
    const c = operatingIncomeSum();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('duplicate/double-clicked income events do not double-count (idempotent writers)', async () => {
    const cid = await makeClass(unique('W12 Dup Class'), 3000);
    const sid = await makeStudent(unique('W12 Dup Student'));
    const sem = await enroll(sid, cid, 'W12 Dup Term');
    const pay = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: sem, amount: 3000 });
    assertOk('dup pay 1', pay, 201);
    const before = await pnlIncome();
    const dup = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: sem, amount: 3000 });
    // Guarded category: the business-event guard refuses (term already settled).
    expect([400, 409]).toContain(dup.status);
    expect(await pnlIncome()).toBe(before);
  });

  it('the full checker stays green on the honest world (incl. I20/I21)', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
