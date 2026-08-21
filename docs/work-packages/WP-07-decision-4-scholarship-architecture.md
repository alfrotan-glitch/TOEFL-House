# WP-07 · Decision 4 — Scholarship funding architecture

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §61 DISCOVER · §62 MODEL · §63 CHALLENGE · §64 DECIDE · §105 STOP
**Date:** 2026-08-21
**Baseline:** `6452441` (WP-07 slices A–D pushed; release gate 22/22)
**Lifecycle state:** CHALLENGE → DECIDE. **READ-ONLY.** No source, schema, test or registry changed.

**Scope.** Only the financial architecture of
`Scholarship Award/Pledge → Funding Recognition → Obligation Allocation`.
The six-question memo is not repeated.

**Labels.** **FACT** = verified in the repository at this baseline · **BEST
PRACTICE** = established accounting/ERP practice, cited as such and never
treated as this project's policy · **OWNER POLICY** = a business choice the
repository does not determine.

---

## 1. What the funding subsystem actually does today (FACT)

| # | Fact | Evidence |
|---|---|---|
| F1 | A donation is recognised as **operating income at the moment of receipt** — it credits branch cash and triggers the automatic savings sweep | `funding.routes.ts` calls `recordIncome({ category: 'donation' … })` |
| F2 | `donations.restricted` and `restriction_note` are stored but consumed by **no financial rule** — they reach only the description text and an event payload | schema + `funding.routes.ts` |
| F3 | A scholarship's `total_budget` is validated as money but is **not backed by anything**: no link to received donations, no check against `funding_campaigns.raised_amount` | scholarship-create handler |
| F4 | An **award moves no money**: it writes `scholarship_awards`, increments `scholarships.allocated_amount`, emits an event. No payment, no ledger row, no change to any student balance | award handler |
| F5 | `scholarship_awards.semester` is free text, displayed only; there is no link to a tuition obligation | schema; `FundingView.tsx` |
| F6 | Impact reporting already counts recipients and **sums award amounts** as delivered social impact, although the awards settle nothing | `impact.routes.ts` (`stmtCountScholarshipRecipients`, `stmtSumScholarshipAmount`) |
| F7 | `sponsorship_agreements` record a `monthly_amount` commitment with **no financial effect whatsoever** — no payment, no obligation, no schedule | `funding.routes.ts` |
| F8 | A **second, unconnected mechanism** for third-party support exists: the discount authority's `SPONSORSHIP` category, ceiling **100%**, owner-approved | `core/configuration/discount-authority.ts` |
| F9 | Every `payments` row is a **cash-equivalent instrument**: `payment_method` is CHECKed to `cash|card|bank_transfer`, and every payment writer calls `recordIncome`, which moves branch cash | schema + all five payment writers |
| F10 | Reconciliation treats a completed payment without a backing ledger row as a **defect** (`unmatchedPayments`), and derives branch cash as `operating income − savings − owner drawings` | `utils/reconciliation.ts` |

### The consequence that decides the architecture

**F1 + F9 together create a double-recognition trap.** Donor cash is recognised
as income when the donation arrives. If applying a scholarship later creates a
`payments` row — and in this codebase a payment *is* a cash movement — the same
donor afghani is recognised as income twice: once as `donation`, once as `fee`.
That is phantom money (LAW 4), and it would also break `cashVariance`, because
the second recognition has no cash behind it (F10).

---

## 2. The three candidate models, evaluated

### Option 1 — Scholarship as a payment source inside `Payment → Obligation Allocation`

A `payments` row with `payment_method = 'scholarship'`, allocated like any other.

| Criterion | Assessment |
|---|---|
| Accounting integrity | **Fails.** Either it calls `recordIncome` (double recognition, F1) or it does not (an unmatched payment, F10). Both break an existing invariant |
| Donor traceability | Weak: the donor link would have to be squeezed into a payment row that has no fund concept |
| Reversals | Confused: a "payment" refund path exists (D-113) and would offer to hand donor money to the student |
| Extensibility | Every future non-cash settlement (write-off, transfer, credit note) repeats the same exception |
| Protocol | LAW 6 (silent exception to "a payment moves cash"), LAW 7 (a payment method that is not a method of payment), §78 |

