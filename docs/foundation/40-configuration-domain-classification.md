# Configuration and Domain Classification

| Concept | Classification | Owner | Effective/history rule |
|---|---|---|---|
| Organization, campus, branch, department | Domain entity | Organization | structural history |
| Person, student, employee, book, asset | Domain entity | owning domain | identity/custody history |
| Fees, discounts, approval thresholds | Effective-dated configuration | Finance/Governance | published versions; no silent rewrite |
| Academic progression and grading rules | Effective-dated configuration | Academic | program/version scoped |
| Payroll rules | Effective-dated configuration + contract terms | HR/Payroll | contract precedence |
| Scholarship/funding rules | Configuration/agreement | Funding/Finance | agreement authority |
| Retention periods | Configuration/policy | Governance/Privacy | category and effective date |
| Branch operating policies | Effective-dated configuration | Organization/Branch | approved scope |
| Communication templates | Configuration | Communication | versioned and approved |
| Account, amount, date, percentage, code | Value object | owning domain | validated, no business truth alone |
| Status change, payment posting, approval, disclosure | Business event/fact | owning domain | immutable evidence |
| Balance, KPI, utilization, summary | Derived data | Reporting from source owner | no manual authority |
| Audit record | Audit record | Audit | append-only |

Configuration is authorized, validated, scoped, effective-dated, versioned where historical interpretation requires it, and never used to duplicate domain state.
