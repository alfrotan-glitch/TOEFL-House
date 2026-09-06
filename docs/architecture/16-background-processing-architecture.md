# Background Processing Architecture

Asynchronous work is limited to post-commit notifications, communication delivery, report projection/generation, scheduled reconciliation, payroll preparation, document processing, backup/restore verification, and integration retries. Ordinary domain commands remain synchronous when the caller needs a definitive decision.

Each job has trigger, durable status, idempotency key, retry limit/backoff, failure/dead-letter state, correlation ID, structured metrics/logs, audit where material, and user-visible status. Jobs consume committed facts and may issue an owner command only with authorization and idempotent reference. Repeated delivery is safe; a failed notification cannot roll back a committed financial or academic fact.
