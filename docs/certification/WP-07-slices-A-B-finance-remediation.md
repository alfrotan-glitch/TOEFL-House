# Remediation Record — WP-07 Slices A–E · Budget/treasury authority, the invoice payment boundary, document/authorization integrity, refund attribution, and scholarship funding

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

Added in slice E (owner decisions D-120 and D-121 — Decision 4 and Decision A/E1-core):

- `student_obligations` + `obligation_allocations`: the single settlement
  authority, tuition obligations only, amount derived from the existing tuition
  authority;
- `scholarship_fundings`: donation money allocated into a fund — the only
  backing a fund can have;
- scholarship award lifecycle, application to obligations, reversal and close;
- the settlement rule consumed by the payment desk and the student balance, so a
  scholarship-settled term cannot be collected again in cash.

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
| WP07-F16 | An installment payment settles no semester, so the same tuition can be collected twice | HIGH — **RESOLVED in slice E3 (D-125)** | proven on a fresh database: a 4,000 AFN installment is stored with `semester = NULL`; the balance authority counts it (`tuitionPaid 4,000 / outstanding 6,000`) while the payment desk still offers the full 10,000 for that term **and accepts it** — 14,000 AFN collected for a 10,000 AFN term. Present at the WP-06 certified baseline `d29554b` and unchanged by slices A–D (`semName` is assigned only in the two fee branches) |
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
| `npx vitest run src/tests/work-packages/wp07` | 131/131 passed |
| `npx vitest run` (server, full) | **2705 passed · 160 skipped** (the 160 are the explicit WP-04 retirements) · 0 failed |
| `npm run preflight:fresh-schema` | 115 tables · 245 indexes · 122 triggers; stands alone, sound, idempotent |
| `npm run release:validate` (after slice E) | **22 passed · 0 failed · 0 skipped**; fresh install 115 tables; financial invariants reconcile |
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

## SLICE E — SCHOLARSHIP FUNDING (Decision 4 + Decision A/E1-core)

**Owner decisions implemented:** D-120 (one settlement authority; scholarship
settlement moves no cash and no income), D-121 (a fund is backed only by
donations explicitly allocated to it; institution-funded funds are impossible by
construction). S5 and S6 remain blocked by owner instruction and were not
touched.

**Checkpoint.** `docs/work-packages/WP-07-decision-4-checkpoint.md` records the
first pass as BLOCKED and the second as CLEARED, with the revalidation of every
approved rule and two mechanics recorded rather than assumed (D-122).

**Attack — what was exercised.** An unfunded fund with a 50,000 AFN declared
target awarding anything; an award one afghani over received backing; a donation
allocated beyond its own value; a cross-branch donation funding a fund; an
allocation to another student's obligation; an allocation naming no obligation;
zero, negative, fractional, string, array, boolean and null amounts; more than
the award's remainder; more than the obligation's outstanding; **two concurrent
applications of one award**; **two concurrent awards against one fund**; a
reversal with no reason; a double reversal; a reversal through another award;
applying a closed award; a direct-database allocation naming two instruments or
none; a second obligation for one semester; an obligation over another student's
semester; and deletion of a funded donation and a settled obligation.

**The accounting property, proven rather than asserted.** After a donation is
recognised once and a scholarship settles a term: the ledger holds exactly one
income row (`donation`), branch cash is unchanged by the settlement,
`computeReconciliation` stays healthy, the student's tuition position falls by
the settled amount, and the payment desk refuses to collect that term again.

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
understated tuition receivable). Both needed a rule that cannot be derived from
repository evidence, so under §105 they were raised rather than guessed.

The owner answered on 2026-08-21 with a business direction (**D-117**, **D-118**)
and instructed that nothing be implemented until the current model has been
verified against it. That verification is
`docs/work-packages/WP-07-payment-allocation-analysis.md`: it establishes what
already supports the direction, eight structural gaps with evidence (no
obligation identity; tuition attributed by an ambiguous NAME; the installment
plan is unnormalized JSON with no enrolment link; invoices carry no purpose or
obligation; no partial or multi-obligation allocation; four independent
allocation rules including a BOS reporting heuristic; free-text semesters
repeated across five tables; fixed fees with no obligation at all), three
candidate models assessed against the owner's rules, and six questions the owner
must answer before any schema change. **Nothing in either path was changed, and
no schema change was made.**

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

- **WP07-F17 (invoice → obligation) — approved by the owner (invoice declares
  its purpose and a tuition invoice names its obligation) and NOT YET BUILT;**
  WP07-F16 is closed by slice E3 (D-125);
