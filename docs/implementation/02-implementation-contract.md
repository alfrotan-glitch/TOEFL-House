# Implementation Contract

## Universal command contract

Every command carries actor, operation, target, scope, effective time, correlation ID, idempotency key when repeatable, and reason where material. Application service authenticates, invokes server authorization, validates lifecycle/preconditions, calls exactly one owning domain transaction, commits fact plus audit, and publishes post-commit work. Queries never mutate. Errors use stable categories. Rejected, held, retried, and completed outcomes are observable and auditable. The Employee Workspace may compose these outcomes into an employee's work-first and exception-first operational environment, but workspace visibility never grants authority and every workspace-originated mutation re-enters the owning command for current server-side authorization, scope, lifecycle, SoD, and invariant checks.

## Universal module contract

Each module owns its entities, repositories, invariants, lifecycle, commands, queries, audit records, and public contract. No module writes another module's persistence. Cross-module reads are defined projections/queries; cross-module mutations are commands. Events are notifications, not authority. Financial facts and authority changes require idempotency and concurrency controls. See `04-module-implementation-contracts.md`.
