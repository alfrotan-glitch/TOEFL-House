-- ============================================================================
-- 076 — DISCOUNT AUTHORIZATION & ELIGIBILITY (CFG-1)
-- ============================================================================
-- A Rule Engine rule is NEVER authorization for a discount above the ordinary
-- ceiling. Before this migration the only representation of a discount was
-- `students.discount_percent REAL` — an unqualified number with no category,
-- no eligibility, no approver and no audit trail. A branch manager could
-- therefore create a rule (`conditions:[]`, `discountPercent:95`) and mint an
-- arbitrary discount: reproduced live at priorities 1/10/199 (-> 95%) and
-- 201/999/10000 (-> 30%), every one of them above the 20% ordinary maximum.
--
-- These tables give the system the vocabulary the policy requires:
--   RULE  = a calculation
--   THESE = the authorization
--
-- Nothing here grants a discount by itself. `discount-authority.ts` reads
-- them, verifies eligibility, applies the per-category maximum and produces
-- the final authorized discount, which is then snapshotted by the caller.
-- ============================================================================

-- Authoritative household identity. Free-text `father_name` is NOT identity,
-- so "family of 4 or more" is counted from this grouping instead of from a
-- client-supplied number.
CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  branch_id  TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A student belongs to at most one household. The family-size count is derived
-- from this column, never from request input.
ALTER TABLE students ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_students_household ON students(household_id);

-- Relationship to an actual teacher/employee identity. `degree` is 1 or 2 and
-- maps to the two relative categories; the FK guarantees the counterparty is a
-- real staff member rather than a name typed into a form.
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

-- The authorization record. A discount category above the ordinary ceiling is
-- valid only while a row here is `active`, in date, and scoped to the
-- student's own branch.
--
-- `approved_percent` is what an approver actually granted; the resolver still
-- clamps it to the category maximum, so a bad row cannot exceed policy.
-- Approver authority per category is enforced in the route layer:
--   FIRST_DEGREE_RELATIVE and SPONSORSHIP require owner; the rest allow
--   manager (see discount-authority.ts APPROVER_ROLE).
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

-- An authorization may never store a negative or non-finite percentage. The
-- per-category ceiling is applied by the resolver; this is the storage floor.
CREATE TRIGGER IF NOT EXISTS trg_discount_auth_percent_insert
BEFORE INSERT ON student_discount_authorizations
WHEN NEW.approved_percent < 0 OR NEW.approved_percent > 100
BEGIN SELECT RAISE(ABORT, 'approved_percent must be between 0 and 100'); END;

CREATE TRIGGER IF NOT EXISTS trg_discount_auth_percent_update
BEFORE UPDATE OF approved_percent ON student_discount_authorizations
WHEN NEW.approved_percent < 0 OR NEW.approved_percent > 100
BEGIN SELECT RAISE(ABORT, 'approved_percent must be between 0 and 100'); END;
