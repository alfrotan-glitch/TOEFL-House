/**
 * INVOICES — subsystem regression coverage.
 *
 * The invoice router is a primary money authority (it creates charges, records
 * payments and posts income to the ledger) but had no dedicated test file. The
 * Step-3 adversarial campaign proved most invariants already hold; this suite
 * locks them so they cannot silently regress, and pins the one confirmed
 * defect.
 *
 * INV-1 (the defect this suite is written against):
 *   PUT /api/invoices/config/settings {"invoiceDueDays": 1e20}  -> 200, stored
 *   POST /api/invoices                                          -> 500 "Invalid time value"
 *   POST /api/invoices/:id/issue                                -> 500 "Invalid time value"
 * `new Date().setDate(getDate() + 1e20)` yields an Invalid Date and
 * `.toISOString()` throws, halting all invoice creation and issuance until an
 * owner/manager reverts the setting. The regression below drives the COMPLETE
 * path — configuration write, persisted setting, invoice creation, stored due
 * date — not just the PUT response.
 *
 * Behaviours deliberately PRESERVED (policy undefined, no security impact):
 *   - an overdue UNPAID invoice may be cancelled
 *   - no maximum line quantity exists (assertMoney bounds the resulting total)
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { setSetting } from '../utils/settings.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

const BR_A = 'invt_branch_a';
const BR_B = 'invt_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string, branchId: string): TokenPayload => ({
  userId,
  username: userId,
  role: role as TokenPayload['role'],
  branchId,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const OWNER = tok('invt_owner', 'owner', BR_A);
const FINANCE = tok('invt_fin', 'finance', BR_A);
const MANAGER = tok('invt_mgr', 'manager', BR_A);
const REGISTRAR = tok('invt_reg', 'registrar', BR_A);
const FINANCE_B = tok('invt_fin_b', 'finance', BR_B);

let app: ReturnType<typeof createApp>;
let seq = 0;

function seedStudent(id: string, branchId: string, status = 'active') {
  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone, discount_percent)
     VALUES (?, ?, ?, ?, ?, ?, 'male', ?, 0)`,
  ).run(id, `TH-INVT-${id}`, `Student ${id}`, status, today(), branchId, `0790${(++seq).toString().padStart(6, '0')}`);
}

/** Create an invoice through the real route. */
async function makeInvoice(
  actor: TokenPayload = OWNER,
  { studentId = 'invt_stu_a', unitPrice = 10000, quantity = 1, discountAmount = 0, issue = true } = {},
) {
  const res = await supertest(app)
    .post('/api/invoices')
    .set(auth(actor))
    .send({ studentId, items: [{ description: 'Tuition', quantity, unitPrice }], discountAmount, issue });
  return { status: res.status, id: res.body?.id as string | undefined, body: res.body };
}

const invoiceRow = (id: string) =>
  db.prepare('SELECT id, status, total_amount, discount_amount, net_amount, invoice_number, branch_id, issue_date, due_date FROM invoices WHERE id = ?').get(id) as
    | Record<string, never>
    | undefined;

const paySum = (id: string) =>
  db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(id) as { c: number; s: number };

const ledgerSum = (id: string) =>
  db.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM financial_transactions WHERE reference_id = ?').get(id) as { c: number; s: number };

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('invt_campus', FIXED_ORG_ID, 'Invoice Campus', 'INVT');
  for (const b of [BR_A, BR_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
      .run(b, b, 'Loc', 'invt_campus');
  }
  const pw = await hashPassword('testpass123');
  for (const u of [OWNER, FINANCE, MANAGER, REGISTRAR, FINANCE_B]) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.role, u.branchId, pw);
  }
  syncLegacyUserRoles(db);
  seedStudent('invt_stu_a', BR_A);
  seedStudent('invt_stu_b', BR_B);
  seedStudent('invt_stu_susp', BR_A, 'suspended');
  app = createApp();
});

afterEach(() => {
  // Never let a hostile configuration leak into the next test.
  setSetting('invoice_due_days', String(SYSTEM_DEFAULTS.invoiceDueDays));
});

