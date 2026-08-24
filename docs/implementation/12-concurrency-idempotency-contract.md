# Concurrency and Idempotency Contract

Repeatable commands require an idempotency key scoped to operation and source; same key returns the original result, conflicting payload is rejected. Owner transactions revalidate state at commit and serialize payment/allocation/refund source, period close/payroll, enrollment capacity, approval count, authority/scope assignment, and reconciliation runs. Conflicts return a stable retryable error; no silent merge. Jobs and webhooks deduplicate and are safe to retry. Tests use simultaneous actors, crash/retry, duplicate delivery, and period races.
