/**
 * Cross-cutting · an idempotency replay must be a replay of THIS business event.
 * ============================================================================
 * `Idempotency-Key` is supplied by the caller. A money writer that looks the
 * key up on its own — without checking that the record it found is the same
 * business event the request describes — will answer 200 `idempotentReplay`
 * for something that never happened:
 *
 *   * the operator is told a collection, sale or gift succeeded;
 *   * nothing is recorded, no stock moves and no cash moves;
 *   * the response hands back the OTHER record's receipt number.
 *
 * Payroll already applied this rule (`teacher_salary_ledger` /
 * `employee_salary_ledger` reject a key that belongs to another person or
 * period with 409). Invoice payment, book sales and donations did not; the
 * cases below prove they now do, at both the pre-check and the
 * unique-violation backstop, and the architecture case keeps the rule from
 * regressing in a new writer.
 *
 * Owning packages: WP-07 (invoice payment), WP-09 (donations), WP-10 (book
 * sales), WP-08 (payroll). None of those packages is certified by this file —
 * it pins one cross-cutting rule they all have to obey.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { fundingRouter } from '../routes/funding.routes.js';
import booksRouter from '../routes/books.routes.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from './support/identity.js';

const BRANCH = 'idem_scope_branch';
let app: express.Express;
let owner: { Authorization: string };
let donorA: string;
let donorB: string;
let bookA: string;
let bookB: string;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, 'Idem Scope', 'Loc')`).run(BRANCH);
  seedUser({ id: 'u_idem_scope', role: 'owner', branchId: BRANCH, fullName: 'Idem Owner' });
  owner = bearerFor('u_idem_scope');

  app = express();
  app.use(express.json());
  app.use('/api/funding', fundingRouter);
  app.use('/api/books', booksRouter);
  app.use(errorHandler);

  donorA = (await supertest(app).post('/api/funding/donors').set(owner).send({ fullName: 'Donor A', type: 'individual', phone: '0700111222' }).expect(201)).body.id;
  donorB = (await supertest(app).post('/api/funding/donors').set(owner).send({ fullName: 'Donor B', type: 'individual', phone: '0700111333' }).expect(201)).body.id;

  const catalogA = await supertest(app).post('/api/books/catalog').set(owner).set('Idempotency-Key', 'idem-scope-catalog-a').send({
    title: 'Book A', itemKind: 'book', branchId: BRANCH, saleEnabled: true, salePrice: 500, lendingEnabled: false, initialQuantity: 50,
  }).expect(201);
  const catalogB = await supertest(app).post('/api/books/catalog').set(owner).set('Idempotency-Key', 'idem-scope-catalog-b').send({
    title: 'Book B', itemKind: 'book', branchId: BRANCH, saleEnabled: true, salePrice: 500, lendingEnabled: false, initialQuantity: 50,
  }).expect(201);
  bookA = catalogA.body.id;
  bookB = catalogB.body.id;
});

describe('a donation replay is a replay of the same gift', () => {
  it('refuses a key already spent on another donor instead of returning their receipt', async () => {
    const key = 'idem-scope-donation';
    const first = await supertest(app)
      .post('/api/funding/donations')
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ donorId: donorA, amount: 4000 })
      .expect(201);

    const second = await supertest(app)
      .post('/api/funding/donations')
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ donorId: donorB, amount: 4000 });

    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).not.toContain(first.body.receiptNo);
    const donorBRows = db.prepare('SELECT COUNT(*) c FROM donations WHERE donor_id = ?').get(donorB) as { c: number };
    expect(donorBRows.c).toBe(0);
  });

  it('still replays a genuine retry of the same gift', async () => {
    const key = 'idem-scope-donation-retry';
    const first = await supertest(app)
      .post('/api/funding/donations')
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ donorId: donorA, amount: 1500 })
      .expect(201);
    const retry = await supertest(app)
      .post('/api/funding/donations')
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ donorId: donorA, amount: 1500 })
      .expect(200);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(retry.body.receiptNo).toBe(first.body.receiptNo);
    const rows = db.prepare('SELECT COUNT(*) c FROM donations WHERE donor_id = ? AND amount = 1500').get(donorA) as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe('a book-sale replay is a replay of the same sale', () => {
  it('refuses a key already spent on another book instead of confirming a sale that never happened', async () => {
    const key = 'idem-scope-sale';
    await supertest(app)
      .post(`/api/books/catalog/${bookA}/sales`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ quantity: 1, purchaserName: 'Walk-in', paymentMethod: 'cash' })
      .expect(201);

    const before = db.prepare('SELECT available_quantity FROM book_inventory_positions WHERE book_id = ?').get(bookB) as { available_quantity: number };
    const second = await supertest(app)
      .post(`/api/books/catalog/${bookB}/sales`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ quantity: 1, purchaserName: 'Walk-in', paymentMethod: 'cash' });

    expect(second.status).toBe(409);
    expect(db.prepare('SELECT available_quantity FROM book_inventory_positions WHERE book_id = ?').get(bookB)).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) c FROM book_sales WHERE book_id = ?').get(bookB) as { c: number }).c).toBe(0);
  });

  it('still replays a genuine retry of the same sale', async () => {
    const key = 'idem-scope-sale-retry';
    const first = await supertest(app)
      .post(`/api/books/catalog/${bookA}/sales`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ quantity: 2, purchaserName: 'Repeat', paymentMethod: 'cash' })
      .expect(201);
    const retry = await supertest(app)
      .post(`/api/books/catalog/${bookA}/sales`)
      .set(owner)
      .set('Idempotency-Key', key)
      .send({ quantity: 2, purchaserName: 'Repeat', paymentMethod: 'cash' })
      .expect(200);
    expect(retry.body).toMatchObject({ id: first.body.id, idempotentReplay: true });
  });
});

describe('no money writer looks an idempotency key up without its business event', () => {
  const serverRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const source = (file: string) => fs.readFileSync(path.join(serverRoot, file), 'utf8');

  it.each([
    ['routes/invoices.routes.ts', /invoice_id = \? AND student_id = \?/],
    ['core/books/books-service.ts', /This idempotency key has already been used for a different Book sale/],
    ['routes/funding.routes.ts', /assertSameDonation\(/],
    ['routes/teachers.routes.ts', /Idempotency key was already used for a different payroll operation/],
  ])('%s scopes its replay to the business event', (file, pattern) => {
    expect(source(file as string)).toMatch(pattern as RegExp);
  });

  it('does not retain a bare Book idempotency lookup after the domain boundary moved to the service', () => {
    const booksRoute = source('routes/books.routes.ts');
    const booksService = source('core/books/books-service.ts');
    expect(booksRoute).not.toMatch(/WHERE idempotency_key/);
    expect(booksService).toContain('idempotency_key IN');
    expect(booksService).toContain('idempotencyCandidates');
  });
});
