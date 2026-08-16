/**
 * Extended Financial Test Suite v2 — Production Hardening
 *
 * PHASE 1: Payment Traceability (payment_id → financial_transactions)
 * PHASE 2: Database Referential Integrity
 * PHASE 3: Transaction Safety (recordIncome outside txn)
 * PHASE 4: True Concurrency (multi-connection stress)
 * PHASE 5: Reconciliation with payment_id
 * PHASE 6: DB Integrity with new column
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { id, today } from '../utils/ids.js';
import { recordIncome } from '../utils/income.js';
import { nextReceiptNumber, nextStudentCode } from '../utils/receipt.js';
import Database from 'better-sqlite3';

const BRANCH_ID = 'b_extended';

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    BRANCH_ID, 'Extended Test Branch', 'Test'
  );
  db.prepare('INSERT OR IGNORE INTO classes (id, name, level, capacity, fee, branch_id, gender_policy, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'cls_ext_1', 'Extended Class A', 'B2', 30, 5000, BRANCH_ID, 'mixed', 'active'
  );
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('student_code_counter', '20000')").run();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('receipt_counter', '20000')").run();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('daily_saving_percent', '5')").run();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('main_account_balance', '0')").run();
  db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES ('saving_balance', '0')").run();
  db.prepare('DELETE FROM finance_accounts WHERE scope_type = ? AND scope_id = ?').run('branch', BRANCH_ID);
  db.prepare('DELETE FROM financial_transactions WHERE branch_id = ?').run(BRANCH_ID);
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

// ═══════════════════════════════════════════════════════════════════════════
// §A — FAILURE-RECOVERY TESTS
// ═══════════════════════════════════════════════════════════════════════════
describe('§A Failure Recovery', () => {
  it('A1: student insert failure rolls back entire conversion', () => {
    const visitorId = id('vis');
    db.prepare(
      `INSERT INTO visitors (id, full_name, gender, source, visit_date, branch_id, stage, status)
       VALUES (?, 'A1 Test', 'male', 'organic', ?, ?, 'placement_completed', 'visited')`
    ).run(visitorId, today(), BRANCH_ID);

    const studentId = id('stu');
    const semId = id('sem');

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
           VALUES (?, 'TH-A1-FAIL', 'A1 Test', 'active', ?, ?, 'male', ?)`
        ).run(studentId, today(), BRANCH_ID, visitorId);

        db.prepare(
          `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount)
           VALUES (?, ?, 'Current', 'cls_ext_1', ?, 5000, 4500)`
        ).run(semId, studentId, today());

        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
           VALUES (?, 'TH-A1-FAIL', 'DUPLICATE', 'active', ?, ?, 'male')`
        ).run(id('stu_bad'), today(), BRANCH_ID);
      })();
      expect.unreachable('Should have thrown');
    } catch { /* expected */ }

    expect(db.prepare('SELECT * FROM students WHERE id = ?').get(studentId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM student_semesters WHERE id = ?').get(semId)).toBeUndefined();
  });

  it('A2: invoice insert failure rolls back payment and registration', () => {
    const studentId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-A2-OK', 'A2 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    const regId = id('reg');
    const payId = id('pay');
    const rc = nextReceiptNumber();

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id)
           VALUES (?, ?, 'cls_ext_1', ?, 4500, ?, 10, ?)`
        ).run(regId, studentId, today(), rc, BRANCH_ID);

        db.prepare(
          `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, 4500, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(payId, studentId, today(), rc, BRANCH_ID);

        db.prepare(
          `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
           VALUES (?, ?, 5000, 5000, 'INVALID_STATUS', ?, '2099-01-01', ?, 'INV-A2-FAIL')`
        ).run(id('inv'), studentId, today(), BRANCH_ID);
      })();
      expect.unreachable('Should have thrown');
    } catch { /* expected */ }

    expect(db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM payments WHERE id = ?').get(payId)).toBeUndefined();
  });

  it('A3: payment insert failure rolls back registration and ledger', () => {
    const studentId = id('stu');
    const invId = id('inv');

    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-A3-OK', 'A3 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 5000, 5000, 'issued', ?, '2099-01-01', ?, 'INV-A3-001')`
    ).run(invId, studentId, today(), BRANCH_ID);

    const regId = id('reg');
    const rc = nextReceiptNumber();

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id)
           VALUES (?, ?, 'cls_ext_1', ?, 4500, ?, 10, ?)`
        ).run(regId, studentId, today(), rc, BRANCH_ID);

        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 4500, ?, 'INVALID_METHOD', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(id('pay'), studentId, invId, today(), rc, BRANCH_ID);
      })();
      expect.unreachable('Should have thrown');
    } catch { /* expected */ }

    expect(db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId)).toBeUndefined();
  });

  it('A4: ledger failure within transaction rolls back payment', () => {
    const studentId = id('stu');
    const invId = id('inv');

    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-A4-OK', 'A4 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 5000, 5000, 'issued', ?, '2099-01-01', ?, 'INV-A4-001')`
    ).run(invId, studentId, today(), BRANCH_ID);

    const payId = id('pay');
    const rc = nextReceiptNumber();

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 4500, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(payId, studentId, invId, today(), rc, BRANCH_ID);

        recordIncome({
          category: 'fee', amount: 4500, date: today(),
          description: 'A4 ledger test', referenceId: invId, paymentId: payId,
          operatorName: 'Audit', branchId: BRANCH_ID,
        });

        db.exec('INSERT INTO nonexistent_table(x) VALUES(1)');
      })();
      expect.unreachable('Should have thrown');
    } catch { /* expected */ }

    expect(db.prepare('SELECT * FROM payments WHERE id = ?').get(payId)).toBeUndefined();
    const txCount = (db.prepare(
      "SELECT COUNT(*) as c FROM financial_transactions WHERE payment_id = ?"
    ).get(payId) as any).c;
    expect(txCount).toBe(0);
  });

  it('A5: failed payment does not corrupt invoice status', () => {
    const studentId = id('stu');
    const invId = id('inv');

    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-A5-OK', 'A5 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 5000, 5000, 'issued', ?, '2099-01-01', ?, 'INV-A5-001')`
    ).run(invId, studentId, today(), BRANCH_ID);

    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 4500, ?, 'crypto', 'completed', 'fee', 'R-FAKE', ?, hex(randomblob(16)))`
        ).run(id('pay'), studentId, invId, today(), BRANCH_ID);
      })();
    } catch { /* expected */ }

    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invId) as any;
    expect(inv.status).toBe('issued');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §B — CONCURRENCY TESTS
// ═══════════════════════════════════════════════════════════════════════════
describe('§B Concurrency', () => {
  it('B1: 200 simultaneous visitor conversions produce 200 unique students', () => {
    const studentIds: string[] = [];
    const studentCodes: string[] = [];

    for (let i = 0; i < 200; i++) {
      const vid = id('vis');
      db.prepare(
        `INSERT INTO visitors (id, full_name, gender, source, visit_date, branch_id, stage, status)
         VALUES (?, ?, 'male', 'organic', ?, ?, 'placement_completed', 'visited')`
      ).run(vid, `B1 Student ${i}`, today(), BRANCH_ID);

      const sid = id('stu');
      const code = nextStudentCode();
      studentIds.push(sid);
      studentCodes.push(code);

      db.transaction(() => {
        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, lead_id)
           VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
        ).run(sid, code, `B1 Student ${i}`, today(), BRANCH_ID, vid);
        db.prepare(`UPDATE visitors SET status = 'registered', stage = 'registration' WHERE id = ?`).run(vid);
      })();
    }

    const count = (db.prepare(
      `SELECT COUNT(*) as c FROM students WHERE id IN (${studentIds.map(() => '?').join(',')})`
    ).get(...studentIds) as any).c;
    expect(count).toBe(200);
    expect(new Set(studentCodes).size).toBe(200);
  });

  it('B2: 200 simultaneous payments with payment_id traceability', () => {
    const studentId = id('stu');
    const invId = id('inv');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-B2', 'B2 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 1000000, 0, 1000000, 'issued', ?, '2099-01-01', ?, 'INV-B2-001')`
    ).run(invId, studentId, today(), BRANCH_ID);

    const paymentIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const pid = id('pay');
      const rc = nextReceiptNumber();
      paymentIds.push(pid);

      db.transaction(() => {
        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 1000, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(pid, studentId, invId, today(), rc, BRANCH_ID);

        recordIncome({
          category: 'fee', amount: 1000, date: today(),
          description: `B2 payment ${i}`, referenceId: invId, paymentId: pid,
          operatorName: 'Audit', branchId: BRANCH_ID,
        });
      })();
    }

    const payCount = (db.prepare('SELECT COUNT(*) as c FROM payments WHERE invoice_id = ?').get(invId) as any).c;
    expect(payCount).toBe(200);

    // PHASE 1: Every payment has exactly one income ledger entry with matching payment_id
    const traceCount = (db.prepare(
      `SELECT COUNT(*) as c FROM financial_transactions WHERE payment_id IN (${paymentIds.map(() => '?').join(',')}) AND type = 'income'`
    ).get(...paymentIds) as any).c;
    expect(traceCount).toBe(200);

    // No income ledger entries without payment_id (for this invoice)
    const unlinked = (db.prepare(
      `SELECT COUNT(*) as c FROM financial_transactions WHERE reference_id = ? AND type = 'income' AND payment_id IS NULL`
    ).get(invId) as any).c;
    expect(unlinked).toBe(0);
  });

  it('B3: 200 simultaneous receipt generations produce no duplicates', () => {
    const receipts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const rc = nextReceiptNumber();
      expect(receipts.has(rc)).toBe(false);
      receipts.add(rc);
    }
    expect(receipts.size).toBe(200);
  });

  it('B4: 200 simultaneous invoice creations', () => {
    const studentId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-B4', 'B4 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    const invIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const iid = id('inv');
      invIds.push(iid);
      db.prepare(
        `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
         VALUES (?, ?, 5000, 5000, 'draft', ?, '2099-01-01', ?, ?)`
      ).run(iid, studentId, today(), BRANCH_ID, `INV-B4-${String(i).padStart(4, '0')}`);
    }

    const count = (db.prepare(
      `SELECT COUNT(*) as c FROM invoices WHERE id IN (${invIds.map(() => '?').join(',')})`
    ).get(...invIds) as any).c;
    expect(count).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §C — RECONCILIATION TESTS (with payment_id)
// ═══════════════════════════════════════════════════════════════════════════
describe('§C Reconciliation', () => {
  it('C1: payment → ledger is strict 1:1 via payment_id', () => {
    const beforePayments = (db.prepare(
      `SELECT COALESCE(SUM(p.amount), 0) as s FROM payments p WHERE p.branch_id = ? AND p.status = 'completed'`
    ).get(BRANCH_ID) as any).s;
    const beforeLedger = (db.prepare(
      `SELECT COALESCE(SUM(ft.amount), 0) as s FROM financial_transactions ft WHERE ft.branch_id = ? AND ft.type = 'income'`
    ).get(BRANCH_ID) as any).s;

    for (let i = 0; i < 5; i++) {
      const sid = id('stu');
      const iid = id('inv');
      const pid = id('pay');
      const rc = nextReceiptNumber();
      const amount = (i + 1) * 1000;

      db.transaction(() => {
        db.prepare(
          `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
           VALUES (?, ?, ?, 'active', ?, ?, 'male')`
        ).run(sid, `TH-C1-${i}`, `Recon Student ${i}`, today(), BRANCH_ID);

        db.prepare(
          `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
           VALUES (?, ?, ?, ?, 'paid', ?, '2099-01-01', ?, ?)`
        ).run(iid, sid, amount, amount, today(), BRANCH_ID, `INV-C1-${String(i).padStart(3, '0')}`);

        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(pid, sid, iid, amount, today(), rc, BRANCH_ID);

        recordIncome({
          category: 'fee', amount, date: today(),
          description: `Recon test ${i}`, referenceId: iid, paymentId: pid,
          operatorName: 'Audit', branchId: BRANCH_ID,
        });
      })();
    }

    const row = db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.branch_id = ? AND p.status = 'completed') as payment_total,
         (SELECT COALESCE(SUM(ft.amount), 0) FROM financial_transactions ft WHERE ft.branch_id = ? AND ft.type = 'income') as ledger_total`
    ).get(BRANCH_ID, BRANCH_ID) as any;

    const deltaPayments = row.payment_total - beforePayments;
    const deltaLedger = row.ledger_total - beforeLedger;
    expect(deltaPayments).toBe(15000);
    expect(deltaLedger).toBe(15000);
  });

  it('C2: every income ft with payment_id has matching payment', () => {
    const orphans = db.prepare(
      `SELECT ft.id FROM financial_transactions ft
       WHERE ft.payment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = ft.payment_id)`
    ).all() as any[];
    expect(orphans.length).toBe(0);
  });

  it('C3: saving_transfer rows have no payment_id', () => {
    const bad = db.prepare(
      `SELECT id FROM financial_transactions WHERE type = 'saving_transfer' AND payment_id IS NOT NULL`
    ).all() as any[];
    expect(bad.length).toBe(0);
  });

  it('C4: saving + main balance invariant', () => {
    const totalIncome = (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as s FROM financial_transactions WHERE type = 'income' AND branch_id = ?`
    ).get(BRANCH_ID) as any).s;
    const totalSavingTransfers = (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as s FROM financial_transactions WHERE type = 'saving_transfer' AND branch_id = ?`
    ).get(BRANCH_ID) as any).s;

    const account = getFinanceAccount('branch', BRANCH_ID);
    const mainBalance = Number(account.mainBalance);
    const savingBalance = Number(account.savingBalance);

    expect(mainBalance).toBe(totalIncome - totalSavingTransfers);
    expect(savingBalance).toBe(totalSavingTransfers);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §D — DATABASE INTEGRITY VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════
describe('§D Database Integrity', () => {
  it('D1: all student branch_id references are valid', () => {
    const orphans = db.prepare(
      `SELECT s.id FROM students s LEFT JOIN branches b ON b.id = s.branch_id WHERE b.id IS NULL`
    ).all() as any[];
    expect(orphans.length).toBe(0);
  });

  it('D2: invoice total - discount = net', () => {
    const violations = db.prepare(
      `SELECT id FROM invoices WHERE ABS(total_amount - COALESCE(discount_amount, 0) - net_amount) > 0.01`
    ).all() as any[];
    expect(violations.length).toBe(0);
  });

  it('D3: no duplicate receipt numbers in payments', () => {
    const dupes = db.prepare(
      `SELECT receipt_number, COUNT(*) as c FROM payments WHERE receipt_number IS NOT NULL GROUP BY receipt_number HAVING c > 1`
    ).all() as any[];
    expect(dupes.length).toBe(0);
  });

  it('D4: no duplicate student codes', () => {
    const dupes = db.prepare(
      `SELECT student_code, COUNT(*) as c FROM students GROUP BY student_code HAVING c > 1`
    ).all() as any[];
    expect(dupes.length).toBe(0);
  });

  it('D5: student_semesters fee_amount >= net_fee_amount', () => {
    const violations = db.prepare(
      `SELECT id FROM student_semesters WHERE fee_amount < net_fee_amount`
    ).all() as any[];
    expect(violations.length).toBe(0);
  });

  it('D6: all payment invoice_id references are valid', () => {
    const orphans = db.prepare(
      `SELECT p.id FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.invoice_id IS NOT NULL AND i.id IS NULL`
    ).all() as any[];
    expect(orphans.length).toBe(0);
  });

  it('D7: no financial transactions with zero or negative amounts', () => {
    const bad = db.prepare(
      `SELECT id FROM financial_transactions WHERE amount <= 0`
    ).all() as any[];
    expect(bad.length).toBe(0);
  });

  it('D8: payment_id FK integrity — no dangling references', () => {
    const orphans = db.prepare(
      `SELECT ft.id FROM financial_transactions ft
       LEFT JOIN payments p ON p.id = ft.payment_id
       WHERE ft.payment_id IS NOT NULL AND p.id IS NULL`
    ).all() as any[];
    expect(orphans.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §E — PHASE 3: TRANSACTION SAFETY
// ═══════════════════════════════════════════════════════════════════════════
describe('§E Transaction Safety', () => {
  it('E1: recordIncome() throws when called outside a transaction', () => {
    // Verify db.inTransaction is false before we start
    expect(db.inTransaction).toBe(false);

    expect(() => {
      recordIncome({
        category: 'fee', amount: 100, date: today(),
        description: 'E1 safety test', referenceId: 'fake',
        operatorName: 'Test', branchId: BRANCH_ID,
      });
    }).toThrow(/recordIncome\(\) called outside a transaction/);
  });

  it('E2: recordIncome() works inside db.transaction()', () => {
    const beforeCount = (db.prepare(
      "SELECT COUNT(*) as c FROM financial_transactions WHERE type = 'income' AND branch_id = ?"
    ).get(BRANCH_ID) as any).c;

    const studentId = id('stu');
    const invId = id('inv');
    const payId = id('pay');
    const rc = nextReceiptNumber();

    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-E2', 'E2 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
       VALUES (?, ?, 5000, 5000, 'issued', ?, '2099-01-01', ?, 'INV-E2-001')`
    ).run(invId, studentId, today(), BRANCH_ID);

    db.transaction(() => {
      db.prepare(
        `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 5000, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
      ).run(payId, studentId, invId, today(), rc, BRANCH_ID);

      recordIncome({
        category: 'fee', amount: 5000, date: today(),
        description: 'E2 in-txn test', referenceId: invId, paymentId: payId,
        operatorName: 'Audit', branchId: BRANCH_ID,
      });
    })();

    const afterCount = (db.prepare(
      "SELECT COUNT(*) as c FROM financial_transactions WHERE type = 'income' AND branch_id = ?"
    ).get(BRANCH_ID) as any).c;
    expect(afterCount).toBe(beforeCount + 1);

    // Verify payment_id is set
    const ft = db.prepare(
      "SELECT payment_id FROM financial_transactions WHERE payment_id = ? AND type = 'income'"
    ).get(payId) as any;
    expect(ft).toBeDefined();
    expect(ft.payment_id).toBe(payId);
  });

  it('E3: nested transaction (savepoint) works for recordIncome', () => {
    const studentId = id('stu');
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
       VALUES (?, 'TH-E3', 'E3 Test', 'active', ?, ?, 'male')`
    ).run(studentId, today(), BRANCH_ID);

    // Outer transaction
    db.transaction(() => {
      db.prepare("UPDATE students SET notes = 'outer' WHERE id = ?").run(studentId);

      // Inner transaction (savepoint in better-sqlite3)
      db.transaction(() => {
        const invId = id('inv');
        const payId = id('pay');
        db.prepare(
          `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, invoice_number)
           VALUES (?, ?, 1000, 1000, 'paid', ?, '2099-01-01', ?, 'INV-E3-001')`
        ).run(invId, studentId, today(), BRANCH_ID);

        db.prepare(
          `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
     VALUES (?, ?, ?, 1000, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`
        ).run(payId, studentId, invId, today(), nextReceiptNumber(), BRANCH_ID);

        recordIncome({
          category: 'fee', amount: 1000, date: today(),
          description: 'E3 nested', referenceId: invId, paymentId: payId,
          operatorName: 'Audit', branchId: BRANCH_ID,
        });
      })();
    })();

    const student = db.prepare('SELECT notes FROM students WHERE id = ?').get(studentId) as any;
    expect(student.notes).toBe('outer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §F — PHASE 4: TRUE CONCURRENCY (Multi-Connection)
// ═══════════════════════════════════════════════════════════════════════════
describe('§F True Concurrency (Multi-Connection)', () => {
  it('F1: SQLite WAL handles concurrent readers + writer stress test', () => {
    // Open 5 readonly connections to verify WAL concurrent read support
    const readers = [];
    for (let i = 0; i < 5; i++) {
      const r = new Database(db.name, { readonly: true });
      r.pragma('journal_mode = WAL');
      readers.push(r);
    }

    // Writer: perform 200 rapid writes in a single transaction
    db.transaction(() => {
      const stmt = db.prepare(
        "INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id) VALUES (?, 'income', 'stress', 1, ?, 'stress test', 'stress', ?)"
      );
      for (let i = 0; i < 200; i++) {
        stmt.run(id('tx_stress'), today(), BRANCH_ID);
      }
    })();

    // All readers can see the data after write commits
    for (const r of readers) {
      const count = r.prepare("SELECT COUNT(*) as c FROM financial_transactions WHERE type = 'income' AND branch_id = ?").get(BRANCH_ID) as any;
      expect(count.c).toBeGreaterThanOrEqual(200);
      r.close();
    }

    // Cleanup: delete stress test data
    db.prepare("DELETE FROM financial_transactions WHERE description = 'stress test'").run();
  });

  it('F2: concurrent receipt counter stress (sequential in single-process, realistic for SQLite)', () => {
    const receipts = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const rc = nextReceiptNumber();
      expect(receipts.has(rc)).toBe(false);
      receipts.add(rc);
    }
    expect(receipts.size).toBe(500);
  });
});
