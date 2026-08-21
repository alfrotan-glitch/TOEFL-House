/**
 * WP-07 · Invoice purpose authority (owner decision D-118).
 * ============================================================================
 * An invoice says WHAT is being billed, and a tuition invoice says WHICH term.
 * Money collected on an invoice settles the thing that invoice bills — never
 * tuition merely because it arrived through the invoice system.
 *
 * WP07-F17 is reproduced by the first two cases. `POST /api/invoices/:id/pay`
 * writes `category = 'fee'` for every invoice and leaves `semester` NULL, so:
 *
 *   a 3,000 AFN "Textbooks and stationery" invoice cut a 10,000 AFN tuition
 *   debt to 7,000 — the institute forgot 3,000 AFN of tuition receivable; and
 *
 *   a 10,000 AFN tuition invoice, paid in full, settled NO term, so the
 *   payment desk would collect the same 10,000 AFN a second time.
 *
 * One defect, two directions: money credited where it was not owed, and money
 * not credited where it was.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { invoicesRouter } from '../../../routes/invoices.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { getStudentBalance, getSemesterTuitionSettled } from '../../../utils/studentBalance.js';
import { computeReconciliation } from '../../../utils/reconciliation.js';
import { today } from '../../../utils/ids.js';

const app = express();
app.use(express.json());
app.use('/api/invoices', invoicesRouter);
app.use('/api/students', studentsRouter);
app.use(errorHandler);

let key: string;
let branch: string;
let studentId: string;
let semesterId: string;
const SEMESTER = 'Term One';
let manager: { Authorization: string };
let phoneSeq = 0;
const nextPhone = () => `07${String(1000000 + (phoneSeq += 1) + (process.pid % 100000)).slice(-8)}`;

/** Create an invoice through the public route and return the raw response. */
const createInvoice = (body: Record<string, unknown>) =>
  supertest(app).post('/api/invoices').set(manager).send(body);

const payInvoice = (invoiceId: string, body: Record<string, unknown>) =>
  supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(manager).send(body);

const paymentsOf = () =>
  db
    .prepare('SELECT id, amount, category, semester, invoice_id FROM payments WHERE student_id = ? ORDER BY rowid')
    .all(studentId) as Array<{ id: string; amount: number; category: string; semester: string | null; invoice_id: string | null }>;

