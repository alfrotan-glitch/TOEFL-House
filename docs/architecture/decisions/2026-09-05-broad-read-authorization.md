# ADR: broad console reads require explicit root authority

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

Several console and JSON read methods returned broad tables while only mutation commands invoked branch-aware authorization. `null` scope is fail-closed for operational targets and cannot be a wildcard.

## Decision

Use branch-scoped query objects when a model has canonical branch provenance. Where a console intentionally returns an organization-wide administrative result set, require `AccessDecision` with a concrete organization-wide capability before executing the query. The base controller exposes `requireOrganizationRead`; denial is audited. This pass applies the gate to the identified Academic, Payroll, Reporting, Home, Organization, CRM, and Payroll JSON bulk reads, while Academic session and CRM detail paths use branch-scoped checks.

## Consequences

- A branch grant cannot read an unscoped administrative table merely because a mutation command would reject its writes.
- Some existing UI workflows may need branch-scoped query replacements rather than broader grants.
- Read authorization is explicit and testable rather than hidden in navigation or frontend filtering.

## Rejected alternative

Using `hasReadAuthority()` as a boolean gate was rejected: it proves only that the actor has some authority, not that the actor may see every branch or organization record.

## Validation required later

Exercise branch grants, organization grants, delegations, inactive employment, null provenance, API/web parity, and denial audit behavior.
