/**
 * WP-07 · The enrolment auto-invoice bills by purpose (WP07-F18).
 * ============================================================================
 * `buildFeeSnapshot` composes one fee list from several fee types — a
 * `registration` fee and a `semester` fee, plus a `retake` fee for a repeat —
 * and the enrolment wrote all of them to ONE invoice. The `student_semesters`
 * row the same call created was inserted with `fee_amount = 0`.
 *
 * So tuition receivable lived in two different places depending on which door
 * the student came through: on the semester row for visitor conversion and
 * manual registration, and on an invoice — invisible to the balance authority
 * — for the enrolment service.
 *
 * Owner decisions taken on the analysis (`WP-07-F18-enrolment-invoice-analysis.md`):
 *
 *   MODEL     Split the enrolment invoice by purpose. The term carries its
 *             tuition, a `tuition` invoice names that term's obligation, and a
 *             separate `other` invoice carries the registration fee.
 *   RETAKE    A retake fee IS tuition.
 *   DISCOUNT  A discount attaches to tuition only, matching what visitor
 *             conversion and manual registration already do.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { getStudentBalance, getSemesterTuitionSettled } from '../../../utils/studentBalance.js';
import { today } from '../../../utils/ids.js';

const TUITION = 8000;
const REGISTRATION = 1500;
const RETAKE = 2000;

let key: string;
let branch: string;
let studentId: string;
let classId: string;
let levelId: string;
let phoneSeq = 0;
const nextPhone = () => `07${String(3000000 + (phoneSeq += 1) + (process.pid % 100000)).slice(-8)}`;

const enrol = (overrides: Record<string, unknown> = {}) =>
  getEnrollmentService(db).enroll({
    studentId,
    branchId: branch,
    semesterName: 'Enrolment Term',
    classId,
    levelId,
    enrollmentType: 'new',
    actorUserId: `${key}_u`,
    actorName: 'Enrolment Officer',
    autoInvoice: true,
    ...overrides,
  } as never) as { enrollmentId: string; invoiceId: string | null; invoiceNumber: string | null };

/** Every invoice this student holds, with what it bills. */
const invoicesOf = () =>
  db
    .prepare(
      `SELECT i.id, i.purpose, i.obligation_id, i.total_amount, i.discount_amount, i.net_amount,
              (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id = i.id) AS lines
         FROM invoices i WHERE i.student_id = ? ORDER BY i.purpose`,
    )
    .all(studentId) as Array<{
      id: string; purpose: string; obligation_id: string | null;
      total_amount: number; discount_amount: number; net_amount: number; lines: number;
    }>;

const termRow = () =>
  db
    .prepare(`SELECT id, fee_amount, net_fee_amount FROM student_semesters WHERE student_id = ? ORDER BY rowid`)
    .get(studentId) as { id: string; fee_amount: number; net_fee_amount: number | null } | undefined;

