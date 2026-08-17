-- 071 — Composite ledger index for Dashboard/Finance aggregates
--
-- WHY
-- ---
-- Every Dashboard and Finance money figure is a range aggregate over
-- `financial_transactions`, filtered by branch and a date window, and usually
-- split by type:
--
--     WHERE branch_id = ? AND date >= ? AND date <= ?        -- cash flow
--     WHERE type = ? AND branch_id = ? AND date BETWEEN ? AND ?  -- period totals
--
-- The table only had SINGLE-column indexes (branch_id, date, type). SQLite can
-- use just one per table reference, so the planner was choosing
-- `idx_fin_tx_type` — a column with exactly two distinct values ('income',
-- 'expense'). That scans roughly half the ledger to answer a question about
-- seven days, and the cash-flow query additionally had to build a temp B-tree
-- to satisfy its GROUP BY:
--
--     SEARCH financial_transactions USING INDEX idx_fin_tx_type (type=?)
--     USE TEMP B-TREE FOR GROUP BY
--
-- Measured on a 60,882-row ledger (audit finding D-11):
--
--     7-day cash flow   6.31 ms  ->  0.50 ms   (12.6x)
--     month-to-date sum 9.12 ms  ->  0.84 ms   (10.9x)
--     year-to-date sum 10.11 ms  ->  6.86 ms
--
-- and the temp B-tree disappears, because (branch_id, date) already yields
-- rows in date order within a branch.
--
-- Column order is deliberate: branch_id first (high selectivity and an
-- equality predicate, and it is how every branch-scoped query starts), then
-- date (the range predicate, which must follow the equality), then type so the
-- common type filter can be answered from the index.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- Index-only change. No table is rebuilt, no row is written, no constraint
-- changes, and no historical migration is touched. Existing single-column
-- indexes are left in place: other queries filter on date or type alone, and
-- dropping them is a separate decision with its own risk.
--
-- Safe to re-run; `IF NOT EXISTS` and the matching declaration in schema.sql
-- keep a fresh install and a migrated install byte-identical.

CREATE INDEX IF NOT EXISTS idx_fin_tx_branch_date_type
  ON financial_transactions(branch_id, date, type);

-- Payments carry the same access shape for "collected this month".
CREATE INDEX IF NOT EXISTS idx_payments_branch_date
  ON payments(branch_id, date);
