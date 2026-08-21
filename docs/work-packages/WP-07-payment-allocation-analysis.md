# WP-07 — Payment allocation and tuition obligations: read-only analysis

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§6–7 (freeze / forensic audit), §61 DISCOVER, §62 MODEL, §63 CHALLENGE, §105 STOP
**Date:** 2026-08-21
**Baseline:** `a17fcbd` (WP-07 slices A–D pushed; full release gate 22/22 green)
**Lifecycle state:** DISCOVER + MODEL. **No implementation. No schema change.**

> The owner recorded a business direction on 2026-08-21 (D-117, D-118) and
> instructed: *"do NOT implement anything… verify the existing model can support
> it before proposing schema changes"* and *"continue the READ-ONLY analysis"*.
> This document is that verification. Every statement below is either a FACT
> established by inspecting the repository at `a17fcbd`, or a clearly labelled
> PROPOSAL awaiting owner approval. Nothing here has been built.

---

## 1. The owner's rules (recorded verbatim in intent, D-117 / D-118)

**D-117 — Explicit payment allocation → tuition obligation.**
Every tuition payment — direct, invoice, or installment — must be explicitly
allocated to the specific tuition obligation it settles. The installment plan is
tied to its enrolment/semester obligation, so the operator does **not** manually
select the semester when paying an installment. "Oldest unpaid semester" is
**not** an acceptable automatic rule.

**D-118 — Invoice → Obligation → Payment allocation.**
An invoice declares its purpose, and a tuition invoice identifies the specific
tuition obligation it bills. A books/exam/other invoice never reduces tuition. An
invoice payment must never be classified as tuition merely because it came
through the invoice system. Preferred shape is `Invoice → Obligation → Payment
allocation`, not a generic `payment.category = 'fee'`.

---

## 2. What the system has today (FACT)

### 2.1 The obligations that exist — implicitly

| Obligation in the business | How it exists today | Identity |
|---|---|---|
| Tuition for one enrolment/term | `student_semesters` row (`fee_amount`, `net_fee_amount`, `status`) | `student_semesters.id` — **never referenced by a payment** |
| An installment of a tuition plan | an element of the `students.installment_plan` **JSON array** (`{id, amount, status, dueDate}`) | a client-supplied string id, unique only within the array |
| An invoice | `invoices` + `invoice_items` (free-text `description`) | `invoices.id` |
| ID card / diploma / placement fee | no row until paid; a once-per-student guard queries `payments` | none |
| A book purchase | `books` + `book_sales`, or a `payments` row carrying `book_id` | `books.id` |
| Exam sitting | `exams.fee`; collected as an ad-hoc `exam` payment | none |
| Ad-hoc charge (`chapter`, `exam`, `other`) | documented in `students.routes.ts` as *deliberately* unbacked | none |

**There is no obligation entity.** Tuition is the only obligation with a stored
amount, and it is a *class enrolment record* that happens to carry two money
columns.

### 2.2 How a payment says what it settles

`payments` carries four attribution columns:

| Column | Meaning | Set by |
|---|---|---|
| `semester` | the **name** of a term, as free text | only the `fee` branch of the payment desk |
| `invoice_id` | the invoice paid | `invoices.routes.ts`, `visitors.routes.ts` |
| `book_id` | the book bought | the payment desk's `book` branch |
| `refunds_payment_id` | the payment reversed (D-113, implemented in slice D) | the refund writer |

### 2.3 Five payment writers, three attribution behaviours

| Writer | Category | Names a term? |
|---|---|---|
| `students.routes.ts` payment desk — `fee` | `fee` | **yes**, by name |
| `students.routes.ts` payment desk — `installment` | `installment` | **no** (`semester` stays NULL) — **WP07-F16** |
| `students.routes.ts` payment desk — `book`/`card`/`diploma`/`placement`/ad-hoc | as chosen | no (correct: not tuition) |
| `students.routes.ts` registration/extra-class writers | `fee` | no |
| `invoices.routes.ts` `POST /:id/pay` | hard-coded `'fee'` | **no** — **WP07-F17** |
| `visitors.routes.ts` conversion | hard-coded `'fee'` | no, and it creates a term literally named `'Current Semester'` |
| `core/placement/store.ts` | `placement` | no (correct) |

### 2.4 Four independent allocation rules read that data

