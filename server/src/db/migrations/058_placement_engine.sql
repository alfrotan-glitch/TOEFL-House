-- ============================================================================
-- 058 — Placement Assessment Engine: policy mode, timing, scoring provenance,
--       decision conditions, content expansion (sections/rubrics/media).
-- ============================================================================
-- Evolves existing placement structures (no parallel models):
--   * profiles   → Placement Policy: requirement_mode (required/optional/
--                  not_required), first_level_exempt, expires_minutes,
--                  decision_rules_json (conditional placement rules).
--   * attempts   → expires_at, paused_at/resumed_at, policy_version,
--                  decision_rule_id, audited manual override fields; status
--                  CHECK expanded with 'paused' and 'expired'.
--   * results    → server-enforced component timing (started_at, deadline_at,
--                  submitted_at, elapsed_seconds, timeout_flag, paused_at) and
--                  scoring provenance (raw_score, percentage, weighted_score,
--                  score_version, corrected_at, correction_reason); status
--                  CHECK expanded with 'timed_out'.
--   * rules      → conditions_json (IF reading>=X AND listening>=Y THEN level).
--   * tests      → difficulty, duration_seconds, content version counter,
--                  rubric_id (writing/speaking), word_target, content_json.
--   * questions  → difficulty, section_key (links to sections/tracks/passages).
--   * NEW placement_test_sections (listening tracks / reading passages /
--                  speaking blocks), placement_rubrics (criteria_json),
--                  placement_media (safe audio/file storage with sha256).
-- ============================================================================

PRAGMA foreign_keys = OFF;

