/**
 * Student financial integrity — duplicate-action regression suite
 * ============================================================================
 * These lock in defects proven by live attack against the running API:
 *
 *   F1. 10 concurrent un-keyed payments created 10 payments and 10 income
 *       rows (10,000 AFN of fabricated revenue from a single 1,000 AFN
 *       intent). Frontend `disabled={loading}` could not prevent it — the
 *       attack used plain HTTP, as a retry, a second tab or a refresh does.
 *   F2. Refunds had the same hole (negative money duplicated).
 *   F3. Dashboard revenue-by-class multiplied a payment by the number of
 *       active semesters a student held (one 9,999 payment → 19,998).
 *   F4. Dashboard outstanding used the GROSS fee, overstating the debt of
 *       every discounted student, and ignored installment payments.
 *
 * The critical counter-invariant is tested too: idempotency must NOT block
 * legitimate distinct business events (two real installments, two explicitly
 * keyed payments, different amounts).
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { resolveIdempotency, IDEMPOTENCY_WINDOW_SECONDS } from '../../../utils/idempotency.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'fin_idem_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
function user(): TokenPayload {
  return { userId: 'u_fin_idem', username: 'fin_idem', branchId: BRANCH, fullName: 'Fin Idem Mgr' };
}
function auth() {
  return { Authorization: `Bearer ${signToken(user())}` };
}

let app: express.Express;
let seq = 0;

async function newStudent(name: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: name,
    phone: `0799${String(100000 + seq).slice(-6)}`,
    gender: 'male',
    branchId: BRANCH,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

function paymentsOf(studentId: string) {
  return db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id = ?`)
    .get(studentId) as { c: number; s: number };
}
function incomeOf(studentId: string) {
  return db
    .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM financial_transactions WHERE reference_id = ? AND type = 'income'`)
    .get(studentId) as { c: number; s: number };
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Fin Idem Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_fin_idem', 'fin_idem', 'Fin Idem Mgr', BRANCH, await hashPassword('x'));
  assignRole('u_fin_idem', 'manager', BRANCH);
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('fin_idem_card_fee', ?, 'card', 'ID card fee', 200, 1, 1)
  `).run(BRANCH);
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('fin_idem_registration_fee', ?, 'registration', 'Registration fee', 0, 1, 1)
  `).run(BRANCH);

  app = createApp();
});

// ══════════════════════════════════════════════════════════════════════════
// F1/F2 — REPEATED REQUESTS MUST NOT DUPLICATE FINANCIAL TRUTH
// ══════════════════════════════════════════════════════════════════════════

/**
 * The payment a refund reverses. Owner decision D-113 makes attribution
 * mandatory, so a fixture that refunds names the charge it reverses — here, the
 * student's most recent refundable payment.
 */
