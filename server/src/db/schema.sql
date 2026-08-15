-- ============================================================================ 
-- TOEFL House ERP v2.0 — Complete Database Schema (SQLite)
-- ============================================================================ 
-- Architecture: Process-Centric, DDD Bounded Contexts, Session-Centric Core 
-- Domain-oriented ERP | Event-driven operations 
-- 
-- Conventions: 
--   * Monetary values stored as REAL in AFN. 
--   * Dates as ISO strings (YYYY-MM-DD); timestamps via datetime('now'). 
--   * Every operational table carries branch_id for multi-branch support. 
--   * Booleans stored as INTEGER 0/1. 
--   * JSON payloads stored as TEXT. 
--   * All FK references use explicit ON DELETE behavior (RESTRICT, CASCADE, SET NULL). 
-- 
-- REVISION HISTORY: 
--   v2.0.6 — Fixed dependency ordering, added explicit ON DELETE rules. 
--   v2.0.7 — THIS REVISION: 
--            • Added book_id to payments table for smart book payments. 
--            • Added 'installment' and 'refund' to payments category CHECK. 
--            • Moved Inventory (BC #10) before Finance (BC #9) for FK integrity. 
-- ============================================================================= 

PRAGMA foreign_keys = ON; 
PRAGMA journal_mode = WAL; 

-- ============================================================================ 
-- BC #1: IDENTITY & ACCESS 
-- ============================================================================ 

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

CREATE INDEX IF NOT EXISTS idx_campuses_org        ON campuses(organization_id); 
CREATE INDEX IF NOT EXISTS idx_campuses_active     ON campuses(is_active); 
CREATE INDEX IF NOT EXISTS idx_branches_active     ON branches(is_active); 

CREATE TABLE IF NOT EXISTS partners ( 
  id               TEXT PRIMARY KEY, 
  full_name        TEXT NOT NULL, 
  phone            TEXT, 
  email            TEXT, 
  share_percent    REAL NOT NULL DEFAULT 0, 
  role_description TEXT 
); 

CREATE TABLE IF NOT EXISTS users ( 
  id                   TEXT PRIMARY KEY, 
  username             TEXT NOT NULL UNIQUE, 
  password_hash        TEXT NOT NULL, 
  full_name            TEXT NOT NULL, 
  email                TEXT, 
  role                 TEXT NOT NULL CHECK (role IN ( 
                         'owner','manager','finance','registrar','teacher', 
                         'head_of_department','counselor','donor_manager','student' 
                       )), 
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

-- Enterprise RBAC 
CREATE TABLE IF NOT EXISTS roles ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, 
  is_system INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, 
  sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT 
); 

CREATE TABLE IF NOT EXISTS permissions ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, resource TEXT NOT NULL, action TEXT NOT NULL, 
  description TEXT, category TEXT NOT NULL DEFAULT 'general', is_system INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS role_permissions ( 
  id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, 
  default_scope TEXT NOT NULL DEFAULT 'branch' CHECK (default_scope IN ('organization','campus','branch','department','program','class','own')), 
  UNIQUE(role_id, permission_id) 
); 

CREATE TABLE IF NOT EXISTS user_roles ( 
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')), 
  scope_id TEXT, is_primary INTEGER NOT NULL DEFAULT 0, assigned_by TEXT, 
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT, 
  UNIQUE(user_id, role_id, scope_type, scope_id) 
); 

CREATE TABLE IF NOT EXISTS permission_overrides ( 
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, 
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')), 
  scope_type TEXT NOT NULL DEFAULT 'branch' CHECK (scope_type IN ('organization','campus','branch','department','program','class','own')), 
  scope_id TEXT, reason TEXT, granted_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT 
); 

CREATE TABLE IF NOT EXISTS role_delegations ( 
  id TEXT PRIMARY KEY, from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, 
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, 
  scope_type TEXT NOT NULL DEFAULT 'branch', scope_id TEXT, reason TEXT, 
  starts_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT NOT NULL, created_by TEXT, is_active INTEGER NOT NULL DEFAULT 1 
); 

CREATE INDEX IF NOT EXISTS idx_users_branch          ON users(branch_id); 
CREATE INDEX IF NOT EXISTS idx_users_role            ON users(role); 
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id); 
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id); 
CREATE INDEX IF NOT EXISTS idx_user_roles_user       ON user_roles(user_id); 
CREATE INDEX IF NOT EXISTS idx_user_roles_role       ON user_roles(role_id); 
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user ON permission_overrides(user_id); 
CREATE INDEX IF NOT EXISTS idx_permissions_resource  ON permissions(resource); 
CREATE INDEX IF NOT EXISTS idx_permissions_code      ON permissions(code); 
CREATE INDEX IF NOT EXISTS idx_roles_code            ON roles(code); 

