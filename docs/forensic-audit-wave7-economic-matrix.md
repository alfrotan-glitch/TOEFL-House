# Wave 7 — Economic Event Matrix & Completeness Verdict (2026-09-05)

Protocol: begin from real-world economic events, not the ledger. For every
event: operational record → financial consequence → asset/revenue effect →
cash effect → historical trace → reversal path → reporting consequence.
A chain with a missing link is a defect. Prior waves' results were treated as
hypotheses and re-attacked; every ⭑ below was re-verified in wave 7.

## 1. The matrix

### Equity & treasury

| # | Economic event | Operational record | Financial consequence | Cash effect | Trace | Reversal | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | Owner capital injection | treasury/deposit | `income/capital_injection` + org main credit | external IN (equity) | tx row + audit | n/a (equity in) | ⭑ excluded from revenue |
| 2 | Fund envelope from treasury | budget-lines/:id/charge | `budget_charge/allocation` (signed) + org debit + envelope credit | internal | tx row | month-end return | ⭑ guarded decrement; race 1-of-8 |
| 3 | Return unused envelope | month-end `return` | `budget_return` (negative) + envelope debit + org credit | internal | tx row | charge again | ⭑ single execution proven |
| 4 | Envelope↔envelope transfer | month-end `transfer` | `transfer_out` + `transfer_in` pair | internal, nets zero | 2 tx rows | opposite transfer | ⭑ same-branch enforced |
| 5 | Owner profit drawing | BOS withdraw | `expense/owner_drawing` (equity) + branch main debit | external OUT | tx row + audit | none (final) | ⭑ liquidity floor enforced |

### Payroll

| # | Event | Record | Consequence | Verdict |
|---|---|---|---|---|
| 6 | Salary paid (full/partial) | salary ledger (idempotent) + `expense/salary` + envelope debit | cost; due-cap = base − Σposted | ⭑ uncapped overpay impossible |
| 7 | Salary advance | ledger + `expense/salary_advance` (non-expense class = receivable) + envelope debit | receivable, **recovered via due-cap that includes advances** | ⭑ verified: advance + later salary cannot exceed base |
| 8 | Payroll void | status→voided **inside BEGIN IMMEDIATE + fresh re-read** | contra negative row + envelope credit | ⭑ double-void serializes 409; economic effect truly reversed |
| 9 | Future-period payroll | period format validated only | prepaid salary = expense now (cash basis) | ◻ note W7-3: representable, cash-basis defensible |

### Student economics

| # | Event | Record | Consequence | Verdict |
|---|---|---|---|---|
| 10 | Tuition billed (term) | `student_semesters` fee (immutable) + obligation row (identity link) | receivable = Σterms − Σallocations | ⭑ single amount authority; no writer ever updates fee/net_fee |
| 11 | Tuition paid (desk) | payment + obligation allocation + `income/fee` + savings sweep | settles THE obligation (keyed by id, not name) | ⭑ over-collect refused |
| 12 | Tuition paid (journey) | invoice + invoice-pay → allocation | same settlement layer | ⭑ cross-surface caps enforced |
| 13 | Registration/placement/card/diploma fee | invoice (charge_kind) + invoice-pay | `income/<kind>` | ⭑ |
| 14 | Refund | negative payment + allocation reversal + negative income + savings reclaim | contra-revenue; cash back | ⭑ sweep reversed, never re-swept |
| 15 | Discount | `net_fee_amount` set at term creation / invoice issue only | receivable reduced at origin | ⭑ immutable afterward; no post-payment discount edits |
| 16 | Drop | semester→deferred, obligation KEPT | debt preserved, still payable (settlement keys on obligation, not status) | ⭑ lifetime scope counts it |
| 17 | Re-enroll after drop | reactivates SAME term | no new debt | ⭑ one term, one invoice |
| 18 | Class transfer | source completed + destination 0-fee term | obligation preserved, no double bill (D-88) | ⭑ receivable authority lifecycle-inclusive — verified against source |
| 19 | Retake/repeat | new term at class fee + retake invoice | new obligation | ⭑ 6,500+2,000 proven |
| 20 | Debt forgiveness / write-off | — | — | ✖ **GAP W7-2**: no write-off surface exists; a dropped student's debt is owed forever. Recording rather than inventing policy (§61); needs an owner decision on forgiveness semantics |
| 21 | Desk ad-hoc `other` payment | payment + `income/other` | revenue; settles nothing | ◻ control note: bypasses invoice documents (carried from W6) |