1. `utils/studentBalance.ts` — `TUITION_PAYMENT_SQL`: tuition charges plus
   refunds that reverse one. **Not** semester-filtered.
2. `utils/studentBalance.ts` — `getSemesterTuitionPaid` (D-116): semester-filtered.
3. the payment desk's own settlement check — now consumes (2).
4. `bos.routes.ts` — `stmtRevenueByClass` / `stmtRevenueByTimeSlot` invent a
   heuristic in SQL: *"matched by name when the payment records one, else the
   student's most recent active one"*. A reporting surface guessing which
   obligation a payment settled is the clearest evidence that the fact is missing
   from the data.

### 2.5 The free-text semester name is repeated in five tables

`student_semesters.semester_name`, `payments.semester`, `registrations.semester`,
`scholarship_awards.semester`, `enrollments.semester_name`.

**And the name is not unique over time.** `uq_student_semester_active` is
`UNIQUE(student_id, semester_name) WHERE status = 'active'` — a completed
"Term One" and a new active "Term One" can coexist for one student, so a payment
naming `'Term One'` is ambiguous the moment a student repeats a term.

---

## 3. Verification: can the existing model support the owner's direction?

**Answer: partially — the pattern exists and is proven, but three structural
facts are missing. No schema change is proposed here; this is the gap list the
owner asked for.**

### 3.1 What already supports it (FACT)

| Support | Evidence |
|---|---|
| Attribution-by-foreign-key is already an accepted pattern in this schema | `payments.refunds_payment_id` (D-113) with `ON DELETE RESTRICT` and two enforcing triggers; `payments.invoice_id`; `student_suspension_semesters.semester_id` already FKs `student_semesters(id)` |
| A stable tuition identity exists | `student_semesters.id` is a primary key; nothing prevents referencing it |
| One canonical schema, applied idempotently, with no migration chain | `server/src/db/schema.sql`, `npm run preflight:fresh-schema` |
| Whole-AFN integer money with scale triggers | D-12/D-22; allocation arithmetic cannot drift into fractions |
| A settlement rule with exactly one implementation to extend | `getSemesterTuitionPaid` (D-116) |
| A test harness that already exercises money end-to-end | 104 WP-07 package cases; full suite 2678 |
| No production data to migrate | A-1 |

### 3.2 What blocks it (FACT — each is a gap, not a defect to patch)

| # | Gap | Why it blocks D-117/D-118 |
|---|---|---|
| G1 | **No obligation identity.** Only tuition has a stored amount, and it lives on the enrolment row | "allocate to the specific obligation" has nothing to point at for books, exams, fixed fees or invoice lines |
| G2 | **Tuition is attributed by NAME, and the name is ambiguous over time** (§2.5) | a repeated term makes the allocation non-deterministic even when the operator names it |
| G3 | **The installment plan is unnormalized JSON with no enrolment link** | D-117 requires the plan to be *tied to its enrolment/semester obligation*; today a plan cannot express which enrolment it pays, and a JSON element cannot be an FK target |
| G4 | **An invoice has no purpose and no obligation link**; its payment hard-codes `'fee'` | D-118 requires the invoice to declare purpose and identify the obligation it bills |
| G5 | **One payment row = at most one implicit obligation** | an invoice billing two obligations, or a payment covering a term plus a book, cannot be expressed; nor can a partial allocation |
| G6 | **Four allocation rules, one of them a reporting heuristic** | the same money can be attributed differently by the desk, the balance and BOS |
| G7 | **Scholarship awards and registrations repeat the free-text semester** | a scholarship that settles tuition would need the same allocation, and today it names a string |
| G8 | **Fixed fees have no obligation at all** — they are inferred from the absence of a prior payment | a "settle the obligation" model has nothing to settle; the guard is a query, not a record |

### 3.3 Consequence already proven (FACT, from the defect record)

- **WP07-F16** — installment payment settles no term: 14,000 AFN collected for a
  10,000 AFN term.
- **WP07-F17** — a "Textbooks and stationery" invoice reduced tuition owed from
  10,000 to 7,000.

Both are instances of G1–G5, not independent bugs. Patching either one in place
(for example, asking the operator to name a term when paying an installment)
would satisfy the symptom while leaving G1, G2 and G5 in place — and D-117
explicitly rejects that operator-selects-the-term shape for installments.

