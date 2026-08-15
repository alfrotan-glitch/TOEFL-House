-- Student Journey Engine (append-only lifecycle store)
-- Nothing in student_journey_events is ever deleted or updated (except never).

CREATE TABLE IF NOT EXISTS student_journey_events (
  id              TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL REFERENCES students(id),
  event_type      TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  branch_id       TEXT REFERENCES branches(id),
  enrollment_id   TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  actor_user_id   TEXT,
  actor_name      TEXT,
  correlation_id  TEXT,
  causation_id    TEXT,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sje_student_time
  ON student_journey_events(student_id, occurred_at ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sje_type
  ON student_journey_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sje_enrollment
  ON student_journey_events(enrollment_id);

-- Canonical enrollment entity (repeat / partial_repeat / resume / jump supported)
CREATE TABLE IF NOT EXISTS enrollments (
  id               TEXT PRIMARY KEY,
  student_id       TEXT NOT NULL REFERENCES students(id),
  program_id       TEXT,
  program_name     TEXT,
  semester_name    TEXT,
  level_code       TEXT,
  class_id         TEXT REFERENCES classes(id),
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  enrollment_type  TEXT NOT NULL DEFAULT 'new' CHECK (enrollment_type IN (
                     'new','repeat','partial_repeat','resume','jump'
                   )),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                     'active','paused','suspended','dropped','completed','graduated'
                   )),
  skills_focus     TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_branch ON enrollments(branch_id);

CREATE TABLE IF NOT EXISTS student_id_cards (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id),
  issued_at    TEXT NOT NULL,
  expires_at   TEXT,
  fee_amount   REAL NOT NULL DEFAULT 0,
  printed      INTEGER NOT NULL DEFAULT 0,
  reprinted    INTEGER NOT NULL DEFAULT 0,
  design       TEXT,
  branch_id    TEXT REFERENCES branches(id),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_id_cards_student ON student_id_cards(student_id);
