# Integration Architecture

Future SMS, email, payment/banking, external identity, file storage, messaging, and reporting/export systems connect through anti-corruption adapters and versioned business contracts. No external system becomes internal source of truth without an explicit Foundation decision.

Each adapter has authenticated credentials held outside domain data, request/response mapping, correlation and idempotency key, timeout, retry/backoff policy, dead-letter/manual-review state, and audit. External payment ambiguity is reconciled by status inquiry/webhook and never blindly retried as a new payment. Webhooks are authenticated, deduplicated, ordered where needed, and source-linked. Integration failure leaves the owned internal fact pending/failed and visible for reconciliation; it does not fabricate success.
