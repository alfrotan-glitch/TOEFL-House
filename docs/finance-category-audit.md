# Finance Category Model — Phase 1 READ-ONLY AUDIT

Repository: `alfrotan-glitch/TOEFL-House`
Branch: `arena/01a01dc0-toefl-house`
Base commit: `14b9cc8`
Date: 2026-08-20
Scope of this document: **observation only.** No source file was modified while producing it.

---

## 1. Current model — there is no Finance Category entity

The single most important audit finding is that **the ERP has no
`finance_categories` table, no category rows, no parent/child column, and no
category CRUD API.** The phrase "Finance Category" is, in this codebase, an
overloaded name for three *different* things that are only loosely coupled:

| # | Artefact | Where | Shape | Who writes it |
|---|----------|-------|-------|---------------|
| A | `budget_lines` | `server/src/db/schema.sql:1143` | **flat**, per-branch, keyed by `purpose` | seeded only (`organizationHierarchy.ts`), never created via API |
| B | `financial_transactions.category` | `server/src/db/schema.sql:1233` | free-text `TEXT NOT NULL`, **no CHECK, no FK** | every money route |
| C | `payments.category` | `server/src/db/schema.sql:1220` | `CHECK(... 10 values ...)` — *student billing* categories, unrelated to expense taxonomy | student/book/exam routes |

**(C) is a different bounded context** (what a student paid for) and is
explicitly out of scope: touching it would be "student finance logic".

### 1.1 `budget_lines` — the de-facto expense category table

```sql
CREATE TABLE IF NOT EXISTS budget_lines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  current_amount   REAL NOT NULL DEFAULT 0,
  allocated_amount REAL NOT NULL DEFAULT 0,
  icon             TEXT,
  cost_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (cost_type IN ('fixed','variable')),
  is_marketing     INTEGER NOT NULL DEFAULT 0,
  purpose          TEXT,                       -- migration 002; the de-facto stable key
  branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT
);
```

* No `parent_id`. No `sort_order`. No `is_active`. No classification column.
* `purpose` is already a **stable, non-display business key** (added by
  migration 002 precisely because `id = 'b1'` was hard-coded in payroll). This
  is the one piece of the legacy design that is genuinely reusable.
* Uniqueness on `(branch_id, purpose)` is enforced only by the seeding
  `WHERE NOT EXISTS` guard — **there is no unique index**, so duplicates are
  possible through direct SQL.
* Non-negative `current_amount` is enforced by triggers (migration 065).

### 1.2 The ledger category is derived from the budget line purpose

`server/src/routes/finance.routes.ts:163`

```ts
const category = opts.budgetLine.purpose || 'utility';
```

Every operational expense row in `financial_transactions` therefore carries the
budget line's `purpose` string. This is the *only* link between the ledger and
the category model, and it is a **string copy, not a foreign key** — historical
rows are immutable text and must stay readable after any rename.

---

## 2. Current categories (complete inventory)

### 2.1 Seeded budget lines — 17 per branch
`server/src/db/organizationHierarchy.ts:93-111`, ids `budget_<purpose>_<branchId>`.

| purpose | name | cost_type | marketing |
|---|---|---|---|
| `teacher_salary` | Teacher Salaries | fixed | – |
| `employee_salary` | Employee Salaries | fixed | – |
| `rent` | Rent | fixed | – |
| `electricity` | Electricity | fixed | – |
| `internet` | Internet | fixed | – |
| `marketing` | Marketing | variable | **yes** |
| `printing` | Printing | variable | – |
| `equipment` | Equipment | variable | – |
| `kitchen` | Kitchen & Refreshments | variable | – |
| `reserve` | Reserve | fixed | – |
| `water` | Water | fixed | – |
| `gas` | Gas | fixed | – |
| `maintenance` | Maintenance & Repairs | variable | – |
| `purchases` | General Purchases | variable | – |
| `cleaning` | Cleaning & Hygiene | fixed | – |
| `transport` | Transport | variable | – |
| `misc` | Miscellaneous | variable | – |

Legacy id families that may still exist in an upgraded production database:
`b1..b10` (original seed, mapped to purposes by migration 002) and
`b11_<branch>..b17_<branch>` (migration 003).

