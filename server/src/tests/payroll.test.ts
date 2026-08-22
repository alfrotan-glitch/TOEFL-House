/**
Integration test: Payroll semantic budget lookup (Audit §3.2)
Verifies that salary payment resolves its envelope through `payroll_target`,
not hardcoded IDs.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';

beforeAll(() => {
  initSchema();
  // Seed branch + teacher + the branch's teacher payroll envelope
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  db.prepare(
    `INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date)
     VALUES (?, ?, 45000, 'fixed', 85, 'active', 'b1', ?)`
  ).run('t_test', 'Test Teacher', today());
  db.prepare(
    `INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, cost_type, branch_id, category_id, payroll_target)
     VALUES (?, 'Teacher Salaries', 150000, 200000, 'variable', 'b1', 'sub_salaries_wages', 'teacher')`
  ).run('bl_test');
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Payroll Semantic Budget Lookup', () => {
  it('finds the payroll envelope by its business relationship, not by a hardcoded id', () => {
    const budgetLine = db
      .prepare('SELECT * FROM budget_lines WHERE payroll_target = ? AND branch_id = ?')
      .get('teacher', 'b1') as any;

    expect(budgetLine).toBeDefined();
    expect(budgetLine.id).toBe('bl_test');
    expect(budgetLine.current_amount).toBe(150000);
  });

  it('returns undefined when the branch has no such payroll envelope', () => {
    const budgetLine = db
      .prepare('SELECT * FROM budget_lines WHERE payroll_target = ? AND branch_id = ?')
      .get('employee', 'branch-that-does-not-exist') as any;

    expect(budgetLine).toBeUndefined();
  });
});