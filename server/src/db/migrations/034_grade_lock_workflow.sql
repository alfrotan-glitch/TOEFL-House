-- ============================================================================
-- Migration 034 — Academic Module Refactor, Phase 7
-- Grade Lock Workflow
-- ============================================================================
--
-- Draft → Submitted → Reviewed → Approved → Published → Locked, applied
-- per-assessment (the whole assessment's grades move through review
-- together, not each student's grade individually).
--
-- Unlike migrations 030-032, this one is a single ALTER TABLE — verified
-- directly (see Phase 7 report) that SQLite permits an ADD COLUMN with a
-- CHECK constraint that only references the new column itself, as long as
-- the DEFAULT satisfies it. No table rebuild needed this time.
-- ============================================================================

ALTER TABLE class_assessments ADD COLUMN lock_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (lock_status IN ('draft','submitted','reviewed','approved','published','locked'));
ALTER TABLE class_assessments ADD COLUMN lock_status_updated_at TEXT;
