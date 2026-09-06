# Derived Data Lineage Registry

| Derived value | Source facts | Rule authority | History/override |
|---|---|---|---|
| Student balance | posted obligations, allocations, refunds, adjustments | Finance | recompute; no manual override |
| Outstanding obligation | obligation lines minus valid allocations/credits | Finance | as-of period |
| Branch revenue | posted income journals scoped to branch | Finance | period/as-of |
| Cash balance | posted cash movements and reconciliations | Finance | observed variance retained |
| Payroll total | approved payroll results | Payroll/Finance | period/as-of |
| Attendance percentage | attendance records and period definition | Academic | correction history retained |
| Progression status | approved progression decisions | Academic | never infer from score alone |
| Enrollment counts | active membership facts | Academic Delivery | as-of period |
| Academic/financial KPIs | authoritative domain facts | Reporting catalog | reproducible |
| Funding utilization | approved allocations and fund restrictions | Funding/Finance | agreement/as-of |
| Dashboard metrics/reports | registered source metrics | Reporting | no independent truth |

All derived values are calculated from canonical facts, use the central period authority, are scoped, reproducible, and cannot be manually edited as truth.
