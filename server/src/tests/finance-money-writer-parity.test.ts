/**
 * Money-writer parity — regression suite for finance finding F-5.
 *
 * Rounds 1 and 2 fixed `Number()` coercion on the two *expense* writers
 * (`/finance/operational-payments`, `/finance/expense-requests`). Round 3
 * applied the same lens to the *income and refund* writers and found three
 * more instances of the identical pattern, all moving real cash.
 *
 * PRE-FIX BEHAVIOUR, reproduced live on a fresh database:
 *
 *   POST /api/invoices/:id/pay            (`Number(amount)`, only `> 0`)
 *       true   -> 201, a 1 AFN payment    (branch cash +0.95 after the sweep)
 *       [500]  -> 201, a 500 AFN payment  (cash +475.00)
 *       '0x10' -> 201, a 16 AFN payment   (cash +15.20)
 *       [[7]]  -> 201, a 7 AFN payment
 *       0.001  -> 500, leaking the two-decimal database trigger
 *
 *   POST /api/students/:id/payments       (`Number(amount)` twice: once for the
 *                                          idempotency fingerprint, once for
 *                                          validation — they could disagree)
 *       true / [500] / '0x10' / [[7]] -> 201, real charges with real cash
 *       0.001 -> 500 (same trigger leak)
 *
 *   POST /api/students/:id/refund         (`Number(amount)`; money moves OUT)
 *       true   -> 201, a real -1 AFN refund   (branch cash -1.00)
 *       [500]  -> 201, a real -500 AFN refund (branch cash -500.00)
 *       '0x10' -> 201, a real -16 AFN refund
 *       0.001  -> 500 (same trigger leak)
 *
 *   POST /api/funding/donations           (`!amount || amount <= 0` on the raw
 *                                          body — a coercion, not a validation)
 *       true / [[7]] / {a:1} -> 500 "SQLite3 can only bind numbers..." /
 *                               "Too few parameter values were provided"
 *       0.001                -> 500 leaking the raw database trigger text
 *       No cash ever moved and the transaction rolled back cleanly here, so
 *       this one is a CONTRACT defect, not a cash defect: client mistakes were
 *       reported as server faults with driver internals leaked to the caller.
 *
 * All four now parse with `assertMoney`, the boundary the rest of the money
 * surface already uses. No range changed: any amount >= 0.01 behaves exactly
 * as before, and `null`/absent still means "not supplied" where callers rely
 * on the endpoint to derive the charge.
 *
 * VERIFIED NOT A DEFECT (recorded so it is not re-reported): a payment followed
 * by an equal refund leaves branch main+saving EXACTLY conserved (55000.00 ->
 * 56000.00 -> 55000.00). Only the main/saving split shifts, which is
 * `recordIncome`'s documented savings-reclaim behaviour, not asymmetry.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { fundingRouter } from '../routes/funding.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';

const BR = 'fmwp_br';
let app: express.Express;
const U: Record<string, TokenPayload> = {};
const auth = (u: string) => ({ Authorization: `Bearer ${signToken(U[u])}` });

/** Not amounts. Each became a real money movement or a raw 500 pre-fix. */
const NON_AMOUNTS: Array<[string, unknown]> = [
  ['boolean true', true],
  ['array', [500]],
  ['nested array', [[7]]],
  ['hex string', '0x10'],
  ['sub-cent', 0.001],
  ['text', 'abc'],
  ['object', {}],
  ['negative', -100],
];

let seq = 0;
function mkStudent(): string {
  const sid = `fmwp_s${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO students (id, full_name, phone, student_code, branch_id, status, registration_date, gender)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 'male')`,
  ).run(sid, `Student ${sid}`, `072${String(1000000 + seq)}`, `FMWP-${seq}`, BR, today());
  return sid;
}
function mkInvoice(studentId: string, net: number): string {
  const iid = `fmwp_i${++seq}`;
  // The document says what it bills (D-118) and carries the line that says
  // what it is for; the payment boundary refuses a document that says neither.
  db.prepare(
    `INSERT OR REPLACE INTO invoices (id, student_id, issue_date, due_date, status, total_amount, discount_amount, net_amount, branch_id, purpose)
     VALUES (?, ?, ?, ?, 'issued', ?, 0, ?, ?, 'other')`,
  ).run(iid, studentId, today(), today(), net, net, BR);
  db.prepare(
    `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount)
     VALUES (?, ?, 'Ad-hoc charge', 1, ?, ?)`,
  ).run(`${iid}_it`, iid, net, net);
  return iid;
}

