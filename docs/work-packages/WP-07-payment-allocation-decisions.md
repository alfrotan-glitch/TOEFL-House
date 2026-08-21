# WP-07 — Payment allocation: decision memo

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §61 DISCOVER · §62 MODEL · §63 CHALLENGE · §64 DECIDE · §90 assumption register · §105 STOP
**Date:** 2026-08-21
**Baseline:** `2fd3d99` (WP-07 slices A–D pushed; full release gate 22/22)
**Lifecycle state:** CHALLENGE → DECIDE. **READ-ONLY. Nothing in this memo is implemented.**

> Companion to `docs/work-packages/WP-07-payment-allocation-analysis.md`, which
> established the current model and its eight gaps. This memo takes the six
> questions that analysis left open, adds the evidence needed to answer each,
> and recommends one option per decision against the Master Protocol's own
> rules. It invents no business policy: where a decision is a business choice,
> it is labelled **OWNER POLICY** and left to the owner.

## 0. How to read the labels (§90)

| Label | Meaning |
|---|---|
| **FACT** | Established by inspecting the repository at `2fd3d99`. Cited. |
| **INFERENCE** | Follows from facts by reasoning, and is marked as such. |
| **OWNER POLICY** | A business choice the repository does not determine. Not decided here. |
| **RECOMMENDATION** | My engineering position, justified by named protocol rules. Still requires owner approval. |