### 2.2 Ledger category strings actually written by the application

| category | tx type | writer | accounting meaning today |
|---|---|---|---|
| `fee`, `installment` | income | students/invoices/visitors | operating revenue |
| `book`, `chapter` | income | books.routes | operating revenue |
| `book_refund`, `chapter_refund` | income (negative) | books.routes | contra-revenue |
| `refund` | income (negative) | students.routes:1169 | contra-revenue |
| `exam`, `diploma` | income | exams.routes | operating revenue |
| `card` | income | students.routes | operating revenue |
| `placement` | income | placement-attempt.routes | operating revenue |
| `donation` | income | funding.routes | operating revenue |
| `capital_injection` | income | finance.routes `/treasury/deposit` | **owner equity in — excluded from revenue** |
| `salary` | expense | teachers.routes:93 (teacher *and* employee payroll, incl. `payment_type='advance'`) | operating expense |
| `profit_distribution` | expense | bos.routes:155 | **owner drawings — excluded from cost** |
| `<budget_line.purpose>` | expense | finance.routes `payFromBudgetLine` | operating expense |
| `utility` | budget_charge / saving_transfer | finance.routes | transfer filler, not a category |
| `saving` | saving_transfer | utils/income.ts | transfer filler, not a category |

### 2.3 Legacy names from the Phase 8 list — repository search result

`Facbook`, `Facebook Advertising`, `Advertisement Expenses`, `Advances Salary`,
`Drawing By Owner`, `Micellaneous`, `Taxa Clearince`, `Book Purchase`,
`Office Supply`, `Print Expenses`, `Repair Expenses`, `Taxi Fare`:

**Zero occurrences anywhere in the repository** (verified over all tracked
files excluding `node_modules` / `package-lock.json`). The only `Facebook`
matches are unrelated to finance:

* `src/config/visitorSources.ts:21` — visitor *lead source* option.
* `src/components/visitors/VisitorDeskPanel.tsx:116` — lead source label.
* `src/components/students/StudentProfileDrawer.tsx:497` — student social profile field.
* `docs/RELEASE_GATE.md:298` — branch contact fields.

`src/components/students/StudentsView.tsx:430` contains the string
`Book Purchase`, but it is the **payment** category label for
`payments.category = 'book'` (student billing), not an expense category.

**Conclusion:** the misspelled legacy categories in the task description exist
only in a *production database*, not in this source tree. The migration must
therefore be written to tolerate them if present and to be a no-op if absent.

---

## 3. Parent/child relationships

None. There is no hierarchy of any kind in the finance domain. The only
hierarchy in the system is Organization → Campus → Branch
(`server/src/db/organizationHierarchy.ts`), which is a *scoping* hierarchy, not
a category one.

---

## 4. Budget / Budget Line schema

* Budget Lines are the budget. There is no separate `budgets` table — a budget
  line carries both `allocated_amount` (cumulative funded) and
  `current_amount` (remaining).
* Funding path: `POST /finance/budget-lines/:id/charge` debits the
  **organization** treasury and credits the line, writing a `budget_charge`
  ledger row with `reference_id = <budget line id>`.
* Spending path: `payFromBudgetLine` decrements the line and writes an
  `expense` row.
* Month-end: `POST /finance/budget-lines/:id/month-end` returns the remainder
  to the treasury (`budget_charge`) or transfers it to a sibling line
  (`saving_transfer`).
* `expense_requests.budget_line_id` → `budget_lines(id) ON DELETE SET NULL`.

---

## 5. APIs that create/update/delete categories

**There are none.** Budget lines can only be created by the seeder
(`ensureBranchBudgetLines` / `ensureBudgetLineCatalog`). There is no
`POST /finance/budget-lines`, no `PATCH`, no `DELETE`. This is a real gap for
the target architecture: a canonical taxonomy that the operator cannot attach
new budget lines to is not usable.

Mutating endpoints that exist:

| Route | Effect |
|---|---|
| `PUT /finance/budget-lines/:id/classify` | sets `cost_type`, `is_marketing` |
| `POST /finance/budget-lines/:id/charge` | funds the line from the treasury |
| `POST /finance/budget-lines/:id/month-end` | returns/transfers the remainder |

---

