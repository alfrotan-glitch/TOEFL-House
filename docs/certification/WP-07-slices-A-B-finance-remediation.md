# Remediation Record — WP-07 Slices A–D · Budget/treasury authority, the invoice payment boundary, document/authorization integrity, and refund attribution

**Work Package:** WP-07 Finance — budget-line movement, savings ledger purity, finance operational settings, invoice payment boundary
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Recoverable pre-slice baseline:** `d29554bff7a635011ebed8a2d5085c265fc07197` (WP-06 certified)
**Implementation checkpoints:** `998e6a4` (budget-movement authority) · `0fbf3ce` (review repairs) · `d6ff265` (invoice payment boundary) · `74465f8` (idempotency replay scope)
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

Added in slice B:

- the invoice payment boundary: payment-method validation, idempotency replay
  scope and ordering, and overpayment precision on `POST /api/invoices/:id/pay`.

Added in slice D (owner decisions D-113 and D-114):

- refund attribution: what a refund reverses, what it may not exceed, which
  semester it re-opens, and which surfaces read it.

Added in slice C:

- document numbering (receipt, student code, invoice, scoped documents): the
  sequence authority and uniqueness at rest;
- duplicate schema authority on the WP-07 tables (`invoices`, `invoice_items`,
  `payments`);
- the discount-authorization write path and the resolver's failure behaviour.

Excluded (unchanged, and not certified here):

- invoice creation/issue/cancel lifecycle beyond the payment path, refunds,
  receipts numbering policy, discount authorization, student balances;
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
| WP07-F8 | An unrecognised invoice payment method is recorded as **cash** | MEDIUM | `paymentMethod: 'cheque'` → 201, a 2,000 AFN payment stored as `cash`, while `POST /api/students/:id/payments` rejected the identical input with 400 |
| WP07-F9 | An idempotency key spent on one invoice fabricates a replay on another | HIGH | the same `Idempotency-Key` on a second, unpaid invoice returned **200 `idempotentReplay: true`** carrying the first invoice's receipt number, so an operator is told a collection succeeded that never happened — and is shown another payment's receipt |
| WP07-F10 | A retried payment that settled the invoice reports failure | MEDIUM | the state gate ran before the replay check, so a concurrent retry answered 400 "Only issued, partial, or overdue invoices can accept payment" although the money had been taken |
| WP07-F12 | A receipt number is not unique at rest | HIGH | the database accepted two payments carrying `R-00099001`, on insert and on update, while the generator's comment promised uniqueness. The receipt is the payer's proof, so an ambiguous number is an unauditable payment (LAW 3) |
| WP07-F13 | The canonical schema declares the same object twice | MEDIUM | one unique index under two names on `invoices`, one index under two names on `invoice_items`, and two branch-guard trigger pairs each on `invoices` and `payments` where the `IS NOT` pair strictly subsumes the `<>` pair (§12) |
| WP07-F14 | A discount grant is coerced, undated and its store fails silently | HIGH | `approvedPercent: [10]` granted 10%, `true` granted 1%, `''`/`null` created a 0% authorization record; `effectiveFrom: 'banana'` was stored and silently prevented the grant from ever activating (and `effectiveTo: 'banana'` from ever expiring); and a resolver that could not read the authorization table charged ordinary policy without a word |
| WP07-F16 | An installment payment settles no semester, so the same tuition can be collected twice | HIGH — **OPEN, owner decision required** | proven on a fresh database: a 4,000 AFN installment is stored with `semester = NULL`; the balance authority counts it (`tuitionPaid 4,000 / outstanding 6,000`) while the payment desk still offers the full 10,000 for that term **and accepts it** — 14,000 AFN collected for a 10,000 AFN term. Present at the WP-06 certified baseline `d29554b` and unchanged by slices A–D (`semName` is assigned only in the two fee branches) |
| WP07-F17 | An invoice payment is always booked as TUITION, whatever the invoice is for | HIGH — **OPEN, owner decision required** | proven on a fresh database: an issued invoice whose only line is "Textbooks and stationery" (3 × 1,000) is paid, `POST /api/invoices/:id/pay` writes `category = 'fee'` with no semester, and the student's tuition outstanding falls from 10,000 to 7,000. The tuition receivable is understated by the value of goods sold |
| WP07-F15 | A refund of one semester distorts another semester's price | HIGH | proven after D-114 landed: with Term A partially refunded by 2,000, Term B's outstanding read 12,000 instead of 10,000, and after Term B was paid in full the desk accepted a further payment against it (`amountCharged: 1`). Two inline copies of the semester-settlement rule counted every refund against whichever term was being paid |
| WP07-F11 | A refund is unattributed, so a non-tuition refund creates tuition debt | HIGH — **RESOLVED in slice D** | proven on a fresh database: tuition 10,000 paid in full, a 2,000 exam fee paid, then a 2,000 refund → the canonical balance authority reported `tuitionPaid 8,000 / outstanding 2,000`. The same authority feeds the roster, the portal, branch outstanding and the enrolment debt-hold, so a refunded exam fee could block a student's enrolment |

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
| Package test authority (budget/treasury/settings) | `server/src/tests/work-packages/wp07/budget-movement-authority.test.ts` (new, 40 cases) |
| Invoice payment: method refused not substituted; replay scoped to invoice + student in all three places; replay checked before the state gate; exact whole-AFN overpayment comparison; the now-unused global key lookup removed | `server/src/routes/invoices.routes.ts` |
| Package test authority (invoice payment) | `server/src/tests/work-packages/wp07/invoice-payment-boundary.test.ts` (new, 7 cases) |
| One sequence authority; `receipt.ts` / `invoice.ts` become typed callers | `server/src/utils/documentNumbers.ts`, `receipt.ts`, `invoice.ts` |
| `uq_payments_receipt_number`; duplicate index and subsumed guard pairs removed from the WP-07 tables | `server/src/db/schema.sql` (112 tables · 237 indexes · 113 triggers) |
| One percentage boundary consumed by the savings rate and discount grants | `server/src/utils/money.ts` (`assertPercent`), `core/configuration/finance-settings.ts` |
| Discount grant parsed; effective window through the canonical ISO-date authority; resolver no longer swallows a store failure | `server/src/routes/discount-authorizations.routes.ts`, `core/configuration/discount-authority.ts` |
| WP-02 structural case re-expressed by property instead of trigger name (forced by the schema consolidation, D-112) | `server/src/tests/work-packages/wp02/high-assurance-security.test.ts` |
| Package test authority (documents + authorization) | `server/src/tests/work-packages/wp07/document-and-authorization-integrity.test.ts` (new, 38 cases) |
| **Slice D** — `payments.refunds_payment_id` (FK, RESTRICT) with attribution and target triggers | `server/src/db/schema.sql` (112 tables · 238 indexes · 117 triggers) |
| Refund requires `paymentId`, caps at that payment's remainder (re-checked inside the transaction), inherits its semester; `GET /:id/refundable-payments` publishes the remainder | `server/src/routes/students.routes.ts` |
| Tuition counts a refund only when it reverses a tuition charge | `server/src/utils/studentBalance.ts` |
| Refund dialog names the payment and shows the server's remainder | `src/components/students/StudentsView.tsx`, `src/types.ts` |
| Seven fixture suites re-expressed to attribute their refunds (D-115) | WP-03 suites, `final-hardening`, `finance-money-writer-parity`, `system-closure-authorities`, `balance-single-source-of-truth` |
| One semester-settlement authority (`getSemesterTuitionPaid`) consumed by both payment-desk checks; two inline copies removed | `server/src/utils/studentBalance.ts`, `server/src/routes/students.routes.ts` |
| Package test authority (refunds + semester settlement) | `server/src/tests/work-packages/wp07/refund-attribution-authority.test.ts` (new, 19 cases) |

