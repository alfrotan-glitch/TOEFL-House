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
| Six-month reserve target | fixed-cost base × 6, compared to `finance_accounts.saving_balance` | `budget_lines` + `finance_accounts` | point-in-time | branch scope | product | AFN | whole AFN (integer) | `bos` profit-withdrawal gate | `bos-profit-withdrawal-integrity.test.ts` | **treasury policy, not the expense taxonomy** |
| Reconciliation variances | four independent differences: amount, cash, saving, budget | `financial_transactions`, `payments`, `finance_accounts`, `budget_lines` | point-in-time | branch scope | difference | AFN | 2dp | `/finance/reconciliation`, `/finance/dashboard` | `cash-position-reconciliation.test.ts` | any \|variance\| ≥ 0.01 ⇒ unhealthy |

## Known precision note

Money is **stored** to 2 decimal places and **displayed** with 0
(`Intl.NumberFormat(..., { maximumFractionDigits: 0 })` in `src/utils/format.ts`).
A displayed total can therefore differ from the sum of the displayed parts by up to one
unit. Deliberate for AFN, where sub-unit amounts are not transacted in cash. Severity:
Low. Tracked in `decisions.md`.
