-- ============================================================================
-- 054 — Traceability: operator position on financial transactions
-- ============================================================================
-- Every financial transaction must preserve who performed it (operator_name)
-- AND the position they held at the time (operator_role). Position is derived
-- from the authenticated user's identity role at write time and stored on the
-- row so historical traceability survives later position changes.
-- ============================================================================

ALTER TABLE financial_transactions ADD COLUMN operator_role TEXT;
