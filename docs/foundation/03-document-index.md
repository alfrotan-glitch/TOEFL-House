# Foundation Document Index

**Status:** Foundation set initialized; most documents are not yet authored.

This index maps the directive's required foundation artifacts to their current state. `PLANNED` means the artifact is intentionally queued, not complete.

| # | Required artifact | Path / planned path | State |
|---:|---|---|---|
| 01 | Project Charter | `docs/foundation/charter.md` | PLANNED |
| 02 | System Mission & Scope | `docs/foundation/mission-and-scope.md` | PLANNED |
| 03 | Organization Model | `docs/foundation/organization-model.md` | BLOCKED by O-01–O-03 |
| 04 | Campus/Branch Model | `docs/foundation/campus-branch-model.md` | BLOCKED by O-01 |
| 05 | Stakeholder Register | `docs/foundation/stakeholders.md` | PLANNED |
| 06 | Position Register | `docs/foundation/positions.md` | BLOCKED by O-04 |
| 07 | Role Register | `docs/foundation/roles.md` | BLOCKED by O-02–O-06 |
| 08 | Permission Register | `docs/foundation/permissions.md` | BLOCKED by role/scope decisions |
| 09 | Scope Model | `docs/foundation/scopes.md` | BLOCKED by O-06 |
| 10 | Workspace Specification | `docs/foundation/workspaces.md` | BLOCKED by O-07 |
| 11 | Requirements Specification | `docs/foundation/requirements.md` | IN PROGRESS after discovery |
| 12 | Domain Register | `docs/foundation/domains.md` | PLANNED |
| 13 | Domain Specifications | `docs/foundation/domains/` | PLANNED |
| 14 | Business Rule Registry | `docs/foundation/business-rules.md` | PLANNED |
| 15 | Entity Registry | `docs/foundation/entities.md` | PLANNED |
| 16 | State Transition Registry | `docs/foundation/states.md` | PLANNED |
| 17 | Source-of-Truth Registry | `docs/foundation/source-of-truth.md` | PLANNED |
| 18 | Invariant Registry | `docs/foundation/invariants.md` | PLANNED |
| 19 | Decision Register | `docs/foundation/04-decision-ledger.md` | IN PROGRESS |
| 20 | Assumption Register | `docs/foundation/assumptions.md` | PLANNED |
| 21 | Open Question Register | `docs/foundation/02-organization-discovery.md` and subsequent clusters | IN PROGRESS |
| 22 | Risk Register | `docs/foundation/05-risk-register.md` | IN PROGRESS |
| 23 | Threat Model | `docs/foundation/threat-model.md` | PLANNED |
| 24 | Security Architecture | `docs/foundation/security-architecture.md` | PLANNED |
| 25 | Financial Model | `docs/foundation/financial-model.md` | BLOCKED by business policy decisions |
| 26 | Accounting Model | `docs/foundation/accounting-model.md` | BLOCKED by finance decisions |
| 27 | Calendar & Period Model | `docs/foundation/calendar-periods.md` | BLOCKED by period policy decisions |
| 28 | Configuration Model | `docs/foundation/configuration.md` | PLANNED |
| 29 | Approval Model | `docs/foundation/approvals.md` | BLOCKED by O-02/O-03 |
| 30 | Audit Model | `docs/foundation/audit-model.md` | PLANNED |
| 31 | Notification Model | `docs/foundation/notifications.md` | PLANNED |
| 32 | Reporting Model | `docs/foundation/reporting.md` | PLANNED |
| 33 | Integration Model | `docs/foundation/integrations.md` | PLANNED |
| 34 | Data Model | `docs/foundation/data-model.md` | PLANNED after domain discovery |
| 35 | Database Architecture | `docs/foundation/database-architecture.md` | BLOCKED by target architecture decision |
| 36 | API Architecture | `docs/foundation/api-architecture.md` | BLOCKED by target architecture decision |
| 37 | API Contracts | `docs/foundation/api-contracts/` | PROHIBITED before architecture |
| 38 | Application Architecture | `docs/foundation/application-architecture.md` | BLOCKED by discovery |
| 39 | Frontend Architecture | `docs/foundation/frontend-architecture.md` | BLOCKED by workspace discovery |
| 40 | Workspace/UI Specifications | `docs/foundation/ui/` | BLOCKED by workspace discovery |
| 41 | Testing Strategy | `docs/foundation/testing-strategy.md` | PLANNED |
| 42 | Acceptance Criteria | `docs/foundation/acceptance-criteria.md` | PLANNED |
| 43 | Traceability Matrix | `docs/foundation/traceability.md` | PLANNED |
| 44 | Backup & Recovery Strategy | `docs/foundation/backup-recovery.md` | PLANNED |
| 45 | Deployment Architecture | `docs/foundation/deployment.md` | BLOCKED by operational requirements |
| 46 | Observability Strategy | `docs/foundation/observability.md` | PLANNED |
| 47 | Performance Strategy | `docs/foundation/performance.md` | PLANNED |
| 48 | Data Governance | `docs/foundation/data-governance.md` | PLANNED |
| 49 | Change Management | `docs/foundation/change-management.md` | PLANNED |
| 50 | Foundation Certification Report | `docs/foundation/50-foundation-certification.md` | PROHIBITED until Gate 16 evidence exists |

## Modeling package

- `19-canonical-domain-model.md` — canonical technology-independent domain map
- `20-entity-relationship-registry.md` — business entities and relationships
- `21-governance-and-access-model.md` — authority, scope, roles, permissions, delegation, segregation of duties
- `22-lifecycle-and-control-model.md` — business lifecycle and exception model
- `23-finance-academic-hr-controls.md` — financial, academic, HR/payroll, privacy, and reporting controls
- `24-data-privacy-resilience-model.md` — data classification, audit, retention, recovery, and integrations
- `25-foundation-modeling-review.md` — modeling review and gate disposition

## Gate rule

The presence of a file is not evidence that its contents are complete. Every artifact must be cross-referenced, decision-aware, and evidence-gated before its owning gate can pass.

## Gate 1 artifact

- `26-gate-1-requirements-completeness-review.md` — requirements completeness audit and Gate 1 disposition

## Gate 2 artifact

- `27-gate-2-business-rule-completeness-review.md` — adversarial business-rule completeness audit and Gate 2 disposition