Already settled and not reopened: **D-113** (a refund reverses one named
payment), **D-114** (a tuition refund re-opens only its own semester),
**D-117**/**D-118** (the owner's allocation direction).

---

## Decision A — The model shape

**Question.** Does WP-07 adopt a full obligation + allocation ledger (Option A),
typed obligation links without an allocation table (Option B), or the minimal
symptom fix (Option C)?

**FACT.** The obligation concept already exists **implicitly in four different
shapes**: `student_semesters` (tuition, with amounts), `students.installment_plan`
(JSON array, no amounts owed elsewhere), `invoices` + `invoice_items` (free
text), and "has this student ever paid X?" queries for fixed fees
(`stmtHasPaidFixedFee` in `students.routes.ts`).

**FACT.** Four independent rules already read that data, one of which — BOS
`stmtRevenueByClass` — **guesses**: *"matched by name when the payment records
one, else the student's most recent active one"*.

**FACT.** Attribution-by-foreign-key is already proven in this schema:
`payments.refunds_payment_id` (D-113) with `ON DELETE RESTRICT` and two
enforcing triggers.

**FACT.** `uq_student_semester_active` is `UNIQUE(student_id, semester_name)
WHERE status = 'active'`, so the term *name* is not unique over a student's
history; name-based attribution is ambiguous by construction.

**RECOMMENDATION — Option A.** Justification by rule:

| Rule | Why A |
|---|---|
| LAW 1 (one authority per concept) | Replaces four implicit obligation shapes and four allocation rules with one entity and one settlement rule |
| LAW 3 (integrity is database integrity) | Allocation becomes an FK-constrained row, not a string comparison |
| LAW 4 (money must be explainable) | Every afghani points at the obligation it settled; the BOS guess disappears |
| LAW 7 (no magic) | Removes "most recent active semester" as an invented rule |
| §13 (every table reflects a real rule) | An obligation is a real business fact, currently spread across four representations |
| §21 (explicit financial architecture) | Fees · invoices · payments · allocation is exactly the model §21 asks for |
| §78 (financial reconciliation) | `SUM(allocations) ≤ obligation.net_amount` becomes a checkable invariant per obligation |

**§87 (no premature complexity) — the counter-argument, addressed.** Two new
tables are justified only because the concept is already present four times and
provably ambiguous; this consolidates rather than adds. Option A introduces no
event bus, no CQRS and no service layer beyond one obligation authority module.

**Migration cost is at its minimum today** (A-1: no production data). It rises
permanently once the institute is live.

**If the owner prefers to stage it:** Option B is a strict subset of A —
`student_installments`, `invoices.purpose` and the typed FKs survive unchanged
into A. B is a safe first slice, not throwaway work. **Option C is not
recommended**: it fixes the two symptoms in the shape D-117 explicitly rejects.

---

## Decision 1 — May one payment settle several obligations?

**FACT.** Today one `payments` row carries at most one implicit obligation, and
every writer collects for exactly one thing. Visitor conversion writes a single
payment described as *"Registration payment for {class}"* against an invoice —
one collected sum, one row.

**FACT.** Receipts are one-per-payment (`uq_payments_receipt_number`, D-110), so
"one payment = one receipt" is already the operator-visible unit.

**OWNER POLICY.** Whether reception may take one sum of cash for a term *and* a
book and issue **one** receipt is a counter-workflow question the repository
does not answer.

**RECOMMENDATION — model many-to-many, keep the API one-obligation-per-request
until the owner asks otherwise.** `payment_allocations(payment_id,
obligation_id, amount)` costs nothing extra to create now and cannot be
retrofitted cheaply later; meanwhile the write API stays exactly as simple as it
is today. This satisfies LAW 6 (a payment is never silently split across
obligations) while leaving the capability available when the owner wants it.

*Consequence of the alternative* (`payments.obligation_id` single column): a
future "one receipt, two obligations" requirement forces a schema change and a
rewrite of every reader.

---

## Decision 2 — May one invoice bill several obligations?

**FACT.** `invoice_items` is a real table and the API accepts an array, but the
UI (`InvoicesPanel.tsx`) sends exactly **one** item per invoice.

**FACT.** Four writers create invoices: the manual route (multi-item capable),
`enrollment-service` (one item), visitor conversion (one item), and the
extra-class path in `students.routes.ts` — which creates an invoice **with no
line items at all**, so its `total_amount` is explained by nothing (LAW 4 /
§21 concern in its own right).

**RECOMMENDATION — one invoice line bills exactly one obligation; an invoice
carries one purpose (homogeneous).** So "3 textbooks" is one invoice with three
lines against three book obligations, while "tuition + textbooks" is two
invoices. Justification: D-118 says the invoice *declares its purpose* — a
mixed-purpose invoice has none; and a homogeneous invoice keeps
`invoice → obligation → allocation` a single unambiguous chain. An invoice must
have at least one line (closes the zero-item invoice).

**OWNER POLICY.** If reception must be able to bill tuition and books on one
printed document, say so and I will model purpose per line instead of per
invoice. I do not recommend it: it makes "what is this invoice for?" unanswerable
on the document itself.

---

## Decision 3 — Over-payment: refused, or held as a credit?

**FACT.** Every writer refuses over-payment today: the invoice payment path
(`Amount exceeds remaining balance`, `Invoice is already fully paid`), the
tuition path (`Payment exceeds the remaining balance…`, `This semester is
already fully paid`), and installments (must equal the installment amount).

**FACT.** No writer ever changes `student_semesters.fee_amount` or
`net_fee_amount` after creation — only `status`, `class_id` and grade columns
are updated.

**INFERENCE.** `studentBalance.creditBalance` is therefore **structurally
unreachable through the API**: it is a defensive floor in the read model, not a
capability the product offers.

**RECOMMENDATION — keep refusal.** Allowing a credit balance is *new business
capability*, not a repair: it creates a liability (money held that is owed back
or forward), which needs its own ledger treatment, its own report line, its own
refund rule and its own reconciliation dimension. Under §87 and LAW 6 the
correct move is to refuse the over-allocation with a precise error, exactly as
today. `creditBalance` stays as a defensive read and is documented as such.

**OWNER POLICY.** If students genuinely pay a lump sum in advance of enrolment,
say so — that is a real requirement, and it changes the model (a deposit
liability, not an obligation).

---

## Decision 4 — Does a scholarship award settle a tuition obligation?

**FACT.** `POST /funding/scholarships/award` writes a `scholarship_awards` row
and increments `scholarships.allocated_amount`. It creates **no payment**, emits
**no ledger entry**, and changes **no student balance**. A student awarded
10,000 AFN still owes 10,000 AFN on every surface.

**FACT.** `scholarship_awards.semester` is free text, displayed only.

**INFERENCE.** Today an award is a funding-side pledge with no financial effect.
Either that is intended (the donor money is separate and the student still pays),
or the award is meant to settle tuition and currently does not — which would be
a further money-truth defect.

**RECOMMENDATION — award = an allocation of donor money to a named tuition
obligation, not a discount.** Justification: the donor's money is real income
already in the ledger; recording the award as a *discount* on the obligation
would erase the fact that a third party paid (LAW 4: every number explainable;
§23: auditability). As an allocation it is visible on both sides — the student's
obligation is settled, and the scholarship's budget is consumed.

**OWNER POLICY — required before anything is built here.** Does a scholarship
award actually pay the student's tuition, or is it a pledge that only becomes
money when the donor's funds are applied? Until answered, scholarships stay
untouched. **I am flagging that the current behaviour may itself be a defect; I
have not classified it as one, because I cannot know the intent.**

---

## Decision 5 — Do fixed fees (ID card, diploma, placement) become obligations?

**FACT.** No receivable exists for them. They are recognised at the moment of
payment/issuance, and duplication is prevented by a query over `payments` UNION
`financial_transactions` (`stmtHasPaidFixedFee`), plus the placement booking
guard.

**RECOMMENDATION — yes, but created and settled in the same transaction.** The
allocation engine then has exactly one shape for every kind of money (LAW 1,
§21), and the once-per-student rule becomes a database uniqueness constraint on
the obligation instead of a "have we ever seen a payment like this?" query —
which is enforcement by search (LAW 3 says integrity belongs in constraints).

*Consequence of the alternative* (leave them outside the model): the allocation
engine needs a permanent special case, and the once-per-student rule stays a
read-then-write check that concurrency can defeat.

---

## Decision 6 — Convert the free-text semesters elsewhere?

**FACT.** `registrations.semester` is **written and never read** — the only
consumers of `registrations` are a count metric and a `SUM(discount_applied)`.
It is dead data (§44).

**FACT.** `scholarship_awards.semester` is free text used for display only.

**FACT.** `enrollments.semester_name` is the academic (WP-05) vocabulary, not a
finance attribution.

**RECOMMENDATION — remove `registrations.semester` under §43/§44 (dead column,
provable), and convert `scholarship_awards.semester` to an obligation reference
**only if** Decision 4 makes awards allocate; otherwise leave it as the display
note it already is. Do not touch `enrollments.semester_name`: it belongs to
WP-05 and is not an allocation.

---

## Summary of recommendations

| # | Decision | Recommendation | Primary rules |
|---|---|---|---|
| A | Model shape | **Option A** — obligations + allocations (B acceptable as a strict-subset first slice) | LAW 1, LAW 3, LAW 4, §13, §21, §78 |
| 1 | Payment ↔ several obligations | Model N:M; keep API one-per-request until asked | LAW 6, §87 |
| 2 | Invoice ↔ several obligations | One line = one obligation; invoice is homogeneous; ≥1 line required | D-118, LAW 4 |
| 3 | Over-payment | Keep refusing; no credit balance | LAW 6, §87 |
| 4 | Scholarship award | Allocation of donor money, not a discount — **owner must confirm the intent first** | LAW 4, §23, §105 |
| 5 | Fixed fees | Obligations created and settled atomically | LAW 1, LAW 3, §21 |
| 6 | Free-text semesters | Drop the dead `registrations.semester`; convert `scholarship_awards.semester` only if 4 says allocate | §43, §44 |

---

## Proposed sequencing, if approved (each slice runs the full lifecycle)

| Slice | Content | Gate |
|---|---|---|
| **E1** | `student_obligations` + `payment_allocations` + the obligation authority module; tuition obligations created with the enrolment; the tuition payment path allocates | full lifecycle + release gate |
| **E2** | `invoices.purpose`, invoice lines bill obligations, invoice payment allocates (closes **WP07-F17**) | full lifecycle + release gate |
| **E3** | `student_installments` normalized as children of the tuition obligation; installment payment allocates with no operator choice (closes **WP07-F16**, satisfies D-117) | full lifecycle + release gate |
| **E4** | Consumers: balance authority, BOS heuristic removal, reports, UI; then the WP-07 C-2 legacy-test disposition | full lifecycle + release gate |

Each slice keeps the release gate green; none is merged half-finished. Decision
4 (scholarships) and Decision 5 (fixed fees) attach to E4 or later, and only if
the owner approves them.

## Risks to state plainly

1. **Blast radius.** E1–E4 touch every money writer, the balance authority, BOS
   reporting and a large share of the WP-03/WP-07 suites. That work is
   mechanical but not small.
2. **Test re-expression.** As in D-112 and D-115, fixtures that write payments
   will need to state their obligation. Behaviour under test does not change;
   the expression does. Every such change will be recorded, never silent.
3. **Interim state.** Between E1 and E3, tuition allocation is authoritative
   while installments are not yet migrated. WP07-F16 therefore stays open until
   E3 lands, and the record will say so.
4. **Same-agent review.** TR-4 still applies: the independent review is
   performed by the same agent that wrote the change.

## Status

Nothing in this memo is implemented. No source file, schema object or test has
been changed. Awaiting the owner's decisions on A and 1–6.
