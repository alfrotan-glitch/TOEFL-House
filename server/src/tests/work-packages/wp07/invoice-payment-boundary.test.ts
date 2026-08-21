/**
 * WP-07 · Invoice payment boundary.
 * ============================================================================
 * The invoice payment endpoint is one of the money paths that both records a
 * `payments` row and moves branch cash through `recordIncome`. These cases pin
 * the two rules a money boundary must obey: the value written is the value
 * that was checked, and an input the system cannot honour is refused rather
 * than replaced.
 *
 * WP07-F8 was reproduced against the previous implementation: an unrecognised
 * payment method (`cheque`, or a typo such as `bank_transfr`) was silently
 * recorded as CASH. `POST /api/students/:id/payments` — the other collection
 * path — already rejected exactly the same input with 400, so one concept had
 * two rules and the laxer one quietly misstated how the money arrived.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { invoicesRouter } from '../../../routes/invoices.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/invoices', invoicesRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let studentId: string;
let manager: { Authorization: string };

function issueInvoice(net: number): Promise<string> {
  return supertest(app)
    .post('/api/invoices')
    .set(manager)
    .send({ studentId, items: [{ description: 'Tuition', quantity: 1, unitPrice: net }], issue: true })
    .expect(201)
    .then((res) => res.body.id as string);
}

const payments = () =>
  db.prepare('SELECT id, amount, payment_method FROM payments WHERE branch_id = ? ORDER BY rowid').all(branch) as Array<{
    id: string; amount: number; payment_method: string;
  }>;

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7p_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);
  studentId = `${key}_stu`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, 'Payer', 'active', ?, ?, 'male')`,
  ).run(studentId, `TH-${key.slice(-6)}`, today(), branch);
  seedUser({ id: `${key}_mgr`, role: 'general_manager', branchId: branch, fullName: 'Manager' });
  manager = bearerFor(`${key}_mgr`);
});

describe('WP-07 · invoice payment refuses what it cannot record faithfully', () => {
  it('WP07-F8 · an unrecognised payment method is rejected, not recorded as cash', async () => {
    const invoiceId = await issueInvoice(5000);
    const res = await supertest(app)
      .post(`/api/invoices/${invoiceId}/pay`)
      .set(manager)
      .send({ amount: 5000, paymentMethod: 'cheque' });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/payment method/i);
    expect(payments()).toHaveLength(0);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('records each accepted method as itself', async () => {
    for (const method of ['cash', 'card', 'bank_transfer'] as const) {
      const invoiceId = await issueInvoice(1000);
      await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 1000, paymentMethod: method }).expect(201);
    }
    expect(payments().map((p) => p.payment_method)).toEqual(['cash', 'card', 'bank_transfer']);
  });

  it('defaults to cash only when the method is omitted', async () => {
    const invoiceId = await issueInvoice(1000);
    await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 1000 }).expect(201);
    expect(payments()[0].payment_method).toBe('cash');
  });

  it('refuses an overpayment by one afghani, exactly', async () => {
    const invoiceId = await issueInvoice(5000);
    await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 4999 }).expect(201);

    const over = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 2 });
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toMatch(/remaining balance \(1 AFN\)/);

    await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 1 }).expect(201);
    const invoice = await supertest(app).get(`/api/invoices/${invoiceId}`).set(manager).expect(200);
    expect(invoice.body.status).toBe('paid');
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('WP07-F9 · an idempotency key from another invoice cannot fabricate a payment', async () => {
    const invoiceA = await issueInvoice(2000);
    const invoiceB = await issueInvoice(2000);
    const sharedKey = `k_${randomUUID()}`;

    const paid = await supertest(app)
      .post(`/api/invoices/${invoiceA}/pay`)
      .set(manager)
      .set('Idempotency-Key', sharedKey)
      .send({ amount: 2000 })
      .expect(201);

    // Replaying the SAME key against a DIFFERENT invoice must not report a
    // collection that never happened there, nor disclose the other receipt.
    const replayed = await supertest(app)
      .post(`/api/invoices/${invoiceB}/pay`)
      .set(manager)
      .set('Idempotency-Key', sharedKey)
      .send({ amount: 2000 });

    expect(replayed.status).not.toBe(200);
    expect(JSON.stringify(replayed.body)).not.toContain(paid.body.receiptNumber);

    const invoiceBState = await supertest(app).get(`/api/invoices/${invoiceB}`).set(manager).expect(200);
    expect(invoiceBState.body.status).toBe('issued');
    expect(payments()).toHaveLength(1);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('replays a retry of a payment that has already settled the invoice', async () => {
    const invoiceId = await issueInvoice(1500);
    const sharedKey = `k_${randomUUID()}`;
    await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).set('Idempotency-Key', sharedKey).send({ amount: 1500 }).expect(201);

    const retry = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).set('Idempotency-Key', sharedKey).send({ amount: 1500 });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(payments()).toHaveLength(1);
  });

  it('collapses a retried payment instead of taking the money twice', async () => {
    const invoiceId = await issueInvoice(3000);
    const [first, second] = await Promise.all([
      supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 3000 }),
      supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send({ amount: 3000 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(payments()).toHaveLength(1);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });
});
