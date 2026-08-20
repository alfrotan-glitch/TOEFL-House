# Finance Category — finalization findings and open owner decisions

Branch: `arena/01a01dc0-toefl-house`
Audited at: `d5b73ab` (post-implementation finalization audit, 2026-08-20)
Status of the taxonomy: **structurally frozen.** The items below do not block
the freeze — none of them changes a classification that affects the P&L.

---

## Open owner decisions (`mapping_status = 'needs_review'`)

Each of these is a **subcategory** choice. In every case the accounting
treatment is already settled and correct, so nothing downstream is waiting on
the answer — only the reporting granularity is.

Resolving one is a two-line change: the entry in
`server/src/core/finance/category-taxonomy.ts` → `LEGACY_PURPOSE_MAP`, and the
matching `UPDATE` in `server/src/db/migrations/078_finance_category_legacy_mapping.sql`.
`finance-category-taxonomy.test.ts` asserts the two stay in step.

### OD-1 · `equipment` "Equipment" → Capital Expenditure → **?**

| | |
|---|---|
| Current | `cat_capital_expenditure` (category level), `needs_review` |
| Treatment | **capital_expenditure — settled, unaffected by the decision** |
| Candidates | `sub_it_equipment` (IT Equipment) · `sub_office_equipment` (Office Equipment) |

**Complete evidence inventory** (repository-wide sweep of `purpose='equipment'`
at the pre-migration commit `14b9cc8` — three hits, one meaningful):

| Source | Evidence |
|---|---|
| `002_add_budget_purpose.sql:24` | `b8 → 'equipment'`. No name, no label, no description. |
| `organizationHierarchy.ts:101` | name `Equipment`, icon **`Monitor`**, `cost_type='variable'` |
| `OperationalExpensesPanel.tsx:14` | membership in the removed hard-coded allow-list. Carries no meaning. |
| expense requests / ledger rows / reports / business rules / fixtures | **none** |
| Dari original name | **none** — migration 005 renames ten purposes; `equipment` is not one |

The whole case for "IT" is the `Monitor` icon. It is a real signal — all
seventeen legacy icons are literal depictions (`Printer`→printing,
`Coffee`→kitchen, `Car`→transport, `Droplets`→water, `Wrench`→maintenance…), so
the iconography is deliberate rather than decorative. But an argument about the
consistency *of that same icon* is not a second independent source, and
"Equipment" as a bare noun covers desks, whiteboards and projectors as
naturally as computers.

**Decision needed:** does this institute's "Equipment" line hold computers/IT,
or general office equipment? Answer either way and the treatment does not move.

### OD-2 · `marketing` "Marketing" → Marketing & Promotion → **?**

| | |
|---|---|
| Current | `cat_marketing_promotion` (category level), `needs_review` |
| Treatment | operating_expense — settled |
| Candidates | Digital Advertising · Traditional Advertising · Promotional Materials |

Evidence: name `Marketing`, icon `Megaphone`, `is_marketing = 1`,
`cost_type='variable'`. `is_marketing` is consumed only by the BOS marketing-spend
KPI (`bos.routes.ts:83`), which aggregates the whole line and is indifferent to
the subcategory. A megaphone is generic promotion and does not distinguish
digital from traditional. No campaign, channel or vendor data exists on the row.

**Insufficient — kept at category level, as instructed.** Facebook already
exists as a *channel* of Digital Advertising, so if the answer is "digital", the
line can also be pointed at `chn_facebook`.

### OD-3 · `transport` "Transport" → Transportation & Logistics → **?**

| | |
|---|---|
| Current | `cat_transport_logistics` (category level), `needs_review` |
| Treatment | operating_expense — settled |
| Candidates | Fuel Expenses · Taxi & Transportation · Delivery & Courier · Travel & Accommodation |

Evidence: name `Transport`, icon `Car`, `cost_type='variable'`; Dari original
`ترانسپورت` (migration 005); seeded by migration 003 as one of the expenses
"common to Afghan language institutes"; listed in the base-commit operational
prose as a routine recurring payment.

That is enough to rule Travel & Accommodation *unlikely* (no trip/lodging
semantics) but it does **not** separate Fuel from Taxi & Transportation — a car
icon fits a fuel bill and a taxi fare equally. Note the new taxonomy's own icon
choices must not be used as evidence here; they were chosen by this migration
and would be circular.

**Insufficient — kept at category level.**

