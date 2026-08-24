# Integration Implementation Contract

SMS, email, payment/banking, external identity, file storage, messaging, and export are adapter boundaries, not authorities. Contracts define authenticated requests, mapped business outcomes, correlation and idempotency keys, timeout/retry, dedupe, dead-letter/manual review, reconciliation, and audit. Payment timeout enters unknown/pending reconciliation, never a new unlinked payment. Authenticated duplicate webhooks are safely ignored/replayed. Vendor choices are deferred. Contract, failure, security, and reconciliation tests are mandatory.
