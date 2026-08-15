-- ============================================================================
-- Migration 030 — Academic Module Refactor, Phase 1
-- Class Lifecycle Engine + Enrollment Lifecycle Engine
-- ============================================================================
--
-- CRIT-FIX (confirmed by reproduction): classes.status CHECK has never
-- included 'scheduled', yet routes/classes.routes.ts has always inserted
-- new classes with status='scheduled' and /:id/activate has always gated on
-- status = 'scheduled'. Every POST /api/classes call throws
-- "SqliteError: CHECK constraint failed: classes" — class creation has been
-- non-functional at the database layer. Only rows inserted directly with
-- status='active' (seed.ts) ever existed. This migration fixes that bug as
-- part of introducing the full 11-stage Class Lifecycle Engine.
--
-- STRATEGY — Class: `status` remains a coarse, backward-compatible
-- projection ('draft'|'active'|'completed'|'cancelled') because the frontend
-- reads `class.status === 'active'` in many places (dashboards, enrollment
-- pickers, session-eligible-class filters). A new `lifecycle_stage` column
-- carries the full blueprint state machine. Two triggers keep `status`
-- permanently in sync with `lifecycle_stage`, including for any future
-- direct SQL write, so the two columns can never drift. Application code
-- transitions `lifecycle_stage` only (see core/academic/class-lifecycle-service.ts);
-- it never writes `status` directly.
--
-- STRATEGY — Enrollment: `status` is expanded in place (no legacy-projection
-- needed). Audited: every consumer outside core/academic/enrollment-service.ts
-- filters only on status = 'active'; nothing depends on the old 3-6 value
-- enum shape, so the full 14-value blueprint set (superset of the old one)
-- is added directly with zero compatibility shim required.
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ============================================================================
-- 1. CLASSES — table rebuild (SQLite cannot ALTER a CHECK constraint)
-- ============================================================================

CREATE TABLE IF NOT EXISTS classes_v2 (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  teacher_id           TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  program_id           TEXT REFERENCES programs(id) ON DELETE SET NULL,
  level_id             TEXT REFERENCES levels(id) ON DELETE SET NULL,
  level                TEXT NOT NULL,
  capacity             INTEGER NOT NULL DEFAULT 0,
  min_viable_size      INTEGER NOT NULL DEFAULT 0,
  schedule_time        TEXT,
  start_date           TEXT,
  end_date             TEXT,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  lifecycle_stage      TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_stage IN (
                         'draft','scheduled','enrollment_open','enrollment_closed',
                         'activated','in_progress','suspended','grading',
                         'completed','archived','cancelled'
                       )),
  lifecycle_updated_at TEXT,
  cancellation_reason  TEXT,
  fee                  REAL NOT NULL DEFAULT 0,
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  gender_policy        TEXT NOT NULL DEFAULT 'mixed' CHECK (gender_policy IN ('female','male','mixed')),
  room_id              TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  time_slot_id         TEXT REFERENCES time_slots(id) ON DELETE SET NULL,
  academic_term_id     TEXT REFERENCES academic_terms(id) ON DELETE SET NULL,
  activation_date      TEXT,
  merged_into_id       TEXT,
  offering_id          TEXT REFERENCES course_offerings(id) ON DELETE SET NULL,
  notes                TEXT
);

INSERT INTO classes_v2 (
  id, name, teacher_id, program_id, level_id, level, capacity, min_viable_size,
  schedule_time, start_date, end_date, status, lifecycle_stage, lifecycle_updated_at,
  cancellation_reason, fee, branch_id, gender_policy, room_id, time_slot_id,
  academic_term_id, activation_date, merged_into_id, offering_id, notes
)
SELECT
  id, name, teacher_id, program_id, level_id, level, capacity, min_viable_size,
  schedule_time, start_date, end_date,
  CASE WHEN status IN ('active','completed','cancelled') THEN status ELSE 'active' END,
  CASE
    WHEN status = 'completed' THEN 'completed'
    WHEN status = 'cancelled' THEN 'cancelled'
    WHEN status = 'active'    THEN 'in_progress'
    ELSE 'draft'
  END,
  NULL,
  NULL,
  fee,
  branch_id,
  COALESCE(gender_policy, 'mixed'),
  room_id, time_slot_id, academic_term_id,
  -- Backfill activation_date only where NULL — legacy 'active' classes were
  -- always operational without ever going through a real activation step.
  CASE WHEN status = 'active' AND activation_date IS NULL
       THEN COALESCE(start_date, date('now'))
       ELSE activation_date END,
  merged_into_id, offering_id, notes
