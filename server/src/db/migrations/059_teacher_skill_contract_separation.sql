-- ============================================================================
-- Migration 059 — Teacher SKILL / CONTRACT separation
-- ============================================================================
-- Forensic audit of the Teacher subsystem established two facts:
--
--   1. The authoritative contract vocabulary is the five-value CHECK created
--      by migration 029 on `teachers.salary_type`:
--          fixed | per_skill | per_session | hybrid | per_level
--      Application code (routes, payroll engine, frontend) had drifted to a
--      DIFFERENT six-value list using 'hybrid_skill'/'hybrid_level', which the
--      database physically cannot store. Any attempt to save those produced a
--      CHECK-constraint failure. This migration normalises any legacy rows so
--      code and database speak one vocabulary.
--
--   2. A SKILL (a row in `class_teacher_skills`) records a teacher's actual
--      teaching workload. It is NOT a compensation concept. Every contract
--      type must be able to record Skills; only payroll differs. The monthly
--      workload TARGET is therefore configuration data on the teacher, not a
--      hard-coded "30,000 AFG => 15 Skills" rule.
--
-- Existing data is preserved throughout.

-- ── 1. Normalise legacy contract values ─────────────────────────────────────
-- No-ops on a database whose CHECK already forbids these values; meaningful
-- only where the six-value variant of schema.sql created the table.
UPDATE teachers SET salary_type = 'hybrid' WHERE salary_type = 'hybrid_skill';
UPDATE teachers SET salary_type = 'per_level' WHERE salary_type = 'hybrid_level';

UPDATE teacher_compensation_history SET salary_type = 'hybrid' WHERE salary_type = 'hybrid_skill';
UPDATE teacher_compensation_history SET salary_type = 'per_level' WHERE salary_type = 'hybrid_level';

-- ── 2. Configurable monthly Skill (workload) target ─────────────────────────
-- Purely a workload/performance expectation. It NEVER changes salary by
-- itself; reports use it to derive Target / Actual / Shortfall / Excess.
-- 0 = no target configured.
ALTER TABLE teachers ADD COLUMN target_skills_per_month INTEGER NOT NULL DEFAULT 0;

-- The target is versioned alongside compensation so historical monthly
-- reports can state the target that applied in that period.
ALTER TABLE teacher_compensation_history ADD COLUMN target_skills_per_month INTEGER NOT NULL DEFAULT 0;

-- ── 3. Workload reporting indexes ───────────────────────────────────────────
-- Skills are analysed by teacher, class and period; these support the
-- monthly workload aggregation without table scans.
CREATE INDEX IF NOT EXISTS idx_cts_teacher_workload
ON class_teacher_skills(teacher_id, branch_id, assignment_type, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_cts_class_skill
ON class_teacher_skills(class_id, skill_id, teacher_id);