-- ============================================================================ 
-- BC #2: CRM — LEAD PIPELINE 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS campaigns ( 
  id         TEXT PRIMARY KEY, 
  name       TEXT NOT NULL, 
  source     TEXT NOT NULL CHECK (source IN ('ads','social','referral','event','organic','other')), 
  start_date TEXT NOT NULL, 
  end_date   TEXT, 
  budget     REAL NOT NULL DEFAULT 0, 
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')), 
  branch_id  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
); 

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
  placement_requirement_mode TEXT,
  placement_status_at     TEXT,
  current_placement_attempt_id TEXT REFERENCES placement_assessment_attempts(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_visitors_program_version ON visitors(program_version_id);
CREATE INDEX IF NOT EXISTS idx_visitors_placement_status ON visitors(placement_status);

CREATE TABLE IF NOT EXISTS visitor_followups ( 
  id         TEXT PRIMARY KEY, 
  visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE, 
  date       TEXT NOT NULL, 
  notes      TEXT, 
  operator   TEXT, 
  outcome    TEXT CHECK (outcome IN ('interested','not_interested','callback','registered')) 
); 

CREATE INDEX IF NOT EXISTS idx_visitors_branch       ON visitors(branch_id); 
CREATE INDEX IF NOT EXISTS idx_visitors_status       ON visitors(status); 
CREATE INDEX IF NOT EXISTS idx_visitors_stage        ON visitors(stage); 
CREATE INDEX IF NOT EXISTS idx_visitors_campaign     ON visitors(campaign_id); 
CREATE INDEX IF NOT EXISTS idx_visitors_source       ON visitors(source); 
CREATE INDEX IF NOT EXISTS idx_visitors_branch_status ON visitors(branch_id, status);
CREATE TABLE IF NOT EXISTS placement_assessment_profiles (
  id TEXT PRIMARY KEY,
  program_version_id TEXT NOT NULL REFERENCES program_versions(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'skill_scores' CHECK (method IN ('skill_scores','level_assessment','written_test','interview','hybrid','content_test')),
  sections_json TEXT NOT NULL DEFAULT '[\"grammar\",\"writing\",\"listening\",\"speaking\"]',
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
  UNIQUE(program_version_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_profile_program_branch ON placement_assessment_profiles(program_version_id, branch_id, enabled);

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
  expires_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1,
  decision_rule_id TEXT,
  override_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  override_reason TEXT,
  override_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  override_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(visitor_id, attempt_number)
);

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

CREATE INDEX IF NOT EXISTS idx_placement_attempts_visitor ON placement_assessment_attempts(visitor_id, status, attempt_number);
CREATE INDEX IF NOT EXISTS idx_placement_attempts_branch ON placement_assessment_attempts(branch_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);

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
 
CREATE INDEX IF NOT EXISTS idx_campaigns_branch      ON campaigns(branch_id); 

-- ============================================================================ 
-- BC #3: ACADEMIC — SESSION-CENTRIC CORE 
-- ============================================================================ 

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

CREATE TABLE IF NOT EXISTS levels ( 
  id                  TEXT PRIMARY KEY, 
  program_id          TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, 
  name                TEXT NOT NULL, 
  "order"             INTEGER NOT NULL DEFAULT 1, 
  prerequisites       TEXT DEFAULT '[]', 
  program_version_id  TEXT, 
  code                TEXT, 
  duration_months     INTEGER DEFAULT 0, 
  default_fee         REAL DEFAULT 0, 
  pass_mark           REAL DEFAULT 60, 
  is_active           INTEGER DEFAULT 1, 
  min_viable_size     INTEGER DEFAULT 5, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS teachers ( 
  id                 TEXT PRIMARY KEY, 
  full_name          TEXT NOT NULL, 
  phone              TEXT, 
  email              TEXT, 
  base_salary        REAL NOT NULL DEFAULT 0, 
  salary_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (salary_type IN ('fixed','per_skill','per_session','hybrid','per_level')),
  performance_score  REAL NOT NULL DEFAULT 0, 
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','on_leave')), 
  branch_id          TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  joined_date        TEXT NOT NULL, 
  specialization     TEXT, 
  qualification      TEXT, 
  contract_type      TEXT CHECK (contract_type IN ('monthly','hourly','per_session')), 
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL, 
  default_skill_rate REAL NOT NULL DEFAULT 0, 
  target_skills_per_month INTEGER 
); 

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
  fee_snapshot        REAL NOT NULL DEFAULT 0, 
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
); 

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
  -- `status` is a derived, backward-compatible projection of
  -- `lifecycle_stage` (Class Lifecycle Engine — see core/academic/
  -- lifecycle-engine.ts). Only ClassLifecycleService writes either column.
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')), 
  lifecycle_stage      TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_stage IN (
                         'draft','scheduled','enrollment_open','enrollment_closed',
                         'activated','in_progress','suspended','grading',
                         'completed','archived','cancelled'
                       )), 
  lifecycle_updated_at TEXT, 
  cancellation_reason  TEXT, 
  fee                  REAL NOT NULL DEFAULT 0, 
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
CREATE INDEX IF NOT EXISTS idx_classes_lifecycle ON classes(lifecycle_stage);

CREATE TABLE IF NOT EXISTS class_teacher_skills ( 
  id              TEXT PRIMARY KEY, 
  class_id        TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, 
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT, 
  monthly_rate    REAL NOT NULL DEFAULT 0, 
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  -- Teacher Assignment Engine (Phase 8). session_id NULL = class-scoped
  -- (the original, only kind before this phase); a real session_id scopes
  -- a one-off assignment (e.g. a single-session substitute) to just that
  -- session. See core/academic docs / routes/skills.routes.ts.
  assignment_type TEXT NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary','assistant','substitute','guest','examiner')), 
  start_date      TEXT, 
  end_date        TEXT, 
  reason          TEXT, 
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE, 
  UNIQUE(class_id, teacher_id, skill_id, session_id) 
); 

CREATE INDEX IF NOT EXISTS idx_cts_teacher ON class_teacher_skills(teacher_id);
CREATE INDEX IF NOT EXISTS idx_cts_class ON class_teacher_skills(class_id);
CREATE INDEX IF NOT EXISTS idx_cts_session ON class_teacher_skills(session_id);
CREATE INDEX IF NOT EXISTS idx_cts_type ON class_teacher_skills(assignment_type);

CREATE TABLE IF NOT EXISTS teacher_level_skill_rates ( 
  id           TEXT PRIMARY KEY, 
  teacher_id   TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  level_id     TEXT, 
  level_code   TEXT NOT NULL, 
  skill_id     TEXT REFERENCES skills(id) ON DELETE CASCADE, 
  rate_per_skill REAL NOT NULL DEFAULT 0, 
  branch_id    TEXT NOT NULL, 
  UNIQUE(teacher_id, level_code, skill_id) 
); 

CREATE TABLE IF NOT EXISTS teacher_salary_ledger ( 
  id              TEXT PRIMARY KEY, 
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, 
  period_key      TEXT NOT NULL, 
  period_label    TEXT NOT NULL, 
  due_amount      REAL NOT NULL DEFAULT 0, 
  paid_amount     REAL NOT NULL DEFAULT 0, 
  payment_type    TEXT NOT NULL CHECK (payment_type IN ('full','partial','advance')), 
  transaction_id  TEXT, 
  notes           TEXT, 
  branch_id       TEXT NOT NULL, 
  paid_at         TEXT NOT NULL DEFAULT (datetime('now')), 
  operator_name   TEXT 
); 

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

CREATE TABLE IF NOT EXISTS sessions ( 
  id                 TEXT PRIMARY KEY, 
  class_id           TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, 
  date               TEXT NOT NULL, 
  start_time         TEXT NOT NULL, 
  end_time           TEXT NOT NULL, 
  topic              TEXT, 
  notes              TEXT, 
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), 
  -- Session Engine (core/academic/lifecycle-engine.ts adjacent — see
  -- routes/sessions.routes.ts). Teacher substitution needs no dedicated
  -- column: teacher_id has always been independent per-session.
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

CREATE TABLE IF NOT EXISTS rosters ( 
  id                 TEXT PRIMARY KEY, 
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, 
  student_id         TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  -- Smart Attendance Engine. 'sick'/'leave' are permanent aliases of
  -- 'medical_leave'/'excused' (Phase 2) for backward compatibility.
  attendance_status  TEXT NOT NULL DEFAULT 'not_marked' CHECK (attendance_status IN (
                       'present','late','absent','excused','medical_leave','sick','leave',
                       'online','hybrid','left_early','not_marked'
                     )), 
  late_minutes       INTEGER, 
  attendance_weight  REAL, 
  marked_at          TEXT, 
  UNIQUE(session_id, student_id) 
); 

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

CREATE INDEX IF NOT EXISTS idx_programs_branch       ON programs(branch_id); 
CREATE INDEX IF NOT EXISTS idx_levels_program        ON levels(program_id); 
CREATE INDEX IF NOT EXISTS idx_classes_branch        ON classes(branch_id); 
CREATE INDEX IF NOT EXISTS idx_classes_program       ON classes(program_id); 
CREATE INDEX IF NOT EXISTS idx_classes_level         ON classes(level_id); 
CREATE INDEX IF NOT EXISTS idx_classes_teacher       ON classes(teacher_id); 
CREATE INDEX IF NOT EXISTS idx_sessions_class        ON sessions(class_id); 
CREATE INDEX IF NOT EXISTS idx_sessions_date         ON sessions(date); 
CREATE INDEX IF NOT EXISTS idx_rosters_session       ON rosters(session_id); 
CREATE INDEX IF NOT EXISTS idx_rosters_student       ON rosters(student_id); 
CREATE INDEX IF NOT EXISTS idx_cts_teacher           ON class_teacher_skills(teacher_id); 
CREATE INDEX IF NOT EXISTS idx_cts_class             ON class_teacher_skills(class_id); 
CREATE INDEX IF NOT EXISTS idx_teacher_eval_teacher  ON teacher_evaluations(teacher_id); 
CREATE INDEX IF NOT EXISTS idx_course_offerings_branch ON course_offerings(branch_id, status); 
CREATE INDEX IF NOT EXISTS idx_time_slots_branch     ON time_slots(branch_id, is_active); 
CREATE INDEX IF NOT EXISTS idx_rooms_branch          ON rooms(branch_id, is_active); 
CREATE INDEX IF NOT EXISTS idx_academic_terms_branch ON academic_terms(branch_id, year); 

-- ============================================================================ 
-- BC #4: STUDENT 
-- ============================================================================ 

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

CREATE TABLE IF NOT EXISTS student_semesters ( 
  id            TEXT PRIMARY KEY, 
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  semester_name TEXT NOT NULL, 
  class_id      TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  enroll_date   TEXT NOT NULL, 
  fee_amount    REAL NOT NULL DEFAULT 0, 
  net_fee_amount REAL, 
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','deferred')), 
  -- Gradebook Engine (Phase 4) — populated once, at complete-semester time,
  -- by the same computeClassGrades() the live gradebook preview uses.
  final_score      REAL, 
  final_percentage REAL, 
  letter_grade     TEXT 
); 
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_semester_active ON student_semesters(student_id, semester_name) WHERE status = 'active'; 

CREATE TABLE IF NOT EXISTS registrations ( 
  id               TEXT PRIMARY KEY, 
  student_id       TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  class_id         TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  date             TEXT NOT NULL, 
  amount_paid      REAL NOT NULL DEFAULT 0, 
  receipt_number   TEXT, 
  discount_applied REAL NOT NULL DEFAULT 0, 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  source           TEXT, 
  semester         TEXT 
); 

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
  -- Enrollment Lifecycle Engine (core/academic/lifecycle-engine.ts). 'paused'
  -- and 'suspended' are permanent aliases of 'frozen' kept for the existing
  -- suspend()/resume() API; new code should prefer freeze()/unfreeze().
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
CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status);

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

-- Transfer/Freeze/Waitlist Engines (Phase 9). These wrap the freeze()/
-- unfreeze()/transfer() transitions above with the "why and for how long"
-- workflow layer — see migrations/036_transfer_freeze_waitlist_engines.sql
-- for the full rationale and routes/enrollment.routes.ts + routes/waitlist.routes.ts
-- for enforcement.
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
CREATE INDEX IF NOT EXISTS idx_wl_student ON class_waitlist(student_id);
CREATE INDEX IF NOT EXISTS idx_wl_status ON class_waitlist(status);

CREATE TABLE IF NOT EXISTS student_id_cards ( 
  id           TEXT PRIMARY KEY, 
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  issued_at    TEXT NOT NULL, 
  expires_at   TEXT, 
  fee_amount   REAL NOT NULL DEFAULT 0, 
  printed      INTEGER NOT NULL DEFAULT 0, 
  reprinted    INTEGER NOT NULL DEFAULT 0, 
  design       TEXT, 
  branch_id    TEXT REFERENCES branches(id) ON DELETE SET NULL, 
  notes        TEXT, 
  created_at   TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_students_branch       ON students(branch_id); 
CREATE INDEX IF NOT EXISTS idx_students_status       ON students(status); 
CREATE INDEX IF NOT EXISTS idx_students_lead         ON students(lead_id); 
CREATE INDEX IF NOT EXISTS idx_students_code         ON students(student_code); 
CREATE INDEX IF NOT EXISTS idx_semesters_student     ON student_semesters(student_id); 
CREATE INDEX IF NOT EXISTS idx_semesters_class       ON student_semesters(class_id); 
CREATE INDEX IF NOT EXISTS idx_registrations_student ON registrations(student_id); 
CREATE INDEX IF NOT EXISTS idx_registrations_class   ON registrations(class_id); 
CREATE INDEX IF NOT EXISTS idx_attendance_target     ON attendance(target_id, target_type); 
CREATE INDEX IF NOT EXISTS idx_attendance_date       ON attendance(date); 
CREATE INDEX IF NOT EXISTS idx_enrollments_student   ON enrollments(student_id, started_at DESC); 
CREATE INDEX IF NOT EXISTS idx_enrollments_branch    ON enrollments(branch_id); 
CREATE INDEX IF NOT EXISTS idx_enrollments_class     ON enrollments(class_id); 
CREATE INDEX IF NOT EXISTS idx_sje_student_time      ON student_journey_events(student_id, occurred_at ASC, created_at ASC); 
CREATE INDEX IF NOT EXISTS idx_sje_type              ON student_journey_events(event_type, occurred_at DESC); 
CREATE INDEX IF NOT EXISTS idx_sje_enrollment        ON student_journey_events(enrollment_id); 
CREATE INDEX IF NOT EXISTS idx_enrollment_events_student ON enrollment_events(student_id, created_at DESC); 
CREATE INDEX IF NOT EXISTS idx_id_cards_student      ON student_id_cards(student_id); 

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tazkira_no ON students(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != ''; 
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone ON students(phone) WHERE phone IS NOT NULL AND phone != ''; 
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email ON students(email) WHERE email IS NOT NULL AND email != ''; 
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_lead_id ON students(lead_id) WHERE lead_id IS NOT NULL; 

-- ============================================================================ 
-- BC #6: ASSESSMENT 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS exams ( 
  id        TEXT PRIMARY KEY, 
  title     TEXT NOT NULL, 
  date      TEXT NOT NULL, 
  fee       REAL NOT NULL DEFAULT 0, 
  class_id  TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  type      TEXT NOT NULL DEFAULT 'mock' CHECK (type IN ('placement','midterm','final','mock','certification')), 
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
); 

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

CREATE INDEX IF NOT EXISTS idx_exams_branch          ON exams(branch_id); 
CREATE INDEX IF NOT EXISTS idx_exam_results_exam     ON exam_results(exam_id); 
CREATE INDEX IF NOT EXISTS idx_exam_results_student  ON exam_results(student_id); 
CREATE INDEX IF NOT EXISTS idx_exam_results_visitor  ON exam_results(visitor_id); 
CREATE INDEX IF NOT EXISTS idx_certificates_student  ON certificates(student_id); 

-- ============================================================================ 
-- BC #8: HR — EMPLOYEE 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS employees ( 
  id          TEXT PRIMARY KEY, 
  full_name   TEXT NOT NULL, 
  phone       TEXT, 
  email       TEXT, 
  role        TEXT NOT NULL, 
  base_salary REAL NOT NULL DEFAULT 0, 
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  joined_date TEXT NOT NULL, 
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL 
); 

CREATE INDEX IF NOT EXISTS idx_employees_branch      ON employees(branch_id); 

-- ============================================================================ 
-- BC #10: INVENTORY (Moved before Finance for Foreign Key Integrity) 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS books ( 
  id             TEXT PRIMARY KEY, 
  title          TEXT NOT NULL, 
  price          REAL NOT NULL DEFAULT 0, 
  purchase_price REAL, 
  stock          INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0), 
  is_chapter     INTEGER NOT NULL DEFAULT 0, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  entry_date     TEXT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
); 

