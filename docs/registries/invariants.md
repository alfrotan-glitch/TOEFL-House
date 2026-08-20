# Invariant Registry

One row per rule that must never be violated. `Enforcement point` is where it is actually
prevented — not where it is documented.

Validated by `npm run audit:registries`.

| Invariant | Owner layer | Enforcement point | Test | Failure behaviour |
|---|---|---|---|---|
| A budget line always belongs to a canonical SUBCATEGORY | database | `trg_budget_lines_require_subcategory_insert/update` (migration 079) | `server/src/tests/finance-taxonomy.test.ts` | `RAISE(ABORT)` — insert rejected |
| A branch has at most one teacher and one employee payroll envelope | database | `uq_budget_lines_payroll_target` (migration 079) | `server/src/tests/new-branch-operational.test.ts` | unique-constraint violation |
| Two budget lines under one subcategory may not share a name | database | `uq_budget_lines_branch_category_name` (migration 079) | `server/src/tests/finance-taxonomy.test.ts` | 409 from the API |
| A subcategory's classification equals its parent's | database | `trg_finance_categories_inherit_classification_*` (migration 077) | `server/src/tests/finance-taxonomy.test.ts` | `RAISE(ABORT)` |
| The taxonomy is exactly two levels deep | database | `trg_finance_categories_parent_is_root_*` + table CHECK (077) | `server/src/tests/finance-taxonomy.test.ts` | `RAISE(ABORT)` |
| A channel belongs to its budget line's own subcategory | database | `trg_budget_lines_channel_matches_category_*` (077) | `server/src/tests/finance-taxonomy.test.ts` | `RAISE(ABORT)` |
| A budget line balance never goes negative | database | `trg_budget_lines_nonnegative_*` (migration 065) | `server/src/tests/payroll-reversal-integrity.test.ts` | `RAISE(ABORT)` |
| Cash and savings balances never go negative | database | `CHECK` on `finance_accounts` | `server/src/tests/cash-position-reconciliation.test.ts` | constraint violation |
| Total branch liquidity after an owner withdrawal remains at or above six months of fixed costs | application transaction + database balance checks | `server/src/core/finance/profit-distribution.ts` ceiling + post-debit assertion in `server/src/routes/bos.routes.ts` | `server/src/tests/bos-profit-withdrawal-integrity.test.ts` | 409 and the transaction rolls back without a drawing or cash mutation |
| Period owner drawings never exceed the owner-approved tier allowance, available main cash, or liquidity above reserve | application transaction | `server/src/core/finance/profit-distribution.ts`, recomputed under the withdrawal transaction in `server/src/routes/bos.routes.ts` | `server/src/tests/bos-period-authority.test.ts`, `server/src/tests/bos-profit-withdrawal-integrity.test.ts` | 409; rejected and concurrent losing requests move no money |
| The published profit-withdrawal ceiling is always the current accounting-month ceiling enforced by withdrawal | application | shared `currentProfitDistributionPosition` input loader + `computeProfitDistribution` | `server/src/tests/bos-period-authority.test.ts` | non-month calculation requests return 400; enforcement recomputes under its write transaction |
| Capital expenditure is never operating expense | application | `server/src/core/finance/ledger-classification.ts` | `server/src/tests/finance-accounting-classification.test.ts` | excluded from the P&L expense total |
| Non-expense cash movements are never operating expense | application | `server/src/core/finance/ledger-classification.ts` | `server/src/tests/finance-accounting-classification.test.ts` | excluded from the P&L expense total |
| An uncategorised expense still counts as operating cost | application | `COALESCE(..., 'operating_expense')` in `ledger-classification.ts` | `server/src/tests/finance-accounting-classification.test.ts` | conservative default; never silently dropped |
| Owner drawings are not revenue and not operating cost | application | `ledger-classification.ts` (`OWNER_DRAWINGS_CATEGORY_ID`) | `server/src/tests/ledger-classification-consistency.test.ts` | reported under `transfers` |
| Owner capital injection is not revenue | application | `ledger-classification.ts` (`CAPITAL_INJECTION_CATEGORY`) | `server/src/tests/ledger-classification-consistency.test.ts` | reported under `transfers` |
| `SUM(budget_lines.current_amount) = SUM(budget_charge) − SUM(budget-funded expense)` | application | `server/src/utils/reconciliation.ts` | `server/src/tests/cash-position-reconciliation.test.ts` | `budgetVariance ≠ 0` → unhealthy |
| Branch cash = operating income − savings − owner drawings | application | `server/src/utils/reconciliation.ts` | `server/src/tests/cash-position-reconciliation.test.ts` | `cashVariance ≠ 0` → unhealthy |
| Every completed payment has a ledger row and vice versa | application | `server/src/utils/reconciliation.ts` | `server/src/tests/financial-integrity.test.ts` | `unmatchedPayments`/`orphanLedgerRows` |
| A payroll advance may exceed earned salary only for employees | application | `server/src/routes/teachers.routes.ts` | `server/src/tests/employee-payroll-idempotency.test.ts` | teacher `advance` → 400 |
| Payroll is idempotent per (person, period, amount, type) | database + application | `uq_teacher_salary_idempotency`, `uq_employee_salary_idempotency` | `server/src/tests/employee-payroll-idempotency.test.ts` | replay returns the original result |
| A user cannot read or write another branch's resources | application | `server/src/middleware/auth.ts` (`resolveBranchScope`, `canAccessBranchResource`) | `server/src/tests/branch-isolation-live.test.ts` | 403 |
| Requester and approver of an expense must differ | application | `server/src/routes/finance.routes.ts` | `server/src/tests/finance-expense-request-integrity.test.ts` | 403 |
| Permissions come only from a live `user_roles` assignment | application | `server/src/core/rbac/rbac-service.ts` (`resolveUserPermissions`) | `server/src/tests/rbac-single-authority.test.ts` | principal resolves to zero permissions |
| Deleting a user's assignments revokes their access | application | `server/src/core/rbac/rbac-service.ts` | `server/src/tests/rbac-home-branch-invariant.test.ts` | guarded endpoint returns 403 |
| There is no role column on `users` at all | database | `server/src/db/schema.sql` | `server/src/tests/rbac-single-authority.test.ts` | `no such column: role` |
| The session token carries no role or permission claim | application | `server/src/utils/auth.ts` (`TokenPayload`) | `server/src/tests/rbac-single-authority.test.ts` | a forged claim is ignored; authority is re-resolved per request |
| `users.branch_id` never authorizes branch access | application | `server/src/core/rbac/rbac-service.ts` (`canAccessBranch`) + `server/src/middleware/auth.ts` (`resolveBranchScope`) | `server/src/tests/branch-scoping.test.ts` | 403 when no live assignment authorizes the identity branch |
| Reading a notification never marks it read for another user | database + application | composite PK on `notification_read_receipts` + authenticated user id in `server/src/routes/audit.routes.ts` | `server/src/tests/notifications-authority.test.ts` | one idempotent receipt for the caller; every other viewer remains unread |
| An expired assignment grants nothing | application | `server/src/core/rbac/rbac-service.ts` | `server/src/tests/rbac-expired-grant-escalation.test.ts` | 403 |
| A user has at most one primary role assignment | database | `trg_user_roles_single_primary` | `server/src/tests/rbac-single-authority.test.ts` | `SqliteError: user may have only one primary role` |
| Authorization guards name canonical role codes only | application + compiler | `RoleCode` derived from `ROLE_CODES` in `server/src/core/rbac/permission-catalog.ts` | `server/src/tests/rbac-scope.test.ts` | unknown role name fails to compile |
| A workflow step naming an unknown role is reported, not silently denied | application | `server/src/routes/workflows.routes.ts` (`assertKnownStepRole`) | `server/src/tests/event-bus.test.ts` | 409 naming the bad role and step |
| Every stored amount is a whole number of AFN | database | INTEGER money columns + `trg_*_money_scale_*` | `server/src/tests/money-boundary-property.test.ts` | `must be a whole number of AFN` |
| Operator-supplied money is never silently rounded | application | `server/src/utils/money.ts` (`assertMoney`) | `server/src/tests/money-boundary-property.test.ts` | HTTP 400 |
| A single amount cannot exceed MAX_SAFE_INTEGER/100, so aggregates stay exact | application | `server/src/utils/money.ts` (`MAX_MONEY`) | `server/src/tests/money-boundary-property.test.ts` | HTTP 400 |
| No application code uses a physical direction utility | build | `scripts/verify-design-system.mjs` | provoked: `ml-4`/`pr-2`/`text-left` reported with their logical replacements | release gate fails |
| Only the DirectionProvider pins text direction | build | `scripts/verify-design-system.mjs` | provoked: a view setting `dir="rtl"` is reported | release gate fails |
| A report names metric ids and never carries its own SQL | application | `server/src/core/reporting/report-engine.ts` | `server/src/tests/reporting-catalog.test.ts` | unknown metric throws, never returns 0 |
| The same metric yields the same value in every report | application | `METRIC_CATALOG` single definition | `server/src/tests/reporting-catalog.test.ts` | two reports compared directly |
| Branch scope is applied by the engine, not by each metric | application | `server/src/core/reporting/report-engine.ts` | `server/src/tests/reporting-catalog.test.ts` | cross-branch totals diverge |
| A report's own permission is enforced on top of Report.View | application | `server/src/routes/reports.routes.ts` | `server/src/tests/reporting-catalog.test.ts` | 403 |
| Every reporting surface resolves a period through the calendar authority | application | `server/src/core/calendar/periods.ts` | `server/src/tests/reporting-catalog.test.ts` | overview and engine spans compared directly |
| A historical period is a Shamsi key, not a Gregorian window | application | `periodBoundariesForKey` | `server/src/tests/reporting-forensic.test.ts` | 400 on an unrecognised key |
| Every required report category has at least one declared report | application | `REPORT_CATALOG` | `server/src/tests/reporting-catalog.test.ts` | provoked: removing the teacher report names it |
| The overview and the report engine agree on operating income and expense | application | shared `ledger-classification` predicates | `server/src/tests/reporting-catalog.test.ts` | provoked: capital injection leaking into income gives 48900 vs 8900 |
| A capital-expenditure row never lands in operating expense | application | `finance_categories.classification` | `server/src/tests/reporting-catalog.test.ts` | capex rises, opex unchanged |
| A printed document declares paper size and margins | build + test | `src/design-system/print.ts` | `server/src/tests/print-document.test.ts` | no `@page` in output |
| Printed tables repeat their headers across pages | build + test | `src/design-system/print.ts` | `server/src/tests/print-document.test.ts` | page two is unlabelled |
| A printed document never fixes text to a physical side | build + test | `src/design-system/print.ts` | `server/src/tests/print-document.test.ts` | `text-align:left/right` absent |
| No component opens its own print window | build | `scripts/verify-design-system.mjs` | provoked: a new `window.open('')` is reported | release gate fails |
| No service module writes to console directly | build | `scripts/verify-logging.mjs` | provoked: a `console.log` in a route is reported | release gate fails |
| A credential-shaped field is never written to a log | application | `server/src/core/observability/logger.ts` (`redact`) | `server/src/tests/logging-authority.test.ts` | value replaced with `[redacted]` |
| A log line keeps the caller's message even when an error is attached | application | `describeError` uses `errorMessage` | `server/src/tests/logging-authority.test.ts` | message would be overwritten by the exception text |
