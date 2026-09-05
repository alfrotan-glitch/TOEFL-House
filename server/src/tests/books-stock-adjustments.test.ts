import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy } from '../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from './support/identity.js';
import { createBooksTestApp, ensureBookBranch } from './support/books.js';

/**
 * W7-1 — physical stock correction (loss / found / correction).
 *
 * The only quantity-decreasing event used to be a sale, which books revenue:
 * a real loss was unrepresentable without fabricating income. Adjustments are
 * quantity facts with audit trails and NO financial leg (cash basis: the cost
 * was expensed at purchase), guarded so availability can never underflow and
 * the sale/loan guards include them.
 */
const BRANCH = 'wp_w7_books';
const OWNER = 'wp_w7_books_owner';
const app = createBooksTestApp();
const owner = () => bearerFor(OWNER);
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function createBook(input: Partial<{ initialQuantity: number; salePrice: number }> = {}): Promise<string> {
  const response = await supertest(app)
    .post('/api/books/catalog')
    .set(owner())
    .set('Idempotency-Key', unique('catalog'))
    .send({
      title: unique('W7 Book'),
      itemKind: 'book',
      saleEnabled: true,
      salePrice: input.salePrice ?? 500,
      lendingEnabled: true,
      initialQuantity: input.initialQuantity ?? 10,
      branchId: BRANCH,
    })
    .expect(201);
  return response.body.id as string;
}

const available = (bookId: string) => Number(
  (db.prepare('SELECT available_quantity AS q FROM book_inventory_positions WHERE book_id = ?').get(bookId) as { q: number }).q,
);

const adjust = (bookId: string, body: Record<string, unknown>, key = unique('adj')) =>
  supertest(app).post(`/api/books/catalog/${bookId}/adjustments`).set(owner()).set('Idempotency-Key', key).send({ branchId: BRANCH, ...body });

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  ensureBookBranch(db, { campusId: 'wp_w7_campus', branchId: BRANCH });
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });
});

describe('W7-1 · Book stock adjustments', () => {
  it('records a loss: quantity drops, no financial row is written', async () => {
    const bookId = await createBook({ initialQuantity: 10 });
    const before = available(bookId);
    const res = await adjust(bookId, { delta: -3, kind: 'loss', reason: 'Water damage in storage room' });
    expect(res.status).toBe(201);
    expect(available(bookId)).toBe(before - 3);
    // No financial representation — a loss is not a sale, and under cash basis
    // there is no second cost event either.
    expect(db.prepare('SELECT COUNT(*) AS n FROM financial_transactions').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payments').get()).toMatchObject({ n: 0 });
  });

  it('refuses an adjustment that would underflow availability', async () => {
    const bookId = await createBook({ initialQuantity: 2 });
    const tooBig = await adjust(bookId, { delta: -5, kind: 'loss', reason: 'Losing more than we hold' });
    expect(tooBig.status).toBe(409);
    expect(available(bookId)).toBe(2);
  });

  it('refuses invalid shapes: zero delta, wrong sign for kind, short reason', async () => {
    const bookId = await createBook();
    expect((await adjust(bookId, { delta: 0, kind: 'correction', reason: 'No-op adjustment' })).status).toBe(400);
    expect((await adjust(bookId, { delta: 2, kind: 'loss', reason: 'Positive loss is a found' })).status).toBe(400);
    expect((await adjust(bookId, { delta: -1, kind: 'found', reason: 'Negative found is a loss' })).status).toBe(400);
    expect((await adjust(bookId, { delta: -1, kind: 'loss', reason: 'short' })).status).toBe(400);
    expect((await adjust(bookId, { delta: -1, kind: 'shrinkage', reason: 'Unknown kind label' })).status).toBe(400);
  });

  it('blocks selling copies that a loss removed (sale guard includes adjustments)', async () => {
    const bookId = await createBook({ initialQuantity: 4, salePrice: 500 });
    expect((await adjust(bookId, { delta: -3, kind: 'loss', reason: 'Three copies were damaged' })).status).toBe(201);
    expect(available(bookId)).toBe(1);
    const oversell = await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(owner())
      .set('Idempotency-Key', unique('sale'))
      .send({ quantity: 2, purchaserName: 'Walk-in', discountAmount: 0, paymentMethod: 'cash' });
    expect(oversell.status).toBe(409);
    const oneLeft = await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(owner())
      .set('Idempotency-Key', unique('sale'))
      .send({ quantity: 1, purchaserName: 'Walk-in', discountAmount: 0, paymentMethod: 'cash' });
    expect(oneLeft.status).toBe(201);
    expect(available(bookId)).toBe(0);
  });

  it('replays idempotently and never double-applies', async () => {
    const bookId = await createBook({ initialQuantity: 10 });
    const key = unique('replay');
    const body = { delta: -2, kind: 'loss', reason: 'Damaged in transit, batch 7' };
    const first = await adjust(bookId, body, key);
    expect(first.status).toBe(201);
    const afterFirst = available(bookId);
    const second = await adjust(bookId, body, key);
    expect(second.status).toBe(200);
    expect(available(bookId)).toBe(afterFirst);
    // A different adjustment under the same key is a conflict, not a replay.
    const conflict = await adjust(bookId, { delta: -1, kind: 'loss', reason: 'Different adjustment body' }, key);
    expect(conflict.status).toBe(409);
  });

  it('adjustments are immutable at the database level', async () => {
    const bookId = await createBook({ initialQuantity: 5 });
    await adjust(bookId, { delta: -1, kind: 'loss', reason: 'One copy missing on count' });
    const row = db.prepare('SELECT id FROM book_stock_adjustments LIMIT 1').get() as { id: string };
    expect(() => db.prepare('UPDATE book_stock_adjustments SET delta = -9 WHERE id = ?').run(row.id)).toThrow(/immutable/i);
    expect(() => db.prepare('DELETE FROM book_stock_adjustments WHERE id = ?').run(row.id)).toThrow(/immutable/i);
  });
});