- **S6 (sponsorship agreements are financial)** — approved and not yet built;
- **S5** — owner ruled the SPONSORSHIP discount and scholarships are *different*
  concepts; the boundary must be documented so they cannot be confused;
- **E1b** — migrating cash payments onto `obligation_allocations`. Today cash
  tuition is still attributed by `payments.semester` and scholarship money by
  allocations; both are read through one settlement authority
  (`getSemesterTuitionSettled`), so no figure disagrees, but the storage is not
  yet unified. `source_kind = 'payment'` is declared and unused until then;
- ~~the funding **UI** for slice E~~ — **completed**. `FundingView.tsx` now
  renders the server's fund position (received / committed / available beside
  the declared target), funds a scholarship from a received donation, applies an
  award to a named tuition obligation, reverses an application and closes an
  award. The retired browser-side arithmetic (`totalBudget − allocatedAmount`)
  is gone, and the screen invalidates the student/payment datasets it affects,
  which the §35 freshness rule caught and now enforces;
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

---

# Slice F — the invoice says what it bills (WP07-F17, WP07-F19)

**Date:** 2026-08-21 · **Baseline:** `bb41398` · **Owner decisions executed:** D-118 (recorded → implemented as D-127)
**Release gate:** 22 passed · 0 failed · 0 skipped · **Server suite:** 2740 passed · 160 known WP-04 skips · 0 failed
**Schema:** 116 tables · 248 indexes · 125 triggers (stands alone, sound, idempotent, sole authority)

## The defect, proven before repair (§103)

`POST /api/invoices/:id/pay` wrote `category = 'fee'` for every invoice and never
wrote `semester`. One literal, two opposite money errors:

```
× a books invoice, paid in full, leaves tuition untouched
  AssertionError: expected 7000 to be 10000
× a tuition invoice, paid in full, settles the term it names
  AssertionError: expected +0 to be 10000
× a term paid through its invoice cannot be collected a second time at the desk
  AssertionError: expected 201 to be 400
```

A 3,000 AFN *Textbooks and stationery* invoice forgave 3,000 AFN of tuition
receivable. A 10,000 AFN tuition invoice, paid in full, settled no term, so the
desk would take the same 10,000 AFN again.

## What ATTACK found that no report had (WP07-F19)

Two 6,000 AFN tuition invoices on a 10,000 AFN term were **both** created and
**both** paid. Each was individually within its own remaining balance and
nothing looked at the term, so 12,000 AFN was absorbed by a 10,000 AFN term
(`creditBalance 2000`). Repaired by `tuitionBillingCapacity` (D-128); the second
invoice is now refused with *"That term has only 4000 AFN left to bill"*.

## What is now true

| Rule | Enforced by |
|---|---|
| An invoice declares its purpose; there is no default | `assertInvoicePurpose`, `invoices.purpose NOT NULL CHECK` |
| A tuition invoice names exactly one obligation; nothing else may name one | table `CHECK`, `trg_invoices_obligation_owner_{insert,update}` |
| Only a tuition invoice's payment is recorded as `fee` and carries a term | `invoicePaymentAttribution` — the sole resolver |
| A term may not be billed beyond what it bills | `assertTuitionInvoiceFits` (D-128) |
| A document with no line items cannot take money | `assertInvoiceHasLines` |
| The operator chooses the purpose, and the term when it is tuition | `InvoicesPanel.tsx` purpose selector + term selector |

## Scope honesty

* **NOT closed — WP07-F18 (owner question raised, A-18):** the enrolment auto-invoice bills a *mixture* (`registration` + `semester` fees) against a `student_semesters` row inserted with `fee_amount = 0`. Tuition receivable therefore still has two representations depending on which door the student came through. The interim `other` classification is forced and loses nothing today, but the underlying split is an owner decision.
* **NOT started in this slice:** E1b (cash payments onto `obligation_allocations`), S5, S6.
* This slice writes the **existing** settlement authority (`payments.semester`, D-116), not a second one. The migration of all cash onto allocations is step 4 and is done once, for every writer.

---

# Slice G — sponsorship money is real money (S6), and the S5 boundary is guarded

**Date:** 2026-08-21 · **Owner decisions executed:** S6 (→ D-131/D-132/D-133), S5 (→ D-134)
**Release gate:** 22 passed · 0 failed · 0 skipped · **Server suite:** 2771 passed · 160 known WP-04 skips · 0 failed
**Schema:** 117 tables · 251 indexes · 127 triggers

