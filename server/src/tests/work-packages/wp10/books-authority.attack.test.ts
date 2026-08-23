import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { createBooksTestApp, ensureBookBranch, ensureBookStudent } from '../../support/books.js';

const BRANCH_A = 'wp10_attack_a';
const BRANCH_B = 'wp10_attack_b';
const OWNER = 'wp10_attack_owner';
const GENERAL_MANAGER = 'wp10_attack_gm';
const RECEPTIONIST = 'wp10_attack_reception';
const FINANCE = 'wp10_attack_finance';
const DATA_ENTRY = 'wp10_attack_data';
const STUDENT_A = 'wp10_attack_student_a';
const STUDENT_B = 'wp10_attack_student_b';
const app = createBooksTestApp();

const owner = () => bearerFor(OWNER);
const gm = () => bearerFor(GENERAL_MANAGER);
const receptionist = () => bearerFor(RECEPTIONIST);
const finance = () => bearerFor(FINANCE);
const dataEntry = () => bearerFor(DATA_ENTRY);
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function createCatalog(input: Partial<{
  branchId: string;
  title: string;
  saleEnabled: boolean;
  salePrice: number | null;
  lendingEnabled: boolean;
  initialQuantity: number;
}> = {}) {
  const saleEnabled = input.saleEnabled ?? true;
  const response = await supertest(app)
    .post('/api/books/catalog')
    .set(input.branchId === BRANCH_B ? owner() : gm())
    .set('Idempotency-Key', unique('catalog'))
    .send({
      title: input.title ?? unique('Book'),
      itemKind: 'book',
      branchId: input.branchId ?? BRANCH_A,
      saleEnabled,
      salePrice: saleEnabled ? (input.salePrice ?? 500) : null,
      lendingEnabled: input.lendingEnabled ?? true,
      initialQuantity: input.initialQuantity ?? 2,
    })
    .expect(201);
  return response.body.id as string;
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  ensureBookBranch(db, { campusId: 'wp10_attack_campus', branchId: BRANCH_A });
  ensureBookBranch(db, { campusId: 'wp10_attack_campus', branchId: BRANCH_B });
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH_A });
  seedUser({ id: GENERAL_MANAGER, role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: RECEPTIONIST, role: 'receptionist', branchId: BRANCH_A });
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BRANCH_A });
  seedUser({ id: DATA_ENTRY, role: 'data_entry', branchId: BRANCH_A });
  ensureBookStudent(db, { id: STUDENT_A, branchId: BRANCH_A });
  ensureBookStudent(db, { id: STUDENT_B, branchId: BRANCH_B });
});

