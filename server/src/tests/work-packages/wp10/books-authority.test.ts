import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { ensureOrganizationHierarchy } from '../../../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { createBooksTestApp, ensureBookBranch, ensureBookStudent } from '../../support/books.js';

const BRANCH_A = 'wp10_authority_a';
const BRANCH_B = 'wp10_authority_b';
const GENERAL_MANAGER = 'wp10_authority_gm';
const RECEPTIONIST = 'wp10_authority_reception';
const FINANCE = 'wp10_authority_finance';
const STUDENT_A = 'wp10_authority_student_a';
const STUDENT_B = 'wp10_authority_student_b';

const app = createBooksTestApp();
const gm = () => bearerFor(GENERAL_MANAGER);
const receptionist = () => bearerFor(RECEPTIONIST);
const finance = () => bearerFor(FINANCE);

function key(name: string): string {
  return `${name}-${crypto.randomUUID()}`;
}

async function createCatalog(input: Partial<{
  title: string;
  branchId: string;
  saleEnabled: boolean;
  salePrice: number;
  lendingEnabled: boolean;
  initialQuantity: number;
}> = {}) {
  const response = await supertest(app)
    .post('/api/books/catalog')
    .set(gm())
    .set('Idempotency-Key', key('catalog'))
    .send({
      title: input.title ?? `Book ${crypto.randomUUID()}`,
      itemKind: 'book',
      branchId: input.branchId ?? BRANCH_A,
      saleEnabled: input.saleEnabled ?? true,
      salePrice: input.saleEnabled === false ? null : (input.salePrice ?? 1000),
      lendingEnabled: input.lendingEnabled ?? true,
      initialQuantity: input.initialQuantity ?? 4,
    })
    .expect(201);
  return response.body.id as string;
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  ensureBookBranch(db, { campusId: 'wp10_authority_campus', branchId: BRANCH_A });
  ensureBookBranch(db, { campusId: 'wp10_authority_campus', branchId: BRANCH_B });
  seedUser({ id: GENERAL_MANAGER, role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: RECEPTIONIST, role: 'receptionist', branchId: BRANCH_A });
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BRANCH_A });
  ensureBookStudent(db, { id: STUDENT_A, branchId: BRANCH_A, fullName: 'Books Student A' });
  ensureBookStudent(db, { id: STUDENT_B, branchId: BRANCH_B, fullName: 'Books Student B' });
});

