# Canonical Authority Registry

One row per critical concept. "Authority" means: if two places disagree, this one wins.

Validated by `npm run audit:registries` — every path in the Storage / Rules / API columns
must exist, and every `Test` must name a real test file.

| Concept | Storage authority | Business-rule authority | API authority | UI consumer(s) | Reporting consumer(s) | Test authority | Status |
|---|---|---|---|---|---|---|---|
| Finance category taxonomy | `finance_categories` | `server/src/core/finance/category-taxonomy.ts` | `GET /api/finance/categories` | `src/components/finance/BudgetsPanel.tsx`, `BudgetLinePicker.tsx` | `reports.routes.ts` | `server/src/tests/finance-taxonomy.test.ts` | AUTHORITATIVE |
| Marketing channel / vendor | `finance_category_channels` | `server/src/core/finance/category-taxonomy.ts` | `GET /api/finance/categories` | `src/components/finance/BudgetsPanel.tsx` | `server/src/routes/bos.routes.ts` | `server/src/tests/finance-taxonomy.test.ts` | AUTHORITATIVE |
| Accounting classification | `finance_categories.classification` | `server/src/core/finance/ledger-classification.ts` | `GET /api/finance/pnl` | `src/components/finance/PnLPanel.tsx` | `reports.routes.ts`, `dashboard-summary.ts` | `server/src/tests/finance-accounting-classification.test.ts` | AUTHORITATIVE |
| Branch budget allocation | `budget_lines` | `server/src/routes/finance.routes.ts` | `GET/POST/PATCH /api/finance/budget-lines` | `src/components/finance/BudgetsPanel.tsx` | `GET /api/finance/dashboard` | `server/src/tests/finance-taxonomy.test.ts` | AUTHORITATIVE |
| Payroll envelope | `budget_lines.payroll_target` | `server/src/routes/teachers.routes.ts` | `POST /api/teachers/:id/pay-salary` | `src/components/teachers/TeachersView.tsx` | `server/src/routes/bos.routes.ts` | `server/src/tests/payroll.test.ts` | AUTHORITATIVE |
| Ledger entry | `financial_transactions` | `server/src/utils/income.ts` (income), `finance.routes.ts` (expense) | `GET /api/finance/transactions` | `src/components/finance/LedgerPanel.tsx` | `reports.routes.ts` | `server/src/tests/financial-integrity.test.ts` | AUTHORITATIVE |
| Cash position | `finance_accounts` | `server/src/utils/financeAccounts.ts` | `GET /api/finance/overview` | `src/components/finance/FinanceDashboardPanel.tsx` | `GET /api/reports/overview` | `server/src/tests/cash-position-reconciliation.test.ts` | AUTHORITATIVE |
| Period boundaries (Jalali) | — (derived) | `server/src/core/calendar/periods.ts` | consumed internally | `src/utils/jalali.ts` | `reports.routes.ts` | `server/src/tests/jalali-calendar.test.ts` | AUTHORITATIVE |
| Money representation | INTEGER columns + `trg_*_money_scale_*` (whole-unit guards) | `server/src/utils/money.ts` (`assertMoney`, `assertComputedMoney`, `roundMoney`, `MAX_MONEY`) | all money endpoints | `src/utils/format.ts` | all | `server/src/tests/money-boundary-property.test.ts` | AUTHORITATIVE |
| Role assignment (what a principal holds) | `user_roles` — the **only** place; `users` has no role column | `server/src/core/rbac/rbac-service.ts` (`assignPrimaryRole`) | `server/src/routes/security.routes.ts` | `src/components/security/` | — | `server/src/tests/rbac-single-authority.test.ts` | AUTHORITATIVE |
| Role vocabulary | `roles.code` | `ROLE_CODES` / `RoleCode` in `server/src/core/rbac/permission-catalog.ts` | `server/src/middleware/auth.ts` (`authorize`) | `src/types.ts` (`UserRole`) | — | `server/src/tests/rbac-single-authority.test.ts` | AUTHORITATIVE |
| Permission decision | `permissions`, `role_permissions`, `permission_overrides` | `server/src/core/rbac/rbac-service.ts` | `server/src/middleware/auth.ts` | `src/apiStore.ts` | — | `server/src/tests/rbac-single-authority.test.ts` | AUTHORITATIVE |
| Branch scope of a request | — (derived from identity) | `server/src/middleware/auth.ts` (`resolveBranchScope`) | every scoped endpoint | — | all reports | `server/src/tests/branch-scoping.test.ts` | AUTHORITATIVE |
| UI text direction | — (derived from language) | `src/design-system/direction-context.ts` | `src/design-system/direction.tsx` (sets `<html dir>`) | every view, by inheritance | printed documents set their own | `scripts/verify-design-system.mjs` | AUTHORITATIVE |
| UI visual language | `src/index.css` (`@theme` tokens) | `src/design-system/styles.ts` | — | every component | — | `scripts/verify-design-system.mjs` | AUTHORITATIVE |
| Reportable metric definition | — (derived) | `server/src/core/reporting/report-catalog.ts` (`METRIC_CATALOG`) | `GET /api/reports/run/:reportId` | reporting views | every report | `server/src/tests/reporting-catalog.test.ts` | AUTHORITATIVE |
| Report definition | — (declared) | `server/src/core/reporting/report-catalog.ts` (`REPORT_CATALOG`) | `GET /api/reports/catalog` | reporting views | — | `server/src/tests/reporting-catalog.test.ts` | AUTHORITATIVE |
| Reporting period | — (derived) | `server/src/core/calendar/periods.ts` (`periodBoundaries`) | every report endpoint | date pickers | every report | `server/src/tests/reporting-catalog.test.ts` | AUTHORITATIVE |
| Printed document layout | — | `src/design-system/print.ts` | — | report and finance print actions | printed reports | `server/src/tests/print-document.test.ts` | AUTHORITATIVE |
