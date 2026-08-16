/**
 * Concurrency proof for the GUARDED payment categories.
 * ============================================================================
 * WHY THIS FILE EXISTS
 *
 * `student-financial-idempotency.test.ts` claims to lock in duplicate-payment
 * protection, and it passed — but every one of its concurrency cases used
 * `category: 'other'` or `'exam'`, which are exactly the categories the route
 * EXEMPTS from its guard. The guarded categories (fee / installment / book /
 * card / diploma / placement) were never raced by any test.
 *
 * Meanwhile production wrote `idempotency_key = NULL` for those same guarded
 * categories. SQLite treats every NULL as distinct in a UNIQUE index, so
 * `uq_payments_idempotency` — documented in the route as the "atomic backstop"
 * — could never fire for them. A live attack proved the consequence: 12
 * concurrent identical un-keyed `fee` requests produced 12 payments and 12
 * income rows, 12,000 AFN of revenue fabricated from one 1,000 AFN intent.
 *
 * 715 tests passed against that. This file closes the gap: it races the
 * categories that actually carry money, and asserts the counter-invariant that
 * genuine repeat business is still allowed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getStudentBalance } from '../utils/studentBalance.js';

const BRANCH = 'guard_conc_branch';
const CLASS_ID = 'guard_conc_class';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
const user = (): TokenPayload => ({
  userId: 'u_guard_conc', username: 'guard_conc', role: 'manager',
  branchId: BRANCH, fullName: 'Guard Conc Mgr',
});
const auth = () => ({ Authorization: `Bearer ${signToken(user())}` });

let app: express.Express;
let seq = 0;

async function newStudent(name: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: name, phone: `0788${String(100000 + seq).slice(-6)}`, gender: 'male', branchId: BRANCH,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Enrols the student and returns the semester id. */
async function enrol(studentId: string, tuition: number): Promise<string> {
  const res = await supertest(app).post(`/api/students/${studentId}/enroll-semester`).set(auth())
    .send({ semesterName: 'Term', classId: CLASS_ID, tuitionAmount: tuition, amountPaidNow: 0 });
  expect(res.status).toBe(201);
  return res.body.semesterId as string;
}

