/**
 * BOOKS — sale quantity integrity.
 *
 * `POST /books/:id/sell` guarded quantity with only `if (!quantity || quantity <= 0)`.
 * That rejects 0, negatives and null, but accepts any other numeric-ish value,
 * and the quantity then flows straight into
 *   total = book.price * quantity
 *   UPDATE books SET stock = stock - ?
 *
 * BKS-1 (the defect this suite is written against), reproduced live on a fresh
 * database:
 *   quantity 0.5   -> HTTP 201, charged 50 AFN for a 100 AFN book,
 *                     inventory left at 9.5 physical copies
 *   quantity 0.001 -> HTTP 201, charged 0.1 AFN, stock 5 -> 4.999
 *   quantity [3]   -> HTTP 201, array coerced to 3 by SQLite/JS arithmetic
 *
 * A book is a physical object: a fractional count is not a smaller sale, it is
 * corrupt inventory. The stock column silently becomes non-integral and every
 * later reconciliation of "copies on hand" is wrong.
 *
 * The invariant: a book sale moves a whole, positive number of copies, and the
 * charge is derived from that validated count.
 *
 * `assertSeatCount` in utils/money.ts is the existing canonical whole-number
 * boundary (finite, integer, non-negative, bounded, same type discipline as
 * assertMoney). It is reused here rather than adding a second integer
 * validator.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { booksRouter } from '../routes/books.routes.js';

const BR = 'bkq_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/books', booksRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string, branchId = BR): TokenPayload => ({
  userId,
  username: userId,
  role: role as TokenPayload['role'],
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const OWNER = tok('bkq_owner', 'owner');
const MANAGER = tok('bkq_mgr', 'manager');

let app: ReturnType<typeof createApp>;
let seq = 0;

/** Create a book through the real route and return its id. */
async function makeBook(price = 100, stock = 10) {
  const title = `BKQ Book ${++seq}`;
  const res = await supertest(app)
    .post('/api/books')
    .set(auth(OWNER))
    .send({ title, price, stock, purchasePrice: 50, isChapter: false, branchId: BR });
  expect(res.status).toBe(201);
  return (db.prepare('SELECT id FROM books WHERE title = ? AND branch_id = ?').get(title, BR) as { id: string }).id;
}

const stockOf = (bookId: string) =>
  (db.prepare('SELECT stock FROM books WHERE id = ?').get(bookId) as { stock: number }).stock;

const salesOf = (bookId: string) =>
  db.prepare('SELECT quantity, total_amount, net_amount FROM book_sales WHERE book_id = ?').all(bookId) as Array<{
    quantity: number;
    total_amount: number;
    net_amount: number;
  }>;

const incomeFor = (bookId: string) =>
  (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE reference_id = ? AND type='income'").get(bookId) as { s: number }).s;

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('bkq_campus', FIXED_ORG_ID, 'BKQ Campus', 'BKQ');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'bkq_campus');
  const pw = await hashPassword('testpass123');
  for (const u of [OWNER, MANAGER]) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.role, u.branchId, pw);
  }
  syncLegacyUserRoles(db);
  db.prepare(
    "INSERT OR REPLACE INTO finance_accounts (id,scope_type,scope_id,main_balance,saving_balance) VALUES ('fa_bkq','branch',?,100000,10000)",
  ).run(BR);
  app = createApp();
});

describe('BKS-1 · a book sale moves whole copies only', () => {
  it.each([
    ['a half copy', 0.5],
    ['a fractional copy', 1.5],
    ['a sub-unit dust quantity', 0.001],
  ])('rejects %s and leaves stock integral', async (_label, quantity) => {
    const bookId = await makeBook(100, 10);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity, customerName: 'Walk-in' });

    expect(res.status).toBe(400);
    expect(stockOf(bookId)).toBe(10);
    expect(Number.isInteger(stockOf(bookId))).toBe(true);
    expect(salesOf(bookId)).toHaveLength(0);
    expect(incomeFor(bookId)).toBe(0);
  });

  it.each([
    ['an array', [3]],
    ['a nested array', [[2]]],
    ['an object', {}],
    ['a boolean', true],
    ['text', 'abc'],
  ])('rejects %s as a quantity and writes nothing', async (_label, quantity) => {
    const bookId = await makeBook(100, 10);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity, customerName: 'Walk-in' });

    expect(res.status).toBe(400);
    expect(stockOf(bookId)).toBe(10);
    expect(salesOf(bookId)).toHaveLength(0);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
  ])('still rejects %s', async (_label, quantity) => {
    const bookId = await makeBook(100, 10);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity, customerName: 'Walk-in' });
    expect(res.status).toBe(400);
    expect(stockOf(bookId)).toBe(10);
  });

  it('accepts a whole quantity and charges exactly price x quantity', async () => {
    const bookId = await makeBook(100, 10);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 3, customerName: 'Walk-in' });

    expect(res.status).toBe(201);
    expect(stockOf(bookId)).toBe(7);
    const sales = salesOf(bookId);
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity).toBe(3);
    expect(sales[0].net_amount).toBe(300);
    expect(incomeFor(bookId)).toBe(300);
  });

  it('accepts a numeric string quantity, as the canonical validator does', async () => {
    const bookId = await makeBook(100, 10);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: '2', customerName: 'Walk-in' });

    expect(res.status).toBe(201);
    expect(stockOf(bookId)).toBe(8);
    expect(salesOf(bookId)[0].quantity).toBe(2);
  });

  it('still refuses to oversell the available stock', async () => {
    const bookId = await makeBook(100, 5);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 6, customerName: 'Walk-in' });
    expect(res.status).toBe(409);
    expect(stockOf(bookId)).toBe(5);
  });

  it('a refund of a whole-quantity sale restores integral stock', async () => {
    const bookId = await makeBook(100, 10);
    const sale = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 4, customerName: 'Walk-in' });
    expect(sale.status).toBe(201);
    expect(stockOf(bookId)).toBe(6);

    const refund = await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(MANAGER));
    expect(refund.status).toBe(200);
    expect(stockOf(bookId)).toBe(10);
    expect(Number.isInteger(stockOf(bookId))).toBe(true);
  });
});

