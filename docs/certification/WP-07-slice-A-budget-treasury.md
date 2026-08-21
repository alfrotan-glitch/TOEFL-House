# Remediation Record — WP-07 Slice A · Budget, treasury and finance-settings authority

**Work Package:** WP-07 Finance — budget-line movement, savings ledger purity, finance operational settings
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Recoverable pre-slice baseline:** `d29554bff7a635011ebed8a2d5085c265fc07197` (WP-06 certified)
**Implementation checkpoint:** `998e6a4` (budget-movement authority)
**Status:** SLICE COMPLETE — **WP-07 as a whole remains UNCERTIFIED**

> This record certifies only the concerns named below. It does **not** certify
> WP-07 Finance. Invoices, payments, refunds, discounts, receipts, the payment
> allocation model, the WP-07 legacy-test disposition (C-2) and the 2026-08-20
> v2-era certification's re-certification burden are all still open. It does not
> certify WP-08 Payroll, WP-11 Reporting, or the product.

## SCOPE

Included:

- money that moves into or out of a **budget line** without being spent:
  funding from the organization treasury, month-end return, month-end
  line-to-line reassignment;
- the ledger representation, sign convention, branch attribution and
  `allocated_amount` coherence of those movements;
- the meaning of `financial_transactions.type = 'saving_transfer'`;
- the reconciliation predicates and comparison precision that consume both;
- the transfer disclosures published by `GET /api/finance/pnl` and
  `GET /api/reports/overview`, and the three UI/print surfaces that render them;
- the three finance operational settings (`daily_saving_percent`,
  `expense_auto_approve_threshold`, `invoice_due_days`) and every endpoint that
  writes them;
- the release gate's financial reconciliation step.

Excluded (unchanged, and not certified here):

- invoice lifecycle, payment recording, refunds, receipts, discount
  authorization, student balances;
- payroll computation and payroll's own budget spend path (WP-08);
- the report engine and metric catalogue design (WP-11) — only the transfer
  disclosure fields were changed;
- any new business policy. No threshold, rate, tier or fee value was invented.

Risk: **HIGH** — branch cash, the organization treasury, budget envelopes and
every reconciliation and P&L surface that reads them.

## DISCOVER (read-only findings, before any change)

| # | Finding | Evidence |
|---|---|---|
| D-1 | Three flows wrote budget ledger rows with three conventions: funding wrote a positive `budget_charge`, a month-end return wrote **another positive** `budget_charge`, and a line-to-line transfer wrote a `saving_transfer` | `finance.routes.ts` before the change |
| D-2 | The reconciler reads `SUM(budget_charge)` as money placed in budget lines and `SUM(saving_transfer)` as branch savings | `utils/reconciliation.ts` |
| D-3 | Month-end return and transfer stamped the ledger row with the **operator's** branch, not the line's, although funding and `/operational-payments` already used the line's branch | `finance.routes.ts` before the change |
| D-4 | `allocated_amount` only ever grew, so a funded-then-returned line reported 100% utilization | `/finance/dashboard` budget block |
| D-5 | Three endpoints wrote the same finance settings under three different rules; the configuration form silently skipped values that failed its check and still answered `ok` | `invoices.routes.ts`, `finance.routes.ts` |
| D-6 | Two-decimal residue survived the whole-AFN decision (D-12/D-22): three `round2` helpers and `0.01` tolerances in the reconciler | `income.ts`, `studentBalance.ts`, `reconciliation.ts` |
| D-7 | The release gate reconciled an **empty** database, so it could only ever prove 0 = 0 | `scripts/release-validate.mjs` |

## PROVEN DEFECTS (reproduced before repair)

Each was demonstrated by an executed test against the pre-change code, then
re-run after the repair.

| # | Defect | Severity | Observed |
|---|---|---|---|
| WP07-F1 | A month-end **return** of 10,000 AFN corrupts the budget reconciliation | HIGH | `budgetVariance = −20,000`, `healthy = false`, permanently |
| WP07-F2 | A month-end **transfer** of 8,000 AFN between two lines of one branch is booked as a savings movement | HIGH | `cashVariance = +8,000`, `savingVariance = −8,000`, `healthy = false`; 8,000 AFN of savings that never happened appears in `/finance/overview` today-saved, `POST /finance/saving-engine/run`, `/finance/pnl` and `/reports/overview` |
| WP07-F3 | An owner settling **another branch's** line books the movement to their own branch | HIGH | funding row on branch B, return row on branch A; neither branch reconciles |
| WP07-F4 | A funded-then-returned line reports full utilization | MEDIUM | `allocated 10,000 / remaining 0 → used 10,000` with nothing spent |
| WP07-F5 | The savings rate accepts values it cannot honour | MEDIUM | `PUT /finance/saving-engine/settings {percent:'abc'}` → 200 and `'abc'` stored, after which every read silently used the 5% default; `PUT /invoices/config/settings {dailySavingPercent:500}` → 200, no upper bound |
| WP07-F6 | A rejected setting reports success | MEDIUM | the configuration form skipped an invalid value and answered `{ok:true}` |
| WP07-F7 | The ledger arrow contradicts the amount | LOW | a −500 refund rendered as `+-500`; a negative budget movement would render as `−-8,000` |

## MODEL

One convention, stated once, in `server/src/core/finance/budget-movements.ts`:

> A budget movement is one `financial_transactions` row of type
> `budget_charge`, whose **amount is signed** — positive moves money into the
> line, negative moves it out. `reference_id` is the line that moved and
> `branch_id` is the branch that owns it. `allocated_amount` follows the
> movement, so `allocated − current` is spend. A transfer is exactly two
> movements summing to zero. `saving_transfer` describes the branch savings
> account and nothing else.