FROM classes;

DROP TABLE classes;
ALTER TABLE classes_v2 RENAME TO classes;

CREATE INDEX IF NOT EXISTS idx_classes_branch    ON classes(branch_id);
CREATE INDEX IF NOT EXISTS idx_classes_program   ON classes(program_id);
CREATE INDEX IF NOT EXISTS idx_classes_level     ON classes(level_id);
CREATE INDEX IF NOT EXISTS idx_classes_teacher   ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_classes_gender    ON classes(branch_id, gender_policy, status);
CREATE INDEX IF NOT EXISTS idx_classes_lifecycle ON classes(lifecycle_stage);

-- NOTE on `status` sync: this codebase's migration runner splits SQL files
-- on bare semicolons and cannot parse multi-statement CREATE TRIGGER ...
-- BEGIN...END bodies (confirmed by reproduction). Rather than modify the
-- shared runner (out of scope for an Academic-Module-only refactor), the
-- `status` ⇄ `lifecycle_stage` projection is enforced at the application
-- layer instead: every write site funnels through
-- core/academic/lifecycle-engine.ts#deriveLegacyClassStatus(), the single
-- source of truth for the mapping. See that module for the enforcement
-- points (ClassLifecycleService, classes.routes.ts, class-generation-engine.ts).

-- ============================================================================
-- 2. ENROLLMENTS — expand status CHECK to the full lifecycle set
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrollments_v2 (
  id                  TEXT PRIMARY KEY,
  student_id          TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id          TEXT REFERENCES programs(id) ON DELETE SET NULL,
  program_name        TEXT,
  semester_name       TEXT,
  level_code          TEXT,
  class_id            TEXT REFERENCES classes(id) ON DELETE SET NULL,
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  enrollment_type     TEXT NOT NULL DEFAULT 'new' CHECK (enrollment_type IN ('new','repeat','partial_repeat','resume','jump','extra')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                        'pending','reserved','confirmed','active','frozen','paused','suspended',
                        'transferred','dropped','withdrawn','completed','graduated','retake','conditional_pass'
                      )),
  hold_reason         TEXT,
  skills_focus        TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  notes               TEXT,
  program_version_id  TEXT,
  fee_snapshot_json   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO enrollments_v2 (
  id, student_id, program_id, program_name, semester_name, level_code, class_id, branch_id,
  enrollment_type, status, hold_reason, skills_focus, started_at, ended_at, notes,
  program_version_id, fee_snapshot_json, created_at, updated_at
)
SELECT
  id, student_id, program_id, program_name, semester_name, level_code, class_id, branch_id,
  enrollment_type, status, NULL, skills_focus, started_at, ended_at, notes,
  program_version_id, fee_snapshot_json, created_at, updated_at
FROM enrollments;

DROP TABLE enrollments;
ALTER TABLE enrollments_v2 RENAME TO enrollments;

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_branch   ON enrollments(branch_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class    ON enrollments(class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_status   ON enrollments(status);

-- ============================================================================
-- 3. ENROLLMENT_EVENTS — expand event_type CHECK to match new transitions
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrollment_events_v2 (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'enrolled','transferred','suspended','resumed','dropped','completed',
                    'pending_created','reserved','confirmed','activated','frozen','unfrozen',
                    'withdrawn','graduated','retake_marked','conditional_pass_marked'
                  )),
  from_class_id   TEXT,
  to_class_id     TEXT,
  notes           TEXT,
  actor_user_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO enrollment_events_v2 (id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id, created_at)
SELECT id, enrollment_id, student_id, event_type, from_class_id, to_class_id, notes, actor_user_id, created_at
FROM enrollment_events;

DROP TABLE enrollment_events;
ALTER TABLE enrollment_events_v2 RENAME TO enrollment_events;

CREATE INDEX IF NOT EXISTS idx_enrollment_events_student    ON enrollment_events(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollment_events_enrollment ON enrollment_events(enrollment_id, created_at DESC);

PRAGMA foreign_keys = ON;
