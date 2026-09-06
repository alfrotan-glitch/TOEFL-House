# ADR: Employee Workspace is a first-class operational work environment

- **Status:** Accepted governing addendum; implementation and runtime validation incomplete
- **Date:** 2026-09-05
- **Governing text:** `docs/governance/employee-workspace-principle.md`
- **Related:** `docs/MASTER_ENGINEERING_CONTRACT.md` approved Employee Workspace addendum; `docs/governance/supreme-technical-governance-mandate.md` §37

## Context

A generic dashboard or static role dashboard does not provide an effective operational environment for employees who hold multiple legitimate positions, operate within changing organizational scope, carry assigned work, or need immediate context for approvals, deadlines, notifications, and exceptions. A workspace that stores its own business state or permission decisions would create a competing authority and could preserve stale power after lifecycle or authorization changes.

The platform needs a product capability that reduces real employee effort while preserving canonical domain ownership, Finance monetary authority, branch isolation, lifecycle integrity, SoD, API/web parity, auditability, and transactional integration behavior.

## Decision

Treat Employee Workspace as a first-class platform capability and product requirement. It is the employee's primary operational work environment, not merely a dashboard.

At composition time, the workspace derives effective employee identity, employment eligibility, positions, assignments, organizational and branch scope, capabilities, lifecycle state, assigned responsibilities, tasks, approvals, deadlines, notifications, authoritative domain context, and exceptions. It is role-aware but not statically role-locked. A multi-position employee may see multiple legitimate work areas, while each action remains independently authorized and scope-checked by the server.

The workspace is an orchestration, presentation, and workflow-entry layer over canonical domain authorities. It may aggregate cross-module information, prioritize work, link to owner commands, and retain presentation preferences. It must not own balances, enrollment state, payroll state, approval truth, lifecycle truth, permissions, or an independent business task authority. Personalization changes presentation and productivity only.

Work-first and exception-first behavior is required. The composition should answer what needs attention, what can be done now, what is overdue, what is blocked or waiting, what changed, and which canonical workflow completes the work. Management workspaces must emphasize decisions, risks, trends, accountability, and exceptions rather than forcing management through employee-level operational screens.

Visibility is never authorization. Every sensitive action is reauthorized at command time against current employment, capability, delegation, lifecycle, and scope state. Workspace projections, task/notification state, and outbox-fed context must be idempotent, traceable, freshness-aware where relevant, rebuildable, and unable to grant or preserve authority.

## Consequences

- Authorization and lifecycle architecture must expose effective context suitable for workspace composition without moving policy into the frontend.
- Domain modules remain owners of facts and commands; workspace aggregation cannot become a cross-module write path.
- API, web, and any console transports must provide equivalent authorized workflow entry points.
- Reporting, notifications, tasks, approvals, search, events/outbox, audit, personalization, and frontend design must state their workspace boundaries.
- Intended-behavior specifications must cover multi-position composition, management context, work/exception prioritization, stale-authority revocation, scope isolation, projection rebuild, idempotency, accessibility, and employee efficiency.
- Runtime migration, concurrency, security, browser, freshness, and usability validation remains required. This ADR does not certify production readiness.

## Non-goals

- replacing canonical domain modules with a workspace service;
- implementing one static dashboard per role;
- treating client visibility or cached workspace state as authorization;
- duplicating financial, academic, HR, Payroll, Finance, approval, lifecycle, or reporting truth;
- defining business policy solely to make a workspace card convenient.
