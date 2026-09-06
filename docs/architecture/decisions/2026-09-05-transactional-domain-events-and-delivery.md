# ADR: transactional domain events are distinct from audit and endpoint delivery

- **Status:** Accepted
- **Date:** 2026-09-05
- **Supersedes:** the implicit assumption that `audit_events` or `integration_deliveries` alone can serve both domain-event publication and delivery retry concerns

## Context

Successful commands already wrote append-only `audit_events` in their owning transaction. `integration_deliveries` was the only outbox-like queue, but it is endpoint-scoped: its uniqueness, payload digest, retry, dead-letter, and delivery evidence are about sending one contract to one endpoint. It cannot represent a durable domain event once, independent of endpoint fan-out. Audit evidence also includes denied attempts and must not be interpreted as a business event stream.

## Decision

Create `domain_events` as an immutable transactional event log. A successful operation writes its material fact, audit evidence, and one domain event in the same transaction. `AuditRecorder` invokes `TransactionalEventRecorder`; denied operations remain audit-only. The event carries the audit source, actor, aggregate, operation/version, correlation, payload, digest, and explicit scope/provenance context; legacy events are backfilled as unknown rather than treated as global.

Commit is the publication boundary. The recorder never performs network I/O. A later projector may create endpoint-specific `integration_deliveries` rows with deterministic idempotency. Delivery progress remains mutable only within its own guarded state machine.

## Consequences

- Rollback must remove the material fact, audit row, and domain event together.
- Integration fan-out no longer changes domain truth.
- Event consumers can be retried without rewriting audit history.
- The repository now has a real event boundary, an allowlisted at-least-once relay, consumer receipts, explicit event context, and projection invalidations; concrete projection rebuilders, external subscriptions, and runtime guarantees remain to be implemented and validated.
- Existing denied-operation audit evidence does not produce false business events.

## Rejected alternatives

1. **Use `audit_events` as the bus:** rejected because denials are evidence and audit schema is not a consumer contract.
2. **Use `integration_deliveries` as domain truth:** rejected because endpoint delivery is not a domain fact and one event may have many endpoint deliveries.
3. **Dispatch synchronously from commands:** rejected because network failure would couple business commit to an external system and break rollback/failure isolation.

## Validation required later

PostgreSQL append-only triggers, transaction rollback, duplicate command idempotency, projector fan-out, endpoint retries, dead-letter requeue, ordering, and payload digest behavior require runtime validation.
