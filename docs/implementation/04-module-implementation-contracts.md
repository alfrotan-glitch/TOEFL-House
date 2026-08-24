# Module Implementation Contracts

| Module | Authoritative data/commands | Dependencies and events | Forbidden writer/test obligations |
|---|---|---|---|
| Organization/Governance | structure, ownership; create/transfer/close/approve | Identity, Access; structure-changed | operations; structure/history tests |
| Identity | person/account verification; link/deactivate | Documents; identity-verified | permissions/status; uniqueness/privacy |
| Authorization/Scope | positions, roles, permissions, assignments, delegation; grant/revoke/resolve | Organization, Identity; authority-changed | UI/self-grant; auth/scope/expiry |
| Admissions/Students/Guardians | applications, admission, enrollment, relationships | Identity, Academic, Finance; admitted/enrolled | grades/balances; lifecycle |
| Academic/Placement/Classes/Scheduling/Attendance/Assessment | programs, periods, evidence, decisions, membership, attendance | Students, HR, Reporting; decision-released | finance/payroll; evidence/decision |
| HR/Teachers/Payroll | employment, contract, work basis, calculations/results | Identity, Academic, Finance; payroll-approved | academic/payment; payroll/SoD |
| Finance/Receivables/Payments/Refunds/Discounts/Funding | obligations, payments, allocations, refunds, journals, funds, reconciliation | approved Students/Payroll/Assets; posted/reconciled | balance/report/UI; financial/concurrency |
| Books/Inventory/Assets/Facilities | catalog, custody, stock, assets, work | Identity/Organization, Finance; movement | journal/balance; custody/history |
| Communication/Documents/Privacy | delivery, metadata/content, consent, disclosure, verification | all facts, Authorization; post-commit delivery | source facts; privacy/access |
| Audit | append-only material evidence | all modules; audit-recorded | business state; immutability |
| Reporting | metric definitions, projections, runs | all source owners; refresh | source facts; reconciliation |

Each row is a bounded context, persistence owner, and transaction boundary. Commands are synchronous at decision points; notifications and projections are asynchronous after commit. Failure is deny/hold/retry according to error category and never cross-context direct mutation.
