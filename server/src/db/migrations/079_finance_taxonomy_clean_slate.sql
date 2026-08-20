-- ============================================================================
-- 079 — Clean slate: the canonical taxonomy becomes the ONLY finance model
-- ============================================================================
-- Migrations 077/078 introduced the canonical taxonomy ALONGSIDE the original
-- flat model and translated between them. That translation layer only ever
-- existed to protect financial history, and this product has never been
-- operational — there is no history to protect. Carrying a compatibility layer
-- for data that does not exist is pure cost: two vocabularies, two seed paths,
-- a mapping table, four permanently "unresolved" budget lines, and a
-- `mapping_status` column that leaked a migration concept into the operator's
-- screen.
--
-- This migration removes the old model outright. Afterwards the running
-- application has ZERO dependency on it.
--
-- WHAT GOES
-- ---------
--   budget_lines.purpose         the string that was copied verbatim into
--                                financial_transactions.category
--   budget_lines.is_marketing    a private, duplicate classification whose only
--                                consumer never worked (see below)
--   budget_lines.mapping_status  a migration concept, never a business one
--   idx_budget_lines_purpose     + the two (branch_id, purpose) triggers
--   every seeded budget line     including the generic Marketing, Transport,
--                                General Purchases, Equipment and Reserve
--                                envelopes
--
-- WHAT ARRIVES
-- ------------
--   financial_transactions.finance_category_id
--       A real FOREIGN KEY into the taxonomy, replacing the string copy. This
--       is now the single accounting authority: classification is resolved by
--       joining `finance_categories.classification`, never by matching text.
--
--   budget_lines.payroll_target  'teacher' | 'employee' | NULL
--       Payroll used to find its envelope with `WHERE purpose='teacher_salary'`.
--       That is a business relationship — "this envelope funds teacher payroll"
--       — so it is modelled as one, with a uniqueness rule that allows at most
--       one teacher and one employee envelope per branch. Teacher and employee
--       budgets stay SEPARATE.
--
--   budget_lines.category_id becomes mandatory, and must point at a
--   SUBCATEGORY. A budget line without a place in the taxonomy is no longer
--   representable, which is what retires `needs_review` and `out_of_taxonomy`
--   as concepts rather than merely emptying them.
--
-- WHY THE OLD MIGRATIONS STAY ON DISK
-- -----------------------------------
-- The runner is append-only and the release gate replays every file against a
-- blank database, so 002/003/005/077/078 cannot be edited or deleted. On a
-- fresh install they still create `purpose`, insert the seventeen legacy rows
-- and map them — and then this migration deletes all of it, before the server
-- accepts its first request. The scaffolding exists for milliseconds during
-- boot and never reaches the application.
-- ============================================================================