beforeEach(() => {
  initSchema();
  key = `w7e_${process.pid}_${randomUUID().slice(0, 6)}`;
  branch = `${key}_b`;
  db.prepare("INSERT INTO branches (id, name, location) VALUES (?, ?, 'L')").run(branch, branch);

  const programId = `${key}_prog`;
  db.prepare(`INSERT INTO programs (id, name, code, branch_id) VALUES (?, 'Enrolment Program', ?, ?)`)
    .run(programId, `EP${phoneSeq}`, branch);
  levelId = `${key}_lvl`;
  db.prepare(
    `INSERT INTO levels (id, program_id, name, code, "order", default_fee) VALUES (?, ?, 'Level One', ?, 1, ?)`,
  ).run(levelId, programId, `L1${phoneSeq}`, TUITION);

  classId = `${key}_cls`;
  db.prepare(
    `INSERT INTO classes (id, name, level, capacity, fee, branch_id, status, lifecycle_stage, program_id, level_id)
     VALUES (?, 'Class A', 'Level One', 30, ?, ?, 'active', 'enrollment_open', ?, ?)`,
  ).run(classId, TUITION, branch, programId, levelId);

  // A registration fee alongside the tuition: this is what makes the enrolment
  // document a MIXTURE.
  db.prepare(
    `INSERT INTO fee_rules (id, fee_type, name, amount, branch_id, is_active, version)
     VALUES (?, 'registration', 'Registration fee', ?, ?, 1, 1)`,
  ).run(`${key}_fr_reg`, REGISTRATION, branch);

  studentId = `${key}_stu`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, 'Enrolled Student', 'active', ?, ?, 'female', ?)`,
  ).run(studentId, `TH-E${(phoneSeq += 1)}-${key.slice(-6)}`, today(), branch, nextPhone());
});

describe('WP-07 · WP07-F18 — the term carries its tuition and the documents say what they bill', () => {
  it('the term the enrolment creates bills the tuition, not zero', () => {
    enrol();

    const term = termRow();
    expect(term, 'the enrolment must create a term').toBeTruthy();
    expect(term?.fee_amount).toBe(TUITION);
    expect(term?.net_fee_amount).toBe(TUITION);

    // The balance authority can now see the debt, which is the whole point.
    expect(getStudentBalance(db, studentId).tuitionDue).toBe(TUITION);
    expect(getStudentBalance(db, studentId).outstanding).toBe(TUITION);
  });

  it('the enrolment issues one tuition invoice naming the term and one other invoice', () => {
    enrol();

    const invoices = invoicesOf();
    expect(invoices).toHaveLength(2);

    const tuition = invoices.find((i) => i.purpose === 'tuition');
    const other = invoices.find((i) => i.purpose === 'other');

    expect(tuition, 'a tuition invoice must exist').toBeTruthy();
    expect(tuition?.net_amount).toBe(TUITION);
    expect(tuition?.obligation_id, 'the tuition invoice must name the term').toBeTruthy();
    expect(tuition?.lines).toBeGreaterThan(0);

    expect(other, 'the registration fee must be billed separately').toBeTruthy();
    expect(other?.net_amount).toBe(REGISTRATION);
    expect(other?.obligation_id).toBeNull();
    expect(other?.lines).toBeGreaterThan(0);

    // The tuition invoice bills exactly the term it names.
    const obligation = db
      .prepare(`SELECT semester_id FROM student_obligations WHERE id = ?`)
      .get(tuition!.obligation_id) as { semester_id: string };
    expect(obligation.semester_id).toBe(termRow()!.id);
  });

  it('a retake fee is tuition and joins the tuition invoice', () => {
    db.prepare(
      `INSERT INTO fee_rules (id, fee_type, name, amount, branch_id, is_active, version)
       VALUES (?, 'retake', 'Retake fee', ?, ?, 1, 1)`,
    ).run(`${key}_fr_ret`, RETAKE, branch);

    enrol({ enrollmentType: 'repeat', semesterName: 'Repeat Term' });

    const invoices = invoicesOf();
    const tuition = invoices.find((i) => i.purpose === 'tuition');
    expect(tuition?.net_amount).toBe(TUITION + RETAKE);
    expect(termRow()?.net_fee_amount).toBe(TUITION + RETAKE);
    expect(invoices.find((i) => i.purpose === 'other')?.net_amount).toBe(REGISTRATION);
  });

  it('a discount reduces tuition only, and the term records the discounted figure', () => {
    enrol({ discountAmount: 3000 });

    const term = termRow();
    expect(term?.fee_amount).toBe(TUITION);
    expect(term?.net_fee_amount).toBe(TUITION - 3000);

    const invoices = invoicesOf();
    const tuition = invoices.find((i) => i.purpose === 'tuition');
    expect(tuition?.total_amount).toBe(TUITION);
    expect(tuition?.discount_amount).toBe(3000);
    expect(tuition?.net_amount).toBe(TUITION - 3000);

    // The registration fee is NOT discounted — which is what the other two
    // enrolment doors already do.
    expect(invoices.find((i) => i.purpose === 'other')?.net_amount).toBe(REGISTRATION);

    expect(getStudentBalance(db, studentId).outstanding).toBe(TUITION - 3000);
  });

  it('a discount larger than the tuition is refused, even when the whole snapshot is bigger', () => {
    // Snapshot total is 9,500 (8,000 tuition + 1,500 registration). A 9,000 AFN
    // discount fits the TOTAL but not the tuition, and tuition is what a
    // discount attaches to.
    expect(() => enrol({ discountAmount: 9000 })).toThrow(/discount cannot exceed/i);
    expect(invoicesOf()).toHaveLength(0);
    expect(termRow()).toBeFalsy();
  });

  it('paying the tuition invoice settles the term; paying the other invoice does not', () => {
    enrol();
    const invoices = invoicesOf();
    const tuition = invoices.find((i) => i.purpose === 'tuition')!;
    const other = invoices.find((i) => i.purpose === 'other')!;
    const term = termRow()!;

    // Settled through the same authority every other tuition payment uses.
    db.prepare(
      `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, semester, receipt_number, branch_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'cash', 'completed', 'fee', 'Enrolment Term', ?, ?, ?)`,
    ).run(`${key}_p1`, studentId, tuition.id, TUITION, today(), `R-${key.slice(-6)}-1`, branch, `${key}_k1`);
    expect(getSemesterTuitionSettled(db, studentId, 'Enrolment Term')).toBe(TUITION);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);

    // The registration invoice's money is not tuition and never was.
    db.prepare(
      `INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'cash', 'completed', 'other', ?, ?, ?)`,
    ).run(`${key}_p2`, studentId, other.id, REGISTRATION, today(), `R-${key.slice(-6)}-2`, branch, `${key}_k2`);
    expect(getSemesterTuitionSettled(db, studentId, 'Enrolment Term')).toBe(TUITION);
    expect(term.id).toBeTruthy();
  });

  it('an enrolment with no tuition in its snapshot issues only the other invoice', () => {
    db.prepare('UPDATE levels SET default_fee = 0 WHERE id = ?').run(levelId);
    db.prepare('UPDATE classes SET fee = 0 WHERE id = ?').run(classId);

    enrol();

    const invoices = invoicesOf();
    expect(invoices.map((i) => i.purpose)).toEqual(['other']);
    expect(invoices[0].net_amount).toBe(REGISTRATION);
    expect(termRow()?.net_fee_amount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK — the ways the split could leak money back together
// ═══════════════════════════════════════════════════════════════════════════

describe('WP-07 · WP07-F18 · ATTACK', () => {
  it('a fully discounted term still records the document that grants the discount', () => {
    enrol({ discountAmount: TUITION });

    const tuition = invoicesOf().find((i) => i.purpose === 'tuition');
    expect(tuition, 'a 100% discount must still leave a record').toBeTruthy();
    expect(tuition?.total_amount).toBe(TUITION);
    expect(tuition?.discount_amount).toBe(TUITION);
    expect(tuition?.net_amount).toBe(0);

    // The discounts-granted report sums invoices.discount_amount, so dropping
    // the document would erase the discount from the books entirely.
    const granted = db
      .prepare(`SELECT COALESCE(SUM(discount_amount),0) AS d FROM invoices WHERE student_id = ? AND status <> 'draft'`)
      .get(studentId) as { d: number };
    expect(granted.d).toBe(TUITION);
    expect(termRow()?.net_fee_amount).toBe(0);
    expect(getStudentBalance(db, studentId).outstanding).toBe(0);
  });

  it('the two documents never overlap: together they bill the snapshot exactly once', () => {
    enrol();
    const invoices = invoicesOf();
    const billed = invoices.reduce((sum, i) => sum + i.total_amount, 0);
    expect(billed).toBe(TUITION + REGISTRATION);

    // and no line is duplicated across them
    const lines = db
      .prepare(
        `SELECT it.description, COUNT(*) AS n FROM invoice_items it
           JOIN invoices i ON i.id = it.invoice_id
          WHERE i.student_id = ? GROUP BY it.description`,
      )
      .all(studentId) as Array<{ description: string; n: number }>;
    expect(lines.every((l) => l.n === 1)).toBe(true);
  });

  it('the tuition invoice never bills more than the term it names', () => {
    enrol();
    const tuition = invoicesOf().find((i) => i.purpose === 'tuition')!;
    const term = termRow()!;
    expect(tuition.net_amount).toBeLessThanOrEqual(Number(term.net_fee_amount ?? term.fee_amount));
  });

  it('an enrolment whose caller owns the term bills no tuition, so nothing is charged twice', () => {
    // This is what manual registration and visitor conversion do: they write
    // their own term with their own figures and pass writeSemester: false.
    const ownTerm = `${key}_ownsem`;
    db.prepare(
      `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
       VALUES (?, ?, 'Caller Term', ?, ?, ?, ?, 'active')`,
    ).run(ownTerm, studentId, classId, today(), TUITION, TUITION);

    enrol({ semesterName: 'Caller Term', writeSemester: false });

    const invoices = invoicesOf();
    expect(invoices.map((i) => i.purpose)).toEqual(['other']);
    expect(invoices[0].net_amount).toBe(REGISTRATION);

    // The term still bills exactly what its owner said, charged once.
    expect(getStudentBalance(db, studentId).tuitionDue).toBe(TUITION);
    expect(getStudentBalance(db, studentId).outstanding).toBe(TUITION);
  });

  it.each([
    ['text', 'abc'],
    ['boolean', true],
    ['array', [1000]],
    ['negative', -1000],
    ['beyond the tuition', TUITION + 1],
  ])('a discount of %s writes no enrolment, no term and no invoice', (_label, amount) => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ?').get(studentId) as { c: number };
    expect(() => enrol({ discountAmount: amount })).toThrow();
    expect(invoicesOf()).toHaveLength(0);
    expect(termRow()).toBeFalsy();
    expect(db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ?').get(studentId)).toEqual(before);
  });

  it('a repeat enrolment cannot discount more than tuition plus retake', () => {
    db.prepare(
      `INSERT INTO fee_rules (id, fee_type, name, amount, branch_id, is_active, version)
       VALUES (?, 'retake', 'Retake fee', ?, ?, 1, 1)`,
    ).run(`${key}_fr_ret2`, RETAKE, branch);

    // Tuition for a repeat is 8,000 + 2,000. One afghani more is refused.
    expect(() => enrol({ enrollmentType: 'repeat', semesterName: 'R1', discountAmount: TUITION + RETAKE + 1 })).toThrow(
      /discount cannot exceed/i,
    );
    enrol({ enrollmentType: 'repeat', semesterName: 'R2', discountAmount: TUITION + RETAKE });
    expect(termRow()?.net_fee_amount).toBe(0);
  });
});
