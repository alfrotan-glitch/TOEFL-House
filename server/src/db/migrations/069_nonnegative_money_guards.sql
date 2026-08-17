-- 069 — Database-level sign guards for invoice, semester-fee and exam money
--
-- WHY
-- ---
-- The visitor→student conversion route validated its inputs with
-- `Number(amountPaid) < 0`, which is a coercion rather than a validation:
-- `Number("abc")` is NaN and `NaN < 0` is false, so rubbish passed the check.
-- Driving the real API produced persisted, permanently wrong financial rows:
--
--     semesterFee "abc"  -> raw "NOT NULL constraint failed" leaked to caller
--     semesterFee -6000  -> invoice with total_amount -6000, discount -6000
--     fee 0 + paid 50000 -> 50,000 AFN collected against a zero-fee enrolment
--
-- The routes are now fixed (they run every figure through `assertMoney`, the
-- same invariant the payment, refund and treasury paths already use). This
-- migration adds the second line of defence, because the tables themselves
-- happily accepted the bad values:
--
--   * `invoices` already has branch-integrity and two-decimal-scale triggers,
--     but NOTHING rejected a negative total. Verified directly against the
--     schema: inserting total_amount -5000 for a valid student succeeded.
--   * `exams.fee` had no guard at all and stored -100 without complaint.
--
-- Money in this system is never negative at rest. Refunds and voids are
-- recorded as separate contra rows in `financial_transactions`, not as
-- negative invoices or negative fees, so these guards do not constrain any
-- legitimate business flow.
--
-- WHAT THIS DOES
-- --------------
-- Adds BEFORE INSERT / BEFORE UPDATE triggers that ABORT on a negative value.
-- It creates no tables, alters no columns, rebuilds nothing, and writes no
-- data — so it cannot lose or transform a single existing row.
--
-- Existing rows are deliberately NOT rewritten. A trigger only constrains new
-- writes; any historical negative row (there are none in a healthy database)
-- stays visible for investigation rather than being silently "corrected".
--
-- Safe to run twice: every statement is DROP ... IF EXISTS followed by CREATE,
-- so re-running simply redefines identical triggers.

DROP TRIGGER IF EXISTS trg_invoices_nonnegative_insert;
CREATE TRIGGER trg_invoices_nonnegative_insert
BEFORE INSERT ON invoices
WHEN NEW.total_amount < 0 OR NEW.discount_amount < 0 OR NEW.net_amount < 0
BEGIN SELECT RAISE(ABORT, 'invoice amounts cannot be negative'); END;

DROP TRIGGER IF EXISTS trg_invoices_nonnegative_update;
CREATE TRIGGER trg_invoices_nonnegative_update
BEFORE UPDATE OF total_amount, discount_amount, net_amount ON invoices
WHEN NEW.total_amount < 0 OR NEW.discount_amount < 0 OR NEW.net_amount < 0
BEGIN SELECT RAISE(ABORT, 'invoice amounts cannot be negative'); END;

DROP TRIGGER IF EXISTS trg_student_semesters_nonnegative_insert;
CREATE TRIGGER trg_student_semesters_nonnegative_insert
BEFORE INSERT ON student_semesters
WHEN NEW.fee_amount < 0 OR (NEW.net_fee_amount IS NOT NULL AND NEW.net_fee_amount < 0)
BEGIN SELECT RAISE(ABORT, 'semester fee cannot be negative'); END;

DROP TRIGGER IF EXISTS trg_student_semesters_nonnegative_update;
CREATE TRIGGER trg_student_semesters_nonnegative_update
BEFORE UPDATE OF fee_amount, net_fee_amount ON student_semesters
WHEN NEW.fee_amount < 0 OR (NEW.net_fee_amount IS NOT NULL AND NEW.net_fee_amount < 0)
BEGIN SELECT RAISE(ABORT, 'semester fee cannot be negative'); END;

DROP TRIGGER IF EXISTS trg_exams_fee_nonnegative_insert;
CREATE TRIGGER trg_exams_fee_nonnegative_insert
BEFORE INSERT ON exams
WHEN NEW.fee < 0
BEGIN SELECT RAISE(ABORT, 'exam fee cannot be negative'); END;

DROP TRIGGER IF EXISTS trg_exams_fee_nonnegative_update;
CREATE TRIGGER trg_exams_fee_nonnegative_update
BEFORE UPDATE OF fee ON exams
WHEN NEW.fee < 0
BEGIN SELECT RAISE(ABORT, 'exam fee cannot be negative'); END;
