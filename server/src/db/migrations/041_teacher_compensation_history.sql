-- Historical teacher compensation and payroll calculation basis.

CREATE TABLE IF NOT EXISTS teacher_compensation_history (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  base_salary REAL NOT NULL DEFAULT 0,
  salary_type TEXT NOT NULL,
  contract_type TEXT,
  default_skill_rate REAL NOT NULL DEFAULT 0,
  reason TEXT,
  operator_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teacher_comp_history_lookup
ON teacher_compensation_history(teacher_id, effective_from);

INSERT OR IGNORE INTO teacher_compensation_history
  (id, teacher_id, effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason)
SELECT
  'tch_' || id,
  id,
  COALESCE(joined_date, date('now')),
  COALESCE(base_salary, 0),
  salary_type,
  contract_type,
  COALESCE(default_skill_rate, 0),
  'Initial compensation history backfill'
FROM teachers;
