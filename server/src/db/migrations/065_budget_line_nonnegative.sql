-- ============================================================================
-- 065 — budget_lines.current_amount may never go negative
-- ============================================================================
-- INCONSISTENT INVARIANT (found 2026-08-16, second audit pass):
--
--   books.stock           has trg_books_stock_nonnegative_{insert,update}
--   finance_accounts      has CHECK (main_balance >= 0), CHECK (saving_balance >= 0)
--   budget_lines.current_amount  had NO floor of any kind
--
-- Proven: a direct UPDATE drove a funded budget line to -998,999 and the
-- database accepted it silently.
--
-- Two of the four application decrement sites guard with
-- `AND current_amount >= ?` and check `changes === 1`; the other two do not.
-- Today no overdraw is reachable over HTTP because better-sqlite3 is
-- synchronous — a read and its follow-up write cannot be interleaved by
-- another request inside one process — but that is a property of the driver,
-- not of the data model. It would silently stop holding under a second
-- process, a worker thread, an external maintenance script, or any future move
-- off better-sqlite3, and an overdrawn budget line is a real financial
-- misstatement: it reports money spent that was never allocated.
--
-- The floor belongs in the database, where every writer is subject to it,
-- exactly as it already is for stock and for cash accounts. Application-level
-- guards remain (they produce the friendly 409); this is the backstop that
-- makes the invariant true rather than merely usually-true.
--
-- SQLite cannot add a CHECK to an existing column without rebuilding the
-- table, and budget_lines is referenced by expense_requests. A BEFORE trigger
-- enforces the identical constraint in place, with no rebuild risk.
-- ============================================================================

-- Repair any row that is already negative before enforcing the rule, so the
-- constraint cannot be tripped by pre-existing bad data on first boot.
UPDATE budget_lines SET current_amount = 0 WHERE current_amount < 0;

DROP TRIGGER IF EXISTS trg_budget_lines_nonnegative_insert;
CREATE TRIGGER trg_budget_lines_nonnegative_insert
BEFORE INSERT ON budget_lines
FOR EACH ROW
WHEN NEW.current_amount < 0
BEGIN
  SELECT RAISE(ABORT, 'budget line balance cannot be negative');
END;

DROP TRIGGER IF EXISTS trg_budget_lines_nonnegative_update;
CREATE TRIGGER trg_budget_lines_nonnegative_update
BEFORE UPDATE OF current_amount ON budget_lines
FOR EACH ROW
WHEN NEW.current_amount < 0
BEGIN
  SELECT RAISE(ABORT, 'budget line balance cannot be negative');
END;