## 6. APIs that create/update/delete Budget Lines

Same as §5 — no create/delete. Read: `GET /finance/budget-lines`
(`ORDER BY id`, branch-scoped via `resolveBranchScope`).

---

## 7. Finance screens/components consuming categories

| File | Use |
|---|---|
| `src/components/finance/FinanceView.tsx` | passes `budgetLines` to 4 panels |
| `src/components/finance/BudgetsPanel.tsx` | flat grid of cards; prints `line.purpose` raw |
| `src/components/finance/OperationalExpensesPanel.tsx` | **hard-codes a 14-value `OPERATIONAL_PURPOSES` set** to decide which lines are selectable |
| `src/components/finance/ExpenseRequestsPanel.tsx` | budget line dropdown |
| `src/components/finance/MonthEndPanel.tsx` | source/target line pickers |
| `src/components/finance/PnLPanel.tsx` | renders `byCategory` rows, `category.replace(/_/g,' ')` |
| `src/components/finance/FinanceDashboardPanel.tsx` | shows `tx.category` in recent ledger |
| `src/components/teachers/TeachersView.tsx:253-254` | **hard-codes legacy ids `'b1'` / `'b2'`** as a fallback |
| `src/components/dashboard/DashboardView.tsx` | budget utilisation |

---

## 8. Reports using category ids/names

* `GET /api/reports/overview` — income `byCategory`, expense `byCategory`,
  `transfers` (reports.routes.ts:127-186).
* `GET /api/finance/pnl` — `byCategory` grouped by `(type, category)`.
* `GET /api/finance/expense-report` — grouped by **budget line**, exposing
  `purpose` and `costType`.
* `GET /api/finance/dashboard` — budget utilisation, exhausted/at-risk lines,
  recent ledger rows with `category`.
* `GET /api/bos/*` — break-even KPIs; `stmtTeacherCost` filters
  `category='salary'`, `stmtMarketingSpend` filters
  `reference_id IN (SELECT id FROM budget_lines WHERE is_marketing=1)`.
* `core/dashboard/dashboard-summary.ts` — cash-flow series.

---

## 9. P&L calculation

`server/src/routes/finance.routes.ts:855-925`. Groups by `(type, category)`
then classifies with the shared authority:

```
income   = type='income'  AND category <> 'capital_injection'
expense  = type='expense' AND category <> 'profit_distribution'
transfers.budgetCharged     = type='budget_charge'
transfers.savingTransferred = type='saving_transfer'
```

## 10. Cash Flow calculation

`server/src/core/dashboard/dashboard-summary.ts:168-180` uses
`OPERATING_INCOME_SQL` / `OPERATING_EXPENSE_SQL` from
`server/src/core/finance/ledger-classification.ts`. Same rule as P&L. Good.

## 11. Budget vs Actual

Two places:
* `GET /finance/dashboard` → `budget.allocated / remaining / used /
  utilizationPercent / exhausted / atRisk`, computed purely from
  `budget_lines`.
* `utils/reconciliation.ts` budget invariant:
  `SUM(current_amount) == SUM(budget_charge) - SUM(expense)` per branch.

## 12. Ledger/accounting mappings

`server/src/core/finance/ledger-classification.ts` is the single classification
authority and it knows **exactly two** non-operating categories:
`capital_injection` (equity in) and `profit_distribution` (equity out).
It has **no concept of Capital Expenditure and no concept of a general
Non-Expense Cash Movement bucket.**

## 13. Foreign keys referencing category ids

* `expense_requests.budget_line_id → budget_lines(id) ON DELETE SET NULL`
* `financial_transactions.reference_id` holds a budget line id for
  `budget_charge` / month-end rows — **untyped, no FK**.
* `financial_transactions.category` — **untyped text, no FK**.
* `budget_lines.branch_id → branches(id) ON DELETE RESTRICT`

## 14. Existing migrations touching this area

`002_add_budget_purpose`, `003_operational_expenses`, `005_zero_demo_finance`,
`006_clear_demo_entities`, `047_finance_accounts_and_payment_idempotency`,
`048_finance_approval_controls`, `065_budget_line_nonnegative`,
`067_repair_f10_phantom_cash`, `071_dashboard_ledger_composite_index`.
Highest existing number: **076**. Next free: **077**.

