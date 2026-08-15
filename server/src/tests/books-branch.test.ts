/**
 * Book store — branch scoping & honest persistence regression suite
 * ============================================================================
 * Locks in two invariants:
 *
 * 1. A book is created in the branch the operator is working in (body
 *    branchId), and the target branch must be within the operator's scope —
 *    so an owner/manager who switches branches in the UI sees the new title
 *    immediately instead of it silently landing in the JWT branch.
 * 2. A book sale decrements the stock of the book's OWN branch and records
 *    revenue there (the operator must already have access to it), even when
 *    the operator's JWT branch differs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { booksRouter } from '../routes/books.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH_A = 'bk_branch_a';
const BRANCH_B = 'bk_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/books', booksRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'manager', branchId: overrides.branchId || BRANCH_A, fullName: 'Book Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let managerA: TokenPayload;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'Book Branch A', 'Loc');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'Book Branch B', 'Loc');
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`)
    .run('u_bk_mgr_a', 'bk_mgr_a', 'Book Mgr A', BRANCH_A, await hashPassword('x'));
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`)
    .run('u_bk_owner', 'bk_owner', 'Book Owner', BRANCH_A, await hashPassword('x'));
  syncLegacyUserRoles(db);
  managerA = makeUser({ userId: 'u_bk_mgr_a', role: 'manager', branchId: BRANCH_A });
  owner = makeUser({ userId: 'u_bk_owner', role: 'owner', branchId: BRANCH_A });
  app = createApp();
});

describe('Book creation — branch targeting', () => {
  it('creates the book in the requested branch when the caller has access (owner switched branch)', async () => {
    const res = await supertest(app).post('/api/books').set(authHeader(owner)).send({
      title: 'Branch B Book', price: 500, stock: 4, isChapter: false, entryDate: today(), branchId: BRANCH_B,
    });
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM books WHERE title = ?').get('Branch B Book') as any;
    expect(row).toBeDefined();
    expect(row.branch_id).toBe(BRANCH_B);
  });

  it('rejects a target branch outside the caller scope', async () => {
    // managerA (branch A, no org scope) cannot create a book in branch B via
    // an explicit branchId — the request must fail closed.
    const res = await supertest(app).post('/api/books').set(authHeader(managerA)).send({
      title: 'Blocked Book', price: 500, stock: 1, isChapter: false, branchId: BRANCH_B,
    });
    expect(res.status).toBe(403);
    const row = db.prepare('SELECT * FROM books WHERE title = ?').get('Blocked Book') as any;
    expect(row).toBeUndefined();
  });

  it('defaults to the JWT branch when no branchId is supplied', async () => {
    const res = await supertest(app).post('/api/books').set(authHeader(managerA)).send({
      title: 'Default Branch Book', price: 300, stock: 2, isChapter: true,
    });
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM books WHERE title = ?').get('Default Branch Book') as any;
    expect(row.branch_id).toBe(BRANCH_A);
  });
});

describe('Book sale — stock and revenue follow the book branch', () => {
  it('sells from the book branch even when the operator JWT branch differs', async () => {
    // Seed a book in branch B directly, then sell it with an owner token
    // (owner has organization-wide access, so the sale is allowed even though
    // the book lives in a branch different from the owner's JWT branch).
    const bookId = id('bk');
    db.prepare(`INSERT INTO books (id, title, price, purchase_price, stock, is_chapter, branch_id, entry_date) VALUES (?, ?, 1000, 600, 5, 0, ?, ?)`)
      .run(bookId, 'Cross Branch Sale Book', BRANCH_B, today());

    const res = await supertest(app).post(`/api/books/${bookId}/sell`).set(authHeader(owner)).send({
      quantity: 2, customerName: 'Cross Buyer', paymentMethod: 'cash',
    });
    expect(res.status).toBe(201);

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
    expect(book.stock).toBe(3); // decremented in the book's own branch
    const sale = db.prepare('SELECT * FROM book_sales WHERE book_id = ?').get(bookId) as any;
    expect(sale.branch_id).toBe(BRANCH_B);
    const income = db.prepare("SELECT * FROM financial_transactions WHERE category = 'book' AND reference_id = ?").get(bookId) as any;
    expect(income).toBeDefined();
    expect(income.branch_id).toBe(BRANCH_B); // revenue lands in the book branch
  });
});