describe('WP-10 · canonical Book commerce and inventory authority', () => {
  it('creates one Book sale with one matching payment/income pair and a server-derived availability position', async () => {
    const bookId = await createCatalog({ initialQuantity: 4 });
    const sale = await supertest(app)
      .post(`/api/books/catalog/${bookId}/sales`)
      .set(gm())
      .set('Idempotency-Key', key('sale'))
      .send({ quantity: 2, studentId: STUDENT_A, discountAmount: 100, paymentMethod: 'bank_transfer', soldOn: '2026-08-20' })
      .expect(201);

    const facts = db.prepare(`
      SELECT s.quantity, s.gross_amount, s.discount_amount, s.net_amount,
             p.amount AS payment_amount, p.category AS payment_category, p.payment_method,
             ft.amount AS income_amount, ft.category AS income_category, ft.reference_id
        FROM book_sales s
        JOIN payments p ON p.id = s.payment_id
        JOIN financial_transactions ft ON ft.payment_id = p.id
       WHERE s.id = ?
    `).get(sale.body.id) as Record<string, unknown>;
    expect(facts).toEqual({
      quantity: 2,
      gross_amount: 2000,
      discount_amount: 100,
      net_amount: 1900,
      payment_amount: 1900,
      payment_category: 'book',
      payment_method: 'bank_transfer',
      income_amount: 1900,
      income_category: 'book',
      reference_id: sale.body.id,
    });

    const workspace = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A }).expect(200);
    const item = workspace.body.catalog.find((row: { id: string }) => row.id === bookId);
    expect(item).toMatchObject({ receivedQuantity: 4, soldQuantity: 2, loanedQuantity: 0, availableQuantity: 2 });
    expect(workspace.body.summary).toMatchObject({ soldQuantity: 2, salesRevenue: 1900 });
  });

  it('paginates every high-volume Books history rather than silently truncating it', async () => {
    const bookId = await createCatalog({ initialQuantity: 4 });
    for (const suffix of ['one', 'two', 'three']) {
      await supertest(app)
        .post(`/api/books/catalog/${bookId}/sales`)
        .set(gm())
        .set('Idempotency-Key', key(`paged-sale-${suffix}`))
        .send({ quantity: 1, purchaserName: `Paged purchaser ${suffix}` })
        .expect(201);
    }
    const first = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A, page: 1, limit: 1 }).expect(200);
    const second = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A, page: 2, limit: 1 }).expect(200);
    expect(first.body.sales).toMatchObject({ page: 1, pageSize: 1 });
    expect(second.body.sales).toMatchObject({ page: 2, pageSize: 1 });
    expect(first.body.sales.total).toBeGreaterThanOrEqual(3);
    expect(second.body.sales.total).toBe(first.body.sales.total);
    expect(first.body.sales.items).toHaveLength(1);
    expect(second.body.sales.items).toHaveLength(1);
    expect(first.body.sales.items[0].id).not.toBe(second.body.sales.items[0].id);
    const capped = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A, page: 1, limit: 1000 }).expect(200);
    const malformed = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A, page: -1, limit: -1 }).expect(200);
    expect(capped.body.sales.pageSize).toBe(100);
    expect(malformed.body.sales).toMatchObject({ page: 1, pageSize: 50 });
  });

  it('does not allow the generic Student payment/refund path to create or reverse Book truth', async () => {
    const bookId = await createCatalog();
    await supertest(app)
      .post(`/api/students/${STUDENT_A}/payments`)
      .set(gm())
      .send({ category: 'book', amount: 1000, bookId })
      .expect(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_sales WHERE book_id = ?').get(bookId)).toEqual({ count: 0 });

    const sale = await supertest(app)
      .post(`/api/books/catalog/${bookId}/sales`)
      .set(gm())
      .set('Idempotency-Key', key('sale'))
      .send({ quantity: 1, studentId: STUDENT_A })
      .expect(201);
    const payment = db.prepare('SELECT payment_id FROM book_sales WHERE id = ?').get(sale.body.id) as { payment_id: string };
    await supertest(app)
      .post(`/api/students/${STUDENT_A}/refund`)
      .set(gm())
      .send({ paymentId: payment.payment_id, amount: 1000, reason: 'Attempt generic refund' })
      .expect(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM book_sale_refunds WHERE sale_id = ?').get(sale.body.id)).toEqual({ count: 0 });
  });

  it('returns a full sale exactly once through a signed contra payment, restores availability, and refuses a second return', async () => {
    const bookId = await createCatalog({ initialQuantity: 2 });
    const sale = await supertest(app)
      .post(`/api/books/catalog/${bookId}/sales`)
      .set(gm())
      .set('Idempotency-Key', key('sale'))
      .send({ quantity: 1, purchaserName: 'Walk-in purchaser' })
      .expect(201);

    const returned = await supertest(app)
      .post(`/api/books/sales/${sale.body.id}/return`)
      .set(finance())
      .set('Idempotency-Key', key('return'))
      .send({ reason: 'Customer returned the unopened book.', returnedOn: '2026-08-24' })
      .expect(201);
    expect(returned.body.receiptNumber).toMatch(/^REF-R-/);
    expect(db.prepare(`
      SELECT p.amount AS payment_amount, p.category, p.refunds_payment_id,
             ft.amount AS income_amount, ft.category AS income_category, ft.reference_id
        FROM book_sale_refunds sr
        JOIN payments p ON p.id = sr.refund_payment_id
        JOIN financial_transactions ft ON ft.payment_id = p.id
       WHERE sr.id = ?
    `).get(returned.body.id)).toMatchObject({ payment_amount: -1000, category: 'refund', income_amount: -1000, income_category: 'refund', reference_id: sale.body.id });
    expect(db.prepare('SELECT available_quantity FROM book_inventory_positions WHERE book_id = ?').get(bookId)).toEqual({ available_quantity: 2 });

    await supertest(app)
      .post(`/api/books/sales/${sale.body.id}/return`)
      .set(finance())
      .set('Idempotency-Key', key('second-return'))
      .send({ reason: 'Second return must fail.' })
      .expect(409);
  });

  it('records a student loan with an explicit due date, derives overdue state, and restores the copy only through one return fact', async () => {
    const bookId = await createCatalog({ saleEnabled: false, lendingEnabled: true, initialQuantity: 1 });
    const issue = await supertest(app)
      .post(`/api/books/catalog/${bookId}/loans`)
      .set(receptionist())
      .set('Idempotency-Key', key('loan'))
      .send({ studentId: STUDENT_A, issuedOn: '2026-08-01', dueOn: '2026-08-02' })
      .expect(201);

    let workspace = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A }).expect(200);
    const loan = workspace.body.loans.items.find((row: { id: string }) => row.id === issue.body.id);
    expect(loan).toMatchObject({ studentId: STUDENT_A, returned: false, overdue: true });
    expect(workspace.body.catalog.find((row: { id: string }) => row.id === bookId)).toMatchObject({ availableQuantity: 0, loanedQuantity: 1 });
    expect(db.prepare(`SELECT event_type, payload FROM student_journey_events WHERE student_id = ? AND correlation_id = ?`).get(STUDENT_A, issue.body.id)).toMatchObject({ event_type: 'journey.book_issued' });

    const returned = await supertest(app)
      .post(`/api/books/loans/${issue.body.id}/return`)
      .set(receptionist())
      .set('Idempotency-Key', key('loan-return'))
      .send({ returnedOn: '2026-08-03', note: 'Returned in good condition.' })
      .expect(201);
    expect(db.prepare(`SELECT event_type FROM student_journey_events WHERE student_id = ? AND correlation_id = ?`).get(STUDENT_A, returned.body.id)).toEqual({ event_type: 'journey.book_returned' });
    await supertest(app)
      .post(`/api/books/loans/${issue.body.id}/return`)
      .set(receptionist())
      .set('Idempotency-Key', key('loan-return-again'))
      .send({ returnedOn: '2026-08-03' })
      .expect(409);

    workspace = await supertest(app).get('/api/books/workspace').set(gm()).query({ branchId: BRANCH_A }).expect(200);
    expect(workspace.body.catalog.find((row: { id: string }) => row.id === bookId)).toMatchObject({ availableQuantity: 1, loanedQuantity: 0 });
  });
});