beforeEach(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  key = `w7i_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);
  studentId = `${key}_s`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Invoice Probe', 'active', ?, ?, 'male', ?)`,
  ).run(studentId, `TH-I${key.slice(-5)}`, today(), branch, nextPhone());
  semesterId = `${key}_sem`;
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, ?, ?, 10000, 10000, 'active')`,
  ).run(semesterId, studentId, SEMESTER, today());
  seedUser({ id: `${key}_mgr`, role: 'general_manager', branchId: branch, fullName: 'Manager' });
  manager = bearerFor(`${key}_mgr`);
});

describe('WP-07 · WP07-F17 — an invoice payment settles what the invoice bills', () => {
  it('a books invoice, paid in full, leaves tuition untouched', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'books',
      items: [{ description: 'Textbooks and stationery', quantity: 1, unitPrice: 3000 }],
      issue: true,
    }).expect(201);

    await payInvoice(created.body.id, { amount: 3000 }).expect(201);

    // The tuition position is untouched: books money is not tuition money.
    expect(getStudentBalance(db, studentId).outstanding).toBe(10000);
    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(0);

    const rows = paymentsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('book');
    expect(rows[0].semester).toBeNull();
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a tuition invoice, paid in full, settles the term it names', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'tuition',
      semesterId,
      items: [{ description: 'Tuition — Term One', quantity: 1, unitPrice: 10000 }],
      issue: true,
    }).expect(201);

    await payInvoice(created.body.id, { amount: 10000 }).expect(201);

    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(10000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);

    const rows = paymentsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('fee');
    expect(rows[0].semester).toBe(SEMESTER);
  });

  it('a term paid through its invoice cannot be collected a second time at the desk', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'tuition',
      semesterId,
      items: [{ description: 'Tuition — Term One', quantity: 1, unitPrice: 10000 }],
      issue: true,
    }).expect(201);
    await payInvoice(created.body.id, { amount: 10000 }).expect(201);

    const second = await supertest(app)
      .post(`/api/students/${studentId}/payments`)
      .set(manager)
      .send({ category: 'fee', amount: 1, semesterId });

    expect(second.status).toBe(400);
    expect(String(second.body.error)).toMatch(/already fully paid/i);
  });
});

describe('WP-07 · an invoice declares what it bills', () => {
  it('an invoice with no declared purpose is refused', async () => {
    const res = await createInvoice({
      studentId,
      items: [{ description: 'Something', quantity: 1, unitPrice: 500 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/purpose/i);
  });

  it('an unrecognised purpose is refused, not defaulted', async () => {
    const res = await createInvoice({
      studentId,
      purpose: 'donation',
      items: [{ description: 'Something', quantity: 1, unitPrice: 500 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/purpose/i);
  });

  it('a tuition invoice that names no term is refused', async () => {
    const res = await createInvoice({
      studentId,
      purpose: 'tuition',
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 10000 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/term|semester|obligation/i);
  });

  it('a non-tuition invoice may not name a term', async () => {
    const res = await createInvoice({
      studentId,
      purpose: 'books',
      semesterId,
      items: [{ description: 'Textbooks', quantity: 1, unitPrice: 500 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/term|semester|obligation|tuition/i);
  });

  it('a tuition invoice cannot name another student\u2019s term', async () => {
    const other = `${key}_s2`;
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES (?, ?, 'Other', 'active', ?, ?, 'female', ?)`,
    ).run(other, `TH-O${key.slice(-5)}`, today(), branch, nextPhone());
    const otherSemester = `${key}_sem2`;
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, 'Other Term', ?, 5000, 5000, 'active')`,
    ).run(otherSemester, other, today());

    const res = await createInvoice({
      studentId,
      purpose: 'tuition',
      semesterId: otherSemester,
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 5000 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE student_id = ?').get(studentId)).toEqual({ c: 0 });
  });
});

describe('WP-07 · every invoice in the database has a purpose and at least one line', () => {
  it('the purpose column is NOT NULL and CHECK-constrained', () => {
    const columns = db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string; notnull: number }>;
    const purpose = columns.find((c) => c.name === 'purpose');
    expect(purpose, 'invoices.purpose must exist').toBeTruthy();
    expect(purpose?.notnull).toBe(1);

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'").get() as { sql: string }).sql;
    expect(sql).toMatch(/purpose[^,]*CHECK/i);
    for (const value of ['tuition', 'books', 'exam', 'other']) {
      expect(sql).toContain(`'${value}'`);
    }
  });

  it('the database refuses an invoice whose purpose it does not recognise', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, purpose)
           VALUES (?, ?, 100, 0, 100, 'issued', ?, ?, 'donation')`,
        )
        .run(`${key}_bad`, studentId, today(), branch),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('the database refuses a tuition invoice with no obligation, and a non-tuition invoice with one', () => {
    const obligationId = `${key}_obl`;
    db.prepare(
      `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
       VALUES (?, ?, ?, 'tuition', ?, 'open')`,
    ).run(obligationId, studentId, branch, semesterId);

    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, purpose)
           VALUES (?, ?, 100, 0, 100, 'issued', ?, ?, 'tuition')`,
        )
        .run(`${key}_bad2`, studentId, today(), branch),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, purpose, obligation_id)
           VALUES (?, ?, 100, 0, 100, 'issued', ?, ?, 'books', ?)`,
        )
        .run(`${key}_bad3`, studentId, today(), branch, obligationId),
    ).toThrow(/CHECK constraint failed/i);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK — the ways a purpose could be talked out of the system
// ═══════════════════════════════════════════════════════════════════════════

