-- Teacher contract models + monthly salary ledger (no double full pay).
-- salary_type values used by app: fixed | per_skill | hybrid | per_level
-- SQLite cannot alter CHECK easily; app enforces allowed values.

CREATE TABLE IF NOT EXISTS teacher_salary_ledger (
  id              TEXT PRIMARY KEY,
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  period_key      TEXT NOT NULL,
  period_label    TEXT NOT NULL,
  due_amount      REAL NOT NULL DEFAULT 0,
  paid_amount     REAL NOT NULL DEFAULT 0,
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('full','partial','advance')),
  transaction_id  TEXT,
  notes           TEXT,
  branch_id       TEXT NOT NULL,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
  operator_name   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tsl_teacher_period ON teacher_salary_ledger(teacher_id, period_key);

-- Per-level skill rates for contract model "per_level"
CREATE TABLE IF NOT EXISTS teacher_level_skill_rates (
  id           TEXT PRIMARY KEY,
  teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  level_id     TEXT,
  level_code   TEXT NOT NULL,
  skill_id     TEXT REFERENCES skills(id),
  rate_per_skill REAL NOT NULL DEFAULT 0,
  branch_id    TEXT NOT NULL,
  UNIQUE(teacher_id, level_code, skill_id)
);

-- Hybrid: base_salary + sum of skill rates already in class_teacher_skills
-- Ensure skill_id uniqueness per class (one teacher per skill slot); max 3 skills enforced in API.
