-- ============================================================================
-- TOEFL House ERP — CANONICAL DATABASE SCHEMA (SQLite)
-- ============================================================================
--
-- This file is the SINGLE canonical representation of the database (§12).
-- There is no migration chain. An empty database plus this file plus the
-- canonical initializer produces a complete, valid database:
--
--     EMPTY DATABASE -> CANONICAL INITIALIZATION -> COMPLETE VALID DATABASE
--
-- Schema changes are made by editing THIS FILE. Nothing else defines schema.
--
-- Conventions
--   * Dates are ISO-8601 'YYYY-MM-DD'; timestamps via datetime('now') in UTC.
--   * Booleans are INTEGER 0/1.
--   * JSON payloads are TEXT.
--   * Every operational table carries branch_id so branch isolation is
--     enforceable in the database rather than only in application code.
--   * Every foreign key states an explicit ON DELETE action.
--   * Monetary values are AFN. Storage representation is owned by the money
--     authority in server/src/utils/money.ts.
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- ORGANIZATION & CONFIGURATION
-- ============================================================================
-- Organization is the root of every scope. Every operational row is reachable
-- from exactly one branch, which is what makes branch isolation enforceable.

CREATE TABLE IF NOT EXISTS organizations ( 
  id          TEXT PRIMARY KEY, 
  name        TEXT NOT NULL, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS campuses ( 
  id               TEXT PRIMARY KEY, 
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, 
  name             TEXT NOT NULL, 
  code             TEXT NOT NULL UNIQUE, 
  address          TEXT, 
  postal_code      TEXT, 
  phone            TEXT, 
  email            TEXT, 
  description      TEXT, 
  is_active        INTEGER NOT NULL DEFAULT 1, 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_campuses_active     ON campuses(is_active);
CREATE INDEX IF NOT EXISTS idx_campuses_org        ON campuses(organization_id);

CREATE TABLE IF NOT EXISTS branches ( 
  id           TEXT PRIMARY KEY, 
  campus_id    TEXT REFERENCES campuses(id) ON DELETE SET NULL, 
  name         TEXT NOT NULL, 
  code         TEXT UNIQUE, 
  location     TEXT NOT NULL DEFAULT '', 
  address      TEXT, 
  postal_code  TEXT, 
  phone        TEXT, 
  email        TEXT, 
  description  TEXT, 
  is_active    INTEGER NOT NULL DEFAULT 1, 
  created_at   TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_branches_active     ON branches(is_active);
CREATE INDEX IF NOT EXISTS idx_branches_campus     ON branches(campus_id);
CREATE INDEX IF NOT EXISTS idx_branches_code       ON branches(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_code_unique ON branches(code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS partners ( 
  id               TEXT PRIMARY KEY, 
  full_name        TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  phone            TEXT, 
  email            TEXT, 
  share_percent    REAL NOT NULL DEFAULT 0 CHECK (share_percent >= 0 AND share_percent <= 100),
  role_description TEXT 
);
CREATE TRIGGER IF NOT EXISTS trg_partners_total_share_insert
BEFORE INSERT ON partners
WHEN (SELECT COALESCE(SUM(share_percent), 0) FROM partners) + NEW.share_percent > 100
BEGIN SELECT RAISE(ABORT, 'total partner shares cannot exceed 100 percent'); END;
CREATE TRIGGER IF NOT EXISTS trg_partners_total_share_update
BEFORE UPDATE OF share_percent ON partners
WHEN (SELECT COALESCE(SUM(share_percent), 0) FROM partners WHERE id <> OLD.id) + NEW.share_percent > 100
BEGIN SELECT RAISE(ABORT, 'total partner shares cannot exceed 100 percent'); END;

CREATE TABLE IF NOT EXISTS system_settings ( 
  key   TEXT PRIMARY KEY, 
  value TEXT NOT NULL 
);

CREATE TABLE IF NOT EXISTS branch_academic_profiles ( 
  branch_id               TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE, 
  default_program_version_id TEXT REFERENCES program_versions(id) ON DELETE SET NULL, 
  placement_test_fee      INTEGER NOT NULL DEFAULT 0, 
  registration_fee        INTEGER NOT NULL DEFAULT 0, 
  card_fee                INTEGER NOT NULL DEFAULT 0, 
  diploma_fee             INTEGER NOT NULL DEFAULT 0, 
  default_pass_mark       REAL NOT NULL DEFAULT 60, 
  default_min_attendance  REAL NOT NULL DEFAULT 75, 
  academic_year_label     TEXT, 
  notes                   TEXT, 
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS academic_holidays ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  date        TEXT NOT NULL, 
  title       TEXT NOT NULL, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, date) 
);

-- ============================================================================
-- IDENTITY & ACCESS
-- ============================================================================
-- Identity, staff records and the authorization model. A user may hold several
-- role assignments; permission resolution is server-side and canonical.

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  full_name            TEXT NOT NULL,
  email                TEXT,
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  campus_id            TEXT REFERENCES campuses(id) ON DELETE SET NULL,
  linked_teacher_id    TEXT,
  linked_employee_id   TEXT,
  linked_partner_id    TEXT,
  linked_student_id    TEXT REFERENCES students(id) ON DELETE SET NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  session_version      INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_branch         ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_campus         ON users(campus_id);
CREATE INDEX IF NOT EXISTS idx_users_linked_student ON users(linked_student_id);

CREATE TABLE IF NOT EXISTS roles ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, 
  is_system INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, 
  sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT 
);
CREATE INDEX IF NOT EXISTS idx_roles_code            ON roles(code);

CREATE TABLE IF NOT EXISTS permissions ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, resource TEXT NOT NULL, action TEXT NOT NULL, 
  description TEXT, category TEXT NOT NULL DEFAULT 'general', is_system INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_permissions_code      ON permissions(code);
CREATE INDEX IF NOT EXISTS idx_permissions_resource  ON permissions(resource);

CREATE TABLE IF NOT EXISTS role_permissions ( 
  id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, 
  default_scope TEXT NOT NULL DEFAULT 'branch' CHECK (default_scope IN ('organization','campus','branch','department','program','class','own')), 
  UNIQUE(role_id, permission_id) 
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);

CREATE TABLE IF NOT EXISTS user_roles ( 
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')), 
  scope_id TEXT, is_primary INTEGER NOT NULL DEFAULT 0, assigned_by TEXT, 
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT, 
  UNIQUE(user_id, role_id, scope_type, scope_id) 
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role       ON user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user       ON user_roles(user_id);
CREATE TRIGGER IF NOT EXISTS trg_user_roles_single_primary_insert
BEFORE INSERT ON user_roles
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND is_primary = 1)
BEGIN
  SELECT RAISE(ABORT, 'user may have only one primary role');
END;
CREATE TRIGGER IF NOT EXISTS trg_user_roles_single_primary_update
BEFORE UPDATE OF is_primary, user_id ON user_roles
WHEN NEW.is_primary = 1 AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.user_id AND is_primary = 1 AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'user may have only one primary role');
END;

CREATE TABLE IF NOT EXISTS permission_overrides ( 
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, 
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')), 
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')), 
  scope_id TEXT, reason TEXT, granted_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT 
);
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user ON permission_overrides(user_id);

CREATE TABLE IF NOT EXISTS role_delegations ( 
  id TEXT PRIMARY KEY, from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  scope_type TEXT NOT NULL DEFAULT 'branch', scope_id TEXT, reason TEXT, 
  starts_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT NOT NULL, created_by TEXT, is_active INTEGER NOT NULL DEFAULT 1 
);

CREATE TABLE IF NOT EXISTS employees ( 
  id          TEXT PRIMARY KEY, 
  full_name   TEXT NOT NULL, 
  phone       TEXT, 
  email       TEXT, 
  role        TEXT NOT NULL, 
  base_salary INTEGER NOT NULL DEFAULT 0, 
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  joined_date TEXT NOT NULL, 
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL 
);
CREATE INDEX IF NOT EXISTS idx_employees_branch      ON employees(branch_id);

CREATE TABLE IF NOT EXISTS student_staff_relations (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  staff_type  TEXT NOT NULL CHECK (staff_type IN ('teacher','employee')),
  teacher_id  TEXT REFERENCES teachers(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  degree      INTEGER NOT NULL CHECK (degree IN (1,2)),
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  verified_by TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Exactly one counterparty, matching staff_type.
  CHECK ((staff_type = 'teacher'  AND teacher_id  IS NOT NULL AND employee_id IS NULL)
      OR (staff_type = 'employee' AND employee_id IS NOT NULL AND teacher_id  IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_staff_relations_student ON student_staff_relations(student_id);

-- ============================================================================
-- ADMISSIONS — VISITORS & STUDENTS
-- ============================================================================
-- The intake pipeline and the person records it produces.

CREATE TABLE IF NOT EXISTS campaigns ( 
  id         TEXT PRIMARY KEY, 
  name       TEXT NOT NULL, 
  source     TEXT NOT NULL CHECK (source IN ('ads','social','referral','event','organic','other')), 
  start_date TEXT NOT NULL, 
  end_date   TEXT, 
  budget     INTEGER NOT NULL DEFAULT 0, 
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')), 
  branch_id  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_campaigns_branch      ON campaigns(branch_id);

CREATE TABLE IF NOT EXISTS visitors (
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
, placement_requirement_mode TEXT, placement_status_at TEXT);
CREATE INDEX IF NOT EXISTS idx_visitors_branch       ON visitors(branch_id);
CREATE INDEX IF NOT EXISTS idx_visitors_branch_status ON visitors(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_visitors_campaign     ON visitors(campaign_id);
CREATE INDEX IF NOT EXISTS idx_visitors_placement_status ON visitors(placement_status);
CREATE INDEX IF NOT EXISTS idx_visitors_program_version ON visitors(program_version_id);
CREATE INDEX IF NOT EXISTS idx_visitors_source       ON visitors(source);
CREATE INDEX IF NOT EXISTS idx_visitors_stage        ON visitors(stage);
CREATE INDEX IF NOT EXISTS idx_visitors_status       ON visitors(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_visitors_serial_no
  ON visitors(serial_no) WHERE serial_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_visitors_tazkira_no
  ON visitors(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != '';

CREATE TABLE IF NOT EXISTS visitor_followups ( 
  id         TEXT PRIMARY KEY, 
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE, 
  date       TEXT NOT NULL, 
  notes      TEXT, 
  operator   TEXT, 
  outcome    TEXT CHECK (outcome IN ('interested','not_interested','callback','registered')) 
);

CREATE TABLE IF NOT EXISTS pipeline_metrics ( 
  pipeline              TEXT NOT NULL, 
  stage                 TEXT NOT NULL, 
  count                 INTEGER NOT NULL DEFAULT 0, 
  conversion_rate       REAL NOT NULL DEFAULT 0, 
  average_time_in_stage REAL NOT NULL DEFAULT 0, 
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  computed_at           TEXT NOT NULL DEFAULT (datetime('now')), 
  PRIMARY KEY (pipeline, stage, branch_id) 
);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_br   ON pipeline_metrics(branch_id);

CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  branch_id  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students ( 
  id                      TEXT PRIMARY KEY, 
  student_code            TEXT NOT NULL UNIQUE, 
  full_name               TEXT NOT NULL, 
  phone                   TEXT, 
  email                   TEXT, 
  qr_code                 TEXT, 
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','suspended')), 
  registration_date       TEXT NOT NULL, 
  branch_id               TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  discount_percent        REAL NOT NULL DEFAULT 0, 
  -- Migration 076: authoritative family/household identity for the
  -- FAMILY_OF_FOUR_PLUS discount category. Member count is derived from this
  -- link, never from a client-supplied familyMemberCount.
  household_id            TEXT REFERENCES households(id),
  lead_id                 TEXT REFERENCES visitors(id) ON DELETE SET NULL, 
  gender                  TEXT NOT NULL, 
  father_name             TEXT, 
  address_region          TEXT, 
  tazkira_no              TEXT, 
  whatsapp                TEXT, 
  dob                     TEXT, 
  school_or_university    TEXT, 
  emergency_contact_name  TEXT, 
  emergency_contact_phone TEXT, 
  notes                   TEXT, 
  placement_score         TEXT, 
  installment_plan        TEXT, 
  card_design             TEXT, 
  created_at              TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_students_branch       ON students(branch_id);
CREATE INDEX IF NOT EXISTS idx_students_code         ON students(student_code);
CREATE INDEX IF NOT EXISTS idx_students_household ON students(household_id);
CREATE INDEX IF NOT EXISTS idx_students_lead         ON students(lead_id);
CREATE INDEX IF NOT EXISTS idx_students_status       ON students(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email ON students(email) WHERE email IS NOT NULL AND email != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_lead_id ON students(lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone ON students(phone) WHERE phone IS NOT NULL AND phone != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone_normalized
  ON students (
    SUBSTR(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''),
      -9
    )
  )
  WHERE phone IS NOT NULL
    AND TRIM(phone) <> ''
    AND LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')) >= 7;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tazkira_no ON students(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != '';

CREATE TABLE IF NOT EXISTS student_semesters ( 
  id            TEXT PRIMARY KEY, 
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  semester_name TEXT NOT NULL, 
  class_id      TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  enroll_date   TEXT NOT NULL, 
  fee_amount    INTEGER NOT NULL DEFAULT 0, 
  net_fee_amount INTEGER, 
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','deferred')), 
  -- Gradebook Engine (Phase 4) — populated once, at complete-semester time,
  -- by the same computeClassGrades() the live gradebook preview uses.
  final_score      REAL, 
  final_percentage REAL, 
  letter_grade     TEXT 
);
CREATE INDEX IF NOT EXISTS idx_semesters_class       ON student_semesters(class_id);
CREATE INDEX IF NOT EXISTS idx_semesters_student     ON student_semesters(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_semester_active ON student_semesters(student_id, semester_name) WHERE status = 'active';
CREATE TRIGGER IF NOT EXISTS trg_student_semesters_nonnegative_insert
BEFORE INSERT ON student_semesters
WHEN NEW.fee_amount < 0 OR (NEW.net_fee_amount IS NOT NULL AND NEW.net_fee_amount < 0)
BEGIN SELECT RAISE(ABORT, 'semester fee cannot be negative'); END;
CREATE TRIGGER IF NOT EXISTS trg_student_semesters_nonnegative_update
BEFORE UPDATE OF fee_amount, net_fee_amount ON student_semesters
WHEN NEW.fee_amount < 0 OR (NEW.net_fee_amount IS NOT NULL AND NEW.net_fee_amount < 0)
BEGIN SELECT RAISE(ABORT, 'semester fee cannot be negative'); END;

CREATE TABLE IF NOT EXISTS registrations ( 
  id               TEXT PRIMARY KEY, 
  student_id       TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  class_id         TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  date             TEXT NOT NULL, 
  amount_paid      INTEGER NOT NULL DEFAULT 0, 
  receipt_number   TEXT, 
  discount_applied INTEGER NOT NULL DEFAULT 0, 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  source           TEXT, 
  semester         TEXT 
);
CREATE INDEX IF NOT EXISTS idx_registrations_class   ON registrations(class_id);
CREATE INDEX IF NOT EXISTS idx_registrations_student ON registrations(student_id);

CREATE TABLE IF NOT EXISTS student_journey_events ( 
  id              TEXT PRIMARY KEY, 
  student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  event_type      TEXT NOT NULL, 
  occurred_at     TEXT NOT NULL, 
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL, 
  enrollment_id   TEXT REFERENCES enrollments(id) ON DELETE CASCADE, 
  payload         TEXT NOT NULL DEFAULT '{}', 
  actor_user_id   TEXT, 
  actor_name      TEXT, 
  correlation_id  TEXT, 
  causation_id    TEXT, 
  schema_version  INTEGER NOT NULL DEFAULT 1, 
  created_at      TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_sje_enrollment        ON student_journey_events(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_sje_student_time      ON student_journey_events(student_id, occurred_at ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sje_type              ON student_journey_events(event_type, occurred_at DESC);

-- ============================================================================
-- PLACEMENT
-- ============================================================================
-- Placement assessment: profiles, banks, attempts, responses and results.

CREATE TABLE IF NOT EXISTS placement_assessment_profiles (
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
  allow_retake INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER, first_attempt_billable INTEGER NOT NULL DEFAULT 1, retake_billable INTEGER NOT NULL DEFAULT 0, retake_fee_amount REAL,
  UNIQUE(program_version_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_profile_program_branch
  ON placement_assessment_profiles(program_version_id, branch_id, enabled);

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
  difficulty    TEXT,
  duration_seconds INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  rubric_id     TEXT REFERENCES placement_rubrics(id) ON DELETE SET NULL,
  word_target   INTEGER,
  content_json  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_placement_tests_active ON placement_tests(status, branch_id, test_type);

CREATE TABLE IF NOT EXISTS placement_test_sections (
  id               TEXT PRIMARY KEY,
  test_id          TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  section_key      TEXT NOT NULL,
  title            TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('audio_track','passage','prompt_block','instructions')),
  audio_url        TEXT,
  transcript       TEXT,
  body             TEXT,
  duration_seconds INTEGER,
  order_index      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(test_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_sections_test ON placement_test_sections(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_test_questions (
  id           TEXT PRIMARY KEY,
  test_id      TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  qtype        TEXT NOT NULL CHECK (qtype IN ('mcq','short_answer','essay','speaking')),
  prompt       TEXT NOT NULL,
  options_json TEXT,
  answer_key   TEXT,
  points       REAL NOT NULL DEFAULT 1,
  order_index  INTEGER NOT NULL DEFAULT 0,
  difficulty   TEXT,
  section_key  TEXT,
  UNIQUE(test_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_questions_test ON placement_test_questions(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_rubrics (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('writing','speaking','interview')),
  criteria_json TEXT NOT NULL DEFAULT '[]',
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS placement_assessment_attempts (
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
  override_at TEXT, outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('passed', 'failed')),
  UNIQUE(visitor_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_branch ON placement_assessment_attempts(branch_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor ON placement_assessment_attempts(visitor_id, status, attempt_number);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor_outcome
  ON placement_assessment_attempts(visitor_id, status, outcome);
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_open_attempt
  ON placement_assessment_attempts(visitor_id)
  WHERE status IN ('in_progress', 'paused');

CREATE TABLE IF NOT EXISTS placement_assessment_responses (
  id            TEXT PRIMARY KEY,
  attempt_id    TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  test_id       TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE RESTRICT,
  question_id   TEXT NOT NULL REFERENCES placement_test_questions(id) ON DELETE RESTRICT,
  question_key  TEXT NOT NULL,
  response_json TEXT,
  auto_score    REAL,
  max_points    REAL NOT NULL DEFAULT 1,
  feedback      TEXT,
  answered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_responses_attempt ON placement_assessment_responses(attempt_id, question_id);

CREATE TABLE IF NOT EXISTS placement_assessment_results (
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
CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);

CREATE TABLE IF NOT EXISTS placement_rules ( 
  id                  TEXT PRIMARY KEY, 
  program_version_id  TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE, 
  name                TEXT NOT NULL, 
  min_score           REAL NOT NULL DEFAULT 0, 
  max_score           REAL NOT NULL DEFAULT 120, 
  recommended_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  recommended_level_code TEXT, 
  branch_id           TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  sort_order          INTEGER NOT NULL DEFAULT 0, 
  is_active           INTEGER NOT NULL DEFAULT 1, 
  version             INTEGER NOT NULL DEFAULT 1, 
  -- Structured rule conditions for the placement decision engine (migration 058). 
  conditions_json     TEXT, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_placement_rules_version   ON placement_rules(program_version_id, is_active);

-- ============================================================================
-- ACADEMIC STRUCTURE
-- ============================================================================
-- The catalogue: what can be taught, by whom, where and when.

CREATE TABLE IF NOT EXISTS programs ( 
  id              TEXT PRIMARY KEY, 
  name            TEXT NOT NULL, 
  description     TEXT, 
  duration_months INTEGER NOT NULL DEFAULT 0, 
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  organization_id TEXT, 
  code            TEXT, 
  is_active       INTEGER NOT NULL DEFAULT 1, 
  created_at      TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_programs_branch       ON programs(branch_id);

CREATE TABLE IF NOT EXISTS program_versions ( 
  id                TEXT PRIMARY KEY, 
  program_id        TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, 
  version_label     TEXT NOT NULL, 
  version_number    INTEGER NOT NULL DEFAULT 1, 
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')), 
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
CREATE INDEX IF NOT EXISTS idx_program_versions_program ON program_versions(program_id, status);

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
CREATE INDEX IF NOT EXISTS idx_subjects_version          ON subjects(program_version_id, level_id);

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
CREATE INDEX IF NOT EXISTS idx_modules_subject           ON modules(subject_id);

CREATE TABLE IF NOT EXISTS levels ( 
  id                  TEXT PRIMARY KEY, 
  program_id          TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, 
  name                TEXT NOT NULL, 
  "order"             INTEGER NOT NULL DEFAULT 1, 
  prerequisites       TEXT DEFAULT '[]', 
  program_version_id  TEXT, 
  code                TEXT, 
  duration_months     INTEGER DEFAULT 0, 
  default_fee         INTEGER DEFAULT 0, 
  pass_mark           REAL DEFAULT 60, 
  is_active           INTEGER DEFAULT 1, 
  min_viable_size     INTEGER DEFAULT 5, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_levels_program        ON levels(program_id);

CREATE TABLE IF NOT EXISTS level_branch_fees ( 
  id          TEXT PRIMARY KEY, 
  level_id    TEXT NOT NULL REFERENCES levels(id) ON DELETE CASCADE, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  fee         INTEGER NOT NULL, 
  currency    TEXT NOT NULL DEFAULT 'AFN', 
  effective_from TEXT, 
  effective_to   TEXT, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(level_id, branch_id) 
);
CREATE INDEX IF NOT EXISTS idx_level_fees_branch         ON level_branch_fees(branch_id, level_id);

CREATE TABLE IF NOT EXISTS skills ( 
  id   TEXT PRIMARY KEY, 
  name TEXT NOT NULL UNIQUE 
);

CREATE TABLE IF NOT EXISTS academic_terms ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  year        INTEGER NOT NULL, 
  code        TEXT NOT NULL, 
  name        TEXT NOT NULL, 
  start_date  TEXT, 
  end_date    TEXT, 
  is_active   INTEGER NOT NULL DEFAULT 1, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, year, code) 
);
CREATE INDEX IF NOT EXISTS idx_academic_terms_branch ON academic_terms(branch_id, year);

CREATE TABLE IF NOT EXISTS time_slots ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  code        TEXT NOT NULL, 
  label       TEXT NOT NULL, 
  start_time  TEXT NOT NULL, 
  end_time    TEXT NOT NULL, 
  is_active   INTEGER NOT NULL DEFAULT 1, 
  sort_order  INTEGER NOT NULL DEFAULT 0, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, code) 
);
CREATE INDEX IF NOT EXISTS idx_time_slots_branch     ON time_slots(branch_id, is_active);

CREATE TABLE IF NOT EXISTS rooms ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  code        TEXT NOT NULL, 
  name        TEXT NOT NULL, 
  capacity    INTEGER NOT NULL DEFAULT 0, 
  is_active   INTEGER NOT NULL DEFAULT 1, 
  notes       TEXT, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, code) 
);
CREATE INDEX IF NOT EXISTS idx_rooms_branch          ON rooms(branch_id, is_active);

CREATE TABLE IF NOT EXISTS course_offerings ( 
  id                  TEXT PRIMARY KEY, 
  program_id          TEXT REFERENCES programs(id) ON DELETE SET NULL, 
  program_version_id  TEXT, 
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  academic_term_id    TEXT REFERENCES academic_terms(id) ON DELETE SET NULL, 
  code                TEXT, 
  name                TEXT NOT NULL, 
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','archived')), 
  capacity_total      INTEGER NOT NULL DEFAULT 0, 
  fee_snapshot        INTEGER NOT NULL DEFAULT 0, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_course_offerings_branch ON course_offerings(branch_id, status);

CREATE TABLE IF NOT EXISTS classes (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  teacher_id           TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  program_id           TEXT REFERENCES programs(id) ON DELETE SET NULL,
  level_id             TEXT REFERENCES levels(id) ON DELETE SET NULL,
  level                TEXT NOT NULL,
  capacity             INTEGER NOT NULL DEFAULT 0,
  min_viable_size      INTEGER NOT NULL DEFAULT 0,
  schedule_time        TEXT,
  start_date           TEXT,
  end_date             TEXT,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  lifecycle_stage      TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_stage IN (
                         'draft','scheduled','enrollment_open','enrollment_closed',
                         'activated','in_progress','suspended','grading',
                         'completed','archived','cancelled'
                       )),
  lifecycle_updated_at TEXT,
  cancellation_reason  TEXT,
  fee                  INTEGER NOT NULL DEFAULT 0,
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  gender_policy        TEXT NOT NULL DEFAULT 'mixed' CHECK (gender_policy IN ('female','male','mixed')),
  room_id              TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  time_slot_id         TEXT REFERENCES time_slots(id) ON DELETE SET NULL,
  academic_term_id     TEXT REFERENCES academic_terms(id) ON DELETE SET NULL,
  activation_date      TEXT,
  merged_into_id       TEXT,
  offering_id          TEXT REFERENCES course_offerings(id) ON DELETE SET NULL,
  notes                TEXT
);
CREATE INDEX IF NOT EXISTS idx_classes_branch    ON classes(branch_id);
CREATE INDEX IF NOT EXISTS idx_classes_branch_lifecycle_dates
  ON classes(branch_id, lifecycle_stage, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_classes_branch_room_dates
  ON classes(branch_id, room_id, time_slot_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_classes_branch_teacher_dates
  ON classes(branch_id, teacher_id, time_slot_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_classes_gender    ON classes(branch_id, gender_policy, status);
CREATE INDEX IF NOT EXISTS idx_classes_level     ON classes(level_id);
CREATE INDEX IF NOT EXISTS idx_classes_lifecycle ON classes(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_classes_program   ON classes(program_id);
CREATE INDEX IF NOT EXISTS idx_classes_teacher   ON classes(teacher_id);

CREATE TABLE IF NOT EXISTS class_teacher_skills (
  id              TEXT PRIMARY KEY,
  class_id        TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  monthly_rate    INTEGER NOT NULL DEFAULT 0,
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  assignment_type TEXT NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary','assistant','substitute','guest','examiner')),
  start_date      TEXT,
  end_date        TEXT,
  reason          TEXT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(class_id, teacher_id, skill_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_cts_class ON class_teacher_skills(class_id);
CREATE INDEX IF NOT EXISTS idx_cts_class_skill
ON class_teacher_skills(class_id, skill_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_cts_session ON class_teacher_skills(session_id);
CREATE INDEX IF NOT EXISTS idx_cts_teacher ON class_teacher_skills(teacher_id);
CREATE INDEX IF NOT EXISTS idx_cts_teacher_workload
ON class_teacher_skills(teacher_id, branch_id, assignment_type, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_cts_type ON class_teacher_skills(assignment_type);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_overlap
ON class_teacher_skills(teacher_id, class_id, start_date, end_date, assignment_type);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_payroll
ON class_teacher_skills(teacher_id, assignment_type, start_date, end_date);

CREATE TABLE IF NOT EXISTS class_generation_runs ( 
  id                  TEXT PRIMARY KEY, 
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  academic_term_id    TEXT REFERENCES academic_terms(id) ON DELETE SET NULL, 
  program_version_id  TEXT REFERENCES program_versions(id) ON DELETE SET NULL, 
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preview','published','cancelled')), 
  params_json         TEXT NOT NULL DEFAULT '{}', 
  result_json         TEXT, 
  created_by          TEXT, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')), 
  published_at        TEXT 
);
CREATE INDEX IF NOT EXISTS idx_class_gen_runs_branch    ON class_generation_runs(branch_id, status);

CREATE TABLE IF NOT EXISTS class_generation_items ( 
  id                  TEXT PRIMARY KEY, 
  run_id              TEXT NOT NULL REFERENCES class_generation_runs(id) ON DELETE CASCADE, 
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  level_name          TEXT, 
  gender_policy       TEXT DEFAULT 'mixed', 
  time_slot_id        TEXT REFERENCES time_slots(id) ON DELETE SET NULL, 
  room_id             TEXT REFERENCES rooms(id) ON DELETE SET NULL, 
  teacher_id          TEXT REFERENCES teachers(id) ON DELETE SET NULL, 
  capacity            INTEGER NOT NULL DEFAULT 20, 
  min_viable_size     INTEGER NOT NULL DEFAULT 5, 
  fee                 INTEGER NOT NULL DEFAULT 0, 
  proposed_name       TEXT, 
  class_id            TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','skipped','error')), 
  error_message       TEXT 
);

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
  branch_id           TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  is_active           INTEGER NOT NULL DEFAULT 1, 
  version             INTEGER NOT NULL DEFAULT 1, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_promotion_rules_version   ON promotion_rules(program_version_id, is_active);

CREATE TABLE IF NOT EXISTS teachers (
  id                 TEXT PRIMARY KEY,
  full_name          TEXT NOT NULL,
  phone              TEXT,
  email              TEXT,
  base_salary        INTEGER NOT NULL DEFAULT 0,
  salary_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (salary_type IN (
                       'fixed','per_skill','per_session','hybrid','per_level'
                     )),
  performance_score  REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                       'active','inactive','on_leave'
                     )),
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  joined_date        TEXT NOT NULL,
  specialization     TEXT,
  qualification      TEXT,
  contract_type      TEXT CHECK (contract_type IN (
                       'monthly','hourly','per_session'
                     )),
  user_id            TEXT REFERENCES users(id),
  default_skill_rate INTEGER NOT NULL DEFAULT 0
, target_skills_per_month INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_teachers_branch ON teachers(branch_id);
CREATE INDEX IF NOT EXISTS idx_teachers_status ON teachers(status);

CREATE TABLE IF NOT EXISTS teacher_level_skill_rates ( 
  id           TEXT PRIMARY KEY, 
  teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  level_id     TEXT, 
  level_code   TEXT NOT NULL, 
  skill_id     TEXT REFERENCES skills(id) ON DELETE CASCADE, 
  rate_per_skill INTEGER NOT NULL DEFAULT 0, 
  branch_id    TEXT NOT NULL, 
  UNIQUE(teacher_id, level_code, skill_id) 
);
CREATE INDEX IF NOT EXISTS idx_teacher_level_rates_lookup
ON teacher_level_skill_rates(teacher_id, branch_id, level_code, skill_id);

CREATE TABLE IF NOT EXISTS teacher_branch_history (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  from_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  to_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  effective_date TEXT NOT NULL,
  reason TEXT,
  operator_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teacher_branch_history_effective
ON teacher_branch_history(teacher_id, effective_date, created_at);
CREATE INDEX IF NOT EXISTS idx_teacher_branch_history_teacher
ON teacher_branch_history(teacher_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_teacher_history_branch
ON teacher_branch_history(teacher_id, effective_date, from_branch_id, to_branch_id);

CREATE TABLE IF NOT EXISTS teacher_compensation_history (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  base_salary INTEGER NOT NULL DEFAULT 0,
  salary_type TEXT NOT NULL CHECK (salary_type IN (
                       'fixed','per_skill','per_session','hybrid','per_level'
                     )),
  contract_type TEXT,
  default_skill_rate INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  operator_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, target_skills_per_month INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_teacher_comp_history_lookup
ON teacher_compensation_history(teacher_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_teacher_compensation_effective
ON teacher_compensation_history(teacher_id, effective_from, created_at);

CREATE TABLE IF NOT EXISTS teacher_evaluations ( 
  id           TEXT PRIMARY KEY, 
  teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  evaluator_id TEXT NOT NULL, 
  date         TEXT NOT NULL, 
  score        REAL NOT NULL DEFAULT 0, 
  criteria     TEXT NOT NULL DEFAULT '{}', 
  notes        TEXT, 
  created_at   TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_teacher_eval_teacher  ON teacher_evaluations(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_evaluations_period
ON teacher_evaluations(teacher_id, date, created_at);

-- ============================================================================
-- ACADEMIC DELIVERY
-- ============================================================================
-- Enrollment and everything produced by actually running a class.

CREATE TABLE IF NOT EXISTS enrollments (
  id                  TEXT PRIMARY KEY,
  student_id          TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_id          TEXT REFERENCES programs(id) ON DELETE SET NULL,
  program_name        TEXT,
  semester_name       TEXT,
  level_code          TEXT,
  class_id            TEXT REFERENCES classes(id) ON DELETE SET NULL,
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  enrollment_type     TEXT NOT NULL DEFAULT 'new' CHECK (enrollment_type IN ('new','repeat','partial_repeat','resume','jump','extra')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                        'pending','reserved','confirmed','active','frozen','paused','suspended',
                        'transferred','dropped','withdrawn','completed','graduated','retake','conditional_pass'
                      )),
  hold_reason         TEXT,
  skills_focus        TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  notes               TEXT,
  program_version_id  TEXT,
  fee_snapshot_json   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enrollments_branch   ON enrollments(branch_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class    ON enrollments(class_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_class_status_student
  ON enrollments(class_id, status, student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_status   ON enrollments(status);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_student_status
  ON enrollments(student_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_active_seat_per_class
  ON enrollments(student_id, class_id, COALESCE(semester_name, ''))
  WHERE class_id IS NOT NULL
    AND status IN ('active', 'confirmed', 'pending');
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_guard BEFORE INSERT ON enrollments WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NULL OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'enrollment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_guard_update BEFORE UPDATE OF student_id, class_id, branch_id ON enrollments WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NULL OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'enrollment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_integrity_insert
BEFORE INSERT ON enrollments
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
   OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Enrollment branch does not match student/class branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollments_branch_integrity_update
BEFORE UPDATE OF student_id, class_id, branch_id ON enrollments
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
   OR (NEW.class_id IS NOT NULL AND (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Enrollment branch does not match student/class branch'); END;

CREATE TABLE IF NOT EXISTS enrollment_events (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'enrolled','transferred','suspended','resumed','dropped','completed',
                    'pending_created','reserved','confirmed','activated','frozen','unfrozen',
                    'withdrawn','graduated','retake_marked','conditional_pass_marked'
                  )),
  from_class_id   TEXT,
  to_class_id     TEXT,
  notes           TEXT,
  actor_user_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enrollment_events_enrollment ON enrollment_events(enrollment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollment_events_student    ON enrollment_events(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS enrollment_freezes ( 
  id                TEXT PRIMARY KEY, 
  enrollment_id     TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE, 
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  branch_id         TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  reason            TEXT NOT NULL, 
  start_date        TEXT NOT NULL, 
  planned_end_date  TEXT NOT NULL, 
  actual_end_date   TEXT, 
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')), 
  requested_by      TEXT, 
  approved_by       TEXT, 
  created_at        TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_efz_enrollment ON enrollment_freezes(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_efz_status ON enrollment_freezes(status);

CREATE TABLE IF NOT EXISTS enrollment_transfer_requests ( 
  id                TEXT PRIMARY KEY, 
  enrollment_id     TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE, 
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  from_class_id     TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  to_class_id       TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, 
  branch_id         TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  reason            TEXT NOT NULL, 
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')), 
  new_enrollment_id TEXT REFERENCES enrollments(id) ON DELETE SET NULL, 
  requested_by      TEXT, 
  approved_by       TEXT, 
  decision_notes    TEXT, 
  created_at        TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_etr_enrollment ON enrollment_transfer_requests(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_etr_status ON enrollment_transfer_requests(status);

CREATE TABLE IF NOT EXISTS class_waitlist ( 
  id            TEXT PRIMARY KEY, 
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, 
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  position      INTEGER NOT NULL, 
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','converted','expired','cancelled')), 
  notes         TEXT, 
  offered_at    TEXT, 
  responded_at  TEXT, 
  requested_by  TEXT, 
  created_at    TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_wl_class ON class_waitlist(class_id);
CREATE INDEX IF NOT EXISTS idx_wl_status ON class_waitlist(status);
CREATE INDEX IF NOT EXISTS idx_wl_student ON class_waitlist(student_id);
CREATE TRIGGER IF NOT EXISTS trg_waitlist_branch_guard BEFORE INSERT ON class_waitlist WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'waitlist branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_branch_guard_update BEFORE UPDATE OF class_id, student_id, branch_id ON class_waitlist WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) <> NEW.branch_id OR (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'waitlist branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_position BEFORE INSERT ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND position = NEW.position AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'waitlist position already exists'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_position_update BEFORE UPDATE OF class_id, position, status ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND position = NEW.position AND id <> NEW.id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'waitlist position already exists'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_student BEFORE INSERT ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND student_id = NEW.student_id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'student already has an active waitlist entry'); END;
CREATE TRIGGER IF NOT EXISTS trg_waitlist_duplicate_student_update BEFORE UPDATE OF class_id, student_id, status ON class_waitlist WHEN NEW.status IN ('waiting','offered') AND EXISTS (SELECT 1 FROM class_waitlist WHERE class_id = NEW.class_id AND student_id = NEW.student_id AND id <> NEW.id AND status IN ('waiting','offered')) BEGIN SELECT RAISE(ABORT, 'student already has an active waitlist entry'); END;

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  class_id           TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date               TEXT NOT NULL,
  start_time         TEXT NOT NULL,
  end_time           TEXT NOT NULL,
  topic              TEXT,
  notes              TEXT,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  session_type       TEXT NOT NULL DEFAULT 'regular' CHECK (session_type IN (
                       'regular','makeup','substitute','online','hybrid','rescheduled'
                     )),
  linked_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  teacher_id         TEXT,
  room_id            TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  skill_id           TEXT REFERENCES skills(id) ON DELETE SET NULL,
  branch_id          TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_class   ON sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date    ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_linked  ON sessions(linked_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON sessions(teacher_id, date);
CREATE INDEX IF NOT EXISTS idx_teacher_sessions_period
ON sessions(teacher_id, date, status, branch_id);

CREATE TABLE IF NOT EXISTS rosters (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_status  TEXT NOT NULL DEFAULT 'not_marked' CHECK (attendance_status IN (
                       'present','late','absent','excused','medical_leave','sick','leave',
                       'online','hybrid','left_early','not_marked'
                     )),
  late_minutes       INTEGER,
  attendance_weight  REAL,
  marked_at          TEXT,
  UNIQUE(session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_rosters_session ON rosters(session_id);
CREATE INDEX IF NOT EXISTS idx_rosters_student ON rosters(student_id);

CREATE TABLE IF NOT EXISTS attendance ( 
  id          TEXT PRIMARY KEY, 
  date        TEXT NOT NULL, 
  target_id   TEXT NOT NULL, 
  target_type TEXT NOT NULL CHECK (target_type IN ('student','teacher')), 
  status      TEXT NOT NULL, 
  class_id    TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
);
CREATE INDEX IF NOT EXISTS idx_attendance_date       ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_target     ON attendance(target_id, target_type);

CREATE TABLE IF NOT EXISTS homework ( 
  id          TEXT PRIMARY KEY, 
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, 
  title       TEXT NOT NULL, 
  description TEXT, 
  due_date    TEXT NOT NULL, 
  assigned_by TEXT NOT NULL, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS quizzes ( 
  id          TEXT PRIMARY KEY, 
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, 
  title       TEXT NOT NULL, 
  description TEXT, 
  max_score   REAL, 
  due_date    TEXT, 
  assigned_by TEXT NOT NULL, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_quizzes_session ON quizzes(session_id);

CREATE TABLE IF NOT EXISTS class_assessments (
  id                      TEXT PRIMARY KEY,
  class_id                TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type IN (
                            'midterm','final','assignment','attendance','participation',
                            'quiz','homework','speaking','listening','reading','writing',
                            'practice_test','makeup_exam'
                          )),
  weight                  REAL NOT NULL DEFAULT 0,
  max_score               REAL NOT NULL DEFAULT 100,
  passing_score           REAL,
  date                    TEXT,
  publish_date            TEXT,
  due_date                TEXT,
  visibility              TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','scheduled')),
  rubric                  TEXT,
  allows_makeup           INTEGER NOT NULL DEFAULT 0,
  makeup_for_assessment_id TEXT REFERENCES class_assessments(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
, lock_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (lock_status IN ('draft','submitted','reviewed','approved','published','locked')), lock_status_updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_assessments_class ON class_assessments(class_id);
CREATE INDEX IF NOT EXISTS idx_assessments_makeup_for ON class_assessments(makeup_for_assessment_id);

CREATE TABLE IF NOT EXISTS student_grades (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES class_assessments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  score REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'graded', 'excused', 'missing')),
  notes TEXT,
  graded_by TEXT,
  graded_at TEXT,
  UNIQUE(assessment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_grades_assessment ON student_grades(assessment_id);
CREATE INDEX IF NOT EXISTS idx_grades_class ON student_grades(class_id);

CREATE TABLE IF NOT EXISTS grade_history (
  id              TEXT PRIMARY KEY,
  grade_id        TEXT NOT NULL REFERENCES student_grades(id) ON DELETE CASCADE,
  assessment_id   TEXT NOT NULL,
  student_id      TEXT NOT NULL,
  class_id        TEXT NOT NULL,
  previous_score  REAL,
  previous_status TEXT,
  previous_notes  TEXT,
  new_score       REAL,
  new_status      TEXT NOT NULL,
  new_notes       TEXT,
  changed_by      TEXT,
  changed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_grade_history_grade ON grade_history(grade_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_grade_history_student_class ON grade_history(student_id, class_id);

CREATE TABLE IF NOT EXISTS exams ( 
  id        TEXT PRIMARY KEY, 
  title     TEXT NOT NULL, 
  date      TEXT NOT NULL, 
  fee       INTEGER NOT NULL DEFAULT 0, 
  class_id  TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  type      TEXT NOT NULL DEFAULT 'mock' CHECK (type IN ('placement','midterm','final','mock','certification')), 
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
);
CREATE INDEX IF NOT EXISTS idx_exams_branch          ON exams(branch_id);
CREATE TRIGGER IF NOT EXISTS trg_exams_fee_nonnegative_insert
BEFORE INSERT ON exams
WHEN NEW.fee < 0
BEGIN SELECT RAISE(ABORT, 'exam fee cannot be negative'); END;
CREATE TRIGGER IF NOT EXISTS trg_exams_fee_nonnegative_update
BEFORE UPDATE OF fee ON exams
WHEN NEW.fee < 0
BEGIN SELECT RAISE(ABORT, 'exam fee cannot be negative'); END;

CREATE TABLE IF NOT EXISTS exam_results ( 
  id                 TEXT PRIMARY KEY, 
  exam_id            TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE, 
  student_id         TEXT REFERENCES students(id) ON DELETE CASCADE, -- Removed NOT NULL to allow visitors
  visitor_id         TEXT REFERENCES visitors(id) ON DELETE SET NULL, -- Added for Walk-in candidates
  candidate_name     TEXT, -- Added to store the name at the time of exam (for display if not a student)
  score              REAL, 
  status             TEXT, 
  exam_fee_paid      INTEGER NOT NULL DEFAULT 0, 
  certificate_issued INTEGER NOT NULL DEFAULT 0, 
  certificate_no     TEXT, 
  branch_id          TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at         TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_exam_results_exam     ON exam_results(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_student  ON exam_results(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_visitor  ON exam_results(visitor_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_results_student
  ON exam_results(exam_id, student_id)
  WHERE student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_results_visitor
  ON exam_results(exam_id, visitor_id)
  WHERE visitor_id IS NOT NULL;
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

CREATE TABLE IF NOT EXISTS certificates ( 
  id             TEXT PRIMARY KEY, 
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  program_id     TEXT REFERENCES programs(id) ON DELETE SET NULL, 
  level_id       TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  issue_date     TEXT NOT NULL, 
  certificate_no TEXT NOT NULL UNIQUE, 
  grade          TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_certificates_student  ON certificates(student_id);

-- ============================================================================
-- LIBRARY
-- ============================================================================
-- Book stock and book sales.

CREATE TABLE IF NOT EXISTS books ( 
  id             TEXT PRIMARY KEY, 
  title          TEXT NOT NULL, 
  price          INTEGER NOT NULL DEFAULT 0, 
  purchase_price INTEGER, 
  stock          INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), 
  is_chapter     INTEGER NOT NULL DEFAULT 0, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  entry_date     TEXT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_branch          ON books(branch_id);
CREATE TRIGGER IF NOT EXISTS trg_books_stock_nonnegative_insert
BEFORE INSERT ON books
WHEN NEW.stock < 0
BEGIN SELECT RAISE(ABORT, 'Book stock cannot be negative'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_stock_nonnegative_update
BEFORE UPDATE OF stock ON books
WHEN NEW.stock < 0
BEGIN SELECT RAISE(ABORT, 'Book stock cannot be negative'); END;

CREATE TABLE IF NOT EXISTS book_restock_history ( 
  id             TEXT PRIMARY KEY, 
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, 
  date           TEXT NOT NULL, 
  quantity       INTEGER NOT NULL, 
  price          INTEGER NOT NULL, 
  purchase_price INTEGER 
);
CREATE INDEX IF NOT EXISTS idx_book_restock_book     ON book_restock_history(book_id);

CREATE TABLE IF NOT EXISTS book_sales ( 
  id              TEXT PRIMARY KEY, 
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT, 
  quantity        INTEGER NOT NULL, 
  total_amount    INTEGER NOT NULL, 
  discount_amount INTEGER DEFAULT 0, 
  net_amount      INTEGER, 
  payment_method  TEXT CHECK (payment_method IN ('cash','card','transfer')), 
  status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')), 
  date            TEXT NOT NULL, 
  customer_name   TEXT, 
  student_id      TEXT REFERENCES students(id) ON DELETE SET NULL, 
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at      TEXT NOT NULL DEFAULT (datetime('now')) , 
  -- Duplicate-click protection for the sale desk (migration 060).
  idempotency_key  TEXT 
);
CREATE INDEX IF NOT EXISTS idx_book_sales_book       ON book_sales(book_id);
CREATE INDEX IF NOT EXISTS idx_book_sales_branch     ON book_sales(branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_sales_idempotency
ON book_sales(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_guard BEFORE INSERT ON book_sales WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'book sale branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_guard_update BEFORE UPDATE OF book_id, student_id, branch_id ON book_sales WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'book sale branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_integrity_insert
BEFORE INSERT ON book_sales
WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Book sale branch does not match book/student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_branch_integrity_update
BEFORE UPDATE OF book_id, student_id, branch_id ON book_sales
WHEN (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
   OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Book sale branch does not match book/student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_insert
BEFORE INSERT ON book_sales
WHEN NEW.total_amount <> CAST(NEW.total_amount AS INTEGER)
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_update
BEFORE UPDATE OF total_amount, discount_amount, net_amount ON book_sales
WHEN NEW.total_amount <> CAST(NEW.total_amount AS INTEGER)
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must be a whole number of AFN'); END;

-- ============================================================================
-- FINANCE
-- ============================================================================
-- The accounting authority. finance_categories is the canonical expense
-- taxonomy; financial_transactions is the ledger; budget_lines are treasury
-- envelopes, not accounting categories.

CREATE TABLE IF NOT EXISTS finance_accounts (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization','branch')),
  scope_id TEXT NOT NULL,
  main_balance INTEGER NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
  saving_balance INTEGER NOT NULL DEFAULT 0 CHECK (saving_balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_finance_accounts_scope ON finance_accounts(scope_type, scope_id);
CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_insert
BEFORE INSERT ON finance_accounts
WHEN NEW.main_balance <> CAST(NEW.main_balance AS INTEGER)
  OR NEW.saving_balance <> CAST(NEW.saving_balance AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'finance account balances must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_update
BEFORE UPDATE OF main_balance, saving_balance ON finance_accounts
WHEN NEW.main_balance <> CAST(NEW.main_balance AS INTEGER)
  OR NEW.saving_balance <> CAST(NEW.saving_balance AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'finance account balances must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS finance_categories (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES finance_categories(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('category','subcategory')),
  classification  TEXT NOT NULL CHECK (classification IN ('operating_expense','capital_expenditure','non_expense_cash_movement')),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_system       INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
  organization_id TEXT NOT NULL DEFAULT 'org_toefl_house',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((level = 'category' AND parent_id IS NULL) OR (level = 'subcategory' AND parent_id IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_finance_categories_order  ON finance_categories(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_finance_categories_org    ON finance_categories(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_finance_categories_parent ON finance_categories(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_categories_child_name
  ON finance_categories(organization_id, parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_categories_root_name
  ON finance_categories(organization_id, name COLLATE NOCASE) WHERE parent_id IS NULL;
CREATE TRIGGER IF NOT EXISTS trg_finance_categories_inherit_classification_insert
BEFORE INSERT ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND NEW.classification IS NOT (SELECT classification FROM finance_categories WHERE id = NEW.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'subcategory classification must match its parent category');
END;
CREATE TRIGGER IF NOT EXISTS trg_finance_categories_inherit_classification_update
BEFORE UPDATE OF classification, parent_id ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND NEW.classification IS NOT (SELECT classification FROM finance_categories WHERE id = NEW.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'subcategory classification must match its parent category');
END;
CREATE TRIGGER IF NOT EXISTS trg_finance_categories_parent_is_root_insert
BEFORE INSERT ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT level FROM finance_categories WHERE id = NEW.parent_id) IS NOT 'category'
BEGIN
  SELECT RAISE(ABORT, 'finance category parent must be a top-level category');
END;
CREATE TRIGGER IF NOT EXISTS trg_finance_categories_parent_is_root_update
BEFORE UPDATE OF parent_id, level ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT level FROM finance_categories WHERE id = NEW.parent_id) IS NOT 'category'
BEGIN
  SELECT RAISE(ABORT, 'finance category parent must be a top-level category');
END;

CREATE TABLE IF NOT EXISTS finance_category_channels (
  id          TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES finance_categories(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'channel' CHECK (kind IN ('channel','vendor')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finance_channels_category ON finance_category_channels(category_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_channels_name
  ON finance_category_channels(category_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS budget_lines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  current_amount   INTEGER NOT NULL DEFAULT 0,
  allocated_amount INTEGER NOT NULL DEFAULT 0,
  icon             TEXT,
  cost_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (cost_type IN ('fixed','variable')),
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  category_id      TEXT REFERENCES finance_categories(id) ON DELETE RESTRICT,
  channel_id       TEXT REFERENCES finance_category_channels(id) ON DELETE SET NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  payroll_target   TEXT CHECK (payroll_target IS NULL OR payroll_target IN ('teacher','employee'))
);
CREATE INDEX IF NOT EXISTS idx_budget_lines_branch   ON budget_lines(branch_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_branch_order ON budget_lines(branch_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_budget_lines_category ON budget_lines(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_lines_branch_category_name
  ON budget_lines(branch_id, category_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_lines_payroll_target
  ON budget_lines(branch_id, payroll_target) WHERE payroll_target IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_channel_matches_category_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.channel_id IS NOT NULL
  AND (SELECT category_id FROM finance_category_channels WHERE id = NEW.channel_id) IS NOT NEW.category_id
BEGIN
  SELECT RAISE(ABORT, 'budget line channel must belong to the same finance category');
END;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_channel_matches_category_update
BEFORE UPDATE OF channel_id, category_id ON budget_lines
FOR EACH ROW
WHEN NEW.channel_id IS NOT NULL
  AND (SELECT category_id FROM finance_category_channels WHERE id = NEW.channel_id) IS NOT NEW.category_id
BEGIN
  SELECT RAISE(ABORT, 'budget line channel must belong to the same finance category');
END;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_nonnegative_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.current_amount < 0
BEGIN
  SELECT RAISE(ABORT, 'budget line balance cannot be negative');
END;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_nonnegative_update
BEFORE UPDATE OF current_amount ON budget_lines
FOR EACH ROW
WHEN NEW.current_amount < 0
BEGIN
  SELECT RAISE(ABORT, 'budget line balance cannot be negative');
END;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_require_subcategory_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.category_id IS NULL
  OR (SELECT level FROM finance_categories WHERE id = NEW.category_id) IS NOT 'subcategory'
BEGIN
  SELECT RAISE(ABORT, 'budget line must reference a finance subcategory');
END;
CREATE TRIGGER IF NOT EXISTS trg_budget_lines_require_subcategory_update
BEFORE UPDATE OF category_id ON budget_lines
FOR EACH ROW
WHEN NEW.category_id IS NULL
  OR (SELECT level FROM finance_categories WHERE id = NEW.category_id) IS NOT 'subcategory'
BEGIN
  SELECT RAISE(ABORT, 'budget line must reference a finance subcategory');
END;

CREATE TABLE IF NOT EXISTS expense_requests ( 
  id                   TEXT PRIMARY KEY, 
  title                TEXT NOT NULL, 
  amount               INTEGER NOT NULL, 
  budget_line_id       TEXT REFERENCES budget_lines(id) ON DELETE SET NULL, 
  requester            TEXT, 
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), 
  date                 TEXT NOT NULL, 
  approved_by          TEXT, 
  reject_reason        TEXT, 
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  workflow_instance_id TEXT, 
  expense_kind         TEXT DEFAULT 'other' CHECK (expense_kind IN ('recurring_bill','one_time_purchase','maintenance','other')), 
  bill_period          TEXT, 
  payment_method       TEXT DEFAULT 'cash' CHECK (payment_method IN ('cash','card','bank_transfer')), 
  notes                TEXT, 
  auto_approved        INTEGER NOT NULL DEFAULT 0, 
  -- Accountable identities for the approval chain (migration 048). The legacy
  -- `requester`/`approved_by` columns hold display names; these hold user ids.
  requester_user_id    TEXT, 
  approved_by_user_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_expense_req_approver_user ON expense_requests(approved_by_user_id);
CREATE INDEX IF NOT EXISTS idx_expense_req_branch    ON expense_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_expense_req_requester_user ON expense_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_expense_req_status    ON expense_requests(status);
CREATE TRIGGER IF NOT EXISTS trg_expense_request_money_scale_insert
BEFORE INSERT ON expense_requests
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'expense amount must be a whole number of AFN'); END;


CREATE TABLE IF NOT EXISTS fee_rules ( 
  id                  TEXT PRIMARY KEY, 
  program_version_id  TEXT REFERENCES program_versions(id) ON DELETE CASCADE, 
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  branch_id           TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  fee_type            TEXT NOT NULL CHECK (fee_type IN ('registration','placement','semester','book','retake','diploma','card','exam','other')), 
  name                TEXT NOT NULL, 
  amount              INTEGER NOT NULL DEFAULT 0, 
  currency            TEXT NOT NULL DEFAULT 'AFN', 
  is_optional         INTEGER NOT NULL DEFAULT 0, 
  effective_from      TEXT, 
  effective_to        TEXT, 
  version             INTEGER NOT NULL DEFAULT 1, 
  is_active           INTEGER NOT NULL DEFAULT 1, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_fee_rules_lookup          ON fee_rules(branch_id, fee_type, is_active);

CREATE TABLE IF NOT EXISTS student_discount_authorizations (
  id                 TEXT PRIMARY KEY,
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  category           TEXT NOT NULL CHECK (category IN (
                       'COURSE_AMBASSADOR',
                       'FIRST_DEGREE_RELATIVE',
                       'SECOND_DEGREE_RELATIVE',
                       'FAMILY_OF_FOUR_PLUS',
                       'SPONSORSHIP'
                     )),
  requested_percent  REAL,
  approved_percent   REAL NOT NULL,
  eligibility_ref    TEXT,
  approved_by        TEXT,
  approved_by_user_id TEXT,
  approved_at        TEXT,
  reason             TEXT,
  evidence_ref       TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','revoked','expired')),
  effective_from     TEXT,
  effective_to       TEXT,
  branch_id          TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source             TEXT NOT NULL DEFAULT 'manual',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discount_auth_student ON student_discount_authorizations(student_id, status);
CREATE TRIGGER IF NOT EXISTS trg_discount_auth_percent_insert
BEFORE INSERT ON student_discount_authorizations
WHEN NEW.approved_percent < 0 OR NEW.approved_percent > 100
BEGIN SELECT RAISE(ABORT, 'approved_percent must be between 0 and 100'); END;
CREATE TRIGGER IF NOT EXISTS trg_discount_auth_percent_update
BEFORE UPDATE OF approved_percent ON student_discount_authorizations
WHEN NEW.approved_percent < 0 OR NEW.approved_percent > 100
BEGIN SELECT RAISE(ABORT, 'approved_percent must be between 0 and 100'); END;

CREATE TABLE IF NOT EXISTS invoices ( 
  id             TEXT PRIMARY KEY, 
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  total_amount   INTEGER NOT NULL DEFAULT 0, 
  discount_amount INTEGER NOT NULL DEFAULT 0, 
  net_amount     INTEGER NOT NULL DEFAULT 0, 
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','partial','overdue','cancelled')), 
  issue_date     TEXT NOT NULL, 
  due_date       TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now')), 
  notes          TEXT, 
  invoice_number TEXT, 
  issued_by      TEXT, 
  student_name   TEXT, 
  student_code   TEXT 
);
CREATE INDEX IF NOT EXISTS idx_invoices_branch       ON invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch_due_status
  ON invoices(branch_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date     ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due   ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_student      ON invoices(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_number_per_branch ON invoices(branch_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_branch_invoice_number
  ON invoices(branch_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_guard BEFORE INSERT ON invoices WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'invoice branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_guard_update BEFORE UPDATE OF student_id, branch_id ON invoices WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id BEGIN SELECT RAISE(ABORT, 'invoice branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_integrity_insert
BEFORE INSERT ON invoices
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Invoice branch does not match student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_branch_integrity_update
BEFORE UPDATE OF student_id, branch_id ON invoices
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Invoice branch does not match student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_money_scale_insert
BEFORE INSERT ON invoices
WHEN NEW.total_amount <> CAST(NEW.total_amount AS INTEGER)
  OR NEW.discount_amount <> CAST(NEW.discount_amount AS INTEGER)
  OR NEW.net_amount <> CAST(NEW.net_amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'invoice monetary values must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_nonnegative_insert
BEFORE INSERT ON invoices
WHEN NEW.total_amount < 0 OR NEW.discount_amount < 0 OR NEW.net_amount < 0
BEGIN SELECT RAISE(ABORT, 'invoice amounts cannot be negative'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_nonnegative_update
BEFORE UPDATE OF total_amount, discount_amount, net_amount ON invoices
WHEN NEW.total_amount < 0 OR NEW.discount_amount < 0 OR NEW.net_amount < 0
BEGIN SELECT RAISE(ABORT, 'invoice amounts cannot be negative'); END;

CREATE TABLE IF NOT EXISTS invoice_items ( 
  id          TEXT PRIMARY KEY, 
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, 
  description TEXT NOT NULL, 
  quantity    INTEGER NOT NULL DEFAULT 1, 
  unit_price  INTEGER NOT NULL DEFAULT 0, 
  amount      INTEGER NOT NULL DEFAULT 0 
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv     ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE TRIGGER IF NOT EXISTS trg_invoice_items_money_scale_insert
BEFORE INSERT ON invoice_items
WHEN NEW.unit_price <> CAST(NEW.unit_price AS INTEGER)
  OR NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'invoice item monetary values must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS payments ( 
  id             TEXT PRIMARY KEY, 
  student_id     TEXT REFERENCES students(id) ON DELETE SET NULL, 
  invoice_id     TEXT REFERENCES invoices(id) ON DELETE SET NULL, 
  book_id        TEXT REFERENCES books(id) ON DELETE SET NULL, -- ADDED for smart payments 
  amount         INTEGER NOT NULL, 
  date           TEXT NOT NULL, 
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','bank_transfer')), 
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','pending','failed','refunded')), 
  category       TEXT NOT NULL CHECK (category IN ('fee','book','chapter','exam','card','placement','diploma','installment','refund','other')), -- ADDED installment & refund 
  notes          TEXT, 
  receipt_number TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  semester       TEXT,
  idempotency_key TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_book         ON payments(book_id);
CREATE INDEX IF NOT EXISTS idx_payments_branch       ON payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_payments_branch_date   ON payments(branch_id, date);
CREATE INDEX IF NOT EXISTS idx_payments_date         ON payments(date);
CREATE INDEX IF NOT EXISTS idx_payments_invoice      ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_student      ON payments(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_guard BEFORE INSERT ON payments WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.branch_id) OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'payment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_guard_update BEFORE UPDATE OF student_id, invoice_id, book_id, branch_id ON payments WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) <> NEW.branch_id) OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) <> NEW.branch_id) OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) <> NEW.branch_id) BEGIN SELECT RAISE(ABORT, 'payment branch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_insert
BEFORE INSERT ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
  OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Payment branch does not match related resource branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_update
BEFORE UPDATE OF student_id, invoice_id, book_id, branch_id ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
  OR (NEW.book_id IS NOT NULL AND (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Payment branch does not match related resource branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_idempotency_required_insert
BEFORE INSERT ON payments
FOR EACH ROW
WHEN NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN
  SELECT RAISE(ABORT, 'payment idempotency_key is required');
END;
CREATE TRIGGER IF NOT EXISTS trg_payments_idempotency_required_update
BEFORE UPDATE OF idempotency_key ON payments
FOR EACH ROW
WHEN NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN
  SELECT RAISE(ABORT, 'payment idempotency_key is required');
END;
CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_insert
BEFORE INSERT ON payments
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'payment amount must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_update
BEFORE UPDATE OF amount ON payments
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'payment amount must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS financial_transactions ( 
  id            TEXT PRIMARY KEY, 
  type          TEXT NOT NULL CHECK (type IN ('income','expense','saving_transfer','budget_charge')), 
  -- Human-readable label. For INCOME rows this is the billing vocabulary
  -- (fee/book/exam/placement/donation/…), which the expense taxonomy does not
  -- model. It is NEVER the accounting authority — see `finance_category_id`.
  category      TEXT NOT NULL, 
  -- THE accounting authority for expense-side rows: a real foreign key into the
  -- canonical taxonomy. Classification is resolved by joining
  -- `finance_categories.classification`, never by matching text. NULL on income
  -- and on treasury/budget transfers, which are not expenses.
  finance_category_id TEXT REFERENCES finance_categories(id) ON DELETE RESTRICT, 
  amount        INTEGER NOT NULL, 
  date          TEXT NOT NULL, 
  description   TEXT, 
  reference_id  TEXT, 
  payment_id    TEXT REFERENCES payments(id) ON DELETE SET NULL, 
  operator_name TEXT, 
  operator_role TEXT, 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
);
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch         ON financial_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch_category
  ON financial_transactions(branch_id, finance_category_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch_date_type ON financial_transactions(branch_id, date, type);
CREATE INDEX IF NOT EXISTS idx_fin_tx_date           ON financial_transactions(date);
CREATE INDEX IF NOT EXISTS idx_fin_tx_finance_category
  ON financial_transactions(finance_category_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_payment        ON financial_transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_type           ON financial_transactions(type);
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_insert
BEFORE INSERT ON financial_transactions
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_update
BEFORE UPDATE OF amount ON financial_transactions
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must be a whole number of AFN'); END;

-- ============================================================================
-- PAYROLL
-- ============================================================================
-- Teacher and employee compensation ledgers.

CREATE TABLE IF NOT EXISTS teacher_salary_ledger ( 
  id              TEXT PRIMARY KEY, 
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  period_key      TEXT NOT NULL, 
  period_label    TEXT NOT NULL, 
  due_amount      INTEGER NOT NULL DEFAULT 0, 
  paid_amount     INTEGER NOT NULL DEFAULT 0, 
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('full','partial','advance')), 
  transaction_id  TEXT, 
  notes           TEXT, 
  branch_id       TEXT NOT NULL, 
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')), 
  operator_name   TEXT, 
  -- Payment idempotency (migration 044): a replayed request with the same key
  -- returns the original result instead of paying twice.
  idempotency_key TEXT, 
  -- Non-destructive payroll correction (migration 045).
  status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','voided')), 
  voided_at       TEXT, 
  voided_by       TEXT, 
  void_reason     TEXT 
);
CREATE INDEX IF NOT EXISTS idx_teacher_salary_branch_period
ON teacher_salary_ledger(branch_id, period_key, paid_at);
CREATE INDEX IF NOT EXISTS idx_teacher_salary_due
ON teacher_salary_ledger(teacher_id, period_key, paid_at);
CREATE INDEX IF NOT EXISTS idx_teacher_salary_period
ON teacher_salary_ledger(teacher_id, period_key, paid_at);
CREATE INDEX IF NOT EXISTS idx_teacher_salary_status ON teacher_salary_ledger(teacher_id, period_key, status);
CREATE INDEX IF NOT EXISTS idx_tsl_teacher_period ON teacher_salary_ledger(teacher_id, period_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_full_period
ON teacher_salary_ledger(teacher_id, period_key)
WHERE payment_type = 'full' AND status = 'posted';
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_idempotency
ON teacher_salary_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_teacher_salary_money_scale_insert
BEFORE INSERT ON teacher_salary_ledger
WHEN NEW.due_amount <> CAST(NEW.due_amount AS INTEGER)
  OR NEW.paid_amount <> CAST(NEW.paid_amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'teacher salary monetary values must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS employee_salary_ledger (
  id              TEXT PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_key      TEXT NOT NULL,
  period_label    TEXT NOT NULL,
  paid_amount     INTEGER NOT NULL DEFAULT 0,
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('full','partial','advance')),
  transaction_id  TEXT,
  notes           TEXT,
  branch_id       TEXT NOT NULL,
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
  operator_name   TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','voided')),
  voided_at       TEXT,
  voided_by       TEXT,
  void_reason     TEXT
);
CREATE INDEX IF NOT EXISTS idx_employee_salary_branch_period
  ON employee_salary_ledger(branch_id, period_key, paid_at);
CREATE INDEX IF NOT EXISTS idx_employee_salary_period
  ON employee_salary_ledger(employee_id, period_key, paid_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_full_period
  ON employee_salary_ledger(employee_id, period_key) WHERE payment_type = 'full' AND status = 'posted';
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_idempotency
  ON employee_salary_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- FUNDING & IMPACT
-- ============================================================================
-- Donors, scholarships, sponsorship and impact reporting.

CREATE TABLE IF NOT EXISTS donors ( 
  id         TEXT PRIMARY KEY, 
  full_name  TEXT NOT NULL, 
  type       TEXT NOT NULL DEFAULT 'individual' CHECK (type IN ('individual','organization','ngo','government')), 
  phone      TEXT, 
  email      TEXT, 
  country    TEXT, 
  notes      TEXT, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_donors_type           ON donors(type);

CREATE TABLE IF NOT EXISTS funding_campaigns ( 
  id            TEXT PRIMARY KEY, 
  name          TEXT NOT NULL, 
  description   TEXT, 
  donor_id      TEXT REFERENCES donors(id) ON DELETE SET NULL, 
  target_amount INTEGER NOT NULL DEFAULT 0, 
  raised_amount INTEGER NOT NULL DEFAULT 0, 
  start_date    TEXT NOT NULL, 
  end_date      TEXT, 
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')), 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at    TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_funding_camp_branch   ON funding_campaigns(branch_id);

CREATE TABLE IF NOT EXISTS donations ( 
  id               TEXT PRIMARY KEY, 
  campaign_id      TEXT REFERENCES funding_campaigns(id) ON DELETE SET NULL, 
  donor_id         TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT, 
  amount           INTEGER NOT NULL, 
  date             TEXT NOT NULL, 
  restricted       INTEGER NOT NULL DEFAULT 0, 
  restriction_note TEXT, 
  receipt_no       TEXT NOT NULL, 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')), 
  -- Duplicate-click protection for the donation desk (migration 061).
  idempotency_key  TEXT 
);
CREATE INDEX IF NOT EXISTS idx_donations_campaign    ON donations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_donations_donor       ON donations(donor_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_idempotency
ON donations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_donations_money_scale_insert
BEFORE INSERT ON donations
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'donation amount must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS scholarships ( 
  id               TEXT PRIMARY KEY, 
  name             TEXT NOT NULL, 
  donor_id         TEXT REFERENCES donors(id) ON DELETE SET NULL, 
  campaign_id      TEXT REFERENCES funding_campaigns(id) ON DELETE SET NULL, 
  total_budget     INTEGER NOT NULL DEFAULT 0, 
  allocated_amount INTEGER NOT NULL DEFAULT 0, 
  criteria         TEXT, 
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','closed')), 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_scholarships_branch   ON scholarships(branch_id);

CREATE TABLE IF NOT EXISTS scholarship_awards ( 
  id             TEXT PRIMARY KEY, 
  scholarship_id TEXT NOT NULL REFERENCES scholarships(id) ON DELETE CASCADE, 
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  amount         INTEGER NOT NULL, 
  award_date     TEXT NOT NULL, 
  semester       TEXT, 
  notes          TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
);
CREATE INDEX IF NOT EXISTS idx_schol_awards_schol    ON scholarship_awards(scholarship_id);
CREATE INDEX IF NOT EXISTS idx_schol_awards_stu      ON scholarship_awards(student_id);
CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_branch_integrity_insert
BEFORE INSERT ON scholarship_awards
WHEN (SELECT branch_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT NEW.branch_id
   OR (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'Scholarship award branch does not match scholarship/student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_money_scale_insert
BEFORE INSERT ON scholarship_awards
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'scholarship amount must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS sponsorship_agreements ( 
  id             TEXT PRIMARY KEY, 
  donor_id       TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT, 
  student_id     TEXT REFERENCES students(id) ON DELETE SET NULL, 
  program_id     TEXT REFERENCES programs(id) ON DELETE SET NULL, 
  monthly_amount INTEGER NOT NULL DEFAULT 0, 
  start_date     TEXT NOT NULL, 
  end_date       TEXT NOT NULL, 
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','terminated')), 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_sponsorships_donor    ON sponsorship_agreements(donor_id);
CREATE INDEX IF NOT EXISTS idx_sponsorships_student  ON sponsorship_agreements(student_id);

CREATE TABLE IF NOT EXISTS impact_metrics ( 
  id            TEXT PRIMARY KEY, 
  name          TEXT NOT NULL, 
  category      TEXT NOT NULL CHECK (category IN ('academic','social','economic','demographic')), 
  target_value  REAL NOT NULL DEFAULT 0, 
  current_value REAL NOT NULL DEFAULT 0, 
  period        TEXT NOT NULL, 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at    TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_impact_metrics_br     ON impact_metrics(branch_id);

CREATE TABLE IF NOT EXISTS impact_reports ( 
  id           TEXT PRIMARY KEY, 
  title        TEXT NOT NULL, 
  donor_id     TEXT REFERENCES donors(id) ON DELETE SET NULL, 
  campaign_id  TEXT REFERENCES funding_campaigns(id) ON DELETE SET NULL, 
  period       TEXT NOT NULL, 
  generated_at TEXT NOT NULL DEFAULT (datetime('now')), 
  metrics      TEXT, 
  narrative    TEXT, 
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','sent')), 
  branch_id    TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
);
CREATE INDEX IF NOT EXISTS idx_impact_reports_br     ON impact_reports(branch_id);

CREATE TABLE IF NOT EXISTS success_stories ( 
  id           TEXT PRIMARY KEY, 
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  title        TEXT NOT NULL, 
  content      TEXT NOT NULL, 
  photo_url    TEXT, 
  published_at TEXT, 
  tags         TEXT NOT NULL DEFAULT '[]', 
  branch_id    TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at   TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_success_stories_stu   ON success_stories(student_id);

-- ============================================================================
-- WORKFLOW, RULES & EVENTS
-- ============================================================================
-- Declarative operational automation and the domain event log.

CREATE TABLE IF NOT EXISTS rule_definitions ( 
  id               TEXT PRIMARY KEY, 
  name             TEXT NOT NULL, 
  description      TEXT NOT NULL DEFAULT '', 
  category         TEXT NOT NULL CHECK (category IN ('fee','discount','promotion','attendance','payroll','scholarship','workflow','notification','finance','academic')), 
  conditions       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conditions) AND json_type(conditions) = 'array'),
  actions          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions) AND json_type(actions) = 'array'),
  priority         INTEGER NOT NULL DEFAULT 0, 
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  scope_branch_id  TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_modified_by TEXT NOT NULL DEFAULT 'system', 
  last_modified_at TEXT NOT NULL DEFAULT (datetime('now')), 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_rules_category        ON rule_definitions(category, is_active);

CREATE TABLE IF NOT EXISTS rule_versions ( 
  id          TEXT PRIMARY KEY, 
  rule_id     TEXT NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE, 
  version     INTEGER NOT NULL CHECK (version >= 1),
  conditions  TEXT NOT NULL CHECK (json_valid(conditions) AND json_type(conditions) = 'array'),
  actions     TEXT NOT NULL CHECK (json_valid(actions) AND json_type(actions) = 'array'),
  priority    INTEGER NOT NULL, 
  is_active   INTEGER NOT NULL CHECK (is_active IN (0,1)),
  modified_by TEXT NOT NULL, 
  modified_at TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(rule_id, version) 
);
CREATE INDEX IF NOT EXISTS idx_rule_versions_rule    ON rule_versions(rule_id, version DESC);

CREATE TABLE IF NOT EXISTS rule_evaluation_logs ( 
  id           TEXT PRIMARY KEY, 
  rule_id      TEXT NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE, 
  category     TEXT NOT NULL, 
  branch_id    TEXT, 
  matched      INTEGER NOT NULL CHECK (matched IN (0,1)),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  result_json  TEXT NOT NULL CHECK (json_valid(result_json)),
  dry_run      INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS workflow_definitions ( 
  id         TEXT PRIMARY KEY, 
  name       TEXT NOT NULL, 
  trigger    TEXT NOT NULL, 
  steps      TEXT NOT NULL DEFAULT '[]', 
  is_active  INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS workflow_instances ( 
  id            TEXT PRIMARY KEY, 
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE RESTRICT, 
  entity_type   TEXT NOT NULL, 
  entity_id     TEXT NOT NULL, 
  current_step  INTEGER NOT NULL DEFAULT 1, 
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','approved','rejected','completed','cancelled')), 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  initiated_by  TEXT, 
  started_at    TEXT NOT NULL DEFAULT (datetime('now')), 
  completed_at  TEXT, 
  payload       TEXT NOT NULL DEFAULT '{}' 
);
CREATE INDEX IF NOT EXISTS idx_wf_inst_status        ON workflow_instances(status, branch_id);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_branch_status ON workflow_instances(branch_id, status, started_at);
CREATE TRIGGER IF NOT EXISTS trg_workflow_entity_branch_update BEFORE UPDATE OF branch_id ON workflow_instances WHEN NEW.branch_id <> OLD.branch_id BEGIN SELECT RAISE(ABORT, 'workflow branch is immutable'); END;

CREATE TABLE IF NOT EXISTS workflow_history ( 
  id          TEXT PRIMARY KEY, 
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE, 
  step_order  INTEGER NOT NULL DEFAULT 0, 
  actor       TEXT NOT NULL, 
  action      TEXT NOT NULL, 
  notes       TEXT, 
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_wf_hist_instance      ON workflow_history(instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_history_instance_time ON workflow_history(instance_id, timestamp);

CREATE TABLE IF NOT EXISTS automations ( 
  id         TEXT PRIMARY KEY, 
  name       TEXT NOT NULL, 
  trigger    TEXT NOT NULL, 
  conditions TEXT NOT NULL DEFAULT '[]', 
  actions    TEXT NOT NULL DEFAULT '[]', 
  is_active  INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS domain_events ( 
  id             TEXT PRIMARY KEY, 
  type           TEXT NOT NULL, 
  aggregate_type TEXT NOT NULL, 
  aggregate_id   TEXT NOT NULL, 
  payload        TEXT NOT NULL DEFAULT '{}', 
  occurred_at    TEXT NOT NULL, 
  operator_id    TEXT, 
  branch_id      TEXT NOT NULL, 
  correlation_id TEXT, 
  causation_id   TEXT, 
  schema_version INTEGER NOT NULL DEFAULT 1, 
  published      INTEGER NOT NULL DEFAULT 0, 
  metadata       TEXT 
);
CREATE INDEX IF NOT EXISTS idx_domain_events_corr    ON domain_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_pub     ON domain_events(published);
CREATE INDEX IF NOT EXISTS idx_domain_events_type    ON domain_events(type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS event_handler_log ( 
  id          TEXT PRIMARY KEY, 
  event_id    TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE, 
  handler     TEXT NOT NULL, 
  success     INTEGER NOT NULL, 
  duration_ms REAL NOT NULL DEFAULT 0, 
  error       TEXT, 
  executed_at TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(event_id, handler) 
);
CREATE INDEX IF NOT EXISTS idx_event_handler_event   ON event_handler_log(event_id);

CREATE TABLE IF NOT EXISTS event_subscriptions ( 
  id         TEXT PRIMARY KEY, 
  event_type TEXT NOT NULL, 
  handler    TEXT NOT NULL CHECK (handler IN ('workflow','automation','notification','webhook')), 
  config     TEXT NOT NULL DEFAULT '{}', 
  is_active  INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
);

CREATE TABLE IF NOT EXISTS notifications (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  message   TEXT,
  date      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info','warning','critical','success')),
  link      TEXT,
  branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_branch_date ON notifications(branch_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_date        ON notifications(date DESC);

CREATE TABLE IF NOT EXISTS notification_read_receipts (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_read_receipts_user
  ON notification_read_receipts(user_id);

-- ============================================================================
-- AUDIT
-- ============================================================================
-- Immutable operational audit trail.

CREATE TABLE IF NOT EXISTS audit_logs ( 
  id            TEXT PRIMARY KEY, 
  operator_id   TEXT, 
  operator_name TEXT, 
  operator_role TEXT, 
  action        TEXT NOT NULL, 
  date          TEXT NOT NULL, 
  time          TEXT NOT NULL, 
  old_value     TEXT, 
  new_value     TEXT, 
  ip            TEXT, 
  device        TEXT, 
  branch_id     TEXT 
);
CREATE INDEX IF NOT EXISTS idx_audit_branch          ON audit_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_date            ON audit_logs(date);

CREATE TABLE IF NOT EXISTS audit_failures (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  request_id TEXT,
  operator_id TEXT,
  branch_id TEXT,
  action TEXT NOT NULL,
  error TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_failures_branch ON audit_failures(branch_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_failures_time ON audit_failures(occurred_at DESC);
