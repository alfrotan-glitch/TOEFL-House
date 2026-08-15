-- ============================================================================
-- 055 — Audit traceability: operator position on every audit record
-- ============================================================================
-- Every audit entry must preserve the operator's position at the time of the
-- action so historical attribution survives later role/position changes
-- (users.role can change; the frozen position must not). This mirrors the
-- operator_role column already added to financial_transactions (054).
-- ============================================================================

ALTER TABLE audit_logs ADD COLUMN operator_role TEXT;