describe('WP-07 · ATTACK · a purpose cannot be forged, coerced or bypassed', () => {
  const attacks: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['case variant', 'Tuition'],
    ['array wrapping a valid purpose', ['tuition']],
    ['object', { purpose: 'tuition' }],
    ['boolean', true],
    ['number', 1],
    ['null', null],
    ['SQL fragment', "tuition' OR '1'='1"],
    ['prototype pollution key', '__proto__'],
  ];

  it.each(attacks)('rejects %s and writes no invoice', async (_label, purpose) => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE student_id = ?').get(studentId) as { c: number }).c;
    const res = await createInvoice({
      studentId,
      purpose,
      items: [{ description: 'Probe', quantity: 1, unitPrice: 500 }],
      issue: true,
    });
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE student_id = ?').get(studentId) as { c: number }).c).toBe(before);
  });

  it('a books invoice cannot be re-pointed at a tuition obligation after the fact', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'books',
      items: [{ description: 'Textbooks', quantity: 1, unitPrice: 3000 }],
      issue: true,
    }).expect(201);

    const obligationId = `${key}_obl2`;
    db.prepare(
      `INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id, status)
       VALUES (?, ?, ?, 'tuition', ?, 'open')`,
    ).run(obligationId, studentId, branch, semesterId);

    expect(() =>
      db.prepare('UPDATE invoices SET obligation_id = ? WHERE id = ?').run(obligationId, created.body.id),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('a tuition invoice cannot be laundered into another purpose while keeping its term', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'tuition',
      semesterId,
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 10000 }],
      issue: true,
    }).expect(201);

    expect(() => db.prepare("UPDATE invoices SET purpose = 'books' WHERE id = ?").run(created.body.id)).toThrow(
      /CHECK constraint failed/i,
    );
  });

  it('an invoice with no line items cannot take money', async () => {
    const bare = `${key}_bare`;
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, branch_id, purpose, invoice_number)
       VALUES (?, ?, 4000, 0, 4000, 'issued', ?, ?, 'other', ?)`,
    ).run(bare, studentId, today(), branch, `INV-BARE-${key.slice(-5)}`);

    const res = await payInvoice(bare, { amount: 4000 });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/line items/i);
    expect(paymentsOf()).toHaveLength(0);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });

  it('a partial payment on a books invoice never leaks into tuition', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'books',
      items: [{ description: 'Textbooks', quantity: 4, unitPrice: 1000 }],
      issue: true,
    }).expect(201);

    await payInvoice(created.body.id, { amount: 1500 }).expect(201);
    await payInvoice(created.body.id, { amount: 2500 }).expect(201);

    expect(getStudentBalance(db, studentId).outstanding).toBe(10000);
    expect(getStudentBalance(db, studentId).tuitionPaid).toBe(0);
    expect(paymentsOf().every((p) => p.category === 'book' && p.semester === null)).toBe(true);
  });

  it('an exam invoice settles no term even when the student has exactly one open term', async () => {
    const created = await createInvoice({
      studentId,
      purpose: 'exam',
      items: [{ description: 'Final exam fee', quantity: 1, unitPrice: 2000 }],
      issue: true,
    }).expect(201);
    await payInvoice(created.body.id, { amount: 2000 }).expect(201);

    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(0);
    expect(getStudentBalance(db, studentId).outstanding).toBe(10000);
    expect(paymentsOf()[0].category).toBe('exam');
  });

  it('WP07-F19 · two tuition invoices cannot together bill more than the term', async () => {
    const a = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition part 1', quantity: 1, unitPrice: 6000 }], issue: true,
    }).expect(201);

    // The second document would bring the claims on a 10,000 AFN term to
    // 12,000. Each invoice is individually within its own balance, so nothing
    // but the term itself can refuse this.
    const second = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition part 2', quantity: 1, unitPrice: 6000 }], issue: true,
    });
    expect(second.status).toBe(400);
    expect(String(second.body.error)).toMatch(/4000 AFN left to bill/i);

    // What the term really has left is billable, and no more.
    const b = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition part 2', quantity: 1, unitPrice: 4000 }], issue: true,
    }).expect(201);

    await payInvoice(a.body.id, { amount: 6000 }).expect(201);
    await payInvoice(b.body.id, { amount: 4000 }).expect(201);

    expect(getSemesterTuitionSettled(db, studentId, SEMESTER)).toBe(10000);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
    expect(getStudentBalance(db, studentId).creditBalance).toBe(0);
  });

  it('WP07-F19 · a term already settled in cash cannot be billed again', async () => {
    await supertest(app)
      .post(`/api/students/${studentId}/payments`)
      .set(manager)
      .send({ category: 'fee', amount: 10000, semesterId })
      .expect(201);

    const res = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 1000 }], issue: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/already fully billed or settled/i);
  });

  it('WP07-F19 · cancelling a tuition invoice returns the term\u2019s billing capacity', async () => {
    const a = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 10000 }], issue: true,
    }).expect(201);

    expect(
      (await createInvoice({
        studentId, purpose: 'tuition', semesterId,
        items: [{ description: 'Tuition again', quantity: 1, unitPrice: 1 }], issue: true,
      })).status,
    ).toBe(400);

    await supertest(app).post(`/api/invoices/${a.body.id}/cancel`).set(manager).send({}).expect(200);

    await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition reissued', quantity: 1, unitPrice: 10000 }], issue: true,
    }).expect(201);
  });

  it('the money the ledger recognises equals the money the payments record', async () => {
    const books = await createInvoice({
      studentId, purpose: 'books',
      items: [{ description: 'Textbooks', quantity: 1, unitPrice: 3000 }], issue: true,
    }).expect(201);
    const tuition = await createInvoice({
      studentId, purpose: 'tuition', semesterId,
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 10000 }], issue: true,
    }).expect(201);
    await payInvoice(books.body.id, { amount: 3000 }).expect(201);
    await payInvoice(tuition.body.id, { amount: 10000 }).expect(201);

    const paid = paymentsOf().reduce((sum, p) => sum + p.amount, 0);
    const recognised = Number(
      (db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS t FROM financial_transactions
            WHERE type = 'income' AND branch_id = ? AND category IN ('fee','book','exam','other')`,
        )
        .get(branch) as { t: number }).t,
    );
    expect(recognised).toBe(paid);
    expect(computeReconciliation({ branchId: branch, isAll: false }).healthy).toBe(true);
  });
});
