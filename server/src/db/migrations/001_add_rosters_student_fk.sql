-- ============================================================================
-- Migration 001: Add missing FOREIGN KEY on rosters.student_id
-- ============================================================================
-- Audit §5.4: rosters.student_id had no REFERENCES students(id), unlike every
-- other student-linking column. SQLite cannot ALTER TABLE to add a FK, so we
-- recreate the table with the constraint and copy existing rows.
-- ============================================================================

CREATE TABLE rosters_new (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_status TEXT NOT NULL DEFAULT 'not_marked' CHECK (attendance_status IN (
    'present','absent','sick','leave','not_marked'
  )),
  marked_at         TEXT,
  UNIQUE(session_id, student_id)
);

INSERT INTO rosters_new (id, session_id, student_id, attendance_status, marked_at)
SELECT id, session_id, student_id, attendance_status, marked_at FROM rosters;
DROP TABLE rosters;
ALTER TABLE rosters_new RENAME TO rosters;

-- Recreate indexes (dropped with the old table)
CREATE INDEX IF NOT EXISTS idx_rosters_session ON rosters(session_id);
CREATE INDEX IF NOT EXISTS idx_rosters_student ON rosters(student_id);