---

## 4. Candidate target models (PROPOSAL — none implemented)

### Option A — Obligation + allocation ledger (textbook accounts-receivable)

```
student_obligations(id, student_id, branch_id, kind, source_ref, description,
                    gross_amount, discount_amount, net_amount, due_date,
                    status, created_at)
payment_allocations(payment_id, obligation_id, amount)      -- many-to-many
invoices.purpose + invoice_items.obligation_id              -- an invoice bills obligations
student_installments(id, obligation_id, sequence, amount, due_date, status)
```

- Tuition obligation is created with the enrolment; installments are children of
  it (satisfies D-117 with **no operator choice**); an invoice bills one or more
  obligations and its payment allocates to them (satisfies D-118).
- Settlement of anything = `SUM(allocations) vs net_amount`, one rule for every
  obligation kind. Removes G1–G8 together.
- Cost: the largest change in WP-07 so far. Touches the payment desk, invoices,
  visitor conversion, placement, books, funding, BOS revenue attribution, the
  balance authority, the student profile/roster UI and most WP-03/WP-07 suites.

### Option B — Typed obligation links, no allocation table

Add `payments.semester_id` (FK), `invoices.purpose` + `invoices.semester_id`,
normalize installments into `student_installments(semester_id, …)`.

- Fixes G2, G3, G4 and the two proven defects; leaves G1 (only tuition is a real
  obligation), G5 (no partial/multi allocation) and G8 (fixed fees) unresolved.
- Materially smaller: no new allocation concept, no change to how a payment is
  read, and the balance authority keeps its current shape with an id instead of
  a name.

### Option C — Minimal symptom fix

`invoices.purpose` + require `semesterId` on installment payments.

- Closes WP07-F16 and WP07-F17 only, and does so in the shape D-117 rejects
  (operator names the term). Recorded for completeness; **not recommended**.

### Assessment against the owner's direction

| Requirement (D-117 / D-118) | A | B | C |
|---|---|---|---|
| Every tuition payment allocated to a specific obligation | yes | yes (tuition only) | partly |
| Installment tied to its enrolment, no operator choice | yes | yes | no |
| Invoice declares purpose | yes | yes | yes |
| Tuition invoice identifies its obligation | yes | yes | no |
| Non-tuition money never reduces tuition | yes | yes | yes |
| `Invoice → Obligation → Payment allocation` as the shape | yes | approximated | no |
| One settlement rule for every obligation kind | yes | no | no |

**Recommendation (PROPOSAL, needs owner approval):** Option A is the only one
that matches the owner's stated shape end to end, and A-1 (no production data)
makes it affordable now in a way it will not be later. If the owner prefers to
stage it, Option B is a strict subset of A — `student_installments` and the
typed links survive unchanged into A — so B is a safe first slice and not
throwaway work.

---

## 5. What must be decided before any implementation (OPEN)

1. May one payment settle **several** obligations (one 15,000 AFN payment
   covering a term and a book)? Option A assumes yes; B assumes no.
2. May one invoice bill **several** obligations, or exactly one?
3. What happens to money paid **beyond** an obligation — refused (today's rule
   for tuition and invoices), or held as a credit that can be allocated later?
4. Does a **scholarship award** settle a tuition obligation (and therefore
   allocate like a payment), or is it a discount on the obligation's amount?
5. Do **fixed fees** (ID card, diploma, placement) become real obligations, or
   stay as guarded one-off charges?
6. Are the **existing free-text semester names** in `registrations` and
   `scholarship_awards` to be converted to obligation references as part of this,
   or left alone?

---

## 5a. Decision memo

The six questions above are answered with evidence and a recommendation per
decision in `docs/work-packages/WP-07-payment-allocation-decisions.md`
(READ-ONLY, awaiting owner approval).

## 6. Status

- WP07-F16 and WP07-F17 remain **OPEN and unmodified** in the codebase; both are
  recorded with their proofs in
  `docs/certification/WP-07-slices-A-B-finance-remediation.md`.
- D-117 and D-118 are recorded in `docs/registries/decisions.md` as owner
  business rules with implementation **deferred by owner instruction**.
- No source file, schema object or test was changed by this analysis. The
  release gate was re-run at `a17fcbd`: **22 passed · 0 failed**.