### Books / inventory

| # | Event | Record | Consequence | Verdict |
|---|---|---|---|---|
| 22 | Stock acquired | receipt (+ W6-1 purchase declaration) | atomic guarded envelope debit + `expense/book_purchase` OR explicit `separate`/`not-applicable` | ⭑ silence = 400 |
| 23 | Stock sold | sale + payment + `income/book` | revenue; availability guard | ⭑ |
| 24 | Sale refunded | refund row + negative payment + negative income | stock restored via view (NOT EXISTS) | ⭑ auto, idempotent, transactional |
| 25 | **Stock lost/found/count-fix** | **NEW: `book_stock_adjustments`** (W7-1) | quantity-only fact, NO financial leg (cost was expensed at purchase) | ⭑ fixed this wave: was unrepresentable without fabricating a sale |
| 26 | Book loan / return | loan / loan-return | availability reservation only; no money | ⭑ guards include adjustments now |
| 27 | Inventory at cost | `unit_cost` on receipts + purchase tx | derivable: Σ(receipts×cost) − sold portion | ◻ follow-up: surface as a workspace metric (cash basis keeps P&L correct) |

### Funding

| # | Event | Record | Consequence | Verdict |
|---|---|---|---|---|
| 28 | Donation | donation row + `income/donation` paired in one transaction | revenue; restriction = real subledger | ⭑ one destination max |
| 29 | Scholarship award/allocation | obligation allocations (aid) | settles tuition receivable, no cash | ⭑ triple-guarded (fund/award/obligation) |
| 30 | Scholarship reversal | allocation reversed | money returns to AWARD, not student | ⭑ donor commitment preserved |
| 31 | Sponsorship return/terminalize | campaign funding entry (origin sponsorship_return) | internal re-route of unspent commitment | ⭑ no new cash, no double income |

## 2. I16's "external flow" — formal status

