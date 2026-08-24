# Reporting and Derived Data Contract

Reporting owns metric definitions, calculation specifications, scope filters, period semantics, and report runs—not source facts. Every metric declares source owner, source entities, calculation, period authority, scope, historical/as-of behavior, refresh/completeness status, and reconciliation requirement.

| Metric family | Source | Period and control |
|---|---|---|
| Balance/receivables/revenue/cash | Finance posted transactions, journals, reconciliations | Financial Period; reconcile before certification |
| Payroll totals | approved Payroll results and Finance payment facts | Payroll/Financial Period |
| Enrollment/attendance/progression | Students and Academic facts/decisions | Academic period; preserve as-of history |
| Funding utilization | approved Funding allocations and Finance postings | agreement and Financial Period |
| Inventory/assets | custody, movement, work, and approved financial facts | effective movement date |

Dashboards cannot write source records or define a competing balance. They cannot silently mix periods, scopes, current ownership with historical attribution, or incomplete data. Divergence is detected by reconciliation and reported as an exception to the source owner. Metric configuration versions remain available so historical reports retain their original definition.