## VERIFY

| Command | Result |
|---|---|
| `npx vitest run src/tests/work-packages/wp07` | 104/104 passed |
| `npx vitest run` (server, full) | **2678 passed · 160 skipped** (the 160 are the explicit WP-04 retirements) · 0 failed |
| `npm run preflight:fresh-schema` | 112 tables · 238 indexes · 117 triggers; stands alone, sound, idempotent |
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

Invoice payment: an unrecognised method; each accepted method; an omitted
method; an overpayment by exactly one afghani (and the exact final afghani,
which is accepted); a shared `Idempotency-Key` replayed against a different
invoice; a keyed retry of a payment that already settled the invoice; and two
concurrent identical payments (one 201, one 200 replay, one `payments` row,
reconciliation healthy).

Slice D: a refund naming no payment; a payment id that does not exist; another
student's payment; a refund of a refund; one afghani over the remainder; the
exact remainder (accepted) followed by one more (refused); two concurrent
refunds of one payment (one 201, one 400, 8,000 total, reconciliation healthy);
a retried keyed refund (replay, one row); an unattributed refund written
directly to the database (refused by trigger); a charge claiming to reverse
something (refused); and deletion of a refunded payment (refused by the foreign
key).

Slice C: a duplicate receipt number by INSERT and by UPDATE; 100 interleaved
payment/refund allocations from one counter; an invoice number reused inside its
branch (refused) and in another branch (allowed, matching the counter); every
index shape and branch guard on the three WP-07 tables; `[10]`, `true`, `''`,
`null`, `'1e2'`, `'0x0F'`, whitespace, `Infinity`, `NaN` and an object as a
discount percent; `'banana'`, `'2026-13-45'` and a reversed window as an
effective window; a requested percent above the ceiling (recorded, never
granted); and a renamed authorization table (the resolver now raises instead of
quietly charging ordinary policy).

## REPAIR (findings from the independent review of the first checkpoint)

Reviewed cold from the diff, then repaired in the same slice:

