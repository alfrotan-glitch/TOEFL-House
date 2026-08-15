-- ============================================================================
-- 005 — Clear demo finance numbers so balances come only from real operations
-- ============================================================================
-- This zeroes main/savings settings and all budget line amounts.
-- Ledger rows from the old seed are removed. Re-run is safe (idempotent zeroes).
-- ============================================================================

UPDATE system_settings SET value = '0' WHERE key IN ('main_account_balance', 'saving_balance');

UPDATE budget_lines SET current_amount = 0, allocated_amount = 0;

-- Remove seeded demo ledger entries (ids tx1..tx9 from old seed)
DELETE FROM financial_transactions WHERE id IN ('tx1','tx2','tx3','tx4','tx5','tx6','tx7','tx8','tx9');

-- Remove seeded demo expense requests
DELETE FROM expense_requests WHERE id IN ('req1','req2','req3');

-- Ensure English-only names for operational lines (if Persian parentheses remain)
UPDATE budget_lines SET name = 'Electricity' WHERE purpose = 'electricity' AND name LIKE '%برق%';
UPDATE budget_lines SET name = 'Internet' WHERE purpose = 'internet' AND name LIKE '%اینترنت%';
UPDATE budget_lines SET name = 'Kitchen & Refreshments' WHERE purpose = 'kitchen' AND name LIKE '%آشپزخانه%';
UPDATE budget_lines SET name = 'Water' WHERE purpose = 'water' AND (name LIKE '%آب%' OR name LIKE '%Water%');
UPDATE budget_lines SET name = 'Gas' WHERE purpose = 'gas' AND (name LIKE '%گاز%' OR name LIKE '%Gas%');
UPDATE budget_lines SET name = 'Maintenance & Repairs' WHERE purpose = 'maintenance' AND name LIKE '%تعمیرات%';
UPDATE budget_lines SET name = 'General Purchases' WHERE purpose = 'purchases' AND name LIKE '%خرید%';
UPDATE budget_lines SET name = 'Cleaning & Hygiene' WHERE purpose = 'cleaning' AND name LIKE '%نظافت%';
UPDATE budget_lines SET name = 'Transport' WHERE purpose = 'transport' AND name LIKE '%ترانسپورت%';
UPDATE budget_lines SET name = 'Miscellaneous' WHERE purpose = 'misc' AND name LIKE '%متفرقه%';
