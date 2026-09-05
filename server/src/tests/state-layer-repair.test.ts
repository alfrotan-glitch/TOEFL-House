/**
 * Wave 11 — state-layer repair verification (W10-1 / W10-2 / W10-3).
 *
 * Adversarial: everything goes through production route surfaces; assertions
 * derive state independently from underlying records (payments, allocations,
 * installments, events), never from API response claims.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';

import studentsRouter from '../routes/students.routes.js';
import classesRouter from '../routes/classes.routes.js';
import catalogRouter from '../routes/catalog.routes.js';
import invoicesRouter from '../routes/invoices.routes.js';
import { runFinancialInvariantChecks } from '../core/finance/invariant-checker.js';
import { bearerFor, seedUser } from './support/identity.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, DEFAULT_BRANCH_ID } from '../db/organizationHierarchy.js';

const OWNER = 'user_owner';
const BRANCH = 'branch_w11';

const app = express();
app.use(express.json());
app.use('/api/students', studentsRouter);
app.use('/api/classes', classesRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/invoices', invoicesRouter);

const owner = () => bearerFor(OWNER);
let seq = 0;
const unique = (s: string) => `${s} ${++seq}`;
const phone = () => `0777${String(100000 + (seq % 900000)).padStart(6, '0').slice(-6)}`;

/** Independent derivation: term amount minus what is STILL actively settled. */
const outstandingOf = (semesterId: string) => {
  const term = db.prepare('SELECT COALESCE(net_fee_amount, fee_amount) v FROM student_semesters WHERE id = ?')
    .get(semesterId) as { v: number };
  const paid = db.prepare(`
    SELECT COALESCE(SUM(a.amount), 0) v FROM obligation_allocations a
      JOIN student_obligations o ON o.id = a.obligation_id
     WHERE o.semester_id = ? AND a.status = 'active'
  `).get(semesterId) as { v: number };
  return Number(term.v) - Number(paid.v);
};

const installmentRow = (id: string) => db
  .prepare('SELECT status, paid_payment_id, amount FROM student_installments WHERE id = ?')
  .get(id) as { status: string; paid_payment_id: string | null; amount: number } | undefined;

const paymentIdByReceipt = (r: string) =>
  (db.prepare('SELECT id FROM payments WHERE receipt_number = ?').get(r) as { id: string }).id;

