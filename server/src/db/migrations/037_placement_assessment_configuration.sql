-- 037 — Program-specific, optional placement assessment configuration
ALTER TABLE visitors ADD COLUMN program_version_id TEXT REFERENCES program_versions(id) ON DELETE SET NULL;
ALTER TABLE visitors ADD COLUMN placement_method TEXT;
ALTER TABLE visitors ADD COLUMN placement_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (placement_status IN ('not_started','scheduled','completed','waived'));

CREATE TABLE IF NOT EXISTS placement_assessment_profiles (
  id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'skill_scores'
    CHECK (method IN ('skill_scores','level_assessment','written_test','interview','hybrid')),
  sections_json TEXT NOT NULL DEFAULT '["grammar","writing","listening","speaking"]',
  max_score REAL NOT NULL DEFAULT 100,
  pass_score REAL NOT NULL DEFAULT 60,
  instructions TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(program_version_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_placement_profile_program_branch
  ON placement_assessment_profiles(program_version_id, branch_id, enabled);
CREATE INDEX IF NOT EXISTS idx_visitors_program_version
  ON visitors(program_version_id);
CREATE INDEX IF NOT EXISTS idx_visitors_placement_status
  ON visitors(placement_status);