describe('WP-10 ATTACK · Books RBAC, cross-branch and state boundaries', () => {
  it('uses permissions rather than role labels: reception can operate lending but cannot refund; Finance cannot issue', async () => {
    const bookId = await createCatalog();
    await supertest(app).get('/api/books/workspace').set(dataEntry()).expect(403);
    await supertest(app).post(`/api/books/catalog/${bookId}/loans`).set(receptionist()).set('Idempotency-Key', unique('loan')).send({ studentId: STUDENT_A, dueOn: '2026-09-01' }).expect(201);
    await supertest(app).post(`/api/books/catalog/${bookId}/loans`).set(finance()).set('Idempotency-Key', unique('finance-loan')).send({ studentId: STUDENT_A, dueOn: '2026-09-01' }).expect(403);

    const sale = await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', unique('sale')).send({ quantity: 1, purchaserName: 'Walk in' }).expect(201);
    await supertest(app).post(`/api/books/sales/${sale.body.id}/return`).set(receptionist()).set('Idempotency-Key', unique('reception-return')).send({ reason: 'No refund authority' }).expect(403);
    await supertest(app).post(`/api/books/sales/${sale.body.id}/return`).set(finance()).set('Idempotency-Key', unique('finance-return')).send({ reason: 'Authorized return' }).expect(201);
  });

  it('refuses foreign resources and branch-correlated student identity', async () => {
    const foreignBook = await createCatalog({ branchId: BRANCH_B });
    await supertest(app).post(`/api/books/catalog/${foreignBook}/sales`).set(gm()).set('Idempotency-Key', unique('foreign-sale')).send({ quantity: 1, purchaserName: 'No access' }).expect(403);

    const localBook = await createCatalog();
    await supertest(app).post(`/api/books/catalog/${localBook}/sales`).set(gm()).set('Idempotency-Key', unique('cross-student-sale')).send({ quantity: 1, studentId: STUDENT_B }).expect(403);
    await supertest(app).post(`/api/books/catalog/${localBook}/loans`).set(gm()).set('Idempotency-Key', unique('cross-student-loan')).send({ studentId: STUDENT_B, dueOn: '2026-09-01' }).expect(403);
  });

  it('rejects unavailable, archived, malformed-date and altered-idempotency attacks without residual facts', async () => {
    const bookId = await createCatalog({ initialQuantity: 1 });
    const saleKey = unique('sale');
    await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', saleKey).send({ quantity: 1, purchaserName: 'First purchaser' }).expect(201);
    await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', unique('oversell')).send({ quantity: 1, purchaserName: 'Oversell' }).expect(409);
    await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', saleKey).send({ quantity: 2, purchaserName: 'Different event' }).expect(409);

    const loanBook = await createCatalog({ saleEnabled: false, lendingEnabled: true });
    await supertest(app).post(`/api/books/catalog/${loanBook}/loans`).set(gm()).set('Idempotency-Key', unique('bad-date')).send({ studentId: STUDENT_A, issuedOn: 'not-a-date', dueOn: '2026-09-01' }).expect(400);
    await supertest(app).patch(`/api/books/catalog/${loanBook}`).set(gm()).send({ status: 'archived' }).expect(200);
    await supertest(app).post(`/api/books/catalog/${loanBook}/receipts`).set(gm()).set('Idempotency-Key', unique('archived-receipt')).send({ quantity: 1 }).expect(409);
    await supertest(app).post(`/api/books/catalog/${loanBook}/loans`).set(gm()).set('Idempotency-Key', unique('archived-loan')).send({ studentId: STUDENT_A, dueOn: '2026-09-01' }).expect(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_loans WHERE book_id = ?').get(loanBook)).toEqual({ count: 0 });
  });
});

describe('WP-10 ATTACK · money, physical quantity and branch-accounting boundaries', () => {
  it.each([
    ['non-numeric', 'abc'], ['negative', -1], ['zero', 0], ['fractional', 1.5], ['unsafe magnitude', 1e15],
  ])('rejects a %s sale price before any catalog or inventory fact exists', async (_label, salePrice) => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM books').get() as { count: number };
    await supertest(app).post('/api/books/catalog').set(gm()).set('Idempotency-Key', unique('bad-price')).send({
      title: unique('Bad price'), itemKind: 'book', branchId: BRANCH_A, saleEnabled: true,
      salePrice, lendingEnabled: false, initialQuantity: 1,
    }).expect(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM books').get()).toEqual(before);
  });

  it.each([
    ['fractional', 0.5], ['zero', 0], ['negative', -1], ['array', [1]], ['object', {}], ['boolean', true], ['text', 'one'],
  ])('rejects a %s physical sale quantity without changing availability or cash', async (_label, quantity) => {
    const bookId = await createCatalog({ initialQuantity: 3 });
    await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', unique('bad-quantity')).send({ quantity, purchaserName: 'Invalid quantity' }).expect(400);
    expect(db.prepare('SELECT available_quantity FROM book_inventory_positions WHERE book_id = ?').get(bookId)).toEqual({ available_quantity: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_sales WHERE book_id = ?').get(bookId)).toEqual({ count: 0 });
  });

  it('accounts an organization-owner sale in the Book branch, never the operator home branch', async () => {
    const foreignBook = await createCatalog({ branchId: BRANCH_B, initialQuantity: 2 });
    const sale = await supertest(app).post(`/api/books/catalog/${foreignBook}/sales`).set(owner()).set('Idempotency-Key', unique('owner-foreign-sale')).send({ quantity: '2', purchaserName: 'Foreign branch buyer' }).expect(201);
    expect(db.prepare(`
      SELECT s.branch_id AS sale_branch, p.branch_id AS payment_branch, ft.branch_id AS income_branch
        FROM book_sales s
        JOIN payments p ON p.id = s.payment_id
        JOIN financial_transactions ft ON ft.payment_id = p.id
       WHERE s.id = ?
    `).get(sale.body.id)).toEqual({ sale_branch: BRANCH_B, payment_branch: BRANCH_B, income_branch: BRANCH_B });
  });
});

describe('WP-10 ATTACK · database backstops and concurrent request identity', () => {
  it('refuses direct immutable fact rewrites, branch moves, unpaired Book payments and stock-capacity corruption', async () => {
    const bookId = await createCatalog({ initialQuantity: 1 });
    const sale = await supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', unique('sale')).send({ quantity: 1, purchaserName: 'Direct guard' }).expect(201);
    const saleRow = db.prepare('SELECT id, payment_id, branch_id FROM book_sales WHERE id = ?').get(sale.body.id) as { id: string; payment_id: string; branch_id: string };

    expect(() => db.prepare('UPDATE book_sales SET net_amount = 1 WHERE id = ?').run(saleRow.id)).toThrow(/immutable/i);
    expect(() => db.prepare('DELETE FROM book_sales WHERE id = ?').run(saleRow.id)).toThrow(/immutable/i);
    expect(() => db.prepare('UPDATE books SET branch_id = ? WHERE id = ?').run(BRANCH_B, bookId)).toThrow(/immutable/i);
    expect(() => db.prepare(`
      INSERT INTO financial_transactions
        (id, type, category, amount, date, description, reference_id, payment_id, operator_name, branch_id)
      VALUES (?, 'income', 'book', 500, '2026-08-23', 'duplicate', ?, ?, 'attack', ?)
    `).run(unique('duplicate-income'), saleRow.id, saleRow.payment_id, BRANCH_A)).toThrow(/Book sale income/i);
    expect(() => db.prepare(`
      INSERT INTO payments (id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
      VALUES (?, 500, '2026-08-23', 'cash', 'completed', 'book', 'direct attack', ?, ?, ?)
    `).run(unique('pay'), unique('receipt'), BRANCH_A, unique('idem'))).toThrow(/Book payment/i);

    const unrelatedPaymentId = unique('unrelated-payment');
    db.prepare(`
      INSERT INTO payments (id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
      VALUES (?, 500, '2026-08-23', 'cash', 'completed', 'other', 'unrelated', ?, ?, ?)
    `).run(unrelatedPaymentId, unique('receipt'), BRANCH_A, unique('idem'));
    expect(() => db.prepare(`
      INSERT INTO payments
        (id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, refunds_payment_id, idempotency_key)
      VALUES (?, -500, '2026-08-23', 'cash', 'completed', 'refund', 'cash-only Book refund', ?, ?, ?, ?)
    `).run(unique('cash-only-refund'), unique('receipt'), BRANCH_A, saleRow.payment_id, unique('cash-only-refund-idem'))).toThrow(/requires its Book sale return/i);
    expect(() => db.prepare(`
      INSERT INTO book_sales
        (id, book_id, quantity, unit_price, gross_amount, discount_amount, net_amount, payment_id,
         sold_on, purchaser_name, operator_user_id, operator_name, branch_id, idempotency_key)
      VALUES (?, ?, 1, 500, 500, 0, 500, ?, '2026-08-23', 'attack', 'attack', 'attack', ?, ?)
    `).run(unique('mismatched-sale'), bookId, unrelatedPaymentId, BRANCH_A, unique('mismatched-sale-idem'))).toThrow(/Book sale is invalid/i);
    expect(() => db.prepare(`
      INSERT INTO book_sale_refunds
        (id, sale_id, refund_payment_id, returned_on, reason, returned_by_user_id, returned_by_name, branch_id, idempotency_key)
      VALUES (?, ?, ?, '2026-08-23', 'mismatched cash relation', 'attack', 'attack', ?, ?)
    `).run(unique('mismatched-return'), saleRow.id, unrelatedPaymentId, BRANCH_A, unique('mismatched-return-idem'))).toThrow(/Book sale return/i);

    expect(() => db.prepare(`
      INSERT INTO book_loans (id, book_id, student_id, issued_on, due_on, issued_by_user_id, issued_by_name, branch_id, idempotency_key)
      VALUES (?, ?, ?, '2026-08-23', '2026-09-01', 'attack', 'attack', ?, ?)
    `).run(unique('loan'), bookId, STUDENT_A, BRANCH_A, unique('loan-idem'))).toThrow(/unavailable/i);
    expect(() => db.prepare(`
      INSERT INTO book_loans (id, book_id, student_id, issued_on, due_on, issued_by_user_id, issued_by_name, branch_id, idempotency_key)
      VALUES (?, ?, ?, '2026-08-23', '2026-09-01', 'attack', 'attack', ?, ?)
    `).run(unique('foreign-loan'), bookId, STUDENT_B, BRANCH_A, unique('foreign-idem'))).toThrow(/cross-branch/i);
    expect(() => db.prepare(`
      INSERT INTO book_stock_receipts
        (id, book_id, quantity, received_on, received_by_user_id, received_by_name, branch_id, idempotency_key)
      VALUES (?, ?, 1, '2026-02-30', 'attack', 'attack', ?, ?)
    `).run(unique('bad-date-receipt'), bookId, BRANCH_A, unique('bad-date-receipt-idem'))).toThrow(/invalid/i);

    const lendingOnlyBook = await createCatalog({ saleEnabled: false, lendingEnabled: true });
    const directSaleId = unique('lending-only-sale');
    const directPaymentId = unique('lending-only-payment');
    expect(() => db.transaction(() => {
      db.prepare(`
        INSERT INTO book_sales
          (id, book_id, quantity, unit_price, gross_amount, discount_amount, net_amount, payment_id,
           sold_on, purchaser_name, operator_user_id, operator_name, branch_id, idempotency_key)
        VALUES (?, ?, 1, 500, 500, 0, 500, ?, '2026-08-23', 'attack', 'attack', 'attack', ?, ?)
      `).run(directSaleId, lendingOnlyBook, directPaymentId, BRANCH_A, unique('lending-only-sale-idem'));
      db.prepare(`
        INSERT INTO payments
          (id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
        VALUES (?, 500, '2026-08-23', 'cash', 'completed', 'book', 'attack', ?, ?, ?)
      `).run(directPaymentId, unique('receipt'), BRANCH_A, unique('lending-only-payment-idem'));
    })()).toThrow(/Book sale is invalid/i);
  });

  it('rejects duplicate catalog identity and collapses duplicate stock-receipt, sale, loan and terminal-return requests', async () => {
    const title = unique('One catalog identity');
    const bookId = await createCatalog({ title, initialQuantity: 2 });
    await supertest(app).post('/api/books/catalog').set(gm()).set('Idempotency-Key', unique('duplicate-title')).send({
      title, itemKind: 'book', branchId: BRANCH_A, saleEnabled: true, salePrice: 500, lendingEnabled: true, initialQuantity: 1,
    }).expect(409);

    const receiptKey = unique('same-receipt');
    const receiptAttempts = await Promise.all([
      supertest(app).post(`/api/books/catalog/${bookId}/receipts`).set(gm()).set('Idempotency-Key', receiptKey).send({ quantity: 1 }),
      supertest(app).post(`/api/books/catalog/${bookId}/receipts`).set(gm()).set('Idempotency-Key', receiptKey).send({ quantity: 1 }),
    ]);
    expect(receiptAttempts.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_stock_receipts WHERE book_id = ?').get(bookId)).toEqual({ count: 2 });

    const saleKey = unique('same-sale');
    const attempts = await Promise.all([
      supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', saleKey).send({ quantity: 1, purchaserName: 'Same buyer' }),
      supertest(app).post(`/api/books/catalog/${bookId}/sales`).set(gm()).set('Idempotency-Key', saleKey).send({ quantity: 1, purchaserName: 'Same buyer' }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 201]);
    const saleId = attempts.find((response) => response.status === 201)?.body.id as string;
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_sales WHERE book_id = ?').get(bookId)).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM financial_transactions ft JOIN book_sales s ON s.payment_id = ft.payment_id
       WHERE s.book_id = ?
    `).get(bookId)).toEqual({ count: 1 });

    const returnKey = unique('same-sale-return');
    const firstReturn = await supertest(app).post(`/api/books/sales/${saleId}/return`).set(finance()).set('Idempotency-Key', returnKey).send({ reason: 'Same return retry' }).expect(201);
    const replayReturn = await supertest(app).post(`/api/books/sales/${saleId}/return`).set(finance()).set('Idempotency-Key', returnKey).send({ reason: 'Same return retry' }).expect(200);
    expect(replayReturn.body).toMatchObject({ id: firstReturn.body.id, idempotentReplay: true });

    const loanKey = unique('same-loan');
    const issued = await supertest(app).post(`/api/books/catalog/${bookId}/loans`).set(receptionist()).set('Idempotency-Key', loanKey).send({ studentId: STUDENT_A, dueOn: '2026-09-01' }).expect(201);
    const replayLoan = await supertest(app).post(`/api/books/catalog/${bookId}/loans`).set(receptionist()).set('Idempotency-Key', loanKey).send({ studentId: STUDENT_A, dueOn: '2026-09-01' }).expect(200);
    expect(replayLoan.body).toMatchObject({ id: issued.body.id, idempotentReplay: true });

    const loanReturnKey = unique('same-loan-return');
    const returnedLoan = await supertest(app).post(`/api/books/loans/${issued.body.id}/return`).set(receptionist()).set('Idempotency-Key', loanReturnKey).send({ note: 'Same return retry' }).expect(201);
    const replayLoanReturn = await supertest(app).post(`/api/books/loans/${issued.body.id}/return`).set(receptionist()).set('Idempotency-Key', loanReturnKey).send({ note: 'Same return retry' }).expect(200);
    expect(replayLoanReturn.body).toMatchObject({ id: returnedLoan.body.id, idempotentReplay: true });
  });
});
