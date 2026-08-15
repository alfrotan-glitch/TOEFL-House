-- ============================================================================
-- 056 — Prevent duplicate ACTIVE semesters per student
-- ============================================================================
-- A double-click / retry on enroll-semester previously created multiple ACTIVE
-- student_semesters rows with the same name and charged the tuition once per
-- row (financial duplication). A partial unique index enforces at most one
-- ACTIVE semester per (student_id, semester_name); repeating a COMPLETED
-- semester remains allowed because the index only covers active rows.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_student_semester_active
  ON student_semesters(student_id, semester_name)
  WHERE status = 'active';
