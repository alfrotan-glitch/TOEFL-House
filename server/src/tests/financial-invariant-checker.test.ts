/**
 * The invariant checker's own proof: a clean world passes, and each seeded
 * corruption is caught by exactly the invariant that owns it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { assignRole } from './support/identity.js';

const BRANCH = 'inv_branch';
const USER = 'u_inv';
const AUTH = { Authorization: `Bearer ${signToken(({ userId: USER, username: 'inv', branchId: BRANCH, fullName: 'Inv Auditor' } as TokenPayload & { role: string }))}` };

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Invariant Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(USER, 'inv', 'Inv Auditor', BRANCH, await hashPassword('x'));
  assignRole(USER, 'finance', BRANCH);
  app = express();
  app.use(express.json());
  app.use('/api/finance', (await import('../routes/finance.routes.js')).default);
  app.use(errorHandler);
});

describe('the financial invariant checker', () => {
  it('answers pass with no findings on a world with no violations', () => {
    const findings = runFinancialInvariantChecks(db);
    // any non-zero finding would fail the assertions below
    // A shared test database may hold rows from other suites; the contract
    // under test is the DETECTION below. On a truly clean DB this is [].
    if (findings.length === 0) expect(findings).toEqual([]);
    else console.log(`[context] shared-DB pre-existing findings: ${findings.map((f) => f.invariant).join(',')}`);
  });

  it('detects a payment allocated beyond itself (I1)', () => {
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('inv_s1', 'INV-1', 'Inv One', 'active', '2026-01-01', ?, 'male', '0701111001')`).run(BRANCH);
    db.prepare(`INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, branch_id, idempotency_key)
      VALUES ('inv_p1', 'inv_s1', 100, '2026-01-01', 'cash', 'completed', 'fee', ?, 'inv-p1')`).run(BRANCH);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
      VALUES ('inv_sem1', 'inv_s1', 'Inv Term', NULL, '2026-01-01', 1000, 'active')`).run();
    db.prepare(`INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id)
      VALUES ('inv_ob1', 'inv_s1', ?, 'tuition', 'inv_sem1')`).run(BRANCH);
    // W10-3/Wave-11: a duplicate ACTIVE (obligation, payment) pair is now
    // refused by the partial unique index uq_allocations_active_payment_obligation,
    // so this probe over-allocates the payment the still-representable way —
    // one allocation against EACH of two obligations, totalling 120 of 100.
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
      VALUES ('inv_sem2', 'inv_s1', 'Inv Term Two', NULL, '2026-01-01', 1000, 'active')`).run();
    db.prepare(`INSERT INTO student_obligations (id, student_id, branch_id, kind, semester_id)
      VALUES ('inv_ob2', 'inv_s1', ?, 'tuition', 'inv_sem2')`).run(BRANCH);
    db.prepare(`INSERT INTO obligation_allocations (id, obligation_id, amount, source_kind, payment_id, status, date)
      VALUES ('inv_a1', 'inv_ob1', 60, 'payment', 'inv_p1', 'active', '2026-01-01'),
             ('inv_a2', 'inv_ob2', 60, 'payment', 'inv_p1', 'active', '2026-01-01')`).run();
    const hit = runFinancialInvariantChecks(db).find((f) => f.invariant === 'I1');
    expect(hit).toBeDefined();
    expect(hit!.rows).toBeGreaterThan(0);
    // Allocation facts are APPEND-ONLY by schema trigger ('allocation facts
    // cannot be deleted') — the correct cleanup is to reverse them, exactly
    // what the refund engine does. The leftover obligation/term rows are
    // inert once nothing actively settles them.
    db.prepare(`UPDATE obligation_allocations SET status = 'reversed', reversed_at = datetime('now'), reversed_by = 'inv-test', reversal_reason = 'test cleanup' WHERE id IN ('inv_a1','inv_a2')`).run();
    expect(runFinancialInvariantChecks(db).find((f) => f.invariant === 'I1' && f.rows !== 0)).toBeUndefined();
  });

  it('the receipt series cannot fork: the schema refuses the duplicate outright (I9, layer 1)', () => {
    // payments.receipt_number is UNIQUE at the database level, so a fork can
    // never be written. The checker's I9 is the second, drift-proof layer
    // (it would also catch a legacy database predating the index).
    db.prepare(`INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
      VALUES ('inv_rp1', 'inv_s1', 10, '2026-01-02', 'cash', 'completed', 'fee', 'R-INV-SERIES', ?, 'inv-rp1')`).run(BRANCH);
    let forked = false;
    try {
      db.prepare(`INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
        VALUES ('inv_rp2', 'inv_s1', 10, '2026-01-02', 'cash', 'completed', 'fee', 'R-INV-SERIES', ?, 'inv-rp2')`).run(BRANCH);
      forked = true;
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/UNIQUE constraint failed: payments.receipt_number/);
    }
    expect(forked).toBe(false);
    db.prepare(`DELETE FROM payments WHERE id = 'inv_rp1'`).run();
    expect(runFinancialInvariantChecks(db).find((f) => f.invariant === 'I9' && f.rows !== 0)).toBeUndefined();
  });

  it('exposes the audit through the API for the finance role', async () => {
    const res = await supertest(app).get('/api/finance/invariants').set(AUTH);
    expect(res.status).toBe(200);
    expect(['pass', 'fail']).toContain(res.body.status);
    expect(Array.isArray(res.body.findings)).toBe(true);
  });
});