**Rejected on evidence, not preference.** Note that Option 1 *is* common in
commercial ERPs — but those systems separate the AR subledger from cash by
design. This one does not: here, payment ≡ cash (F9).

### Option 2 — A distinct funding instrument settling through the **same** allocation authority

Scholarship application is its own instrument. It settles obligations through one
allocation table and writes **nothing** to the cash ledger.

| Criterion | Assessment |
|---|---|
| Accounting integrity | **Correct.** Donor money is recognised exactly once, when received; the allocation is an accounts-receivable settlement with no cash effect |
| Donor traceability | **Strong.** allocation → award → scholarship → donor/campaign is an unbroken chain of foreign keys |
| Partial funding | Native: allocations carry an amount; an obligation may be settled by any mix of cash and scholarship up to its net amount |
| Multiple obligations | Native: one award may allocate to several obligations; one obligation may draw on several awards |
| Reversals/refunds | Clean and *asymmetric by design*: reversing a scholarship allocation returns money to the fund, never to the student — which is the correct answer, and is impossible to express in Option 1 |
| Auditability | Every settlement names its instrument; `SUM(allocations) ≤ obligation.net_amount` is a checkable invariant (§78) |
| Reporting | Tuition can finally be split into **billed / settled by cash / settled by scholarship** — strictly more information than today, with no ledger reclassification |
| Extensibility | A new instrument (write-off, transfer, credit note) is a new `source_kind`, not a new exception |
| Protocol | LAW 1 (one allocation authority), LAW 3 (FK + CHECK enforcement), LAW 4, §21, §23, §78 |

### Option 3 — Alternatives considered and why they lose

**3a — Scholarship as a discount on the obligation** (reduce `net_amount`).
Destroys the fact that a third party paid: the student's obligation simply
shrinks, the donor disappears from the student's record, and impact reporting
(F6) has nothing to reconcile against. It also collides with the discount
authority, which is a *policy ceiling* mechanism (F8), not a funding mechanism.
A discount is decided **before** the charge; a scholarship can arrive after.
**Rejected** (LAW 4, §23, LAW 1).

**3b — Restricted-fund (deferred revenue) accounting.** **BEST PRACTICE** for
donor-restricted funds: recognise a restricted contribution as a fund liability
on receipt, then *release from restriction* to income when the purpose is met —
here, when the award is applied. This is genuinely more correct in accrual terms
than F1, and `donations.restricted` (F2) suggests someone intended it.

It is **not an alternative to Option 2 — it is orthogonal to it.** Option 2
governs *settlement* (which obligation this money discharges); 3b governs
*recognition* (when donor money becomes income). Option 2 is unchanged under
either recognition model: only the donation writer and the P&L differ. That
independence is the strongest argument for Option 2 — it does not force the
recognition decision now, and does not have to be rebuilt if the owner adopts
restricted-fund accounting later.

---

## 3. Recommended model (one)

**Option 2 — scholarship funding is a non-cash settlement instrument that shares
the canonical obligation-allocation authority and writes nothing to the cash
ledger.**

Shape (PROPOSAL, not built):

```
student_obligations(id, student_id, branch_id, kind, …, net_amount, status)     -- Decision A

scholarship_awards(id, scholarship_id, student_id, amount, …)                   -- exists; gains
                                                                                --   status + reversal fields
obligation_allocations(
  id,
  obligation_id         NOT NULL REFERENCES student_obligations(id) ON DELETE RESTRICT,
  amount                INTEGER NOT NULL CHECK (amount > 0),
  source_kind           TEXT    NOT NULL CHECK (source_kind IN ('payment','scholarship')),
  payment_id            REFERENCES payments(id)            ON DELETE RESTRICT,
  scholarship_award_id  REFERENCES scholarship_awards(id)  ON DELETE RESTRICT,
  CHECK ( (source_kind='payment'     AND payment_id IS NOT NULL AND scholarship_award_id IS NULL)
       OR (source_kind='scholarship' AND scholarship_award_id IS NOT NULL AND payment_id IS NULL) ),
  created_at)
```

