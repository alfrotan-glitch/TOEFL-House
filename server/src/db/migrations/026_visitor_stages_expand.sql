-- 026 — Visitor stage compatibility and finance lookup columns
--
-- schema.sql is the canonical current schema and already contains the expanded
-- visitor-stage CHECK. The migration is intentionally non-destructive on fresh
-- installs and does not rebuild `visitors` with SELECT *. Legacy databases whose
-- visitor CHECK still lacks the expanded stages are upgraded by the migration
-- runner's legacy-table compatibility handler before this file is executed.
--
-- This design prevents schema drift from turning a harmless fresh install into
-- a destructive table rebuild.

CREATE INDEX IF NOT EXISTS idx_visitors_branch ON visitors(branch_id);
CREATE INDEX IF NOT EXISTS idx_visitors_stage ON visitors(stage);
CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status);

ALTER TABLE student_semesters ADD COLUMN net_fee_amount REAL;

ALTER TABLE invoices ADD COLUMN student_name TEXT;
ALTER TABLE invoices ADD COLUMN student_code TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date);
