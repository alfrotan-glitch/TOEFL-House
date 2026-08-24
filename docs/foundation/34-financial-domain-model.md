# Canonical Financial Domain Model

## Financial entities and ownership

| Entity | Authority and purpose | Immutable core |
|---|---|---|
| Financial Obligation | amount owed by a liable party for an approved charge | source, original amount, debtor, period |
| Obligation Line | atomic charge within obligation | source, amount, category |
| Payment | money received from an external source | source, amount, method, received time, payer |
| Payment Allocation | allocation of payment to obligation lines | payment, obligation, amount |
| Refund / Refund Line | authorized return of received money | source payment, amount, reason |
| Discount | approved reduction of an obligation | eligibility, amount/rate, reason, effective dates |
| Adjustment | approved non-payment financial correction | source, amount, reason, authority |
| Reversal | transaction negating a prior posted transaction | original link, reason, amount |
| Journal / Journal Line | balanced accounting record | period, source, debit/credit, posting |
| Account | chart-of-accounts classification | code, type, effective definition |
| Financial Period | controlled reporting/posting window | dates, status, close authority |
| Cash Drawer / Cash Movement | accountable physical cash custody and movement | custodian, observed amount, movement |
| Reconciliation | comparison of expected and observed state | source set, observation, variance, explanation |
| Expense | approved business cost request and financial source | supplier, purpose, amount, approval |
| Funding Source/Fund/Restriction | money origin, pool, and permitted use | agreement, restriction, dates |
| Scholarship Award/Allocation | approved student benefit and funding application | award rule, student, fund, period |

Balances, receivables, cash positions, funding utilization, and payroll totals are derived from posted source facts. No entity stores an authoritative mutable balance.

## Mandatory financial rules

A payment posts only once, allocations cannot exceed payment or obligation, refunds cannot exceed refundable source, discounts preserve original obligation, adjustments and reversals retain source links, journals balance, cash movements reconcile to drawers, closed periods reject mutation, and restricted funds cannot be reclassified without authorized evidence. Every material transaction has actor, authorization context, scope, source, period, reason, and audit.
