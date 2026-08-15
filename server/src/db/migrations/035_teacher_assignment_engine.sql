-- ============================================================================
-- Migration 035 — Academic Module Refactor, Phase 8
-- Teacher Assignment Engine
-- ============================================================================
--
-- class_teacher_skills has functioned as the de facto "Teacher Assignment"
-- entity all along — it already has its own dedicated router
-- (classTeacherSkillsRouter), its own business rules (max 3 skills/class,
-- fixed-contract teachers can't hold skill rates), and error messages that
-- already say "Assignment not found". What it lacked against the
-- blueprint: assignment_type (every row was implicitly "primary"),
-- start/end dates, a reason, and session-level scoping (class-level only).
--
-- assignment_type DEFAULTs to 'primary' so every existing row's meaning is
-- completely unchanged. session_id is nullable — NULL means class-scoped
-- (the only kind that existed before this migration); a real session_id
-- scopes a one-off assignment (e.g. a single-session substitute) to just
-- that session, per the blueprint's "Session scope or class scope".
--
-- UNIQUE constraint becomes (class_id, teacher_id, skill_id, session_id).
-- SQLite treats each NULL as distinct in a UNIQUE index, which means this
-- alone would no longer block two class-scoped (session_id IS NULL) rows
-- for the same class+teacher+skill — the original protection this
-- constraint provided. That specific case is re-enforced at the
-- application layer instead (see skills.routes.ts) — the same
-- app-level-enforcement pattern used throughout this refactor whenever
-- SQLite's constraint model can't directly express what's needed.
-- ============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS class_teacher_skills_v2 (
  id              TEXT PRIMARY KEY,
  class_id        TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  monthly_rate    REAL NOT NULL DEFAULT 0,
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  assignment_type TEXT NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary','assistant','substitute','guest','examiner')),
  start_date      TEXT,
  end_date        TEXT,
  reason          TEXT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(class_id, teacher_id, skill_id, session_id)
);

INSERT INTO class_teacher_skills_v2 (id, class_id, teacher_id, skill_id, monthly_rate, branch_id, assignment_type, start_date, end_date, reason, session_id)
SELECT id, class_id, teacher_id, skill_id, monthly_rate, branch_id, 'primary', NULL, NULL, NULL, NULL
FROM class_teacher_skills;

DROP TABLE class_teacher_skills;
ALTER TABLE class_teacher_skills_v2 RENAME TO class_teacher_skills;

CREATE INDEX IF NOT EXISTS idx_cts_teacher ON class_teacher_skills(teacher_id);
CREATE INDEX IF NOT EXISTS idx_cts_class ON class_teacher_skills(class_id);
CREATE INDEX IF NOT EXISTS idx_cts_session ON class_teacher_skills(session_id);
CREATE INDEX IF NOT EXISTS idx_cts_type ON class_teacher_skills(assignment_type);

PRAGMA foreign_keys = ON;