describe('BOOKS · refund integrity (locking behaviour proven safe)', () => {
  it('a sale cannot be refunded twice', async () => {
    const bookId = await makeBook(100, 10);
    const sale = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 2, customerName: 'Walk-in' });

    expect((await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(MANAGER))).status).toBe(200);
    const stockAfterFirst = stockOf(bookId);

    const second = await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(MANAGER));
    expect(second.status).toBe(409);
    expect(stockOf(bookId)).toBe(stockAfterFirst);
  });

  it('a refund does not rewrite the book price set after the sale', async () => {
    const bookId = await makeBook(100, 10);
    const sale = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 2, customerName: 'Walk-in' });

    await supertest(app)
      .put(`/api/books/${bookId}`)
      .set(auth(OWNER))
      .send({ title: 'BKQ repriced', price: 250, stock: stockOf(bookId), purchasePrice: 150, isChapter: false });

    await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(MANAGER));
    const row = db.prepare('SELECT price, purchase_price FROM books WHERE id = ?').get(bookId) as {
      price: number;
      purchase_price: number;
    };
    expect(row.price).toBe(250);
    expect(row.purchase_price).toBe(150);
  });

  it('overselling is refused and no stock, sale or income is written', async () => {
    // Kills the oversell mutant: the guard is the only thing between a request
    // and negative inventory, since the conditional UPDATE would simply not
    // match and the sale row would still be attempted.
    const bookId = await makeBook(100, 3);
    const res = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 10, customerName: 'Walk-in' });

    expect(res.status).toBe(409);
    expect(stockOf(bookId)).toBe(3);
    expect(salesOf(bookId)).toHaveLength(0);
    expect(incomeFor(bookId)).toBe(0);
  });

  it('a sale in another branch cannot be refunded across the branch boundary', async () => {
    // Kills the refund branch-scope mutant.
    const OTHER = 'bkq_branch_other';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
      .run(OTHER, OTHER, 'Loc', 'bkq_campus');
    const foreignManager = tok('bkq_mgr_other', 'manager', OTHER);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(foreignManager.userId, foreignManager.username, foreignManager.fullName, 'manager', OTHER, 'x');
    syncLegacyUserRoles(db);

    const bookId = await makeBook(100, 10);
    const sale = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(OWNER))
      .send({ quantity: 2, customerName: 'Walk-in' });
    expect(sale.status).toBe(201);
    const stockBefore = stockOf(bookId);

    const refund = await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(foreignManager));
    expect(refund.status).toBe(403);
    expect(stockOf(bookId)).toBe(stockBefore);
    expect(
      (db.prepare("SELECT status FROM book_sales WHERE id = ?").get(sale.body.id) as { status: string }).status,
    ).toBe('completed');
  });

  it('a registrar may sell but may not refund', async () => {
    const registrar = tok('bkq_reg', 'registrar');
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(registrar.userId, registrar.username, registrar.fullName, 'registrar', BR, 'x');
    syncLegacyUserRoles(db);

    const bookId = await makeBook(100, 10);
    const sale = await supertest(app)
      .post(`/api/books/${bookId}/sell`)
      .set(auth(registrar))
      .send({ quantity: 1, customerName: 'Walk-in' });
    expect(sale.status).toBe(201);

    const refund = await supertest(app).post(`/api/books/sales/${sale.body.id}/refund`).set(auth(registrar));
    expect(refund.status).toBe(403);
  });
});
