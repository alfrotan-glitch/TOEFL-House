-- Enrollment lifecycle log (transfer / suspend / resume). Past session rosters are never rewritten.
CREATE TABLE IF NOT EXISTS enrollment_events (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  student_id      TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'enrolled','transferred','suspended','resumed','dropped','completed'
                  )),
  from_class_id   TEXT,
  to_class_id     TEXT,
  notes           TEXT,
  actor_user_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enrollment_events_student ON enrollment_events(student_id, created_at DESC);

-- Allow transferred status on enrollments (SQLite cannot alter CHECK easily — app-level enforces)