const paymentsOf = (sid: string) =>
  db.prepare('SELECT amount, typeof(amount) ty, category FROM payments WHERE student_id = ?').all(sid) as Array<Record<string, unknown>>;
const cash = () => getFinanceAccount('branch', BR);
const totalCash = () => { const a = cash(); return Math.round((a.mainBalance + a.savingBalance) * 100) / 100; };

const DONOR = 'fmwp_donor';
const CAMPAIGN = 'fmwp_camp';
const donate = (body: Record<string, unknown>) =>
  supertest(app).post('/api/funding/donations').set(auth('fmwp_fin'))
    .send({ donorId: DONOR, campaignId: CAMPAIGN, date: today(), ...body });

/**
 * The payment a refund reverses. Owner decision D-113 makes attribution
 * mandatory, so a fixture that refunds must name the charge it is reversing —
 * here, the student's most recent refundable payment.
 */
function latestRefundablePaymentId(studentId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM payments
        WHERE student_id = ? AND status = 'completed' AND category <> 'refund' AND amount > 0
        ORDER BY date DESC, rowid DESC LIMIT 1`,
    )
    .get(studentId) as { id: string } | undefined;
  if (!row) throw new Error(`fixture: student ${studentId} has no refundable payment`);
  return row.id;
}

/** Everything a donation is supposed to move, read together. */
const donationState = () => ({
  donations: Number((db.prepare('SELECT COUNT(*) c FROM donations').get() as { c: number }).c),
  raised: Number((db.prepare('SELECT raised_amount r FROM funding_campaigns WHERE id = ?').get(CAMPAIGN) as { r: number }).r),
  income: Number((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='donation'").get() as { s: number }).s),
});

const payInvoice = (iid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/invoices/${iid}/pay`).set(auth('fmwp_fin')).send(body);
const payStudent = (sid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${sid}/payments`).set(auth('fmwp_fin')).send({ category: 'other', notes: 'ad-hoc regression charge', ...body });
const refundStudent = (sid: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/students/${sid}/refund`).set(auth('fmwp_own')).send({
    reason: 'regression refund',
    // A refund names the payment it reverses (owner decision D-113).
    paymentId: latestRefundablePaymentId(sid),
    ...body,
  });

/** A 4xx carrying a human message, never a leaked driver/trigger error. */
function expectCleanClientError(res: { status: number; body: Record<string, unknown> }) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(String(res.body?.error ?? '')).not.toMatch(/decimal places|constraint|SQLite3|bind/i);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BR, 'FMWP Branch', 'Kabul');
  const pw = await hashPassword('pw');
  db.prepare("INSERT OR IGNORE INTO donors (id, full_name, type) VALUES (?, 'FMWP Donor', 'individual')").run(DONOR);
  db.prepare(
    `INSERT OR IGNORE INTO funding_campaigns (id, name, donor_id, target_amount, raised_amount, start_date, status, branch_id)
     VALUES (?, 'FMWP Campaign', ?, 1000000, 0, ?, 'active', ?)`,
  ).run(CAMPAIGN, DONOR, today(), BR);
  for (const [uid, role] of [['fmwp_own', 'owner'], ['fmwp_fin', 'finance']] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(uid, uid, uid, BR, pw);
    assignRole(uid, role, BR);
    U[uid] = { userId: uid, username: uid, branchId: BR, fullName: uid };
  }

  app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/funding', fundingRouter);
  app.use(errorHandler);
});

