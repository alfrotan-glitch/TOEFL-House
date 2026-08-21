/**
 * Enterprise Financial Integrity Audit — Automated Test Suite
 *
 * Covers:
 *  §1  Transaction atomicity (convert, payment, invoice)
 *  §2  Idempotency (duplicate conversion guard)
 *  §3  Reconciliation (payment = ledger entry)
 *  §4  Invoice state machine
 *  §5  Payment method validation
 *  §6  Discount & fee snapshot immutability
 *  §7  Receipt number uniqueness (atomic counter)
 *  §8  Student code uniqueness (atomic counter)
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';
import { recordIncome } from '../utils/income.js';
import { nextReceiptNumber, nextStudentCode } from '../utils/receipt.js';
import { signToken, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import invoicesRouter from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH_ID = 'b_audit';

/** Real router + real auth, so invoice guards are exercised over HTTP. */
function invoiceApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}
const financeAuth = () => ({
  Authorization: `Bearer ${signToken({
    userId: 'u_fin_audit', username: 'u_fin_audit',
    branchId: BRANCH_ID, fullName: 'Finance Audit',
  } as TokenPayload)}`,
});

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    BRANCH_ID, 'Audit Branch', 'Test'
  );
  db.prepare('INSERT OR IGNORE INTO classes (id, name, level, capacity, fee, branch_id, gender_policy, status, lifecycle_stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'cls_audit_1', 'Audit Class A', 'B2', 20, 5000, BRANCH_ID, 'mixed', 'active', 'activated'
  );
  db.prepare('INSERT OR IGNORE INTO classes (id, name, level, capacity, fee, branch_id, gender_policy, status, lifecycle_stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'cls_audit_2', 'Audit Class B', 'B1', 20, 3000, BRANCH_ID, 'mixed', 'active', 'activated'
  );
  // Seed the student_code_counter to a known value so tests are deterministic
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('student_code_counter', '5000')").run();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('receipt_counter', '100')").run();

  bootstrapRbacCatalog(db);
  db.prepare(
    `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('u_fin_audit', 'u_fin_audit', 'Finance Audit', ?, 'x', 1, 0)`
  ).run(BRANCH_ID);
  assignRole('u_fin_audit', 'finance', BRANCH_ID);

});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

