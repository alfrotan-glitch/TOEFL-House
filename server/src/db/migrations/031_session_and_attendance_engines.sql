-- ============================================================================
-- Migration 031 — Academic Module Refactor, Phase 2
-- Session Engine hardening + Smart Attendance Engine
-- ============================================================================
--
-- SESSIONS: adds session_type (regular/makeup/substitute/online/hybrid/
-- rescheduled), linked_session_id (self-reference for makeup/reschedule
-- linkage), room_id (per-session override of the class's default room —
-- the blueprint's "Classroom" field was previously class-level only), and
-- notes (distinct from `topic`, matching the blueprint's "Teaching notes"
-- field). Teacher substitution needs no new column: sessions.teacher_id has
-- always been independent per-session (confirmed in Phase 1 audit) — the
-- API layer now just surfaces `isSubstitute` as a computed flag.
--
-- ROSTERS (attendance): attendance_status CHECK expands from 5 values to
-- the full blueprint set. All 5 existing values remain valid, unchanged in
-- meaning — 'sick' and 'leave' become permanent aliases of the new
-- 'medical_leave' and 'excused' respectively, matching the alias pattern
-- established in migration 030 for enrollment statuses. Adds late_minutes
-- (raw input for the configurable late-threshold policy) and
-- attendance_weight (a 0/0.5/1 snapshot of the credit this mark was worth
-- under the policy in effect at mark-time — see
-- core/academic/attendance-policy-service.ts).
--
-- QUIZZES: new table, mirrors the existing `homework` table's shape and
-- conventions exactly — the blueprint lists Quiz alongside Homework as a
-- first-class per-session activity, and only Homework existed before.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. SESSIONS — table rebuild (adding CHECK-constrained session_type)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions_v2 (
  id                 TEXT PRIMARY KEY,
  class_id           TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date               TEXT NOT NULL,
  start_time         TEXT NOT NULL,
  end_time           TEXT NOT NULL,
  topic              TEXT,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  session_type       TEXT NOT NULL DEFAULT 'regular' CHECK (session_type IN (
                       'regular','makeup','substitute','online','hybrid','rescheduled'
                     )),
  linked_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  teacher_id         TEXT,
  room_id            TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  skill_id           TEXT REFERENCES skills(id) ON DELETE SET NULL,
  branch_id          TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_v2 (
  id, class_id, date, start_time, end_time, topic, notes, status, session_type,
  linked_session_id, teacher_id, room_id, skill_id, branch_id, created_at
)
SELECT
  id, class_id, date, start_time, end_time, topic, NULL, status, 'regular',
  NULL, teacher_id, NULL, skill_id, branch_id, created_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_class   ON sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date    ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON sessions(teacher_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_linked  ON sessions(linked_session_id);

-- ============================================================================
-- 2. ROSTERS — expand attendance_status CHECK, add late tracking + weight
-- ============================================================================

CREATE TABLE IF NOT EXISTS rosters_v2 (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_status  TEXT NOT NULL DEFAULT 'not_marked' CHECK (attendance_status IN (
                       'present','late','absent','excused','medical_leave','sick','leave',
                       'online','hybrid','left_early','not_marked'
                     )),
  late_minutes       INTEGER,
  attendance_weight  REAL,
  marked_at          TEXT,
  UNIQUE(session_id, student_id)
);

INSERT INTO rosters_v2 (id, session_id, student_id, attendance_status, late_minutes, attendance_weight, marked_at)
SELECT id, session_id, student_id, attendance_status, NULL, NULL, marked_at
FROM rosters;

DROP TABLE rosters;
ALTER TABLE rosters_v2 RENAME TO rosters;

CREATE INDEX IF NOT EXISTS idx_rosters_session ON rosters(session_id);
CREATE INDEX IF NOT EXISTS idx_rosters_student ON rosters(student_id);

-- ============================================================================
-- 3. QUIZZES — new table, mirrors `homework` exactly
-- ============================================================================

CREATE TABLE IF NOT EXISTS quizzes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  max_score   REAL,
  due_date    TEXT,
  assigned_by TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quizzes_session ON quizzes(session_id);

PRAGMA foreign_keys = ON;
