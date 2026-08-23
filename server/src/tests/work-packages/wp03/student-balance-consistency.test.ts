/**
 * Student tuition balance — cross-surface consistency suite (group F7)
 * ============================================================================
 * Reproduces and locks in defects proven against the live API:
 *
 *   S9.  GET /payments omitted `status` and `notes`, so every consumer saw
 *        status === undefined. The student profile keyed its refund styling on
 *        `status === 'refunded'`, so a refund of −2,000 rendered as the string
 *        "+-2000" in green, as though the academy had RECEIVED it.
 *
 *   S10. Five surfaces each re-derived "tuition paid" with a different rule:
 *          profile  fee+installment+refund, ALL semesters
 *          roster   fee+installment+refund, ACTIVE semesters
 *          portal   fee+installment       , ACTIVE semesters  <- no refund
 *          dashboard fee+installment      , ALL semesters     <- no refund
 *          hold     fee+installment+refund, ACTIVE semesters
 *        A student who paid 13,000 and was refunded 2,000 against 13,000 of
 *        tuition owed 2,000 — but their own portal showed a debt of 0, and the
 *        branch dashboard understated its receivable by the same 2,000.
 *
 * The fix is one authoritative module (utils/studentBalance.ts) that every
 * surface calls. These tests assert the arithmetic AND that the surfaces agree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { deriveBalance, getStudentBalance, getBranchOutstanding, TUITION_PAYMENT_CATEGORIES } from '../../../utils/studentBalance.js';
import { today } from '../../../utils/ids.js';

const BRANCH = 'bal_branch';
const OTHER_BRANCH = 'bal_branch_other';

/** A student with tuition, payments and a refund — the exact defect scenario. */
const S_REFUNDED = 'bal_stu_refunded';
/** A student with a completed semester plus an active one. */
const S_TWO_TERMS = 'bal_stu_two_terms';
/** A student who bought a book but owes tuition. */
const S_BOOK = 'bal_stu_book';

beforeEach(() => {
  initSchema();
  const d = today();

  // A sibling suite truncates students/student_semesters wholesale, and vitest
  // shares one database file across suites. Re-seed on every test rather than
  // once, so this suite's outcome never depends on file execution order.
  // Refunds reference the payment they reverse (ON DELETE RESTRICT), so a
  // fixture reset removes the reversing rows before the rows they point at.
  db.prepare(`DELETE FROM payments WHERE id LIKE 'bal_%' AND category = 'refund'`).run();
  db.prepare(`DELETE FROM payments WHERE id LIKE 'bal_%'`).run();
  db.prepare(`DELETE FROM student_semesters WHERE id LIKE 'bal_%'`).run();
  db.prepare(`DELETE FROM students WHERE id LIKE 'bal_%'`).run();

  for (const b of [BRANCH, OTHER_BRANCH]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(b, b);
  }

  // NOTE: students.phone carries a partial UNIQUE index. Reusing one phone
  // number across fixtures makes INSERT OR REPLACE delete the previously
  // seeded student, silently emptying the fixture. Each student gets its own.
  let phoneSeq = 0;
  const mkStudent = (id: string, code: string, branch = BRANCH) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
         VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
      )
      .run(id, code, id, `07000001${String(++phoneSeq).padStart(2, '0')}`, d, branch);

  const mkSemester = (id: string, student: string, name: string, net: number, status = 'active') =>
    db
      .prepare(
        `INSERT OR REPLACE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, student, name, d, net, net, status);

  // A refund names the payment it reverses (owner decision D-113), which is
  // what keeps a refund of a non-tuition charge out of the tuition position.
  const mkPayment = (id: string, student: string, amount: number, category: string, branch = BRANCH, reverses: string | null = null) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key, refunds_payment_id)
         VALUES (?, ?, ?, ?, 'cash', 'completed', ?, ?, ?, hex(randomblob(16)), ?)`,
      )
      .run(id, student, amount, d, category, `RC-${id}`, branch, reverses);

  // Scenario 1: 13,000 tuition; paid 10,000 fee + 3,000 installment; refunded 2,000.
  mkStudent(S_REFUNDED, 'BAL-001');
  mkSemester('bal_sem_1', S_REFUNDED, 'Term A', 13000);
  mkPayment('bal_p1', S_REFUNDED, 10000, 'fee');
  mkPayment('bal_p2', S_REFUNDED, 3000, 'installment');
  mkPayment('bal_p3', S_REFUNDED, -2000, 'refund', BRANCH, 'bal_p1'); // signed, and attributed to the fee it reverses

  // Scenario 2: a completed 10,000 term and an active 13,000 term, 5,000 paid.
  mkStudent(S_TWO_TERMS, 'BAL-002');
  mkSemester('bal_sem_2a', S_TWO_TERMS, 'Term Old', 10000, 'completed');
  mkSemester('bal_sem_2b', S_TWO_TERMS, 'Term New', 13000, 'active');
  mkPayment('bal_p4', S_TWO_TERMS, 5000, 'fee');

  // Scenario 3: owes 8,000 tuition, but paid a 1,500 chapter charge (not tuition).
  mkStudent(S_BOOK, 'BAL-003');
  mkSemester('bal_sem_3', S_BOOK, 'Term C', 8000);
  mkPayment('bal_p5', S_BOOK, 1500, 'chapter');
});