// ── INV-1 ────────────────────────────────────────────────────────────────────
describe('INV-1 · a hostile invoiceDueDays cannot break invoice creation', () => {
  it.each([
    ['1e20', 1e20],
    ['1e15', 1e15],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['negative', -5],
    ['fractional 0.001', 0.001],
    ['text', 'abc'],
    ['boolean', true],
    ['array', [30]],
    ['object', {}],
  ])('rejects invoiceDueDays = %s at the configuration write', async (_label, value) => {
    const res = await supertest(app)
      .put('/api/invoices/config/settings')
      .set(auth(OWNER))
      .send({ invoiceDueDays: value });
    expect(res.status).toBe(400);
  });

  it('non-finite values cannot even reach the endpoint over JSON', async () => {
    // JSON.stringify turns Infinity/NaN into null, and null means "leave
    // unchanged". Asserting a 400 here would test something unreachable, so the
    // real invariant is that the stored configuration is not corrupted.
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 30 });
    const res = await supertest(app)
      .put('/api/invoices/config/settings')
      .set(auth(OWNER))
      .send({ invoiceDueDays: Infinity });
    expect(res.status).toBe(200);
    const cfg = await supertest(app).get('/api/invoices/config/settings').set(auth(OWNER));
    expect(cfg.body.invoiceDueDays).toBe(30);

    const created = await makeInvoice(OWNER, { unitPrice: 100 });
    expect(created.status).toBe(201);
  });

  it('a raw non-finite literal in the JSON body is rejected, not stored', async () => {
    // Bypasses JSON.stringify: a hand-crafted body containing `1e999`
    // (which JSON.parse turns into Infinity) must not corrupt the setting.
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 30 });
    const res = await supertest(app)
      .put('/api/invoices/config/settings')
      .set({ ...auth(OWNER), 'Content-Type': 'application/json' })
      .send('{"invoiceDueDays": 1e999}');
    expect(res.status).toBe(400);

    const cfg = await supertest(app).get('/api/invoices/config/settings').set(auth(OWNER));
    expect(cfg.body.invoiceDueDays).toBe(30);
    expect((await makeInvoice(OWNER, { unitPrice: 100 })).status).toBe(201);
  });

  it.each([
    ['1e20', 1e20],
    ['1e15', 1e15],
    ['Infinity', Infinity],
  ])('invoice creation stays operational after an attempted %s setting', async (_label, value) => {
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: value });

    // The complete path: persisted setting -> creation -> stored due date.
    const created = await makeInvoice(OWNER, { unitPrice: 100 });
    expect(created.status).toBe(201); // was HTTP 500 "Invalid time value"

    const row = invoiceRow(created.id!) as unknown as { due_date: string; issue_date: string };
    expect(row.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(row.due_date).getTime())).toBe(false);
  });

  it('issuing a draft stays operational after an attempted hostile setting', async () => {
    const draft = await makeInvoice(OWNER, { unitPrice: 100, issue: false });
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 1e20 });

    const res = await supertest(app).post(`/api/invoices/${draft.id}/issue`).set(auth(OWNER));
    expect(res.status).toBe(200);
    const row = invoiceRow(draft.id!) as unknown as { due_date: string };
    expect(row.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ['0', 0],
    ['30', 30],
    ['3650', 3650],
    ['numeric string "45"', '45'],
  ])('still accepts the legitimate value %s', async (_label, value) => {
    const res = await supertest(app)
      .put('/api/invoices/config/settings')
      .set(auth(OWNER))
      .send({ invoiceDueDays: value });
    expect(res.status).toBe(200);

    const created = await makeInvoice(OWNER, { unitPrice: 100 });
    expect(created.status).toBe(201);
    expect((invoiceRow(created.id!) as unknown as { due_date: string }).due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a negative due-days value is rejected and cannot back-date an invoice', async () => {
    // Mutation I6 showed the ceiling alone does not catch a negative offset:
    // it yields a VALID past date, so there is no 500 to detect it by. The
    // damage is a silently back-dated (immediately overdue) invoice.
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 30 });
    expect((await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: -5 })).status).toBe(400);

    const created = await makeInvoice(OWNER, { unitPrice: 100 });
    const row = created.id ? (invoiceRow(created.id) as unknown as { issue_date: string; due_date: string }) : null;
    expect(row).not.toBeNull();
    expect(row!.due_date >= row!.issue_date).toBe(true);
  });

  it('a rejected setting leaves the previous configuration intact', async () => {
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 30 });
    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 1e20 });

    const cfg = await supertest(app).get('/api/invoices/config/settings').set(auth(OWNER));
    expect(cfg.body.invoiceDueDays).toBe(30);
  });

  it('a hostile setting cannot alter invoice, payment or ledger amounts', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 10000, paymentMethod: 'cash' });
    const before = { invoice: invoiceRow(inv.id!), pay: paySum(inv.id!), ledger: ledgerSum(inv.id!) };

    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 1e20 });

    expect(invoiceRow(inv.id!)).toEqual(before.invoice);
    expect(paySum(inv.id!)).toEqual(before.pay);
    expect(ledgerSum(inv.id!)).toEqual(before.ledger);
  });
});