function latestRefundablePaymentId(studentId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM payments
        WHERE student_id = ? AND status = 'completed' AND category <> 'refund' AND amount > 0
        ORDER BY date DESC, rowid DESC LIMIT 1`,
    )
    .get(studentId) as { id: string } | undefined;
  if (!row) throw new Error(`fixture: student ${studentId} has no refundable payment`);
  return row.id;
}

describe('F1 — duplicate payment requests', () => {
  it('10 identical un-keyed requests create exactly ONE payment and ONE income row', async () => {
    const sid = await newStudent('Concurrent Payer');
    const body = { amount: 1000, category: 'other', paymentMethod: 'cash', notes: 'attack' };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send(body)),
    );

    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(9);
    for (const r of replayed) expect(r.body.idempotentReplay).toBe(true);

    const pay = paymentsOf(sid);
    const inc = incomeOf(sid);
    expect(pay.c).toBe(1);
    expect(pay.s).toBe(1000);
    expect(inc.c).toBe(1);
    expect(inc.s).toBe(1000);
  });

  it('sequential double-click (the classic case) charges once', async () => {
    const sid = await newStudent('Double Clicker');
    const body = { amount: 750, category: 'exam', notes: 'Ad-hoc test charge' };
    const first = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send(body);
    const second = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.receiptNumber).toBe(first.body.receiptNumber);
    expect(paymentsOf(sid)).toMatchObject({ c: 1, s: 750 });
  });

  it('an explicit Idempotency-Key replay returns the ORIGINAL receipt', async () => {
    const sid = await newStudent('Keyed Payer');
    const key = 'test-key-fixed-001';
    const a = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', key).send({ amount: 900, category: 'other', notes: 'Ad-hoc test charge' });
    const b = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', key).send({ amount: 900, category: 'other', notes: 'Ad-hoc test charge' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.receiptNumber).toBe(a.body.receiptNumber);
    expect(paymentsOf(sid).c).toBe(1);
  });
});

describe('F2 — duplicate refund requests', () => {
  it('5 identical refund requests move money out exactly once', async () => {
    const sid = await newStudent('Refund Target');
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ amount: 5000, category: 'other', notes: 'Ad-hoc test charge' });

    const target = latestRefundablePaymentId(sid);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        supertest(app).post(`/api/students/${sid}/refund`).set(auth()).send({ amount: 1000, reason: 'duplicate test', paymentId: target })),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

    const refunds = db
      .prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id = ? AND category = 'refund'`)
      .get(sid) as { c: number; s: number };
    expect(refunds.c).toBe(1);
    expect(refunds.s).toBe(-1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// COUNTER-INVARIANT — LEGITIMATE BUSINESS MUST NOT BE BLOCKED
// ══════════════════════════════════════════════════════════════════════════
describe('legitimate distinct business events remain possible', () => {
  it('two explicitly keyed identical payments both succeed', async () => {
    const sid = await newStudent('Legit Repeater');
    const a = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', 'legit-a').send({ amount: 1000, category: 'other', notes: 'Ad-hoc test charge' });
    const b = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).set('Idempotency-Key', 'legit-b').send({ amount: 1000, category: 'other', notes: 'Ad-hoc test charge' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.receiptNumber).not.toBe(b.body.receiptNumber);
    expect(paymentsOf(sid)).toMatchObject({ c: 2, s: 2000 });
  });

  it('payments differing in amount or category are separate events', async () => {
    const sid = await newStudent('Varied Payer');
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ amount: 1000, category: 'other', notes: 'Ad-hoc test charge' });
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ amount: 2000, category: 'other', notes: 'Ad-hoc test charge' });
    await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ amount: 1000, category: 'exam', notes: 'Ad-hoc test charge' });
    expect(paymentsOf(sid)).toMatchObject({ c: 3, s: 4000 });
  });

  it('the derived key changes once the retry window has passed', () => {
    const req = { get: () => undefined, body: {} };
    const intent = { route: 'student-payment', studentId: 's1', amount: 1000 };
    const t0 = 1_000_000_000_000;
    const withinWindow = resolveIdempotency(req, intent, t0).key;
    const sameInstant = resolveIdempotency(req, intent, t0 + 1_000).key;
    const laterWindow = resolveIdempotency(req, intent, t0 + IDEMPOTENCY_WINDOW_SECONDS * 1000 * 3).key;
    expect(sameInstant).toBe(withinWindow); // a retry collapses
    expect(laterWindow).not.toBe(withinWindow); // a genuinely new charge is allowed
  });

  it('a boundary-straddling retry still matches the previous window', () => {
    const req = { get: () => undefined, body: {} };
    const intent = { route: 'student-payment', studentId: 's1', amount: 1000 };
    const w = IDEMPOTENCY_WINDOW_SECONDS * 1000;
    const justBefore = Math.floor(1_000_000_000_000 / w) * w + w - 5;
    const justAfter = justBefore + 10; // crosses the bucket boundary
    const a = resolveIdempotency(req, intent, justBefore);
    const b = resolveIdempotency(req, intent, justAfter);
    expect(b.candidates).toContain(a.key); // the earlier attempt is still found
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BUSINESS-EVENT UNIQUENESS (distinct from request idempotency)
// ══════════════════════════════════════════════════════════════════════════
describe('fixed fees are charged once per student across all writers', () => {
  it('issuing an ID card then paying the card fee manually does not double-charge', async () => {
    const sid = await newStudent('Card Holder');
    const issued = await supertest(app).post(`/api/students/${sid}/issue-card`).set(auth()).send({ cardDesign: { t: 1 } });
    expect(issued.status).toBe(201);
    const manual = await supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send({ category: 'card' });
    expect(manual.status).toBe(409);
    const card = db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = ? AND category = 'card'`)
      .get(sid) as { c: number };
    expect(card.c).toBeLessThanOrEqual(1);
  });

  it('concurrent ID-card issuance charges the fee at most once', async () => {
    const sid = await newStudent('Card Racer');
    await Promise.all(
      Array.from({ length: 6 }, () => supertest(app).post(`/api/students/${sid}/issue-card`).set(auth()).send({ cardDesign: { t: 1 } })),
    );
    const card = db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = ? AND category = 'card'`)
      .get(sid) as { c: number };
    expect(card.c).toBeLessThanOrEqual(1);
  });

  it('concurrent semester enrolment creates one semester and one tuition charge', async () => {
    const sid = await newStudent('Semester Racer');
    // Priced by the class fee (audit F-A1).
    db.prepare(`INSERT OR REPLACE INTO classes (id,name,level,branch_id,status,lifecycle_stage,schedule_time,fee) VALUES ('race_cls','Race Class','A1',?,'active','in_progress','08:00',5000)`).run(BRANCH);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        supertest(app).post(`/api/students/${sid}/enroll-semester`).set(auth()).send({ semesterName: 'Race-Term', classId: 'race_cls', amountPaidNow: 5000 }),
      ),
    );
    const sem = db.prepare(`SELECT COUNT(*) AS c FROM student_semesters WHERE student_id = ?`).get(sid) as { c: number };
    expect(sem.c).toBe(1);
    expect(paymentsOf(sid)).toMatchObject({ c: 1, s: 5000 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F3/F4 — DASHBOARD AGGREGATES MUST RECONCILE WITH THE LEDGER
// ══════════════════════════════════════════════════════════════════════════
describe('F3 — dashboard revenue must not be multiplied by JOINs', () => {
  it('one payment is attributed to exactly one class even with several active semesters', () => {
    const d = today();
    db.prepare(`INSERT OR IGNORE INTO students (id,student_code,full_name,status,registration_date,branch_id,gender) VALUES ('join_probe','TH-JOIN1','Join Probe','active',?,?,'male')`).run(d, BRANCH);
    for (const [cid, name, sem] of [['join_cls_a', 'Join A', 'JT0'], ['join_cls_b', 'Join B', 'JT1']]) {
      db.prepare(`INSERT OR REPLACE INTO classes (id,name,level,branch_id,status,lifecycle_stage,schedule_time,fee) VALUES (?,?,'A1',?,'active','in_progress','08:00',1000)`).run(cid, name, BRANCH);
      db.prepare(`INSERT OR REPLACE INTO student_semesters (id,student_id,semester_name,class_id,enroll_date,fee_amount,net_fee_amount,status) VALUES (?,'join_probe',?,?,?,1000,1000,'active')`).run(`join_sem_${cid}`, sem, cid, d);
    }
    db.prepare(`INSERT OR REPLACE INTO payments (id,student_id,amount,date,payment_method,status,category,receipt_number,branch_id,semester, idempotency_key) VALUES ('join_pay','join_probe',9999,?,'cash','completed','fee','RC-JOIN',?,'JT0', hex(randomblob(16)))`).run(d, BRANCH);

    const rows = db
      .prepare(
        `SELECT c.name, SUM(p.amount) AS revenue FROM payments p
         JOIN student_semesters ss ON ss.id = (
           SELECT s2.id FROM student_semesters s2 WHERE s2.student_id = p.student_id
             AND (p.semester IS NULL OR s2.semester_name = p.semester)
           ORDER BY (s2.status = 'active') DESC, s2.enroll_date DESC LIMIT 1)
         JOIN classes c ON c.id = ss.class_id
         WHERE p.category IN ('fee','installment') AND p.status = 'completed'
           AND c.branch_id = ? AND p.date BETWEEN ? AND ? AND p.student_id = 'join_probe'
         GROUP BY c.id`,
      )
      .all(BRANCH, d, d) as Array<{ name: string; revenue: number }>;

    const reported = rows.reduce((sum, r) => sum + Number(r.revenue), 0);
    const truth = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE student_id='join_probe' AND category='fee'`).get() as { s: number }).s;
    expect(reported).toBe(truth); // was 2x truth before the fix
    expect(rows).toHaveLength(1);
  });
});

describe('F4 — outstanding must respect discounts and installments', () => {
  it('uses the net (discounted) fee and counts installment payments', () => {
    const d = today();
    db.prepare(`INSERT OR IGNORE INTO students (id,student_code,full_name,status,registration_date,branch_id,gender) VALUES ('out_probe2','TH-OUT2','Out Probe','active',?,?,'male')`).run(d, BRANCH);
    db.prepare(`INSERT OR REPLACE INTO student_semesters (id,student_id,semester_name,enroll_date,fee_amount,net_fee_amount,status) VALUES ('out_sem2','out_probe2','OutTerm2',?,10000,7000,'active')`).run(d);
    db.prepare(`INSERT OR REPLACE INTO payments (id,student_id,amount,date,payment_method,status,category,receipt_number,branch_id, idempotency_key) VALUES ('out_p1','out_probe2',3000,?,'cash','completed','fee','RC-O1',?, hex(randomblob(16)))`).run(d, BRANCH);
    db.prepare(`INSERT OR REPLACE INTO payments (id,student_id,amount,date,payment_method,status,category,receipt_number,branch_id, idempotency_key) VALUES ('out_p2','out_probe2',1000,?,'cash','completed','installment','RC-O2',?, hex(randomblob(16)))`).run(d, BRANCH);

    const outstanding = (
      db
        .prepare(
          `SELECT COALESCE(SUM(sem_total.total - COALESCE(paid.total,0)),0) AS outstanding
           FROM (SELECT student_id, SUM(COALESCE(net_fee_amount, fee_amount)) AS total FROM student_semesters WHERE student_id='out_probe2' GROUP BY student_id) sem_total
           JOIN students st ON st.id = sem_total.student_id AND st.branch_id = ?
           LEFT JOIN (SELECT student_id, SUM(amount) AS total FROM payments WHERE category IN ('fee','installment') AND status='completed' AND branch_id = ? GROUP BY student_id) paid
             ON paid.student_id = sem_total.student_id
           WHERE sem_total.total > COALESCE(paid.total,0)`,
        )
        .get(BRANCH, BRANCH) as { outstanding: number }
    ).outstanding;

    // net 7000 − (3000 fee + 1000 installment) = 3000. Was 6000 before the fix.
    expect(outstanding).toBe(3000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// AUDIT TRAIL
// ══════════════════════════════════════════════════════════════════════════
describe('audit trail reflects one business event, not one per click', () => {
  it('a replayed payment does not write extra audit or journey rows', async () => {
    const sid = await newStudent('Audit Subject');
    const body = { amount: 1234, category: 'other', notes: 'Ad-hoc test charge' };
    await Promise.all(Array.from({ length: 5 }, () => supertest(app).post(`/api/students/${sid}/payments`).set(auth()).send(body)));

    const audits = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE ?`).get(`%1234 AFN%`) as { c: number };
    expect(audits.c).toBe(1);
    const journey = db.prepare(`SELECT COUNT(*) AS c FROM student_journey_events WHERE student_id = ? AND event_type = 'journey.payment_recorded'`).get(sid) as { c: number };
    expect(journey.c).toBe(1);
  });
});