Runner conventions (`server/src/db/migrate.ts`):
* lexically ordered `NNN_name.sql`, recorded in `schema_migrations`;
* whole file wrapped in one transaction, `integrity_check` +
  `foreign_key_check` validated **before commit**;
* only `duplicate column name` on a proven-existing column is swallowed —
  every other "already exists" error is fatal, so **DDL must use
  `IF NOT EXISTS` and DML must be written idempotently**;
* `schema.sql` must be updated in parallel because
  `scripts/verify-fresh-schema.mjs` fails the release gate if the
  schema-only database drifts from the fully-migrated one.

## 15. Existing tests

151 backend test files / 2 268 tests. Directly relevant:
`ledger-classification-consistency`, `cash-position-reconciliation`,
`finance-dashboard`, `finance-dashboard-period`, `finance-grand-audit`,
`finance-expense-request-integrity`, `finance-operational-payment-integrity`,
`finance-money-writer-parity`, `ledger-period-totals`, `reporting-forensic`,
`bos-profit-withdrawal-integrity`, `treasury-chain`, `payroll*`,
`new-branch-operational`, `position-lifecycle`.

Baseline on this checkout: **2 266 pass / 2 failed**, both in
`program-versions-panel-layout.test.ts` and both solely because `dist/assets`
did not exist yet (they require a prior `npm run build`). After building the
frontend the baseline is green.

## 16. Hard-coded category names/ids

| Location | Hard-coded thing | Severity |
|---|---|---|
| `src/components/teachers/TeachersView.tsx:253-254` | legacy ids `'b1'`, `'b2'` | **must go** |
| `src/components/finance/OperationalExpensesPanel.tsx:13-16` | 14 purpose strings | **must go** |
| `server/src/routes/finance.routes.ts:163` | fallback category `'utility'` | acceptable, transfer filler |
| `server/src/routes/teachers.routes.ts:93` | expense category `'salary'` | ledger semantics, out of scope |
| `server/src/routes/bos.routes.ts:76,155` | `'profit_distribution'` | canonical, keep |
| `server/src/routes/reports.routes.ts:151-172` | `'capital_injection'`, `'profit_distribution'` literals *not* imported from the classification authority | duplication risk |

## 17. Authorization rules involving Finance categories

None are category-specific. Permissions are resource-level: `Budget.View`,
`Budget.Edit`, `Budget.Allocate`, `Expense.View`, `Expense.Create`,
`Expense.Approve`, `Ledger.View`, `Finance.Report`. Branch isolation is
enforced by `resolveBranchScope` + `requireBudgetLine`. **Nothing here needs to
change.**

## 18. Validation that assumes categories are flat

* `requireBudgetLine()` — single-row lookup, no ancestry check.
* Month-end transfer — asserts both lines share a branch; no category rule.
* `OPERATIONAL_PURPOSES` in the UI — a flat allow-list.
* No validation prevents a cycle, because no parent column exists.

## 19. Organization/branch/campus scoping

Budget lines are **branch-scoped** (`branch_id NOT NULL`). Treasury is
**organization-scoped** (`finance_accounts` with `scope_type='organization'`,
`scope_id='global'`). The canonical taxonomy is an *organization-level* concept
and must not be duplicated per branch, otherwise two branches could drift.

## 20. Ordering / display logic

`GET /finance/budget-lines` → `ORDER BY id`; the finance dashboard uses
`ORDER BY name`. Both are accidental orderings. There is no `sort_order`
anywhere, so "Water" sorts after "Rent" purely alphabetically and the seeded
business order is lost.

---

## Accounting semantics found today (the honest picture)

| Concern | Implemented today | Target requirement | Verdict |
|---|---|---|---|
| Owner's Drawings excluded from opex | **Yes** — `profit_distribution` | required | already compliant |
| Owner capital excluded from revenue | **Yes** — `capital_injection` | (not asked) | already compliant |
| Refunds not an operating expense | **Yes** — booked as *negative income* (contra-revenue) via `recordIncome(-x)` | required | already compliant, different mechanism than the target text implies |
| Fixed assets excluded from opex | **No** — there is no capex concept at all | required | **gap** |
| Salary advances excluded from opex | **No** — `payment_type='advance'` writes `expense`/`salary` and debits the salary budget line | required | **conflict, see below** |
| Charitable contributions classified | **No** — donations exist only as *income* (`funding.routes`); outgoing charity has no path | required | **gap** |

