-- ============================================================================
-- 052 — Student self-service portal: role 'student', linked_student_id, campus
-- ============================================================================
-- Enables a read-only student portal where a student logs in with their
-- student code + full name and sees only their own profile. Changes:
--   1. users.role CHECK extended with 'student'.
--   2. users.campus_id links the account to the branch's campus.
--   3. users.linked_student_id ties the account to exactly one student.
-- SQLite cannot ALTER a CHECK, so the table is rebuilt with the FK-safe
-- pattern (PRAGMA marker tells the migration runner to disable FKs around
-- this file's transaction; column names are explicit, never SELECT *).
-- ============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new_052 (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  email                TEXT,
  role                 TEXT NOT NULL CHECK (role IN (
                         'owner','manager','finance','registrar','teacher',
                         'head_of_department','counselor','donor_manager','student'
                       )),
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  campus_id            TEXT REFERENCES campuses(id) ON DELETE SET NULL,
  linked_teacher_id    TEXT,
  linked_employee_id   TEXT,
  linked_partner_id    TEXT,
  linked_student_id    TEXT REFERENCES students(id) ON DELETE SET NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  session_version      INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);

INSERT INTO users_new_052 (
  id, username, password_hash, full_name, email, role, branch_id,
  linked_teacher_id, linked_employee_id, linked_partner_id,
  is_active, must_change_password, session_version, created_at, last_login_at
)
SELECT
  id, username, password_hash, full_name, email, role, branch_id,
  linked_teacher_id, linked_employee_id, linked_partner_id,
  is_active, must_change_password, session_version, created_at, last_login_at
FROM users;

DROP TABLE users;

ALTER TABLE users_new_052 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_branch         ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_campus         ON users(campus_id);
CREATE INDEX IF NOT EXISTS idx_users_linked_student ON users(linked_student_id);