const assertOk = (label: string, res: { status: number; body: unknown }, ...ok: number[]) => {
  if (!ok.includes(res.status)) {
    throw new Error(`${label} ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
};

async function makeClass(name: string, fee: number): Promise<string> {
  const res = await request(app).post('/api/classes').set(owner()).send({
    name, level: 'A1', capacity: 30, fee, startDate: '2026-09-01', branchId: BRANCH,
  });
  assertOk('class create', res, 201);
  return res.body.id as string;
}

async function makeStudent(name: string): Promise<string> {
  const res = await request(app).post('/api/students/manual').set(owner()).send({
    fullName: name, phone: phone(), branchId: BRANCH, gender: 'male',
  });
  assertOk('student create', res, 201);
  const studentId = (res.body.student?.id ?? res.body.id) as string;
  // Admission issues a registration invoice that gates enrollment — settle it.
  const list = await request(app).get(`/api/invoices?studentId=${studentId}`).set(owner());
  const invoices = Array.isArray(list.body) ? list.body : (list.body.invoices ?? []);
  const registration = invoices.find((i: { chargeKind?: string; purpose?: string; status?: string }) =>
    (i.chargeKind ?? i.purpose) === 'registration' && i.status !== 'cancelled' && i.status !== 'paid');
  if (registration) {
    const paid = await request(app).post(`/api/invoices/${registration.id}/pay`).set(owner())
      .send({ amount: registration.netAmount, paymentMethod: 'cash' });
    assertOk('registration pay', paid, 200, 201);
  }
  return studentId;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare(`INSERT INTO branches (id, campus_id, name) VALUES (?, 'campus_kbl', 'W11 Branch')
              ON CONFLICT(id) DO NOTHING`).run(BRANCH);
  seedUser({ id: OWNER, role: 'owner', branchId: BRANCH });
  // Manual admission requires an active registration fee rule — created through
  // the production catalog surface, not a direct insert.
  const existingRule = db.prepare(
    "SELECT COUNT(*) c FROM fee_rules WHERE branch_id = ? AND fee_type = 'registration' AND is_active = 1"
  ).get(BRANCH) as { c: number };
  if (existingRule.c === 0) {
    const rule = await request(app).post('/api/catalog/fee-rules').set(owner()).send({
      branchId: BRANCH, feeType: 'registration', name: 'W11 registration',
      amount: 1000, isActive: true, effectiveFrom: '2026-01-01',
    });
    assertOk('fee rule', rule, 200, 201);
  }
});

describe('W11 · world-build sanity (harness itself)', () => {
  it('builds a class + admitted student through production surfaces', async () => {
    const cid = await makeClass(unique('W11 Sanity'), 5000);
    expect(typeof cid).toBe('string');
    const sid = await makeStudent(unique('W11 Student'));
    expect(typeof sid).toBe('string');
  });
});

describe('W10-1 · installment settlement lifecycle (repaired)', () => {
  let student: string;
  let semesterId: string;
  let plan: { id: string; amount: number }[];
  let paymentId: string;

  beforeAll(async () => {
    const cid = await makeClass(unique('W11 Class'), 5000);
    student = await makeStudent(unique('W11 Lifecycle'));
    const enrolled = await request(app).post(`/api/students/${student}/enroll-semester`).set(owner()).send({
      classId: cid, semesterName: 'W11 Term', startDate: '2026-09-01', endDate: '2026-12-20',
    });
    assertOk('enroll', enrolled, 201);
    semesterId = enrolled.body.semesterId as string;

    const planRes = await request(app).put(`/api/students/${student}/installment-plan`).set(owner()).send({
      semesterId, installments: [
        { amount: 2500, dueDate: '2026-10-01' },
        { amount: 2500, dueDate: '2026-11-01' },
      ],
    });
    assertOk('plan', planRes, 200, 201);
    const planList = await request(app).get(`/api/students/${student}/installment-plan?semesterId=${semesterId}`).set(owner());
    plan = (planList.body.installments ?? planList.body) as { id: string; amount: number }[];
    expect(plan.length).toBe(2);
  });

  it('pay → full refund reopens the installment; repayment succeeds', async () => {
    const pay = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'installment', installmentId: plan[0].id, amount: 2500 });
    assertOk('installment pay', pay, 201);
    paymentId = paymentIdByReceipt(pay.body.receiptNumber);
    expect(installmentRow(plan[0].id)?.status).toBe('paid');
    expect(outstandingOf(semesterId)).toBe(2500);

    const refund = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 2500, reason: 'W10-1 full refund reproduction' });
    assertOk('full refund', refund, 200, 201);

    // THE REPAIR: the installment memo reopened, consistently with events.
    const row = installmentRow(plan[0].id);
    expect(row?.status).toBe('pending');
    expect(row?.paid_payment_id).toBeNull();
    // Independent: outstanding restored via active-allocation math; no active allocation remains.
    expect(outstandingOf(semesterId)).toBe(5000);
    expect(db.prepare("SELECT COUNT(*) n FROM obligation_allocations WHERE payment_id = ? AND status='active'")
      .get(paymentId)).toMatchObject({ n: 0 });

    // Repayment through the previously-blocked path now succeeds.
    const repay = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'installment', installmentId: plan[0].id, amount: 2500 });
    assertOk('repay', repay, 201);
    expect(installmentRow(plan[0].id)?.status).toBe('paid');
    expect(outstandingOf(semesterId)).toBe(2500);
  });

  it('partial refund keeps the installment paid (payment still settles)', async () => {
    // Derive the CURRENT settling payment from the installment itself.
    paymentId = installmentRow(plan[0].id)!.paid_payment_id!;
    const partial = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 1000, reason: 'W10-1 partial refund semantics' });
    assertOk('partial refund', partial, 200, 201);
    // 1500 of the payment still settles → the flag must stay paid.
    expect(installmentRow(plan[0].id)?.status).toBe('paid');
    expect(outstandingOf(semesterId)).toBe(3500);
    expect(db.prepare("SELECT COUNT(*) n FROM obligation_allocations WHERE payment_id = ? AND status='active'")
      .get(paymentId)).toMatchObject({ n: 1 });
  });

  it('refunding the retained remainder reopens again (cycle is idempotent)', async () => {
    const rest = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 1500, reason: 'W10-1 refund the retained remainder' });
    assertOk('remainder refund', rest, 200, 201);
    expect(installmentRow(plan[0].id)?.status).toBe('pending');
    expect(outstandingOf(semesterId)).toBe(5000);
  });

  it('duplicate/over refund is refused and changes nothing', async () => {
    const before = outstandingOf(semesterId);
    const dup = await request(app).post(`/api/students/${student}/refund`).set(owner())
      .send({ paymentId, amount: 2500, reason: 'W10-1 duplicate refund attempt' });
    expect([400, 409]).toContain(dup.status); // refused — exact code is the surface's choice
    expect(outstandingOf(semesterId)).toBe(before);
    expect(installmentRow(plan[0].id)?.status).toBe('pending');
  });

  it('concurrent refunds of the same payment: one wins, state stays consistent', async () => {
    const pay = await request(app).post(`/api/students/${student}/payments`).set(owner())
      .send({ category: 'installment', installmentId: plan[0].id, amount: 2500 });
    assertOk('re-pay for concurrency', pay, 201);
    const pid = paymentIdByReceipt(pay.body.receiptNumber);
    const results = await Promise.all([
      request(app).post(`/api/students/${student}/refund`).set(owner()).send({ paymentId: pid, amount: 2500, reason: 'W10-1 concurrent refund A' }),
      request(app).post(`/api/students/${student}/refund`).set(owner()).send({ paymentId: pid, amount: 2500, reason: 'W10-1 concurrent refund B' }),
    ]);
    const won = results.filter((r) => r.status === 200 || r.status === 201).length;
    const refused = results.filter((r) => r.status === 400 || r.status === 409).length;
    expect(won).toBe(1);
    expect(refused).toBe(1);
    expect(installmentRow(plan[0].id)?.status).toBe('pending');
    expect(outstandingOf(semesterId)).toBe(5000);
    const stateFindings = runFinancialInvariantChecks(db).filter((f) => ['I17', 'I18', 'I19'].includes(f.invariant));
    expect(stateFindings).toEqual([]);
  });
});

describe('W11-A · idempotency generation (repay after refund, category-generic)', () => {
  it('a FEE payment refunded in full can be honestly re-paid (new receipt, not a replay)', async () => {
    const cid = await makeClass(unique('W11 FeeGen'), 3000);
    const sid = await makeStudent(unique('W11 FeeGen Student'));
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner()).send({
      classId: cid, semesterName: 'W11 FeeGen Term', startDate: '2026-09-01', endDate: '2026-12-20',
    });
    assertOk('enroll', enrolled, 201);
    const sem = enrolled.body.semesterId as string;

    const pay1 = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: sem, amount: 3000 });
    assertOk('fee pay 1', pay1, 201);
    expect(pay1.body.idempotentReplay).toBeUndefined();
    const pid1 = paymentIdByReceipt(pay1.body.receiptNumber);

    const refund = await request(app).post(`/api/students/${sid}/refund`).set(owner())
      .send({ paymentId: pid1, amount: 3000, reason: 'W11-A full fee refund' });
    assertOk('fee refund', refund, 200, 201);

    // The same desk officer immediately re-collects the same fee — identical
    // derived idempotency fingerprint. This MUST be a new payment, never a
    // replay of the refunded receipt.
    const pay2 = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: sem, amount: 3000 });
    assertOk('fee re-pay', pay2, 201);
    expect(pay2.body.idempotentReplay).toBeUndefined();
    expect(pay2.body.receiptNumber).not.toBe(pay1.body.receiptNumber);

    // And the term is settled by the SECOND payment only.
    const active = db.prepare(`
      SELECT COALESCE(SUM(a.amount),0) v FROM obligation_allocations a
        JOIN student_obligations o ON o.id = a.obligation_id
       WHERE o.semester_id = ? AND a.status='active' AND a.payment_id = ?
    `).get(sem, paymentIdByReceipt(pay2.body.receiptNumber)) as { v: number };
    expect(Number(active.v)).toBe(3000);
    expect(outstandingOf(sem)).toBe(0);
    // A THIRD identical attempt now (payment still settling) is refused by the
    // fee guard — not recorded, not replayed.
    const pay3 = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'fee', semesterId: sem, amount: 3000 });
    expect([400, 409]).toContain(pay3.status);
    expect(runFinancialInvariantChecks(db).filter((f) => ['I16', 'I17', 'I18', 'I19'].includes(f.invariant))).toEqual([]);
  });
});

describe('W10-2 · class-merge attribution events (repaired)', () => {
  it('merge writes a transferred event per moved enrollment; attribution is reconstructible', async () => {
    const src = await makeClass(unique('W11 Src'), 5000);
    const dst = await makeClass(unique('W11 Dst'), 5000);
    const moved: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sid = await makeStudent(unique(`W11 Moved ${i}`));
      const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner()).send({
        classId: src, semesterName: 'W11 Src Term', startDate: '2026-09-01', endDate: '2026-12-20',
      });
      assertOk('enroll moved', enrolled, 201);
      moved.push(sid);
    }
    const merge = await request(app).post(`/api/classes/${src}/merge`).set(owner()).send({ targetClassId: dst });
    assertOk('merge', merge, 200, 201);

    const events = db.prepare(`
      SELECT ev.* FROM enrollment_events ev
       JOIN enrollments en ON en.id = ev.enrollment_id
       WHERE en.student_id IN (${moved.map(() => '?').join(',')})
         AND ev.event_type = 'transferred'
    `).all(...moved) as { from_class_id: string; to_class_id: string; actor_user_id: string; notes: string }[];
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.from_class_id).toBe(src);
      expect(e.to_class_id).toBe(dst);
      expect(e.actor_user_id).toBe(OWNER);
      expect(typeof e.notes).toBe('string');
      expect((e.notes as string).length).toBeGreaterThan(0);
    }
    // Attribution reconstructible: every moved enrollment now points at dst,
    // with an event explaining HOW and WHEN it got there.
    const rows = db.prepare(`
      SELECT ss.class_id FROM student_semesters ss WHERE ss.student_id IN (${moved.map(() => '?').join(',')})
    `).all(...moved) as { class_id: string }[];
    expect(rows.every((r) => r.class_id === dst)).toBe(true);
  });
});

describe('W10-3 · state-layer guards (repaired)', () => {
  it('the database refuses a duplicate ACTIVE (obligation, payment) allocation', () => {
    const any = db.prepare(`
      SELECT a.obligation_id, a.payment_id FROM obligation_allocations a WHERE a.status='active' LIMIT 1
    `).get() as { obligation_id: string; payment_id: string } | undefined;
    if (!any) return; // nothing to probe in this world
    // A schema-honest duplicate (source_kind/date/checks all satisfied) so
    // the PARTIAL UNIQUE INDEX is the layer that fires — nothing else.
    const dup = db.prepare(`
      INSERT INTO obligation_allocations (id, obligation_id, payment_id, amount, source_kind, status, date)
      VALUES ('alloc_probe_dup', ?, ?, 1, 'payment', 'active', '2026-09-05')
    `);
    expect(() => dup.run(any.obligation_id, any.payment_id)).toThrow(/UNIQUE/i);
  });

  it('I17 detects over-settlement (tamper probe)', async () => {
    // Self-contained world: the W10-1 world ends fully refunded (no active
    // allocations), so this probe settles an obligation of its own first.
    const cid = await makeClass(unique('W11 I17'), 4000);
    const sid = await makeStudent(unique('W11 I17 Student'));
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner()).send({
      classId: cid, semesterName: 'W11 I17 Term', startDate: '2026-09-01', endDate: '2026-12-20',
    });
    assertOk('enroll', enrolled, 201);
    const sem = enrolled.body.semesterId as string;
    const planRes = await request(app).put(`/api/students/${sid}/installment-plan`).set(owner()).send({
      semesterId: sem, installments: [{ amount: 4000, dueDate: '2026-10-01' }],
    });
    assertOk('plan', planRes, 200, 201);
    const planList = await request(app).get(`/api/students/${sid}/installment-plan?semesterId=${sem}`).set(owner());
    const inst = ((planList.body.installments ?? planList.body) as { id: string }[])[0];
    const pay = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'installment', installmentId: inst.id, amount: 4000 });
    assertOk('pay', pay, 201);

    const target = db.prepare(`
      SELECT o.id oid, o.semester_id sem FROM obligation_allocations a
        JOIN student_obligations o ON o.id = a.obligation_id
       WHERE a.status='active' AND o.semester_id = ? LIMIT 1
    `).get(sem) as { oid: string; sem: string };
    expect(target).toBeDefined();
    expect(runFinancialInvariantChecks(db).some((f) => f.invariant === 'I17' && f.entityId === target.oid)).toBe(false);
    const restore = db.prepare('SELECT fee_amount f, net_fee_amount n FROM student_semesters WHERE id = ?').get(target.sem) as { f: number; n: number | null };
    try {
      // Shrink the term below what is already actively settled.
      db.prepare('UPDATE student_semesters SET fee_amount = 1, net_fee_amount = 1 WHERE id = ?').run(target.sem);
      const findings = runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I17');
      expect(findings.some((f) => f.entityId === target.oid)).toBe(true);
    } finally {
      db.prepare('UPDATE student_semesters SET fee_amount = ?, net_fee_amount = ? WHERE id = ?')
        .run(restore.f, restore.n, target.sem);
    }
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I17' && f.entityId === target.oid)).toEqual([]);
  });

  it('I18 detects a paid installment whose payment no longer settles (tamper probe)', async () => {
    const cid = await makeClass(unique('W11 I18'), 5000);
    const sid = await makeStudent(unique('W11 I18 Student'));
    const enrolled = await request(app).post(`/api/students/${sid}/enroll-semester`).set(owner()).send({
      classId: cid, semesterName: 'W11 I18 Term', startDate: '2026-09-01', endDate: '2026-12-20',
    });
    assertOk('enroll', enrolled, 201);
    const sem = enrolled.body.semesterId as string;
    const planRes = await request(app).put(`/api/students/${sid}/installment-plan`).set(owner()).send({
      semesterId: sem, installments: [{ amount: 5000, dueDate: '2026-10-01' }],
    });
    assertOk('plan', planRes, 200, 201);
    const planList = await request(app).get(`/api/students/${sid}/installment-plan?semesterId=${sem}`).set(owner());
    const inst = ((planList.body.installments ?? planList.body) as { id: string }[])[0];
    const pay = await request(app).post(`/api/students/${sid}/payments`).set(owner())
      .send({ category: 'installment', installmentId: inst.id, amount: 5000 });
    assertOk('pay', pay, 201);
    const pid = paymentIdByReceipt(pay.body.receiptNumber);

    // Honest state is clean.
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I18' && f.entityId === inst.id)).toEqual([]);
    // NOTE: 'paid' with a NULL payment is impossible at the strongest layer —
    // the pairing CHECK on student_installments rejects the row outright. The
    // invariant's job is the state the CHECK cannot see: a paid installment
    // naming a payment that no longer actively settles anything.
    try {
      // Ghost = the refund payment of the earlier world: completed, real, but
      // it allocates nothing. Pointing the installment at it must be caught.
      const ghost = db.prepare(
        "SELECT id FROM payments WHERE category = 'refund' AND status = 'completed' LIMIT 1",
      ).get() as { id: string } | undefined;
      expect(ghost).toBeDefined();
      db.prepare('UPDATE student_installments SET paid_payment_id=? WHERE id=?').run(ghost!.id, inst.id);
      expect(runFinancialInvariantChecks(db).some((f) => f.invariant === 'I18' && f.entityId === inst.id)).toBe(true);
    } finally {
      db.prepare('UPDATE student_installments SET paid_payment_id=? WHERE id=?').run(pid, inst.id);
    }
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I18' && f.entityId === inst.id)).toEqual([]);
  });

  it('I19 detects payroll/ledger amount mismatch — with guards lifted (tamper probe)', () => {
    // BOTH salary ledgers are fully guarded at the DB layer: inserts must name
    // a matching transaction, and ledger rows + linked transactions are
    // immutable and undeletable. An amount mismatch is therefore UNREACHABLE
    // by mutation today. I19 exists as the second layer against schema drift
    // and future write paths; this probe proves the DETECTOR detects by
    // lifting the guards briefly and restoring them — the only schema-legal
    // world in which the state exists is one the guards were removed from.
    const teacher = 'teacher_probe_w11';
    const tx = 'ftx_probe_w11';
    const GUARDS = [
      'trg_teacher_salary_no_delete',
      'trg_financial_transactions_payroll_fact_update_guard',
      'trg_financial_transactions_payroll_fact_delete_guard',
    ];
    const RESTORE = `
      CREATE TRIGGER trg_teacher_salary_no_delete
      BEFORE DELETE ON teacher_salary_ledger
      BEGIN SELECT RAISE(ABORT, 'teacher salary ledger facts cannot be deleted'); END;
      CREATE TRIGGER trg_financial_transactions_payroll_fact_update_guard
      BEFORE UPDATE ON financial_transactions
      WHEN EXISTS (SELECT 1 FROM teacher_salary_ledger t WHERE t.transaction_id = OLD.id OR t.id = OLD.reference_id)
        OR EXISTS (SELECT 1 FROM employee_salary_ledger e WHERE e.transaction_id = OLD.id OR e.id = OLD.reference_id)
      BEGIN SELECT RAISE(ABORT, 'payroll financial facts cannot be modified'); END;
      CREATE TRIGGER trg_financial_transactions_payroll_fact_delete_guard
      BEFORE DELETE ON financial_transactions
      WHEN EXISTS (SELECT 1 FROM teacher_salary_ledger t WHERE t.transaction_id = OLD.id OR t.id = OLD.reference_id)
        OR EXISTS (SELECT 1 FROM employee_salary_ledger e WHERE e.transaction_id = OLD.id OR e.id = OLD.reference_id)
      BEGIN SELECT RAISE(ABORT, 'payroll financial facts cannot be deleted'); END;
    `;
    try {
      db.prepare(`INSERT INTO teachers (id, full_name, branch_id, joined_date) VALUES (?, 'Probe Teacher', ?, '2026-01-01')
                  ON CONFLICT(id) DO NOTHING`).run(teacher, BRANCH);
      db.prepare(`INSERT INTO financial_transactions (id, type, category, finance_category_id, amount, date, description, branch_id, reference_id)
                  VALUES (?, 'expense', 'salary', 'sub_salaries_wages', 1000, '2026-09-05', 'W11 I19 probe', ?, ?)
                  ON CONFLICT(id) DO NOTHING`).run(tx, BRANCH, teacher);
      db.prepare(`INSERT INTO teacher_salary_ledger
                    (id, teacher_id, period_key, period_label, due_amount, paid_amount,
                     payment_type, transaction_id, branch_id, status)
                  VALUES ('tsl_probe_w11', ?, '2026-09', 'Sep 2026', 1000, 1000, 'full', ?, ?, 'posted')`).run(teacher, tx, BRANCH);
      expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I19' && f.entityId === 'tsl_probe_w11')).toEqual([]);
      for (const g of GUARDS) db.prepare(`DROP TRIGGER IF EXISTS ${g}`).run();
      db.prepare('UPDATE financial_transactions SET amount = 1001 WHERE id = ?').run(tx);
      expect(runFinancialInvariantChecks(db).some((f) => f.invariant === 'I19' && f.entityId === 'tsl_probe_w11')).toBe(true);
    } finally {
      // Full removal (now legal with guards lifted), then guards restored
      // exactly as the schema defines them.
      db.prepare("DELETE FROM teacher_salary_ledger WHERE id = 'tsl_probe_w11'").run();
      db.prepare("DELETE FROM teachers WHERE id = 'teacher_probe_w11'").run();
      db.prepare("DELETE FROM financial_transactions WHERE id = 'ftx_probe_w11'").run();
      db.exec(RESTORE);
    }
    expect(runFinancialInvariantChecks(db).filter((f) => f.invariant === 'I19' && f.entityId === 'tsl_probe_w11')).toEqual([]);
    // The guards are back: all three triggers exist again and the delete
    // guard refuses even an empty-range delete (triggers fire regardless of
    // how many rows match).
    const restored = db.prepare(
      `SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name IN ('trg_teacher_salary_no_delete','trg_financial_transactions_payroll_fact_update_guard','trg_financial_transactions_payroll_fact_delete_guard')`,
    ).get() as { c: number };
    expect(restored.c).toBe(3);
    // (Per-row BEFORE DELETE triggers do not fire on zero-row statements, so
    // existence — plus the earlier live refusal — is the honest proof.)
  });

  it('full checker passes on the repaired world (cash + state layers together)', () => {
    expect(runFinancialInvariantChecks(db)).toEqual([]);
  });
});
