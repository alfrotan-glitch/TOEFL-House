# Canonical TOEFL House Domain Model

**Phase:** Foundation Modeling
**Status:** Draft model — business authority only
**Implementation:** Forbidden

## Modeling conventions

- A domain owns its business truth and exposes outcomes to other domains through controlled business contracts.
- A record has one owner, one lifecycle, explicit scope, effective dates where applicable, and an auditable history.
- Current state is a projection of approved facts; historical facts are not silently rewritten.
- `UNKNOWN` means the institution has not supplied a specific policy. It is not a permission to invent one.

## Domain map

| Domain | Owns | Consumes | Material outputs |
|---|---|---|---|
| Organization | organization, campus, branch, department, structural lifecycle | ownership, governance | organizational scope and attribution |
| Identity & Access | person identity, accounts, positions, roles, permissions, assignments | HR, organization | authorized subject context |
| Governance & Approvals | requests, reviews, decisions, delegations, conflicts | all sensitive domains | approved/rejected decisions |
| People | person, relationships, contact identity | identity, admissions, HR | verified person context |
| Admissions | visitors, applicants, admission decisions | people, programs, placement, finance | applicant/student conversion |
| Students | student identity, lifecycle, guardians, status | admissions, academics, finance | student record and status |
| Academic Structure | programs, versions, levels, courses, periods | organization, configuration | valid academic offering |
| Academic Delivery | classes, sessions, schedules, teachers, enrollment, attendance | academic structure, people | academic participation facts |
| Assessment & Testing | placement, exams, assessments, results, appeals | academic delivery | approved academic outcomes |
| Progression & Completion | progression, repeat, completion, graduation, certificates | assessment, attendance, finance policy | academic completion facts |
| HR & Payroll | employment, contracts, leave, performance, compensation, payroll | people, organization, finance | employment and payroll obligations |
| Finance & Accounting | accounts, journals, receivables, payables, cash, periods, reconciliation | all financial events | financial truth |
| Fees & Student Finance | fee policies, obligations, payments, allocations, discounts, refunds | finance, students, academics | student financial obligations |
| Funding | scholarships, sponsorship, donors, restrictions, allocations | finance, students | restricted/unrestricted funding truth |
| Resource Operations | books, inventory, assets, facilities, maintenance | organization, finance | custody and resource facts |
| Communication | approved messages, templates, recipient history | all event owners | controlled communication |
| Documents | owned documents, versions, verification, retention | all domains | authorized evidence |
| Reporting | definitions, periods, scope, metrics | authoritative domains | reconciled reports |
| Audit & Security | audit facts, incidents, access reviews, data classifications | all domains | accountability and security evidence |
| Resilience & Integrations | recovery objectives, external exchanges, integration contracts | governance and operations | controlled external effects |

## Cross-domain authority rules

- Finance and Accounting owns all monetary truth.
- Academic Structure owns programs, levels, periods, and academic policy definitions.
- Academic Delivery owns class participation, session, attendance, and teacher assignment facts.
- Assessment owns assessment attempts, results, moderation, and release status.
- HR owns employment status, contracts, leave, and employee history.
- Identity & Access owns effective access; HR and organization provide assignment facts.
- Organization owns structural identity and effective organizational attribution.
- Reporting never creates a competing calculation or status.
- Audit records are append-only evidence and are not business state substitutes.

## Required aggregate boundaries

1. Organization aggregate: organization/campus/branch/department structure.
2. Person aggregate: person identity and verified relationships.
3. Access assignment aggregate: position, role, permission, scope, delegation, effective dates.
4. Student aggregate: student lifecycle and identity history.
5. Academic offering aggregate: program/version/level/course/period/class.
6. Enrollment aggregate: student participation, transfer, freeze, withdrawal.
7. Assessment aggregate: attempt, response, score, moderation, result release.
8. Employment aggregate: employee, contract, assignment, leave, performance.
9. Payroll aggregate: period, calculation, approval, payment, correction.
10. Financial transaction aggregate: obligation, payment, allocation, refund, journal, reconciliation.
11. Funding aggregate: fund, agreement, restriction, allocation, disbursement.
12. Resource custody aggregate: book/item/asset, location, custodian, movement.
13. Document aggregate: document identity, version, verification, retention.
14. Approval aggregate: request, review, decision, conflict, evidence.

Each aggregate requires a complete lifecycle specification before implementation.
