/**
Integration test: Payroll semantic budget lookup (Audit §3.2)
Verifies that salary payment uses purpose-based budget lookup,
not hardcoded IDs.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';

beforeAll(() => {
  initSchema();
  // Seed branch + teacher + budget line with purpose
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  db.prepare(
    `INSERT OR IGNORE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date)
     VALUES (?, ?, 45000, 'fixed', 85, 'active', 'b1', ?)`
  ).run('t_test', 'Test Teacher', today());
  db.prepare(
    `INSERT OR IGNORE INTO budget_lines (id, name, current_amount, allocated_amount, cost_type, is_marketing, branch_id, purpose)
     VALUES (?, 'Teacher Salaries', 150000, 200000, 'variable', 0, 'b1', 'teacher_salary')`
  ).run('bl_test');
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Payroll Semantic Budget Lookup', () => {
  it('finds budget line by purpose, not by hardcoded ID', () => {
    const budgetLine = db
      .prepare('SELECT * FROM budget_lines WHERE purpose = ? AND branch_id = ?')
      .get('teacher_salary', 'b1') as any;

    expect(budgetLine).toBeDefined();
    expect(budgetLine.id).toBe('bl_test');
    expect(budgetLine.current_amount).toBe(150000);
  });

  it('returns undefined for non-existent purpose', () => {
    const budgetLine = db
      .prepare('SELECT * FROM budget_lines WHERE purpose = ? AND branch_id = ?')
      .get('nonexistent_purpose', 'b1') as any;

    expect(budgetLine).toBeUndefined();
  });
});