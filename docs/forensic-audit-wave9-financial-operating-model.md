# Wave 9 — Financial Operating Model & Architecture Adequacy Verdict

**Date:** 2026-09-05 · **Discipline:** design before code. No implementation in
this wave. Governance constraints honored: MASTER_ENGINEERING_PROTOCOL §61/§105
(no invented business rules), LAW 4 (financial truth sacred), LAW 10 (UNKNOWN →
UNKNOWN). Policy may only come from: the protocol, the permission catalog, the
canonical category taxonomy, SYSTEM_DEFAULTS, and behavior the code itself
DECLARES. Everything else is marked **UNKNOWN** with the exact decision named.

---

## 0. The declared accounting basis, stated precisely

The system's documents never say "cash basis" as such; the basis must be read
from what the code declares. Deduced from writer behavior (waves 5–8, source
+ live):

1. **Revenue is recognized when cash is received** (every income row is
   paired with a payment/donation document, atomically).
2. **Expense is recognized when cash is paid** (every expense row is paired
   with an envelope/balance debit, atomically).
3. **Inventory cost is recognized at acquisition** (W6-1); no COGS at sale.
4. **Capital expenditure is excluded from the trading result** and reported
   on its own line; no depreciation, no asset register.
5. **Alongside cash recognition, the system maintains ECONOMIC-STATE MEMOS:**
   obligations + allocations (receivables), salary-advance classifications
   (staff receivables), donation restrictions (donor commitments),
   scholarship/sponsorship subledgers (restricted fund flows).

Therefore the true model is not "cash basis" but:

> **Cash-recognition accounting with economic-state memos.**

**Coherence law (the central test of this wave):** a cash-recognition system
may legitimately *time-shift* recognition, but every memo state it creates
must be **lifecycle-complete** — every obligation created must have a
discharge path (payment, refund, settlement, or explicit renunciation), and
every claim it asserts must be derivable to zero or to an explicitly
explained residual. Wave 8's gaps are precisely lifecycle-incomplete or
missing memo states:

| Memo state | Created by | Discharge paths today | Complete? |
|---|---|---|---|
| Student tuition obligation | enrollment | payment, aid allocation | **no renunciation path** |
| Staff advance receivable | payroll advance | recovery via due-cap | **no renunciation path** |
| Employee deduction (if any) | — | — | **cannot exist at all** |
| Supplier payable | 'separate' promise | **none — not even tracked** | **missing state** |
| Loan liability | — | — | **missing state** |
| Restricted commitment | donation restriction | allocation to purpose | tracked, **not enforced, not exposed** |

This framing converts "missing feature" into "violated coherence law," which
is what makes each verdict below defensible rather than a wish list.

---

## 1. Supplier payables

### Policy questions (owner decisions required)

| # | Decision | Why it matters economically | If left undefined |
|---|---|---|---|
| P1 | Does TOEFL House buy goods on supplier credit at all? (Kabul publishers often demand cash on delivery.) | Determines whether a payable state exists in the business | `separate` promises stay unreconciled words |
| P2 | Do recurring supplier ACCOUNTS exist (identity, terms, statements), or only anonymous purchases? | Supplier identity as an entity vs. a free-text payee | Payables could never age or reconcile per supplier |
| P3 | Who may authorize a credit purchase and its settlement? | Control over future cash commitments | Anyone with Expense.Create could commit the institute |
| P4 | Are purchase commitments (orders before delivery) material? | A PO is a memo state even before goods | Likely immaterial at this scale — E |

**Answered by source:** none. **All UNKNOWN.**

### Economic semantics derived from the declared basis (policy-independent)

- **Cash purchase** (current W6-1 path): goods + expense + envelope debit,
  one atomic fact. Correct and complete. **No change.**
- **Credit purchase**, if P1 = yes: goods receipt creates a **payable memo**
  (quantity + value + supplier per P2). NO expense row at receipt (cash has
  not moved — consistent with cash recognition). At settlement: envelope
  debit + expense row + payable discharge, one atomic fact. **Exactly one
  expense per purchase, at the cash event — double-counting is impossible by
  construction.**
