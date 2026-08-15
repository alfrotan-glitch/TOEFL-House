-- Teacher HR/payroll integrity hardening.
-- The migration runner intentionally executes one statement at a time, so this
-- migration uses portable indexes rather than multi-statement trigger bodies.

CREATE TABLE IF NOT EXISTS teacher_branch_history (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  from_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  to_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  effective_date TEXT NOT NULL,
  reason TEXT,
  operator_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teacher_branch_history_teacher
ON teacher_branch_history(teacher_id, effective_date);

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_full_period
ON teacher_salary_ledger(teacher_id, period_key)
WHERE payment_type = 'full';

CREATE INDEX IF NOT EXISTS idx_teacher_salary_period
ON teacher_salary_ledger(teacher_id, period_key, paid_at);

CREATE INDEX IF NOT EXISTS idx_teacher_salary_branch_period
ON teacher_salary_ledger(branch_id, period_key, paid_at);

CREATE INDEX IF NOT EXISTS idx_teacher_assignments_payroll
ON class_teacher_skills(teacher_id, assignment_type, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_teacher_level_rates_lookup
ON teacher_level_skill_rates(teacher_id, branch_id, level_code, skill_id);
