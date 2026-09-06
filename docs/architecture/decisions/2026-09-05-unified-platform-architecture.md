# ADR: Unified TOEFL House Platform Architecture

- **Status:** Accepted target architecture; implementation and runtime validation incomplete
- **Date:** 2026-09-05
- **Scope:** Full product architecture and authority reconciliation
- **Detailed report:** `docs/architecture/2026-09-05-unified-platform-reconciliation.md`
- **Comparison:** `origin/arena/01a03298-toefl-house`

## Decision

Build a third architecture rather than preserving either source implementation:

- Laravel modular monolith for backend application boundaries;
- PostgreSQL for transactional persistence and financial integrity;
- React/TypeScript frontend for administrator, reception, teacher, management, finance, operations, and student experiences;
- one authoritative owner per business concept;
- Finance as the sole monetary authority;
- append-only source-linked financial facts with compensating corrections;
- transactional outbox for integration and automation;
- centralized AccessDecision and fail-closed organization/branch scope;
- lifecycle commands with one transition graph per aggregate;
- read-only reports/projections with independent financial invariant auditing;
- first-class Employee Workspace and management workspaces dynamically composed from effective identity, authority, scope, lifecycle, assigned work, deadlines, approvals, notifications, context, and exceptions, without becoming a shadow authority;
- the mandatory, non-negotiable Integrated Enterprise System Architecture Graph at `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md` as the connected conformance target for every domain, edge, workflow, projection, event, document, notification, search, report, management, and failure path.

System A's broad ERP capabilities, React product surface, financial subledgers, invariant checker, readiness/backup posture, placement engine, and workflow concepts are selected as capabilities. Its SQLite database and route-level implementation are not selected. System B's PostgreSQL-oriented schema, modular domain commands, access/lifecycle controls, provenance, idempotency, audit, and correction architecture are selected as foundations. System B's missing operational capabilities are implemented within the final boundaries rather than by copying System A's backend.

## Authority consequences

- Payroll calculations and settlement proposals are workflow evidence only.
- Finance `employment_settlements` is the sole recorded employment-settlement fact.
- The Payroll `FinalSettlement` model and `final_settlements` runtime table are removed by migration `2026_09_05_000143_consolidate_employment_settlement_authority.php`.
- No report, dashboard, account cache, automation handler, import, or controller may create a competing monetary fact.
- Unknown/null branch scope is denied, not treated as organization-wide.
- A historical or terminal lifecycle state cannot be bypassed by a generic update endpoint.
- Workspace visibility is not authorization; every workspace-originated sensitive action is reauthorized server-side at command time.
- Multiple legitimate positions are composed into work-first, exception-first work environments rather than static role locks.

## Supersession

This ADR supersedes any source-system assumption that either implementation, database, UI, route layout, or compatibility model must be preserved. It supersedes the historical Payroll compatibility part of `2026-09-05-production-authority-and-correction.md`; that ADR remains valid for provenance and compensating-correction semantics.

Existing migrations that create the retired table remain historical migration records. They are not the final runtime schema after migration `000143`.

## Rejected alternatives

1. **Keep System A unchanged:** rejected because SQLite/single-schema deployment and route-level implementation are insufficient as the final multi-user financial backend.
2. **Keep System B unchanged:** rejected because it lacks the complete product experience and several valuable financial/academic/operational capabilities.
3. **Merge both backends:** rejected because it creates duplicate identity, organization, finance, reporting, lifecycle, and authorization authorities.
4. **Keep Payroll settlement as a read-only compatibility model:** rejected for the final redesign because the user explicitly permits schema redesign and a runtime compatibility concept invites future duplicate writes.
5. **Use frontend restrictions as security:** rejected; every server command remains authoritative.
6. **Call one generic or static role dashboard an employee workspace:** rejected; the target is a dynamically composed operational work environment with direct canonical workflow entry and exception visibility.

## Consequences

Positive:

- one monetary truth and one authority per concept;
- stronger relational concurrency and recovery posture;
- broader role-complete product experience;
- explicit migration path for removing duplicate authorities;
- clear separation between facts, workflow evidence, projections, and integrations;
- an operational employee experience that composes canonical work without duplicating domain authority.

Costs and risks:

- substantial contract and schema migration work;
- React frontend/API integration work;
- PostgreSQL deployment and restore validation;
- capability ports must be redesigned rather than copied;
- no production-readiness claim is possible until deferred runtime and independent review gates pass.