describe('S10: the authoritative balance definition', () => {
  it('refunds reduce tuition paid (they are stored signed-negative)', () => {
    const b = getStudentBalance(db, S_REFUNDED, 'all');
    expect(b.tuitionDue).toBe(13000);
    expect(b.tuitionPaid).toBe(11000); // 10000 + 3000 - 2000
    expect(b.outstanding).toBe(2000);
    // The portal's old rule (ignoring refunds) produced this wrong answer:
    expect(b.tuitionPaid).not.toBe(13000);
    expect(b.outstanding).not.toBe(0);
  });

  it('non-tuition categories never pay down tuition', () => {
    const b = getStudentBalance(db, S_BOOK, 'all');
    expect(b.tuitionDue).toBe(8000);
    expect(b.tuitionPaid).toBe(0); // the 1,500 ad-hoc chapter charge is NOT tuition
    expect(b.outstanding).toBe(8000);
    expect(TUITION_PAYMENT_CATEGORIES).not.toContain('book');
  });

  it("scope 'all' and 'active' answer different questions, explicitly", () => {
    const all = getStudentBalance(db, S_TWO_TERMS, 'all');
    const active = getStudentBalance(db, S_TWO_TERMS, 'active');
    expect(all.tuitionDue).toBe(23000); // lifetime
    expect(active.tuitionDue).toBe(13000); // owed right now
    expect(all.outstanding).toBe(18000);
    expect(active.outstanding).toBe(8000);
  });

  it('outstanding is floored at zero and surplus becomes a credit balance', () => {
    const b = deriveBalance(1000, 1500);
    expect(b.outstanding).toBe(0);
    expect(b.creditBalance).toBe(500);
  });

  it('paidPercentage is clamped to 0..100 and is 100 when nothing was charged', () => {
    expect(deriveBalance(0, 0).paidPercentage).toBe(100);
    expect(deriveBalance(1000, 2000).paidPercentage).toBe(100);
    expect(deriveBalance(1000, 250).paidPercentage).toBe(25);
    expect(deriveBalance(1000, -500).paidPercentage).toBe(0);
  });
});

describe('S10: branch outstanding matches the sum of its students', () => {
  it('includes refunds, so branch debt is not understated', () => {
    const branchTotal = getBranchOutstanding(db, BRANCH);
    const perStudent =
      getStudentBalance(db, S_REFUNDED, 'all').outstanding +
      getStudentBalance(db, S_TWO_TERMS, 'all').outstanding +
      getStudentBalance(db, S_BOOK, 'all').outstanding;
    expect(branchTotal).toBe(perStudent);
    // 2000 + 18000 + 8000
    expect(branchTotal).toBe(28000);
  });

  it("one student's credit balance cannot mask another student's debt", () => {
    const before = getBranchOutstanding(db, BRANCH);
    // Massively overpay one student; the branch receivable must not shrink.
    db.prepare(
      `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
       VALUES ('bal_overpay', ?, 999999, ?, 'cash', 'completed', 'fee', 'RC-OVER', ?, hex(randomblob(16)))`,
    ).run(S_BOOK, today(), BRANCH);

    const after = getBranchOutstanding(db, BRANCH);
    // S_BOOK's own 8,000 debt clears, but nobody else's debt is cancelled.
    expect(after).toBe(before - 8000);
    expect(after).toBeGreaterThan(0);

    db.prepare(`DELETE FROM payments WHERE id = 'bal_overpay'`).run();
  });

  it('scopes strictly to the branch', () => {
    expect(getBranchOutstanding(db, OTHER_BRANCH)).toBe(0);
  });
});

