/**
 * The database refuses negative money at rest.
 * ============================================================================
 * Route validation is the first line of defence and it is now in place, but a
 * money column with no constraint is one forgotten `Number()` away from
 * storing a permanently wrong figure. Without these guards the schema would
 * accept, for a perfectly valid student:
 *
 *     INSERT INTO invoices (... total_amount -5000, net_amount -5000 ...)  -> stored
 *     INSERT INTO exams    (... fee -100 ...)                              -> stored
 *
 * `invoices` already had branch-integrity and two-decimal-scale triggers, so
 * the gap was specifically the SIGN of the amount.
 *
 * Refunds and voids are recorded as separate contra rows in
 * `financial_transactions`, never as negative invoices or negative fees, so
 * these guards constrain no legitimate flow — the tests below prove ordinary
 * writes, and zero-value writes, still succeed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/connection.js';

let studentId: string;
let branchId: string;

beforeAll(() => {
  // The invoice branch-integrity trigger requires the invoice branch to equal
  // the student's branch, so the fixture must pin both to the same value
  // rather than assume a pre-existing student is in the branch we picked.
  branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() as { id: string } | undefined)?.id ?? '1';
  studentId = 'stu_069_guard';
  db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
  db.prepare(
    `INSERT INTO students (id, full_name, student_code, gender, branch_id, status, registration_date)
     VALUES (?, 'Guard Probe', 'TH-069069', 'male', ?, 'active', '2026-01-01')`
  ).run(studentId, branchId);
});

const insertInvoice = (total: number, discount: number, net: number) =>
  db.prepare(
    `INSERT INTO invoices (id, student_id, invoice_number, total_amount, discount_amount, net_amount, status, branch_id, issue_date, purpose)
     VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, '2026-01-01', 'other')`
  ).run(`inv_069_${Math.random().toString(36).slice(2, 10)}`, studentId, `T-${Math.random().toString(36).slice(2, 9)}`,
    total, discount, net, branchId);

const insertExam = (fee: number) =>
  db.prepare("INSERT INTO exams (id, title, date, fee, type, branch_id) VALUES (?, 'Probe', '2026-01-01', ?, 'final', ?)")
    .run(`ex_069_${Math.random().toString(36).slice(2, 10)}`, fee, branchId);

describe('negative money is rejected by the database', () => {
  it('refuses a negative invoice total', () => {
    expect(() => insertInvoice(-5000, 0, -5000)).toThrow(/cannot be negative/i);
  });

  it('refuses a negative discount amount', () => {
    expect(() => insertInvoice(5000, -100, 5000)).toThrow(/cannot be negative/i);
  });

  it('refuses updating an existing invoice to a negative total', () => {
    insertInvoice(5000, 0, 5000);
    const row = db.prepare('SELECT id FROM invoices ORDER BY rowid DESC LIMIT 1').get() as { id: string };
    expect(() => db.prepare('UPDATE invoices SET total_amount = -1 WHERE id = ?').run(row.id))
      .toThrow(/cannot be negative/i);
  });

  it('refuses a negative exam fee', () => {
    expect(() => insertExam(-100)).toThrow(/cannot be negative/i);
  });

  it('refuses updating an exam fee to a negative value', () => {
    insertExam(1500);
    const row = db.prepare('SELECT id FROM exams ORDER BY rowid DESC LIMIT 1') .get() as { id: string };
    expect(() => db.prepare('UPDATE exams SET fee = -50 WHERE id = ?').run(row.id)).toThrow(/cannot be negative/i);
  });

  it('refuses a negative semester fee', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO student_semesters (id, student_id, semester_name, fee_amount, enroll_date, status)
         VALUES (?, ?, 'S', -6000, '2026-01-01', 'active')`
      ).run(`ss_069_${Math.random().toString(36).slice(2, 8)}`, studentId),
    ).toThrow(/cannot be negative/i);
  });

  it('still allows ordinary and zero-value writes', () => {
    // A free exam and a zero-total invoice are legitimate; only negatives are refused.
    expect(() => insertExam(1500)).not.toThrow();
    expect(() => insertExam(0)).not.toThrow();
    expect(() => insertInvoice(6000, 0, 6000)).not.toThrow();
    expect(() => insertInvoice(0, 0, 0)).not.toThrow();
  });
});