describe('F-5 · invoice payment parses its amount', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} and moves no cash`, async () => {
      const s = mkStudent();
      const iv = mkInvoice(s, 10_000);
      const before = totalCash();
      const res = await payInvoice(iv, { amount: value });
      expectCleanClientError(res);
      expect(paymentsOf(s)).toHaveLength(0);
      expect(totalCash()).toBe(before);
    });
  }

  it.each([
    ['whole number', 2500, 2500],
    ['numeric string', '3000', 3000],
    ['one hundred afghani', 100, 100],
  ])('still accepts a legitimate amount (%s)', async (_l, sent, stored) => {
    const s = mkStudent();
    const iv = mkInvoice(s, 50_000);
    const res = await payInvoice(iv, { amount: sent });
    expect(res.status).toBe(201);
    const rows = paymentsOf(s);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(stored);
    expect(rows[0].ty).toBe('integer');
  });

  it('never stores a TEXT amount in the REAL payments.amount column', async () => {
    const s = mkStudent();
    const iv = mkInvoice(s, 50_000);
    for (const [, v] of NON_AMOUNTS) await payInvoice(iv, { amount: v });
    const bad = Number((db.prepare("SELECT COUNT(*) c FROM payments WHERE typeof(amount) NOT IN ('real','integer')").get() as { c: number }).c);
    expect(bad).toBe(0);
  });
});

describe('F-5 · student ad-hoc payment parses its amount', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} and moves no cash`, async () => {
      const s = mkStudent();
      const before = totalCash();
      const res = await payStudent(s, { amount: value });
      expectCleanClientError(res);
      expect(paymentsOf(s)).toHaveLength(0);
      expect(totalCash()).toBe(before);
    });
  }

  it('still accepts a legitimate charge', async () => {
    const s = mkStudent();
    const res = await payStudent(s, { amount: 1000 });
    expect(res.status).toBe(201);
    expect(Number(paymentsOf(s)[0].amount)).toBe(1000);
  });

  it.each([
    ['explicit zero', 0],
    ['string zero', '0'],
    ['sub-cent rounding to zero', 0.001],
  ])('rejects a zero-value charge (%s)', async (_l, value) => {
    // assertMoney legitimately ROUNDS 0.001 to 0, so parsing alone does not
    // stop a zero-amount charge — only the endpoint's "> 0" rule does, and
    // mutation testing showed nothing covered it. A zero charge would write a
    // payment row and an income ledger row for no money.
    const s = mkStudent();
    const res = await payStudent(s, { amount: value });
    expect(res.status).toBe(400);
    expect(paymentsOf(s)).toHaveLength(0);
  });

  it('two amounts that round to the same cent are ONE charge, not two', async () => {
    // The idempotency fingerprint must be built from the PARSED amount, not the
    // raw input. 100.005 and 100.01 both persist as 100 — the identical
    // charge. Fingerprinting the raw value makes them look like two different
    // requests, so the retry of a rounded charge is accepted as new and the
    // student is DOUBLE-CHARGED. Reproduced: raw fingerprint -> 2 rows of
    // 100; parsed fingerprint -> 1 row + replay.
    const s = mkStudent();
    const a = await payStudent(s, { amount: 100 });
    expect(a.status).toBe(201);

    const b = await payStudent(s, { amount: '100' });
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(true);

    const rows = paymentsOf(s);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(100);
  });

  it('a category that derives its own fee is still payable with no amount supplied', async () => {
    // `null` must keep meaning "not supplied". Fixed-fee categories resolve the
    // charge from configuration, so routing every request through the parser
    // would 400 a legitimate card issuance ("Amount must be greater than 0.").
    const s = mkStudent();
    const res = await payStudent(s, { category: 'card', amount: undefined, notes: undefined });
    expect(res.status).toBe(201);
    expect(paymentsOf(s)).toHaveLength(1);
  });

  it('the idempotency fingerprint and the stored amount agree', async () => {
    // The fingerprint was derived from `Number(amount)` while validation used a
    // second, independent `Number(amount)`. Parsing once keeps a retry of the
    // SAME intent collapsing, which is only observable if both see one value.
    const s = mkStudent();
    const a = await payStudent(s, { amount: '750.00' });
    const b = await payStudent(s, { amount: '750.00' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(true);
    expect(paymentsOf(s)).toHaveLength(1);
    expect(Number(paymentsOf(s)[0].amount)).toBe(750);
  });
});

