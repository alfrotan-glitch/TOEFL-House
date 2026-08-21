/**
 * WP-07 · Document integrity and discount-authorization input boundary.
 * ============================================================================
 * Slice C of the WP-07 remediation. Three concerns, all proven against the
 * pre-change code:
 *
 *   WP07-F12  `payments.receipt_number` had no uniqueness at rest. The
 *             generator's comment claims the number is "guaranteed unique",
 *             but the guarantee lived only in application code — the database
 *             accepted two payments carrying one receipt number, which makes
 *             the customer-facing proof of payment ambiguous (LAW 3).
 *   WP07-F13  Duplicate schema authority: `invoices` carried the same unique
 *             index under two names, `invoice_items` the same index under two
 *             names, and `invoices`/`payments` each carried two branch-guard
 *             trigger pairs where the second is strictly stronger than the
 *             first (§12 "no duplicate schema authority").
 *   WP07-F14  The discount-authorization write path coerced its percentage
 *             with `Number()` (so `[50]` and `true` became grants), accepted
 *             any string as an effective date (so a garbage window silently
 *             disabled or perpetuated a money grant), had no range constraint
 *             at rest, and the resolver swallowed every SQL error as
 *             "table absent", silently falling back to ordinary policy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { invoicesRouter } from '../../../routes/invoices.routes.js';
import { discountAuthorizationsRouter } from '../../../routes/discount-authorizations.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { nextReceiptNumber, nextStudentCode } from '../../../utils/receipt.js';
import { nextInvoiceNumber } from '../../../utils/invoice.js';
import { nextScopedDocumentNumber } from '../../../utils/documentNumbers.js';
import { resolveAuthorizedDiscount } from '../../../core/configuration/discount-authority.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/invoices', invoicesRouter);
app.use('/api/discount-authorizations', discountAuthorizationsRouter);
app.use(errorHandler);

let key: string;
let branchA: string;
let branchB: string;
let studentA: string;
let studentB: string;
let owner: { Authorization: string };

const insertPayment = (id: string, studentId: string, branch: string, receipt: string | null) =>
  db.prepare(
    `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, 1000, ?, 'cash', 'completed', 'fee', ?, ?, ?)`,
  ).run(id, studentId, today(), receipt, branch, `k_${randomUUID()}`);

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7c_${process.pid}_${randomUUID().slice(0, 6)}`;
  branchA = `${key}_a`;
  branchB = `${key}_b`;
  for (const b of [branchA, branchB]) {
    db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(b, b);
  }
  studentA = `${key}_sa`;
  studentB = `${key}_sb`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, 'Student A', 'active', ?, ?, 'male')`,
  ).run(studentA, `TH-A${key.slice(-5)}`, today(), branchA);
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, 'Student B', 'active', ?, ?, 'female')`,
  ).run(studentB, `TH-B${key.slice(-5)}`, today(), branchB);
  seedUser({ id: `${key}_owner`, role: 'owner', branchId: branchA, fullName: 'Owner' });
  owner = bearerFor(`${key}_owner`);
});

describe('WP-07 · a receipt number identifies exactly one payment', () => {
  it('WP07-F12 · the database refuses a duplicate receipt number', () => {
    insertPayment(`${key}_p1`, studentA, branchA, 'R-00099001');
    expect(() => insertPayment(`${key}_p2`, studentA, branchA, 'R-00099001')).toThrow(/UNIQUE/i);
    expect((db.prepare('SELECT COUNT(*) c FROM payments WHERE receipt_number = ?').get('R-00099001') as { c: number }).c).toBe(1);
  });

  it('the guarantee is global, because the counter that issues it is global', () => {
    insertPayment(`${key}_p3`, studentA, branchA, 'R-00099002');
    // Another branch cannot reuse the number either: one counter, one namespace.
    expect(() => insertPayment(`${key}_p4`, studentB, branchB, 'R-00099002')).toThrow(/UNIQUE/i);
  });

  it('leaves receipt-less rows alone', () => {
    insertPayment(`${key}_p5`, studentA, branchA, null);
    insertPayment(`${key}_p6`, studentA, branchA, null);
    expect((db.prepare('SELECT COUNT(*) c FROM payments WHERE receipt_number IS NULL AND student_id = ?').get(studentA) as { c: number }).c).toBe(2);
  });

  it('issues unique numbers under repeated allocation', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(nextReceiptNumber());
    expect(seen.size).toBe(200);
  });
});

describe('WP-07 · attack · the document guarantees hold under abuse', () => {
  it('refuses a duplicate receipt introduced by an UPDATE, not only by an INSERT', () => {
    insertPayment(`${key}_u1`, studentA, branchA, 'R-00088001');
    insertPayment(`${key}_u2`, studentA, branchA, 'R-00088002');
    expect(() =>
      db.prepare('UPDATE payments SET receipt_number = ? WHERE id = ?').run('R-00088001', `${key}_u2`),
    ).toThrow(/UNIQUE/i);
  });

  it('never issues one number to a payment and a refund', () => {
    // Refund receipts are prefixed but drawn from the SAME counter, so a
    // collision would mean the counter, not the prefix, had failed.
    const issued = new Set<string>();
    for (let i = 0; i < 50; i++) {
      issued.add(nextReceiptNumber());
      issued.add(`REF-${nextReceiptNumber()}`);
    }
    expect(issued.size).toBe(100);
    expect([...issued].filter((n) => n.startsWith('REF-')).length).toBe(50);
  });

  it.each([
    ['an exponent', '1e2'],
    ['a hex string', '0x0F'],
    ['whitespace only', '   '],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['an object', { percent: 10 }],
  ])('refuses %s as an approved percent', async (_label, approvedPercent) => {
    const res = await supertest(app).post('/api/discount-authorizations').set(owner).send({
      studentId: studentA, category: 'COURSE_AMBASSADOR', reason: 'Attack', approvedPercent,
    });
    expect(res.status).toBe(400);
  });

  it('accepts a padded numeric string as the number it spells', async () => {
    await supertest(app).post('/api/discount-authorizations').set(owner).send({
      studentId: studentA, category: 'COURSE_AMBASSADOR', reason: 'Padded', approvedPercent: ' 12.5 ',
    }).expect(201);
    const row = db.prepare('SELECT approved_percent p FROM student_discount_authorizations WHERE student_id = ?').get(studentA) as { p: number };
    expect(row.p).toBe(12.5);
  });

  it('a requested percent above the ceiling is recorded but never granted', async () => {
    await supertest(app).post('/api/discount-authorizations').set(owner).send({
      studentId: studentA, category: 'COURSE_AMBASSADOR', reason: 'Asked for more',
      requestedPercent: 90, approvedPercent: 15,
    }).expect(201);
    const row = db.prepare('SELECT requested_percent r, approved_percent p FROM student_discount_authorizations WHERE student_id = ?').get(studentA) as { r: number; p: number };
    expect([row.r, row.p]).toEqual([90, 15]);
    expect(resolveAuthorizedDiscount(db, studentA, 90, { branchId: branchA }).percent).toBe(15);
  });
});

describe('WP-07 · document numbers keep their formats and their one counter', () => {
  it('every generator produces its documented format', () => {
    expect(nextReceiptNumber()).toMatch(/^R-\d{8}$/);
    expect(nextStudentCode()).toMatch(/^TH-\d{6}$/);
    expect(nextInvoiceNumber(branchA, 2026)).toMatch(/^INV-2026-\d{5}$/);
    expect(nextScopedDocumentNumber('donation_receipt', branchA, 'DON', 2026)).toMatch(/^DON-2026-\d{6}$/);
  });

  it('invoice numbering is per branch and per year', () => {
    expect(nextInvoiceNumber(branchA, 2026)).toBe('INV-2026-00001');
    expect(nextInvoiceNumber(branchA, 2026)).toBe('INV-2026-00002');
    // A different branch keeps its own sequence; a different year restarts.
    expect(nextInvoiceNumber(branchB, 2026)).toBe('INV-2026-00001');
    expect(nextInvoiceNumber(branchA, 2027)).toBe('INV-2027-00001');
  });

  it('an invoice number is unique within its branch and free in another', async () => {
    const first = await supertest(app).post('/api/invoices').set(owner)
      .send({ studentId: studentA, items: [{ description: 'Tuition', unitPrice: 1000 }], issue: true }).expect(201);
    const numberA = first.body.invoiceNumber as string;
    expect(numberA).toMatch(/^INV-\d{4}-\d{5}$/);

    // The same string in the same branch is refused by the database.
    expect(() =>
      db.prepare(
        `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, invoice_number)
         VALUES (?, ?, 1000, 0, 1000, 'issued', ?, ?, ?)`,
      ).run(`${key}_dupinv`, studentA, today(), branchA, numberA),
    ).toThrow(/UNIQUE/i);

    // Uniqueness is scoped to the branch, which is what the counter matches.
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, invoice_number)
       VALUES (?, ?, 1000, 0, 1000, 'issued', ?, ?, ?)`,
    ).run(`${key}_otherbranch`, studentB, today(), branchB, numberA);
    expect((db.prepare('SELECT COUNT(*) c FROM invoices WHERE invoice_number = ?').get(numberA) as { c: number }).c).toBe(2);
  });

  it('allocates every document number through one counter authority', () => {
    const src = (file: string) =>
      fs.readFileSync(path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'), 'utils', file), 'utf8');
    // receipt.ts and invoice.ts must consume the sequence authority rather than
    // each re-deriving "read the counter, add one, pad it".
    for (const file of ['receipt.ts', 'invoice.ts']) {
      expect(src(file)).toMatch(/from '\.\/documentNumbers\.js'/);
      expect(src(file)).not.toMatch(/incrementNumberSetting/);
    }
  });
});

describe('WP-07 · the canonical schema declares each constraint once', () => {
  const WP07_TABLES = ['invoices', 'invoice_items', 'payments'];

  const indexShapes = (table: string) =>
    (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`).all(table) as Array<{ name: string; sql: string }>)
      .map((row) => {
        const sql = row.sql.replace(/\s+/g, ' ').replace(/IF NOT EXISTS /i, '').toLowerCase();
        const match = /on\s+"?\w+"?\s*\(([^)]*)\)(.*)$/.exec(sql);
        return {
          name: row.name,
          shape: `${/create unique index/.test(sql)}|${(match?.[1] ?? '').replace(/\s/g, '')}|${(match?.[2] ?? '').trim()}`,
        };
      });

  it.each(WP07_TABLES)('WP07-F13 · %s declares no index twice', (table) => {
    const shapes = indexShapes(table);
    const byShape = new Map<string, string[]>();
    for (const entry of shapes) byShape.set(entry.shape, [...(byShape.get(entry.shape) ?? []), entry.name]);
    const duplicated = [...byShape.entries()].filter(([, names]) => names.length > 1);
    expect(duplicated.map(([, names]) => names.join(' == '))).toEqual([]);
  });

  it.each(['invoices', 'payments'])('WP07-F13 · %s carries exactly one branch guard per event', (table) => {
    const triggers = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`).all(table) as Array<{ name: string; sql: string }>)
      .filter((t) => /branch/i.test(t.name));
    const inserts = triggers.filter((t) => /before insert/i.test(t.sql));
    const updates = triggers.filter((t) => /before update/i.test(t.sql));
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    // The survivor is the NULL-safe one: `<>` yields NULL — not TRUE — when the
    // related row is missing, so it cannot be the guard that stays.
    for (const t of [...inserts, ...updates]) expect(t.sql).toMatch(/IS NOT NEW\./);
  });

  it('the surviving guard still refuses a cross-branch invoice and payment', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id)
         VALUES (?, ?, 500, 0, 500, 'issued', ?, ?)`,
      ).run(`${key}_xinv`, studentA, today(), branchB),
    ).toThrow(/branch/i);

    expect(() => insertPayment(`${key}_xpay`, studentA, branchB, null)).toThrow(/branch/i);
  });
});

describe('WP-07 · a discount authorization is parsed, dated and bounded', () => {
  const grant = (body: Record<string, unknown>) =>
    supertest(app).post('/api/discount-authorizations').set(owner).send({
      studentId: studentA, category: 'COURSE_AMBASSADOR', reason: 'Ambassador programme', ...body,
    });

  const authorizations = () =>
    db.prepare('SELECT * FROM student_discount_authorizations WHERE student_id = ?').all(studentA) as Array<Record<string, unknown>>;

  it.each([
    ['an array', [10]],
    ['a boolean', true],
    ['a non-numeric string', 'abc'],
    ['an empty string', ''],
    ['null', null],
    ['a negative percent', -5],
  ])('WP07-F14 · refuses %s as an approved percent', async (_label, approvedPercent) => {
    const res = await grant({ approvedPercent });
    expect(res.status).toBe(400);
    expect(authorizations()).toHaveLength(0);
  });

  it('accepts a numeric percent inside the category ceiling', async () => {
    await grant({ approvedPercent: 15 }).expect(201);
    await grant({ approvedPercent: '10' }).expect(201);
    expect(authorizations().map((a) => Number(a.approved_percent))).toEqual([15, 10]);
  });

  it('still refuses a percent above the category ceiling', async () => {
    const res = await grant({ approvedPercent: 16 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/may not exceed 15%/);
  });

  it.each([
    ['a non-date string', { effectiveFrom: 'banana' }],
    ['an impossible date', { effectiveTo: '2026-13-45' }],
    ['a reversed window', { effectiveFrom: '2026-09-01', effectiveTo: '2026-08-01' }],
  ])('WP07-F14 · refuses %s as an effective window', async (_label, window) => {
    const res = await grant({ approvedPercent: 10, ...window });
    expect(res.status).toBe(400);
    expect(authorizations()).toHaveLength(0);
  });

  it('accepts a real window and honours it', async () => {
    await grant({ approvedPercent: 15, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }).expect(201);
    expect(resolveAuthorizedDiscount(db, studentA, 5, { branchId: branchA, today: '2026-06-01' }).percent).toBe(15);
    expect(resolveAuthorizedDiscount(db, studentA, 5, { branchId: branchA, today: '2027-01-01' }).percent).toBe(5);
  });

  it('control · the database already refuses a percent outside 0-100 at rest', () => {
    const insert = (percent: number) =>
      db.prepare(
        `INSERT INTO student_discount_authorizations (id, student_id, category, approved_percent, branch_id, status)
         VALUES (?, ?, 'SPONSORSHIP', ?, ?, 'active')`,
      ).run(randomUUID(), studentA, percent, branchA);
    expect(() => insert(500)).toThrow();
    expect(() => insert(-1)).toThrow();
    expect(() => insert(100)).not.toThrow();
  });

  it('WP07-F14 · the resolver reports a broken authorization store instead of charging ordinary policy', () => {
    db.exec('ALTER TABLE student_discount_authorizations RENAME TO student_discount_authorizations_moved');
    try {
      expect(() => resolveAuthorizedDiscount(db, studentA, 50, { branchId: branchA })).toThrow();
    } finally {
      db.exec('ALTER TABLE student_discount_authorizations_moved RENAME TO student_discount_authorizations');
    }
  });
});