Properties this buys, each tied to a protocol rule:

- **One settlement authority** for cash and non-cash alike — LAW 1.
- **Cash stays exactly where it is.** No new `financial_transactions` rows, so
  `computeReconciliation` and the cash formula are untouched — §78.
- **Exactly-one-of** is a database CHECK, not a convention — LAW 3.
- **`ON DELETE RESTRICT` everywhere**: a settled obligation, a spent award and a
  used payment cannot be deleted out from under the trail — §23, §50.
- **`scholarships.allocated_amount` becomes derived** from awards rather than a
  maintained mirror — §13 (do not store derived values where derivation is safe).
- Reporting reads `billed / cash-settled / scholarship-settled` straight from the
  allocation table; the impact figures in F6 finally reconcile to real settlements.

---

## 4. The exact business rule this model requires (PROPOSAL — owner must approve)

> **Scholarship funding rule.**
> A scholarship fund holds money the institute has **already received** from an
> identified donor or campaign. An **award** commits a stated amount of one fund
> to one named student. An award is **applied** by allocating it to specific
> tuition obligations of that student: an allocation may be partial, several
> allocations may draw on one award, and one obligation may be settled by any mix
> of scholarship allocations and cash payments — never exceeding that
> obligation's net amount. A scholarship allocation **settles the obligation but
> creates no cash and no income**: the donor's money was recognised when the
> donation was received, and recognising it again as tuition would count one
> afghani twice. An allocation may be **reversed** while the obligation it
> settled has not been refunded in cash; reversal returns the amount to the fund
> and re-opens exactly that obligation. Scholarship money is **never** paid to a
> student and never becomes a student credit. Tuition settled by scholarship is
> reported separately from tuition settled by cash and is never reported as
> tuition income.

### Sub-rules the owner must confirm (each shows my recommendation)

| # | Question | Recommendation | Why |
|---|---|---|---|
| S1 | May a fund award more than the donations actually received for it? (today: unchecked — F3) | **No.** Block an award that would exceed the fund's received backing | LAW 4: an award against money that does not exist promises what the institute cannot deliver |
| S2 | Is an award made **per student** and then allocated, or directly to one obligation? | **Per student, then allocated** | Matches how aid is granted, and supports partial and multi-term use |
| S3 | A scholarship-funded student withdraws and their tuition is cancelled — where does the money go? | **Back to the fund.** Never to the student, never to branch cash | The money was the donor's, given for tuition |
| S4 | Recognition model: keep donations as immediate income (F1), or adopt restricted-fund liability + release (3b)? | **Decide separately.** Option 2 works under either; adopt 3b only if donors are genuinely owed an accounting of restricted funds | Orthogonal (see 3b); avoids coupling two decisions |
| S5 | Is the 100% `SPONSORSHIP` **discount** category (F8) the same business concept as scholarships/sponsorship agreements? | If yes, **one must be retired** | LAW 1: two mechanisms for one concept, with opposite accounting effects |
| S6 | Do `sponsorship_agreements` (F7) generate scheduled awards/allocations, or are they narrative records? | State which. If financial, they become a schedule that produces awards | LAW 6: a commitment that silently does nothing is worse than no record |

---

## 5. What I am explicitly **not** deciding

- Whether an award is a **pledge** (promise of future money) or a **grant of
  received money**. The recommended rule assumes received money (S1); a pledge
  model needs its own liability treatment and is OWNER POLICY.
- Whether the current no-effect award (F4) is a **defect** or intended. It is
  recorded as evidence, not classified.
- The recognition model (S4).

## 6. Status

Read-only analysis. No source file, schema object, test or registry was changed.
E1–E4 are not started. **Awaiting owner approval of the recommended model and the
business rule in §4 before any implementation.**