Definition attacked: external = `type='income'` (cash in) or `type='expense'
(cash out); internal = `budget_charge` / `saving_transfer` (moves between
counted stores only).

- **Exactly once IN/OUT:** the complete writer inventory (waves 5–7, source +
  live ledger) shows every external row is written by exactly one production
  writer paired with exactly one store mutation, and no store mutator exists
  without its row. The DB CHECK constrains `type` to the four-value
  vocabulary, so no dual-natured or orphan type can be written by any route
  that passes the schema.
- **No internal/external ambiguity:** capital injections are external-in
  (equity) and counted; owner drawings external-out and counted; refunds are
  negative income and counted; budget and savings movements are typed
  internal and only ever move money between counted stores. No writer can
  move store-to-store cash under `income`/`expense` types.
- **Honest limit:** conservation covers CASH stores only. Receivables and
  inventory are economic state outside its scope (§1 rows 10–27 cover them),
  and an event never recorded (the W6-1 class) is invisible to every
  internal-consistency check — which is why W6-1/W7-1 are boundary
  requirements, not invariants.

## 3. Independent report battery (live world, my SQL ≠ app SQL)

| Figure | My derivation | Endpoint/ledger | Match |
|---|---|---|---|
| Revenue | payments-net + donations = 22,900 | ledger operating income 22,900 | ✓ |
| Payroll | salary ledgers Σ = 4,200 | salary/salary_advance rows 4,200 | ✓ |
| Cash (all stores) | income − expense = 118,200 | stores 118,200 | ✓ |
| Envelopes | signed movements − spend = 87,300 | envelope currents 87,300 | ✓ |
| Receivables (branch) | per-student Σ max(0, terms − payments − aid) = 25,000 | report 25,000 | ✓ |
| Settlement layer | allocations 18,000 = tuition payments 18,000 + aid 0 | ✓ complete both directions | ✓ |
| Donations | donations table = donation income rows | ✓ | ✓ |
| Inventory | receipts − net sales = 19 | view available 19 | ✓ |
| Advances | advance ledgers 700 = ledger advance rows 700 | ✓ | ✓ |

Two probe errors during this battery (category scope, movement sign
assumption) were caught by decomposition and are recorded as process notes —
the system reconciled exactly once the probes were correct.

## 4. Findings

- **W7-1 (fixed): stock loss/found unrepresentable.** The only
  quantity-decreasing event was a sale — which books revenue — so a physical
  loss had no honest representation. Fixed with `book_stock_adjustments`
  (quantity-only, kind loss/found/correction, reason ≥8 chars, idempotent,
  immutable by trigger, availability floor enforced in-trigger, sale/loan
  guards and the inventory view include adjustments, schema convergence via
  DROP+CREATE for the two changed triggers). No financial leg — correct under
  the system's cash basis (cost expensed at purchase). 6/6 tests + 7/7 live.
- **W7-2 (gap, recorded not implemented): no debt write-off surface.** A
  dropped student's tuition debt is permanently owed; only payment settles
  it. Forgiveness is business policy (§61 no-invented-policy) — needs an
  explicit owner decision (who may forgive, what happens to the revenue
  already recognized, notification/audit requirements).
- **W7-3 (note): future payroll periods accepted.** `requirePayrollPeriod`
  validates format, not recency; prepaid salary records as current expense
  (defensible under uniform cash basis; recorded for the controller).
- **W7-4 (note): books dates accept back/future-dating** (`soldOn`,
  `receivedOn`, `returnedOn`, `adjustedOn`: format-valid only). Reports filter
  consistently by the stored date, conservation is unaffected; an authorized
  user can shift book revenue between reporting months. Audit trail records
  the operator. Recorded as a control consideration, not a defect.

## 5. Verdict (the eight questions)

1. **Proven trustworthy:** the cash spine — treasury, envelopes, payroll,
   drawings, income/refund pairing, conservation (I16), settlement layer
   (obligation allocations), books acquisition/sale/refund/adjustment
   economics, scholarship/restriction subledger, race and idempotency
   behavior, the receivable authority.
2. **Mathematically consistent but economically unproven:** period allocation
   under cash basis for prepaid salary (W7-3) and backdated books documents
   (W7-4) — consistent, but period truth rests on operator honesty + audit
   trail rather than control; inventory-at-cost visibility (row 27) is
   derivable but not surfaced.
3. **Economically incorrect (found and fixed in waves 6–7):** books
   acquisition invisibility (W6-1), server-timezone business dates (W6-2),
   stock loss unrepresentability (W7-1).
4. **Material defects outstanding:** none open. W7-2 (write-off) is a
   capability gap awaiting a policy decision, not a misstatement.
5. **Historical records affected:** legacy pre-W6.1 receipts carry NULL
   purchase declarations (pre-declaration history, surfaced as such); no
   other historical population is affected — migrations audited (wave 5) and
   re-checked this wave.
6. **Insufficient invariants:** all of I1–I16 share one structural limit —
   they compare the system to itself and cannot see an unrecorded event
   (proven twice: W6-1, W7-1). The countermeasure is boundary requirements on
   event surfaces (both added). I16's external-flow definition itself proved
   sound (§2).
7. **Architecture sound?** Yes within its declared model: single cash-basis
   ledger, one amount authority per concept, guarded decrements, immutable
   facts + explicit reversals, paired document/ledger writes. No competing
   representation of the same debt is used for balances (invoice ≠ authority;
   obligation = identity link; term = amount; allocation = settlement).
8. **Redesign vs patch:** nothing requires redesign. Two additions were
   architectural in spirit (acquisition accounting, adjustment surface); the
   write-off surface (W7-2) is the one future structural addition, pending
   policy.

**Suite:** 215 files, 2,900 passed, 2 skipped (one unreproduced single flake
in the first post-change run; three subsequent full runs clean). **Live:**
invariants I1–I16 pass, reconciliation 0/0, adjustment drill 7/7 on the
running server.
