-- ============================================================================
-- 077 — Canonical hierarchical Finance Category model
-- ============================================================================
-- WHAT WAS WRONG
-- --------------
-- The ERP had no finance category entity. "Category" meant one of three
-- unrelated things:
--
--   budget_lines                     flat, per-branch, keyed by `purpose`
--   financial_transactions.category  free TEXT, no CHECK, no FK
--   payments.category                student BILLING categories (out of scope)
--
-- Consequences proven by reading the code before this migration:
--   * no parent/child, so "Utilities" could not own Electricity/Water/Gas;
--   * no accounting classification, so a fixed-asset purchase and a rent bill
--     were both "type='expense'" and both landed in operating cost;
--   * no ordering, no active flag, no channel/vendor concept — so a marketing
--     platform such as Facebook could only be modelled by inventing a bogus
--     "Facebook Advertising" ACCOUNTING category;
--   * `budget_lines` had no uniqueness guard on (branch_id, purpose) at all.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. `finance_categories`         two-level canonical taxonomy, organization
--                                   scoped, stable text ids, explicit
--                                   accounting classification, ordering,
--                                   active flag.
--   2. `finance_category_channels`  channels/vendors BELOW a subcategory, so
--                                   Facebook is a channel of Digital
--                                   Advertising and never a category.
--   3. budget_lines gains `category_id`, `channel_id`, `sort_order`,
--      `is_active`, `mapping_status`.
--   4. Integrity triggers: valid parent, inherited classification,
--      no duplicate (branch_id, purpose).
--
-- The explicit legacy `purpose` → canonical node mapping is migration 078. It
-- has to be a separate file because those UPDATEs write a FOREIGN KEY into
-- `finance_categories`, and the taxonomy ROWS are seeded from the TypeScript
-- source of truth by the runner hook that fires immediately before 078.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * It does not touch `financial_transactions`. Historical category strings
--     are immutable evidence; they are classified by LOOKUP
--     (core/finance/ledger-classification.ts), never by UPDATE. Rewriting them
--     would restate published P&L figures.
--   * It does not delete or rename a single existing budget line.
--   * It does not merge budget lines. Electricity, Water and Gas all fold under
--     ONE subcategory (Utilities) yet remain THREE budget lines, because each
--     is an independently funded envelope. Merging on name similarity is
--     exactly the mistake this model exists to prevent.
--   * It does not seed the taxonomy ROWS. Those come from the single
--     TypeScript source of truth (core/finance/category-taxonomy.ts) via
--     `db/financeCategoryCatalog.ts`. Duplicating 55 nodes in SQL would create a
--     second definition that could silently drift from the first.
--
-- IDEMPOTENCY
-- -----------
-- Every DDL statement uses IF NOT EXISTS; the ALTERs are covered by the
-- runner's proven duplicate-column path; every UPDATE is guarded by
-- `category_id IS NULL`, so a re-run is a no-op and an operator decision made
-- after the upgrade is never overwritten.
-- ============================================================================

-- ── 1. Canonical taxonomy ───────────────────────────────────────────────────
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
  -- A category is a root; a subcategory always has a parent. Enforced by the
  -- database so no writer can invent a third level or an orphan.
  CHECK ((level = 'category' AND parent_id IS NULL) OR (level = 'subcategory' AND parent_id IS NOT NULL)),
  -- A node may never be its own parent (the trigger below closes the general
  -- cycle case; this closes the degenerate one without a table scan).
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_finance_categories_parent ON finance_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_finance_categories_org    ON finance_categories(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_finance_categories_order  ON finance_categories(parent_id, sort_order);

-- Display names are not identifiers, but two SIBLINGS sharing a name is a data
-- entry error that would make the picker ambiguous.
-- Two PARTIAL indexes rather than one over `IFNULL(parent_id,'')`, for two
-- reasons: SQLite treats every NULL in a unique index as distinct, so a single
-- plain index would not constrain top-level categories at all; and an
-- EXPRESSION index reports a NULL column name to `PRAGMA index_info`, which the
-- fresh-schema preflight (rightly) rejects as unverifiable.
DROP INDEX IF EXISTS uq_finance_categories_sibling_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_categories_root_name
  ON finance_categories(organization_id, name COLLATE NOCASE) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_categories_child_name
  ON finance_categories(organization_id, parent_id, name COLLATE NOCASE) WHERE parent_id IS NOT NULL;

-- ── 2. Channels / vendors — Facebook lives HERE, not in the taxonomy ────────
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

-- ── 3. Budget lines become the THIRD level of the hierarchy ─────────────────
ALTER TABLE budget_lines ADD COLUMN category_id TEXT REFERENCES finance_categories(id) ON DELETE RESTRICT;
ALTER TABLE budget_lines ADD COLUMN channel_id TEXT REFERENCES finance_category_channels(id) ON DELETE SET NULL;
ALTER TABLE budget_lines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE budget_lines ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
-- Default is the HONEST one: a line nobody has classified needs a human.
-- The explicit mapping below promotes the ones that are provable.
ALTER TABLE budget_lines ADD COLUMN mapping_status TEXT NOT NULL DEFAULT 'needs_review';

CREATE INDEX IF NOT EXISTS idx_budget_lines_category ON budget_lines(category_id);
CREATE INDEX IF NOT EXISTS idx_budget_lines_branch_order ON budget_lines(branch_id, sort_order);

-- Deterministic display order for the legacy catalogue, so the Finance UI stops
-- depending on `ORDER BY id` / `ORDER BY name` accidents.
UPDATE budget_lines SET sort_order = CASE purpose
    WHEN 'teacher_salary'  THEN 10
    WHEN 'employee_salary' THEN 20
    WHEN 'rent'            THEN 30
    WHEN 'electricity'     THEN 40
    WHEN 'water'           THEN 50
    WHEN 'gas'             THEN 60
    WHEN 'internet'        THEN 70
    WHEN 'cleaning'        THEN 80
    WHEN 'maintenance'     THEN 90
    WHEN 'printing'        THEN 100
    WHEN 'kitchen'         THEN 110
    WHEN 'misc'            THEN 120
    WHEN 'equipment'       THEN 130
    WHEN 'marketing'       THEN 140
    WHEN 'transport'       THEN 150
    WHEN 'purchases'       THEN 160
    WHEN 'reserve'         THEN 170
    ELSE sort_order
  END
  WHERE sort_order = 0 AND purpose IS NOT NULL;

-- ── 4. Integrity triggers ───────────────────────────────────────────────────
-- A subcategory's parent must be a CATEGORY. Two levels, enforced in the
-- database: this is also what makes a cycle unreachable, because the only node
-- that may be a parent is a root.
DROP TRIGGER IF EXISTS trg_finance_categories_parent_is_root_insert;
CREATE TRIGGER trg_finance_categories_parent_is_root_insert
BEFORE INSERT ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT level FROM finance_categories WHERE id = NEW.parent_id) IS NOT 'category'
BEGIN
  SELECT RAISE(ABORT, 'finance category parent must be a top-level category');