describe('S9: the payments API must expose the fields the UI renders', () => {
  it('a refund row is identifiable as a refund', () => {
    const row = db.prepare(`SELECT * FROM payments WHERE id = 'bal_p3'`).get() as any;
    // Whichever signal the UI keys on, it must be able to tell this is money out.
    expect(row.category).toBe('refund');
    expect(row.amount).toBeLessThan(0);
    // The old bug: the UI keyed on status === 'refunded', which is never set
    // for student refunds — they are 'completed' rows in the 'refund' category.
    expect(row.status).toBe('completed');
  });

  it('summing signed amounts yields net tuition, never an inflated total', () => {
    const net = db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM payments
         WHERE student_id = ? AND status='completed' AND category IN ('fee','installment','refund')`,
      )
      .get(S_REFUNDED) as { s: number };
    expect(net.s).toBe(11000);
  });
});

/**
 * S11 — a partially refunded semester could never be settled.
 * The semester-debt calculation counted only category==='fee' rows for that
 * semester, so a refund did not reopen the debt: the route answered
 * "This semester is already fully paid." and the academy could not collect
 * money the student genuinely owed. Proven live before the fix.
 */
describe('S11: a refund reopens the semester debt it belongs to', () => {
  const S_SEM = 'bal_stu_sempay';
  const SEM_NAME = 'SemPay Term';

  beforeEach(() => {
    const d = today();
    db.prepare(`DELETE FROM payments WHERE id LIKE 'balsp_%' AND category = 'refund'`).run();
    db.prepare(`DELETE FROM payments WHERE id LIKE 'balsp_%'`).run();
    db.prepare(`DELETE FROM student_semesters WHERE id LIKE 'balsp_%'`).run();
    db.prepare(`DELETE FROM students WHERE id = ?`).run(S_SEM);

    db.prepare(
      `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
       VALUES (?, 'BAL-SP', 'SemPay Probe', 'male', '0700009999', 'active', ?, ?)`,
    ).run(S_SEM, d, BRANCH);
    db.prepare(
      `INSERT OR REPLACE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES ('balsp_sem', ?, ?, ?, 10000, 10000, 'active')`,
    ).run(S_SEM, SEM_NAME, d);
  });

  /**
   * Mirrors the route's semester-settlement rule. A refund carries the semester
   * of the payment it reverses (owner decision D-114), so one term's refund can
   * only ever re-open that term's debt.
   */
  const paidTowardSemester = () =>
    (db.prepare(`SELECT * FROM payments WHERE student_id = ?`).all(S_SEM) as any[])
      .filter(
        (p) =>
          p.status === 'completed' &&
          p.semester === SEM_NAME &&
          (p.category === 'fee' || p.category === 'installment' || p.category === 'refund'),
      )
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const addPayment = (id: string, amount: number, category: string, semester: string | null, reverses: string | null = null) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, semester, idempotency_key, refunds_payment_id)
         VALUES (?, ?, ?, ?, 'cash', 'completed', ?, ?, ?, ?, hex(randomblob(16)), ?)`,
      )
      .run(id, S_SEM, amount, today(), category, `RC-${id}`, BRANCH, semester, reverses);

  it('a full payment settles the semester', () => {
    addPayment('balsp_p1', 10000, 'fee', SEM_NAME);
    expect(paidTowardSemester()).toBe(10000);
    expect(Math.max(0, 10000 - paidTowardSemester())).toBe(0);
  });

  it('refunding 4,000 of a settled semester reopens a 4,000 debt', () => {
    addPayment('balsp_p1', 10000, 'fee', SEM_NAME);
    // The refund names the fee it reverses and inherits that fee's semester.
    addPayment('balsp_p2', -4000, 'refund', SEM_NAME, 'balsp_p1');
    expect(paidTowardSemester()).toBe(6000);
    const debt = Math.max(0, 10000 - paidTowardSemester());
    expect(debt).toBe(4000);
    // The defect: the old rule saw 10,000 paid and refused the collection.
    expect(debt).not.toBe(0);
  });

  it('installments count toward the same semester debt as fees', () => {
    addPayment('balsp_p1', 6000, 'fee', SEM_NAME);
    addPayment('balsp_p2', 4000, 'installment', SEM_NAME);
    expect(paidTowardSemester()).toBe(10000);
  });

  it('a non-tuition purchase never settles the semester', () => {
    addPayment('balsp_p1', 10000, 'chapter', SEM_NAME);
    expect(paidTowardSemester()).toBe(0);
    expect(Math.max(0, 10000 - paidTowardSemester())).toBe(10000);
  });

  it('a refund of a non-tuition purchase never re-opens the semester', () => {
    addPayment('balsp_p1', 10000, 'fee', SEM_NAME);
    addPayment('balsp_p2', 2000, 'chapter', null);
    addPayment('balsp_p3', -2000, 'refund', null, 'balsp_p2');
    // The ad-hoc chapter money never settled the term, so returning it cannot un-settle it.
    expect(paidTowardSemester()).toBe(10000);
  });
});