-- ── New content structures ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS placement_rubrics (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('writing','speaking','interview')),
  criteria_json TEXT NOT NULL DEFAULT '[]',   -- [{ key, label, weight, max_score }]
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS placement_test_sections (
  id               TEXT PRIMARY KEY,
  test_id          TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  section_key      TEXT NOT NULL,
  title            TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('audio_track','passage','prompt_block','instructions')),
  audio_url        TEXT,          -- media reference (placement_media id or external URL)
  transcript       TEXT,
  body             TEXT,          -- passage text / block content
  duration_seconds INTEGER,
  order_index      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(test_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_sections_test ON placement_test_sections(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_media (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','document','image','other')),
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_placement_media_branch ON placement_media(branch_id, kind);

-- ── Tests / questions expansion ────────────────────────────────────────────
ALTER TABLE placement_tests ADD COLUMN difficulty TEXT;
ALTER TABLE placement_tests ADD COLUMN duration_seconds INTEGER;
ALTER TABLE placement_tests ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE placement_tests ADD COLUMN rubric_id TEXT REFERENCES placement_rubrics(id) ON DELETE SET NULL;
ALTER TABLE placement_tests ADD COLUMN word_target INTEGER;
ALTER TABLE placement_tests ADD COLUMN content_json TEXT;

ALTER TABLE placement_test_questions ADD COLUMN difficulty TEXT;
ALTER TABLE placement_test_questions ADD COLUMN section_key TEXT;

-- ── Profiles → Placement Policy ────────────────────────────────────────────
ALTER TABLE placement_assessment_profiles ADD COLUMN requirement_mode TEXT NOT NULL DEFAULT 'required' CHECK (requirement_mode IN ('required','optional','not_required'));
ALTER TABLE placement_assessment_profiles ADD COLUMN first_level_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE placement_assessment_profiles ADD COLUMN expires_minutes INTEGER;
ALTER TABLE placement_assessment_profiles ADD COLUMN decision_rules_json TEXT;

-- ── Decision rules: conditional thresholds ─────────────────────────────────
ALTER TABLE placement_rules ADD COLUMN conditions_json TEXT;

-- ── Profiles: method CHECK admits content_test (single-component policies) ──
CREATE TABLE placement_assessment_profiles_058 (
  id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'skill_scores' CHECK (method IN ('skill_scores','level_assessment','written_test','interview','hybrid','content_test')),
  sections_json TEXT NOT NULL DEFAULT '[]',
  max_score REAL NOT NULL DEFAULT 100,
  pass_score REAL NOT NULL DEFAULT 60,
  instructions TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  requirement_mode TEXT NOT NULL DEFAULT 'required' CHECK (requirement_mode IN ('required','optional','not_required')),
  first_level_exempt INTEGER NOT NULL DEFAULT 0,
  expires_minutes INTEGER,
  decision_rules_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  components_json TEXT NOT NULL DEFAULT '[]',
  scoring_model TEXT NOT NULL DEFAULT 'weighted_average',
  allow_retake INTEGER NOT NULL DEFAULT 1,
  UNIQUE(program_version_id, branch_id)
);
INSERT INTO placement_assessment_profiles_058 (
  id, program_version_id, branch_id, enabled, required, method, sections_json, max_score, pass_score,
  instructions, version, requirement_mode, first_level_exempt, expires_minutes, decision_rules_json,
  created_at, updated_at, components_json, scoring_model, allow_retake
)
SELECT
  id, program_version_id, branch_id, enabled, required, method, sections_json, max_score, pass_score,
  instructions, version, requirement_mode, first_level_exempt, expires_minutes, decision_rules_json,
  created_at, updated_at, components_json, scoring_model, allow_retake
FROM placement_assessment_profiles;
DROP TABLE placement_assessment_profiles;
ALTER TABLE placement_assessment_profiles_058 RENAME TO placement_assessment_profiles;

-- ── Visitors: placement requirement mode + status timestamp (reporting) ────
ALTER TABLE visitors ADD COLUMN placement_requirement_mode TEXT;
ALTER TABLE visitors ADD COLUMN placement_status_at TEXT;
ALTER TABLE visitors ADD COLUMN current_placement_attempt_id TEXT REFERENCES placement_assessment_attempts(id) ON DELETE SET NULL;

-- ── Attempts: expiry, pause/resume, policy version, override ───────────────
ALTER TABLE placement_assessment_attempts ADD COLUMN expires_at TEXT;
ALTER TABLE placement_assessment_attempts ADD COLUMN paused_at TEXT;
ALTER TABLE placement_assessment_attempts ADD COLUMN resumed_at TEXT;
ALTER TABLE placement_assessment_attempts ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE placement_assessment_attempts ADD COLUMN decision_rule_id TEXT;
ALTER TABLE placement_assessment_attempts ADD COLUMN override_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL;
ALTER TABLE placement_assessment_attempts ADD COLUMN override_reason TEXT;
ALTER TABLE placement_assessment_attempts ADD COLUMN override_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE placement_assessment_attempts ADD COLUMN override_at TEXT;

CREATE TABLE placement_assessment_attempts_058 (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  program_version_id TEXT NOT NULL REFERENCES program_versions(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL REFERENCES placement_assessment_profiles(id) ON DELETE RESTRICT,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','paused','completed','expired','cancelled')),
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
  expires_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1,
  decision_rule_id TEXT,
  override_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  override_reason TEXT,
  override_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  override_at TEXT,
  UNIQUE(visitor_id, attempt_number)
);
INSERT INTO placement_assessment_attempts_058 (
  id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status, started_at,
  completed_at, total_score, max_score, percentage, recommended_level_id, recommendation_text,
  examiner_user_id, snapshot_json, notes, created_at, updated_at, expires_at, paused_at, resumed_at,
  policy_version, decision_rule_id, override_level_id, override_reason, override_by, override_at
)
SELECT
  id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status, started_at,
  completed_at, total_score, max_score, percentage, recommended_level_id, recommendation_text,
  examiner_user_id, snapshot_json, notes, created_at, updated_at, expires_at, paused_at, resumed_at,
  policy_version, decision_rule_id, override_level_id, override_reason, override_by, override_at
FROM placement_assessment_attempts;
DROP TABLE placement_assessment_attempts;
ALTER TABLE placement_assessment_attempts_058 RENAME TO placement_assessment_attempts;

-- ── Results: timing + scoring provenance + timed_out status ────────────────
ALTER TABLE placement_assessment_results ADD COLUMN raw_score REAL;
ALTER TABLE placement_assessment_results ADD COLUMN percentage REAL;
ALTER TABLE placement_assessment_results ADD COLUMN weighted_score REAL;
ALTER TABLE placement_assessment_results ADD COLUMN score_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE placement_assessment_results ADD COLUMN correction_reason TEXT;
ALTER TABLE placement_assessment_results ADD COLUMN corrected_at TEXT;
ALTER TABLE placement_assessment_results ADD COLUMN started_at TEXT;
ALTER TABLE placement_assessment_results ADD COLUMN deadline_at TEXT;
ALTER TABLE placement_assessment_results ADD COLUMN submitted_at TEXT;
ALTER TABLE placement_assessment_results ADD COLUMN elapsed_seconds INTEGER;
ALTER TABLE placement_assessment_results ADD COLUMN timeout_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE placement_assessment_results ADD COLUMN paused_at TEXT;

CREATE TABLE placement_assessment_results_058 (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('skill_scores','written_test','interview','level_assessment','custom_score','content_test')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','waived','timed_out')),
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
  raw_score REAL,
  percentage REAL,
  weighted_score REAL,
  score_version INTEGER NOT NULL DEFAULT 1,
  correction_reason TEXT,
  corrected_at TEXT,
  started_at TEXT,
  deadline_at TEXT,
  submitted_at TEXT,
  elapsed_seconds INTEGER,
  timeout_flag INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  UNIQUE(attempt_id, component_key)
);
INSERT INTO placement_assessment_results_058 (
  id, attempt_id, component_key, component_type, label, status, score, max_score, weight,
  selected_level_id, notes, result_text, payload_json, evaluator_user_id, completed_at, updated_at,
  raw_score, percentage, weighted_score, score_version, correction_reason, corrected_at,
  started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag, paused_at
)
SELECT
  id, attempt_id, component_key, component_type, label, status, score, max_score, weight,
  selected_level_id, notes, result_text, payload_json, evaluator_user_id, completed_at, updated_at,
  raw_score, percentage, weighted_score, score_version, correction_reason, corrected_at,
  started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag, paused_at
FROM placement_assessment_results;
DROP TABLE placement_assessment_results;
ALTER TABLE placement_assessment_results_058 RENAME TO placement_assessment_results;

CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor ON placement_assessment_attempts(visitor_id, status, attempt_number);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_branch ON placement_assessment_attempts(branch_id, status, started_at);
