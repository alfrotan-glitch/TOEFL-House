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
| Money is stored to at most 2 decimal places | database | `trg_payments_money_scale_*`, `trg_fin_tx_money_scale_*` | `server/src/tests/money-boundary-property.test.ts` | `RAISE(ABORT)` |
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
| `users.branch_id` never authorizes branch access | application | `server/src/core/rbac/rbac-service.ts` (`canAccessBranch`) | `server/src/tests/rbac-single-authority.test.ts` | access denied without a matching scope |
| An expired assignment grants nothing | application | `server/src/core/rbac/rbac-service.ts` | `server/src/tests/rbac-expired-grant-escalation.test.ts` | 403 |
| A user has at most one primary role assignment | database | `trg_user_roles_single_primary` | `server/src/tests/rbac-single-authority.test.ts` | `SqliteError: user may have only one primary role` |
| Authorization guards name canonical role codes only | application + compiler | `RoleCode` derived from `ROLE_CODES` in `server/src/core/rbac/permission-catalog.ts` | `server/src/tests/rbac-scope.test.ts` | unknown role name fails to compile |
| A workflow step naming an unknown role is reported, not silently denied | application | `server/src/routes/workflows.routes.ts` (`assertKnownStepRole`) | `server/src/tests/event-bus.test.ts` | 409 naming the bad role and step |
| Every stored amount is a whole number of AFN | database | INTEGER money columns + `trg_*_money_scale_*` | `server/src/tests/money-boundary-property.test.ts` | `must be a whole number of AFN` |
| Operator-supplied money is never silently rounded | application | `server/src/utils/money.ts` (`assertMoney`) | `server/src/tests/money-boundary-property.test.ts` | HTTP 400 |
| A single amount cannot exceed MAX_SAFE_INTEGER/100, so aggregates stay exact | application | `server/src/utils/money.ts` (`MAX_MONEY`) | `server/src/tests/money-boundary-property.test.ts` | HTTP 400 |