// ── Sub-cent money consistency (canonical authority) ─────────────────────────
describe('INV-2 · sub-cent money is rejected, never silently rounded', () => {
  it('a sub-cent unitPrice is refused rather than stored as a different price', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(OWNER))
      .send({ studentId: 'invt_stu_a', items: [{ description: 'Sub-cent', quantity: 1, unitPrice: 0.001 }], issue: true });

    // Canonical policy (CFG-2 precedent + the payments money-scale triggers) is
    // REJECT, not round. Rounding turned 0.001 into a zero-value invoice.
    expect(res.status).toBe(400);
  });

  it('a sub-cent discount is refused', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(OWNER))
      .send({ studentId: 'invt_stu_a', items: [{ description: 'T', unitPrice: 1000 }], discountAmount: 0.001, issue: true });
    expect(res.status).toBe(400);
  });

  it('two-decimal money is still accepted exactly', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(OWNER))
      .send({ studentId: 'invt_stu_a', items: [{ description: 'T', quantity: 1, unitPrice: 1500.25 }], issue: true });
    expect(res.status).toBe(201);
    expect((invoiceRow(res.body.id) as unknown as { net_amount: number }).net_amount).toBe(1500.25);
  });
});

// ── Authorization ────────────────────────────────────────────────────────────
describe('invoice authorization matrix', () => {
  it('registrar cannot pay, cancel, or change configuration', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 1000 });
    const pay = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(REGISTRAR)).send({ amount: 100, paymentMethod: 'cash' });
    expect(pay.status).toBe(403);
    expect(paySum(inv.id!).c).toBe(0);

    const cancel = await supertest(app).post(`/api/invoices/${inv.id}/cancel`).set(auth(REGISTRAR));
    expect(cancel.status).toBe(403);
    expect((invoiceRow(inv.id!) as unknown as { status: string }).status).not.toBe('cancelled');

    const cfg = await supertest(app).put('/api/invoices/config/settings').set(auth(REGISTRAR)).send({ invoiceDueDays: 99 });
    expect(cfg.status).toBe(403);
  });

  it('finance may pay but may not change configuration', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 1000 });
    const pay = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 500, paymentMethod: 'cash' });
    expect(pay.status).toBe(201);
    expect((await supertest(app).put('/api/invoices/config/settings').set(auth(FINANCE)).send({ invoiceDueDays: 99 })).status).toBe(403);
  });

  it('an unauthenticated request cannot read or create', async () => {
    expect((await supertest(app).get('/api/invoices')).status).toBe(401);
    expect((await supertest(app).post('/api/invoices').send({ studentId: 'invt_stu_a', items: [] })).status).toBe(401);
  });
});

// ── Cross-branch ─────────────────────────────────────────────────────────────
describe('invoice branch isolation', () => {
  it('another branch cannot read, pay, or cancel an invoice', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    const before = invoiceRow(inv.id!);

    expect((await supertest(app).get(`/api/invoices/${inv.id}`).set(auth(FINANCE_B))).status).toBe(403);
    expect((await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE_B)).send({ amount: 100, paymentMethod: 'cash' })).status).toBe(403);
    expect((await supertest(app).post(`/api/invoices/${inv.id}/cancel`).set(auth(FINANCE_B))).status).toBe(403);

    expect(invoiceRow(inv.id!)).toEqual(before);
    expect(paySum(inv.id!).c).toBe(0);
  });

  it('an invoice cannot be created for a student in another branch, even with a forged branchId', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(FINANCE_B))
      .send({ studentId: 'invt_stu_a', branchId: BR_B, items: [{ description: 'X', unitPrice: 999 }], issue: true });
    expect(res.status).toBe(403);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
