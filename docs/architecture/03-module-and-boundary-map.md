# Module and Boundary Map

| Module/bounded context | Owns | Commands | Forbidden |
|---|---|---|---|
| Organization/Governance | structure, ownership, policy approvals | create, transfer, close, policy approve | operational facts |
| Identity | people, accounts, verification | establish/link/deactivate identity | grants or student status |
| Authorization/Scope | positions, roles, permissions, assignments, delegation, scope | grant, revoke, delegate, resolve | self-authority |
| Admissions/Students/Guardians | applications, admission, student, verified relationships | apply, admit, convert, withdraw, guardian management | enrollment membership, grades, balances |
| Enrollment | membership/registration lifecycle and reusable seat/prerequisite constraints; current extraction reads Academic canonical facts until lifecycle authority moves | request, activate, freeze, transfer, complete, withdraw | grades, balances, source-domain delivery facts |
| Academic (Placement, Classes, Attendance, Assessment) | programs, periods, classes, delivery facts, evidence, decisions | place, define, record, score, approve, appeal | scheduling planning authority, finance/payroll truth |
| Scheduling | planning constraints, availability/reservation/conflict projections, room/teacher viability | plan, reserve, release, reconcile | Academic delivery/session truth, enrollment membership, finance/payroll truth |
| HR/Teachers/Payroll | employment, contracts, work basis, leave, calculations, results | employ, assign, calculate, approve, settle | academic decisions, payment posting |
| Finance (Receivables, Payments, Refunds, Discounts, Funding) | obligations, transactions, journals, funds, reconciliation | post, allocate, refund, adjust, reconcile | mutable balances |
| Books/Inventory/Assets/Facilities | catalog, custody, stock, assets, work orders | issue, return, move, dispose, complete | accounting journals |
| Work Management | workflow coordination, source-linked tasks/approvals/exceptions, assignments, queue membership, SLA state, history | start, assign, claim, transition, escalate | domain approvals, source facts, permissions, money, notifications |
| Communication | message intent/delivery and recipient-scoped notification/read projection | send, read, dismiss, deliver, retry | business fact authority, task/approval truth |
| Documents/Privacy | metadata/content, verification, consent/disclosure | verify, disclose, revoke, retain | business fact authority |
| Audit | immutable audit evidence | record/verify | state mutation |
| Reporting | metric definitions and projections | define, run, reconcile | source facts |
| Employee Workspace | effective work context composition, source-linked task/approval presentation, personal productivity preferences | compose, prioritize, save presentation preferences | domain truth, authorization, lifecycle, financial facts, and independent shadow workflow state |

The Employee Workspace is an orchestration and presentation capability, not a replacement bounded context for business facts. It may query multiple owner contexts and link employees to canonical actions, but it cannot create a competing authority.

Each module owns lifecycle, invariants, persistence interface, and public contracts. The integrated graph is mandatory for every module boundary and relationship: `OWNS`, `CREATES`, `READS`, `COMMANDS`, `AUTHORIZES`, `VALIDATES`, `CONSUMES_EVENT`, `EMITS_EVENT`, `PROJECTS`, `DOCUMENTS`, `ASSIGNS`, `ESCALATES`, `CORRELATES`, and `REFERENCES` must be made explicit where applicable. Application orchestration coordinates but does not own entities. Events are emitted only for durable business facts or justified post-commit notifications.