### OD-4 · `purchases` "General Purchases" → **?**

| | |
|---|---|
| Current | `category_id = NULL`, `needs_review` |
| Treatment | operating_expense — unchanged from before the upgrade |
| Candidates | Office Supplies · Teaching Materials · Miscellaneous Expenses |

Evidence: name `General Purchases`, icon `ShoppingCart`, `cost_type='variable'`;
Dari original `خرید` ("purchase / buying"); seeded by migration 003 among the
routine operational expenses.

The name is explicitly **General**, and `خرید` is procurement in the broadest
sense. Nothing narrows it to stationery, teaching material or a catch-all. It
also cannot simply be folded into Miscellaneous Expenses: `misc` (`متفرقه`) is a
*separate* legacy envelope already mapped there, and merging two deliberately
distinct budgets on convenience is exactly what this migration forbids.

**Not even the parent category is decidable, so nothing is asserted.**
Owner decision required.

---

## Settled, no action

### `reserve` "Reserve" — `out_of_taxonomy`, correct

A contingency envelope, not an expense classification. Verified during the
finalization audit:

* The **six-month reserve policy does not read this budget line.** `bos.routes.ts`
  computes `reserveFundTarget = SUM(budget_lines.allocated_amount WHERE cost_type='fixed') × 6`
  and compares it against the branch **savings account** (`finance_accounts.saving_balance`),
  not against the line named "Reserve". Nothing in that rule changed.
* The line contributes its own `allocated_amount` to the `fixedTotal` break-even
  basis because it is `cost_type='fixed'`. Pre-existing behaviour, untouched.
* Spend booked to it still classifies as `operating_expense` — the conservative
  and correct default: money spent out of a contingency envelope is a real cost
  of whatever it paid for. Forcing it into the expense taxonomy would have
  invented a category; leaving it silently unclassified would have hidden it.
* **Defect found and fixed during this audit:** the Budgets screen rendered
  `out_of_taxonomy` lines inside the *"Unclassified — needs an owner decision"*
  bucket, telling the owner that Reserve was waiting on them when it is not.
  It now has its own group, *"Outside the expense taxonomy"*, badged
  *"Not an expense category"*.

---

## Accounting-debt follow-ups (NOT part of the taxonomy migration)

### FU-1 · Payroll advances are still posted as salary expense

**What is true today.** The taxonomy defines
`Non-Expense Cash Movements → Salary Advances` (`sub_salary_advances`) with the
correct classification, and every branch carries a budget line for it. But the
payroll write paths —
`POST /employees/:id/pay-salary` and the teacher equivalent — write
`payment_type='advance'` rows as `type='expense'`, `category='salary'`, debiting
the salary budget line. `classifyExpenseCategory('salary')` therefore returns
`operating_expense`, and a payroll advance **is** counted as operating cost.

**Why it was not changed here.** Changing it restates payroll, alters the
`budget_lines`/ledger relationship the reconciler depends on, and touches the
payroll authority — all explicitly out of scope for a category migration.

**Regression risk this migration introduces (accepted, documented).** The same
economic event can now be recorded two ways:

| Path | Ledger category | Classification |
|---|---|---|
| Payroll → pay salary, `type='advance'` | `salary` | operating expense |
| Finance → Operations, against the *Salary Advances* budget line | `sub_salary_advances` | non-expense cash movement |

This is a reporting divergence, not a data-integrity fault: both paths debit a
budget line and both reconcile. Until FU-1 is resolved, **the non-expense total
covers only the second path**, and that limitation is stated in three places so
no reader can infer otherwise:

* `server/src/core/finance/ledger-classification.ts` module docstring ("KNOWN LIMIT")
* the P&L panel's Non-Expense Cash Movements block, in the UI
* here

**Resolution options, for whoever picks this up:**

1. Point the payroll advance path at the `sub_salary_advances` purpose so it
   writes the non-expense category. Cheapest; changes new advances only.
2. Model advances as a receivable (an advance is an asset until it is recovered
   from a later salary run), which is the accounting-correct answer and the
   larger change.

Option 1 does **not** require a historical restatement; option 2 does.

### FU-2 · There is no `POST /finance/budget-lines`

Budget lines can only be created by the seeder. The canonical catalogue means
every subcategory already has an envelope, so nothing is blocked today — but an
operator cannot add a second envelope under a subcategory (a second landlord, a
second vehicle) without a code change. Not a defect; a known limit of the
current model, unchanged by this migration.