describe('invoice lifecycle', () => {
  it('a cancelled invoice cannot be paid or re-issued', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 1000 });
    expect((await supertest(app).post(`/api/invoices/${inv.id}/cancel`).set(auth(FINANCE))).status).toBe(200);

    expect((await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 100, paymentMethod: 'cash' })).status).toBe(400);
    expect((await supertest(app).post(`/api/invoices/${inv.id}/issue`).set(auth(OWNER))).status).toBe(400);
    expect(paySum(inv.id!).c).toBe(0);
  });

  it('a paid invoice cannot be cancelled and a partially paid one cannot be cancelled', async () => {
    const paid = await makeInvoice(OWNER, { unitPrice: 1000 });
    await supertest(app).post(`/api/invoices/${paid.id}/pay`).set(auth(FINANCE)).send({ amount: 1000, paymentMethod: 'cash' });
    expect((await supertest(app).post(`/api/invoices/${paid.id}/cancel`).set(auth(FINANCE))).status).toBe(400);

    const partial = await makeInvoice(OWNER, { unitPrice: 1000 });
    await supertest(app).post(`/api/invoices/${partial.id}/pay`).set(auth(FINANCE)).send({ amount: 400, paymentMethod: 'cash' });
    expect((await supertest(app).post(`/api/invoices/${partial.id}/cancel`).set(auth(FINANCE))).status).toBe(400);
    expect(paySum(partial.id!).s).toBe(400);
  });

  it('only a draft can be issued', async () => {
    const issued = await makeInvoice(OWNER, { unitPrice: 100 });
    expect((await supertest(app).post(`/api/invoices/${issued.id}/issue`).set(auth(OWNER))).status).toBe(400);
  });

  it('PRESERVED POLICY — an overdue UNPAID invoice may be cancelled', async () => {
    // Documented as POLICY UNDEFINED / no security impact. Locked so the
    // current behaviour cannot drift silently in either direction.
    const inv = await makeInvoice(OWNER, { unitPrice: 1000 });
    db.prepare("UPDATE invoices SET status='overdue' WHERE id=?").run(inv.id);
    expect((await supertest(app).post(`/api/invoices/${inv.id}/cancel`).set(auth(FINANCE))).status).toBe(200);
    expect((invoiceRow(inv.id!) as unknown as { status: string }).status).toBe('cancelled');
  });
});

// ── Payment validation & money conservation ──────────────────────────────────
describe('invoice payment validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -100],
    ['sub-cent', 0.001],
    ['huge 1e15', 1e15],
    ['huge 1e20', 1e20],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['text', 'abc'],
    ['boolean', true],
    ['array', [500]],
    ['object', {}],
    ['null', null],
    ['hex string', '0x10'],
  ])('rejects a %s payment and writes nothing', async (_label, amount) => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    const res = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount, paymentMethod: 'cash' });
    expect(res.status).toBe(400);
    expect(paySum(inv.id!).c).toBe(0);
    expect(ledgerSum(inv.id!).c).toBe(0);
  });

  it('rejects an overpayment and leaves the balance untouched', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    expect((await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 10001, paymentMethod: 'cash' })).status).toBe(400);
    expect(paySum(inv.id!).s).toBe(0);
  });

  it('accepted payments never exceed the invoice total and the ledger matches exactly', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 3000, paymentMethod: 'cash' });
    await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 7000, paymentMethod: 'cash' });
    const over = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 1, paymentMethod: 'cash' });

    expect(over.status).toBe(400);
    expect(paySum(inv.id!).s).toBe(10000);
    expect(ledgerSum(inv.id!).s).toBe(10000);
    expect((invoiceRow(inv.id!) as unknown as { status: string }).status).toBe('paid');
  });

  it('an identical unkeyed retry is collapsed, distinct keys both land', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    const first = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 5000, paymentMethod: 'cash' });
    const retry = await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 5000, paymentMethod: 'cash' });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(paySum(inv.id!).c).toBe(1);

    const second = await supertest(app)
      .post(`/api/invoices/${inv.id}/pay`)
      .set({ ...auth(FINANCE), 'Idempotency-Key': 'invt-distinct' })
      .send({ amount: 5000, paymentMethod: 'cash' });
    expect(second.status).toBe(201);
    expect(paySum(inv.id!).s).toBe(10000);
  });

  it('historical payments are immutable across later configuration changes', async () => {
    const inv = await makeInvoice(OWNER, { unitPrice: 10000 });
    await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 10000, paymentMethod: 'cash' });
    const before = db.prepare('SELECT id, amount, receipt_number FROM payments WHERE invoice_id = ?').all(inv.id);

    await supertest(app).put('/api/invoices/config/settings').set(auth(OWNER)).send({ invoiceDueDays: 7 });

    expect(db.prepare('SELECT id, amount, receipt_number FROM payments WHERE invoice_id = ?').all(inv.id)).toEqual(before);
  });
});

