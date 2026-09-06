# Module and Boundary Map

| Module/bounded context | Owns | Commands | Forbidden |
|---|---|---|---|
| Organization/Governance | structure, ownership, policy approvals | create, transfer, close, policy approve | operational facts |
| Identity | people, accounts, verification | establish/link/deactivate identity | grants or student status |
| Authorization/Scope | positions, roles, permissions, assignments, delegation, scope | grant, revoke, delegate, resolve | self-authority |
| Admissions/Students/Guardians | applications, admission, student, verified relationships, enrollment | apply, admit, convert, enroll, withdraw | grades, balances |
| Academic (Placement, Classes, Scheduling, Attendance, Assessment) | programs, periods, classes, schedules, evidence, decisions | place, schedule, record, score, approve, appeal | finance/payroll truth |
| HR/Teachers/Payroll | employment, contracts, work basis, leave, calculations, results | employ, assign, calculate, approve, settle | academic decisions, payment posting |
| Finance (Receivables, Payments, Refunds, Discounts, Funding) | obligations, transactions, journals, funds, reconciliation | post, allocate, refund, adjust, reconcile | mutable balances |
| Books/Inventory/Assets/Facilities | catalog, custody, stock, assets, work orders | issue, return, move, dispose, complete | accounting journals |
| Communication/Documents/Privacy | templates/delivery, metadata/content, verification, consent/disclosure | send, verify, disclose, revoke, retain | business fact authority |
| Audit | immutable audit evidence | record/verify | state mutation |
| Reporting | metric definitions and projections | define, run, reconcile | source facts |

Each module owns lifecycle, invariants, persistence interface, and public contracts. Application orchestration coordinates but does not own entities. Events are emitted only for durable business facts or justified post-commit notifications.
