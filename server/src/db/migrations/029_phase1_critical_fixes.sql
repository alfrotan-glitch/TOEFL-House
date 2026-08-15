-- ============================================================================
-- Migration 029 — Phase 1 Critical Fixes
-- ============================================================================
-- CRIT-01: Prevent duplicate student records (UNIQUE on tazkira_no, phone, email)
-- CRIT-02: Restore Foreign Keys dropped in Migration 025 (teachers table)
-- CRIT-08: Full Visitor <-> Student integrity (lead_id UNIQUE + FK)
-- ============================================================================

-- ── CRIT-01: Duplicate Prevention ──────────────────────────────────────────
-- SQLite does NOT support ADD CONSTRAINT for UNIQUE indexes on existing tables.
-- We create partial UNIQUE indexes that only enforce uniqueness for non-NULL values.
-- This allows multiple students to have NULL tazkira_no / phone / email (e.g. data
-- entry in progress) while preventing duplicates once a value is set.

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tazkira_no
  ON students(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone
  ON students(phone) WHERE phone IS NOT NULL AND phone != '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email
  ON students(email) WHERE email IS NOT NULL AND email != '';

-- ── CRIT-08: Visitor <-> Student Integrity ──────────────────────────────────
-- lead_id must be UNIQUE (one visitor can convert to at most one student)
-- and enforced as a FK to visitors(id) ON DELETE SET NULL (if visitor is deleted,
-- the student record survives but loses the lead link).

-- 1. Remove any existing non-unique index on lead_id if present
DROP INDEX IF EXISTS idx_students_lead_id;

-- 2. Create a UNIQUE partial index: only enforce uniqueness when lead_id is set
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_lead_id
  ON students(lead_id) WHERE lead_id IS NOT NULL;

-- 3. Ensure visitors that have been converted (status='registered') cannot be
--    deleted accidentally.  The FK on students.lead_id already references visitors(id)
--    in schema.sql (v2.0.1+), but we add a complementary index for query performance.
CREATE INDEX IF NOT EXISTS idx_visitors_status
  ON visitors(status);

CREATE INDEX IF NOT EXISTS idx_visitors_branch_status
  ON visitors(branch_id, status);

-- ── CRIT-02: Restore Foreign Keys on Teachers ───────────────────────────────
-- Migration 025 used PRAGMA foreign_keys=OFF and recreated the teachers table
-- WITHOUT restoring the CHECK constraints and FK to branches(id) and users(id).
-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so we must recreate.

PRAGMA foreign_keys = OFF;

-- Step 1: Create new teachers table with full constraints
CREATE TABLE IF NOT EXISTS teachers_restored (
  id                 TEXT PRIMARY KEY,
  full_name          TEXT NOT NULL,
  phone              TEXT,
  email              TEXT,
  base_salary        REAL NOT NULL DEFAULT 0,
  salary_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (salary_type IN (
                       'fixed','per_skill','per_session','hybrid','per_level'
                     )),
  performance_score  REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                       'active','inactive','on_leave'
                     )),
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  joined_date        TEXT NOT NULL,
  specialization     TEXT,
  qualification      TEXT,
  contract_type      TEXT CHECK (contract_type IN (
                       'monthly','hourly','per_session'
                     )),
  user_id            TEXT REFERENCES users(id),
  default_skill_rate REAL NOT NULL DEFAULT 0
);

-- Step 2: Copy all data
INSERT OR IGNORE INTO teachers_restored (
  id, full_name, phone, email, base_salary, salary_type, performance_score, status,
  branch_id, joined_date, specialization, qualification, contract_type, user_id, default_skill_rate
)
SELECT
  id, full_name, phone, email, base_salary, salary_type, performance_score, status,
  branch_id, joined_date, specialization, qualification, contract_type, user_id, default_skill_rate
FROM teachers;

-- Step 3: Swap tables
DROP TABLE IF EXISTS teachers;
ALTER TABLE teachers_restored RENAME TO teachers;

-- Step 4: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_teachers_branch ON teachers(branch_id);
CREATE INDEX IF NOT EXISTS idx_teachers_status ON teachers(status);

PRAGMA foreign_keys = ON;

-- ── End of Migration 029 ─────────────────────────────────────────────────────