## The pre-state, as fact

`grep -rn "sponsorship" server/src --include=*.ts` over the source before this
slice returns counts, list queries, a create/update route and one event name.
**No code path read `monthly_amount` for any financial purpose.** An agreement
promising 5,000 AFN a month reduced no tuition, settled no term and appeared in
no position. The number existed and meant nothing.

## The model

```
donation (income recognised here, once)
   └─ sponsorship_receipts        earmarked to the agreement, by the SIGNING donor
        └─ obligation_allocations source_kind = 'sponsorship'  → settles a tuition term
                                  no cash · no ledger row
```

A third instrument, one settlement authority. `obligation_allocations` gains
`sponsorship_agreement_id` and a third `source_kind`, with the exactly-one-of
CHECK extended so an allocation can never name two instruments.

## Rules pinned by executed tests (31 cases)

| Rule | Evidence |
|---|---|
| A promise settles nothing | 5,000 AFN/month, no receipts → `400 has received no money yet`; student still owes 12,000 |
| Received money settles the named term | after a 5,000 receipt + allocation: term settled 5,000, outstanding 7,000 |
| No cash is created | branch main and saving balances unchanged, ledger row count unchanged, reconciliation healthy |
| Bounded by what it received | `Only 3000 AFN of this sponsorship is still unapplied` |
| Bounded by what the term owes | `Only 12000 AFN is still outstanding` |
| It cannot reach a student it does not name | `403` |
| The money must be the signing donor's | route check **and** `trg_sponsorship_receipts_donor_insert` |
| One afghani cannot back two commitments | 5,000 donation, 4,000 to a fund → a 2,000 receipt is refused, 1,000 accepted |
| A reversal returns money to its agreement, not the student | available back to 12,000, term re-opens to 12,000, second reversal `409` |
| A terminated agreement receives and settles nothing | `409` on both |
| Amount coercion is refused at both boundaries | 8 adversarial values × receipt and allocation, nothing written |

## S5 — the boundary the owner ruled on

Both concepts stay, and the difference is now asserted rather than remembered:

* **Discount `SPONSORSHIP`** reduces what the student is **charged**; no donor money exists; owner authorization required.
* **Sponsorship agreement** leaves the charge untouched and **settles** it with a donor's received money.

Proven: applying a sponsorship leaves `student_semesters.net_fee_amount`
unchanged and yields exactly one `sponsorship` allocation — the debt is gone
because it was paid, not because it was reduced.

## Scope honesty

* **Server-complete, operator-incomplete.** The four sponsorship endpoints exist and are proven, but `FundingView.tsx` does not yet expose them: an operator cannot record a receipt or apply a sponsorship from a screen. The scholarship lifecycle (D-124) has its surface; the sponsorship lifecycle does not.
* **E1b not started** — cash is still attributed by `payments.semester`.
* **WP07-F18 still open** and awaiting the owner (A-18).

---

# Slice H — the enrolment bills by purpose (WP07-F18, WP07-F20)

**Date:** 2026-08-21 · **Owner decisions executed:** split model, retake = tuition, discount attaches to tuition (→ D-136/D-137/D-138)
**Release gate:** 22 passed · 0 failed · 0 skipped · **Server suite:** 2788 passed · 160 known WP-04 skips · 0 failed
**Schema:** 117 tables · 251 indexes · 127 triggers

## The defect, proven before repair (§103)

```
× the term the enrolment creates bills the tuition, not zero
  AssertionError: expected +0 to be 8000
× the enrolment issues one tuition invoice naming the term and one other invoice
  AssertionError: expected [ { …(7) } ] to have a length of 2 but got 1
× a discount larger than the tuition is refused, even when the whole snapshot is bigger
  AssertionError: expected [Function] to throw an error
```

The term billed **0** while the invoice billed 8,000, so `getStudentBalance`
reported no tuition debt for that student at all. A 9,000 AFN discount on 8,000
AFN of tuition was accepted because it was measured against the 9,500 AFN
snapshot total.

## What ATTACK found — WP07-F20

`EnrollmentService.enroll` coerced its discount with `Math.max(0, Number(x))`:
`true` became a **1 AFN discount**, `[1000]` became **1,000 AFN**, and `-1000`
became a silent **0**. The journey route parses with `assertMoney`, but every
caller converges on the service, which did not. Repaired there (D-140).

## What is now true