- **Partial delivery / partial payment**: payable carries the residual;
  settlements are append-only allocation rows against it.
- **Supplier rebate/refund/price correction**: money returning from a
  supplier is a **contra-expense** (negative expense event), never income.
  Today's positive-only expense surface forces it into `income/other`
  (fabricated revenue) — see §5.
- **Goods received, never paid, supplier vanishes**: under cash recognition
  the institute never records an expense; the payable memo is renounced
  (write-off of a payable — mirror of receivable write-off, §2); the windfall
  is that inventory was acquired free — economically a donation-in-kind,
  which the `not-applicable` declaration already represents. Coherent.

### Architecture analysis

The proven **obligation + allocation pattern** (identity-linked receivable
memo, append-only settlements, reversal with reason) is exactly the shape a
payable needs, inverted. No existing entity is overloaded by adding a
supplier-payable memo that mirrors it; the books receipt's `separate`
declaration becomes the payable's origin document. Settlement must be a NEW
event kind (it moves cash and discharges a memo — like payroll, not like a
second purchase).

**Verdict: D** (policy P1–P3 unresolved; implementation must not proceed).
The extension path itself is **B** — clean, pattern-conformant, no redesign.

---

## 2. Write-offs and forgiveness

### The ten words, separated economically

| Concept | Economic meaning | P&L effect under the declared basis |
|---|---|---|
| Payment | cash settles the claim | revenue recognized |
| Refund | cash returned for settled value | contra-revenue |
| Discount | price reduction **at origin** (billing-time) | lower receivable; none (never revenue) |
| Scholarship | **third party settles** the student's claim | revenue (donor's cash in) + allocation; NOT a discount |
| Write-off / forgiveness / bad debt | the institute **renounces** the claim | **none — the unpaid amount was never revenue** |
| Disputed debt | claim of uncertain collectibility | memo flag only |
| Administrative correction | repair of a recording error | restatement of the erroneous fact |
| Cancellation | service never to be delivered | claim never legitimately existed → correct the obligation |

**The decisive accounting insight (derived, not invented):** because revenue
is recognized only at cash receipt, a student-debt write-off touches **no
revenue and no expense** — it discharges a memo. A "bad-debt expense"
concept belongs to accrual accounting (revenue recognized then uncollected)
and would be *incoherent* here. The correct treatment is forced by the
declared basis:

- **Student-debt write-off** = memo discharge, reason-coded, authorized,
  reversible-as-an-event (a later payment by the student is NEW revenue —
  policy P8 below decides whether it instead reinstates the debt).
- **Staff-advance write-off** = the advance WAS cash out classified as a
  receivable; renouncing it **converts the memo receivable into an expense**
  (staff-benefits/loss class). The deferred cost finally lands. Different
  treatment from student debt, on the same principle — this is where the two
  "write-off" families must NOT share code semantics blindly.
- **Employee deduction** (if ever introduced) reduces future due — it is a
  payroll-composition feature, not a financial event, until cash moves.

### Policy questions

| # | Decision | Why it matters | If undefined |
|---|---|---|---|
| P5 | Who may authorize write-offs (owner only? manager + owner approval? threshold?) | Economic authority vs technical permission | receivable metrics lie forever (current state) |
| P6 | Reason codes / documentation required? | audit defensibility | free-text abuse |
| P7 | Partial write-offs allowed? | real collections often settle for less | receivable residual ambiguity |
| P8 | Payment received after write-off: new revenue or reinstatement? | changes revenue truth and donor optics | two legitimate paths, different economics |
| P9 | Period controls (may a write-off be dated into a closed month?) | no period locks exist today (W7-4) | history rewriting risk |
| P10 | Re-enrollment after write-off: fresh obligation? | obvious yes, but must be explicit | ambiguity |

**Answered by source:** partial — the permission catalog shows the control
vocabulary pattern (`Refund.Approve` exists as an independent approval
permission; expense approval has requester≠approver segregation with an
owner exception). A `WriteOff.Approve`-style permission mirroring
`Refund.Approve` is conformant, but **who holds it is UNKNOWN**.

