/**
 * Exam enrolment — business-event uniqueness (group F8)
 * ============================================================================
 * `POST /exams/:id/enroll` was the one money writer that stayed UNVERIFIED
 * across three audit addenda, because the database held no exam rows and no
 * attack could be staged. An exam with a real fee was finally created and the
 * route attacked with a barrier-synchronised 30-way race, six times over.
 *
 * It held — but only incidentally. The guard was an application-level
 * "is this candidate already enrolled?" SELECT followed by an INSERT, with no
 * atomic backstop. It survives today because better-sqlite3 serialises calls
 * inside one process; a second process, a connection pool, or a move to any
 * networked database would let two requests pass the SELECT together and book
 * the exam fee twice.
 *
 * Migration 062 adds the real constraint:
 *     uq_exam_results_student  (exam_id, student_id) WHERE student_id NOT NULL
 *     uq_exam_results_visitor  (exam_id, visitor_id) WHERE visitor_id NOT NULL
 *
 * Two partial indexes rather than one composite: a row carries EITHER a
 * student_id OR a visitor_id, and SQLite treats NULLs as distinct, so a single
 * index spanning both columns would constrain nothing.
 *
 * Proven by mutation: with the application check disabled outright
 * (`if (false && existing)`), the live 30-way race still returned
 * {201:1, 409:29} with exactly one enrolment and one income row — the index
 * alone is sufficient.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { isUniqueViolation } from '../utils/idempotency.js';
import { today } from '../utils/ids.js';

const BRANCH = 'exu_branch';
const EXAM = 'exu_exam';
const STUDENT = 'exu_student';
const VISITOR = 'exu_visitor';

beforeEach(() => {
  initSchema();
  const d = today();

  db.prepare(`DELETE FROM exam_results WHERE id LIKE 'exu_%'`).run();
  db.prepare(`DELETE FROM exams WHERE id = ?`).run(EXAM);
  db.prepare(`DELETE FROM students WHERE id = ?`).run(STUDENT);
  db.prepare(`DELETE FROM visitors WHERE id = ?`).run(VISITOR);

  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, 'Exam Uniq Branch', 'Loc')`).run(BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO exams (id, title, date, fee, type, branch_id)
     VALUES (?, 'Uniqueness Exam', ?, 3000, 'certification', ?)`,
  ).run(EXAM, d, BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
     VALUES (?, 'EXU-001', 'Exam Candidate', 'male', '0700777001', 'active', ?, ?)`,
  ).run(STUDENT, d, BRANCH);
  db.prepare(
    `INSERT OR REPLACE INTO visitors (id, full_name, gender, phone, source, status, visit_date, branch_id)
     VALUES (?, 'Exam Visitor', 'male', '0700777002', 'walk_in', 'new', ?, ?)`,
  ).run(VISITOR, d, BRANCH);
});

const enroll = (rowId: string, studentId: string | null, visitorId: string | null) =>
  db
    .prepare(
      `INSERT INTO exam_results (id, exam_id, student_id, visitor_id, candidate_name, exam_fee_paid, branch_id)
       VALUES (?, ?, ?, ?, 'Candidate', 1, ?)`,
    )
    .run(rowId, EXAM, studentId, visitorId, BRANCH);

describe('the database refuses a duplicate exam enrolment', () => {
  it('the unique indexes exist', () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'uq_exam_results_%'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain('uq_exam_results_student');
    expect(names).toContain('uq_exam_results_visitor');
  });

  it('a student cannot be enrolled twice in the same exam', () => {
    enroll('exu_r1', STUDENT, null);
    expect(() => enroll('exu_r2', STUDENT, null)).toThrow();
    const n = db.prepare(`SELECT COUNT(*) AS c FROM exam_results WHERE exam_id = ? AND student_id = ?`).get(EXAM, STUDENT) as { c: number };
    expect(n.c).toBe(1);
  });

  it('a visitor cannot be enrolled twice in the same exam', () => {
    enroll('exu_v1', null, VISITOR);
    expect(() => enroll('exu_v2', null, VISITOR)).toThrow();
    const n = db.prepare(`SELECT COUNT(*) AS c FROM exam_results WHERE exam_id = ? AND visitor_id = ?`).get(EXAM, VISITOR) as { c: number };
    expect(n.c).toBe(1);
  });

  it('the violation is recognisable as a unique violation, so the route can answer 409', () => {
    enroll('exu_r1', STUDENT, null);
    let caught: unknown;
    try {
      enroll('exu_r2', STUDENT, null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });
});

describe('the constraint does not block legitimate enrolments', () => {
  it('the same student may enrol in a DIFFERENT exam', () => {
    const d = today();
    db.prepare(
      `INSERT OR REPLACE INTO exams (id, title, date, fee, type, branch_id)
       VALUES ('exu_exam2', 'Second Exam', ?, 3000, 'certification', ?)`,
    ).run(d, BRANCH);

    enroll('exu_r1', STUDENT, null);
    db.prepare(
      `INSERT INTO exam_results (id, exam_id, student_id, visitor_id, candidate_name, exam_fee_paid, branch_id)
       VALUES ('exu_r2', 'exu_exam2', ?, NULL, 'Candidate', 1, ?)`,
    ).run(STUDENT, BRANCH);

    const n = db.prepare(`SELECT COUNT(*) AS c FROM exam_results WHERE student_id = ?`).get(STUDENT) as { c: number };
    expect(n.c).toBe(2);
    db.prepare(`DELETE FROM exams WHERE id = 'exu_exam2'`).run();
  });

  it('different candidates may enrol in the same exam', () => {
    enroll('exu_r1', STUDENT, null);
    enroll('exu_v1', null, VISITOR);
    const n = db.prepare(`SELECT COUNT(*) AS c FROM exam_results WHERE exam_id = ?`).get(EXAM) as { c: number };
    expect(n.c).toBe(2);
  });

  it('the partial predicate means many rows may share a NULL student_id', () => {
    // Visitor rows all have student_id NULL. A non-partial unique index on
    // (exam_id, student_id) would still permit these (SQLite NULLs are
    // distinct), but the visitor index is what actually constrains them.
    const d = today();
    for (const v of ['exu_v_a', 'exu_v_b']) {
      db.prepare(
        `INSERT OR REPLACE INTO visitors (id, full_name, gender, phone, source, status, visit_date, branch_id)
         VALUES (?, ?, 'male', ?, 'walk_in', 'new', ?, ?)`,
      ).run(v, v, `07007${v.slice(-3)}`, d, BRANCH);
    }
    enroll('exu_ra', null, 'exu_v_a');
    enroll('exu_rb', null, 'exu_v_b');
    const n = db.prepare(`SELECT COUNT(*) AS c FROM exam_results WHERE exam_id = ? AND student_id IS NULL`).get(EXAM) as { c: number };
    expect(n.c).toBe(2);
    expect(d).toBeTruthy();
  });
});
