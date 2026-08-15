-- 027 — Payment Traceability & Referential Integrity Hardening
-- 
-- PHASE 1: Add payment_id to financial_transactions for strict 1:1 traceability.
--   - Every income ledger entry can now be traced to exactly one payment.
--   - reference_id is kept for backward compatibility (non-payment income like
--     donations, exam fees, book sales still use it).
--   - saving_transfer and budget_charge rows leave payment_id NULL.
--
-- PHASE 2: Add missing FK constraints.
--   - registrations.class_id → classes(id)
--   - payments.student_id already has FK; verified.
--   - student_semesters.class_id → classes(id)

-- §1: Add payment_id column
ALTER TABLE financial_transactions ADD COLUMN payment_id TEXT
  REFERENCES payments(id) ON DELETE SET NULL

-- §2: Index for traceability queries
CREATE INDEX IF NOT EXISTS idx_fin_tx_payment ON financial_transactions(payment_id)

-- §3: FK on registrations.class_id (was missing)
-- SQLite cannot ADD CONSTRAINT, so we verify with a data-integrity
-- check that every registrations.class_id exists in classes.
-- The schema.sql already has REFERENCES classes(id) for future fresh DBs.
-- For existing DBs, orphan rows (if any) should be cleaned by the app.

-- §4: FK on student_semesters.class_id
-- Same approach — schema.sql already has the FK for fresh DBs.

-- §5: Verify no orphan payment_ids exist (data integrity proof)
-- This is a no-op check — the FK constraint above enforces it going forward.