**Verdict: D** (P5–P10). Semantics fully derived above; ready for
implementation the moment policy lands.

---

## 3. Restricted funds

### What the code already declares

Restrictions are structured at intake (campaign/scholarship/sponsorship
targets), flow through a guarded allocation subledger, and reverse to the
award/campaign — wave 6 verified the subledger is real. What no path
consults: spending authorization. Restricted cash pools with operating cash
in one store.

### The three possible models

1. **Tracking-only** (current): the system KNOWS how much restricted money
   exists and where it committed; it does not prevent ineligible use.
2. **Exposure reporting**: derive restricted-unspent from the subledger and
   publish it beside cash: "of the 118,200 in stores, X is committed to
   donor purposes; unrestricted cash is 118,200−X."
3. **Enforcement / fund accounting**: fund-tagged stores; ineligible
   spending blocked at authorization.

### Policy question

| # | Decision | Why | If undefined |
|---|---|---|---|
| P11 | Has TOEFL House PROMISED donors enforcement (or only intent-to-restrict)? | determines whether model 1 is honest or negligent | silently operating model 1 while donors believe 3 |

**Derivable without policy (important):** through the FUNDING module,
restricted money can only flow to student settlements — ineligible use
*through the module* is already impossible. The fungibility exposure is at
the treasury level: operating spending may consume cash that is economically
the donors'. **Model 2 (exposure reporting) requires no policy decision** —
it is truth made visible from the existing subledger (restricted unspent =
Σ restricted donations − Σ active allocations funded by them − returned),
and it is the honest minimum regardless of P11.

**Verdict:** exposure report **B (authorized now)**; enforcement model **D**
(P11); the existing subledger structure itself **A** — no redesign needed
for either.

---

## 4. Loans and liabilities

### Policy questions

| # | Decision | Why | If undefined |
|---|---|---|---|
| P12 | Does TOEFL House borrow (owner loans, hawala credit, bank facility)? | determines whether the concept exists at all | debt keeps masquerading as equity |
| P13 | If yes: what forms — and is conventional interest excluded (Islamic-finance practice, likely in Kabul but the owner's call, not the auditor's)? | shapes the liability classes and whether an interest concept exists at all | wrong vocabulary built |
| P14 | Who may bind the institute to a liability? | the largest single economic authority in the system | anyone recording a "deposit" |
| P15 | Employee loans (beyond advances against earned pay)? | a different receivable family | conflated with payroll advances |

### Equity-distortion proof (the attack on capital_injection-as-debt)

`capital_injection` increases owner-capital metrics; a loan booked there
**overstates capitalization**; repaying it via `owner_drawing` **overstates
drawings**. No report can reveal the institute is obligated to repay, and
solvency (cash vs obligations) is unrepresentable. With 40 injections in the
drill world this is provable mechanics; in production, **whether any
injection was actually a loan is owner knowledge — flagged as an owner
attestation item, not reconstructible from data** (see §7).

### Semantics if P12 = yes

Liability memo mirroring obligations: loan document (principal, creditor,
terms per P13) → cash-in event classed `loan_proceeds` (non-equity,
non-revenue) → store credit → repayment events (store debit, non-expense
unless a fee is charged → fee = expense class per existing taxonomy) →
discharge. Append-only, reversible-as-event. The architecture takes this as
a clean extension (same pattern family); what it must NOT do is reuse
`capital_injection`.

**Verdict: D** (P12–P15). Architecture path **B**.

---

## 5. Income taxonomy (the policy-independent structural fix)

### The defect, restated

Operating income is defined residually: `type='income' AND category <>
'capital_injection'`. Four economically different inflows collapse into
`other`: true operating misc revenue, bank/finance income (P13 may make
this nonexistent), asset-disposal proceeds, supplier rebates. The expense
side already solved this with an explicit classification taxonomy.

### Proposed taxonomy (semantics; no code)

