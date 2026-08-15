-- Expand teacher salary models: allow hybrid / per_level (remove old CHECK).
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS teachers_new (
  id                 TEXT PRIMARY KEY,
  full_name          TEXT NOT NULL,
  phone              TEXT,
  email              TEXT,
  base_salary        REAL NOT NULL DEFAULT 0,
  salary_type        TEXT NOT NULL DEFAULT 'fixed',
  performance_score  REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active',
  branch_id          TEXT NOT NULL,
  joined_date        TEXT NOT NULL,
  specialization     TEXT,
  qualification      TEXT,
  contract_type      TEXT,
  user_id            TEXT,
  default_skill_rate REAL NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO teachers_new (
  id, full_name, phone, email, base_salary, salary_type, performance_score, status,
  branch_id, joined_date, specialization, qualification, contract_type, user_id, default_skill_rate
)
SELECT
  id, full_name, phone, email, base_salary, salary_type, performance_score, status,
  branch_id, joined_date, specialization, qualification, contract_type, user_id, 0
FROM teachers;

DROP TABLE IF EXISTS teachers;
ALTER TABLE teachers_new RENAME TO teachers;

CREATE INDEX IF NOT EXISTS idx_teachers_branch ON teachers(branch_id);
CREATE INDEX IF NOT EXISTS idx_teachers_status ON teachers(status);

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teacher_level_skill_rates (
  id             TEXT PRIMARY KEY,
  teacher_id     TEXT NOT NULL,
  level_id       TEXT,
  level_code     TEXT NOT NULL,
  skill_id       TEXT,
  rate_per_skill REAL NOT NULL DEFAULT 0,
  branch_id      TEXT NOT NULL,
  UNIQUE(teacher_id, level_code, skill_id)
);

CREATE TABLE IF NOT EXISTS teacher_salary_ledger (
  id             TEXT PRIMARY KEY,
  teacher_id     TEXT NOT NULL,
  period_key     TEXT NOT NULL,
  period_label   TEXT NOT NULL,
  due_amount     REAL NOT NULL DEFAULT 0,
  paid_amount    REAL NOT NULL DEFAULT 0,
  payment_type   TEXT NOT NULL,
  transaction_id TEXT,
  notes          TEXT,
  branch_id      TEXT NOT NULL,
  paid_at        TEXT NOT NULL DEFAULT (datetime('now')),
  operator_name  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tsl_teacher_period ON teacher_salary_ledger(teacher_id, period_key);
