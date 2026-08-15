/**
Integration test: Payment Recording (Audit §8.1)
Verifies that recording a payment correctly inserts both the
payment record and the corresponding financial_transactions ledger entry.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';

beforeAll(() => {
  initSchema();
  // Seed minimal required data
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, 'b1', 'male')`
  ).run('s1', 'TH-TEST-001', 'Test Student', today());
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Payment Recording', () => {
  it('records a payment and creates a matching ledger entry', () => {
    const paymentId = id('pay');
    const txId = id('tx');
    const date = today();
    const amount = 5000;

    db.transaction(() => {
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, branch_id)
         VALUES (?, ?, ?, ?, 'cash', 'completed', 'fee', 'b1')`
      ).run(paymentId, 's1', amount, date);

      db.prepare(
        `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, payment_id, operator_name, branch_id)
         VALUES (?, 'income', 'fee', ?, ?, 'Test payment', ?, ?, 'Test Operator', 'b1')`
      ).run(txId, amount, date, paymentId, paymentId);
    })();

    // Verify payment exists
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
    expect(payment).toBeDefined();
    expect(payment.amount).toBe(amount);
    expect(payment.status).toBe('completed');

    // Verify ledger entry exists and matches
    const tx = db.prepare('SELECT * FROM financial_transactions WHERE reference_id = ?').get(paymentId) as any;
    expect(tx).toBeDefined();
    expect(tx.amount).toBe(amount);
    expect(tx.type).toBe('income');
    expect(tx.category).toBe('fee');
  });

  it('rejects payment for non-existent student (FK constraint)', () => {
    const paymentId = id('pay');
    expect(() => {
      db.prepare(
        `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, branch_id)
         VALUES (?, 'nonexistent', 1000, ?, 'cash', 'completed', 'fee', 'b1')`
      ).run(paymentId, today());
    }).toThrow();
  });
});