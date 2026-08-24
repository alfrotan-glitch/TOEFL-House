# Domain Contracts — Business Level

| Domain | Owns | Exposes | Forbidden direct mutation |
|---|---|---|---|
| Organization & Governance | structure, approvals, delegation | effective structure and decisions | consumer-created structure |
| Identity & Access | account, assignment, role, permission, scope | effective access | UI-only grants |
| Admissions & Student | applicants, admission, student, guardian | verified identity/status | academic/finance-owned copies |
| Academic | programs, periods, classes, evidence, decisions | approved academic facts | report-derived status |
| HR & Payroll | employment, contract, entitlement, payroll | approved employment/payroll facts | manager balance edits |
| Finance | accounts, journals, obligations, payments, reconciliation | posted financial facts | operational money truth |
| Library & Inventory | books, custody, stock, assets | custody and movement facts | student/branch stock copies |
| Facilities & Operations | facilities, requests, work orders | operational status | direct financial posting |
| Communication | templates, messages, delivery history | approved communication output | arbitrary sends |
| Security & Audit | incidents, audit, classification | security evidence | audit mutation |
| Reporting | definitions, metrics, runs | derived reports | alternate calculations |

Cross-domain commands identify their owner, accepted input, authority, scope, outcome, audit, and failure behavior. Events notify consumers but do not transfer source-of-truth ownership.
