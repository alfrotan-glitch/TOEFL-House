-- ============================================================================
-- Migration 060 — Book sale duplicate protection
-- ============================================================================
-- The book sale desk (POST /books/:id/sell) created one sale, one stock
-- decrement and one income row PER CLICK: five concurrent requests produced
-- five sales totalling 1,250 AFN from a single intent (proven by attack).
--
-- Same model as payments.idempotency_key: the unique index is the atomic
-- guarantee, so concurrent requests cannot race past the application check.
-- NULL keys are exempt, which keeps historical rows valid.

ALTER TABLE book_sales ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_sales_idempotency
ON book_sales(idempotency_key) WHERE idempotency_key IS NOT NULL;
