-- ============================================================================
-- Migration 061 — Donation duplicate protection
-- ============================================================================
-- The donation desk (POST /funding/donations) created one donation and one
-- income row PER CLICK: eight concurrent requests produced eight donations
-- totalling 40,000 AFN from a single 5,000 AFN intent (proven by attack).
--
-- Same model as payments.idempotency_key and book_sales.idempotency_key: the
-- unique index is the atomic guarantee, so concurrent requests cannot race
-- past the application-level check. NULL keys are exempt, keeping every
-- historical donation valid.
--
-- NOTE: the index is created here and NOT in schema.sql. schema.sql is
-- applied before migrations on every startup, so an index there would
-- reference a column that existing databases do not yet have.

ALTER TABLE donations ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_idempotency
ON donations(idempotency_key) WHERE idempotency_key IS NOT NULL;