const paymentsOf = (sid: string) =>
  db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id = ?`)
    .get(sid) as { c: number; s: number };

const incomeOf = (sid: string) =>
  db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s
       FROM financial_transactions
      WHERE type = 'income' AND payment_id IN (SELECT id FROM payments WHERE student_id = ?)`,
  ).get(sid) as { c: number; s: number };

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Guard Conc Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`,
  ).run('u_guard_conc', 'guard_conc', 'Guard Conc Mgr', BRANCH, await hashPassword('x'));
  db.prepare(
    `INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,lifecycle_stage,schedule_time,fee)
     VALUES (?,?,'A1',?,'active','in_progress','08:00',1000)`,
  ).run(CLASS_ID, 'Guard Conc Class', BRANCH);
  syncLegacyUserRoles(db);
  app = createApp();
});

// ══════════════════════════════════════════════════════════════════════════
// THE DEFECT: guarded categories under concurrency
// ══════════════════════════════════════════════════════════════════════════
describe('guarded categories collapse concurrent duplicates', () => {
  it('12 concurrent un-keyed `fee` payments create exactly ONE payment and ONE income row', async () => {
    const sid = await newStudent('Fee Racer');
    const semesterId = await enrol(sid, 60_000);

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        supertest(app).post(`/api/students/${sid}/payments`).set(auth())
          .send({ amount: 1000, category: 'fee', semesterId, paymentMethod: 'cash' }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200);
    // Exactly one winner; every loser replays the winner's receipt.
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(11);
    for (const r of replayed) {
      expect(r.body.idempotentReplay).toBe(true);
      expect(r.body.receiptNumber).toBe(created[0].body.receiptNumber);
    }

    expect(paymentsOf(sid)).toMatchObject({ c: 1, s: 1000 });
    expect(incomeOf(sid)).toMatchObject({ c: 1, s: 1000 });
  });

  it('never persists a NULL idempotency key — the unique index must be able to arbitrate', async () => {
    const sid = await newStudent('Key Persistence');
    const semesterId = await enrol(sid, 20_000);
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .send({ amount: 500, category: 'fee', semesterId, paymentMethod: 'cash' });

    const nulls = db.prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE student_id = ? AND (idempotency_key IS NULL OR TRIM(idempotency_key) = '')`,
    ).get(sid) as { c: number };
    expect(nulls.c).toBe(0);
  });

  it('the database itself rejects a NULL idempotency key (integrity boundary, not convention)', () => {
    const sid = db.prepare(`SELECT id, branch_id FROM students LIMIT 1`).get() as { id: string; branch_id: string };
    expect(() =>
      db.prepare(
        `INSERT INTO payments (id,student_id,amount,date,payment_method,status,category,branch_id)
         VALUES ('guard_null_probe',?,100,'2026-01-01','cash','completed','other',?)`,
      ).run(sid.id, sid.branch_id),
    ).toThrow(/idempotency_key is required/i);
  });

  it('concurrent ID-card issuance books the fee at most once', async () => {
    const sid = await newStudent('Card Racer');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        supertest(app).post(`/api/students/${sid}/issue-card`).set(auth()).send({ cardDesign: { c: 1 } }),
      ),
    );
    for (const r of responses) expect(r.status).toBe(201);
    const cardFees = db.prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE student_id = ? AND category = 'card'`,
    ).get(sid) as { c: number };
    expect(cardFees.c).toBeLessThanOrEqual(1);
  });

  it('concurrent payments can never exceed the semester debt', async () => {
    const sid = await newStudent('Overpay Racer');
    const semesterId = await enrol(sid, 5_000);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        supertest(app).post(`/api/students/${sid}/payments`).set(auth())
          // Distinct keys: each is a legitimate separate intent, so only the
          // debt ceiling — not idempotency — may stop the overcharge.
          .set('Idempotency-Key', `overpay-${i}`)
          .send({ amount: 4000, category: 'fee', semesterId, paymentMethod: 'cash' }),
      ),
    );
    const total = paymentsOf(sid).s;
    expect(total).toBeLessThanOrEqual(5_000);
    expect(getStudentBalance(db, sid, 'active').outstanding).toBeGreaterThanOrEqual(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// COUNTER-INVARIANT — the fix must not block real business
// ══════════════════════════════════════════════════════════════════════════
describe('legitimate repeat business still succeeds on guarded categories', () => {
  it('two genuine installments of the SAME amount both charge when keyed distinctly', async () => {
    const sid = await newStudent('Twin Installments');
    const semesterId = await enrol(sid, 60_000);
    const send = (key: string) =>
      supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', key)
        .send({ amount: 1000, category: 'fee', semesterId, paymentMethod: 'cash' });

    const a = await send('installment-one');
    const b = await send('installment-two');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.receiptNumber).not.toBe(b.body.receiptNumber);
    expect(paymentsOf(sid)).toMatchObject({ c: 2, s: 2000 });
  });

  it('a fully-paid semester still returns a precise error, not a silent replay', async () => {
    const sid = await newStudent('Paid In Full');
    const semesterId = await enrol(sid, 3_000);
    const payoff = await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .set('Idempotency-Key', 'payoff').send({ amount: 3000, category: 'fee', semesterId, paymentMethod: 'cash' });
    expect(payoff.status).toBe(201);

    const extra = await supertest(app).post(`/api/students/${sid}/payments`).set(auth())
      .set('Idempotency-Key', 'extra').send({ amount: 100, category: 'fee', semesterId, paymentMethod: 'cash' });
    // The operator must be told WHY, not handed a stale success.
    expect([400, 409]).toContain(extra.status);
    expect(String(extra.body.error)).toMatch(/already fully paid/i);
  });

  it('a reused Idempotency-Key across two students is REFUSED, never silently swallowed', async () => {
    // Found in the final adversarial pass. The replay lookup matched on the key
    // alone, so reusing one key for two different students returned the FIRST
    // student's receipt for the SECOND student's genuine payment: 200 OK, a
    // receipt number that belonged to someone else, and the money never booked.
    // Client keys are caller-controlled, so this was reachable by a bug or by
    // an attacker wanting a payment to disappear.
    const one = await newStudent('Key Collide One');
    const two = await newStudent('Key Collide Two');
    const semOne = await enrol(one, 9_000);
    const semTwo = await enrol(two, 9_000);
    const key = 'shared-across-students';

    const first = await supertest(app).post(`/api/students/${one}/payments`).set(auth())
      .set('Idempotency-Key', key).send({ amount: 700, category: 'fee', semesterId: semOne, paymentMethod: 'cash' });
    expect(first.status).toBe(201);

    const second = await supertest(app).post(`/api/students/${two}/payments`).set(auth())
      .set('Idempotency-Key', key).send({ amount: 700, category: 'fee', semesterId: semTwo, paymentMethod: 'cash' });

    // Must NOT be a 200 replay carrying the other student's receipt.
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/different student/i);
    expect(second.body.receiptNumber).toBeUndefined();
    // And the second student must still owe the money.
    expect(paymentsOf(two).c).toBe(0);
  });

  it('the SAME student replaying their own key still collapses to one charge', async () => {
    const sid = await newStudent('Own Key Replay');
    const semesterId = await enrol(sid, 9_000);
    const body = { amount: 600, category: 'fee', semesterId, paymentMethod: 'cash' };
    const a = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', 'own-key').send(body);
    const b = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', 'own-key').send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.idempotentReplay).toBe(true);
    expect(b.body.receiptNumber).toBe(a.body.receiptNumber);
    expect(paymentsOf(sid)).toMatchObject({ c: 1, s: 600 });
  });

  it('a different amount is a different intent and is charged', async () => {
    const sid = await newStudent('Varied Amounts');
    const semesterId = await enrol(sid, 60_000);
    const base = { category: 'fee', semesterId, paymentMethod: 'cash' };
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ ...base, amount: 1000 });
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ ...base, amount: 2500 });
    expect(paymentsOf(sid)).toMatchObject({ c: 2, s: 3500 });
  });
});
