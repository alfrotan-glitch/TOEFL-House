-- ============================================================================
-- Migration 033 — Academic Module Refactor, Phase 4
-- Gradebook Engine
-- ============================================================================
--
-- Two additions, both simple ADD COLUMN / CREATE TABLE (no CHECK-constraint
-- changes, so no table-rebuild pattern needed this time):
--
-- 1. grade_history — student_grades has always overwritten score/status/
--    notes in place with zero audit trail of prior values. This table
--    captures every actual change (see hasGradeChanged() in
--    core/academic/gradebook-service.ts — no-op resaves of identical
--    values are NOT logged, to keep this useful under an auto-save UI
--    rather than growing unbounded).
--
-- 2. student_semesters.final_score / final_percentage / letter_grade —
--    complete-semester has only ever persisted pass/fail (via `status`);
--    the actual computed score/percentage vanished once grading closed.
--    Populated once, at completion time, by the same computeClassGrades()
--    the live gradebook preview uses — closing a real gap ahead of the
--    Phase 10 Transcript Engine, which will need this data to already
--    exist rather than trying to reconstruct it later from raw grades
--    that may have since been edited.
-- ============================================================================

CREATE TABLE IF NOT EXISTS grade_history (
  id              TEXT PRIMARY KEY,
  grade_id        TEXT NOT NULL REFERENCES student_grades(id) ON DELETE CASCADE,
  assessment_id   TEXT NOT NULL,
  student_id      TEXT NOT NULL,
  class_id        TEXT NOT NULL,
  previous_score  REAL,
  previous_status TEXT,
  previous_notes  TEXT,
  new_score       REAL,
  new_status      TEXT NOT NULL,
  new_notes       TEXT,
  changed_by      TEXT,
  changed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_grade_history_grade ON grade_history(grade_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_grade_history_student_class ON grade_history(student_id, class_id);

ALTER TABLE student_semesters ADD COLUMN final_score REAL;
ALTER TABLE student_semesters ADD COLUMN final_percentage REAL;
ALTER TABLE student_semesters ADD COLUMN letter_grade TEXT;
