-- ============================================================================
-- 066 — a VOIDED full salary payment must not block the period forever
-- ============================================================================
-- DEFECT (proven live, 2026-08-16 second audit pass):
--
--   1. Clerk pays a teacher 10,000 AFN "full" for 1405-09  -> 201
--   2. Wrong amount; clerk voids it                        -> 200, budget restored
--   3. Clerk re-pays the correct amount                    -> 409, FOREVER
--
--   The teacher can never be paid for that month again. Voiding is presented
--   as a correction mechanism, so it has to actually release what it reverses.
--
-- TWO independent causes, both fixed:
--
--   (a) Application: sumPaidForPeriod() and hasFullPayForPeriod() in
--       core/payroll/class-payroll.ts summed EVERY ledger row regardless of
--       status, so a voided payment still counted as money paid
--       ("Nothing remains payable"). Fixed in that file — both now filter
--       status = 'posted'.
--
--   (b) Schema (this migration): uq_teacher_salary_full_period is a partial
--       UNIQUE index on (teacher_id, period_key) WHERE payment_type = 'full'.
--       It did not exclude voided rows, so even after (a) the re-payment hit
--       "A record with this unique information already exists".
--
-- The index still does its real job — preventing TWO LIVE full payments for
-- the same teacher and period — but a voided row no longer occupies the slot.
-- Dropping and recreating a partial index is safe and non-destructive: no data
-- is touched, and the rebuilt index is immediately consistent.
-- ============================================================================

DROP INDEX IF EXISTS uq_teacher_salary_full_period;

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_salary_full_period
ON teacher_salary_ledger(teacher_id, period_key)
WHERE payment_type = 'full' AND status = 'posted';
