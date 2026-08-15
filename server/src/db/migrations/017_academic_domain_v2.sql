-- ============================================================================
-- 017 — Academic Domain Model v2
-- Program Versioning · Subjects · Modules · Promotion/Placement Rules
-- Fee Rules · Class Generation drafts · Branch academic profile
-- ============================================================================

-- Catalog program (org-level identity) may span versions
CREATE TABLE IF NOT EXISTS program_versions (
  id                TEXT PRIMARY KEY,
  program_id        TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  version_label     TEXT NOT NULL,
  version_number    INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','published','archived')),
  effective_from    TEXT,
  effective_to      TEXT,
  duration_months   INTEGER NOT NULL DEFAULT 0,
  description       TEXT,
  is_default        INTEGER NOT NULL DEFAULT 0,
  published_at      TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(program_id, version_number)
);

-- Link levels to a specific program version (null = legacy unversioned)
ALTER TABLE levels ADD COLUMN program_version_id TEXT REFERENCES program_versions(id);
ALTER TABLE levels ADD COLUMN code TEXT;
ALTER TABLE levels ADD COLUMN duration_months INTEGER DEFAULT 0;
ALTER TABLE levels ADD COLUMN default_fee REAL DEFAULT 0;
ALTER TABLE levels ADD COLUMN pass_mark REAL DEFAULT 60;
ALTER TABLE levels ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE levels ADD COLUMN min_viable_size INTEGER DEFAULT 5;

CREATE TABLE IF NOT EXISTS subjects (
  id                  TEXT PRIMARY KEY,
  program_version_id  TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL,
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  hours               INTEGER NOT NULL DEFAULT 0,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(program_version_id, code)
);

CREATE TABLE IF NOT EXISTS modules (
  id              TEXT PRIMARY KEY,
  subject_id      TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  hours           INTEGER NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  assessment_type TEXT DEFAULT 'continuous',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subject_id, code)
);

-- Promotion rules (versioned, branch-overridable)
CREATE TABLE IF NOT EXISTS promotion_rules (
  id                  TEXT PRIMARY KEY,
  program_version_id  TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  from_level_id       TEXT REFERENCES levels(id) ON DELETE SET NULL,
  to_level_id         TEXT REFERENCES levels(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  min_score           REAL NOT NULL DEFAULT 60,
  min_attendance_pct  REAL NOT NULL DEFAULT 75,
  require_all_subjects INTEGER NOT NULL DEFAULT 1,
  auto_promote        INTEGER NOT NULL DEFAULT 0,
  branch_id           TEXT REFERENCES branches(id),
  is_active           INTEGER NOT NULL DEFAULT 1,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Placement rules: score bands → recommended level
CREATE TABLE IF NOT EXISTS placement_rules (
  id                  TEXT PRIMARY KEY,
  program_version_id  TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  min_score           REAL NOT NULL DEFAULT 0,
  max_score           REAL NOT NULL DEFAULT 120,
  recommended_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  recommended_level_code TEXT,
  branch_id           TEXT REFERENCES branches(id),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fee rules (academic-aware, versioned)
CREATE TABLE IF NOT EXISTS fee_rules (
  id                  TEXT PRIMARY KEY,
  program_version_id  TEXT REFERENCES program_versions(id) ON DELETE CASCADE,
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL,
  branch_id           TEXT REFERENCES branches(id),
  fee_type            TEXT NOT NULL
                      CHECK (fee_type IN (
                        'registration','placement','semester','book','retake',
                        'diploma','card','exam','other'
                      )),
  name                TEXT NOT NULL,
  amount              REAL NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'AFN',
  is_optional         INTEGER NOT NULL DEFAULT 0,
  effective_from      TEXT,
  effective_to        TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Class generation drafts (from configuration → operational classes)
CREATE TABLE IF NOT EXISTS class_generation_runs (
  id                  TEXT PRIMARY KEY,
  branch_id           TEXT NOT NULL REFERENCES branches(id),
  academic_term_id    TEXT REFERENCES academic_terms(id),
  program_version_id  TEXT REFERENCES program_versions(id),
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','preview','published','cancelled')),
  params_json         TEXT NOT NULL DEFAULT '{}',
  result_json         TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  published_at        TEXT
);

CREATE TABLE IF NOT EXISTS class_generation_items (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES class_generation_runs(id) ON DELETE CASCADE,
  level_id            TEXT REFERENCES levels(id),
  level_name          TEXT,
  time_slot_id        TEXT REFERENCES time_slots(id),
  room_id             TEXT REFERENCES rooms(id),
  teacher_id          TEXT,
  capacity            INTEGER NOT NULL DEFAULT 20,
  min_viable_size     INTEGER NOT NULL DEFAULT 5,
  fee                 REAL NOT NULL DEFAULT 0,
  proposed_name       TEXT,
  class_id            TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','created','skipped','error')),
  error_message       TEXT
);

-- Branch academic profile (independence knobs)
CREATE TABLE IF NOT EXISTS branch_academic_profiles (
  branch_id               TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  default_program_version_id TEXT REFERENCES program_versions(id),
  placement_test_fee      REAL NOT NULL DEFAULT 0,
  registration_fee        REAL NOT NULL DEFAULT 0,
  card_fee                REAL NOT NULL DEFAULT 0,
  diploma_fee             REAL NOT NULL DEFAULT 0,
  default_pass_mark       REAL NOT NULL DEFAULT 60,
  default_min_attendance  REAL NOT NULL DEFAULT 75,
  academic_year_label     TEXT,
  notes                   TEXT,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enrollments should pin program version for historical integrity
ALTER TABLE enrollments ADD COLUMN program_version_id TEXT REFERENCES program_versions(id);
ALTER TABLE enrollments ADD COLUMN fee_snapshot_json TEXT;

CREATE INDEX IF NOT EXISTS idx_program_versions_program ON program_versions(program_id, status);
CREATE INDEX IF NOT EXISTS idx_subjects_version ON subjects(program_version_id, level_id);
CREATE INDEX IF NOT EXISTS idx_modules_subject ON modules(subject_id);
CREATE INDEX IF NOT EXISTS idx_promotion_rules_version ON promotion_rules(program_version_id, is_active);
CREATE INDEX IF NOT EXISTS idx_placement_rules_version ON placement_rules(program_version_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fee_rules_lookup ON fee_rules(branch_id, fee_type, is_active);
CREATE INDEX IF NOT EXISTS idx_class_gen_runs_branch ON class_generation_runs(branch_id, status);