| Income class | Economic meaning | Recognition | Operating result? | Reversal |
|---|---|---|---|---|
| `tuition / fee / installment` | service revenue (education) | cash receipt | YES | refund (contra) |
| `placement / exam / diploma / card / other-operating` | service revenue (auxiliary) | cash receipt | YES | refund (contra) |
| `book` | product revenue | cash receipt | YES | refund (contra) |
| `donation-unrestricted` | funding income, no donor restriction | cash receipt | YES (funding line, separately displayed) | return |
| `donation-restricted` | funding income with donor commitment | cash receipt | YES (funding line) **and restricted-exposure entry** | return/reallocation via subledger |
| `capital_injection` | owner equity in | cash receipt | NO (equity) | n/a |
| `loan_proceeds` *(P12)* | liability in | cash receipt | NO (liability memo origin) | repayment |
| `contra-refund` | returned revenue | negative | reduces | re-payment |
| **`non_operating_other`** | inflows neither trading nor equity nor liability (disposals, rebates-if-not-contra-expense, misc) | cash receipt | **NO** | negative event |

**The conservative-default principle (replaces the residual):** an
unrecognized income category is rejected at the boundary (like money
asserts), and if a fallback must exist it defaults to
`non_operating_other` — inflows never silently inflate trading results,
exactly as uncategorized expenses never vanish from costs. Both residual
directions are now conservative. Unexpected cash can no longer *become
revenue by accident*.

**Attempted breakings:** (a) same event in two classes — desk misc fee vs
non-operating gift: the boundary is "consideration for the institute's
offerings vs not"; documented per class above; (b) rebate: belongs in
contra-expense when a corresponding expense exists, `non_operating_other`
otherwise — rule stated, not left to the operator; (c) restricted donation
into unrestricted class: intake structure rejects (already enforced);
(d) loan into donation: distinct classes exist, boundary rejects.

**Verdict: authorized for implementation now** (pure semantics; the only
policy-flavored member, interest/finance income, is excluded until P13).
Historical migration: 4 `other` rows today, all genuine operating fees →
classified `other-operating`, correct as-is; `capital_injection` rows keep
their class with the §7 attestation caveat.

---

## 6. Entity separation & the ledger's conceptual role

Audited against overload: `invoice` = billing document ✓; `obligation` =
debt identity ✓ (amount authority = term; settlement = allocation);
`payment` = cash-in document ✓; `financial_transaction` = typed economic
event ✓; `envelope` = spending authorization ✓; `budget category` =
taxonomy node ✓. **Overloaded today:** `income/other` (§5 fixes);
`capital_injection` (§4 fixes). **The ledger's role, resolved explicitly:**
it is an **event journal** (one row = one economic event, classified,
paired atomically with its store mutation and/or memo transition) — not a
double-entry accounting ledger, not a mere cash journal. Balances are
derived views over events (stores + memos). Consequently: new concepts that
need a lifecycle (payables, loans, write-offs) get **memo subledgers +
event kinds**, not new string categories on existing rows — string
categories are reserved for classification, lifecycle belongs to entities.

---

## 7. Historical impact (live world, verified this wave)

| Population | Size | Classification |
|---|---|---|
| `separate` purchase promises | 0 | n/a (forward-looking) |
| donations / restrictions | 0 | n/a |
| capex budget lines | 0 | n/a |
| `income/other` rows | 4 | correct as-is → `other-operating` under §5 |
| capital injections | 40 | drill-world owner deposits, correct here; **production attestation required (loan-vs-equity unknowable from data)** |
| staff advances outstanding | 700 | recoverable in-period; no damage |

No migration rewrites history. The single irreducible uncertainty (were any
production injections loans?) is disclosed, not normalized.

---

## 8. Control model requirements (for the blocked items)

| Concept | Create | Approve | Reverse | View | SoD |
|---|---|---|---|---|---|
| Credit purchase | Expense.Create | P3 | immutable + event reversal | Finance | requester≠approver (pattern exists) |
| Payable settlement | P3 holder | — | immutable + reversal | Finance | — |
| Student write-off | P5 holder | **mandatory independent** (mirror Refund.Approve) | reversal-as-event, P8 | Finance + Audit | yes |
| Advance write-off | P5 holder | mandatory independent | reversal-as-event | Finance + Audit | yes |
| Loan | P14 holder | mandatory | immutable + repayment events | Finance + Audit | yes |
| Restricted spend (if enforced) | existing paths | P11 model | existing | all | — |

