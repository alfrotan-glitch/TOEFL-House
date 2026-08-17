-- ============================================================================
-- 067 — repair F-10 phantom cash left in finance_accounts
-- ============================================================================
-- WHY THIS EXISTS
--
-- F-10 (fixed in code, 2026-08-16): POST /books/sales/:saleId/refund wrote its
-- contra-revenue row straight into financial_transactions with a hand-rolled
-- INSERT. The sale credited cash through recordIncome(); the refund never
-- debited it. Every legacy refund therefore left money in finance_accounts
-- that the ledger says is gone:
--
--     ledger income sum      3500
--     finance_accounts       5000   (main 4750 + saving 250)
--     phantom cash           1500   = the legacy refunds
--
-- The code path is fixed, so no NEW divergence can be created. This migration
-- repairs rows that pre-date the fix. It is deliberately a SEPARATE, additive
-- migration: no historical migration is modified.
--
-- WHAT IT CHANGES
--
--   Table   : finance_accounts        (main_balance, saving_balance)
--   Table   : financial_transactions  (INSERT ONLY - one audit trail row per
--                                      corrected branch; nothing is updated or
--                                      deleted)
--   Never touched: payments, invoices, book_sales, students, enrollments,
--                  audit_logs, teacher_salary_ledger,
--                  teacher_compensation_history, student_journey_events.
--
-- It does NOT alter constraints, drop columns, or transform academic data.
-- It does NOT delete anything. History is preserved; the correction is made
-- as a forward-dated adjustment, exactly as a reversal would be.
--
-- HOW THE CORRECTION IS DERIVED
--
--   expected_cash(branch) = SUM(income) - SUM(saving_transfer)   [main]
--                           SUM(saving_transfer)                 [saving]
--
-- which is precisely the invariant computeReconciliation() already enforces
-- (utils/reconciliation.ts). We do not guess a figure: the ledger is the
-- authority and the accounts are moved to agree with it.
--
-- IDEMPOTENCY
--
-- Running this twice is safe, and two independent mechanisms make it so:
--
--   PRIMARY   After the first run the branch already agrees with its ledger,
--             so the `WHERE divergence` clause on both statements matches no
--             rows at all. Verified: removing the NOT EXISTS guard alone does
--             NOT break idempotency, because this clause is doing the work.
--   BACKSTOP  The NOT EXISTS guard on the deterministic marker id
--             ('tx_f10_' || branch_id) additionally prevents a duplicate audit
--             row if the migration were ever re-run against a database that
--             had diverged AGAIN for some unrelated reason.
--
-- There is no accumulating effect in either case.
--
-- BRANCH ISOLATION
--
-- Every statement is grouped BY branch and joins finance_accounts on
-- scope_id = branch_id, so one branch's ledger can never repair another's
-- balance. Organization-scope rows (scope_type='organization') are excluded:
-- the treasury is funded by capital_injection, not by branch income, and its
-- balance is not derived from this formula.
--
-- ROLLBACK
--
-- The pre-migration backup written by backupBeforeMigrations() (VACUUM INTO,
-- db/migrate.ts) is the rollback path. In addition, every correction is
-- recorded as a financial_transactions row, so the adjustment is auditable and
-- reversible by hand.
-- ============================================================================

-- 1) Audit trail FIRST, computed from the pre-correction state. Written only
--    for branches that actually diverge, and only once (NOT EXISTS guard makes
--    a second run a no-op).
INSERT INTO financial_transactions (
  id, type, category, amount, date, description,
  reference_id, operator_name, operator_role, branch_id
)
SELECT
  'tx_f10_' || v.branch_id,
  'income',
  'other',
  0,
  date('now'),
  'F-10 repair: finance_accounts realigned to the ledger. main ' ||
    CAST(v.actual_main AS TEXT) || ' -> ' || CAST(v.expected_main AS TEXT) ||
    ', saving ' || CAST(v.actual_saving AS TEXT) || ' -> ' || CAST(v.expected_saving AS TEXT),
  'migration_067',
  'System (migration 067)',
  'system',
  v.branch_id
FROM (
  SELECT
    fa.scope_id AS branch_id,
    fa.main_balance AS actual_main,
    fa.saving_balance AS actual_saving,
    COALESCE((SELECT SUM(CASE WHEN ft.type='income' AND ft.category <> 'capital_injection' THEN ft.amount
                              WHEN ft.type='saving_transfer' THEN -ft.amount
                              ELSE 0 END)
              FROM financial_transactions ft
              WHERE ft.branch_id = fa.scope_id), 0) AS expected_main,
    COALESCE((SELECT SUM(ft.amount) FROM financial_transactions ft
              WHERE ft.branch_id = fa.scope_id AND ft.type='saving_transfer'), 0) AS expected_saving
  FROM finance_accounts fa
  WHERE fa.scope_type = 'branch'
) v
WHERE (v.actual_main <> v.expected_main OR v.actual_saving <> v.expected_saving)
  AND NOT EXISTS (
    SELECT 1 FROM financial_transactions x
    WHERE x.id = 'tx_f10_' || v.branch_id
  );

-- 2) Realign the balances to the ledger. Guarded by the same divergence
--    condition, so untouched branches are not rewritten at all.
UPDATE finance_accounts
SET
  main_balance = COALESCE((
    SELECT SUM(CASE WHEN ft.type='income' AND ft.category <> 'capital_injection' THEN ft.amount
                    WHEN ft.type='saving_transfer' THEN -ft.amount
                    ELSE 0 END)
    FROM financial_transactions ft
    WHERE ft.branch_id = finance_accounts.scope_id), 0),
  saving_balance = COALESCE((
    SELECT SUM(ft.amount) FROM financial_transactions ft
    WHERE ft.branch_id = finance_accounts.scope_id AND ft.type='saving_transfer'), 0)
WHERE scope_type = 'branch'
  AND (
    main_balance <> COALESCE((
      SELECT SUM(CASE WHEN ft.type='income' AND ft.category <> 'capital_injection' THEN ft.amount
                      WHEN ft.type='saving_transfer' THEN -ft.amount
                      ELSE 0 END)
      FROM financial_transactions ft
      WHERE ft.branch_id = finance_accounts.scope_id), 0)
    OR
    saving_balance <> COALESCE((
      SELECT SUM(ft.amount) FROM financial_transactions ft
      WHERE ft.branch_id = finance_accounts.scope_id AND ft.type='saving_transfer'), 0)
  );
