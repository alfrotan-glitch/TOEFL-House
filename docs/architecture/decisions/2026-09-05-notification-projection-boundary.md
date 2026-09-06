# ADR: Notification projection and event intent boundary

- Status: accepted for convergence
- Date: 2026-09-05

## Context

Communication messages and domain work are different concepts. A notification informs one recipient and needs independent read/dismiss state, but it must not acknowledge a domain action, complete a work item, or become a global unread authority. Inferring recipients from the event actor or exposing branchless rows to branch actors would create scope and privacy defects.

## Decision

Communication owns a recipient-scoped `notifications` projection. Its consumer accepts only explicit event payload intent containing a recipient and title, records a dedupe key, and never mutates the source aggregate. Notification read/dismiss transitions are owned by Communication, require recipient identity plus the `communication.notification.read` capability and exact branch or organization scope authorization, and are idempotent under row lock. Organization scope is resolved directly through `StructureScope` and the canonical Access resolver; it does not depend on a current visible branch assignment.

Notifications use event context branch provenance when an intent does not override it. Missing provenance is unknown, not organization-wide. Employee Workspace composes the projection and React may call only the versioned read/dismiss commands. Message delivery, Work Management state, Audit evidence, and source-domain facts remain separate authorities.

## Consequences

- Replay-safe recipient/read state exists without a second task or message authority.
- Domain producers must opt in with explicit recipient notification intents; no broad event-to-recipient guessing is performed.
- If an envelope supplies both branch and organization provenance, the active campus assignment must prove that they belong to the same active organization; otherwise projection is rejected.
- Channel/device preferences, expiry/retry operations, and comprehensive event-specific notification policy remain deferred.
- Runtime migration, consumer, authorization seed, API, and browser behavior remain unverified under the governing static-only review posture.
