-- ============================================================================
-- 059 — Teacher workload target: configurable Target Skills per month
-- ============================================================================
-- Adds a configurable monthly teaching-workload target per teacher (Phase 7 of
-- the Teacher forensic audit). This is workload configuration ONLY: it never
-- changes salary by itself — compensation follows the contract type's rule.
-- Reports surface Target / Actual / Shortfall / Excess.
-- ============================================================================

ALTER TABLE teachers ADD COLUMN target_skills_per_month INTEGER;
