-- ============================================================================
-- Migration 002: Add semantic 'purpose' column to budget_lines
-- ============================================================================
-- Audit §3.2: Salary payment was hardcoded to budget_lines.id = 'b1'/'b2'.
-- This migration adds a stable semantic key so lookups work regardless of
-- how budget lines were created.
--
-- NOTE: ALTER TABLE ADD COLUMN is NOT idempotent in SQLite. The migration
-- runner (migrate.ts) catches "duplicate column name" and marks this
-- migration as applied if the column already exists.
-- ============================================================================

ALTER TABLE budget_lines ADD COLUMN purpose TEXT;

-- Backfill existing seed data with semantic purposes.
-- WHERE purpose IS NULL makes these safe to re-run.
UPDATE budget_lines SET purpose = 'teacher_salary'   WHERE id = 'b1'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'employee_salary'  WHERE id = 'b2'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'rent'             WHERE id = 'b3'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'electricity'      WHERE id = 'b4'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'internet'         WHERE id = 'b5'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'marketing'        WHERE id = 'b6'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'printing'         WHERE id = 'b7'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'equipment'        WHERE id = 'b8'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'kitchen'          WHERE id = 'b9'  AND purpose IS NULL;
UPDATE budget_lines SET purpose = 'reserve'          WHERE id = 'b10' AND purpose IS NULL;

CREATE INDEX IF NOT EXISTS idx_budget_lines_purpose ON budget_lines(purpose);