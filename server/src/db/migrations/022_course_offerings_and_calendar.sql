-- Course Offering: Program Version + Level + Branch + Term delivery instance.
-- Class is a section under an offering; students enroll into class via enrollment, not stored on class row.

CREATE TABLE IF NOT EXISTS course_offerings (
  id                  TEXT PRIMARY KEY,
  program_id          TEXT REFERENCES programs(id),
  program_version_id  TEXT REFERENCES program_versions(id),
  level_id            TEXT REFERENCES levels(id),
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  academic_term_id    TEXT REFERENCES academic_terms(id),
  code                TEXT,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','open','closed','archived')),
  capacity_total      INTEGER NOT NULL DEFAULT 0,
  fee_snapshot        REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_course_offerings_branch ON course_offerings(branch_id, status);

-- Link class to offering (nullable for legacy rows)
ALTER TABLE classes ADD COLUMN offering_id TEXT REFERENCES course_offerings(id);

-- Branch holiday calendar (Session Engine skips these dates)
CREATE TABLE IF NOT EXISTS academic_holidays (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(branch_id, date)
);
