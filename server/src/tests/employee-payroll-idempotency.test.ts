/**
 * Employee payroll integrity — regression suite for teacher-audit finding T-1.
 *
 * PRE-FIX BEHAVIOUR, reproduced live on a fresh database before any code was
 * changed (`POST /api/employees/:id/pay-salary`):
 *   - 3 sequential identical partial payments -> 3 payments, 3,000 AFN
 *   - 6 concurrent identical partial payments -> 6 payments, 6,000 AFN
 *   - the same explicit Idempotency-Key twice -> 2 payments (header ignored)
 *   - every payment wrote a raw financial_transactions row and NO ledger row
 * The only guard was a `description LIKE '%full salary%<month>%'` string match
 * that applied to `payment_type = 'full'` only and was a check-then-act.
 *
 * Each test below states the invariant it defends. The teacher payroll path is
 * used as a control where the two are expected to agree, since the fix reuses
 * that path's authorities (resolveIdempotency + a partial UNIQUE index as the
 * race arbiter + BEGIN IMMEDIATE).
 *
 * SCOPE: these tests deliberately assert NOTHING about a cumulative salary cap.
 * No cap rule exists anywhere in this codebase, its data or its tests, so none
 * is invented here; see docs/TEACHER_SUBSYSTEM_AUDIT_2026-08-18.md.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { NON_EXPENSE_CASH_MOVEMENT_SQL, OPERATING_EXPENSE_SQL } from '../core/finance/ledger-classification.js';
import { today, id as mkId } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { teachersRouter, employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'epi_branch';
const BUDGET = 50_000_000;

let app: express.Express;
let owner: TokenPayload;
let budgetLineId: string;

const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

function mkEmployee(eid: string, baseSalary = 8000, status: 'active' | 'inactive' = 'active') {
  db.prepare(
    `INSERT OR REPLACE INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
     VALUES (?, ?, 'clerk', ?, ?, ?, ?)`,
  ).run(eid, `Employee ${eid}`, BRANCH, baseSalary, status, today());
  return eid;
}

function mkTeacher(tid: string, baseSalary = 8000) {
  db.prepare(
    `INSERT OR REPLACE INTO teachers (id, full_name, branch_id, base_salary, salary_type, status, joined_date, performance_score, default_skill_rate)
     VALUES (?, ?, ?, ?, 'fixed', 'active', ?, 0, 0)`,
  ).run(tid, `Teacher ${tid}`, BRANCH, baseSalary, today());
  return tid;
}

const pay = (eid: string, body: Record<string, unknown>, key?: string) => {
  const req = supertest(app).post(`/api/employees/${eid}/pay-salary`).set(auth(owner));
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

const ledgerRows = (eid: string) =>
  db.prepare('SELECT * FROM employee_salary_ledger WHERE employee_id = ? ORDER BY paid_at').all(eid) as Array<Record<string, unknown>>;
// Every payroll ledger row for this employee, whatever its accounting
// treatment. Filtering on `category = 'salary'` would silently drop genuine
// advances, which now carry their own canonical node.
const txRows = (eid: string) =>
  db.prepare("SELECT * FROM financial_transactions WHERE reference_id = ? AND type = 'expense'").all(eid) as Array<Record<string, unknown>>;
const paidTotal = (eid: string) => txRows(eid).reduce((sum, r) => sum + Number(r.amount), 0);
const budgetNow = () => Number((db.prepare('SELECT current_amount c FROM budget_lines WHERE id = ?').get(budgetLineId) as { c: number }).c);
const setBudget = (v: number) => db.prepare('UPDATE budget_lines SET current_amount = ? WHERE id = ?').run(v, budgetLineId);

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'EPI Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('epi_owner', 'epi_owner', 'EPI Owner', 'owner', ?, ?, 1, 0)`,
  ).run(BRANCH, await hashPassword('pw'));
  syncLegacyUserRoles(db);
  owner = { userId: 'epi_owner', username: 'epi_owner', role: 'owner' as never, branchId: BRANCH, fullName: 'EPI Owner' };

  budgetLineId = mkId('bl');
  db.prepare(
    `INSERT INTO budget_lines (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(budgetLineId, 'Employee Salaries', BUDGET, BUDGET, 'sub_salaries_wages', 'employee', BRANCH);
  const tb = mkId('bl');
  db.prepare(
    `INSERT INTO budget_lines (id, name, allocated_amount, current_amount, category_id, payroll_target, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tb, 'Teacher Salaries', BUDGET, BUDGET, 'sub_salaries_wages', 'teacher', BRANCH);

  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
});

describe('T-1 · sequential duplicate requests', () => {
  it('collapses three identical sequential partial payments into ONE payment', async () => {
    const e = mkEmployee('epi_seq');
    const before = budgetNow();
    for (let i = 0; i < 3; i++) {
      const r = await pay(e, { monthName: 'Asad 1405', amountPaid: 1000, paymentType: 'partial' });
      expect(r.status).toBe(201);
    }
    // Pre-fix this was 3 rows / 3,000 AFN.
    expect(txRows(e)).toHaveLength(1);
    expect(ledgerRows(e)).toHaveLength(1);
    expect(paidTotal(e)).toBe(1000);
    expect(before - budgetNow()).toBe(1000);
  });

  it('reports the retry as a replay rather than a new payment', async () => {
    const e = mkEmployee('epi_replayflag');
    const first = await pay(e, { monthName: 'Hamal 1405', amountPaid: 700, paymentType: 'partial' });
    const second = await pay(e, { monthName: 'Hamal 1405', amountPaid: 700, paymentType: 'partial' });
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    // A replay must return the SAME ledger row, not a new one.
    expect(second.body.ledgerId).toBe(first.body.ledgerId);
    expect(ledgerRows(e)).toHaveLength(1);
  });
});

describe('T-1 · concurrent duplicate requests', () => {
  it('collapses six concurrent identical payments into ONE payment and ONE debit', async () => {
    const e = mkEmployee('epi_conc');
    const before = budgetNow();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pay(e, { monthName: 'Sonbola 1405', amountPaid: 1000, paymentType: 'partial' })),
    );
    // Every caller gets a success; only one payment actually exists.
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(txRows(e)).toHaveLength(1);
    expect(ledgerRows(e)).toHaveLength(1);
    expect(paidTotal(e)).toBe(1000);
    // Pre-fix the budget lost 6,000 AFN here.
    expect(before - budgetNow()).toBe(1000);
  });

  it('CONTROL · the teacher path already behaved this way', async () => {
    const t = mkTeacher('epi_ctl_teacher');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        supertest(app).post(`/api/teachers/${t}/pay-salary`).set(auth(owner))
          .send({ monthName: '1405-05', amountPaid: 1000, paymentType: 'partial' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM teacher_salary_ledger WHERE teacher_id = ?').get(t)).toEqual({ c: 1 });
  });
});

describe('T-1 · explicit Idempotency-Key', () => {
  it('honours a repeated client-supplied key (it was ignored entirely pre-fix)', async () => {
    const e = mkEmployee('epi_key');
    const a = await pay(e, { monthName: 'Mizan 1405', amountPaid: 1500, paymentType: 'partial' }, 'epi-key-1');
    const b = await pay(e, { monthName: 'Mizan 1405', amountPaid: 1500, paymentType: 'partial' }, 'epi-key-1');
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.replayed).toBe(true);
    expect(txRows(e)).toHaveLength(1);
    expect(paidTotal(e)).toBe(1500);
  });

  it('rejects a key replayed against a DIFFERENT employee', async () => {
    const a1 = mkEmployee('epi_key_x');
    const a2 = mkEmployee('epi_key_y');
    const first = await pay(a1, { monthName: 'Dalw 1405', amountPaid: 900, paymentType: 'partial' }, 'epi-shared-key');
    expect(first.status).toBe(201);
    const second = await pay(a2, { monthName: 'Dalw 1405', amountPaid: 900, paymentType: 'partial' }, 'epi-shared-key');
    expect(second.status).toBe(409);
    // The second employee must not have been paid on the back of the first key.
    expect(ledgerRows(a2)).toHaveLength(0);
    expect(txRows(a2)).toHaveLength(0);
  });

  it('rejects a key replayed against a different PERIOD', async () => {
    const e = mkEmployee('epi_key_period');
    expect((await pay(e, { monthName: 'Hoot 1405', amountPaid: 400, paymentType: 'partial' }, 'epi-period-key')).status).toBe(201);
    const other = await pay(e, { monthName: 'Saur 1405', amountPaid: 400, paymentType: 'partial' }, 'epi-period-key');
    expect(other.status).toBe(409);
    expect(ledgerRows(e)).toHaveLength(1);
  });
});

describe('T-1 · legitimate distinct payments still succeed', () => {
  it('allows different amounts, different months and advances in the same month', async () => {
    const e = mkEmployee('epi_distinct');
    const before = budgetNow();
    const r1 = await pay(e, { monthName: 'Aqrab 1405', amountPaid: 1000, paymentType: 'partial' });
    const r2 = await pay(e, { monthName: 'Aqrab 1405', amountPaid: 2500, paymentType: 'partial' });
    const r3 = await pay(e, { monthName: 'Qaws 1405', amountPaid: 1000, paymentType: 'partial' });
    const r4 = await pay(e, { monthName: 'Aqrab 1405', amountPaid: 1000, paymentType: 'advance' });
    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([201, 201, 201, 201]);
    // Four genuinely distinct payments — idempotency must not swallow any.
    expect(txRows(e)).toHaveLength(4);
    expect(ledgerRows(e)).toHaveLength(4);
    expect(paidTotal(e)).toBe(5500);
    expect(before - budgetNow()).toBe(5500);
  });

  it('preserves partial/advance behaviour: repeated partials are NOT capped at base salary', async () => {
    // Deliberate: no cap semantics are asserted, only that distinct legitimate
    // partials keep working. Whether a cumulative cap SHOULD exist is an open
    // business decision recorded in the audit, not something invented here.
    const e = mkEmployee('epi_nocap', 2000);
    for (const amt of [900, 1100, 1300]) {
      expect((await pay(e, { monthName: 'Jawza 1405', amountPaid: amt, paymentType: 'partial' })).status).toBe(201);
    }
    expect(paidTotal(e)).toBe(3300);
    expect(ledgerRows(e)).toHaveLength(3);
  });
});

describe('T-1 · full-payment period guard', () => {
  it('still rejects a second FULL payment for the same month (non-retry)', async () => {
    const e = mkEmployee('epi_full');
    const a = await pay(e, { monthName: 'Asad 1405', amountPaid: 8000, paymentType: 'full' }, 'epi-full-a');
    const b = await pay(e, { monthName: 'Asad 1405', amountPaid: 8000, paymentType: 'full' }, 'epi-full-b');
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    // The route must classify this as a payroll conflict itself. Without the
    // unique-violation backstop the raw constraint error escapes to the global
    // error handler, which also answers 409 but with the generic message
    // "A record with this unique information already exists." — the same status
    // code, so asserting the status alone cannot tell the two apart. Mutation
    // testing caught exactly that gap.
    expect(b.body.error).toMatch(/full salary payment for "Asad 1405" already exists/i);
    expect(txRows(e)).toHaveLength(1);
    expect(paidTotal(e)).toBe(8000);
  });

  it('catches a duplicate FULL payment written in a different month FORMAT', async () => {
    // The old description-LIKE guard compared raw strings, so 'Asad 1405' and
    // '1405-05' looked like different months and both were paid. The ledger
    // stores a normalised period key, so the index catches it.
    const e = mkEmployee('epi_full_fmt');
    expect((await pay(e, { monthName: 'Asad 1405', amountPaid: 8000, paymentType: 'full' }, 'epi-fmt-a')).status).toBe(201);
    expect((await pay(e, { monthName: '1405-05', amountPaid: 8000, paymentType: 'full' }, 'epi-fmt-b')).status).toBe(409);
    expect(txRows(e)).toHaveLength(1);
  });
});

describe('T-1 · failure rollback', () => {
  it('leaves no ledger row, no transaction and no debit when the budget is insufficient', async () => {
    const e = mkEmployee('epi_rollback');
    const saved = budgetNow();
    setBudget(100);
    const r = await pay(e, { monthName: 'Qaws 1405', amountPaid: 5000, paymentType: 'partial' });
    expect(r.status).toBe(409);
    expect(ledgerRows(e)).toHaveLength(0);
    expect(txRows(e)).toHaveLength(0);
    expect(budgetNow()).toBe(100);
    setBudget(saved);
  });

  it('never overdraws the budget under concurrency', async () => {
    const e = mkEmployee('epi_exhaust');
    const saved = budgetNow();
    setBudget(1000);
    // Distinct amounts so these are five genuinely different payments, not retries.
    const results = await Promise.all([1000, 1001, 1002, 1003, 1004].map((amt) =>
      pay(e, { monthName: 'Jadi 1405', amountPaid: amt, paymentType: 'partial' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(budgetNow()).toBe(0);
    expect(budgetNow()).toBeGreaterThanOrEqual(0);
    setBudget(saved);
  });

  it('rolls back the debit AND the expense row when the ledger insert fails', async () => {
    // Atomicity proof. A pre-existing posted FULL row for this period makes the
    // ledger insert violate uq_employee_salary_full_period at the very last
    // step, AFTER the budget has been debited and the expense row written. All
    // three must vanish together. If the boundary were split, money would leave
    // the budget and an expense would be recorded with no ledger row behind it.
    const e = mkEmployee('epi_atomic');
    db.prepare(
      `INSERT INTO employee_salary_ledger (id, employee_id, period_key, period_label, paid_amount, payment_type, branch_id, idempotency_key, status)
       VALUES (?, ?, '1405-09', 'Qaws 1405', 8000, 'full', ?, ?, 'posted')`,
    ).run(mkId('esl'), e, BRANCH, 'epi-atomic-preexisting');

    const before = budgetNow();
    const r = await pay(e, { monthName: 'Qaws 1405', amountPaid: 8000, paymentType: 'full' }, 'epi-atomic-new');
    expect(r.status).toBe(409);
    expect(budgetNow()).toBe(before);
    expect(txRows(e)).toHaveLength(0);
    expect(ledgerRows(e)).toHaveLength(1);
  });

  it('rejects an inactive employee without writing anything', async () => {
    const e = mkEmployee('epi_inactive', 8000, 'inactive');
    const r = await pay(e, { monthName: 'Asad 1405', amountPaid: 500, paymentType: 'partial' });
    expect(r.status).toBe(400);
    expect(ledgerRows(e)).toHaveLength(0);
    expect(txRows(e)).toHaveLength(0);
  });

  it('rejects non-positive and non-finite amounts without residue', async () => {
    const e = mkEmployee('epi_badamount');
    for (const amountPaid of [0, -100, 'abc']) {
      const r = await pay(e, { monthName: 'Asad 1405', amountPaid, paymentType: 'partial' });
      expect(r.status).toBe(400);
    }
    expect(ledgerRows(e)).toHaveLength(0);
    expect(txRows(e)).toHaveLength(0);
  });
});

describe('T-1 · database-level race arbiter', () => {
  // better-sqlite3 is synchronous, so HTTP requests fired with Promise.all can
  // never truly interleave inside the route: the service-layer replay check
  // alone absorbs them and the unique index is never exercised through HTTP.
  // (Mutation testing proved this — downgrading the index to non-unique left
  // every HTTP-level test still passing.) The index is the ONLY protection
  // left if the pre-check is ever bypassed, e.g. by a second process, so it is
  // asserted directly against the database.
  it('the database itself refuses a second row with the same idempotency key', () => {
    const e = mkEmployee('epi_uq_key');
    const insert = (rowId: string, key: string) =>
      db.prepare(
        `INSERT INTO employee_salary_ledger (id, employee_id, period_key, period_label, paid_amount, payment_type, branch_id, idempotency_key, status)
         VALUES (?, ?, '1405-05', 'Asad 1405', 500, 'partial', ?, ?, 'posted')`,
      ).run(rowId, e, BRANCH, key);

    insert(mkId('esl'), 'epi-race-key');
    expect(() => insert(mkId('esl'), 'epi-race-key')).toThrow(/UNIQUE constraint failed/i);
    expect(ledgerRows(e)).toHaveLength(1);
  });

  it('the unique key index still allows many rows with NO key (partial index)', () => {
    const e = mkEmployee('epi_uq_null');
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO employee_salary_ledger (id, employee_id, period_key, period_label, paid_amount, payment_type, branch_id, idempotency_key, status)
         VALUES (?, ?, '1405-06', 'Sonbola 1405', 100, 'partial', ?, NULL, 'posted')`,
      ).run(mkId('esl'), e, BRANCH);
    }
    expect(ledgerRows(e)).toHaveLength(3);
  });

  it('the database itself refuses two posted FULL rows for one employee-period', () => {
    const e = mkEmployee('epi_uq_full');
    const insert = (rowId: string, type: string, status = 'posted') =>
      db.prepare(
        `INSERT INTO employee_salary_ledger (id, employee_id, period_key, period_label, paid_amount, payment_type, branch_id, idempotency_key, status)
         VALUES (?, ?, '1405-08', 'Aqrab 1405', 800, ?, ?, ?, ?)`,
      ).run(rowId, e, type, BRANCH, mkId('k'), status);

    insert(mkId('esl'), 'full');
    expect(() => insert(mkId('esl'), 'full')).toThrow(/UNIQUE constraint failed/i);
    // Partials and advances are unaffected, and a VOIDED full frees the slot
    // so a corrected payment can be re-made.
    expect(() => insert(mkId('esl'), 'partial')).not.toThrow();
    expect(() => insert(mkId('esl'), 'full', 'voided')).not.toThrow();
  });
});

describe('T-1 · financial reconciliation', () => {
  it('links every ledger row to exactly one balanced expense transaction', async () => {
    const e = mkEmployee('epi_recon');
    const r = await pay(e, { monthName: 'Mizan 1405', amountPaid: 1234.5, paymentType: 'partial' });
    expect(r.status).toBe(201);
    const [led] = ledgerRows(e);
    expect(led).toBeTruthy();
    expect(led.period_key).toBe('1405-07');
    expect(Number(led.paid_amount)).toBe(1234.5);
    expect(led.payment_type).toBe('partial');
    expect(led.status).toBe('posted');
    expect(led.branch_id).toBe(BRANCH);
    expect(led.operator_name).toBe('EPI Owner');
    expect(led.idempotency_key).toBeTruthy();

    const tx = db.prepare('SELECT * FROM financial_transactions WHERE id = ?').get(led.transaction_id) as Record<string, unknown>;
    expect(tx).toBeTruthy();
    expect(Number(tx.amount)).toBe(Number(led.paid_amount));
    expect(tx.type).toBe('expense');
    expect(tx.category).toBe('salary');
    expect(tx.reference_id).toBe(e);
    expect(tx.branch_id).toBe(BRANCH);
  });

  it('keeps ledger total, expense total and budget debit in agreement', async () => {
    const e = mkEmployee('epi_recon_sum');
    const before = budgetNow();
    for (const amt of [300, 450, 725]) {
      expect((await pay(e, { monthName: 'Saur 1405', amountPaid: amt, paymentType: 'partial' })).status).toBe(201);
    }
    // Retries must not disturb the reconciliation.
    await pay(e, { monthName: 'Saur 1405', amountPaid: 450, paymentType: 'partial' });

    const ledgerTotal = ledgerRows(e).reduce((s, r) => s + Number(r.paid_amount), 0);
    expect(ledgerTotal).toBe(1475);
    expect(paidTotal(e)).toBe(1475);
    expect(before - budgetNow()).toBe(1475);
    // One ledger row per expense row: no orphans on either side.
    expect(ledgerRows(e)).toHaveLength(txRows(e).length);
  });

  it('does NOT write employee rows into the teacher ledger', async () => {
    // teacher_salary_ledger.teacher_id is a NOT NULL FK to teachers(id) and the
    // teacher payroll engine SUMs it; employee rows there would corrupt it.
    const e = mkEmployee('epi_isolation');
    await pay(e, { monthName: 'Hoot 1405', amountPaid: 600, paymentType: 'partial' });
    expect(db.prepare('SELECT COUNT(*) c FROM teacher_salary_ledger WHERE teacher_id = ?').get(e)).toEqual({ c: 0 });
    expect(ledgerRows(e)).toHaveLength(1);
  });

  it('has no employee salary expense without a matching ledger row (no shadow writer)', async () => {
    // Guards against a second, unhardened write path reappearing anywhere.
    const orphans = db.prepare(
      `SELECT ft.id FROM financial_transactions ft
        WHERE ft.category = 'salary' AND ft.branch_id = ?
          AND ft.reference_id IN (SELECT id FROM employees)
          AND NOT EXISTS (SELECT 1 FROM employee_salary_ledger l WHERE l.transaction_id = ft.id)`,
    ).all(BRANCH);
    expect(orphans).toEqual([]);
  });
});

describe('employee payroll classifies a genuine advance as a receivable', () => {
  /**
   * An employee advance is UNCAPPED — it may exceed salary already earned — so
   * it is money lent against future pay, not a wage cost. Full and partial
   * payments settle salary that has already accrued and stay operating expense.
   * The teacher path has no equivalent: its "advance" was capped at the period's
   * remaining due, which made it a partial payment wearing the wrong label, and
   * the concept was removed there rather than reinterpreted.
   */
  it('books an advance under Salary Advances and a partial under Salaries & Wages', async () => {
    const e = mkEmployee('epi_treatment');
    await pay(e, { monthName: 'Jadi 1405', amountPaid: 900, paymentType: 'partial' });
    await pay(e, { monthName: 'Jadi 1405', amountPaid: 700, paymentType: 'advance' });

    const rows = db.prepare(
      "SELECT amount, category, finance_category_id FROM financial_transactions WHERE reference_id = ? AND type='expense' ORDER BY amount DESC",
    ).all(e) as Array<{ amount: number; category: string; finance_category_id: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: 900, category: 'salary', finance_category_id: 'sub_salaries_wages' });
    expect(rows[1]).toMatchObject({ amount: 700, category: 'salary_advance', finance_category_id: 'sub_salary_advances' });
  });

  it('keeps the advance out of operating expense while the partial stays in', async () => {
    const e = mkEmployee('epi_pnl');
    await pay(e, { monthName: 'Dalw 1405', amountPaid: 400, paymentType: 'partial' });
    await pay(e, { monthName: 'Dalw 1405', amountPaid: 600, paymentType: 'advance' });

    const sum = (predicate: string) => Number((db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM financial_transactions WHERE reference_id = ? AND ${predicate}`,
    ).get(e) as { v: number }).v);

    expect(sum(OPERATING_EXPENSE_SQL)).toBe(400);
    expect(sum(NON_EXPENSE_CASH_MOVEMENT_SQL)).toBe(600);
  });
});