| # | Review finding | Repair |
|---|---|---|
| R-1 | A budget line holding money could be retired, parking real money in an envelope excluded from pickers | `PATCH` refuses with 409 naming the balance |
| R-2 | A retired line could still be funded | `POST /charge` refuses with 409; the treasury debit shares the transaction |
| R-3 | The metric registry claimed the dashboard filtered `is_active = 1`; the SQL did not | The SQL now filters, which R-1 makes safe, and the registry row states why |
| R-4 | The savings rate had a second, laxer writer with no upper bound | One descriptor-based validation authority, consumed by all three writers |
| R-5 | An invalid setting was silently skipped behind a 200 | The writer parses and rejects; the response reports what it applied |

## CROSS-PACKAGE DEFECT FOUND AND DELIBERATELY RE-SCOPED (§106)

WP07-F9 is an instance of a class, not a one-off. A sweep of every money writer
that accepts a caller-supplied `Idempotency-Key` found the same unscoped replay
in `POST /api/funding/donations` (WP-09) and `POST /api/books/:id/sell`
(WP-10), and confirmed that payroll (WP-08) already applies the correct rule.
Rather than silently ignoring defects outside the WP-07 route boundary, the
slice was deliberately re-scoped to include the cross-cutting rule, which is
now pinned for all four writers by
`server/src/tests/idempotency-replay-scope.test.ts` and recorded as **D-109**.

Evidence that the defect was real before the repair: with the two route files
reverted, that suite fails 5 of 9 — a key spent on donor A returned **200 with
donor A's receipt number** for a request naming donor B, and a key spent on
book A returned 200 for a sale of book B with no stock movement and no income
row. WP-09 and WP-10 remain uncertified; only this rule is fixed in them.

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

## OPEN — OWNER DECISION REQUIRED (WP07-F16 and WP07-F17, charge-side attribution)

D-113 and D-114 settled what a REFUND attaches to. The same question is open on
the CHARGE side, in two places the repository does not answer:

- **WP07-F16** — `students.installment_plan` is a student-level JSON array of
  `{id, amount, status, dueDate}` with no link to a semester, while a student may
  hold several concurrent enrolments. Nothing in the data says which term an
  installment settles, so the payment desk stores `semester = NULL` and the term
  stays collectable in full.
- **WP07-F17** — an invoice carries free-text line items and its payment is
  hard-coded to `category = 'fee'`. Nothing records whether an invoice is for
  tuition or for something else, so every invoice payment is counted as tuition.

Both are money-truth defects with real cash consequences (double collection;
understated tuition receivable). Both need a rule that cannot be derived from
repository evidence, so under §105 they are raised rather than guessed. Nothing
in either path was changed.

## RESOLVED BY OWNER DECISION (WP07-F11, refund attribution)

Slice C stopped rather than guessing. The repository contained two
contradictory positions and no evidence that resolved them:

- `POST /api/students/:id/refund` computes its refundable base from **every**
  completed non-refund payment — tuition, book, exam, card, placement, diploma —
  and records the refund with no link to what it reverses;
- `server/src/utils/studentBalance.ts` counts **every** refund against tuition
  (`fee | installment | refund`), and its own comment states that non-tuition
  categories "do not pay down tuition".

Both cannot be right. Proven consequence (fresh database): refunding a 2,000 AFN
exam fee leaves a student who has paid tuition in full showing 2,000 AFN of
tuition debt, which the enrolment debt-hold then acts on.

Fixing this required a rule the repository did not contain. It was raised under
§105 and the owner answered on 2026-08-21:

- **D-113** — a refund reverses **the specific payment** being returned; it is
  capped at that payment's un-refunded remainder and inherits its category;
- **D-114** — a **tuition** refund names its semester, so only that semester's
  debt re-opens.

Slice D implements exactly those two rules and nothing more. The refund inherits
the semester from the payment it reverses rather than accepting one from the
caller, because two independently supplied facts can disagree and only one of
them can be right.

## CERTIFICATION (scope-limited)

**READY — for the concerns in SCOPE only.** Every defect listed above was
reproduced before repair and is pinned by an executed test; every applicable
gate passes; no business policy was invented; no schema change was required.

**WP-07 Finance remains NOT CERTIFIED.** Discharged by slices C and D: document
numbering and uniqueness at rest, WP-07 duplicate schema authority, the
discount-authorization input boundary and failure behaviour, and refund
attribution under the owner's two rules. Still outstanding, and deliberately not
claimed:

- **WP07-F16 (installment → semester) and WP07-F17 (invoice → obligation) —
  BLOCKED on the owner decisions above;**
- payment allocation — narrowed by inspection, not yet certified. The
  charge side is already explicit: `fee` requires `semesterId`, `installment`
  requires `installmentId` and must match its amount, `book` requires `bookId`,
  and `chapter`/`exam`/`other` are documented as deliberately unbacked ad-hoc
  charges. What was missing was the settlement rule, now consolidated as
  `getSemesterTuitionPaid` (D-116). Installment-plan state transitions and their
  interaction with semester debt remain unexamined;
- invoice creation/issue/cancel lifecycle beyond numbering and the payment path;
- the WP-07 legacy-test disposition under C-2 (35 inventoried files / 409 cases
  are still the behavioural record; the three package suites replace none of
  them);
- the re-certification burden recorded in `docs/certification/WP-07-finance.md`.
