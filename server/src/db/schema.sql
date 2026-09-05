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
  linked_teacher_id    TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  linked_employee_id   TEXT REFERENCES employees(id) ON DELETE SET NULL,
  linked_partner_id    TEXT REFERENCES partners(id) ON DELETE SET NULL,
  linked_student_id    TEXT REFERENCES students(id) ON DELETE SET NULL,
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  session_version      INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_branch         ON users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_campus         ON users(campus_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linked_student ON users(linked_student_id) WHERE linked_student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linked_teacher ON users(linked_teacher_id) WHERE linked_teacher_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linked_employee ON users(linked_employee_id) WHERE linked_employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linked_partner ON users(linked_partner_id) WHERE linked_partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS roles ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, 
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT 
);
CREATE INDEX IF NOT EXISTS idx_roles_code            ON roles(code);

CREATE TABLE IF NOT EXISTS permissions ( 
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, resource TEXT NOT NULL, action TEXT NOT NULL, 
  description TEXT, category TEXT NOT NULL DEFAULT 'general', is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
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
  scope_id TEXT, is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)), assigned_by TEXT,
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

CREATE TABLE IF NOT EXISTS employees ( 
  id          TEXT PRIMARY KEY, 
  full_name   TEXT NOT NULL, 
  phone       TEXT, 
  email       TEXT, 
  role        TEXT NOT NULL, 
  base_salary INTEGER NOT NULL DEFAULT 0, 
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')), 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  joined_date TEXT NOT NULL
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
  card_design             TEXT, 
  created_at              TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_students_branch       ON students(branch_id);
CREATE INDEX IF NOT EXISTS idx_students_code         ON students(student_code);
CREATE INDEX IF NOT EXISTS idx_students_household ON students(household_id);
CREATE INDEX IF NOT EXISTS idx_students_lead         ON students(lead_id);
CREATE INDEX IF NOT EXISTS idx_students_status       ON students(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email ON students(email) WHERE email IS NOT NULL AND email != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_email_normalized
  ON students(lower(trim(email))) WHERE email IS NOT NULL AND trim(email) != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_lead_id ON students(lead_id) WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone ON students(phone) WHERE phone IS NOT NULL AND phone != '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_phone_normalized
  ON students (
    SUBSTR(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', ''),
      -9
    )
  )
  WHERE phone IS NOT NULL
    AND TRIM(phone) <> ''
    AND LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '')) >= 7;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_tazkira_no ON students(tazkira_no) WHERE tazkira_no IS NOT NULL AND tazkira_no != '';
CREATE TRIGGER IF NOT EXISTS trg_students_phone_syntax_insert
BEFORE INSERT ON students
WHEN NEW.phone IS NOT NULL AND trim(NEW.phone) <> '' AND (
  LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(NEW.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '')) < 7
  OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(NEW.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '') GLOB '*[^0-9]*'
)
BEGIN SELECT RAISE(ABORT, 'invalid student phone'); END;
CREATE TRIGGER IF NOT EXISTS trg_students_phone_syntax_update
BEFORE UPDATE OF phone ON students
WHEN NEW.phone IS NOT NULL AND trim(NEW.phone) <> '' AND (
  LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(NEW.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '')) < 7
  OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(NEW.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '') GLOB '*[^0-9]*'
)
BEGIN SELECT RAISE(ABORT, 'invalid student phone'); END;
CREATE TRIGGER IF NOT EXISTS trg_students_tazkira_visitor_guard_insert
BEFORE INSERT ON students
WHEN NEW.tazkira_no IS NOT NULL AND trim(NEW.tazkira_no) <> '' AND EXISTS (
  SELECT 1 FROM visitors v WHERE v.tazkira_no = NEW.tazkira_no AND (NEW.lead_id IS NULL OR v.id <> NEW.lead_id)
)
BEGIN SELECT RAISE(ABORT, 'student Tazkira conflicts with visitor'); END;
CREATE TRIGGER IF NOT EXISTS trg_students_tazkira_visitor_guard_update
BEFORE UPDATE OF tazkira_no, lead_id ON students
WHEN NEW.tazkira_no IS NOT NULL AND trim(NEW.tazkira_no) <> '' AND EXISTS (
  SELECT 1 FROM visitors v WHERE v.tazkira_no = NEW.tazkira_no AND (NEW.lead_id IS NULL OR v.id <> NEW.lead_id)
)
BEGIN SELECT RAISE(ABORT, 'student Tazkira conflicts with visitor'); END;
CREATE TRIGGER IF NOT EXISTS trg_visitors_tazkira_student_guard_insert
BEFORE INSERT ON visitors
WHEN NEW.tazkira_no IS NOT NULL AND trim(NEW.tazkira_no) <> '' AND EXISTS (
  SELECT 1 FROM students s WHERE s.tazkira_no = NEW.tazkira_no AND (s.lead_id IS NULL OR s.lead_id <> NEW.id)
)
BEGIN SELECT RAISE(ABORT, 'visitor Tazkira conflicts with student'); END;
CREATE TRIGGER IF NOT EXISTS trg_visitors_tazkira_student_guard_update
BEFORE UPDATE OF tazkira_no ON visitors
WHEN NEW.tazkira_no IS NOT NULL AND trim(NEW.tazkira_no) <> '' AND EXISTS (
  SELECT 1 FROM students s WHERE s.tazkira_no = NEW.tazkira_no AND (s.lead_id IS NULL OR s.lead_id <> NEW.id)
)
BEGIN SELECT RAISE(ABORT, 'visitor Tazkira conflicts with student'); END;

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

-- Exact semester restoration for whole-student suspension. A batch records the
-- rows this workflow actually deferred, so resume cannot reactivate unrelated
-- historical semesters that happened to share the same class.
CREATE TABLE IF NOT EXISTS student_suspension_batches (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  suspended_at TEXT NOT NULL DEFAULT (datetime('now')),
  resumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_student_suspension_batches_open
  ON student_suspension_batches(student_id, resumed_at, suspended_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_suspension_batches_one_open
  ON student_suspension_batches(student_id) WHERE resumed_at IS NULL;
CREATE TABLE IF NOT EXISTS student_suspension_semesters (
  batch_id          TEXT NOT NULL REFERENCES student_suspension_batches(id) ON DELETE CASCADE,
  semester_id       TEXT NOT NULL REFERENCES student_semesters(id) ON DELETE CASCADE,
  original_class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  PRIMARY KEY (batch_id, semester_id)
);

-- A registration is an EVENT document: who registered, where, when, through
-- which surface. It deliberately carries NO money columns: cash collected is a
-- fact of `payments` + `obligation_allocations`, discounts granted are a fact
-- of `invoices.discount_amount`, and a second copy of either on this table
-- would be a free-to-drift duplicate of an authority (the removed
-- amount_paid/receipt_number/discount_applied columns were written as 0/NULL/0
-- by every production writer while the dashboard summed discount_applied as
-- "registration discounts granted" — a permanently understated figure).
CREATE TABLE IF NOT EXISTS registrations ( 
  id               TEXT PRIMARY KEY, 
  student_id       TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  class_id         TEXT REFERENCES classes(id) ON DELETE SET NULL, 
  date             TEXT NOT NULL, 
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
  pass_score REAL NOT NULL DEFAULT 0 CHECK (pass_score >= 0 AND pass_score <= 120),
  instructions TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1 AND version = CAST(version AS INTEGER)),
  requirement_mode TEXT NOT NULL DEFAULT 'required' CHECK (requirement_mode IN ('required','optional','not_required')),
  first_level_exempt INTEGER NOT NULL DEFAULT 0 CHECK (first_level_exempt IN (0,1) AND (first_level_exempt = 0 OR requirement_mode = 'required')),
  expires_minutes INTEGER CHECK (expires_minutes IS NULL OR (expires_minutes >= 1 AND expires_minutes <= 525600 AND expires_minutes = CAST(expires_minutes AS INTEGER))),
  decision_rules_json TEXT CHECK (decision_rules_json IS NULL OR (json_valid(decision_rules_json) AND json_type(decision_rules_json) = 'array')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  components_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(components_json) AND json_type(components_json) = 'array'),
  scoring_model TEXT NOT NULL DEFAULT 'canonical' CHECK (scoring_model IN ('canonical')),
  allow_retake INTEGER NOT NULL DEFAULT 1 CHECK (allow_retake IN (0,1)),
  max_attempts INTEGER CHECK (max_attempts IS NULL OR (max_attempts >= 1 AND max_attempts <= 100 AND max_attempts = CAST(max_attempts AS INTEGER))),
  first_attempt_billable INTEGER NOT NULL DEFAULT 1 CHECK (first_attempt_billable IN (0,1)),
  retake_billable INTEGER NOT NULL DEFAULT 0 CHECK (retake_billable IN (0,1)),
  retake_fee_amount REAL CHECK (
    retake_fee_amount IS NULL OR
    (retake_fee_amount >= 0 AND retake_fee_amount = CAST(retake_fee_amount AS INTEGER))
  ),
  UNIQUE(program_version_id, branch_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_profile_program_branch
  ON placement_assessment_profiles(program_version_id, branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_profile_global
  ON placement_assessment_profiles(program_version_id) WHERE branch_id IS NULL;

CREATE TABLE IF NOT EXISTS placement_tests (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  test_type     TEXT NOT NULL CHECK (test_type IN ('grammar','listening','reading','writing','speaking')),
  instructions  TEXT,
  audio_url     TEXT,
  transcript    TEXT,
  passage       TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL, -- NULL = global
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  difficulty    TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds = CAST(duration_seconds AS INTEGER))),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1 AND version = CAST(version AS INTEGER)),
  rubric_id     TEXT REFERENCES placement_rubrics(id) ON DELETE SET NULL,
  word_target   INTEGER CHECK (word_target IS NULL OR (word_target > 0 AND word_target = CAST(word_target AS INTEGER))),
  content_json  TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
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
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds = CAST(duration_seconds AS INTEGER))),
  order_index      INTEGER NOT NULL DEFAULT 0 CHECK (order_index >= 0 AND order_index = CAST(order_index AS INTEGER)),
  UNIQUE(test_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_sections_test ON placement_test_sections(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_test_questions (
  id           TEXT PRIMARY KEY,
  test_id      TEXT NOT NULL REFERENCES placement_tests(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  qtype        TEXT NOT NULL CHECK (qtype IN ('mcq','short_answer','fill_blank','sentence_completion','error_identification','essay','speaking')),
  prompt       TEXT NOT NULL,
  options_json TEXT CHECK (options_json IS NULL OR (json_valid(options_json) AND json_type(options_json) = 'array')),
  answer_key   TEXT,
  points       REAL NOT NULL DEFAULT 1 CHECK (points > 0),
  order_index  INTEGER NOT NULL DEFAULT 0 CHECK (order_index >= 0 AND order_index = CAST(order_index AS INTEGER)),
  difficulty   TEXT,
  section_key  TEXT,
  cefr_level   TEXT CHECK (cefr_level IS NULL OR cefr_level IN ('A1','A2','B1','B2','C1')),
  topic        TEXT,
  subskill     TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN ('draft','reviewed','approved','active','retired')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1 AND version = CAST(version AS INTEGER)),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TEXT,
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  UNIQUE(test_id, question_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_questions_test ON placement_test_questions(test_id, order_index);

CREATE TABLE IF NOT EXISTS placement_rubrics (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('writing','speaking')),
  criteria_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json) AND json_type(criteria_json) = 'array'),
  branch_id     TEXT REFERENCES branches(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1 AND version = CAST(version AS INTEGER)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS placement_media (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400 AND size_bytes = CAST(size_bytes AS INTEGER)),
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
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number = CAST(attempt_number AS INTEGER)),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','paused','completed','expired','cancelled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  total_score REAL CHECK (total_score IS NULL OR total_score >= 0),
  max_score REAL CHECK (max_score IS NULL OR max_score > 0),
  percentage REAL CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  recommended_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  recommendation_text TEXT,
  examiner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1 AND policy_version = CAST(policy_version AS INTEGER)),
  decision_rule_id TEXT,
  override_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  override_reason TEXT,
  override_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  override_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('passed', 'failed')),
  delivery_mode TEXT NOT NULL DEFAULT 'DIGITAL' CHECK (delivery_mode IN ('DIGITAL','PHYSICAL')),
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
  -- Test/question identifiers refer to immutable objects captured in the
  -- attempt snapshot. They deliberately do not reference mutable bank rows.
  test_id       TEXT NOT NULL,
  question_id   TEXT NOT NULL,
  question_key  TEXT NOT NULL,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  auto_score    REAL CHECK (auto_score IS NULL OR (auto_score >= 0 AND auto_score <= max_points)),
  max_points    REAL NOT NULL DEFAULT 1 CHECK (max_points > 0),
  feedback      TEXT,
  answered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_placement_responses_attempt ON placement_assessment_responses(attempt_id, question_id);

CREATE TABLE IF NOT EXISTS placement_assessment_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES placement_assessment_attempts(id) ON DELETE CASCADE,
  component_key TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('grammar','reading','listening','writing','speaking')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','waived','timed_out')),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= max_score)),
  max_score REAL NOT NULL DEFAULT 100 CHECK (max_score > 0),
  weight REAL NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 100),
  selected_level_id TEXT REFERENCES levels(id) ON DELETE SET NULL,
  notes TEXT,
  result_text TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  evaluator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_score REAL CHECK (raw_score IS NULL OR raw_score >= 0),
  percentage REAL CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  weighted_score REAL CHECK (weighted_score IS NULL OR (weighted_score >= 0 AND weighted_score <= weight)),
  score_version INTEGER NOT NULL DEFAULT 1 CHECK (score_version >= 1 AND score_version = CAST(score_version AS INTEGER)),
  correction_reason TEXT,
  corrected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  corrected_at TEXT,
  started_at TEXT,
  deadline_at TEXT,
  submitted_at TEXT,
  elapsed_seconds INTEGER CHECK (elapsed_seconds IS NULL OR (elapsed_seconds >= 0 AND elapsed_seconds = CAST(elapsed_seconds AS INTEGER))),
  timeout_flag INTEGER NOT NULL DEFAULT 0 CHECK (timeout_flag IN (0,1)),
  paused_at TEXT,
  cefr_level TEXT CHECK (cefr_level IS NULL OR cefr_level IN ('A1','A2','B1','B2','C1')),
  cefr_evidence_json TEXT CHECK (cefr_evidence_json IS NULL OR json_valid(cefr_evidence_json)),
  UNIQUE(attempt_id, component_key)
);
CREATE INDEX IF NOT EXISTS idx_placement_results_attempt ON placement_assessment_results(attempt_id, status);

-- Placement integrity is correlated to the immutable attempt snapshot and the
-- attempt's program/branch, not to mutable bank or caller-selected objects.
CREATE TRIGGER IF NOT EXISTS trg_placement_test_rubric_scope_insert
BEFORE INSERT ON placement_tests
WHEN NEW.rubric_id IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM placement_rubrics r
   WHERE r.id = NEW.rubric_id
     AND ((r.branch_id IS NOT NULL AND r.branch_id IS NOT NEW.branch_id)
       OR NOT ((NEW.test_type = 'writing' AND r.kind = 'writing')
            OR (NEW.test_type = 'speaking' AND r.kind = 'speaking')))
 )
BEGIN SELECT RAISE(ABORT, 'placement test rubric scope or kind mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_test_rubric_scope_update
BEFORE UPDATE OF rubric_id, branch_id, test_type ON placement_tests
WHEN NEW.rubric_id IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM placement_rubrics r
   WHERE r.id = NEW.rubric_id
     AND ((r.branch_id IS NOT NULL AND r.branch_id IS NOT NEW.branch_id)
       OR NOT ((NEW.test_type = 'writing' AND r.kind = 'writing')
            OR (NEW.test_type = 'speaking' AND r.kind = 'speaking')))
 )