describe('F-5 · student refund parses its amount', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} and takes no cash out`, async () => {
      const s = mkStudent();
      expect((await payStudent(s, { amount: 5000 })).status).toBe(201);
      const before = totalCash();
      const res = await refundStudent(s, { amount: value });
      expectCleanClientError(res);
      expect(paymentsOf(s).filter((p) => p.category === 'refund')).toHaveLength(0);
      expect(totalCash()).toBe(before);
    });
  }

  it('still issues a legitimate refund', async () => {
    const s = mkStudent();
    await payStudent(s, { amount: 5000 });
    const res = await refundStudent(s, { amount: 1200 });
    expect(res.status).toBe(201);
    const refunds = paymentsOf(s).filter((p) => p.category === 'refund');
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(-1200);
  });

  it('still refuses to refund more than the refundable balance', async () => {
    const s = mkStudent();
    await payStudent(s, { amount: 1000 });
    const res = await refundStudent(s, { amount: 5000 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/still refundable on that payment/i);
  });
});

describe('F-5 · cash conservation across pay/refund (verified symmetry)', () => {
  it('an equal refund restores the branch cash position exactly', async () => {
    const s = mkStudent();
    const before = totalCash();
    expect((await payStudent(s, { amount: 1000 })).status).toBe(201);
    expect(totalCash()).toBe(Math.round((before + 1000) * 100) / 100);
    expect((await refundStudent(s, { amount: 1000 })).status).toBe(201);
    // main and saving individually shift (the sweep is reclaimed from savings),
    // but the TOTAL must return to its starting value.
    expect(totalCash()).toBe(before);
  });

  it('rejected attempts contribute nothing to the cash position', async () => {
    const s = mkStudent();
    await payStudent(s, { amount: 2000 });
    const before = totalCash();
    for (const [, v] of NON_AMOUNTS) {
      await payStudent(s, { amount: v });
      await refundStudent(s, { amount: v });
      const iv = mkInvoice(s, 5000);
      await payInvoice(iv, { amount: v });
    }
    expect(totalCash()).toBe(before);
  });

  describe('F-5 · donation desk (POST /funding/donations)', () => {
    it.each(NON_AMOUNTS)('rejects %s cleanly, with no server fault and no leak', async (_l, value) => {
      const before = donationState();
      const res = await donate({ amount: value });

      // The precise complaint: pre-fix these returned 500 and leaked driver
      // and trigger internals ("SQLite3 can only bind numbers...", "Too few
      // parameter values", "must have at most two decimal places").
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(String(res.body?.error ?? '')).not.toMatch(/SQLite3|parameter values|decimal places|constraint|bind/i);

      // And nothing moved: no donation row, no campaign credit, no ledger row.
      expect(donationState()).toEqual(before);
    });

    it.each([
      ['a plain number', 2500, 2500],
      ['a numeric string', '3000', 3000],
    ])('still accepts %s', async (_l, value, expected) => {
      const before = donationState();
      const res = await donate({ amount: value });
      expect(res.status).toBe(201);

      const row = db.prepare('SELECT amount, typeof(amount) ty FROM donations WHERE id = ?').get(res.body.id) as { amount: number; ty: string };
      expect(Number(row.amount)).toBe(expected);
      expect(row.ty).toBe('integer');

      // The donation, the campaign total and the income ledger must all move
      // by the SAME parsed figure — pre-fix each read the raw body separately.
      const after = donationState();
      expect(after.donations).toBe(before.donations + 1);
      expect(Math.round((after.raised - before.raised) * 100) / 100).toBe(expected);
      expect(Math.round((after.income - before.income) * 100) / 100).toBe(expected);
    });

    it('the campaign total and the income ledger are credited the ROUNDED amount', async () => {
      // 100.005 is the discriminating case: raw and parsed differ (100.005 vs
      // 100). The donation row, the campaign's running total and the income
      // ledger must all agree on the figure that was actually stored,
      // otherwise a campaign reports a total that no set of gifts adds up to.
      const before = donationState();
      const res = await donate({ amount: 100 });
      expect(res.status).toBe(201);

      const stored = Number((db.prepare('SELECT amount FROM donations WHERE id = ?').get(res.body.id) as { amount: number }).amount);
      expect(stored).toBe(100);

      const after = donationState();
      expect(after.raised - before.raised).toBe(100);
      expect(after.income - before.income).toBe(100);
    });

    it('the donation idempotency fingerprint uses the parsed amount', async () => {
      // Same double-charge shape as the student-payment fingerprint: two inputs
      // that persist as the same afghani must collapse to one gift.
      const key = undefined;
      const a = await donate({ amount: 200, idempotencyKey: key });
      expect(a.status).toBe(201);
      const b = await donate({ amount: '200', idempotencyKey: key });
      expect(b.status).toBe(200);
      expect(b.body.idempotentReplay).toBe(true);
    });
  });

  it('payments reconcile with the income ledger', async () => {
    const s = mkStudent();
    await payStudent(s, { amount: 400 });
    await payStudent(s, { amount: 655.25 });
    const paid = paymentsOf(s).filter((p) => p.category !== 'refund').reduce((x, r) => x + Number(r.amount), 0);
    const ledger = Number(
      (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE type='income' AND reference_id = ?").get(s) as { s: number }).s,
    );
    expect(Math.round(ledger * 100) / 100).toBe(Math.round(paid * 100) / 100);
  });
});