// ── Creation validation ──────────────────────────────────────────────────────
describe('invoice creation validation', () => {
  const item = (o: Record<string, unknown>) => ({
    studentId: 'invt_stu_a',
    items: [{ description: 'T', quantity: 1, unitPrice: 1000, ...o }],
    issue: true,
  });

  it.each([
    ['negative quantity', item({ quantity: -3 })],
    ['zero quantity', item({ quantity: 0 })],
    ['fractional quantity', item({ quantity: 1.5 })],
    ['negative price', item({ unitPrice: -500 })],
    ['price beyond precision', item({ unitPrice: 1e20 })],
    ['text price', item({ unitPrice: 'abc' })],
    ['NaN price', item({ unitPrice: NaN })],
    ['Infinity price', item({ unitPrice: Infinity })],
    ['array price', item({ unitPrice: [500] })],
    ['blank description', { studentId: 'invt_stu_a', items: [{ description: '', unitPrice: 100 }], issue: true }],
    ['no items', { studentId: 'invt_stu_a', items: [], issue: true }],
    ['items not an array', { studentId: 'invt_stu_a', items: 'x', issue: true }],
    ['negative discount', { studentId: 'invt_stu_a', items: [{ description: 'T', unitPrice: 1000 }], discountAmount: -100, issue: true }],
    ['discount above total', { studentId: 'invt_stu_a', items: [{ description: 'T', unitPrice: 1000 }], discountAmount: 99999, issue: true }],
    ['missing studentId', { items: [{ description: 'T', unitPrice: 100 }], issue: true }],
  ])('rejects %s', async (_label, body) => {
    const before = (db.prepare('SELECT COUNT(*) c FROM invoices').get() as { c: number }).c;
    const res = await supertest(app).post('/api/invoices').set(auth(OWNER)).send(body);
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) c FROM invoices').get() as { c: number }).c).toBe(before);
  });

  it('rejects an unknown student (404) and a suspended one (409)', async () => {
    expect((await supertest(app).post('/api/invoices').set(auth(OWNER)).send({ studentId: 'nope', items: [{ description: 'T', unitPrice: 100 }] })).status).toBe(404);
    expect((await supertest(app).post('/api/invoices').set(auth(OWNER)).send({ studentId: 'invt_stu_susp', items: [{ description: 'T', unitPrice: 100 }] })).status).toBe(409);
  });

  it('a forged total is ignored — the server recomputes from the line items', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(OWNER))
      .send({ studentId: 'invt_stu_a', items: [{ description: 'T', quantity: 2, unitPrice: 1000 }], totalAmount: 1, netAmount: 1, issue: true });
    expect(res.status).toBe(201);
    const row = invoiceRow(res.body.id) as unknown as { total_amount: number; net_amount: number };
    expect(row.total_amount).toBe(2000);
    expect(row.net_amount).toBe(2000);
  });

  it('a discount equal to the total yields a zero net invoice', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(OWNER))
      .send({ studentId: 'invt_stu_a', items: [{ description: 'T', unitPrice: 1000 }], discountAmount: 1000, issue: true });
    expect(res.status).toBe(201);
    expect((invoiceRow(res.body.id) as unknown as { net_amount: number }).net_amount).toBe(0);
  });
});

// ── Numbering ────────────────────────────────────────────────────────────────
describe('invoice and receipt numbering integrity', () => {
  it('issued invoices and payments never share a number', async () => {
    for (let i = 0; i < 5; i++) {
      const inv = await makeInvoice(OWNER, { unitPrice: 100 });
      await supertest(app).post(`/api/invoices/${inv.id}/pay`).set(auth(FINANCE)).send({ amount: 100, paymentMethod: 'cash' });
    }
    const dupInvoices = db.prepare('SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL GROUP BY invoice_number HAVING COUNT(*) > 1').all();
    const dupReceipts = db.prepare('SELECT receipt_number FROM payments WHERE receipt_number IS NOT NULL GROUP BY receipt_number HAVING COUNT(*) > 1').all();
    expect(dupInvoices).toEqual([]);
    expect(dupReceipts).toEqual([]);
  });

  it('a draft carries no invoice number until it is issued', async () => {
    const draft = await makeInvoice(OWNER, { unitPrice: 100, issue: false });
    expect((invoiceRow(draft.id!) as unknown as { invoice_number: string | null }).invoice_number).toBeNull();
    await supertest(app).post(`/api/invoices/${draft.id}/issue`).set(auth(OWNER));
    expect((invoiceRow(draft.id!) as unknown as { invoice_number: string | null }).invoice_number).toMatch(/^INV-/);
  });
});
