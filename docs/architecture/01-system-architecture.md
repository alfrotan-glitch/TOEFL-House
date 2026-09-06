# System Architecture

## Logical topology

Clients and administrative interfaces call an application boundary. The application layer exposes commands, queries, workflow orchestration, and contract validation; it never owns domain truth. Inside one deployable logical system, bounded contexts have explicit ownership and communicate through domain contracts. The domain layer enforces invariants and lifecycles. A server-side authorization policy boundary evaluates identity, position, assignment, permission, scope, policy, and approval before commands reach an owner.

Persistence is behind repository/unit-of-work boundaries owned by each context. Finance has a separate logical boundary and transaction rules. Audit receives append-only material-operation records independently of mutable operational logs. Reporting reads published canonical facts and metric definitions into projections. Document storage is opaque content plus metadata/verification owned by Documents and Privacy. Integrations are anti-corruption boundaries. Background jobs run post-commit work only, with durable job state.

This is a logical topology, not a technology selection. UI, files, logs, projections, and external systems are never authorities. The mandatory connected enterprise graph and typed relationship vocabulary are defined in `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md`; any conflicting topology or edge is a conformance defect.

The employee workspace is a first-class product and application capability over this topology. It composes effective authority, relevant work context, canonical queries, and canonical actions into role-aware but not role-locked employee and management work environments. It may aggregate cross-module work, tasks, approvals, deadlines, notifications, and exceptions, but it never becomes a source of business truth or authorization. Workspace composition must be server-derived, lifecycle-aware, scope-aware, and safe under authority changes.