END;

DROP TRIGGER IF EXISTS trg_finance_categories_parent_is_root_update;
CREATE TRIGGER trg_finance_categories_parent_is_root_update
BEFORE UPDATE OF parent_id, level ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND (SELECT level FROM finance_categories WHERE id = NEW.parent_id) IS NOT 'category'
BEGIN
  SELECT RAISE(ABORT, 'finance category parent must be a top-level category');
END;

-- A subcategory inherits its parent's accounting treatment. Without this a
-- "Vehicles" node could be filed under Capital Expenditure and still be
-- classified as an operating expense, which is precisely the defect the
-- taxonomy exists to remove.
DROP TRIGGER IF EXISTS trg_finance_categories_inherit_classification_insert;
CREATE TRIGGER trg_finance_categories_inherit_classification_insert
BEFORE INSERT ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND NEW.classification IS NOT (SELECT classification FROM finance_categories WHERE id = NEW.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'subcategory classification must match its parent category');
END;

DROP TRIGGER IF EXISTS trg_finance_categories_inherit_classification_update;
CREATE TRIGGER trg_finance_categories_inherit_classification_update
BEFORE UPDATE OF classification, parent_id ON finance_categories
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
  AND NEW.classification IS NOT (SELECT classification FROM finance_categories WHERE id = NEW.parent_id)
BEGIN
  SELECT RAISE(ABORT, 'subcategory classification must match its parent category');
END;

-- A budget line's channel must belong to the budget line's own category.
-- Otherwise "Facebook" could be attached to Rent Expense.
DROP TRIGGER IF EXISTS trg_budget_lines_channel_matches_category_insert;
CREATE TRIGGER trg_budget_lines_channel_matches_category_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.channel_id IS NOT NULL
  AND (SELECT category_id FROM finance_category_channels WHERE id = NEW.channel_id) IS NOT NEW.category_id
BEGIN
  SELECT RAISE(ABORT, 'budget line channel must belong to the same finance category');
END;

DROP TRIGGER IF EXISTS trg_budget_lines_channel_matches_category_update;
CREATE TRIGGER trg_budget_lines_channel_matches_category_update
BEFORE UPDATE OF channel_id, category_id ON budget_lines
FOR EACH ROW
WHEN NEW.channel_id IS NOT NULL
  AND (SELECT category_id FROM finance_category_channels WHERE id = NEW.channel_id) IS NOT NEW.category_id
BEGIN
  SELECT RAISE(ABORT, 'budget line channel must belong to the same finance category');
END;

-- (branch_id, purpose) had NO uniqueness guard of any kind. A UNIQUE INDEX
-- cannot be added safely here: an upgraded production database may already
-- contain duplicates, and this migration must never fail on, or silently
-- delete, real financial configuration. A BEFORE trigger enforces the invariant
-- for every future write while leaving existing rows untouched and reportable —
-- the same technique migration 065 used for the non-negative balance floor.
--
-- `id <> NEW.id` is load-bearing, not defensive noise. A BEFORE INSERT trigger
-- fires BEFORE SQLite applies conflict resolution, so without it an ordinary
-- `INSERT OR IGNORE` / `INSERT OR REPLACE` upsert of the SAME row would abort
-- instead of being ignored or replaced. Proven by the existing payroll and
-- operational-payment suites, which upsert their fixture line repeatedly.
DROP TRIGGER IF EXISTS trg_budget_lines_unique_purpose_insert;
CREATE TRIGGER trg_budget_lines_unique_purpose_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.purpose IS NOT NULL
  AND EXISTS (SELECT 1 FROM budget_lines WHERE branch_id = NEW.branch_id AND purpose = NEW.purpose AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a budget line with this purpose already exists for this branch');
END;

DROP TRIGGER IF EXISTS trg_budget_lines_unique_purpose_update;
CREATE TRIGGER trg_budget_lines_unique_purpose_update
BEFORE UPDATE OF purpose, branch_id ON budget_lines
FOR EACH ROW
WHEN NEW.purpose IS NOT NULL
  AND EXISTS (SELECT 1 FROM budget_lines WHERE branch_id = NEW.branch_id AND purpose = NEW.purpose AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a budget line with this purpose already exists for this branch');
END;