BEGIN SELECT RAISE(ABORT, 'placement test rubric scope or kind mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_rubric_kind_scope_update
BEFORE UPDATE OF kind ON placement_rubrics
WHEN EXISTS (
  SELECT 1 FROM placement_tests t
  WHERE t.rubric_id = NEW.id
    AND NOT ((t.test_type = 'writing' AND NEW.kind = 'writing')
          OR (t.test_type = 'speaking' AND NEW.kind = 'speaking'))
)
BEGIN SELECT RAISE(ABORT, 'placement rubric kind conflicts with linked tests'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_attempt_scope_insert
BEFORE INSERT ON placement_assessment_attempts
WHEN (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id
   OR (SELECT program_version_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.program_version_id
   OR (SELECT program_version_id FROM placement_assessment_profiles WHERE id = NEW.profile_id) IS NOT NEW.program_version_id
   OR EXISTS (
     SELECT 1 FROM placement_assessment_profiles profile
     JOIN program_versions pv ON pv.id = NEW.program_version_id
     JOIN programs program ON program.id = pv.program_id
     WHERE profile.id = NEW.profile_id
       AND profile.branch_id IS NOT NULL
       AND profile.branch_id IS NOT NEW.branch_id
       AND profile.branch_id IS NOT program.branch_id
   )
BEGIN SELECT RAISE(ABORT, 'placement attempt scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_attempt_scope_update
BEFORE UPDATE OF visitor_id, program_version_id, profile_id, branch_id ON placement_assessment_attempts
WHEN (SELECT branch_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.branch_id
   OR (SELECT program_version_id FROM visitors WHERE id = NEW.visitor_id) IS NOT NEW.program_version_id
   OR (SELECT program_version_id FROM placement_assessment_profiles WHERE id = NEW.profile_id) IS NOT NEW.program_version_id
   OR EXISTS (
     SELECT 1 FROM placement_assessment_profiles profile
     JOIN program_versions pv ON pv.id = NEW.program_version_id
     JOIN programs program ON program.id = pv.program_id
     WHERE profile.id = NEW.profile_id
       AND profile.branch_id IS NOT NULL
       AND profile.branch_id IS NOT NEW.branch_id
       AND profile.branch_id IS NOT program.branch_id
   )
BEGIN SELECT RAISE(ABORT, 'placement attempt scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_response_snapshot_insert
BEFORE INSERT ON placement_assessment_responses
WHEN NOT EXISTS (
  SELECT 1
  FROM placement_assessment_attempts a,
       json_each(json_extract(a.snapshot_json, '$.tests')) snapshot_test,
       json_each(json_extract(snapshot_test.value, '$.questions')) snapshot_question
  WHERE a.id = NEW.attempt_id
    AND json_extract(snapshot_test.value, '$.id') = NEW.test_id
    AND json_extract(snapshot_question.value, '$.id') = NEW.question_id
)
BEGIN SELECT RAISE(ABORT, 'placement response is not in the attempt snapshot'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_response_snapshot_update
BEFORE UPDATE OF attempt_id, test_id, question_id ON placement_assessment_responses
WHEN NOT EXISTS (
  SELECT 1
  FROM placement_assessment_attempts a,
       json_each(json_extract(a.snapshot_json, '$.tests')) snapshot_test,
       json_each(json_extract(snapshot_test.value, '$.questions')) snapshot_question
  WHERE a.id = NEW.attempt_id
    AND json_extract(snapshot_test.value, '$.id') = NEW.test_id
    AND json_extract(snapshot_question.value, '$.id') = NEW.question_id
)
BEGIN SELECT RAISE(ABORT, 'placement response is not in the attempt snapshot'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_result_snapshot_insert
BEFORE INSERT ON placement_assessment_results
WHEN NOT EXISTS (
  SELECT 1
  FROM placement_assessment_attempts a,
       json_each(json_extract(a.snapshot_json, '$.components')) component
  WHERE a.id = NEW.attempt_id
    AND json_extract(component.value, '$.key') = NEW.component_key
)
BEGIN SELECT RAISE(ABORT, 'placement result is not in the attempt snapshot'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_result_snapshot_update
BEFORE UPDATE OF attempt_id, component_key ON placement_assessment_results
WHEN NOT EXISTS (
  SELECT 1
  FROM placement_assessment_attempts a,
       json_each(json_extract(a.snapshot_json, '$.components')) component
  WHERE a.id = NEW.attempt_id
    AND json_extract(component.value, '$.key') = NEW.component_key
)
BEGIN SELECT RAISE(ABORT, 'placement result is not in the attempt snapshot'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_result_level_scope_insert
BEFORE INSERT ON placement_assessment_results
WHEN NEW.selected_level_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM levels l
   JOIN program_versions pv ON pv.program_id = l.program_id
   JOIN placement_assessment_attempts a ON a.program_version_id = pv.id
   WHERE a.id = NEW.attempt_id AND l.id = NEW.selected_level_id
 )
BEGIN SELECT RAISE(ABORT, 'placement result level program mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_result_level_scope_update
BEFORE UPDATE OF selected_level_id, attempt_id ON placement_assessment_results
WHEN NEW.selected_level_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM levels l
   JOIN program_versions pv ON pv.program_id = l.program_id
   JOIN placement_assessment_attempts a ON a.program_version_id = pv.id
   WHERE a.id = NEW.attempt_id AND l.id = NEW.selected_level_id
 )
BEGIN SELECT RAISE(ABORT, 'placement result level program mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_placement_attempt_level_scope_update
BEFORE UPDATE OF recommended_level_id, override_level_id ON placement_assessment_attempts
WHEN (NEW.recommended_level_id IS NOT NULL OR NEW.override_level_id IS NOT NULL)
 AND EXISTS (
   SELECT 1
   FROM (SELECT NEW.recommended_level_id AS level_id UNION ALL SELECT NEW.override_level_id) selected
   WHERE selected.level_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM levels l
       JOIN program_versions pv ON pv.program_id = l.program_id
       WHERE pv.id = NEW.program_version_id AND l.id = selected.level_id
     )
 )
BEGIN SELECT RAISE(ABORT, 'placement recommendation level program mismatch'); END;

-- ============================================================================
-- ACADEMIC STRUCTURE
-- ============================================================================
-- The catalogue: what can be taught, by whom, where and when.

CREATE TABLE IF NOT EXISTS programs ( 
  id              TEXT PRIMARY KEY, 
  name            TEXT NOT NULL, 
  description     TEXT, 
  duration_months INTEGER NOT NULL DEFAULT 0 CHECK (typeof(duration_months) = 'integer' AND duration_months >= 0),
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  organization_id TEXT, 
  code            TEXT, 
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_programs_branch       ON programs(branch_id);

CREATE TABLE IF NOT EXISTS program_versions ( 
  id                TEXT PRIMARY KEY, 
  program_id        TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, 
  version_label     TEXT NOT NULL, 
  version_number    INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version_number) = 'integer' AND version_number >= 1),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')), 
  effective_from    TEXT CHECK (effective_from IS NULL OR (date(effective_from) IS NOT NULL AND date(effective_from) = effective_from)),
  effective_to      TEXT CHECK (effective_to IS NULL OR (date(effective_to) IS NOT NULL AND date(effective_to) = effective_to)),
  duration_months   INTEGER NOT NULL DEFAULT 0 CHECK (typeof(duration_months) = 'integer' AND duration_months >= 0),
  description       TEXT, 
  is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
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
  hours               INTEGER NOT NULL DEFAULT 0 CHECK (typeof(hours) = 'integer' AND hours >= 0),
  sort_order          INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
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
  hours           INTEGER NOT NULL DEFAULT 0 CHECK (typeof(hours) = 'integer' AND hours >= 0),
  sort_order      INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  assessment_type TEXT DEFAULT 'continuous', 
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(subject_id, code) 
);
CREATE INDEX IF NOT EXISTS idx_modules_subject           ON modules(subject_id);

CREATE TABLE IF NOT EXISTS levels ( 
  id                  TEXT PRIMARY KEY, 
  program_id          TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, 
  name                TEXT NOT NULL, 
  "order"             INTEGER NOT NULL DEFAULT 1 CHECK (typeof("order") = 'integer' AND "order" >= 1),
  prerequisites       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prerequisites) AND json_type(prerequisites) = 'array'),
  program_version_id  TEXT REFERENCES program_versions(id) ON DELETE SET NULL,
  code                TEXT, 
  duration_months     INTEGER NOT NULL DEFAULT 0 CHECK (typeof(duration_months) = 'integer' AND duration_months >= 0),
  default_fee         INTEGER NOT NULL DEFAULT 0 CHECK (typeof(default_fee) = 'integer' AND default_fee >= 0),
  pass_mark           REAL NOT NULL DEFAULT 60 CHECK (typeof(pass_mark) IN ('integer','real') AND pass_mark >= 0 AND pass_mark <= 100),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  min_viable_size     INTEGER NOT NULL DEFAULT 5 CHECK (typeof(min_viable_size) = 'integer' AND min_viable_size >= 0),
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
  year        INTEGER NOT NULL CHECK (typeof(year) = 'integer' AND year >= 1),
  code        TEXT NOT NULL, 
  name        TEXT NOT NULL, 
  start_date  TEXT CHECK (start_date IS NULL OR date(start_date) IS NOT NULL AND date(start_date) = start_date),
  end_date    TEXT CHECK (end_date IS NULL OR date(end_date) IS NOT NULL AND date(end_date) = end_date),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, year, code),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_academic_terms_branch ON academic_terms(branch_id, year);

CREATE TABLE IF NOT EXISTS time_slots ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  code        TEXT NOT NULL, 
  label       TEXT NOT NULL, 
  start_time  TEXT NOT NULL CHECK (length(start_time) = 5 AND time(start_time) IS NOT NULL),
  end_time    TEXT NOT NULL CHECK (length(end_time) = 5 AND time(end_time) IS NOT NULL AND end_time > start_time),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, code) 
);
CREATE INDEX IF NOT EXISTS idx_time_slots_branch     ON time_slots(branch_id, is_active);

CREATE TABLE IF NOT EXISTS rooms ( 
  id          TEXT PRIMARY KEY, 
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE, 
  code        TEXT NOT NULL, 
  name        TEXT NOT NULL, 
  capacity    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(capacity) = 'integer' AND capacity >= 0),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes       TEXT, 
  created_at  TEXT NOT NULL DEFAULT (datetime('now')), 
  UNIQUE(branch_id, code) 
);
CREATE INDEX IF NOT EXISTS idx_rooms_branch          ON rooms(branch_id, is_active);

CREATE TABLE IF NOT EXISTS course_offerings ( 
  id                  TEXT PRIMARY KEY, 
  program_id          TEXT NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  program_version_id  TEXT NOT NULL REFERENCES program_versions(id) ON DELETE RESTRICT,
  level_id            TEXT NOT NULL REFERENCES levels(id) ON DELETE RESTRICT,
  branch_id           TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  academic_term_id    TEXT NOT NULL REFERENCES academic_terms(id) ON DELETE RESTRICT,
  code                TEXT, 
  name                TEXT NOT NULL, 
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','archived')), 
  fee_snapshot        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(fee_snapshot) = 'integer' AND fee_snapshot >= 0),
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
  capacity             INTEGER NOT NULL DEFAULT 0 CHECK (typeof(capacity) = 'integer' AND capacity >= 0),
  min_viable_size      INTEGER NOT NULL DEFAULT 0 CHECK (typeof(min_viable_size) = 'integer' AND min_viable_size >= 0 AND (capacity = 0 OR min_viable_size <= capacity)),
  schedule_time        TEXT,
  start_date           TEXT CHECK (start_date IS NULL OR date(start_date) IS NOT NULL AND date(start_date) = start_date),
  end_date             TEXT CHECK (end_date IS NULL OR date(end_date) IS NOT NULL AND date(end_date) = end_date AND (start_date IS NULL OR end_date >= start_date)),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  lifecycle_stage      TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_stage IN (
                         'draft','scheduled','enrollment_open','enrollment_closed',
                         'activated','in_progress','suspended','grading',
                         'completed','archived','cancelled'
                       )),
  lifecycle_updated_at TEXT,
  cancellation_reason  TEXT,
  fee                  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(fee) = 'integer' AND fee >= 0),
  branch_id            TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  gender_policy        TEXT NOT NULL DEFAULT 'mixed' CHECK (gender_policy IN ('female','male','mixed')),
  room_id              TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  time_slot_id         TEXT REFERENCES time_slots(id) ON DELETE SET NULL,
  academic_term_id     TEXT REFERENCES academic_terms(id) ON DELETE SET NULL,
  activation_date      TEXT CHECK (activation_date IS NULL OR date(activation_date) IS NOT NULL AND date(activation_date) = activation_date),
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

-- Curriculum identifiers are one ownership graph, not independently valid
-- foreign keys. These guards protect direct writers as well as HTTP routes.
CREATE TRIGGER IF NOT EXISTS trg_levels_version_program_insert
BEFORE INSERT ON levels
WHEN NEW.program_version_id IS NOT NULL
 AND (SELECT program_id FROM program_versions WHERE id = NEW.program_version_id) IS NOT NEW.program_id
BEGIN SELECT RAISE(ABORT, 'level program version mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_levels_version_program_update
BEFORE UPDATE OF program_id, program_version_id ON levels
WHEN NEW.program_version_id IS NOT NULL
 AND (SELECT program_id FROM program_versions WHERE id = NEW.program_version_id) IS NOT NEW.program_id
BEGIN SELECT RAISE(ABORT, 'level program version mismatch'); END;

-- `levels.prerequisites` is a real curriculum graph even though its compact
-- representation is JSON. Every edge must resolve inside the same program;
-- two explicitly versioned endpoints must share one version. Common
-- (unversioned) levels may be reused by a version of their own program.
CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_integrity_insert
BEFORE INSERT ON levels
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.prerequisites) edge
  LEFT JOIN levels prerequisite ON prerequisite.id = edge.value
  WHERE edge.type <> 'text' OR edge.value <> trim(edge.value) OR edge.value = ''
     OR prerequisite.id IS NULL OR prerequisite.id = NEW.id
     OR prerequisite.program_id IS NOT NEW.program_id
     OR (NEW.program_version_id IS NOT NULL
       AND prerequisite.program_version_id IS NOT NULL
       AND prerequisite.program_version_id IS NOT NEW.program_version_id)
) OR (SELECT COUNT(*) FROM json_each(NEW.prerequisites)) <>
     (SELECT COUNT(DISTINCT value) FROM json_each(NEW.prerequisites))
BEGIN SELECT RAISE(ABORT, 'level prerequisite ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_integrity_update
BEFORE UPDATE OF prerequisites, program_id, program_version_id ON levels
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.prerequisites) edge
  LEFT JOIN levels prerequisite ON prerequisite.id = edge.value
  WHERE edge.type <> 'text' OR edge.value <> trim(edge.value) OR edge.value = ''
     OR prerequisite.id IS NULL OR prerequisite.id = NEW.id
     OR prerequisite.program_id IS NOT NEW.program_id
     OR (NEW.program_version_id IS NOT NULL
       AND prerequisite.program_version_id IS NOT NULL
       AND prerequisite.program_version_id IS NOT NEW.program_version_id)
) OR (SELECT COUNT(*) FROM json_each(NEW.prerequisites)) <>
     (SELECT COUNT(DISTINCT value) FROM json_each(NEW.prerequisites))