Invariants preserved, per branch:

```
SUM(budget_lines.current_amount) = SUM(budget movement) − SUM(budget-funded expense)
saving_balance                   = SUM(savings movement)
main_balance                     = SUM(operating income) − SUM(savings movement) − SUM(owner drawings)
```

## CHALLENGE

REPAIR, not rebuild. The ledger table, the finance-account model, the canonical
taxonomy, the Shamsi period authority and the whole-AFN money boundary all
survive scrutiny — the defect was that three route bodies each invented what a
budget ledger row means. Adding a fifth `financial_transactions.type` was
rejected: the reconciler, the P&L and the reports would each need to learn it,
which is the same duplication in a new place. A schema change was neither
required nor made.

## DECIDE → IMPLEMENT

Recorded as **D-101 … D-105** in `docs/registries/decisions.md`.

| Change | File |
|---|---|
| New single writer for budget movements | `server/src/core/finance/budget-movements.ts` (new) |
| Charge / month-end consume it; self-transfer, retired-target and retired-line funding refused; charge amount parsed at the boundary | `server/src/routes/finance.routes.ts` |
| Retiring a line that still holds money refused; dashboard budget figures cover operated lines | `server/src/routes/finance.routes.ts` |
| Shared predicates, exact whole-AFN comparison | `server/src/utils/reconciliation.ts` |
| Savings rate: fail clearly instead of clamping | `server/src/utils/income.ts` |
| One validation authority for the three finance settings, consumed by all three writers | `server/src/core/configuration/finance-settings.ts` (new), `finance.routes.ts`, `invoices.routes.ts` |
| Transfer disclosures split into funded / returned / reassigned | `finance.routes.ts`, `reports.routes.ts`, `src/types.ts`, `PnLPanel.tsx`, `OperationsReportView.tsx` |
| Ledger arrow derived from the amount | `src/components/finance/FinanceDashboardPanel.tsx` |
| Two-decimal residue removed | `income.ts`, `studentBalance.ts`, `reconciliation.ts` |
| Reconciliation gate drives a full money lifecycle | `scripts/release-validate.mjs` |
| Package test authority | `server/src/tests/work-packages/wp07/budget-movement-authority.test.ts` (new, 40 cases) |

## VERIFY

| Command | Result |
|---|---|
| `npx vitest run src/tests/work-packages/wp07` | 40/40 passed |
| `npx vitest run` (server, full) | **2604 passed · 160 skipped** (the 160 are the explicit WP-04 retirements) · 0 failed |
| `npx tsc --noEmit` (server + frontend) | clean |
| `npm run release:validate` | **22 passed · 0 failed · 0 skipped** |
| Reconciliation gate detail | `full money lifecycle · amount/cash/saving/budget all 0` |

## ATTACK

Exercised, all through the HTTP surface unless noted: fractional / array /
boolean / hex-string / empty-string / null / zero / negative charge amounts;
numeric-string amounts (stored as INTEGER, verified with `typeof()`); a charge
exceeding the treasury; a self-transfer; a cross-branch transfer; a transfer
into a retired line; settlement of an empty line; **two concurrent returns of
the same line** (exactly one succeeds, one return row, reconciliation healthy);
retiring a funded line; funding a retired line (treasury untouched, same
transaction); settlement of another branch's line by an organization owner;
`postBudgetMovement` called outside a transaction; a movement that would
overdraw a line; a one-afghani cash break (detected, not tolerated); an
out-of-range stored savings rate (income refused, nothing written); `'abc'`,
`500`, `-1`, `true`, `[10]` and `1500.4` through both settings writers.

## REPAIR (findings from the independent review of the first checkpoint)

Reviewed cold from the diff, then repaired in the same slice:

| # | Review finding | Repair |
|---|---|---|
| R-1 | A budget line holding money could be retired, parking real money in an envelope excluded from pickers | `PATCH` refuses with 409 naming the balance |
| R-2 | A retired line could still be funded | `POST /charge` refuses with 409; the treasury debit shares the transaction |
| R-3 | The metric registry claimed the dashboard filtered `is_active = 1`; the SQL did not | The SQL now filters, which R-1 makes safe, and the registry row states why |
| R-4 | The savings rate had a second, laxer writer with no upper bound | One descriptor-based validation authority, consumed by all three writers |
| R-5 | An invalid setting was silently skipped behind a 200 | The writer parses and rejects; the response reports what it applied |

## INDEPENDENT REVIEW

Performed from the diff, the executed output and the database state rather than
from memory of writing the change. Residual observations, none of them defects
in this slice's scope:

- `budget_lines.allocated_amount` is a **stock** figure (money currently placed
  plus money spent from the line), not a period allocation. Utilization is
  therefore lifetime-to-date. That is what the metric registry now states; a
  period-scoped budget model would be a WP-07 design decision requiring owner
  input, and none was invented.
- Payroll (WP-08) spends from budget lines through its own guarded update and
  writes a signed contra row on void. That path was read and is consistent with
  the invariant, but payroll is not certified here.
- The same-agent limitation on independent review remains tracked as TR-4.

## CERTIFICATION (scope-limited)

**READY — for the concerns in SCOPE only.** Every defect listed above was
reproduced before repair and is pinned by an executed test; every applicable
gate passes; no business policy was invented; no schema change was required.

**WP-07 Finance remains NOT CERTIFIED.** Outstanding, and deliberately not
claimed: invoice lifecycle and numbering, payment and refund allocation,
discount authorization, receipts, the WP-07 legacy-test disposition under C-2,
and the re-certification burden recorded in
`docs/certification/WP-07-finance.md`.