CREATE TABLE IF NOT EXISTS book_restock_history ( 
  id             TEXT PRIMARY KEY, 
  book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, 
  date           TEXT NOT NULL, 
  quantity       INTEGER NOT NULL, 
  price          REAL NOT NULL, 
  purchase_price REAL 
); 

CREATE TABLE IF NOT EXISTS book_sales ( 
  id              TEXT PRIMARY KEY, 
  book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT, 
  quantity        INTEGER NOT NULL, 
  total_amount    REAL NOT NULL, 
  discount_amount REAL DEFAULT 0, 
  net_amount      REAL, 
  payment_method  TEXT CHECK (payment_method IN ('cash','card','transfer')), 
  status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')), 
  date            TEXT NOT NULL, 
  customer_name   TEXT, 
  student_id      TEXT REFERENCES students(id) ON DELETE SET NULL, 
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at      TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_books_branch          ON books(branch_id); 
CREATE INDEX IF NOT EXISTS idx_book_sales_branch     ON book_sales(branch_id); 
CREATE INDEX IF NOT EXISTS idx_book_sales_book       ON book_sales(book_id); 
CREATE INDEX IF NOT EXISTS idx_book_restock_book     ON book_restock_history(book_id); 

-- ============================================================================ 
-- BC #9: FINANCE 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS finance_accounts (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('organization','branch')),
  scope_id TEXT NOT NULL,
  main_balance REAL NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
  saving_balance REAL NOT NULL DEFAULT 0 CHECK (saving_balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS budget_lines ( 
  id               TEXT PRIMARY KEY, 
  name             TEXT NOT NULL, 
  current_amount   REAL NOT NULL DEFAULT 0, 
  allocated_amount REAL NOT NULL DEFAULT 0, 
  icon             TEXT, 
  cost_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (cost_type IN ('fixed','variable')), 
  is_marketing     INTEGER NOT NULL DEFAULT 0, 
  purpose          TEXT, 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
); 

CREATE TABLE IF NOT EXISTS expense_requests ( 
  id                   TEXT PRIMARY KEY, 
  title                TEXT NOT NULL, 
  amount               REAL NOT NULL, 
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
  auto_approved        INTEGER NOT NULL DEFAULT 0
); 

-- LEGACY_COMPAT_ONLY: runtime Finance uses finance_accounts; this table remains for migration compatibility.
CREATE TABLE IF NOT EXISTS saving_accounts ( 
  branch_id TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE, 
  balance   REAL NOT NULL DEFAULT 0 
); 

CREATE TABLE IF NOT EXISTS invoices ( 
  id             TEXT PRIMARY KEY, 
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  total_amount   REAL NOT NULL DEFAULT 0, 
  discount_amount REAL NOT NULL DEFAULT 0, 
  net_amount     REAL NOT NULL DEFAULT 0, 
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

CREATE TABLE IF NOT EXISTS invoice_items ( 
  id          TEXT PRIMARY KEY, 
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, 
  description TEXT NOT NULL, 
  quantity    INTEGER NOT NULL DEFAULT 1, 
  unit_price  REAL NOT NULL DEFAULT 0, 
  amount      REAL NOT NULL DEFAULT 0 
); 

CREATE TABLE IF NOT EXISTS payments ( 
  id             TEXT PRIMARY KEY, 
  student_id     TEXT REFERENCES students(id) ON DELETE SET NULL, 
  invoice_id     TEXT REFERENCES invoices(id) ON DELETE SET NULL, 
  book_id        TEXT REFERENCES books(id) ON DELETE SET NULL, -- ADDED for smart payments 
  amount         REAL NOT NULL, 
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL; 

CREATE TABLE IF NOT EXISTS financial_transactions ( 
  id            TEXT PRIMARY KEY, 
  type          TEXT NOT NULL CHECK (type IN ('income','expense','saving_transfer','budget_charge')), 
  category      TEXT NOT NULL, 
  amount        REAL NOT NULL, 
  date          TEXT NOT NULL, 
  description   TEXT, 
  reference_id  TEXT, 
  payment_id    TEXT REFERENCES payments(id) ON DELETE SET NULL, 
  operator_name TEXT, 
  operator_role TEXT, 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
); 

CREATE INDEX IF NOT EXISTS idx_budget_lines_branch   ON budget_lines(branch_id); 
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch         ON financial_transactions(branch_id); 
CREATE INDEX IF NOT EXISTS idx_fin_tx_date           ON financial_transactions(date); 
CREATE INDEX IF NOT EXISTS idx_fin_tx_type           ON financial_transactions(type); 
CREATE INDEX IF NOT EXISTS idx_fin_tx_payment        ON financial_transactions(payment_id); 
CREATE INDEX IF NOT EXISTS idx_payments_student      ON payments(student_id); 
CREATE INDEX IF NOT EXISTS idx_payments_branch       ON payments(branch_id); 
CREATE INDEX IF NOT EXISTS idx_payments_date         ON payments(date); 
CREATE INDEX IF NOT EXISTS idx_payments_invoice      ON payments(invoice_id); 
CREATE INDEX IF NOT EXISTS idx_payments_book         ON payments(book_id); -- ADDED INDEX 
CREATE INDEX IF NOT EXISTS idx_invoices_student      ON invoices(student_id); 
CREATE INDEX IF NOT EXISTS idx_invoices_branch       ON invoices(branch_id); 
CREATE INDEX IF NOT EXISTS idx_invoices_due_date     ON invoices(due_date); 
CREATE INDEX IF NOT EXISTS idx_invoices_status_due   ON invoices(status, due_date); 
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv     ON invoice_items(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_number_per_branch ON invoices(branch_id, invoice_number) WHERE invoice_number IS NOT NULL;
 
CREATE INDEX IF NOT EXISTS idx_expense_req_branch    ON expense_requests(branch_id); 
CREATE INDEX IF NOT EXISTS idx_expense_req_status    ON expense_requests(status);

-- High-assurance invariants for fresh installations.
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
CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_insert
BEFORE INSERT ON payments
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'payment amount must have at most two decimal places'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_money_scale_update
BEFORE UPDATE OF amount ON payments
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'payment amount must have at most two decimal places'); END;
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_insert
BEFORE INSERT ON financial_transactions
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must have at most two decimal places'); END;
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_update
BEFORE UPDATE OF amount ON financial_transactions
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must have at most two decimal places'); END;
 

-- ============================================================================ 
-- BC #11: FUNDING — SPONSORSHIP / DONATION / SCHOLARSHIP 
-- ============================================================================ 

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

CREATE TABLE IF NOT EXISTS funding_campaigns ( 
  id            TEXT PRIMARY KEY, 
  name          TEXT NOT NULL, 
  description   TEXT, 
  donor_id      TEXT REFERENCES donors(id) ON DELETE SET NULL, 
  target_amount REAL NOT NULL DEFAULT 0, 
  raised_amount REAL NOT NULL DEFAULT 0, 
  start_date    TEXT NOT NULL, 
  end_date      TEXT, 
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')), 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at    TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS donations ( 
  id               TEXT PRIMARY KEY, 
  campaign_id      TEXT REFERENCES funding_campaigns(id) ON DELETE SET NULL, 
  donor_id         TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT, 
  amount           REAL NOT NULL, 
  date             TEXT NOT NULL, 
  restricted       INTEGER NOT NULL DEFAULT 0, 
  restriction_note TEXT, 
  receipt_no       TEXT NOT NULL, 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS scholarships ( 
  id               TEXT PRIMARY KEY, 
  name             TEXT NOT NULL, 
  donor_id         TEXT REFERENCES donors(id) ON DELETE SET NULL, 
  campaign_id      TEXT REFERENCES funding_campaigns(id) ON DELETE SET NULL, 
  total_budget     REAL NOT NULL DEFAULT 0, 
  allocated_amount REAL NOT NULL DEFAULT 0, 
  criteria         TEXT, 
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','closed')), 
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS scholarship_awards ( 
  id             TEXT PRIMARY KEY, 
  scholarship_id TEXT NOT NULL REFERENCES scholarships(id) ON DELETE CASCADE, 
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  amount         REAL NOT NULL, 
  award_date     TEXT NOT NULL, 
  semester       TEXT, 
  notes          TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT 
); 

CREATE TABLE IF NOT EXISTS sponsorship_agreements ( 
  id             TEXT PRIMARY KEY, 
  donor_id       TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT, 
  student_id     TEXT REFERENCES students(id) ON DELETE SET NULL, 
  program_id     TEXT REFERENCES programs(id) ON DELETE SET NULL, 
  monthly_amount REAL NOT NULL DEFAULT 0, 
  start_date     TEXT NOT NULL, 
  end_date       TEXT NOT NULL, 
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','terminated')), 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_donors_type           ON donors(type); 
CREATE INDEX IF NOT EXISTS idx_funding_camp_branch   ON funding_campaigns(branch_id); 
CREATE INDEX IF NOT EXISTS idx_donations_donor       ON donations(donor_id); 
CREATE INDEX IF NOT EXISTS idx_donations_campaign    ON donations(campaign_id); 
CREATE INDEX IF NOT EXISTS idx_scholarships_branch   ON scholarships(branch_id); 
CREATE INDEX IF NOT EXISTS idx_schol_awards_stu      ON scholarship_awards(student_id); 
CREATE INDEX IF NOT EXISTS idx_schol_awards_schol    ON scholarship_awards(scholarship_id); 
CREATE INDEX IF NOT EXISTS idx_sponsorships_donor    ON sponsorship_agreements(donor_id); 
CREATE INDEX IF NOT EXISTS idx_sponsorships_student  ON sponsorship_agreements(student_id); 

-- ============================================================================ 
-- BC #12: IMPACT — NGO / DONOR REPORTING 
-- ============================================================================ 

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

CREATE INDEX IF NOT EXISTS idx_impact_metrics_br     ON impact_metrics(branch_id); 
CREATE INDEX IF NOT EXISTS idx_impact_reports_br     ON impact_reports(branch_id); 
CREATE INDEX IF NOT EXISTS idx_success_stories_stu   ON success_stories(student_id); 

-- ============================================================================ 
-- BC #13: WORKFLOW & AUTOMATION + RULE ENGINE 
-- ============================================================================ 

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

CREATE TABLE IF NOT EXISTS workflow_history ( 
  id          TEXT PRIMARY KEY, 
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE, 
  step_order  INTEGER NOT NULL DEFAULT 0, 
  actor       TEXT NOT NULL, 
  action      TEXT NOT NULL, 
  notes       TEXT, 
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')) 
); 

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

CREATE TABLE IF NOT EXISTS rule_definitions ( 
  id               TEXT PRIMARY KEY, 
  name             TEXT NOT NULL, 
  description      TEXT NOT NULL DEFAULT '', 
  category         TEXT NOT NULL CHECK (category IN ('fee','discount','promotion','attendance','payroll','scholarship','workflow','notification','finance','academic')), 
  conditions       TEXT NOT NULL DEFAULT '[]', 
  actions          TEXT NOT NULL DEFAULT '[]', 
  priority         INTEGER NOT NULL DEFAULT 0, 
  is_active        INTEGER NOT NULL DEFAULT 1, 
  scope_branch_id  TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  version          INTEGER NOT NULL DEFAULT 1, 
  last_modified_by TEXT NOT NULL DEFAULT 'system', 
  last_modified_at TEXT NOT NULL DEFAULT (datetime('now')), 
  created_at       TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS rule_versions ( 
  id          TEXT PRIMARY KEY, 
  rule_id     TEXT NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE, 
  version     INTEGER NOT NULL, 
  conditions  TEXT NOT NULL, 
  actions     TEXT NOT NULL, 
  priority    INTEGER NOT NULL, 
  is_active   INTEGER NOT NULL, 
  modified_by TEXT NOT NULL, 
  modified_at TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(rule_id, version) 
); 

CREATE TABLE IF NOT EXISTS rule_evaluation_logs ( 
  id           TEXT PRIMARY KEY, 
  rule_id      TEXT NOT NULL REFERENCES rule_definitions(id) ON DELETE CASCADE, 
  category     TEXT NOT NULL, 
  branch_id    TEXT, 
  matched      INTEGER NOT NULL, 
  context_json TEXT NOT NULL, 
  result_json  TEXT NOT NULL, 
  dry_run      INTEGER NOT NULL DEFAULT 0, 
  evaluated_at TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_wf_inst_status        ON workflow_instances(status, branch_id); 
CREATE INDEX IF NOT EXISTS idx_wf_hist_instance      ON workflow_history(instance_id); 
CREATE INDEX IF NOT EXISTS idx_rules_category        ON rule_definitions(category, is_active); 
CREATE INDEX IF NOT EXISTS idx_rule_versions_rule    ON rule_versions(rule_id, version DESC); 

-- ============================================================================ 
-- BC #14: EVENT BUS 
-- ============================================================================ 

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

CREATE TABLE IF NOT EXISTS event_subscriptions ( 
  id         TEXT PRIMARY KEY, 
  event_type TEXT NOT NULL, 
  handler    TEXT NOT NULL CHECK (handler IN ('workflow','automation','notification','webhook')), 
  config     TEXT NOT NULL DEFAULT '{}', 
  is_active  INTEGER NOT NULL DEFAULT 1, 
  created_at TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE INDEX IF NOT EXISTS idx_domain_events_type    ON domain_events(type, occurred_at DESC); 
CREATE INDEX IF NOT EXISTS idx_domain_events_corr    ON domain_events(correlation_id); 
CREATE INDEX IF NOT EXISTS idx_domain_events_pub     ON domain_events(published); 
CREATE INDEX IF NOT EXISTS idx_event_handler_event   ON event_handler_log(event_id); 

-- ============================================================================ 
-- BC #15: NOTIFICATION & AUDIT 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS notifications ( 
  id        TEXT PRIMARY KEY, 
  title     TEXT NOT NULL, 
  message   TEXT, 
  date      TEXT NOT NULL, 
  read      INTEGER NOT NULL DEFAULT 0, 
  type      TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info','warning','critical','success')), 
  user_id   TEXT REFERENCES users(id) ON DELETE CASCADE, 
  link      TEXT, 
  branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE 
); 

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

CREATE INDEX IF NOT EXISTS idx_notifications_branch  ON notifications(branch_id); 
CREATE INDEX IF NOT EXISTS idx_notifications_read    ON notifications(read); 
CREATE INDEX IF NOT EXISTS idx_audit_branch          ON audit_logs(branch_id); 
CREATE INDEX IF NOT EXISTS idx_audit_date            ON audit_logs(date); 

-- ============================================================================ 
-- ACADEMIC DOMAIN v2 
-- ============================================================================ 

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

-- PLACEMENT ASSESSMENT WORKSPACE (runtime tables are added by migrations 037/038)
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
  created_at          TEXT NOT NULL DEFAULT (datetime('now')) 
); 

CREATE TABLE IF NOT EXISTS fee_rules ( 
  id                  TEXT PRIMARY KEY, 
  program_version_id  TEXT REFERENCES program_versions(id) ON DELETE CASCADE, 
  level_id            TEXT REFERENCES levels(id) ON DELETE SET NULL, 
  branch_id           TEXT REFERENCES branches(id) ON DELETE CASCADE, 
  fee_type            TEXT NOT NULL CHECK (fee_type IN ('registration','placement','semester','book','retake','diploma','card','exam','other')), 
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
  fee                 REAL NOT NULL DEFAULT 0, 
  proposed_name       TEXT, 
  class_id            TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','skipped','error')), 
  error_message       TEXT 
); 

CREATE TABLE IF NOT EXISTS branch_academic_profiles ( 
  branch_id               TEXT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE, 
  default_program_version_id TEXT REFERENCES program_versions(id) ON DELETE SET NULL, 
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

CREATE TABLE IF NOT EXISTS level_branch_fees ( 
  id          TEXT PRIMARY KEY, 
  level_id    TEXT NOT NULL REFERENCES levels(id) ON DELETE CASCADE, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  fee         REAL NOT NULL, 
  currency    TEXT NOT NULL DEFAULT 'AFN', 
  effective_from TEXT, 
  effective_to   TEXT, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(level_id, branch_id) 
); 

CREATE TABLE IF NOT EXISTS academic_holidays ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  date        TEXT NOT NULL, 
  title       TEXT NOT NULL, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, date) 
); 

CREATE INDEX IF NOT EXISTS idx_program_versions_program ON program_versions(program_id, status); 
CREATE INDEX IF NOT EXISTS idx_subjects_version          ON subjects(program_version_id, level_id); 
CREATE INDEX IF NOT EXISTS idx_modules_subject           ON modules(subject_id); 
CREATE INDEX IF NOT EXISTS idx_promotion_rules_version   ON promotion_rules(program_version_id, is_active); 
CREATE INDEX IF NOT EXISTS idx_placement_rules_version   ON placement_rules(program_version_id, is_active); 
CREATE INDEX IF NOT EXISTS idx_fee_rules_lookup          ON fee_rules(branch_id, fee_type, is_active); 
CREATE INDEX IF NOT EXISTS idx_class_gen_runs_branch    ON class_generation_runs(branch_id, status); 
CREATE INDEX IF NOT EXISTS idx_level_fees_branch         ON level_branch_fees(branch_id, level_id); 

-- ============================================================================ 
-- CONFIGURATION & PIPELINE METRICS 
-- ============================================================================ 

CREATE TABLE IF NOT EXISTS system_settings ( 
  key   TEXT PRIMARY KEY, 
  value TEXT NOT NULL 
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

-- ============================================================================
-- ACADEMIC ASSESSMENT & GRADEBOOK ENGINE
-- ============================================================================

CREATE TABLE IF NOT EXISTS class_assessments (
  id                       TEXT PRIMARY KEY,
  class_id                 TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  -- Assessment Engine (core/academic/lifecycle-engine.ts adjacent — see
  -- routes/classes.routes.ts §3). 'placement_test' is deliberately excluded
  -- — see ADR AM-15 in the Phase 3 report.
  type                     TEXT NOT NULL CHECK (type IN (
                             'midterm','final','assignment','attendance','participation',
                             'quiz','homework','speaking','listening','reading','writing',
                             'practice_test','makeup_exam'
                           )),
  weight                   REAL NOT NULL DEFAULT 0, 
  max_score                REAL NOT NULL DEFAULT 100,
  passing_score            REAL,
  date                     TEXT,
  publish_date             TEXT,
  due_date                 TEXT,
  visibility               TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','scheduled')),
  rubric                   TEXT,
  allows_makeup            INTEGER NOT NULL DEFAULT 0,
  makeup_for_assessment_id TEXT REFERENCES class_assessments(id) ON DELETE SET NULL,
  -- Grade Lock Workflow (Phase 7) — Draft/Submitted/Reviewed/Approved/
  -- Published/Locked, applied per-assessment. See core/academic/
  -- grade-lock-service.ts.
  lock_status              TEXT NOT NULL DEFAULT 'draft' CHECK (lock_status IN ('draft','submitted','reviewed','approved','published','locked')),
  lock_status_updated_at   TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

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



-- ============================================================================
-- AUDIT FAILURE FORENSICS (2026-08-14)
-- ============================================================================
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
CREATE INDEX IF NOT EXISTS idx_audit_failures_time ON audit_failures(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_failures_branch ON audit_failures(branch_id, occurred_at DESC);



CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_insert
BEFORE INSERT ON book_sales
WHEN ABS(NEW.total_amount - ROUND(NEW.total_amount, 2)) > 0.0000001
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_sales_money_scale_update
BEFORE UPDATE OF total_amount, discount_amount, net_amount ON book_sales
WHEN ABS(NEW.total_amount - ROUND(NEW.total_amount, 2)) > 0.0000001
  OR ABS(COALESCE(NEW.discount_amount, 0) - ROUND(COALESCE(NEW.discount_amount, 0), 2)) > 0.0000001
  OR ABS(COALESCE(NEW.net_amount, 0) - ROUND(COALESCE(NEW.net_amount, 0), 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'book sale monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_expense_request_money_scale_insert
BEFORE INSERT ON expense_requests
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'expense amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_insert
BEFORE INSERT ON finance_accounts
WHEN ABS(NEW.main_balance - ROUND(NEW.main_balance, 2)) > 0.0000001
  OR ABS(NEW.saving_balance - ROUND(NEW.saving_balance, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'finance account balances must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_finance_accounts_money_scale_update
BEFORE UPDATE OF main_balance, saving_balance ON finance_accounts
WHEN ABS(NEW.main_balance - ROUND(NEW.main_balance, 2)) > 0.0000001
  OR ABS(NEW.saving_balance - ROUND(NEW.saving_balance, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'finance account balances must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_teacher_salary_money_scale_insert
BEFORE INSERT ON teacher_salary_ledger
WHEN ABS(NEW.due_amount - ROUND(NEW.due_amount, 2)) > 0.0000001
  OR ABS(NEW.paid_amount - ROUND(NEW.paid_amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'teacher salary monetary values must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_donations_money_scale_insert
BEFORE INSERT ON donations
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'donation amount must have at most two decimal places'); END;

CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_money_scale_insert
BEFORE INSERT ON scholarship_awards
WHEN ABS(NEW.amount - ROUND(NEW.amount, 2)) > 0.0000001
BEGIN SELECT RAISE(ABORT, 'scholarship amount must have at most two decimal places'); END;
