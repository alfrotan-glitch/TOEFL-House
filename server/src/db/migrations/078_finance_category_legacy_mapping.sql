-- ============================================================================
-- 078 — Explicit legacy budget-line → canonical category mapping
-- ============================================================================
-- Migration 077 created the hierarchy. This one attaches the EXISTING budget
-- lines to it.
--
-- WHY THIS IS A SEPARATE FILE
-- ---------------------------
-- Every statement below writes a FOREIGN KEY into `finance_categories`, so the
-- 55 canonical nodes must already exist. They are seeded from the single
-- TypeScript source of truth (`core/finance/category-taxonomy.ts`, applied by
-- `db/financeCategoryCatalog.ts`) by the runner hook in `db/migrate.ts` that
-- fires immediately before this file. Splitting the two keeps the taxonomy
-- defined exactly once instead of once in TypeScript and once in SQL.
--
-- HOW THE MAPPING WAS DECIDED
-- ---------------------------
-- Every statement is a decision with a stated reason. Nothing is mapped because
-- two names look alike, and nothing ambiguous is guessed:
--
--   * Electricity, Water and Gas fold under ONE subcategory (Utilities) yet
--     remain THREE budget lines — each is an independently funded envelope and
--     merging them would destroy three budgets.
--   * Teacher and employee payroll likewise share Salaries & Wages while
--     staying two envelopes.
--   * Three legacy lines could not be resolved without guessing and are marked
--     `needs_review` instead. One is deliberately outside the taxonomy.
--
-- IDEMPOTENCY
-- -----------
-- `WHERE category_id IS NULL` makes each statement a no-op on re-run AND makes
-- it impossible for a re-run to overwrite a decision an operator made after the
-- upgrade.
--
-- HISTORY
-- -------
-- `financial_transactions` is not touched. Historical category strings are
-- immutable evidence and are classified by LOOKUP
-- (core/finance/ledger-classification.ts), never by UPDATE — rewriting them
-- would restate published P&L figures.
-- ============================================================================
-- The identical map lives in core/finance/category-taxonomy.ts and is applied
-- to branches created AFTER this migration.
-- `finance-category-taxonomy.test.ts` parses THIS FILE and asserts the two
-- agree statement for statement, so they cannot drift.

-- Personnel & Payroll → Salaries & Wages.
-- Teacher and employee payroll stay TWO budget lines under ONE subcategory:
-- same accounting meaning, different envelopes.
UPDATE budget_lines SET category_id = 'sub_salaries_wages', mapping_status = 'mapped'
  WHERE purpose = 'teacher_salary' AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'sub_salaries_wages', mapping_status = 'mapped'
  WHERE purpose = 'employee_salary' AND category_id IS NULL;

-- Premises & Facilities.
UPDATE budget_lines SET category_id = 'sub_rent', mapping_status = 'mapped'
  WHERE purpose = 'rent' AND category_id IS NULL;
-- Three separate utility envelopes, one subcategory. NOT merged.
UPDATE budget_lines SET category_id = 'sub_utilities', mapping_status = 'mapped'
  WHERE purpose IN ('electricity','water','gas') AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'sub_internet_communication', mapping_status = 'mapped'
  WHERE purpose = 'internet' AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'sub_cleaning_sanitation', mapping_status = 'mapped'
  WHERE purpose = 'cleaning' AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'sub_repair_maintenance', mapping_status = 'mapped'
  WHERE purpose = 'maintenance' AND category_id IS NULL;

-- Office & Administration.
UPDATE budget_lines SET category_id = 'sub_printing', mapping_status = 'mapped'
  WHERE purpose = 'printing' AND category_id IS NULL;

-- Food & General Operations.
UPDATE budget_lines SET category_id = 'sub_food_catering', mapping_status = 'mapped'
  WHERE purpose = 'kitchen' AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'sub_miscellaneous', mapping_status = 'mapped'
  WHERE purpose = 'misc' AND category_id IS NULL;

-- Capital Expenditure — subcategory NOT decidable.
--
-- FINALIZATION AUDIT (2026-08-20): a repository-wide sweep of every
-- `purpose='equipment'` reference at the pre-migration commit returns three
-- hits, and only one carries meaning — the seed catalogue's `Monitor` icon.
-- There is no expense request, no ledger row, no report, no business rule, no
-- description, no Dari original and no fixture that references it anywhere.
--
-- One artefact is not enough to assert IT Equipment over Office Equipment, so
-- the subcategory is left to a human. The ACCOUNTING TREATMENT is unaffected:
-- both candidates sit under Capital Expenditure, so the line classifies as
-- capital expenditure either way and no P&L figure depends on the outcome.
UPDATE budget_lines SET category_id = 'cat_capital_expenditure', mapping_status = 'needs_review'
  WHERE purpose = 'equipment' AND category_id IS NULL;

-- AMBIGUOUS — parent certain, subcategory NOT decidable from the data.
-- Attached at CATEGORY level so the accounting treatment is unambiguous while
-- the subcategory is left to a human. Guessing "Digital Advertising" here would
-- have been indistinguishable from a correct answer in the UI and wrong in the
-- ledger.
UPDATE budget_lines SET category_id = 'cat_marketing_promotion', mapping_status = 'needs_review'
  WHERE purpose = 'marketing' AND category_id IS NULL;
UPDATE budget_lines SET category_id = 'cat_transport_logistics', mapping_status = 'needs_review'
  WHERE purpose = 'transport' AND category_id IS NULL;

-- AMBIGUOUS — not even the parent is decidable. "General Purchases" is equally
-- consistent with Office Supplies, Teaching Materials and Miscellaneous, so
-- NOTHING is asserted. It keeps its pre-migration behaviour (operating
-- expense) and is reported for an owner decision.
UPDATE budget_lines SET mapping_status = 'needs_review'
  WHERE purpose = 'purchases' AND category_id IS NULL;

-- OUT OF TAXONOMY — a contingency reserve is not an expense classification, and
-- the BOS profit-withdrawal rule already depends on a reserve target. The line
-- stays fully operational; it is simply not part of the expense model.
UPDATE budget_lines SET mapping_status = 'out_of_taxonomy'
  WHERE purpose = 'reserve' AND category_id IS NULL;

