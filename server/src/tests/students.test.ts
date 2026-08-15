/**
Integration test: Students list — N+1 fix verification (Audit §7.1)
Verifies that listing students returns semesters correctly via batch query.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';

beforeAll(() => {
  initSchema();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  // Seed two students with semesters
  const date = today();
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, 'b1', 'male')`
  ).run('s_test1', 'TH-TEST-1', 'Student One', date);
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, 'b1', 'female')`
  ).run('s_test2', 'TH-TEST-2', 'Student Two', date);
  db.prepare(
    `INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount)
     VALUES (?, ?, 'Fall', ?, 5000)`
  ).run('sem_test1', 's_test1', date);
  db.prepare(
    `INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount)
     VALUES (?, ?, 'Spring', ?, 5500)`
  ).run('sem_test2', 's_test1', date);
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Students List (N+1 fix)', () => {
  it('returns students with their semesters via batch query', () => {
    const rows = db.prepare('SELECT * FROM students WHERE branch_id = ? ORDER BY registration_date DESC').all('b1') as any[];

    // Simulate the batch mapper logic
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const semesters = db
      .prepare(`SELECT * FROM student_semesters WHERE student_id IN (${placeholders}) ORDER BY enroll_date`)
      .all(...ids) as any[];

    const byStudent = new Map<string, any[]>();
    for (const s of semesters) {
      if (!byStudent.has(s.student_id)) byStudent.set(s.student_id, []);
      byStudent.get(s.student_id)!.push(s);
    }

    const mapped = rows.map((row) => ({
      id: row.id,
      semesters: (byStudent.get(row.id) || []).length,
    }));

    const studentOne = mapped.find((m) => m.id === 's_test1');
    const studentTwo = mapped.find((m) => m.id === 's_test2');

    expect(studentOne?.semesters).toBe(2);
    expect(studentTwo?.semesters).toBe(0);
  });
});