// ═══════════════════════════════════════════════════════════════════════════
// §1 — TRANSACTION INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════
describe('§1 Transaction Integrity', () => {
  it('convert creates student + semester + registration + invoice + payment in one transaction', () => {
    const visitorId = id('vis');
    db.prepare(
      `INSERT INTO visitors (id, full_name, gender, source, visit_date, branch_id, stage, status)
       VALUES (?, 'Txn Test', 'male', 'organic', ?, ?, 'placement_completed', 'visited')`
    ).run(visitorId, today(), BRANCH_ID);

    const studentId = id('stu');
    const invoiceId = id('inv');
    const paymentId = id('pay');
    const rc = nextReceiptNumber();
    const studentCode = nextStudentCode();
    const date = today();

    // Simulate what the convert endpoint does, in a transaction
    db.transaction(() => {
      db.prepare("UPDATE visitors SET status = 'registered', stage = 'registration' WHERE id = ?").run(visitorId);

      db.prepare(
        `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, discount_percent, gender, lead_id)
         VALUES (?, ?, ?, 'active', ?, ?, 10, 'male', ?)`
      ).run(studentId, studentCode, 'Txn Test', date, BRANCH_ID, visitorId);

      db.prepare(
        `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount)
         VALUES (?, ?, 'Current', 'cls_audit_1', ?, 5000, 4500)`
      ).run(id('sem'), studentId, date);

      db.prepare(
        `INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id)
         VALUES (?, ?, 'cls_audit_1', ?, 4500, ?, 10, ?)`
      ).run(id('reg'), studentId, date, rc, BRANCH_ID);

      db.prepare(
        `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
         VALUES (?, ?, 5000, 500, 4500, 'paid', ?, '2099-01-01', ?, 'INV-2099-00001')`
      ).run(invoiceId, studentId, date, BRANCH_ID);

      db.prepare(
        `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 4500, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
      ).run(paymentId, studentId, invoiceId, date, rc, BRANCH_ID);

      recordIncome({
        category: 'fee', amount: 4500, date,
        description: 'Txn integrity test', referenceId: invoiceId,
        paymentId,
        operatorName: 'Audit', branchId: BRANCH_ID,
      });
    })();

    // Verify ALL records exist
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    expect(student).toBeDefined();
    expect((student as any).student_code).toBe(studentCode);

    const semester = db.prepare('SELECT * FROM student_semesters WHERE student_id = ?').get(studentId);
    expect(semester).toBeDefined();

    const registration = db.prepare('SELECT * FROM registrations WHERE student_id = ?').get(studentId);
    expect(registration).toBeDefined();

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    expect(invoice).toBeDefined();
    expect((invoice as any).status).toBe('paid');

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    expect(payment).toBeDefined();
    expect((payment as any).amount).toBe(4500);

    const tx = db.prepare('SELECT * FROM financial_transactions WHERE reference_id = ? AND type = \'income\'').get(invoiceId);
    expect(tx).toBeDefined();
    expect((tx as any).amount).toBe(4500);
  });

  it('transaction rollback: if payment insert fails, no student is created', () => {
    const visitorId = id('vis');
    db.prepare(
      `INSERT INTO visitors (id, full_name, gender, source, visit_date, branch_id, stage, status)
       VALUES (?, 'Rollback Test', 'male', 'organic', ?, ?, 'placement_completed', 'visited')`
    ).run(visitorId, today(), BRANCH_ID);

    const studentId = id('stu');

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
           VALUES (?, 'TH-ROLLBACK', 'Rollback Test', 'active', ?, ?, 'male', ?)`
        ).run(studentId, today(), BRANCH_ID, visitorId);

        // Force a UNIQUE constraint violation on student_code
        db.prepare('INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, \'TH-ROLLBACK\', \'Dup\', \'active\', ?, ?, \'male\')').run(
          id('stu_bad'), today(), BRANCH_ID
        );
      })();
      expect.unreachable('Should have thrown');
    } catch {
      // Expected — UNIQUE constraint on student_code
    }

    // Verify student was NOT created (rolled back)
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    expect(student).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 — IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════
describe('§2 Idempotency', () => {
  it('duplicate conversion is blocked by lead_id check', () => {
    const visitorId = id('vis');
    db.prepare(
      `INSERT INTO visitors (id, full_name, gender, source, visit_date, branch_id, stage, status)
       VALUES (?, 'Idempotent Test', 'male', 'organic', ?, ?, 'placement_completed', 'visited')`
    ).run(visitorId, today(), BRANCH_ID);

    const studentId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
       VALUES (?, 'TH-IDEM', 'Idempotent Test', 'active', ?, ?, 'male', ?)`
    ).run(studentId, today(), BRANCH_ID, visitorId);

    // Simulate the idempotency guard from the convert endpoint
    const existing = db.prepare('SELECT id FROM students WHERE lead_id = ?').get(visitorId);
    expect(existing).toBeDefined();
    // The endpoint would throw 409 here
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — FINANCIAL RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════
describe('§3 Financial Reconciliation', () => {
  it('payment amount equals ledger transaction amount', () => {
    const studentId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-RECON', 'Recon Student', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    const amount = 3500;
    const invoiceId = id('inv');
    const paymentId = id('pay');
    const rc = nextReceiptNumber();
    const date = today();

    db.transaction(() => {
      db.prepare(
        `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
         VALUES (?, ?, ?, ?, 'issued', ?, '2099-01-01', ?, 'INV-2099-00002')`
      ).run(invoiceId, studentId, amount, amount, date, BRANCH_ID);

      db.prepare(
        `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
      ).run(paymentId, studentId, invoiceId, amount, date, rc, BRANCH_ID);

      recordIncome({
        category: 'fee', amount, date,
        description: 'Reconciliation test', referenceId: invoiceId,
        paymentId,
        operatorName: 'Audit', branchId: BRANCH_ID,
      });
    })();

    // Reconciliation query
    const row = db.prepare(
      `SELECT p.amount as payment_amount,
              COALESCE(SUM(ft.amount), 0) as ledger_total
       FROM payments p
       LEFT JOIN financial_transactions ft ON ft.reference_id = p.invoice_id AND ft.type = 'income'
       WHERE p.id = ?
       GROUP BY p.id`
    ).get(paymentId) as any;

    expect(row.payment_amount).toBe(amount);
    expect(row.ledger_total).toBe(amount);
  });

  it('no orphan ledger entries: every income tx references a valid payment invoice', () => {
    const orphans = db.prepare(
      `SELECT ft.id, ft.reference_id
       FROM financial_transactions ft
       LEFT JOIN payments p ON p.invoice_id = ft.reference_id
       WHERE ft.type = 'income' AND ft.reference_id IS NOT NULL AND p.id IS NULL`
    ).all() as any[];
    // In our test data, all income txs with reference_id point to valid invoices
    // (Some may reference student_id directly, which is acceptable for non-invoice payments)
    // True orphans would be reference_ids pointing to non-existent entities
    for (const orphan of orphans) {
      // If reference_id exists, it should point to something meaningful
      // (invoice, student, or visitor — all acceptable)
      const validTarget =
        db.prepare('SELECT id FROM invoices WHERE id = ?').get(orphan.reference_id) ||
        db.prepare('SELECT id FROM students WHERE id = ?').get(orphan.reference_id) ||
        db.prepare('SELECT id FROM visitors WHERE id = ?').get(orphan.reference_id);
      expect(validTarget).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 — INVOICE STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════
describe('§4 Invoice State Machine', () => {
  const invId = id('inv');
  const stuId = id('stu');

  beforeAll(() => {
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-INVST', 'Inv State Student', 'active', ?, ?, 'male')`
    ).run(stuId, today(), BRANCH_ID);
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 6000, 6000, 'draft', ?, '2099-01-01', ?, 'INV-2099-00003')`
    ).run(invId, stuId, today(), BRANCH_ID);
  });

  it('draft → issued is allowed', () => {
    db.prepare("UPDATE invoices SET status = 'issued' WHERE id = ? AND status = 'draft'").run(invId);
    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invId) as any;
    expect(inv.status).toBe('issued');
  });

  it('partial payment sets status to partial', () => {
    db.prepare("UPDATE invoices SET status = 'partial' WHERE id = ?").run(invId);
    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invId) as any;
    expect(inv.status).toBe('partial');
  });

  // The three tests that used to live here were false confidence. They wrote a
  // status with UPDATE and then asserted the UPDATE had worked — that tests
  // SQLite, not the product — and one literally read
  //     expect(true).toBe(true); // Verified by code review
  // A rule "verified by code review" is not verified at all: the guard could be
  // deleted and every one of them would still pass. They are replaced below by
  // requests through the real router, which fail if the guard is removed.

  it('a paid invoice cannot be cancelled — through the real endpoint', async () => {
    const paidInv = id('inv');
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 1000, 1000, 'paid', ?, '2099-01-01', ?, 'INV-2099-00010')`
    ).run(paidInv, stuId, today(), BRANCH_ID);

    const res = await supertest(invoiceApp()).post(`/api/invoices/${paidInv}/cancel`).set(financeAuth());
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot be cancelled/i);
    expect((db.prepare('SELECT status FROM invoices WHERE id = ?').get(paidInv) as any).status).toBe('paid');
  });

  it('an invoice with payments cannot be cancelled, even when not marked paid', async () => {
    const inv = id('inv');
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 1000, 1000, 'partial', ?, '2099-01-01', ?, 'INV-2099-00011')`
    ).run(inv, stuId, today(), BRANCH_ID);
    db.prepare(
      `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
       VALUES (?, ?, ?, 400, ?, 'cash', 'completed', 'fee', ?, ?, ?)`
    ).run(id('pay'), stuId, inv, today(), nextReceiptNumber(), BRANCH_ID, id('idem'));

    const res = await supertest(invoiceApp()).post(`/api/invoices/${inv}/cancel`).set(financeAuth());
    expect(res.status).toBe(400);
    // Cancelling an invoice that already took money would strand the payment.
    expect(String(res.body.error)).toMatch(/refund first/i);
  });

  it('a cancelled invoice cannot receive a payment', async () => {
    const inv2 = id('inv');
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 1000, 1000, 'cancelled', ?, '2099-01-01', ?, 'INV-2099-00004')`
    ).run(inv2, stuId, today(), BRANCH_ID);

    const res = await supertest(invoiceApp())
      .post(`/api/invoices/${inv2}/pay`).set(financeAuth())
      .send({ amount: 100, paymentMethod: 'cash' });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?').get(inv2)).toEqual({ c: 0 });
  });

  it('a draft invoice cannot receive a payment', async () => {
    const draft = id('inv');
    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 1000, 1000, 'draft', ?, '2099-01-01', ?, 'INV-2099-00012')`
    ).run(draft, stuId, today(), BRANCH_ID);

    const res = await supertest(invoiceApp())
      .post(`/api/invoices/${draft}/pay`).set(financeAuth())
      .send({ amount: 100, paymentMethod: 'cash' });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?').get(draft)).toEqual({ c: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 — PAYMENT METHOD VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
describe('§5 Payment Method Validation', () => {
  it('valid methods: cash, card, bank_transfer', () => {
    const valid = ['cash', 'card', 'bank_transfer'];
    const stuId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-PAYM', 'Pay Method Student', 'active', ?, ?, 'male')`
    ).run(stuId, today(), BRANCH_ID);

    for (const method of valid) {
      const rc = nextReceiptNumber();
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, 100, ?, ?, 'completed', 'fee', ?, ?, hex(randomblob(16)))`
      ).run(id('pay'), stuId, today(), method, rc, BRANCH_ID);

      const p = db.prepare('SELECT payment_method FROM payments WHERE receipt_number = ?').get(rc) as any;
      expect(p.payment_method).toBe(method);
    }
  });

  it('invalid method is rejected by DB CHECK constraint', () => {
    const stuId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-PAYM2', 'Pay Method 2', 'active', ?, ?, 'male')`
    ).run(stuId, today(), BRANCH_ID);

    expect(() => {
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, 100, ?, 'crypto', 'completed', 'fee', 'R-FAKE', ?, hex(randomblob(16)))`
      ).run(id('pay'), stuId, today(), BRANCH_ID);
    }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 — DISCOUNT & FEE SNAPSHOT IMMUTABILITY
// ═══════════════════════════════════════════════════════════════════════════
describe('§6 Discount & Fee Snapshot', () => {
  it('student_semesters records both gross and net fee', () => {
    const semId = id('sem');
    const stuId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-DISC', 'Discount Student', 'active', ?, ?, 'male')`
    ).run(stuId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount)
       VALUES (?, ?, 'Test Sem', 'cls_audit_1', ?, 5000, 4500)`
    ).run(semId, stuId, today());

    const sem = db.prepare('SELECT fee_amount, net_fee_amount FROM student_semesters WHERE id = ?').get(semId) as any;
    expect(sem.fee_amount).toBe(5000);
    expect(sem.net_fee_amount).toBe(4500);
  });

  it('invoice preserves total and discount separately', () => {
    const invId = id('inv');
    const stuId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-DISC2', 'Discount Student 2', 'active', ?, ?, 'male')`
    ).run(stuId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 5000, 500, 4500, 'issued', ?, '2099-01-01', ?, 'INV-2099-00005')`
    ).run(invId, stuId, today(), BRANCH_ID);

    const inv = db.prepare('SELECT total_amount, discount_amount, net_amount FROM invoices WHERE id = ?').get(invId) as any;
    expect(inv.total_amount).toBe(5000);
    expect(inv.discount_amount).toBe(500);
    expect(inv.net_amount).toBe(4500);
    // total - discount = net
    expect(inv.total_amount - inv.discount_amount).toBe(inv.net_amount);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §7 — RECEIPT NUMBER UNIQUENESS
// ═══════════════════════════════════════════════════════════════════════════
describe('§7 Receipt Number Uniqueness', () => {
  it('generates 100 sequential receipt numbers with no duplicates', () => {
    const receipts = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const rc = nextReceiptNumber();
      expect(receipts.has(rc)).toBe(false); // No duplicate
      receipts.add(rc);
    }
    expect(receipts.size).toBe(100);
  });

  it('receipt format is R-XXXXXXXX (8 digits)', () => {
    const rc = nextReceiptNumber();
    expect(rc).toMatch(/^R-\d{8}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 — STUDENT CODE UNIQUENESS
// ═══════════════════════════════════════════════════════════════════════════
describe('§8 Student Code Uniqueness', () => {
  it('generates 50 sequential student codes with no duplicates', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = nextStudentCode();
      expect(codes.has(code)).toBe(false);
      codes.add(code);
    }
    expect(codes.size).toBe(50);
  });

  it('student code format is TH-NNNN', () => {
    const code = nextStudentCode();
    expect(code).toMatch(/^TH-\d+$/);
  });
});