| Rule | Enforced by |
|---|---|
| The term carries the tuition it bills | `stmtInsertNewSemester` writes `fee_amount` / `net_fee_amount` |
| A tuition invoice names the term's obligation | `ensureTuitionObligation` + `invoices.obligation_id` CHECK (D-127) |
| Registration is billed on its own document | `partitionFeeSnapshot` + two `issueInvoice` calls |
| `semester` and `retake` are tuition; nothing else is | `TUITION_FEE_TYPES`, one declaration read by two callers |
| A discount attaches to tuition only | service check + journey ceiling on `tuitionTotal` |
| A fully discounted term still records its document | `gross > 0` issues the invoice even at net 0 |
| Tuition is billed only against a term this call created | `termId` / `writeSemester` branch (D-139) |
| The discount is parsed, not coerced | `assertMoney` (D-140) |

## Scope honesty

* **Residual, recorded not hidden (D-139):** an enrolment with no class creates no term, so no tuition obligation exists to name and the whole snapshot is billed as one `other` document. Such an enrolment creates no tuition receivable in the balance authority.
* **F-18b remains open and unclaimed:** `reports.routes.ts:389-409` sums open invoices as "outstanding" while the balance authority derives tuition outstanding from `student_semesters`. On the conversion path both exist, so the two figures overlap. Pre-existing, unchanged by this slice, and deliberately not resolved here (§106).
* **F-18c fixed in passing:** the false "EnrollmentService is the single writer" comment is replaced with the true statement that two other writers create the term themselves and pass `writeSemester: false`.
* **E1b is next.**

---

# Slice I — cash settles through the one authority (E1b, WP07-F21)

**Date:** 2026-08-21 · **Owner decisions executed:** refund reverses its allocation; allocations authoritative now, column retired later (→ D-141/D-142/D-143)
**Release gate:** 22 passed · 0 failed · 0 skipped · **Server suite:** 2801 passed · 160 known WP-04 skips · 0 failed
**Schema:** 117 tables · 251 indexes · 127 triggers (no schema change — `source_kind='payment'` was already declared)

## What changed

`obligation_allocations` declared three instruments and used two. Cash is now
the third: every tuition cash writer allocates, and `getSemesterTuitionPaid`
reads allocations rather than the free-text `payments.semester`.

| Writer | Allocates |
|---|---|
| payment desk, `category='fee'` | the obligation of the named term |
| payment desk, `category='installment'` | the obligation the plan belongs to (D-125) |
| tuition invoice payment | the obligation the invoice names (D-127) |
| visitor conversion | the obligation of the term the conversion creates |
| enrol-semester collection | the obligation of the term being opened |

## Why it is not merely tidiness

`uq_student_semester_active` is `UNIQUE(student_id, semester_name) WHERE
status = 'active'`, so a term NAME is unique only among active terms — **not
over time**. The suite's central case takes "Term One", pays it in full,
completes it, and opens a second "Term One". Each term now reports exactly what
it was paid, and the second is collectable in full.

## What ATTACK found — WP07-F21

Precise allocations were not sufficient on their own. The payment desk still
computed a term's debt with `getSemesterTuitionSettled(studentId, semesterName)`
— **by name** — so the first term's payments were counted against the second and
the desk answered `400 This semester is already fully paid` to a legitimate
collection. Both desk reads now key on the obligation (D-143).

## The refund fork, as the owner ruled it

A refund reverses the allocation it targets and re-allocates whatever the
student keeps settled:

* full refund → allocation reversed, term re-opens by the whole amount;
* 3,000 refund on a 10,000 payment → one reversed row, one fresh active 7,000 row, exactly 3,000 re-opened, 3,001 refused;
* two successive partial refunds each reduce the term by exactly their amount;
* a refund of a non-tuition charge touches no allocation.

Reconciliation stays healthy throughout, and `CHECK (amount > 0)` still guards
every instrument.

## Scope honesty

* **`payments.semester` is still written** for display and refund attribution. It is no longer the settlement key. Retiring the column is the agreed follow-on, once no reader remains.
* **BOS revenue attribution is unchanged.** `stmtRevenueByClass` / `stmtRevenueByTimeSlot` still guess the term by name. E1b makes a correct attribution possible; using it is a reporting-side change that should carry its own defect ID.
* **F-18b unchanged** — the open-invoice "outstanding" figure in `reports.routes.ts` still overlaps the balance authority.
* **S6 remains server-complete, operator-incomplete** — `FundingView.tsx` still does not expose the sponsorship endpoints.
