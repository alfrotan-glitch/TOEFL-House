# WP-07 · WP07-F17 — CHECKPOINT (§65)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §65 CHECKPOINT · §103 EVIDENCE · §106 SCOPE · LAW 1 · LAW 4
**Date:** 2026-08-21
**Baseline:** `bb41398` (release gate 22 passed · 0 failed · 0 skipped; server suite 2708 passed · 160 known WP-04 skips)
**Owner decision being executed:** D-118 — *"An invoice declares its purpose, and a tuition invoice must identify its specific tuition obligation/semester."*
**Checkpoint outcome:** **CLEARED FOR THREE WRITERS · ONE DEPENDENCY RE-SCOPED (WP07-F18, owner question raised).**

---

## 1. The defect, proven before repair (§103)

Executed: `npx vitest run src/tests/work-packages/wp07/invoice-purpose-authority.test.ts`
against `bb41398` source. Real output:

```
 ❯ invoice-purpose-authority.test.ts (11 tests | 9 failed)
   × a books invoice, paid in full, leaves tuition untouched
     AssertionError: expected 7000 to be 10000
   × a tuition invoice, paid in full, settles the term it names
     AssertionError: expected +0 to be 10000
   × a term paid through its invoice cannot be collected a second time at the desk
     AssertionError: expected 201 to be 400
```

**FACT.** `POST /api/invoices/:id/pay` writes `category = 'fee'` for every
invoice and never writes `semester` (`invoices.routes.ts`,
`stmtInsertPayment`). One hard-coded literal produces two opposite money
errors:

| Direction | Evidence |
|---|---|
| Money credited where nothing was owed | A 3,000 AFN *Textbooks and stationery* invoice reduced a 10,000 AFN tuition debt to **7,000**. The institute forgets 3,000 AFN of tuition receivable. |
| Money not credited where it was owed | A 10,000 AFN **tuition** invoice, paid in full, left the term settled at **0**, so the payment desk answered `201` to a further collection against a term already paid. |

Both flow from the same root: the invoice never says what it bills, so the
payment cannot say what it settles.

---

## 2. Invoice writers inventoried (FACT — `grep -rn "INSERT INTO invoices" server/src`)

| # | Writer | Lines | Purpose derivable from evidence? |
|---|---|---|---|
| 1 | `routes/invoices.routes.ts` (manual, multi-item) | operator-entered | **No** — the operator must declare it. In scope. |
| 2 | `routes/visitors.routes.ts` (conversion) | one line, `Tuition fee — <class>`, against a `student_semesters` row that carries the real fee | **Yes — tuition.** In scope. |
| 3 | `routes/students.routes.ts` (extra class) | **zero line items**, no `student_semesters` row exists | **Yes — not tuition.** No obligation exists to name, so D-118 forbids `tuition`. In scope. |
| 4 | `core/academic/enrollment-service.ts` (auto-invoice) | `snapshot.fees` = `registration` + `semester` (+ `retake`) | **No — see §3.** Re-scoped. |

---

## 3. Dependency discovered — WP07-F18 (re-scoped, owner question raised)

**FACT.** The enrolment auto-invoice bills a *mixture* — `buildFeeSnapshot`
adds a `registration` fee and a `semester` fee to one document
(`catalog-service.ts:381-386`).

**FACT.** The `student_semesters` row that same enrolment creates is inserted
with `fee_amount = 0` (`enrollment-service.ts:162`).

**INFERENCE (LAW 1).** Tuition receivable therefore has **two different
representations depending on which door the student came through**:

* visitor conversion / manual registration → the money is on `student_semesters`, and `studentBalance` sees it;
* enrolment service → the money is on the **invoice**, and `student_semesters` bills **0**, so `studentBalance` sees no tuition at all.

**Consequence for D-118.** A mixed invoice cannot "identify its specific
tuition obligation", because no single obligation covers its amount. By the
owner's own rule it therefore cannot be a `tuition` invoice as it stands.
Making it one would be worse than the defect: it would credit tuition against a
term that bills 0 and hand the student a phantom credit balance.

**Scope decision (§106).** Repairing this properly means either splitting the
enrolment invoice per purpose, or making the enrolment write the tuition figure
onto the semester row it creates. Both change WP-05-certified writers and the
meaning of `student_semesters.fee_amount`. That is **not** the approved F-17
slice, and it is not a decision the agent may take.

**Interim applied in this slice, and why it loses nothing:** the enrolment
auto-invoice declares `purpose = 'other'`.

* It is *forced*, not chosen: the column is `NOT NULL`, and D-118 forbids `tuition` for a document that names no obligation.
* It is *strictly better than today*: with `category = 'fee'` a payment on this invoice reduced **other semesters'** tuition debt — the F-17 leak. With `other` it reduces none.
* It *forfeits no legitimate settlement*: the term this path creates bills 0, so there was never any tuition of its own for it to settle.
* It is *reversible*: when the owner answers WP07-F18 the classification moves with it.

This is recorded as **ASSUMPTION A-18** and raised to the owner as an explicit
question rather than absorbed silently.

---

## 4. Model chosen, and the alternative rejected

**Invoice-level purpose and invoice-level obligation** — `invoices.purpose`
(`tuition|books|exam|other`) plus `invoices.obligation_id`, with a table CHECK
making the obligation mandatory for `tuition` and forbidden for every other
purpose.

*Rejected: a per-line `obligation_id`.* If two lines of one invoice could name
two different obligations, a partial payment would have to be **split** between
them — and no rule for that split exists in the repository. Inventing one
(pro-rata? line order?) is exactly the business policy §61 forbids. One invoice
→ one obligation keeps the owner's rule executable with nothing invented, and
`purpose` on the invoice makes the document homogeneous by construction rather
than by convention.

---

## 5. What this slice does not touch

* `E1b` — cash payments are still attributed by `payments.semester` and read through `getSemesterTuitionSettled`. This slice writes the *existing* settlement authority (D-116) rather than opening a second one; the migration of all cash onto `obligation_allocations` is the approved step 4 and is done once, for every writer, not half here.
* `student_semesters.fee_amount = 0` in the enrolment path (WP07-F18, above).
* Cross-package duplicate schema authority from C-18 (WP-05/08/10).
