-- ============================================================================
-- 063 — payments.idempotency_key must never be NULL
-- ============================================================================
-- DEFECT THIS CLOSES (proven by live attack, 2026-08-16):
--
--   12 concurrent identical un-keyed `fee` payments produced 12 payments and
--   12 income rows — 12,000 AFN of fabricated revenue from a single 1,000 AFN
--   intent, each with its own receipt number.
--
-- ROOT CAUSE: students.routes.ts wrote `idempotency_key = NULL` for the
-- "guarded" categories (fee/installment/book/card/diploma/placement). SQLite
-- treats every NULL as distinct in a UNIQUE index, so uq_payments_idempotency
-- — documented in the code as the "atomic backstop" — could never fire for
-- exactly the categories it was meant to protect. The only remaining defence
-- was a read-then-write balance check that every concurrent request passes
-- simultaneously.
--
-- The application now always persists a key. This migration makes the database
-- the integrity boundary so no future writer can silently reintroduce the hole:
-- a NULL key is rejected by the engine, not by convention.
--
-- Historical rows predating the fix are backfilled with a deterministic,
-- collision-free legacy key derived from the row id. That preserves their
-- distinctness (they were genuinely separate historical events) while allowing
-- the NOT NULL constraint to hold. No amount, date or category is altered.
--
-- SQLite cannot ALTER a column to add NOT NULL, and rebuilding `payments`
-- would require dropping and recreating every branch-integrity and money-scale
-- trigger attached to it plus all child FKs. A CHECK enforced by trigger is
-- equivalent for write-time integrity and is far safer to apply in place.
-- ============================================================================

-- 1. Backfill any pre-existing NULL keys with a stable, unique legacy value.
UPDATE payments
   SET idempotency_key = 'legacy:' || id
 WHERE idempotency_key IS NULL;

-- 2. Reject future NULL/blank keys at the engine level.
DROP TRIGGER IF EXISTS trg_payments_idempotency_required_insert;
CREATE TRIGGER trg_payments_idempotency_required_insert
BEFORE INSERT ON payments
FOR EACH ROW
WHEN NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN
  SELECT RAISE(ABORT, 'payment idempotency_key is required');
END;

DROP TRIGGER IF EXISTS trg_payments_idempotency_required_update;
CREATE TRIGGER trg_payments_idempotency_required_update
BEFORE UPDATE OF idempotency_key ON payments
FOR EACH ROW
WHEN NEW.idempotency_key IS NULL OR TRIM(NEW.idempotency_key) = ''
BEGIN
  SELECT RAISE(ABORT, 'payment idempotency_key is required');
END;