Technical permission ≠ economic authority: every row above names the
economic authority question explicitly; none is answered by an endpoint's
permission check alone.

## 9. Reporting consequences (no second truth)

Each new concept reports as a **derived view over its memo + events**, never
a parallel total: payables aging (memo), write-off disclosure line beside
receivables, restricted-unspent beside cash (P11 model 2), loan liability
beside equity, income classes as §5. The reconciliation engine's universe
extends by the same law: memos must reconcile to their events (obligation
pattern already proven both directions).

## 10. Falsification log (attacks on the PROPOSED model)

1. *Credit purchase settled twice* — impossible: settlement is one event
   kind; expense exists only at that event; payable discharge is atomic
   with it.
2. *Write-off then payment* — P8 decision point, both options coherent;
   model forces the choice to be explicit, not accidental.
3. *Write-off advance then recovery* — recovery = negative expense on the
   loss class (contra), never income; flagged as P-policy sub-decision.
4. *Loan booked as donation* — rejected: classes distinct at intake.
5. *Rebate as revenue* — rejected by taxonomy rule (contra-expense when
   expense exists).
6. *Restricted money "laundered" via envelope transfer* — exposure metric
   is store-independent (derived from donation/allocation subledger), so
   internal transfers cannot change it; enforcement (if promised) needs P11.
7. *Bonus via temporary base-salary raise* — competing-path defect
   acknowledged (contract history falsified); fix authorized under §5-adjacent
   payroll due-composition (teachers already compute bonuses into dues;
   employees symmetrically should) — no new concept needed.
8. *Concurrent write-off + payment* — discharge guarded like voids
   (status-checked inside the transaction).
9. *Backdated write-off into a closed month* — W7-4 applies; period locks
   are a separate policy (P9) noted, not smuggled in.
10. *Two paths, same event, different economics* — the remaining instance
    is #7; every other duplicate-path found in waves 5–8 was eliminated.

## 11. Implementation gate — what is authorized

| Work item | Status |
|---|---|
| Income taxonomy redesign (§5) + conservative default | **AUTHORIZED** — no policy dependency |
| Restricted-fund exposure reporting (§3 model 2) | **AUTHORIZED** — derived truth, no new policy |
| Employee bonus via payroll due-composition (§10.7) | **AUTHORIZED** — completes existing declared design symmetrically |
| Supplier payables | **BLOCKED — P1–P3** |
| Write-offs (student + staff) | **BLOCKED — P5–P10** |
| Loans / liabilities | **BLOCKED — P12–P15** |
| Enforcement-grade fund accounting | **BLOCKED — P11** |

## 12. Architecture Adequacy Verdict (final)

| Concept | Verdict |
|---|---|
| Cash spine (income/expense/envelope/treasury/payroll/refund/inventory events) | **A** |
| Income classification | **C → redesign authorized** (§5; conservative default kills the residual) |
| Restricted-fund tracking subledger | **A**; exposure view **B (authorized)**; enforcement **D (P11)** |
| Supplier payables | **D (P1–P3)**; architecture path B |
| Student-debt write-off | **D (P5–P10)**; semantics derived, basis-consistent (memo discharge, no P&L) |
| Staff-advance write-off | **D (same policy family)**; semantics derived (expense recognition at renunciation) |
| Loans | **D (P12–P15)**; equity-distortion proven; path B |
| Employee bonus / deduction | bonus **B (authorized fix)**; deduction **F** (no surface; needs P5-family policy) |
| Asset register / disposal proceeds class | register **B/E**; disposal class included in §5 (authorized) |
| Organizational contracts (one payer, many seats) | **F** — needs product policy beyond finance |

**The model is capable of representing the institution without semantic
shortcuts** once the five authorized items land and the five policy blocks
resolve — nothing in the architecture requires redesign beyond the income
taxonomy; everything else extends a proven pattern family (memo + events +
guarded discharge + reversal-as-event). Implementation may proceed ONLY in
the order: authorized items first, policy items after their decisions.