BEGIN SELECT RAISE(ABORT, 'level prerequisite ownership mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_cycle_insert
BEFORE INSERT ON levels
WHEN EXISTS (
  WITH RECURSIVE dependency(level_id) AS (
    SELECT value FROM json_each(NEW.prerequisites)
    UNION
    SELECT nested.value
    FROM dependency current
    JOIN levels prerequisite ON prerequisite.id = current.level_id
    JOIN json_each(prerequisite.prerequisites) nested
  )
  SELECT 1 FROM dependency WHERE level_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'level prerequisite cycle'); END;
CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_cycle_update
BEFORE UPDATE OF prerequisites ON levels
WHEN EXISTS (
  WITH RECURSIVE dependency(level_id) AS (
    SELECT value FROM json_each(NEW.prerequisites)
    UNION
    SELECT nested.value
    FROM dependency current
    JOIN levels prerequisite ON prerequisite.id = current.level_id
    JOIN json_each(prerequisite.prerequisites) nested
  )
  SELECT 1 FROM dependency WHERE level_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'level prerequisite cycle'); END;

-- Updating or deleting a prerequisite endpoint must not strand inbound edges.
CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_inbound_update
BEFORE UPDATE OF program_id, program_version_id ON levels
WHEN EXISTS (
  SELECT 1
  FROM levels dependent, json_each(dependent.prerequisites) edge
  WHERE dependent.id <> OLD.id AND edge.type = 'text' AND edge.value = OLD.id
    AND (dependent.program_id IS NOT NEW.program_id
      OR (dependent.program_version_id IS NOT NULL
        AND NEW.program_version_id IS NOT NULL
        AND dependent.program_version_id IS NOT NEW.program_version_id))
)
BEGIN SELECT RAISE(ABORT, 'level prerequisite inbound ownership mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_levels_prerequisites_delete
BEFORE DELETE ON levels
WHEN EXISTS (
  SELECT 1 FROM levels dependent, json_each(dependent.prerequisites) edge
  WHERE dependent.id <> OLD.id AND edge.type = 'text' AND edge.value = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'level is required by another level'); END;

CREATE TRIGGER IF NOT EXISTS trg_subjects_level_version_insert
BEFORE INSERT ON subjects
WHEN NEW.level_id IS NOT NULL
 AND (SELECT program_version_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_version_id
BEGIN SELECT RAISE(ABORT, 'subject level program version mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_subjects_level_version_update
BEFORE UPDATE OF program_version_id, level_id ON subjects
WHEN NEW.level_id IS NOT NULL
 AND (SELECT program_version_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_version_id
BEGIN SELECT RAISE(ABORT, 'subject level program version mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_offerings_scope_insert
BEFORE INSERT ON course_offerings
WHEN (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id
 OR (SELECT program_id FROM program_versions WHERE id = NEW.program_version_id) IS NOT NEW.program_id
 OR (SELECT program_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_id
 OR (SELECT program_version_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_version_id
 OR (SELECT branch_id FROM academic_terms WHERE id = NEW.academic_term_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'offering curriculum scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_offerings_scope_update
BEFORE UPDATE OF program_id, program_version_id, level_id, branch_id, academic_term_id ON course_offerings
WHEN (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id
 OR (SELECT program_id FROM program_versions WHERE id = NEW.program_version_id) IS NOT NEW.program_id
 OR (SELECT program_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_id
 OR (SELECT program_version_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_version_id
 OR (SELECT branch_id FROM academic_terms WHERE id = NEW.academic_term_id) IS NOT NEW.branch_id
 OR EXISTS (
   SELECT 1 FROM classes c LEFT JOIN levels l ON l.id = c.level_id
   WHERE c.offering_id = OLD.id
    AND (c.branch_id IS NOT NEW.branch_id OR c.program_id IS NOT NEW.program_id
      OR c.level_id IS NOT NEW.level_id OR c.academic_term_id IS NOT NEW.academic_term_id
      OR l.program_version_id IS NOT NEW.program_version_id)
 )
BEGIN SELECT RAISE(ABORT, 'offering curriculum scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_classes_integrity_insert
BEFORE INSERT ON classes
WHEN ((NEW.program_id IS NULL) <> (NEW.level_id IS NULL))
 OR (NEW.program_id IS NOT NULL AND (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id)
 OR (NEW.level_id IS NOT NULL AND ((SELECT program_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_id))
 OR (NEW.teacher_id IS NOT NULL AND ((SELECT branch_id FROM teachers WHERE id = NEW.teacher_id) IS NOT NEW.branch_id OR (SELECT status FROM teachers WHERE id = NEW.teacher_id) <> 'active'))
 OR (NEW.room_id IS NOT NULL AND (SELECT branch_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.branch_id)
 OR (NEW.time_slot_id IS NOT NULL AND (SELECT branch_id FROM time_slots WHERE id = NEW.time_slot_id) IS NOT NEW.branch_id)
 OR (NEW.academic_term_id IS NOT NULL AND (SELECT branch_id FROM academic_terms WHERE id = NEW.academic_term_id) IS NOT NEW.branch_id)
 OR (NEW.offering_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM course_offerings o JOIN levels l ON l.id = NEW.level_id
   WHERE o.id = NEW.offering_id AND o.branch_id = NEW.branch_id
    AND o.program_id IS NEW.program_id AND o.level_id IS NEW.level_id
    AND o.academic_term_id IS NEW.academic_term_id
    AND o.program_version_id IS l.program_version_id
 ))
 OR NEW.status IS NOT CASE
   WHEN NEW.lifecycle_stage = 'draft' THEN 'draft'
   WHEN NEW.lifecycle_stage = 'cancelled' THEN 'cancelled'
   WHEN NEW.lifecycle_stage IN ('completed','archived') THEN 'completed'
   ELSE 'active' END
BEGIN SELECT RAISE(ABORT, 'class academic integrity mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_classes_integrity_update
BEFORE UPDATE OF teacher_id, program_id, level_id, branch_id, room_id, time_slot_id, academic_term_id, offering_id, status, lifecycle_stage ON classes
WHEN ((NEW.program_id IS NULL) <> (NEW.level_id IS NULL))
 OR (NEW.program_id IS NOT NULL AND (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id)
 OR (NEW.level_id IS NOT NULL AND ((SELECT program_id FROM levels WHERE id = NEW.level_id) IS NOT NEW.program_id))
 OR (NEW.teacher_id IS NOT NULL AND ((SELECT branch_id FROM teachers WHERE id = NEW.teacher_id) IS NOT NEW.branch_id OR (NEW.teacher_id IS NOT OLD.teacher_id AND (SELECT status FROM teachers WHERE id = NEW.teacher_id) <> 'active')))
 OR (NEW.room_id IS NOT NULL AND (SELECT branch_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.branch_id)
 OR (NEW.time_slot_id IS NOT NULL AND (SELECT branch_id FROM time_slots WHERE id = NEW.time_slot_id) IS NOT NEW.branch_id)
 OR (NEW.academic_term_id IS NOT NULL AND (SELECT branch_id FROM academic_terms WHERE id = NEW.academic_term_id) IS NOT NEW.branch_id)
 OR (NEW.offering_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM course_offerings o JOIN levels l ON l.id = NEW.level_id
   WHERE o.id = NEW.offering_id AND o.branch_id = NEW.branch_id
    AND o.program_id IS NEW.program_id AND o.level_id IS NEW.level_id
    AND o.academic_term_id IS NEW.academic_term_id
    AND o.program_version_id IS l.program_version_id
 ))
 OR NEW.status IS NOT CASE
   WHEN NEW.lifecycle_stage = 'draft' THEN 'draft'
   WHEN NEW.lifecycle_stage = 'cancelled' THEN 'cancelled'
   WHEN NEW.lifecycle_stage IN ('completed','archived') THEN 'completed'
   ELSE 'active' END
BEGIN SELECT RAISE(ABORT, 'class academic integrity mismatch'); END;

CREATE TABLE IF NOT EXISTS class_teacher_skills (
  id              TEXT PRIMARY KEY,
  class_id        TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id      TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  monthly_rate    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(monthly_rate) = 'integer' AND monthly_rate >= 0),
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  assignment_type TEXT NOT NULL DEFAULT 'primary' CHECK (assignment_type IN ('primary','assistant','substitute','guest','examiner')),
  start_date      TEXT CHECK (start_date IS NULL OR date(start_date) IS NOT NULL AND date(start_date) = start_date),
  end_date        TEXT CHECK (end_date IS NULL OR date(end_date) IS NOT NULL AND date(end_date) = end_date AND (start_date IS NULL OR end_date >= start_date)),
  reason          TEXT,
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(class_id, teacher_id, skill_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_cts_class ON class_teacher_skills(class_id);
CREATE INDEX IF NOT EXISTS idx_cts_class_skill
ON class_teacher_skills(class_id, skill_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_cts_session ON class_teacher_skills(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cts_class_scoped
ON class_teacher_skills(class_id, teacher_id, skill_id) WHERE session_id IS NULL;
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
  base_salary        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(base_salary) = 'integer' AND base_salary >= 0),
  salary_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (salary_type IN (
                       'fixed','per_skill','per_session','hybrid','per_level'
                     )),
  performance_score  REAL NOT NULL DEFAULT 0 CHECK (typeof(performance_score) IN ('integer','real') AND performance_score >= 0 AND performance_score <= 100),
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
  default_skill_rate INTEGER NOT NULL DEFAULT 0 CHECK (typeof(default_skill_rate) = 'integer' AND default_skill_rate >= 0),
  target_skills_per_month INTEGER NOT NULL DEFAULT 0 CHECK (typeof(target_skills_per_month) = 'integer' AND target_skills_per_month >= 0)
);
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
  date         TEXT NOT NULL CHECK (date(date) IS NOT NULL AND date(date) = date),
  score        REAL NOT NULL CHECK (typeof(score) IN ('integer','real') AND score > 0 AND score <= 100),
  criteria     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(criteria) AND json_type(criteria) = 'object'),
  notes        TEXT, 
  created_at   TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_teacher_eval_teacher  ON teacher_evaluations(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_evaluations_period
ON teacher_evaluations(teacher_id, date, created_at);
CREATE TRIGGER IF NOT EXISTS trg_teacher_performance_evaluation_guard
BEFORE UPDATE OF performance_score ON teachers
WHEN NEW.performance_score IS NOT OLD.performance_score
 AND (
   SELECT evaluation.score
   FROM teacher_evaluations evaluation
   WHERE evaluation.teacher_id = NEW.id
   ORDER BY evaluation.rowid DESC
   LIMIT 1
 ) IS NOT NEW.performance_score
BEGIN SELECT RAISE(ABORT, 'teacher performance score requires latest evaluation provenance'); END;

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
  start_date        TEXT NOT NULL CHECK (date(start_date) IS NOT NULL AND date(start_date) = start_date),
  planned_end_date  TEXT NOT NULL CHECK (date(planned_end_date) IS NOT NULL AND date(planned_end_date) = planned_end_date AND planned_end_date >= start_date),
  actual_end_date   TEXT CHECK (actual_end_date IS NULL OR (date(actual_end_date) IS NOT NULL AND date(actual_end_date) = actual_end_date AND actual_end_date >= start_date)),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')), 
  requested_by      TEXT, 
  approved_by       TEXT, 
  created_at        TEXT NOT NULL DEFAULT (datetime('now')), 
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_efz_enrollment ON enrollment_freezes(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_efz_status ON enrollment_freezes(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_efz_active_enrollment
ON enrollment_freezes(enrollment_id) WHERE status = 'active';
CREATE TRIGGER IF NOT EXISTS trg_enrollment_freezes_scope_insert
BEFORE INSERT ON enrollment_freezes
WHEN (SELECT student_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.student_id
 OR (SELECT branch_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'freeze enrollment scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollment_freezes_scope_update
BEFORE UPDATE OF enrollment_id, student_id, branch_id ON enrollment_freezes
WHEN (SELECT student_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.student_id
 OR (SELECT branch_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'freeze enrollment scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollment_freezes_active_projection_insert
BEFORE INSERT ON enrollment_freezes
WHEN NEW.status = 'active'
 AND (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'frozen'
BEGIN SELECT RAISE(ABORT, 'active freeze requires frozen enrollment'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollment_freezes_active_projection_update
BEFORE UPDATE OF enrollment_id, status ON enrollment_freezes
WHEN NEW.status = 'active'
 AND (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'frozen'
BEGIN SELECT RAISE(ABORT, 'active freeze requires frozen enrollment'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollments_active_freeze_projection_update
BEFORE UPDATE OF status ON enrollments
WHEN OLD.status = 'frozen' AND NEW.status <> 'frozen'
 AND EXISTS (
   SELECT 1 FROM enrollment_freezes
   WHERE enrollment_id = NEW.id AND status = 'active'
 )
BEGIN SELECT RAISE(ABORT, 'active freeze must be completed before enrollment resumes'); END;

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
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'approved' AND new_enrollment_id IS NOT NULL)
    OR (status IN ('pending','rejected','cancelled') AND new_enrollment_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_etr_enrollment ON enrollment_transfer_requests(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_etr_status ON enrollment_transfer_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_etr_pending_enrollment
ON enrollment_transfer_requests(enrollment_id) WHERE status = 'pending';
CREATE TRIGGER IF NOT EXISTS trg_enrollment_transfer_requests_scope_insert
BEFORE INSERT ON enrollment_transfer_requests
WHEN (SELECT student_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.student_id
 OR (SELECT class_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.from_class_id
 OR (SELECT branch_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.branch_id
 OR (SELECT branch_id FROM classes WHERE id = NEW.to_class_id) IS NOT NEW.branch_id
 OR (NEW.status = 'pending' AND (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'active')
 OR (NEW.status = 'approved' AND (
      (SELECT student_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.student_id
      OR (SELECT class_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.to_class_id
      OR (SELECT branch_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.branch_id
      OR (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'transferred'
    ))
BEGIN SELECT RAISE(ABORT, 'transfer request scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_enrollment_transfer_requests_scope_update
BEFORE UPDATE OF enrollment_id, student_id, from_class_id, to_class_id, branch_id, status, new_enrollment_id
ON enrollment_transfer_requests
WHEN (SELECT student_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.student_id
 OR (SELECT class_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.from_class_id
 OR (SELECT branch_id FROM enrollments WHERE id = NEW.enrollment_id) IS NOT NEW.branch_id
 OR (SELECT branch_id FROM classes WHERE id = NEW.to_class_id) IS NOT NEW.branch_id
 OR (NEW.status = 'pending' AND (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'active')
 OR (NEW.status = 'approved' AND (
      (SELECT student_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.student_id
      OR (SELECT class_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.to_class_id
      OR (SELECT branch_id FROM enrollments WHERE id = NEW.new_enrollment_id) IS NOT NEW.branch_id
      OR (SELECT status FROM enrollments WHERE id = NEW.enrollment_id) IS NOT 'transferred'
    ))
BEGIN SELECT RAISE(ABORT, 'transfer request scope mismatch'); END;

CREATE TABLE IF NOT EXISTS class_waitlist ( 
  id            TEXT PRIMARY KEY, 
  class_id      TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, 
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, 
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  position      INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 1),
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

CREATE TRIGGER IF NOT EXISTS trg_cts_scope_insert
BEFORE INSERT ON class_teacher_skills
WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id
 OR (SELECT branch_id FROM teachers WHERE id = NEW.teacher_id) IS NOT NEW.branch_id
 OR (SELECT status FROM teachers WHERE id = NEW.teacher_id) <> 'active'
 OR (NEW.session_id IS NOT NULL AND (
   (SELECT class_id FROM sessions WHERE id = NEW.session_id) IS NOT NEW.class_id
   OR (SELECT branch_id FROM sessions WHERE id = NEW.session_id) IS NOT NEW.branch_id
   OR (NEW.start_date IS NOT NULL AND NEW.start_date > (SELECT date FROM sessions WHERE id = NEW.session_id))
   OR (NEW.end_date IS NOT NULL AND NEW.end_date < (SELECT date FROM sessions WHERE id = NEW.session_id))
 ))
BEGIN SELECT RAISE(ABORT, 'teacher assignment scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_cts_scope_update
BEFORE UPDATE OF class_id, teacher_id, branch_id, session_id, start_date, end_date ON class_teacher_skills
WHEN (SELECT branch_id FROM classes WHERE id = NEW.class_id) IS NOT NEW.branch_id
 OR (SELECT branch_id FROM teachers WHERE id = NEW.teacher_id) IS NOT NEW.branch_id
 OR (NEW.teacher_id IS NOT OLD.teacher_id AND (SELECT status FROM teachers WHERE id = NEW.teacher_id) <> 'active')
 OR (NEW.session_id IS NOT NULL AND (
   (SELECT class_id FROM sessions WHERE id = NEW.session_id) IS NOT NEW.class_id
   OR (SELECT branch_id FROM sessions WHERE id = NEW.session_id) IS NOT NEW.branch_id
   OR (NEW.start_date IS NOT NULL AND NEW.start_date > (SELECT date FROM sessions WHERE id = NEW.session_id))
   OR (NEW.end_date IS NOT NULL AND NEW.end_date < (SELECT date FROM sessions WHERE id = NEW.session_id))
 ))
BEGIN SELECT RAISE(ABORT, 'teacher assignment scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_cts_skill_limit_insert
BEFORE INSERT ON class_teacher_skills
WHEN NEW.assignment_type IN ('primary','assistant')
 AND NOT EXISTS (SELECT 1 FROM class_teacher_skills WHERE class_id = NEW.class_id AND skill_id = NEW.skill_id AND assignment_type IN ('primary','assistant'))
 AND (SELECT COUNT(DISTINCT skill_id) FROM class_teacher_skills WHERE class_id = NEW.class_id AND assignment_type IN ('primary','assistant')) >= 3
BEGIN SELECT RAISE(ABORT, 'class has reached the ongoing skill limit'); END;
CREATE TRIGGER IF NOT EXISTS trg_cts_skill_limit_update
BEFORE UPDATE OF class_id, skill_id, assignment_type ON class_teacher_skills
WHEN NEW.assignment_type IN ('primary','assistant')
 AND NOT EXISTS (SELECT 1 FROM class_teacher_skills WHERE class_id = NEW.class_id AND skill_id = NEW.skill_id AND assignment_type IN ('primary','assistant') AND id <> OLD.id)
 AND (SELECT COUNT(DISTINCT skill_id) FROM class_teacher_skills WHERE class_id = NEW.class_id AND assignment_type IN ('primary','assistant') AND id <> OLD.id) >= 3
BEGIN SELECT RAISE(ABORT, 'class has reached the ongoing skill limit'); END;

CREATE TRIGGER IF NOT EXISTS trg_teachers_inactive_work_guard
BEFORE UPDATE OF status ON teachers
WHEN NEW.status = 'inactive' AND OLD.status <> 'inactive'
 AND (
   EXISTS (SELECT 1 FROM classes c WHERE c.teacher_id = OLD.id AND c.lifecycle_stage NOT IN ('completed','archived','cancelled'))
   OR EXISTS (
     SELECT 1 FROM class_teacher_skills cts JOIN classes c ON c.id = cts.class_id
     WHERE cts.teacher_id = OLD.id AND cts.assignment_type IN ('primary','assistant')
       AND c.lifecycle_stage NOT IN ('completed','archived','cancelled')
       AND (cts.end_date IS NULL OR cts.end_date >= date('now'))
   )
 )
BEGIN SELECT RAISE(ABORT, 'teacher has active teaching work'); END;

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
  CHECK (lock_status IN ('draft','submitted','reviewed','approved','published','locked')), lock_status_updated_at TEXT,
  CHECK (weight >= 0 AND max_score > 0));
CREATE INDEX IF NOT EXISTS idx_assessments_class ON class_assessments(class_id);
CREATE INDEX IF NOT EXISTS idx_assessments_makeup_for ON class_assessments(makeup_for_assessment_id);

CREATE TABLE IF NOT EXISTS student_grades (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES class_assessments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  score REAL CHECK (score IS NULL OR score >= 0),
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
  type      TEXT NOT NULL CHECK (type IN ('placement','midterm','final','certification')), 
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
  score              REAL CHECK (score IS NULL OR (score >= 0 AND score <= 120)), 
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pass','fail')), 
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
  status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','revoked')), 
  revoked_at     TEXT, 
  revoked_by     TEXT, 
  created_at     TEXT NOT NULL DEFAULT (datetime('now')) 
);
CREATE INDEX IF NOT EXISTS idx_certificates_student  ON certificates(student_id);

-- ============================================================================
-- BOOKS
-- ============================================================================
-- Catalog, custody and commerce are deliberately separate facts. A catalog item
-- is not a mutable stock balance: availability is derived from immutable stock
-- receipts, posted sales without a return, and issued loans without a return.

CREATE TABLE IF NOT EXISTS books ( 
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  item_kind             TEXT NOT NULL CHECK (item_kind IN ('book','chapter')),
  sale_enabled          INTEGER NOT NULL DEFAULT 1 CHECK (sale_enabled IN (0,1)),
  sale_price            INTEGER,
  lending_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (lending_enabled IN (0,1)),
  default_unit_cost     INTEGER,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((sale_enabled = 1 AND sale_price IS NOT NULL) OR (sale_enabled = 0 AND sale_price IS NULL)),
  CHECK (sale_enabled = 1 OR lending_enabled = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_books_branch_kind_title
  ON books(branch_id, item_kind, title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_books_branch_status ON books(branch_id, status, title);
CREATE TRIGGER IF NOT EXISTS trg_books_money_insert
BEFORE INSERT ON books
WHEN (NEW.sale_price IS NOT NULL AND (typeof(NEW.sale_price) IS NOT 'integer' OR NEW.sale_price <= 0))
  OR (NEW.default_unit_cost IS NOT NULL AND (typeof(NEW.default_unit_cost) IS NOT 'integer' OR NEW.default_unit_cost < 0))
BEGIN SELECT RAISE(ABORT, 'Book prices and unit costs must be whole AFN values; a sale price must be positive'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_money_update
BEFORE UPDATE OF sale_price, default_unit_cost, sale_enabled ON books
WHEN (NEW.sale_price IS NOT NULL AND (typeof(NEW.sale_price) IS NOT 'integer' OR NEW.sale_price <= 0))
  OR (NEW.default_unit_cost IS NOT NULL AND (typeof(NEW.default_unit_cost) IS NOT 'integer' OR NEW.default_unit_cost < 0))
BEGIN SELECT RAISE(ABORT, 'Book prices and unit costs must be whole AFN values; a sale price must be positive'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_title_insert
BEFORE INSERT ON books
WHEN NEW.title IS NULL OR TRIM(NEW.title) = '' OR NEW.title IS NOT TRIM(NEW.title)
BEGIN SELECT RAISE(ABORT, 'Book title must be non-empty trimmed text'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_title_update
BEFORE UPDATE OF title ON books
WHEN NEW.title IS NULL OR TRIM(NEW.title) = '' OR NEW.title IS NOT TRIM(NEW.title)
BEGIN SELECT RAISE(ABORT, 'Book title must be non-empty trimmed text'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_identity_immutable
BEFORE UPDATE OF branch_id, item_kind ON books
BEGIN SELECT RAISE(ABORT, 'A Book branch and item kind are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_books_no_delete
BEFORE DELETE ON books
BEGIN SELECT RAISE(ABORT, 'Book catalog facts are archived, never deleted'); END;

CREATE TABLE IF NOT EXISTS book_stock_receipts (
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  received_on           TEXT NOT NULL,
  unit_cost             INTEGER,
  note                  TEXT,
  received_by_user_id   TEXT NOT NULL,
  received_by_name      TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  -- Acquisition accounting (wave 6 / W6-1): how the purchase of this stock was
  -- accounted for. NULL when the receipt carries no cost, when it was paid
  -- atomically from a budget line (see purchase_transaction_id), or on legacy
  -- rows written before the declaration existed.
  purchase_declaration  TEXT,
  -- The expense row that paid for this stock atomically with the receipt.
  purchase_transaction_id TEXT REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_book_stock_receipts_book_date
  ON book_stock_receipts(book_id, received_on, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_stock_receipts_idempotency
  ON book_stock_receipts(idempotency_key);

-- W7-1: audited quantity-only stock adjustments (loss / found / correction).
-- Under the system's cash basis the acquisition cost was expensed at purchase,
-- so a physical loss has NO financial leg — this table exists so the loss is
-- representable at all, instead of forcing staff to fabricate a sale (which
-- would invent revenue) to correct a quantity.
CREATE TABLE IF NOT EXISTS book_stock_adjustments (
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  delta                 INTEGER NOT NULL CHECK (delta <> 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('loss','found','correction')),
  adjusted_on           TEXT NOT NULL,
  reason                TEXT NOT NULL CHECK (length(TRIM(reason)) >= 8),
  adjusted_by_user_id   TEXT NOT NULL,
  adjusted_by_name      TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_book_stock_adjustments_branch_date
  ON book_stock_adjustments(branch_id, adjusted_on, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_stock_adjustments_idempotency
  ON book_stock_adjustments(idempotency_key);
CREATE TRIGGER IF NOT EXISTS trg_book_stock_adjustments_integrity_insert
BEFORE INSERT ON book_stock_adjustments
WHEN typeof(NEW.delta) IS NOT 'integer'
  OR strftime('%Y-%m-%d', NEW.adjusted_on) IS NOT NEW.adjusted_on
  OR (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
  OR (SELECT status FROM books WHERE id = NEW.book_id) IS NOT 'active'
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
  OR (
    COALESCE((SELECT SUM(r.quantity) FROM book_stock_receipts r WHERE r.book_id = NEW.book_id), 0)
    - COALESCE((SELECT SUM(s.quantity) FROM book_sales s
                WHERE s.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)), 0)
    - COALESCE((SELECT COUNT(*) FROM book_loans l
                WHERE l.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_loan_returns lr WHERE lr.loan_id = l.id)), 0)
    + COALESCE((SELECT SUM(a.delta) FROM book_stock_adjustments a WHERE a.book_id = NEW.book_id), 0)
      + NEW.delta < 0
  )
BEGIN SELECT RAISE(ABORT, 'Book stock adjustment is invalid, cross-branch, archived, unkeyed, or underflows availability'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_stock_adjustments_immutable_update
BEFORE UPDATE ON book_stock_adjustments
BEGIN SELECT RAISE(ABORT, 'Book stock adjustments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_stock_adjustments_immutable_delete
BEFORE DELETE ON book_stock_adjustments
BEGIN SELECT RAISE(ABORT, 'Book stock adjustments are immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_stock_receipts_integrity_insert
BEFORE INSERT ON book_stock_receipts
WHEN typeof(NEW.quantity) IS NOT 'integer'
  OR NEW.quantity <= 0
  OR strftime('%Y-%m-%d', NEW.received_on) IS NOT NEW.received_on
  OR (NEW.unit_cost IS NOT NULL AND (typeof(NEW.unit_cost) IS NOT 'integer' OR NEW.unit_cost < 0))
  OR (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
  OR (SELECT status FROM books WHERE id = NEW.book_id) IS NOT 'active'
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN SELECT RAISE(ABORT, 'Book stock receipt is invalid, cross-branch, archived, or unkeyed'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_stock_receipts_immutable_update
BEFORE UPDATE ON book_stock_receipts
BEGIN SELECT RAISE(ABORT, 'Book stock receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_stock_receipts_immutable_delete
BEFORE DELETE ON book_stock_receipts
BEGIN SELECT RAISE(ABORT, 'Book stock receipts are immutable'); END;

CREATE TABLE IF NOT EXISTS book_sales ( 
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  unit_price            INTEGER NOT NULL CHECK (unit_price > 0),
  gross_amount          INTEGER NOT NULL CHECK (gross_amount > 0),
  discount_amount       INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount            INTEGER NOT NULL CHECK (net_amount > 0),
  payment_id            TEXT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  sold_on               TEXT NOT NULL,
  purchaser_name        TEXT NOT NULL,
  student_id            TEXT REFERENCES students(id) ON DELETE SET NULL,
  operator_user_id      TEXT NOT NULL,
  operator_name         TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (gross_amount = quantity * unit_price),
  CHECK (net_amount = gross_amount - discount_amount)
);
CREATE INDEX IF NOT EXISTS idx_book_sales_book_date ON book_sales(book_id, sold_on, created_at);
CREATE INDEX IF NOT EXISTS idx_book_sales_branch_date ON book_sales(branch_id, sold_on, created_at);
CREATE INDEX IF NOT EXISTS idx_book_sales_student ON book_sales(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_sales_idempotency ON book_sales(idempotency_key);
DROP TRIGGER IF EXISTS trg_book_sales_integrity_insert;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_integrity_insert
BEFORE INSERT ON book_sales
WHEN typeof(NEW.quantity) IS NOT 'integer'
  OR typeof(NEW.unit_price) IS NOT 'integer'
  OR typeof(NEW.gross_amount) IS NOT 'integer'
  OR typeof(NEW.discount_amount) IS NOT 'integer'
  OR typeof(NEW.net_amount) IS NOT 'integer'
  OR NEW.quantity <= 0 OR NEW.unit_price <= 0 OR NEW.gross_amount <= 0
  OR NEW.discount_amount < 0 OR NEW.net_amount <= 0
  OR strftime('%Y-%m-%d', NEW.sold_on) IS NOT NEW.sold_on
  OR NEW.gross_amount <> NEW.quantity * NEW.unit_price
  OR NEW.net_amount <> NEW.gross_amount - NEW.discount_amount
  OR NEW.purchaser_name IS NULL OR TRIM(NEW.purchaser_name) = ''
  OR (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
  OR (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (
    EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id)
    AND NOT EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = NEW.payment_id AND p.category = 'book' AND p.status = 'completed' AND p.invoice_id IS NULL
        AND p.amount = NEW.net_amount AND p.branch_id IS NEW.branch_id
        AND p.student_id IS NEW.student_id
    )
  )
  OR (SELECT status FROM books WHERE id = NEW.book_id) IS NOT 'active'
  OR (SELECT sale_enabled FROM books WHERE id = NEW.book_id) IS NOT 1
  OR (SELECT sale_price FROM books WHERE id = NEW.book_id) IS NOT NEW.unit_price
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
  OR (
    COALESCE((SELECT SUM(r.quantity) FROM book_stock_receipts r WHERE r.book_id = NEW.book_id), 0)
    - COALESCE((SELECT SUM(s.quantity) FROM book_sales s
                WHERE s.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)), 0)
    - COALESCE((SELECT COUNT(*) FROM book_loans l
                WHERE l.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_loan_returns lr WHERE lr.loan_id = l.id)), 0)
    + COALESCE((SELECT SUM(a.delta) FROM book_stock_adjustments a WHERE a.book_id = NEW.book_id), 0)
    < NEW.quantity
  )
BEGIN SELECT RAISE(ABORT, 'Book sale is invalid, unavailable, cross-branch, archived, or unkeyed'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_immutable_update
BEFORE UPDATE ON book_sales
BEGIN SELECT RAISE(ABORT, 'Book sales are immutable; use a Book sale return'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sales_immutable_delete
BEFORE DELETE ON book_sales
BEGIN SELECT RAISE(ABORT, 'Book sales are immutable'); END;

CREATE TABLE IF NOT EXISTS book_sale_refunds (
  id                    TEXT PRIMARY KEY,
  sale_id               TEXT NOT NULL UNIQUE REFERENCES book_sales(id) ON DELETE RESTRICT,
  refund_payment_id     TEXT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  returned_on           TEXT NOT NULL,
  reason                TEXT NOT NULL,
  returned_by_user_id   TEXT NOT NULL,
  returned_by_name      TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_book_sale_refunds_branch_date
  ON book_sale_refunds(branch_id, returned_on, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_sale_refunds_idempotency ON book_sale_refunds(idempotency_key);
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refunds_integrity_insert
BEFORE INSERT ON book_sale_refunds
WHEN (SELECT branch_id FROM book_sales WHERE id = NEW.sale_id) IS NOT NEW.branch_id
  OR strftime('%Y-%m-%d', NEW.returned_on) IS NOT NEW.returned_on
  OR NEW.returned_on < (SELECT sold_on FROM book_sales WHERE id = NEW.sale_id)
  OR NEW.reason IS NULL OR TRIM(NEW.reason) = ''
  OR (
    EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.refund_payment_id)
    AND NOT EXISTS (
      SELECT 1 FROM payments p JOIN book_sales s ON s.id = NEW.sale_id
      WHERE p.id = NEW.refund_payment_id AND p.category = 'refund' AND p.status = 'completed'
        AND p.amount = -s.net_amount AND p.refunds_payment_id = s.payment_id
        AND p.branch_id IS NEW.branch_id AND p.student_id IS s.student_id
    )
  )
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN SELECT RAISE(ABORT, 'Book sale return is cross-branch, unexplained, or unkeyed'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refunds_immutable_update
BEFORE UPDATE ON book_sale_refunds
BEGIN SELECT RAISE(ABORT, 'Book sale returns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refunds_immutable_delete
BEFORE DELETE ON book_sale_refunds
BEGIN SELECT RAISE(ABORT, 'Book sale returns are immutable'); END;

CREATE TABLE IF NOT EXISTS book_loans (
  id                    TEXT PRIMARY KEY,
  book_id               TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  student_id            TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  issued_on             TEXT NOT NULL,
  due_on                TEXT NOT NULL,
  issued_by_user_id     TEXT NOT NULL,
  issued_by_name        TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (due_on >= issued_on)
);
CREATE INDEX IF NOT EXISTS idx_book_loans_branch_due ON book_loans(branch_id, due_on, issued_on);
CREATE INDEX IF NOT EXISTS idx_book_loans_student ON book_loans(student_id, due_on);
CREATE INDEX IF NOT EXISTS idx_book_loans_book ON book_loans(book_id, issued_on);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_loans_idempotency ON book_loans(idempotency_key);
DROP TRIGGER IF EXISTS trg_book_loans_integrity_insert;
CREATE TRIGGER IF NOT EXISTS trg_book_loans_integrity_insert
BEFORE INSERT ON book_loans
WHEN NEW.due_on < NEW.issued_on
  OR strftime('%Y-%m-%d', NEW.issued_on) IS NOT NEW.issued_on
  OR strftime('%Y-%m-%d', NEW.due_on) IS NOT NEW.due_on
  OR (SELECT branch_id FROM books WHERE id = NEW.book_id) IS NOT NEW.branch_id
  OR (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
  OR (SELECT status FROM books WHERE id = NEW.book_id) IS NOT 'active'
  OR (SELECT lending_enabled FROM books WHERE id = NEW.book_id) IS NOT 1
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
  OR (
    COALESCE((SELECT SUM(r.quantity) FROM book_stock_receipts r WHERE r.book_id = NEW.book_id), 0)
    - COALESCE((SELECT SUM(s.quantity) FROM book_sales s
                WHERE s.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)), 0)
    - COALESCE((SELECT COUNT(*) FROM book_loans l
                WHERE l.book_id = NEW.book_id
                  AND NOT EXISTS (SELECT 1 FROM book_loan_returns lr WHERE lr.loan_id = l.id)), 0)
    + COALESCE((SELECT SUM(a.delta) FROM book_stock_adjustments a WHERE a.book_id = NEW.book_id), 0)
    < 1
  )
BEGIN SELECT RAISE(ABORT, 'Book loan is invalid, unavailable, cross-branch, archived, disabled, or unkeyed'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_loans_immutable_update
BEFORE UPDATE ON book_loans
BEGIN SELECT RAISE(ABORT, 'Book loans are immutable; use a Book loan return'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_loans_immutable_delete
BEFORE DELETE ON book_loans
BEGIN SELECT RAISE(ABORT, 'Book loans are immutable'); END;

CREATE TABLE IF NOT EXISTS book_loan_returns (
  id                    TEXT PRIMARY KEY,
  loan_id               TEXT NOT NULL UNIQUE REFERENCES book_loans(id) ON DELETE RESTRICT,
  returned_on           TEXT NOT NULL,
  note                  TEXT,
  returned_by_user_id   TEXT NOT NULL,
  returned_by_name      TEXT NOT NULL,
  branch_id             TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  idempotency_key       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_book_loan_returns_branch_date
  ON book_loan_returns(branch_id, returned_on, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_loan_returns_idempotency ON book_loan_returns(idempotency_key);
CREATE TRIGGER IF NOT EXISTS trg_book_loan_returns_integrity_insert
BEFORE INSERT ON book_loan_returns
WHEN strftime('%Y-%m-%d', NEW.returned_on) IS NOT NEW.returned_on
  OR NEW.returned_on < (SELECT issued_on FROM book_loans WHERE id = NEW.loan_id)
  OR (SELECT branch_id FROM book_loans WHERE id = NEW.loan_id) IS NOT NEW.branch_id
  OR NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN SELECT RAISE(ABORT, 'Book loan return is invalid, cross-branch, or unkeyed'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_loan_returns_immutable_update
BEFORE UPDATE ON book_loan_returns
BEGIN SELECT RAISE(ABORT, 'Book loan returns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_loan_returns_immutable_delete
BEFORE DELETE ON book_loan_returns
BEGIN SELECT RAISE(ABORT, 'Book loan returns are immutable'); END;

DROP VIEW IF EXISTS book_inventory_positions;
CREATE VIEW book_inventory_positions AS
SELECT
  b.id AS book_id,
  COALESCE((SELECT SUM(r.quantity) FROM book_stock_receipts r WHERE r.book_id = b.id), 0) AS received_quantity,
  COALESCE((SELECT SUM(s.quantity) FROM book_sales s
            WHERE s.book_id = b.id
              AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)), 0) AS sold_quantity,
  COALESCE((SELECT COUNT(*) FROM book_loans l
            WHERE l.book_id = b.id
              AND NOT EXISTS (SELECT 1 FROM book_loan_returns lr WHERE lr.loan_id = l.id)), 0) AS loaned_quantity,
  COALESCE((SELECT SUM(r.quantity) FROM book_stock_receipts r WHERE r.book_id = b.id), 0)
    - COALESCE((SELECT SUM(s.quantity) FROM book_sales s
                WHERE s.book_id = b.id
                  AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.sale_id = s.id)), 0)
    - COALESCE((SELECT COUNT(*) FROM book_loans l
                WHERE l.book_id = b.id
                  AND NOT EXISTS (SELECT 1 FROM book_loan_returns lr WHERE lr.loan_id = l.id)), 0)
    + COALESCE((SELECT SUM(a.delta) FROM book_stock_adjustments a WHERE a.book_id = b.id), 0) AS available_quantity
FROM books b;


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
  fee_type            TEXT NOT NULL CHECK (fee_type IN ('registration','placement','semester','retake','diploma','card')), 
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
  student_code   TEXT,
  -- Non-tuition classification within the one invoice table. Purpose remains
  -- the money authority (tuition vs not-tuition); charge_kind distinguishes
  -- admission charges such as registration and placement without creating a
  -- second invoice system.
  charge_kind    TEXT CHECK (charge_kind IS NULL OR charge_kind IN ('registration','placement','books','exam','other')),
  -- What this document bills (owner decision D-118). An invoice payment
  -- settles the thing the invoice names; it is never tuition merely because it
  -- arrived through the invoice system. While every invoice payment was booked
  -- as `category = 'fee'`, a 3,000 AFN textbooks invoice cut a 10,000 AFN
  -- tuition debt to 7,000 and a paid tuition invoice settled no term at all.
  purpose        TEXT NOT NULL CHECK (purpose IN ('tuition','books','exam','other')),
  -- The tuition obligation this invoice bills. Exactly one, so a partial
  -- payment never has to be split between obligations by a rule nobody wrote.
  obligation_id  TEXT REFERENCES student_obligations(id) ON DELETE RESTRICT,
  CHECK (
       (purpose =  'tuition' AND obligation_id IS NOT NULL)
    OR (purpose <> 'tuition' AND obligation_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_invoices_branch       ON invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch_due_status
  ON invoices(branch_id, due_date, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date     ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due   ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_student      ON invoices(student_id);
-- Invoice numbers are issued per branch and per year by `invoice_sequence:*`,
-- so uniqueness is scoped to the branch that issued them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_branch_invoice_number
  ON invoices(branch_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
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
-- An invoice may only bill a tuition obligation of the student it is addressed
-- to. Without this, a document could name another student's term and its
-- payment would settle a debt that student never owed.
CREATE TRIGGER IF NOT EXISTS trg_invoices_obligation_owner_insert
BEFORE INSERT ON invoices
WHEN NEW.obligation_id IS NOT NULL AND (
     (SELECT student_id FROM student_obligations WHERE id = NEW.obligation_id) IS NOT NEW.student_id
  OR (SELECT kind       FROM student_obligations WHERE id = NEW.obligation_id) <> 'tuition')
BEGIN SELECT RAISE(ABORT, 'Invoice obligation must be a tuition obligation of the same student'); END;
CREATE TRIGGER IF NOT EXISTS trg_invoices_obligation_owner_update
BEFORE UPDATE OF obligation_id, student_id ON invoices
WHEN NEW.obligation_id IS NOT NULL AND (
     (SELECT student_id FROM student_obligations WHERE id = NEW.obligation_id) IS NOT NEW.student_id
  OR (SELECT kind       FROM student_obligations WHERE id = NEW.obligation_id) <> 'tuition')
BEGIN SELECT RAISE(ABORT, 'Invoice obligation must be a tuition obligation of the same student'); END;
CREATE INDEX IF NOT EXISTS idx_invoices_obligation ON invoices(obligation_id);

CREATE TABLE IF NOT EXISTS invoice_items ( 
  id          TEXT PRIMARY KEY, 
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, 
  description TEXT NOT NULL, 
  quantity    INTEGER NOT NULL DEFAULT 1, 
  unit_price  INTEGER NOT NULL DEFAULT 0, 
  amount      INTEGER NOT NULL DEFAULT 0 
);
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
  amount         INTEGER NOT NULL, 
  date           TEXT NOT NULL, 
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','bank_transfer')), 
  status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','pending','failed','refunded')), 
  category       TEXT NOT NULL CHECK (category IN ('fee','book','chapter','exam','card','placement','diploma','installment','refund','other')),
  notes          TEXT, 
  receipt_number TEXT, 
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT, 
  semester       TEXT,
  -- A refund reverses exactly one payment (owner decision D-113). The named row
  -- carries the category and the semester the money belongs to, which is what
  -- keeps a refund of a book, exam or card charge out of the student's TUITION
  -- position and re-opens only the semester the refunded tuition settled.
  refunds_payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_branch       ON payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_payments_branch_date   ON payments(branch_id, date);
CREATE INDEX IF NOT EXISTS idx_payments_date         ON payments(date);
CREATE INDEX IF NOT EXISTS idx_payments_invoice      ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_student      ON payments(student_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- A receipt number is the payer's proof that a specific payment happened, so
-- two payments may never carry one. The number is issued by a single global
-- counter (`receipt_counter`), which is why uniqueness here is global rather
-- than per branch. Rows with no receipt (internal bookings) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_receipt_number
  ON payments(receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_refunds ON payments(refunds_payment_id);
-- Attribution is mandatory in one direction and forbidden in the other: a
-- refund without a target is unexplainable money, and a charge that claims to
-- reverse something is not a charge.
CREATE TRIGGER IF NOT EXISTS trg_payments_refund_attribution_insert
BEFORE INSERT ON payments
WHEN (NEW.category = 'refund' AND NEW.refunds_payment_id IS NULL)
  OR (NEW.category <> 'refund' AND NEW.refunds_payment_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a refund must name the payment it reverses, and only a refund may name one'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_refund_attribution_update
BEFORE UPDATE OF category, refunds_payment_id ON payments
WHEN (NEW.category = 'refund' AND NEW.refunds_payment_id IS NULL)
  OR (NEW.category <> 'refund' AND NEW.refunds_payment_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a refund must name the payment it reverses, and only a refund may name one'); END;
-- The target must be a real, non-refund payment of the same student and branch,
-- so a refund cannot be attributed to another student's money or chained onto
-- another refund.
CREATE TRIGGER IF NOT EXISTS trg_payments_refund_target_insert
BEFORE INSERT ON payments
WHEN NEW.refunds_payment_id IS NOT NULL AND (
     (SELECT student_id FROM payments WHERE id = NEW.refunds_payment_id) IS NOT NEW.student_id
  OR (SELECT branch_id  FROM payments WHERE id = NEW.refunds_payment_id) IS NOT NEW.branch_id
  OR (SELECT category   FROM payments WHERE id = NEW.refunds_payment_id) = 'refund')
BEGIN SELECT RAISE(ABORT, 'a refund must reverse a non-refund payment of the same student and branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_refund_target_update
BEFORE UPDATE OF refunds_payment_id, student_id, branch_id ON payments
WHEN NEW.refunds_payment_id IS NOT NULL AND (
     (SELECT student_id FROM payments WHERE id = NEW.refunds_payment_id) IS NOT NEW.student_id
  OR (SELECT branch_id  FROM payments WHERE id = NEW.refunds_payment_id) IS NOT NEW.branch_id
  OR (SELECT category   FROM payments WHERE id = NEW.refunds_payment_id) = 'refund')
BEGIN SELECT RAISE(ABORT, 'a refund must reverse a non-refund payment of the same student and branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_insert
BEFORE INSERT ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'Payment branch does not match related resource branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_branch_integrity_update
BEFORE UPDATE OF student_id, invoice_id, branch_id ON payments
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.invoice_id IS NOT NULL AND (SELECT branch_id FROM invoices WHERE id = NEW.invoice_id) IS NOT NEW.branch_id)
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

-- A Book sale owns its cash receipt. The sale is inserted first with a deferred
-- payment foreign key, so this check runs when the matching payment is written.
CREATE TRIGGER IF NOT EXISTS trg_book_sale_payment_integrity_insert
BEFORE INSERT ON payments
WHEN NEW.category = 'book' AND NEW.invoice_id IS NULL AND (
  NEW.status IS NOT 'completed'
  OR NEW.amount <= 0
  OR NOT EXISTS (
    SELECT 1 FROM book_sales s
    WHERE s.payment_id = NEW.id
      AND s.branch_id IS NEW.branch_id
      AND s.student_id IS NEW.student_id
      AND s.net_amount = NEW.amount
  )
)
BEGIN SELECT RAISE(ABORT, 'A non-invoice Book payment must be the completed receipt for its Book sale'); END;

-- A Book sale return owns one full signed contra receipt. Its amount, target,
-- branch and student identity must agree with the sale it reverses.
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refund_payment_integrity_insert
BEFORE INSERT ON payments
WHEN EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = NEW.id)
  AND (
    NEW.category IS NOT 'refund'
    OR NEW.status IS NOT 'completed'
    OR NEW.amount <> -(
      SELECT s.net_amount
      FROM book_sale_refunds sr JOIN book_sales s ON s.id = sr.sale_id
      WHERE sr.refund_payment_id = NEW.id
    )
    OR NEW.refunds_payment_id IS NOT (
      SELECT s.payment_id
      FROM book_sale_refunds sr JOIN book_sales s ON s.id = sr.sale_id
      WHERE sr.refund_payment_id = NEW.id
    )
    OR NEW.branch_id IS NOT (
      SELECT s.branch_id
      FROM book_sale_refunds sr JOIN book_sales s ON s.id = sr.sale_id
      WHERE sr.refund_payment_id = NEW.id
    )
    OR NEW.student_id IS NOT (
      SELECT s.student_id
      FROM book_sale_refunds sr JOIN book_sales s ON s.id = sr.sale_id
      WHERE sr.refund_payment_id = NEW.id
    )
  )
BEGIN SELECT RAISE(ABORT, 'Book sale return payment must exactly reverse its Book sale receipt'); END;

-- A payment that reverses a physical Book sale may exist only after the
-- immutable Book return fact is present. This blocks a generic refund from
-- creating cash-only inventory restoration by being inserted first.
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refund_requires_return_insert
BEFORE INSERT ON payments
WHEN NEW.category = 'refund'
  AND EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = NEW.refunds_payment_id)
  AND NOT EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'A Book sale refund payment requires its Book sale return fact'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_sale_payments_immutable_update
BEFORE UPDATE ON payments
WHEN EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = OLD.id)
  OR EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Book commerce payments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_payments_immutable_delete
BEFORE DELETE ON payments
WHEN EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = OLD.id)
  OR EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Book commerce payments are immutable'); END;

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
  -- A donation income row is one side of a deferred, one-to-one financial fact
  -- pair. Other income remains intentionally generic through `reference_id`.
  donation_id   TEXT UNIQUE REFERENCES donations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_tx_donation
  ON financial_transactions(donation_id) WHERE donation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_tx_type           ON financial_transactions(type);
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_insert
BEFORE INSERT ON financial_transactions
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_fin_tx_money_scale_update
BEFORE UPDATE OF amount ON financial_transactions
WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'financial transaction amount must be a whole number of AFN'); END;

CREATE TRIGGER IF NOT EXISTS trg_book_sale_income_integrity_insert
BEFORE INSERT ON financial_transactions
WHEN EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = NEW.payment_id)
  AND (
    NEW.type IS NOT 'income'
    OR NEW.category IS NOT 'book'
    OR NEW.amount <> (SELECT net_amount FROM book_sales WHERE payment_id = NEW.payment_id)
    OR NEW.reference_id IS NOT (SELECT id FROM book_sales WHERE payment_id = NEW.payment_id)
    OR NEW.branch_id IS NOT (SELECT branch_id FROM book_sales WHERE payment_id = NEW.payment_id)
    OR EXISTS (SELECT 1 FROM financial_transactions ft WHERE ft.payment_id = NEW.payment_id)
  )
BEGIN SELECT RAISE(ABORT, 'Book sale income must exactly match its Book sale payment'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_refund_income_integrity_insert
BEFORE INSERT ON financial_transactions
WHEN EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = NEW.payment_id)
  AND (
    NEW.type IS NOT 'income'
    OR NEW.category IS NOT 'refund'
    OR NEW.amount <> -(
      SELECT s.net_amount FROM book_sale_refunds sr JOIN book_sales s ON s.id = sr.sale_id
      WHERE sr.refund_payment_id = NEW.payment_id
    )
    OR NEW.reference_id IS NOT (
      SELECT sr.sale_id FROM book_sale_refunds sr WHERE sr.refund_payment_id = NEW.payment_id
    )
    OR NEW.branch_id IS NOT (
      SELECT sr.branch_id FROM book_sale_refunds sr WHERE sr.refund_payment_id = NEW.payment_id
    )
    OR EXISTS (SELECT 1 FROM financial_transactions ft WHERE ft.payment_id = NEW.payment_id)
  )
BEGIN SELECT RAISE(ABORT, 'Book sale return income must exactly match its contra payment'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_income_immutable_update
BEFORE UPDATE ON financial_transactions
WHEN EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = OLD.payment_id)
  OR EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = OLD.payment_id)
BEGIN SELECT RAISE(ABORT, 'Book commerce income facts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_book_sale_income_immutable_delete
BEFORE DELETE ON financial_transactions
WHEN EXISTS (SELECT 1 FROM book_sales s WHERE s.payment_id = OLD.payment_id)
  OR EXISTS (SELECT 1 FROM book_sale_refunds sr WHERE sr.refund_payment_id = OLD.payment_id)
BEGIN SELECT RAISE(ABORT, 'Book commerce income facts are immutable'); END;

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
-- `idx_teacher_salary_due` is the one canonical covering period lookup.
DROP INDEX IF EXISTS idx_teacher_salary_period;
CREATE INDEX IF NOT EXISTS idx_teacher_salary_status ON teacher_salary_ledger(teacher_id, period_key, status);
CREATE INDEX IF NOT EXISTS idx_tsl_teacher_period ON teacher_salary_ledger(teacher_id, period_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_full_period
ON teacher_salary_ledger(teacher_id, period_key)
WHERE payment_type = 'full' AND status = 'posted';
-- A voided payment is history, not a live retry. A corrected payment may reuse
-- its request identity and becomes the sole posted row for that key.
DROP INDEX IF EXISTS uq_teacher_salary_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_idempotency
ON teacher_salary_ledger(idempotency_key)
WHERE idempotency_key IS NOT NULL AND status = 'posted';
DROP TRIGGER IF EXISTS trg_teacher_salary_money_scale_insert;
DROP TRIGGER IF EXISTS trg_teacher_salary_fact_insert;
CREATE TRIGGER trg_teacher_salary_fact_insert
BEFORE INSERT ON teacher_salary_ledger
WHEN typeof(NEW.due_amount) IS NOT 'integer'
  OR NEW.due_amount < 0
  OR typeof(NEW.paid_amount) IS NOT 'integer'
  OR NEW.paid_amount <= 0
  OR NEW.paid_amount > NEW.due_amount
  OR (NEW.payment_type = 'full' AND NEW.paid_amount <> NEW.due_amount)
  OR NEW.payment_type = 'advance'
  OR NEW.status IS NOT 'posted'
  OR NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  OR CAST(substr(NEW.period_key, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
  OR NEW.transaction_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM financial_transactions ft
    WHERE ft.id = NEW.transaction_id
      AND ft.type = 'expense'
      AND ft.category = 'salary'
      AND ft.finance_category_id = 'sub_salaries_wages'
      AND ft.amount = NEW.paid_amount
      AND ft.reference_id = NEW.teacher_id
      AND ft.branch_id = NEW.branch_id
  )
BEGIN SELECT RAISE(ABORT, 'teacher salary ledger fact is invalid'); END;
DROP TRIGGER IF EXISTS trg_teacher_salary_fact_update;
CREATE TRIGGER trg_teacher_salary_fact_update
BEFORE UPDATE OF due_amount, paid_amount, payment_type, period_key ON teacher_salary_ledger
WHEN typeof(NEW.due_amount) IS NOT 'integer'
  OR NEW.due_amount < 0
  OR typeof(NEW.paid_amount) IS NOT 'integer'
  OR NEW.paid_amount <= 0
  OR NEW.paid_amount > NEW.due_amount
  OR (NEW.payment_type = 'full' AND NEW.paid_amount <> NEW.due_amount)
  OR NEW.payment_type = 'advance'
  OR NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  OR CAST(substr(NEW.period_key, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
BEGIN SELECT RAISE(ABORT, 'teacher salary ledger fact is invalid'); END;
DROP TRIGGER IF EXISTS trg_teacher_salary_immutable_update;
CREATE TRIGGER trg_teacher_salary_immutable_update
BEFORE UPDATE ON teacher_salary_ledger
WHEN OLD.status IS NOT 'posted'
  OR NEW.status IS NOT 'voided'
  OR NEW.id IS NOT OLD.id
  OR NEW.teacher_id IS NOT OLD.teacher_id
  OR NEW.period_key IS NOT OLD.period_key
  OR NEW.period_label IS NOT OLD.period_label
  OR NEW.due_amount IS NOT OLD.due_amount
  OR NEW.paid_amount IS NOT OLD.paid_amount
  OR NEW.payment_type IS NOT OLD.payment_type
  OR NEW.transaction_id IS NOT OLD.transaction_id
  OR NEW.notes IS NOT OLD.notes
  OR NEW.branch_id IS NOT OLD.branch_id
  OR NEW.paid_at IS NOT OLD.paid_at
  OR NEW.operator_name IS NOT OLD.operator_name
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.voided_at IS NULL
  OR NEW.voided_by IS NULL
  OR length(trim(NEW.voided_by)) = 0
  OR NEW.void_reason IS NULL
  OR length(trim(NEW.void_reason)) < 8
  OR NOT EXISTS (
    SELECT 1 FROM financial_transactions reversal
    WHERE reversal.type = 'expense'
      AND reversal.category = 'salary'
      AND reversal.finance_category_id = 'sub_salaries_wages'
      AND reversal.amount = -OLD.paid_amount
      AND reversal.reference_id = OLD.id
      AND reversal.branch_id = OLD.branch_id
  )
BEGIN SELECT RAISE(ABORT, 'teacher salary ledger facts are immutable'); END;
DROP TRIGGER IF EXISTS trg_teacher_salary_no_delete;
CREATE TRIGGER trg_teacher_salary_no_delete
BEFORE DELETE ON teacher_salary_ledger
BEGIN SELECT RAISE(ABORT, 'teacher salary ledger facts cannot be deleted'); END;

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
DROP INDEX IF EXISTS uq_employee_salary_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_idempotency
  ON employee_salary_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'posted';
DROP TRIGGER IF EXISTS trg_employee_salary_fact_insert;
CREATE TRIGGER trg_employee_salary_fact_insert
BEFORE INSERT ON employee_salary_ledger
WHEN typeof(NEW.paid_amount) IS NOT 'integer'
  OR NEW.paid_amount <= 0
  OR NEW.status IS NOT 'posted'
  OR NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  OR CAST(substr(NEW.period_key, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
  OR NEW.transaction_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM financial_transactions ft
    WHERE ft.id = NEW.transaction_id
      AND ft.type = 'expense'
      AND ft.amount = NEW.paid_amount
      AND ft.reference_id = NEW.employee_id
      AND ft.branch_id = NEW.branch_id
      AND (
        (NEW.payment_type = 'advance'
          AND ft.category = 'salary_advance'
          AND ft.finance_category_id = 'sub_salary_advances')
        OR
        (NEW.payment_type IN ('full', 'partial')
          AND ft.category = 'salary'
          AND ft.finance_category_id = 'sub_salaries_wages')
      )
  )
BEGIN SELECT RAISE(ABORT, 'employee salary ledger fact is invalid'); END;
DROP TRIGGER IF EXISTS trg_employee_salary_fact_update;
CREATE TRIGGER trg_employee_salary_fact_update
BEFORE UPDATE OF paid_amount, payment_type, period_key ON employee_salary_ledger
WHEN typeof(NEW.paid_amount) IS NOT 'integer'
  OR NEW.paid_amount <= 0
  OR NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  OR CAST(substr(NEW.period_key, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
BEGIN SELECT RAISE(ABORT, 'employee salary ledger fact is invalid'); END;
DROP TRIGGER IF EXISTS trg_employee_salary_immutable_update;
CREATE TRIGGER trg_employee_salary_immutable_update
BEFORE UPDATE ON employee_salary_ledger
WHEN OLD.status IS NOT 'posted'
  OR NEW.status IS NOT 'voided'
  OR NEW.id IS NOT OLD.id
  OR NEW.employee_id IS NOT OLD.employee_id
  OR NEW.period_key IS NOT OLD.period_key
  OR NEW.period_label IS NOT OLD.period_label
  OR NEW.paid_amount IS NOT OLD.paid_amount
  OR NEW.payment_type IS NOT OLD.payment_type
  OR NEW.transaction_id IS NOT OLD.transaction_id
  OR NEW.notes IS NOT OLD.notes
  OR NEW.branch_id IS NOT OLD.branch_id
  OR NEW.paid_at IS NOT OLD.paid_at
  OR NEW.operator_name IS NOT OLD.operator_name
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.voided_at IS NULL
  OR NEW.voided_by IS NULL
  OR length(trim(NEW.voided_by)) = 0
  OR NEW.void_reason IS NULL
  OR length(trim(NEW.void_reason)) < 8
  OR NOT EXISTS (
    SELECT 1 FROM financial_transactions reversal
    WHERE reversal.type = 'expense'
      AND reversal.amount = -OLD.paid_amount
      AND reversal.reference_id = OLD.id
      AND reversal.branch_id = OLD.branch_id
      AND (
        (OLD.payment_type = 'advance'
          AND reversal.category = 'salary_advance'
          AND reversal.finance_category_id = 'sub_salary_advances')
        OR
        (OLD.payment_type IN ('full', 'partial')
          AND reversal.category = 'salary'
          AND reversal.finance_category_id = 'sub_salaries_wages')
      )
  )
BEGIN SELECT RAISE(ABORT, 'employee salary ledger facts are immutable'); END;
DROP TRIGGER IF EXISTS trg_employee_salary_no_delete;
CREATE TRIGGER trg_employee_salary_no_delete
BEFORE DELETE ON employee_salary_ledger
BEGIN SELECT RAISE(ABORT, 'employee salary ledger facts cannot be deleted'); END;

-- A financial transaction linked to a payroll fact, including its void contra,
-- is part of that immutable payroll history and cannot be detached later.
DROP TRIGGER IF EXISTS trg_financial_transactions_payroll_fact_update_guard;
CREATE TRIGGER trg_financial_transactions_payroll_fact_update_guard
BEFORE UPDATE ON financial_transactions
WHEN EXISTS (
  SELECT 1 FROM teacher_salary_ledger t WHERE t.transaction_id = OLD.id OR t.id = OLD.reference_id
) OR EXISTS (
  SELECT 1 FROM employee_salary_ledger e WHERE e.transaction_id = OLD.id OR e.id = OLD.reference_id
)
BEGIN SELECT RAISE(ABORT, 'payroll financial facts cannot be modified'); END;
DROP TRIGGER IF EXISTS trg_financial_transactions_payroll_fact_delete_guard;
CREATE TRIGGER trg_financial_transactions_payroll_fact_delete_guard
BEFORE DELETE ON financial_transactions
WHEN EXISTS (
  SELECT 1 FROM teacher_salary_ledger t WHERE t.transaction_id = OLD.id OR t.id = OLD.reference_id
) OR EXISTS (
  SELECT 1 FROM employee_salary_ledger e WHERE e.transaction_id = OLD.id OR e.id = OLD.reference_id
)
BEGIN SELECT RAISE(ABORT, 'payroll financial facts cannot be deleted'); END;

-- ============================================================================
-- FUNDING & IMPACT
-- ============================================================================
-- Donations are cash facts. Campaign, scholarship and sponsorship allocations
-- are separately recorded non-cash funding facts so every reported outcome has
-- an exact source and cash is never recognized twice.

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
CREATE INDEX IF NOT EXISTS idx_donors_type ON donors(type);

CREATE TABLE IF NOT EXISTS funding_campaigns (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  donor_id      TEXT REFERENCES donors(id) ON DELETE SET NULL,
  target_amount INTEGER NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
  start_date    TEXT NOT NULL,
  end_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  branch_id     TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_funding_campaigns_branch ON funding_campaigns(branch_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_funding_campaigns_donor ON funding_campaigns(donor_id);

CREATE TABLE IF NOT EXISTS donations (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  donor_id       TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  date           TEXT NOT NULL,
  receipt_no     TEXT NOT NULL,
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES financial_transactions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations(donor_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_donations_branch_date ON donations(branch_id, date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_branch_receipt ON donations(branch_id, receipt_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_idempotency
  ON donations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_donations_campaign_branch_insert
BEFORE INSERT ON donations
WHEN NEW.campaign_id IS NOT NULL
 AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'donation campaign must belong to the donation branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_donations_campaign_branch_update
BEFORE UPDATE OF campaign_id, branch_id ON donations
WHEN NEW.campaign_id IS NOT NULL
 AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'donation campaign must belong to the donation branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_donations_transaction_integrity_insert
BEFORE INSERT ON donations
WHEN (SELECT type FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT 'income'
  OR (SELECT category FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT 'donation'
  OR (SELECT donation_id FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT NEW.id
  OR (SELECT branch_id FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT NEW.branch_id
  OR (SELECT amount FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT NEW.amount
  OR (SELECT date FROM financial_transactions WHERE id = NEW.transaction_id) IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'donation must link to its matching income transaction'); END;
CREATE TRIGGER IF NOT EXISTS trg_donations_immutable_update
BEFORE UPDATE ON donations
BEGIN SELECT RAISE(ABORT, 'donation facts cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_financial_transactions_donation_immutable_update
BEFORE UPDATE ON financial_transactions
WHEN OLD.donation_id IS NOT NULL OR NEW.donation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'donation income facts cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_financial_transactions_donation_immutable_delete
BEFORE DELETE ON financial_transactions
WHEN OLD.donation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'donation income facts cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS scholarships (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  donor_id     TEXT REFERENCES donors(id) ON DELETE SET NULL,
  campaign_id  TEXT REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  total_budget INTEGER NOT NULL DEFAULT 0 CHECK (total_budget >= 0),
  criteria     TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  branch_id    TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scholarships_branch ON scholarships(branch_id);
CREATE INDEX IF NOT EXISTS idx_scholarships_campaign ON scholarships(campaign_id);
CREATE TRIGGER IF NOT EXISTS trg_scholarships_campaign_branch_insert
BEFORE INSERT ON scholarships
WHEN NEW.campaign_id IS NOT NULL
 AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'scholarship campaign must belong to the scholarship branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarships_campaign_branch_update
BEFORE UPDATE OF campaign_id, branch_id ON scholarships
WHEN NEW.campaign_id IS NOT NULL
 AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'scholarship campaign must belong to the scholarship branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarships_immutable_update
BEFORE UPDATE ON scholarships
BEGIN SELECT RAISE(ABORT, 'scholarship definitions cannot be modified after creation'); END;

CREATE TABLE IF NOT EXISTS sponsorship_agreements (
  id             TEXT PRIMARY KEY,
  donor_id       TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT,
  student_id     TEXT REFERENCES students(id) ON DELETE RESTRICT,
  program_id     TEXT REFERENCES programs(id) ON DELETE SET NULL,
  campaign_id    TEXT REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  monthly_amount INTEGER NOT NULL DEFAULT 0 CHECK (monthly_amount >= 0),
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','terminated')),
  terminal_at    TEXT,
  terminal_by    TEXT,
  terminal_reason TEXT,
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date),
  CHECK ((status = 'active' AND terminal_at IS NULL AND terminal_by IS NULL AND terminal_reason IS NULL)
     OR (status IN ('completed','terminated') AND terminal_at IS NOT NULL AND terminal_by IS NOT NULL AND terminal_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_sponsorships_donor ON sponsorship_agreements(donor_id);
CREATE INDEX IF NOT EXISTS idx_sponsorships_student ON sponsorship_agreements(student_id);
CREATE INDEX IF NOT EXISTS idx_sponsorships_campaign ON sponsorship_agreements(campaign_id);
CREATE TRIGGER IF NOT EXISTS trg_sponsorships_scope_insert
BEFORE INSERT ON sponsorship_agreements
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.program_id IS NOT NULL AND (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id)
  OR (NEW.campaign_id IS NOT NULL AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'sponsorship branch scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorships_scope_update
BEFORE UPDATE OF student_id, program_id, campaign_id, branch_id ON sponsorship_agreements
WHEN (NEW.student_id IS NOT NULL AND (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id)
  OR (NEW.program_id IS NOT NULL AND (SELECT branch_id FROM programs WHERE id = NEW.program_id) IS NOT NEW.branch_id)
  OR (NEW.campaign_id IS NOT NULL AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id)
BEGIN SELECT RAISE(ABORT, 'sponsorship branch scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorships_immutable_scope_update
BEFORE UPDATE OF donor_id, student_id, program_id, campaign_id, start_date, branch_id ON sponsorship_agreements
BEGIN SELECT RAISE(ABORT, 'sponsorship identity and return target cannot be modified'); END;

CREATE TABLE IF NOT EXISTS donation_restrictions (
  donation_id               TEXT PRIMARY KEY REFERENCES donations(id) ON DELETE RESTRICT,
  target_kind               TEXT NOT NULL CHECK (target_kind IN ('campaign','scholarship','sponsorship')),
  campaign_id               TEXT REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  scholarship_id            TEXT REFERENCES scholarships(id) ON DELETE RESTRICT,
  sponsorship_agreement_id  TEXT REFERENCES sponsorship_agreements(id) ON DELETE RESTRICT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
       (target_kind = 'campaign'     AND campaign_id IS NOT NULL AND scholarship_id IS NULL AND sponsorship_agreement_id IS NULL)
    OR (target_kind = 'scholarship'  AND scholarship_id IS NOT NULL AND campaign_id IS NULL AND sponsorship_agreement_id IS NULL)
    OR (target_kind = 'sponsorship'  AND sponsorship_agreement_id IS NOT NULL AND campaign_id IS NULL AND scholarship_id IS NULL)
  )
);
CREATE TRIGGER IF NOT EXISTS trg_donation_restrictions_scope_insert
BEFORE INSERT ON donation_restrictions
WHEN (NEW.target_kind = 'campaign' AND (
       (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT (SELECT branch_id FROM donations WHERE id = NEW.donation_id)
       OR NEW.campaign_id IS NOT (SELECT campaign_id FROM donations WHERE id = NEW.donation_id)
     ))
  OR (NEW.target_kind = 'scholarship' AND
       (SELECT branch_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT (SELECT branch_id FROM donations WHERE id = NEW.donation_id))
  OR (NEW.target_kind = 'sponsorship' AND (
       (SELECT branch_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT (SELECT branch_id FROM donations WHERE id = NEW.donation_id)
       OR (SELECT donor_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT (SELECT donor_id FROM donations WHERE id = NEW.donation_id)
     ))
BEGIN SELECT RAISE(ABORT, 'restricted donation target does not match its source'); END;
CREATE TRIGGER IF NOT EXISTS trg_donation_restrictions_immutable_update
BEFORE UPDATE ON donation_restrictions
BEGIN SELECT RAISE(ABORT, 'donation restrictions cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_donation_restrictions_immutable_delete
BEFORE DELETE ON donation_restrictions
BEGIN SELECT RAISE(ABORT, 'donation restrictions cannot be deleted'); END;

-- An entry is a restricted campaign balance with exact source provenance. It
-- never changes cash: cash was recognized by the linked donation income row.
CREATE TABLE IF NOT EXISTS campaign_funding_entries (
  id                              TEXT PRIMARY KEY,
  campaign_id                     TEXT NOT NULL REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  source_donation_id              TEXT NOT NULL REFERENCES donations(id) ON DELETE RESTRICT,
  source_sponsorship_receipt_id   TEXT REFERENCES sponsorship_receipts(id) ON DELETE RESTRICT,
  sponsorship_agreement_id        TEXT REFERENCES sponsorship_agreements(id) ON DELETE RESTRICT,
  origin_kind                     TEXT NOT NULL CHECK (origin_kind IN ('restricted_donation','sponsorship_return')),
  amount                          INTEGER NOT NULL CHECK (amount > 0),
  reason                          TEXT,
  actor_user_id                   TEXT REFERENCES users(id) ON DELETE SET NULL,
  operator_name                   TEXT NOT NULL,
  branch_id                       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  date                            TEXT NOT NULL,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
       (origin_kind = 'restricted_donation' AND source_sponsorship_receipt_id IS NULL AND sponsorship_agreement_id IS NULL AND reason IS NULL)
    OR (origin_kind = 'sponsorship_return' AND source_sponsorship_receipt_id IS NOT NULL AND sponsorship_agreement_id IS NOT NULL AND length(trim(reason)) >= 8)
  )
);
CREATE INDEX IF NOT EXISTS idx_campaign_funding_entries_campaign ON campaign_funding_entries(campaign_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_funding_entries_donation ON campaign_funding_entries(source_donation_id);
CREATE INDEX IF NOT EXISTS idx_campaign_funding_entries_receipt ON campaign_funding_entries(source_sponsorship_receipt_id);

CREATE TABLE IF NOT EXISTS scholarship_fundings (
  id                         TEXT PRIMARY KEY,
  scholarship_id             TEXT NOT NULL REFERENCES scholarships(id) ON DELETE RESTRICT,
  donation_id                TEXT REFERENCES donations(id) ON DELETE RESTRICT,
  campaign_funding_entry_id  TEXT REFERENCES campaign_funding_entries(id) ON DELETE RESTRICT,
  amount                     INTEGER NOT NULL CHECK (amount > 0),
  branch_id                  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  operator_name              TEXT,
  date                       TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((donation_id IS NOT NULL AND campaign_funding_entry_id IS NULL) OR (donation_id IS NULL AND campaign_funding_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_scholarship_fundings_fund ON scholarship_fundings(scholarship_id);
CREATE INDEX IF NOT EXISTS idx_scholarship_fundings_donation ON scholarship_fundings(donation_id);
CREATE INDEX IF NOT EXISTS idx_scholarship_fundings_campaign_entry ON scholarship_fundings(campaign_funding_entry_id);

CREATE TABLE IF NOT EXISTS scholarship_awards (
  id             TEXT PRIMARY KEY,
  scholarship_id TEXT NOT NULL REFERENCES scholarships(id) ON DELETE RESTRICT,
  student_id     TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  award_date     TEXT NOT NULL,
  notes          TEXT,
  branch_id      TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  closed_at      TEXT,
  closed_by      TEXT,
  close_reason   TEXT,
  CHECK ((status = 'active' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_scholarship_awards_scholarship ON scholarship_awards(scholarship_id);
CREATE INDEX IF NOT EXISTS idx_scholarship_awards_student ON scholarship_awards(student_id);

-- ============================================================================
-- OBLIGATIONS AND ALLOCATIONS
-- ============================================================================
-- An obligation identifies the tuition debt; it intentionally does not mirror
-- the fee amount. Every active allocation names one real funding instrument.
CREATE TABLE IF NOT EXISTS student_obligations (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  branch_id   TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('tuition')),
  semester_id TEXT REFERENCES student_semesters(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind <> 'tuition' OR semester_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_tuition_semester ON student_obligations(semester_id) WHERE semester_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_obligations_student ON student_obligations(student_id, status);
CREATE TRIGGER IF NOT EXISTS trg_obligations_student_branch_insert
BEFORE INSERT ON student_obligations
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'obligation branch does not match student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_obligations_student_branch_update
BEFORE UPDATE OF student_id, branch_id ON student_obligations
WHEN (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'obligation branch does not match student branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_obligations_semester_owner_insert
BEFORE INSERT ON student_obligations
WHEN NEW.semester_id IS NOT NULL AND (SELECT student_id FROM student_semesters WHERE id = NEW.semester_id) IS NOT NEW.student_id
BEGIN SELECT RAISE(ABORT, 'obligation semester belongs to another student'); END;
CREATE TRIGGER IF NOT EXISTS trg_obligations_semester_owner_update
BEFORE UPDATE OF semester_id, student_id ON student_obligations
WHEN NEW.semester_id IS NOT NULL AND (SELECT student_id FROM student_semesters WHERE id = NEW.semester_id) IS NOT NEW.student_id
BEGIN SELECT RAISE(ABORT, 'obligation semester belongs to another student'); END;

CREATE TABLE IF NOT EXISTS student_installments (
  id              TEXT PRIMARY KEY,
  obligation_id   TEXT NOT NULL REFERENCES student_obligations(id) ON DELETE RESTRICT,
  sequence        INTEGER NOT NULL CHECK (sequence > 0),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  due_date        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((status = 'pending' AND paid_payment_id IS NULL) OR (status = 'paid' AND paid_payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_installment_obligation_sequence ON student_installments(obligation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_installments_obligation ON student_installments(obligation_id, status);
CREATE TRIGGER IF NOT EXISTS trg_installments_money_scale_insert
BEFORE INSERT ON student_installments WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'installment amount must be a whole number of AFN'); END;
CREATE TRIGGER IF NOT EXISTS trg_installments_money_scale_update
BEFORE UPDATE OF amount ON student_installments WHEN NEW.amount <> CAST(NEW.amount AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'installment amount must be a whole number of AFN'); END;

CREATE TABLE IF NOT EXISTS obligation_allocations (
  id                         TEXT PRIMARY KEY,
  obligation_id              TEXT NOT NULL REFERENCES student_obligations(id) ON DELETE RESTRICT,
  amount                     INTEGER NOT NULL CHECK (amount > 0),
  source_kind                TEXT NOT NULL CHECK (source_kind IN ('payment','scholarship','sponsorship')),
  payment_id                 TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  scholarship_award_id       TEXT REFERENCES scholarship_awards(id) ON DELETE RESTRICT,
  scholarship_funding_id     TEXT REFERENCES scholarship_fundings(id) ON DELETE RESTRICT,
  sponsorship_agreement_id   TEXT REFERENCES sponsorship_agreements(id) ON DELETE RESTRICT,
  sponsorship_receipt_id     TEXT REFERENCES sponsorship_receipts(id) ON DELETE RESTRICT,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  reversed_at                TEXT,
  reversed_by                TEXT,
  reversal_reason            TEXT,
  operator_name              TEXT,
  date                       TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
       (source_kind = 'payment' AND payment_id IS NOT NULL AND scholarship_award_id IS NULL AND scholarship_funding_id IS NULL AND sponsorship_agreement_id IS NULL AND sponsorship_receipt_id IS NULL)
    OR (source_kind = 'scholarship' AND scholarship_award_id IS NOT NULL AND scholarship_funding_id IS NOT NULL AND payment_id IS NULL AND sponsorship_agreement_id IS NULL AND sponsorship_receipt_id IS NULL)
    OR (source_kind = 'sponsorship' AND sponsorship_agreement_id IS NOT NULL AND sponsorship_receipt_id IS NOT NULL AND payment_id IS NULL AND scholarship_award_id IS NULL AND scholarship_funding_id IS NULL)
  ),
  CHECK ((status = 'active' AND reversed_at IS NULL) OR (status = 'reversed' AND reversed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_allocations_obligation ON obligation_allocations(obligation_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_award ON obligation_allocations(scholarship_award_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_scholarship_funding ON obligation_allocations(scholarship_funding_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_payment ON obligation_allocations(payment_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_sponsorship ON obligation_allocations(sponsorship_agreement_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_sponsorship_receipt ON obligation_allocations(sponsorship_receipt_id, status);

CREATE TABLE IF NOT EXISTS sponsorship_receipts (
  id                         TEXT PRIMARY KEY,
  agreement_id               TEXT NOT NULL REFERENCES sponsorship_agreements(id) ON DELETE RESTRICT,
  donation_id                TEXT REFERENCES donations(id) ON DELETE RESTRICT,
  campaign_funding_entry_id  TEXT REFERENCES campaign_funding_entries(id) ON DELETE RESTRICT,
  amount                     INTEGER NOT NULL CHECK (amount > 0),
  branch_id                  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  operator_name              TEXT,
  date                       TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((donation_id IS NOT NULL AND campaign_funding_entry_id IS NULL) OR (donation_id IS NULL AND campaign_funding_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_sponsorship_receipts_agreement ON sponsorship_receipts(agreement_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_receipts_donation ON sponsorship_receipts(donation_id);
CREATE INDEX IF NOT EXISTS idx_sponsorship_receipts_campaign_entry ON sponsorship_receipts(campaign_funding_entry_id);

-- Source/branch/target backstops. Application services provide clear errors;
-- these triggers prevent the same corruption through any other writer.
CREATE TRIGGER IF NOT EXISTS trg_scholarship_fundings_scope_insert
BEFORE INSERT ON scholarship_fundings
WHEN (SELECT branch_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT NEW.branch_id
  OR (NEW.donation_id IS NOT NULL AND (SELECT branch_id FROM donations WHERE id = NEW.donation_id) IS NOT NEW.branch_id)
  OR (NEW.campaign_funding_entry_id IS NOT NULL AND (SELECT branch_id FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id) IS NOT NEW.branch_id)
  OR (NEW.donation_id IS NOT NULL AND EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = NEW.donation_id AND (r.target_kind IS NOT 'scholarship' OR r.scholarship_id IS NOT NEW.scholarship_id)))
  OR (NEW.campaign_funding_entry_id IS NOT NULL AND (SELECT campaign_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT (SELECT campaign_id FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id))
BEGIN SELECT RAISE(ABORT, 'scholarship funding source scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorship_receipts_scope_insert
BEFORE INSERT ON sponsorship_receipts
WHEN (SELECT branch_id FROM sponsorship_agreements WHERE id = NEW.agreement_id) IS NOT NEW.branch_id
  OR (NEW.donation_id IS NOT NULL AND (SELECT branch_id FROM donations WHERE id = NEW.donation_id) IS NOT NEW.branch_id)
  OR (NEW.campaign_funding_entry_id IS NOT NULL AND (SELECT branch_id FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id) IS NOT NEW.branch_id)
  OR (NEW.donation_id IS NOT NULL AND (SELECT donor_id FROM donations WHERE id = NEW.donation_id) IS NOT (SELECT donor_id FROM sponsorship_agreements WHERE id = NEW.agreement_id))
  OR (NEW.donation_id IS NOT NULL AND EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = NEW.donation_id AND (r.target_kind IS NOT 'sponsorship' OR r.sponsorship_agreement_id IS NOT NEW.agreement_id)))
  OR (NEW.campaign_funding_entry_id IS NOT NULL AND ((SELECT campaign_id FROM sponsorship_agreements WHERE id = NEW.agreement_id) IS NOT (SELECT campaign_id FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id)
      OR (SELECT donor_id FROM donations WHERE id = (SELECT source_donation_id FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id)) IS NOT (SELECT donor_id FROM sponsorship_agreements WHERE id = NEW.agreement_id)))
BEGIN SELECT RAISE(ABORT, 'sponsorship receipt source scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_entries_scope_insert
BEFORE INSERT ON campaign_funding_entries
WHEN (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
  OR (SELECT branch_id FROM donations WHERE id = NEW.source_donation_id) IS NOT NEW.branch_id
  OR (NEW.origin_kind = 'restricted_donation' AND NOT EXISTS (SELECT 1 FROM donation_restrictions r WHERE r.donation_id = NEW.source_donation_id AND r.target_kind = 'campaign' AND r.campaign_id = NEW.campaign_id))
  OR (NEW.origin_kind = 'sponsorship_return' AND (
       (SELECT agreement_id FROM sponsorship_receipts WHERE id = NEW.source_sponsorship_receipt_id) IS NOT NEW.sponsorship_agreement_id
       OR (SELECT campaign_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT NEW.campaign_id
       OR COALESCE(
            (SELECT donation_id FROM sponsorship_receipts WHERE id = NEW.source_sponsorship_receipt_id),
            (SELECT source_donation_id FROM campaign_funding_entries
              WHERE id = (SELECT campaign_funding_entry_id FROM sponsorship_receipts WHERE id = NEW.source_sponsorship_receipt_id))
          ) IS NOT NEW.source_donation_id
  ))
BEGIN SELECT RAISE(ABORT, 'campaign funding entry source scope mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_funding_direct_donation_capacity_insert
BEFORE INSERT ON scholarship_fundings
WHEN NEW.donation_id IS NOT NULL AND NEW.amount > (
  (SELECT amount FROM donations WHERE id = NEW.donation_id)
  - COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE donation_id = NEW.donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE donation_id = NEW.donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM campaign_funding_entries WHERE source_donation_id = NEW.donation_id AND origin_kind = 'restricted_donation'), 0)
)
BEGIN SELECT RAISE(ABORT, 'donation funding source is over-allocated'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorship_direct_donation_capacity_insert
BEFORE INSERT ON sponsorship_receipts
WHEN NEW.donation_id IS NOT NULL AND NEW.amount > (
  (SELECT amount FROM donations WHERE id = NEW.donation_id)
  - COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE donation_id = NEW.donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE donation_id = NEW.donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM campaign_funding_entries WHERE source_donation_id = NEW.donation_id AND origin_kind = 'restricted_donation'), 0)
)
BEGIN SELECT RAISE(ABORT, 'donation funding source is over-allocated'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_entry_capacity_insert
BEFORE INSERT ON campaign_funding_entries
WHEN NEW.origin_kind = 'restricted_donation' AND NEW.amount > (
  (SELECT amount FROM donations WHERE id = NEW.source_donation_id)
  - COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE donation_id = NEW.source_donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE donation_id = NEW.source_donation_id), 0)
  - COALESCE((SELECT SUM(amount) FROM campaign_funding_entries WHERE source_donation_id = NEW.source_donation_id AND origin_kind = 'restricted_donation'), 0)
)
BEGIN SELECT RAISE(ABORT, 'donation campaign source is over-allocated'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_return_capacity_insert
BEFORE INSERT ON campaign_funding_entries
WHEN NEW.origin_kind = 'sponsorship_return' AND NEW.amount > (
  (SELECT amount FROM sponsorship_receipts WHERE id = NEW.source_sponsorship_receipt_id)
  - COALESCE((SELECT SUM(amount) FROM obligation_allocations WHERE sponsorship_receipt_id = NEW.source_sponsorship_receipt_id AND status = 'active'), 0)
  - COALESCE((SELECT SUM(amount) FROM campaign_funding_entries WHERE source_sponsorship_receipt_id = NEW.source_sponsorship_receipt_id), 0)
)
BEGIN SELECT RAISE(ABORT, 'sponsorship receipt return exceeds its available balance'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_source_capacity_scholarship_insert
BEFORE INSERT ON scholarship_fundings
WHEN NEW.campaign_funding_entry_id IS NOT NULL AND NEW.amount > (
  (SELECT amount FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id)
  - COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE campaign_funding_entry_id = NEW.campaign_funding_entry_id), 0)
  - COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE campaign_funding_entry_id = NEW.campaign_funding_entry_id), 0)
)
BEGIN SELECT RAISE(ABORT, 'campaign funding source is over-allocated'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_source_capacity_sponsorship_insert
BEFORE INSERT ON sponsorship_receipts
WHEN NEW.campaign_funding_entry_id IS NOT NULL AND NEW.amount > (
  (SELECT amount FROM campaign_funding_entries WHERE id = NEW.campaign_funding_entry_id)
  - COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE campaign_funding_entry_id = NEW.campaign_funding_entry_id), 0)
  - COALESCE((SELECT SUM(amount) FROM sponsorship_receipts WHERE campaign_funding_entry_id = NEW.campaign_funding_entry_id), 0)
)
BEGIN SELECT RAISE(ABORT, 'campaign funding source is over-allocated'); END;

CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_entries_immutable_update
BEFORE UPDATE ON campaign_funding_entries
BEGIN SELECT RAISE(ABORT, 'campaign funding entries cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_campaign_funding_entries_immutable_delete
BEFORE DELETE ON campaign_funding_entries
BEGIN SELECT RAISE(ABORT, 'campaign funding entries cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_fundings_immutable_update
BEFORE UPDATE ON scholarship_fundings
BEGIN SELECT RAISE(ABORT, 'scholarship funding facts cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_fundings_immutable_delete
BEFORE DELETE ON scholarship_fundings
BEGIN SELECT RAISE(ABORT, 'scholarship funding facts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorship_receipts_immutable_update
BEFORE UPDATE ON sponsorship_receipts
BEGIN SELECT RAISE(ABORT, 'sponsorship receipt facts cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorship_receipts_immutable_delete
BEFORE DELETE ON sponsorship_receipts
BEGIN SELECT RAISE(ABORT, 'sponsorship receipt facts cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_scope_insert
BEFORE INSERT ON scholarship_awards
WHEN (SELECT branch_id FROM scholarships WHERE id = NEW.scholarship_id) IS NOT NEW.branch_id
   OR (SELECT branch_id FROM students WHERE id = NEW.student_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'scholarship award branch scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_fund_capacity_insert
BEFORE INSERT ON scholarship_awards
WHEN NEW.status = 'active' AND NEW.amount > (
  COALESCE((SELECT SUM(amount) FROM scholarship_fundings WHERE scholarship_id = NEW.scholarship_id), 0)
  - COALESCE((SELECT SUM(amount) FROM scholarship_awards WHERE scholarship_id = NEW.scholarship_id AND status = 'active'), 0)
  - COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a JOIN scholarship_awards aw ON aw.id = a.scholarship_award_id
               WHERE aw.scholarship_id = NEW.scholarship_id AND aw.status = 'closed' AND a.status = 'active'), 0)
)
BEGIN SELECT RAISE(ABORT, 'scholarship fund has insufficient available money'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_aid_source_scope_insert
BEFORE INSERT ON obligation_allocations
WHEN (NEW.source_kind = 'scholarship' AND (
       (SELECT scholarship_id FROM scholarship_fundings WHERE id = NEW.scholarship_funding_id) IS NOT (SELECT scholarship_id FROM scholarship_awards WHERE id = NEW.scholarship_award_id)
       OR (SELECT branch_id FROM scholarship_awards WHERE id = NEW.scholarship_award_id) IS NOT (SELECT branch_id FROM student_obligations WHERE id = NEW.obligation_id)
       OR (SELECT student_id FROM scholarship_awards WHERE id = NEW.scholarship_award_id) IS NOT (SELECT student_id FROM student_obligations WHERE id = NEW.obligation_id)
     ))
  OR (NEW.source_kind = 'sponsorship' AND (
       (SELECT agreement_id FROM sponsorship_receipts WHERE id = NEW.sponsorship_receipt_id) IS NOT NEW.sponsorship_agreement_id
       OR (SELECT branch_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT (SELECT branch_id FROM student_obligations WHERE id = NEW.obligation_id)
       OR ((SELECT student_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT NULL
           AND (SELECT student_id FROM sponsorship_agreements WHERE id = NEW.sponsorship_agreement_id) IS NOT (SELECT student_id FROM student_obligations WHERE id = NEW.obligation_id))
     ))
BEGIN SELECT RAISE(ABORT, 'aid allocation source scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_scholarship_source_capacity_insert
BEFORE INSERT ON obligation_allocations
WHEN NEW.source_kind = 'scholarship' AND NEW.status = 'active' AND NEW.amount > (
  (SELECT amount FROM scholarship_fundings WHERE id = NEW.scholarship_funding_id)
  - COALESCE((SELECT SUM(amount) FROM obligation_allocations WHERE scholarship_funding_id = NEW.scholarship_funding_id AND status = 'active'), 0)
)
BEGIN SELECT RAISE(ABORT, 'scholarship funding source is exhausted'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_sponsorship_source_capacity_insert
BEFORE INSERT ON obligation_allocations
WHEN NEW.source_kind = 'sponsorship' AND NEW.status = 'active' AND NEW.amount > (
  (SELECT amount FROM sponsorship_receipts WHERE id = NEW.sponsorship_receipt_id)
  - COALESCE((SELECT SUM(amount) FROM obligation_allocations WHERE sponsorship_receipt_id = NEW.sponsorship_receipt_id AND status = 'active'), 0)
  - COALESCE((SELECT SUM(amount) FROM campaign_funding_entries WHERE source_sponsorship_receipt_id = NEW.sponsorship_receipt_id), 0)
)
BEGIN SELECT RAISE(ABORT, 'sponsorship receipt source is exhausted'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_award_capacity_insert
BEFORE INSERT ON obligation_allocations
WHEN NEW.source_kind = 'scholarship' AND NEW.status = 'active' AND NEW.amount > (
  (SELECT amount FROM scholarship_awards WHERE id = NEW.scholarship_award_id)
  - COALESCE((SELECT SUM(amount) FROM obligation_allocations WHERE scholarship_award_id = NEW.scholarship_award_id AND status = 'active'), 0)
)
BEGIN SELECT RAISE(ABORT, 'scholarship award is exhausted'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_closed_award_reverse
BEFORE UPDATE OF status ON obligation_allocations
WHEN OLD.source_kind = 'scholarship' AND OLD.status = 'active' AND NEW.status = 'reversed'
 AND (SELECT status FROM scholarship_awards WHERE id = OLD.scholarship_award_id) IS NOT 'active'
BEGIN SELECT RAISE(ABORT, 'a closed scholarship award cannot reverse an application'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_immutable_update
BEFORE UPDATE ON scholarship_awards
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'closed'
  AND NEW.id IS OLD.id AND NEW.scholarship_id IS OLD.scholarship_id AND NEW.student_id IS OLD.student_id
  AND NEW.amount IS OLD.amount AND NEW.award_date IS OLD.award_date AND NEW.notes IS OLD.notes
  AND NEW.branch_id IS OLD.branch_id AND NEW.closed_at IS NOT NULL AND NEW.closed_by IS NOT NULL
  AND NEW.close_reason IS NOT NULL AND length(trim(NEW.close_reason)) >= 8
)
BEGIN SELECT RAISE(ABORT, 'scholarship award facts are immutable except authorized closure'); END;
CREATE TRIGGER IF NOT EXISTS trg_scholarship_awards_immutable_delete
BEFORE DELETE ON scholarship_awards
BEGIN SELECT RAISE(ABORT, 'scholarship award facts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_immutable_update
BEFORE UPDATE ON obligation_allocations
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'reversed'
  AND NEW.id IS OLD.id AND NEW.obligation_id IS OLD.obligation_id AND NEW.amount IS OLD.amount
  AND NEW.source_kind IS OLD.source_kind AND NEW.payment_id IS OLD.payment_id
  AND NEW.scholarship_award_id IS OLD.scholarship_award_id AND NEW.scholarship_funding_id IS OLD.scholarship_funding_id
  AND NEW.sponsorship_agreement_id IS OLD.sponsorship_agreement_id AND NEW.sponsorship_receipt_id IS OLD.sponsorship_receipt_id
  AND NEW.operator_name IS OLD.operator_name AND NEW.date IS OLD.date AND NEW.created_at IS OLD.created_at
  AND NEW.reversed_at IS NOT NULL AND NEW.reversed_by IS NOT NULL AND NEW.reversal_reason IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'allocation facts are immutable except reversal'); END;
CREATE TRIGGER IF NOT EXISTS trg_allocations_immutable_delete
BEFORE DELETE ON obligation_allocations
BEGIN SELECT RAISE(ABORT, 'allocation facts cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_sponsorship_terminal_integrity_update
BEFORE UPDATE ON sponsorship_agreements
WHEN OLD.status <> 'active'
  OR (NEW.status IN ('completed','terminated') AND EXISTS (
    SELECT 1
      FROM sponsorship_receipts r
     WHERE r.agreement_id = OLD.id
       AND r.amount > COALESCE((SELECT SUM(a.amount) FROM obligation_allocations a WHERE a.sponsorship_receipt_id = r.id AND a.status = 'active'), 0)
                    + COALESCE((SELECT SUM(c.amount) FROM campaign_funding_entries c WHERE c.source_sponsorship_receipt_id = r.id), 0)
  ))
BEGIN SELECT RAISE(ABORT, 'terminal sponsorship requires every receipt balance to be resolved'); END;

CREATE TABLE IF NOT EXISTS impact_reports (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('branch','donor','campaign')),
  donor_id        TEXT REFERENCES donors(id) ON DELETE RESTRICT,
  campaign_id     TEXT REFERENCES funding_campaigns(id) ON DELETE RESTRICT,
  period_key      TEXT NOT NULL,
  period_from     TEXT NOT NULL,
  period_to       TEXT NOT NULL,
  generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  generated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  metrics         TEXT NOT NULL CHECK (json_valid(metrics) AND json_type(metrics) = 'array'),
  narrative       TEXT NOT NULL,
  idempotency_key TEXT,
  branch_id       TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  CHECK (
       (scope_kind = 'branch' AND donor_id IS NULL AND campaign_id IS NULL)
    OR (scope_kind = 'donor' AND donor_id IS NOT NULL AND campaign_id IS NULL)
    OR (scope_kind = 'campaign' AND campaign_id IS NOT NULL AND donor_id IS NULL)
  ),
  CHECK (period_from <= period_to)
);
CREATE INDEX IF NOT EXISTS idx_impact_reports_branch_generated ON impact_reports(branch_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_impact_reports_scope ON impact_reports(scope_kind, donor_id, campaign_id, period_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_impact_reports_idempotency ON impact_reports(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS trg_impact_reports_campaign_scope_insert
BEFORE INSERT ON impact_reports
WHEN NEW.scope_kind = 'campaign' AND (SELECT branch_id FROM funding_campaigns WHERE id = NEW.campaign_id) IS NOT NEW.branch_id
BEGIN SELECT RAISE(ABORT, 'impact report campaign belongs to another branch'); END;
CREATE TRIGGER IF NOT EXISTS trg_impact_reports_immutable_update
BEFORE UPDATE ON impact_reports
BEGIN SELECT RAISE(ABORT, 'impact report snapshots cannot be modified'); END;

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
