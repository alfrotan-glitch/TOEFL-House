# Metric Registry

One row per number the system reports. Two surfaces showing "the same" number must point
at the same row here, or the difference must be recorded in the Notes column.

Validated by `npm run audit:registries`.

**Executable form.** Metrics consumed by declared reports live in
`server/src/core/reporting/report-catalog.ts`, where each is defined once with the SQL
that produces it. This document is the human-readable register; that file is what runs.
A report names metric ids and never carries SQL, so a metric cannot be computed two ways.

| Metric | Formula | Source | Period | Filters | Aggregation | Unit | Precision | Consumers | Test | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Operating income | `SUM(amount)` where `type='income' AND category<>'capital_injection'` | `financial_transactions` | date range (Jalali-derived) | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl`, `/finance/overview`, `/reports/overview`, `dashboard-summary` | `finance-accounting-classification.test.ts` | one predicate, four consumers |
| Operating expense | `SUM(amount)` where `type='expense'` and the row's `finance_category_id` classifies as `operating_expense` (NULL ⇒ operating) | `financial_transactions` ⋈ `finance_categories` | date range | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl`, `/finance/overview`, `/reports/overview`, `/finance/dashboard`, `/finance/expense-report` | `finance-accounting-classification.test.ts` | excludes capex + non-expense |
| Capital expenditure | as above with `classification='capital_expenditure'` | `financial_transactions` ⋈ `finance_categories` | date range | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl`, `/reports/overview`, `/finance/expense-report` | `finance-accounting-classification.test.ts` | cash out, **not** P&L cost |
| Non-expense cash movement | as above with `classification='non_expense_cash_movement'` | `financial_transactions` ⋈ `finance_categories` | date range | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl`, `/reports/overview`, `/finance/expense-report` | `finance-accounting-classification.test.ts` | advances, refunds, drawings, charity |
| Net (operating) | operating income − operating expense | derived | date range | branch scope | difference | AFN | whole AFN (integer) | `/finance/pnl`, `/finance/overview` | `finance-accounting-classification.test.ts` | excludes all three transfer classes |
| Owner drawings | `SUM(amount)` where `finance_category_id='sub_owner_drawings'` | `financial_transactions` | date range | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl` (`transfers`), `/reports/overview`, `bos` | `ledger-classification-consistency.test.ts` | debits branch cash, not a budget line |
| Capital injection | `SUM(amount)` where `type='income' AND category='capital_injection'` | `financial_transactions` | date range | branch scope | sum | AFN | whole AFN (integer) | `/finance/pnl` (`transfers`), `/reports/overview` | `ledger-classification-consistency.test.ts` | credits the organization treasury |
| Budget allocated / remaining | `SUM(allocated_amount)` / `SUM(current_amount)` | `budget_lines` | point-in-time | branch scope, `is_active=1` | sum | AFN | whole AFN (integer) | `/finance/dashboard`, `/reports/overview` | `finance-taxonomy.test.ts` | unfunded lines contribute 0 |
| Budget utilization % | `(allocated − remaining) / allocated` | `budget_lines` | point-in-time | `allocated > 0` | ratio | % | integer | `/finance/dashboard` | `finance-taxonomy.test.ts` | guarded against divide-by-zero |
| Marketing spend | `SUM(amount)` where the row's subcategory has `parent_id='cat_marketing_promotion'` | `financial_transactions` ⋈ `finance_categories` | date range | branch scope | sum | AFN | whole AFN (integer) | `bos` executive dashboard | — | **was permanently zero before migration 079** (matched request ids against budget line ids) |
| Teacher/staff wage cost | `SUM(amount)` where `finance_category_id='sub_salaries_wages'` | `financial_transactions` | date range | branch scope | sum | AFN | whole AFN (integer) | `bos` executive dashboard | `employee-payroll-idempotency.test.ts` | excludes genuine advances |
| Break-even (fixed cost base) | `SUM(allocated_amount)` where `cost_type='fixed'` | `budget_lines` | point-in-time | branch scope | sum | AFN | whole AFN (integer) | `bos` | `bos-profit-withdrawal-integrity.test.ts` | budgeting property, not accounting |
| Six-month post-withdrawal liquidity reserve target | fixed-cost base × 6, compared to `finance_accounts.main_balance + saving_balance − proposed withdrawal` | `budget_lines` + `finance_accounts` | point-in-time | branch scope | product + sum | AFN | whole AFN (integer) | `bos` executive dashboard and profit-withdrawal gate | `bos-period-authority.test.ts`, `bos-profit-withdrawal-integrity.test.ts` | treasury policy, not the expense taxonomy; savings is included but is not independently required to cover the target |
| Current-month owner withdrawal ceiling | `MIN(MAX(0, tier_share(gross operating profit) − drawings already taken), main_balance, MAX(0, main_balance + saving_balance − six-month reserve target))`; tier share is 0% below 10% margin, 5% at 10–19.99%, 10% at 20–29.99%, and 15% at 30% or above | `financial_transactions`, `finance_accounts`, `budget_lines`; computed by `profit-distribution.ts` | current Shamsi accounting month through today | concrete authorized branch | bounded difference | AFN | whole AFN (integer) | `GET /api/bos/profit-distribution/calculate`, `POST /api/bos/profit-distribution/withdraw`, BOS withdrawal card | `bos-period-authority.test.ts`, `bos-profit-withdrawal-integrity.test.ts` | publisher and enforcer use the same loader and authority; mutation recomputes inside its transaction |
| Reconciliation variances | four independent differences: amount, cash, saving, budget | `financial_transactions`, `payments`, `finance_accounts`, `budget_lines` | point-in-time | branch scope | difference | AFN | whole AFN (integer) | `/finance/reconciliation`, `/finance/dashboard` | `cash-position-reconciliation.test.ts` | any nonzero integer variance is unhealthy |

## Precision authority

Money is stored, validated, computed and displayed as whole AFN. Operator input with a
fractional amount is rejected; system-derived percentages settle once through
`assertComputedMoney`. Consequently a displayed total and the sum of its displayed parts
use the same unit and no hidden sub-unit balance exists. See D-22 and D-23.
