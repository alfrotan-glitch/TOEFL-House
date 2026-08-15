-- 038 — Unified program-specific placement assessment workspace
ALTER TABLE placement_assessment_profiles ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE placement_assessment_profiles ADD COLUMN scoring_model TEXT NOT NULL DEFAULT 'weighted_average';
ALTER TABLE placement_assessment_profiles ADD COLUMN allow_retake INTEGER NOT NULL DEFAULT 1;
ALTER TABLE visitors ADD COLUMN current_placement_attempt_id TEXT;

CREATE TABLE IF NOT EXISTS placement_assessment_attempts (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  program_version_id TEXT NOT NULL REFERENCES program_versions(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES placement_assessment_profiles(id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  total_score REAL,
  max_score REAL,
  percentage REAL,
  recommended_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  recommendation_text TEXT,
  examiner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(visitor_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS placement_assessment_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('skill_scores','written_test','interview','level_assessment','custom_score')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','waived')),
  score REAL,
  max_score REAL NOT NULL DEFAULT 100,
  weight REAL NOT NULL DEFAULT 0,
  selected_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  notes TEXT,
  result_text TEXT,
  payload_json TEXT,
  evaluator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, component_key)
);

CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor ON placement_assessment_attempts(visitor_id, status, attempt_number);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_branch ON placement_assessment_attempts(branch_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);