---

## Data migration risks

1. **`financial_transactions.category` is immutable history.** Rewriting it
   would restate published P&L figures. Any new model must read history
   through a mapping, never by rewriting rows.
2. **`reconciliation.ts` budget invariant is arithmetic over `type='expense'`
   rows.** Adding budget lines is safe (they start at 0), but *reclassifying*
   an expense out of `type='expense'` would break
   `SUM(current_amount) = SUM(budget_charge) - SUM(expense)` and turn the
   release gate red.
3. **Pre-existing defect (found during this audit, not caused by it):**
   `bos.routes.ts` profit withdrawal writes an `expense` row that debits
   *branch cash* and never touches a budget line, yet
   `reconciliation.budgetSpentSql` counts **all** `type='expense'` rows as
   budget spend. A profit withdrawal therefore injects a false
   `budgetVariance`. Same for `expense`/`salary` rows — those *do* debit a
   line, so they are fine. Only `profit_distribution` is anomalous. This is
   exactly the "Owner's Drawings must not be treated as an ordinary operating
   expense" requirement, expressed in the reconciler.
4. **`budget_lines` has no unique index on `(branch_id, purpose)`** — an
   upgraded production database may already contain duplicates.
5. **`schema.sql` / migration drift** is release-gate enforced.
6. **Legacy id families `b1..b10`, `b11_*..b17_*`** must keep working;
   migration 002 already normalised them onto `purpose`.

## Duplicate categories found

None in the source seed — the 17 purposes are distinct. Semantic near-duplicates
that must **not** be merged automatically:
`electricity` / `water` / `gas` are three distinct budget lines that all belong
under one canonical subcategory (Utilities). They stay three Budget Lines; only
their *parent* is shared. Merging them would destroy per-utility budgets.

## Missing hierarchy support

Everything: no parent column, no level, no classification, no ordering, no
active flag, no organization-level catalogue, no channel/vendor concept
(so "Facebook as a channel under Digital Advertising" is currently
unrepresentable), and no create API to attach a Budget Line to a subcategory.

## Recommended migration strategy (Phase 2 input)

**Extend, do not replace.**

1. New organization-level table `finance_categories` — stable text codes,
   `parent_id`, `level ∈ {category, subcategory}`, `classification ∈
   {operating_expense, capital_expenditure, non_expense_cash_movement}`,
   `sort_order`, `is_active`, `is_system`.
2. New table `finance_category_channels` for channels/vendors, so **Facebook is
   a channel under Marketing & Promotion → Digital Advertising** and never an
   accounting category.
3. `budget_lines.category_id` → `finance_categories(id)` (subcategory level),
   nullable so no historical row is orphaned, with a deterministic
   purpose → subcategory mapping table applied by the migration.
4. Extend `ledger-classification.ts` so P&L / cash flow / reports resolve a
   ledger row's classification from the canonical taxonomy, keeping
   `capital_injection` / `profit_distribution` behaviour bit-identical.
5. Never rewrite `financial_transactions.category`.
6. Keep `purpose` as the stable business key it already is; add the unique
   index that was missing.

### Ambiguities that block a deterministic mapping

These are reported rather than guessed:

| Legacy purpose | Why it is ambiguous |
|---|---|
| `marketing` "Marketing" | target splits marketing into Digital / Traditional / Promotional Materials; the row carries no channel information |
| `equipment` "Equipment" | Office & Administration (operating) **or** Capital Expenditure (IT/Office Equipment) — the choice changes P&L classification |
| `purchases` "General Purchases" | Office Supplies / Teaching Materials / Miscellaneous are all plausible |
| `transport` "Transport" | Fuel / Taxi & Transportation / Delivery & Courier / Travel are all plausible |
| `reserve` "Reserve" | a contingency fund; **the target taxonomy has no equivalent node at all** |
| salary **advances** | today an operating expense; the target says non-expense — changing it restates payroll and breaks the budget reconciler |
