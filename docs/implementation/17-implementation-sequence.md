# Dependency-Driven Implementation Sequence

| Package | Objective/prerequisites | Scope and verification |
|---|---|---|
| 0 Contract harness | finalize non-blocking policy inputs; no production behavior | ADRs, conventions, CI gates |
| 1 Identity and Organization | canonical identity/structure | entities, commands, auth/history tests; rollback import none |
| 2 Authorization and Scope | server policy and effective assignments | permissions, delegation, Owner approvals; exhaustive auth/scope tests |
| 3 Documents/Privacy/Audit | evidence, consent, immutable audit | metadata, disclosure/export; privacy/history tests |
| 4 Students/Admissions | admission, relationships, enrollment | lifecycle and identity tests; rollback transaction |
| 5 Academic delivery | programs, classes, scheduling, attendance, placement | capacity/evidence tests; module contracts |
| 6 Academic decisions | moderation, progression, appeal, certification | decision tests and history |
| 7 HR/Teachers | employment, contracts, work basis, leave | contract/authority tests |
| 8 Payroll | periods, calculations, approvals, settlement | payroll/SoD/concurrency tests |
| 9 Finance core | periods, accounts, obligations, journals | financial invariants/reconciliation; no reports yet |
| 10 Payments and funding | payments, allocations, refunds, discounts, funds | idempotency/concurrency/restricted-fund tests |
| 11 Assets/Operations/Communication | custody, work, delivery | contract/integration tests |
| 12 Reporting | metric catalog, projections, dashboards | source/period reconciliation |
| 13 Integrations/jobs | adapters, retries, scheduled work | failure/recovery/duplicate tests |
| 14 migration/cutover (conditional) | approved migration decision and mapping | validation, reconciliation, rollback, owner acceptance |

Each package includes domain commands/queries, owned persistence changes only, invariant tests, acceptance criteria, and reversible release. No UI-first sequencing is permitted. Prerequisites are the prior package's contracts and passing verification.
