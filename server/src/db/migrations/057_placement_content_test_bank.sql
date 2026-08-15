-- ============================================================================
-- 057 — Content-driven placement: reusable test bank + candidate responses
-- ============================================================================
-- Adds the minimum architecture for a real content-driven placement system:
--   * placement_tests            — reusable test-bank entries (listening /
--                                   reading / writing / speaking) with
--                                   audio URL + transcript + passage.
--   * placement_test_questions   — questions per test (MCQ / short answer /
--                                   essay / speaking), answer keys, points.
--   * placement_assessment_responses — candidate answers per attempt,
--                                   auto-scored server-side (UNIQUE per
--                                   attempt+question → replay-safe).
-- The results table CHECK is rebuilt to admit the new 'content_test'
-- component type. Attempts already snapshot the profile; the snapshot will
-- now also carry the immutable test content + answer keys.
-- ============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS placement_tests (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  test_type     TEXT NOT NULL CHECK (test_type IN ('listening','reading','writing','speaking')),
  instructions  TEXT,
  audio_url     TEXT,
  transcript    TEXT,
  passage       TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL, -- NULL = global
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_placement_tests_active ON placement_tests(status, branch_id, test_type);

CREATE TABLE IF NOT EXISTS placement_test_questions (
  id           TEXT PRIMARY KEY,
  test_id      TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  qtype        TEXT NOT NULL CHECK (qtype IN ('mcq','short_answer','essay','speaking')),
  prompt       TEXT NOT NULL,
  options_json TEXT,          -- JSON array of { key, text } for mcq
  answer_key   TEXT,          -- exact expected answer (mcq option key / short-answer text)
  points       REAL NOT NULL DEFAULT 1,
  order_index  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(test_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_questions_test ON placement_test_questions(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_assessment_responses (
  id            TEXT PRIMARY KEY,
  attempt_id    TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  test_id       TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE RESTRICT,
  question_id   TEXT NOT NULL REFERENCES placement_test_questions(id) ON DELETE RESTRICT,
  question_key  TEXT NOT NULL,
  response_json TEXT,          -- candidate answer (selected option / text)
  auto_score    REAL,          -- points earned (server-computed for mcq/short_answer)
  max_points    REAL NOT NULL DEFAULT 1,
  feedback      TEXT,          -- auto feedback / evaluator comment
  answered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_responses_attempt ON placement_assessment_responses(attempt_id, question_id);

-- Rebuild placement_assessment_results with 'content_test' in the CHECK.
CREATE TABLE placement_assessment_results_057 (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('skill_scores','written_test','interview','level_assessment','custom_score','content_test')),
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

INSERT INTO placement_assessment_results_057 (
  id, attempt_id, component_key, component_type, label, status, score, max_score,
  weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id,
  completed_at, updated_at
)
SELECT
  id, attempt_id, component_key, component_type, label, status, score, max_score,
  weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id,
  completed_at, updated_at
FROM placement_assessment_results;

DROP TABLE placement_assessment_results;
ALTER TABLE placement_assessment_results_057 RENAME TO placement_assessment_results;

CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);