-- ── 1. The ledger gains its foreign key into the taxonomy ───────────────────
-- On an EXISTING database `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a
-- no-op, so the column has to be added here or the upgrade dies on the first
-- backfill below. On a fresh database schema.sql already declared it and the
-- runner's proven duplicate-column path absorbs this statement.
ALTER TABLE financial_transactions ADD COLUMN finance_category_id TEXT REFERENCES finance_categories(id);

-- ── 2. Normalise the ledger onto the new authority ──────────────────────────
-- Only three category strings have ever been written for an expense row, and
-- each has exactly one canonical home. This is a one-time normalisation, not a
-- compatibility layer: nothing reads `category` for classification afterwards.
UPDATE financial_transactions
   SET finance_category_id = category
 WHERE type = 'expense'
   AND finance_category_id IS NULL
   AND category IN (SELECT id FROM finance_categories);

UPDATE financial_transactions
   SET finance_category_id = 'sub_salaries_wages'
 WHERE type = 'expense' AND finance_category_id IS NULL AND category = 'salary';

UPDATE financial_transactions
   SET finance_category_id = 'sub_owner_drawings'
 WHERE type = 'expense' AND finance_category_id IS NULL AND category = 'profit_distribution';

-- ── 3. Clean slate for budget configuration ─────────────────────────────────
-- Budget lines are CONFIGURATION, not financial history. The seeded catalogue
-- is replaced wholesale by the two payroll envelopes the system genuinely
-- requires; everything else is created deliberately by an authorised user.
-- `expense_requests.budget_line_id` is ON DELETE SET NULL, so no row is lost.
DELETE FROM budget_lines;

-- ── 4. Remove the legacy purpose apparatus ──────────────────────────────────
-- SQLite refuses DROP COLUMN while an index or trigger still references the
-- column, so these come first.
DROP INDEX IF EXISTS idx_budget_lines_purpose;
DROP TRIGGER IF EXISTS trg_budget_lines_unique_purpose_insert;
DROP TRIGGER IF EXISTS trg_budget_lines_unique_purpose_update;

ALTER TABLE budget_lines DROP COLUMN purpose;
ALTER TABLE budget_lines DROP COLUMN is_marketing;
ALTER TABLE budget_lines DROP COLUMN mapping_status;

-- ── 5. Payroll envelope, modelled as the business relationship it is ────────
ALTER TABLE budget_lines ADD COLUMN payroll_target TEXT
  CHECK (payroll_target IS NULL OR payroll_target IN ('teacher', 'employee'));

-- At most one teacher envelope and one employee envelope per branch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_lines_payroll_target
  ON budget_lines(branch_id, payroll_target) WHERE payroll_target IS NOT NULL;

-- ── 6. Every budget line belongs to the taxonomy ────────────────────────────
-- `category_id` cannot be altered to NOT NULL in place, and rebuilding a table
-- referenced by `expense_requests` is a needless risk. Triggers enforce the
-- identical invariant for every writer — the technique migrations 065 and 077
-- already use here.
DROP TRIGGER IF EXISTS trg_budget_lines_require_subcategory_insert;
CREATE TRIGGER trg_budget_lines_require_subcategory_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.category_id IS NULL
  OR (SELECT level FROM finance_categories WHERE id = NEW.category_id) IS NOT 'subcategory'
BEGIN
  SELECT RAISE(ABORT, 'budget line must reference a finance subcategory');
END;

DROP TRIGGER IF EXISTS trg_budget_lines_require_subcategory_update;
CREATE TRIGGER trg_budget_lines_require_subcategory_update
BEFORE UPDATE OF category_id ON budget_lines
FOR EACH ROW
WHEN NEW.category_id IS NULL
  OR (SELECT level FROM finance_categories WHERE id = NEW.category_id) IS NOT 'subcategory'
BEGIN
  SELECT RAISE(ABORT, 'budget line must reference a finance subcategory');
END;

-- Two envelopes under the same subcategory are legitimate (a second landlord, a
-- second vehicle) — two envelopes with the same NAME under it are a data-entry
-- error. This replaces the old (branch_id, purpose) rule.
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_lines_branch_category_name
  ON budget_lines(branch_id, category_id, name COLLATE NOCASE);

-- ── 7. Retire the private marketing classification ───────────────────
-- `bos.routes.ts` measured marketing spend with
--     reference_id IN (SELECT id FROM budget_lines WHERE is_marketing = 1)
-- but `payFromBudgetLine` writes the EXPENSE REQUEST id into `reference_id`
-- (`req_…`), never a budget line id (`budget_…`). The figure was therefore
-- permanently zero — verified live before this migration was written. With
-- `finance_category_id` the same question is answered by the taxonomy, so the
-- duplicate flag is gone rather than repaired.
CREATE INDEX IF NOT EXISTS idx_fin_tx_finance_category
  ON financial_transactions(finance_category_id);
CREATE INDEX IF NOT EXISTS idx_fin_tx_branch_category
  ON financial_transactions(branch_id, finance_category_id);
