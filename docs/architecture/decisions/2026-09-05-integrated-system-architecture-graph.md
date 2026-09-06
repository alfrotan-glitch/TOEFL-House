# ADR: Integrated Enterprise System Architecture Graph

- **Status:** Accepted governing target architecture; mandatory and non-negotiable
- **Date:** 2026-09-05
- **Normative specification:** `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md`
- **Governing references:** `docs/MASTER_ENGINEERING_CONTRACT.md` approved graph addendum; `docs/governance/supreme-technical-governance-mandate.md` §38
- **Conformance status:** not yet established; static repository audit and runtime validation remain required

## Decision

Treat TOEFL House as one enterprise organism with a connected logical architecture rather than as unrelated modules. The integrated graph is mandatory for all subsequent architecture, implementation, schema, API, workflow, authorization, frontend, workspace, event/outbox, reporting, documentation, and acceptance decisions.

The graph requires:

- one authoritative owner per major fact;
- typed cross-domain relationships rather than unclassified dependencies;
- explicit authentication, authorization, command, validation, transaction, audit, event, projection, document, notification, search, reporting, and management paths;
- logical bounded contexts without requiring one physical service per context;
- Finance as the sole monetary authority;
- Enrollment as the enrollment decision authority consuming governed academic and financial eligibility;
- Placement as the measurement/evidence/result authority, not a class-assignment authority;
- Workflow as process/work-item coordination, not domain-state ownership;
- workspace as an authorized projection/orchestration surface, never a business fact owner;
- separate Task, Approval, WorkItem, Exception, and Notification concepts;
- server-side resource-, relationship-, scope-, lifecycle-, delegation-, SoD-, concurrency-, and idempotency-aware authorization;
- preserved historical branch/provenance context and compensating corrections rather than silent rewriting;
- transactional outbox publication with idempotent consumers;
- defined behavior for normal, duplicate, concurrent, stale, unauthorized, wrong-branch, missing-provenance, downstream-failure, retry, duplicate-event, and replay conditions.

## Conformance law

Every important implementation field or state must be answerable by: authoritative owner, changing command, permitting authorization, actor and context, invariant boundary, concurrent behavior, repeat behavior, emitted event, consuming projections, workflow/document/notification consequences, historical reconstruction, provenance retention, unauthorized-attempt evidence, direct-write prevention, correction path, and traceability to management reporting.

If a repository artifact conflicts with the graph, it is a conformance defect. It must be corrected or explicitly rejected by a superseding ADR; existing code, schemas, routes, screens, reports, indexes, workflow artifacts, documents, events, notifications, or implementation convenience do not override the graph.

## Consequences

- The next repository audit must map every major repository concept and cross-domain edge to an owner and typed relationship.
- Existing modular-monolith decisions remain compatible; the graph governs logical responsibility, not mandatory physical decomposition.
- Employee Workspace implementation must be assessed as part of the complete enterprise graph, not as an isolated dashboard feature.
- Architecture acceptance requires explicit failure/concurrency/idempotency behavior and historical/provenance evidence.
- This ADR is a target specification only. It does not certify conformance, runtime correctness, migration safety, or production readiness.
