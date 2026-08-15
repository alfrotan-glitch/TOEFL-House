-- ============================================================================
-- 051 — Extend visitors.placement_status CHECK to include 'in_progress'
-- ============================================================================
-- The unified Placement Assessment Workspace (migration 038) transitions a
-- visitor's placement_status to 'in_progress' the moment an assessment attempt
-- starts (placement.routes.ts), but the column CHECK introduced in migration
-- 037 only allowed ('not_started','scheduled','completed','waived'). Every
-- attempt start therefore failed with SQLITE_CONSTRAINT_CHECK and a misleading
-- 400 "Invalid data provided". This migration adds 'in_progress' to the CHECK.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. The
-- PRAGMA marker below tells the migration runner to disable foreign-key
-- enforcement around this file's transaction so the DROP does not cascade
-- into child tables (visitor_followups, placement_assessment_attempts,
-- students.lead_id, exam results). Triggers whose bodies reference
-- `visitors` must be dropped before the rebuild and recreated afterwards;
-- column names are listed explicitly (never SELECT *) so newer columns are
-- never shifted positionally.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_exam_results_branch_integrity_insert;
DROP TRIGGER IF EXISTS trg_exam_results_branch_integrity_update;

PRAGMA foreign_keys = OFF;

CREATE TABLE visitors_rebuilt_051 (
  id                      TEXT PRIMARY KEY,
  serial_no               TEXT,
  full_name               TEXT NOT NULL,
  phone                   TEXT,
  email                   TEXT,
  gender                  TEXT NOT NULL,
  source                  TEXT NOT NULL,
  campaign_id             TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  stage                   TEXT DEFAULT 'lead' CHECK (stage IN (
                            'lead','inquiry','follow_up','placement_booking',
                            'placement_fee','placement_completed',
                            'class_fee','card_issued','book_issued',
                            'registration','enrollment',
                            'active','graduated','alumni','lost'
                          )),
  assigned_to             TEXT,
  visit_date              TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'visited',
  notes                   TEXT,
  branch_id               TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  interested_course       TEXT,
  follow_up_status        TEXT,
  next_contact_date       TEXT,
  father_name             TEXT,
  address_region          TEXT,
  tazkira_no              TEXT,
  whatsapp                TEXT,
  dob                     TEXT,
  school_or_university    TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  placement_score         TEXT,
  program_version_id      TEXT REFERENCES program_versions(id) ON DELETE SET NULL,
  placement_method        TEXT,
  placement_status        TEXT NOT NULL DEFAULT 'not_started' CHECK (placement_status IN ('not_started','scheduled','in_progress','completed','waived')),
  current_placement_attempt_id TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO visitors_rebuilt_051 (
  id, serial_no, full_name, phone, email, gender, source, campaign_id, stage,
  assigned_to, visit_date, status, notes, branch_id, interested_course,
  follow_up_status, next_contact_date, father_name, address_region, tazkira_no,
  whatsapp, dob, school_or_university, emergency_contact_name,
  emergency_contact_phone, placement_score, program_version_id, placement_method,
  placement_status, current_placement_attempt_id, created_at
)
SELECT
  id, serial_no, full_name, phone, email, gender, source, campaign_id, stage,
  assigned_to, visit_date, status, notes, branch_id, interested_course,
  follow_up_status, next_contact_date, father_name, address_region, tazkira_no,
  whatsapp, dob, school_or_university, emergency_contact_name,
  emergency_contact_phone, placement_score, program_version_id, placement_method,
  placement_status, current_placement_attempt_id, created_at
FROM visitors;

DROP TABLE visitors;

ALTER TABLE visitors_rebuilt_051 RENAME TO visitors;

CREATE INDEX IF NOT EXISTS idx_visitors_program_version ON visitors(program_version_id);
CREATE INDEX IF NOT EXISTS idx_visitors_placement_status ON visitors(placement_status);
CREATE INDEX IF NOT EXISTS idx_visitors_branch       ON visitors(branch_id);
CREATE INDEX IF NOT EXISTS idx_visitors_status       ON visitors(status);
CREATE INDEX IF NOT EXISTS idx_visitors_stage        ON visitors(stage);
CREATE INDEX IF NOT EXISTS idx_visitors_campaign     ON visitors(campaign_id);
CREATE INDEX IF NOT EXISTS idx_visitors_source       ON visitors(source);
CREATE INDEX IF NOT EXISTS idx_visitors_branch_status ON visitors(branch_id, status);

CREATE TRIGGER IF NOT EXISTS trg_exam_results_branch_integrity_insert
BEFORE INSERT ON exam_results
WHEN (SELECT branch_id FROM exams WHERE id = NEW.exam_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
   OR (NEW.visitor_id IS NOT NULL AND (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Exam result branch does not match candidate/exam branch'); END;

CREATE TRIGGER IF NOT EXISTS trg_exam_results_branch_integrity_update
BEFORE UPDATE OF exam_id, student_id, visitor_id, branch_id ON exam_results
WHEN (SELECT branch_id FROM exams WHERE id = NEW.exam_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
   OR (NEW.visitor_id IS NOT NULL AND (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Exam result branch does not match candidate/exam branch'); END;
