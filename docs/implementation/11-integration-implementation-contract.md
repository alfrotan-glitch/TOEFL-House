# Integration Implementation Contract

SMS, email, payment/banking, external identity, file storage, messaging, and export are adapter boundaries, not authorities. Contracts define authenticated requests, mapped business outcomes, correlation and idempotency keys, timeout/retry, dedupe, dead-letter/manual review, reconciliation, and audit. Payment timeout enters unknown/pending reconciliation, never a new unlinked payment. Authenticated duplicate webhooks are safely ignored/replayed. Vendor choices are deferred. Contract, failure, security, and reconciliation tests are mandatory.

Workspace task, reminder, notification, and exception projections may consume committed domain events and authoritative queries. They must be idempotent, correlation-linked, freshness-aware where applicable, retry-safe, and rebuildable. Delivery or projection failure may degrade presentation but cannot create workflow authority, mutate owner facts, or preserve revoked access.
