/**
 * Money-writer duplicate-action regression suite (group F6)
 * ============================================================================
 * Locks in defects proven by live concurrent attack against the running API:
 *
 *   S6. POST /funding/donations — 8 concurrent un-keyed requests created
 *       8 donations (40,000 AFN from one 5,000 AFN intent) and 8 income rows.
 *   S7. POST /invoices — a malformed money field threw a plain Error, so
 *       client input errors surfaced as HTTP 500 instead of 400.
 *   S8. POST /invoices/:id/pay — idempotency was only honoured when the CLIENT
 *       supplied a key, so 8 concurrent un-keyed requests created 8 payments.
 *
 * The counter-invariant is asserted too: request idempotency must never block
 * a genuinely distinct business event (two real instalments of equal amount).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { fundingRouter } from '../routes/funding.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { assertMoney } from '../utils/money.js';
import { HttpError } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'mw_idem_branch';
const STUDENT = 'mw_idem_student';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/funding', fundingRouter);
  app.use(errorHandler);
  return app;
}
function user(): TokenPayload {
  return { userId: 'u_mw_idem', username: 'mw_idem', role: 'manager', branchId: BRANCH, fullName: 'MW Idem Mgr' };
}
function auth() {
  return { Authorization: `Bearer ${signToken(user())}` };
}

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);

  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, 'MW Idem Branch', 'Loc')`).run(BRANCH);
  const pw = await hashPassword('x');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('u_mw_idem', 'mw_idem', 'MW Idem Mgr', 'manager', ?, ?, 1, 0)`,
  ).run(BRANCH, pw);
  syncLegacyUserRoles(db);
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
     VALUES (?, 'MW-0001', 'MW Idem Student', 'male', '0700000111', 'active', ?, ?)`,
  ).run(STUDENT, today(), BRANCH);

  app = createApp();
});

// ---------------------------------------------------------------------------
// S7 — money validation must be a client error, never a server error
// ---------------------------------------------------------------------------
describe('S7: malformed money is a 400, not a 500', () => {
  it('assertMoney throws HttpError(400) for every failure mode', () => {
    // Non-finite, negative, and beyond safe monetary precision. (Ordinary
    // sub-unit values like 1.005 are legitimately rounded, not rejected.)
    const bad = [NaN, Infinity, -Infinity, -1, 'abc', Number.MAX_VALUE];
    for (const v of bad) {
      let caught: unknown;
      try {
        assertMoney(v as number, 'testField');
      } catch (e) {
        caught = e;
      }
      expect(caught, `expected ${String(v)} to be rejected`).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(400);
    }
  });

  it('accepts legitimate money values', () => {
    for (const v of [0, 1, 1000, 1234.5, 99.99, 1.005]) {
      expect(() => assertMoney(v, 'testField')).not.toThrow();
    }
  });

  it('POST /invoices with a non-numeric unitPrice returns 400', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth())
      .send({ studentId: STUDENT, items: [{ description: 'Tuition', quantity: 1, unitPrice: 'abc' }] });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
// S8 — invoice payment idempotency without a client key
// ---------------------------------------------------------------------------
describe('S8: invoice payment cannot be duplicated by retries', () => {
  async function makeIssuedInvoice(amount: number) {
    const created = await supertest(app)
      .post('/api/invoices')
      .set(auth())
      .send({ studentId: STUDENT, items: [{ description: 'Tuition', quantity: 1, unitPrice: amount }], issue: true });
    expect(created.status).toBe(201);
    const invId = created.body.id as string;
    await supertest(app).post(`/api/invoices/${invId}/issue`).set(auth()).send({});
    return invId;
  }

  it('8 concurrent UN-KEYED payments record exactly one payment', async () => {
    const invId = await makeIssuedInvoice(9000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        supertest(app).post(`/api/invoices/${invId}/pay`).set(auth()).send({ amount: 1000, paymentMethod: 'cash' }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(7);
    for (const r of replayed) expect(r.body.idempotentReplay).toBe(true);

    const row = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?`)
      .get(invId) as { c: number; s: number };
    expect(row.c).toBe(1);
    expect(row.s).toBe(1000);

    // Financial truth must match: exactly one income row for one payment.
    const inc = db
      .prepare(
        `SELECT COUNT(*) AS c FROM financial_transactions
         WHERE type='income' AND payment_id IN (SELECT id FROM payments WHERE invoice_id = ?)`,
      )
      .get(invId) as { c: number };
    expect(inc.c).toBe(1);
  });

  it('all replays return the SAME payment id and receipt number', async () => {
    const invId = await makeIssuedInvoice(5000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        supertest(app).post(`/api/invoices/${invId}/pay`).set(auth()).send({ amount: 500, paymentMethod: 'cash' }),
      ),
    );
    const ids = new Set(results.map((r) => r.body.paymentId));
    const receipts = new Set(results.map((r) => r.body.receiptNumber));
    expect(ids.size).toBe(1);
    expect(receipts.size).toBe(1);
  });

  it('COUNTER-INVARIANT: two genuinely distinct instalments of equal amount both succeed', async () => {
    const invId = await makeIssuedInvoice(4000);
    const a = await supertest(app)
      .post(`/api/invoices/${invId}/pay`)
      .set(auth())
      .set('Idempotency-Key', 'mw-inst-a')
      .send({ amount: 1000, paymentMethod: 'cash' });
    const b = await supertest(app)
      .post(`/api/invoices/${invId}/pay`)
      .set(auth())
      .set('Idempotency-Key', 'mw-inst-b')
      .send({ amount: 1000, paymentMethod: 'cash' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const row = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?`)
      .get(invId) as { c: number; s: number };
    expect(row.c).toBe(2);
    expect(row.s).toBe(2000);
  });

  it('an explicit key replayed 20 times stays exactly one payment', async () => {
    const invId = await makeIssuedInvoice(8000);
    for (let i = 0; i < 20; i++) {
      const r = await supertest(app)
        .post(`/api/invoices/${invId}/pay`)
        .set(auth())
        .set('Idempotency-Key', 'mw-replay-20')
        .send({ amount: 250, paymentMethod: 'cash' });
      expect(i === 0 ? 201 : 200).toBe(r.status);
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ?`)
      .get(invId) as { c: number };
    expect(row.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S6 — donation idempotency
// ---------------------------------------------------------------------------
describe('S6: donations cannot be duplicated by retries', () => {
  let donorId: string;

  beforeAll(async () => {
    const res = await supertest(app)
      .post('/api/funding/donors')
      .set(auth())
      .send({ fullName: 'MW Idem Donor', type: 'individual', phone: '0700222333' });
    expect(res.status).toBe(201);
    donorId = res.body.id;
  });

  it('8 concurrent UN-KEYED donations record exactly one donation', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        supertest(app).post('/api/funding/donations').set(auth()).send({ donorId, amount: 5000 }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(7);

    const row = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM donations WHERE donor_id = ?`)
      .get(donorId) as { c: number; s: number };
    expect(row.c).toBe(1);
    expect(row.s).toBe(5000);
  });

  it('the DB unique index is the authoritative guard, not the app pre-check', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='uq_donations_idempotency'`)
      .get() as { name?: string } | undefined;
    expect(idx?.name).toBe('uq_donations_idempotency');

    // Writing the same key twice must be refused by SQLite itself.
    const key = 'mw-donation-dupe-key';
    const insert = (rowId: string) =>
      db
        .prepare(
          `INSERT INTO donations (id, donor_id, amount, date, receipt_no, branch_id, idempotency_key)
           VALUES (?, ?, 100, date('now'), ?, ?, ?)`,
        )
        .run(rowId, donorId, `RC-${rowId}`, BRANCH, key);
    insert('mw_dn_1');
    expect(() => insert('mw_dn_2')).toThrow();
  });

  it('COUNTER-INVARIANT: two explicitly keyed donations of equal amount both succeed', async () => {
    const a = await supertest(app)
      .post('/api/funding/donations')
      .set(auth())
      .set('Idempotency-Key', 'mw-gift-a')
      .send({ donorId, amount: 2500 });
    const b = await supertest(app)
      .post('/api/funding/donations')
      .set(auth())
      .set('Idempotency-Key', 'mw-gift-b')
      .send({ donorId, amount: 2500 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);

    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM donations WHERE donor_id = ? AND amount = 2500`)
      .get(donorId) as { c: number };
    expect(row.c).toBe(2);
  });

  it('idempotent replays do not burn receipt numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        supertest(app).post('/api/funding/donations').set(auth()).send({ donorId, amount: 333 }),
      ),
    );
    const receipts = new Set(results.map((r) => r.body.receiptNo).filter(Boolean));
    expect(receipts.size).toBe(1);
  });
});
