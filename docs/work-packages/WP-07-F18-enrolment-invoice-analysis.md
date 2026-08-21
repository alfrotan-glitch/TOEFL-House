# WP-07 · WP07-F18 — READ-ONLY ANALYSIS

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §61 (no invented policy) · §62 · §105 (STOP) · §106 (scope) · LAW 1 · LAW 4
**Date:** 2026-08-21 · **Baseline:** `f0b148d` (release gate 22/22; server suite 2771 passed · 160 known skips)
**Owner instruction:** *"Read-only analysis first, no implementation"* and *"Resolve WP07-F18 first"* (selections recorded this session).
**Status of this document:** analysis only. **No source, schema, test or registry behaviour was changed to produce it.** This is the D-119 treatment applied to F-18.

---

## 1. The finding, restated precisely

**FACT.** `AcademicCatalogService.buildFeeSnapshot` composes one fee list from
several fee types (`catalog-service.ts:381-386`):

```
addFromRules('registration');
addFromRules('semester');
if (enrollmentType === 'repeat' || 'partial_repeat') addFromRules('retake');
```
plus a branch-profile `registration` fee fallback and a level/branch `semester`
fee fallback. `fee_rules.fee_type` is CHECK-constrained to nine values
(`registration, placement, semester, book, retake, diploma, card, exam, other`).

**FACT.** `EnrollmentService.enroll` writes that whole list to **one** invoice
(`enrollment-service.ts:502-510`), one `invoice_items` row per fee.

**FACT.** The `student_semesters` row the same call creates is inserted with
`fee_amount = 0` and no `net_fee_amount` (`enrollment-service.ts:169`):

```sql
INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status)
VALUES (?, ?, ?, ?, date('now'), 0, 'active')
```

**INFERENCE (LAW 1).** `student_semesters` is the declared canonical authority
for *Student tuition balance* (`docs/registries/canonical-authority.md:58`), and
`TUITION_NET_SQL = COALESCE(net_fee_amount, fee_amount)` is the one expression
that says what a term bills. On this path that expression returns **0** while a
real tuition fee is being billed on an invoice. Tuition receivable therefore has
two representations depending on which door the student came through:

| Door | Where the tuition figure lives | Does `studentBalance` see it? |
|---|---|---|
| Visitor conversion (`visitors.routes.ts:88`) | `student_semesters.fee_amount` / `net_fee_amount` | **Yes** |
| Manual student registration (`students.routes.ts:141`) | `student_semesters.fee_amount` / `net_fee_amount` | **Yes** |
| Enrolment service (`enrollment-service.ts:169`) | the **invoice**; the semester bills 0 | **No** |

**FACT — a stale claim in the source.** The comment above that insert states
*"EnrollmentService is the single writer… No caller inserts a semester row
itself — visitor conversion, waitlist conversion and manual student registration
all rely on this."* Two other writers exist (`students.routes.ts:141`,
`visitors.routes.ts:88`). The comment is not true today. Whichever option is
chosen, that comment must be corrected or made true; it is currently a false
statement about an authority (§13).

---

## 2. Blast radius — measured, not estimated

### 2.1 The defective combination is reachable through exactly ONE endpoint

The condition requires `writeSemester ≠ false` **and** `autoInvoice ≠ false`
**and** `snapshot.total > 0`. Every production caller was inspected:

| Caller | `autoInvoice` | `writeSemester` | Produces the F-18 condition? |
|---|---|---|---|
| `students.routes.ts:916` (registration) | `resolvedTuition <= 0` | `false` | **No** |
| `students.routes.ts:1539` (enrol existing student) | `resolvedTuition <= 0 && paidNow <= 0` | `false` | **No** |
| `visitors.routes.ts:907` (conversion) | `false` | `false` | **No** |
| `journey.routes.ts:293` → `journeyRouter` `POST /enrollments`, mounted under `/api/students/:id/journey` | **defaults to `true`** | **not passed → defaults to `true`** | **YES** |

**This is the single most important fact in this analysis.** The journey
enrolment endpoint (permission `Class.Assign`) is the only
production path that creates a zero-fee semester alongside a fee-bearing
invoice. Every other caller already suppresses one half of the problem — and
notably, the two paths that *do* write a real tuition figure onto the semester
row pass `writeSemester: false` and write it themselves.

**Consequence for scope.** This is a *narrow* repair, not a WP-05-wide one. The
earlier CHECKPOINT estimate ("changes WP-05-certified writers", §3 of
`WP-07-F17-invoice-purpose-checkpoint.md`) was **too pessimistic** and is
corrected here.

### 2.2 Who reads the columns that would change

`fee_amount` / `net_fee_amount` readers outside tests (9 files, by count of
matching lines):

| File | Lines | Nature |
|---|---|---|
| `utils/studentBalance.ts` | 8 | THE balance authority (`TUITION_NET_SQL` + five aggregate queries) |
| `routes/students.routes.ts` | 4 | profile, roster, payment desk |
| `routes/academic.routes.ts` | 4 | academic reads |
| `routes/bos.routes.ts` | 2 | dashboard |
| `routes/visitors.routes.ts` | 1 | conversion writer |
| `routes/placement-attempt.routes.ts`, `core/placement/store.ts`, `core/placement/placement-policy.ts` | 1 each | placement fee reads (unrelated to tuition) |
| `core/academic/enrollment-service.ts` | 1 | the writer under discussion |

Every tuition consumer already routes through `studentBalance.ts`. **Nothing
reads the enrolment invoice as a tuition figure**; the only invoice-based money
report is `reports.routes.ts:389-409`, which sums *open invoices* as an
"outstanding" figure independent of the tuition balance — and that figure is
already double-counted in principle for the conversion path, where both the
invoice and the semester row exist. That pre-existing overlap is noted below as
a dependent question, not resolved here.

### 2.3 Tests that would move

`grep -rln "autoInvoice|fee_snapshot|buildFeeSnapshot|feeSnapshot" server/src/tests` → **4 files**:

* `work-packages/wp05/attack.test.ts`
* `work-packages/wp04/enrollment-gates.integration.test.ts`
* `work-packages/wp03/students-admissions.attack.test.ts`
* `payment-overpayment.test.ts`

`grep -rln "invoiceId|invoiceNumber" server/src/tests/work-packages/wp05` → **0 files**.
No WP-05 suite asserts anything about the enrolment invoice's identity or
amount. The exposure is the fee-snapshot shape, not the invoice.

### 2.4 Certified decisions touched

| Decision | Relationship |
|---|---|
| **D-127 / D-118** | The reason F-18 exists: a mixed invoice cannot name one obligation, so it cannot be a `tuition` invoice. Any option must keep that true. |
| **D-120** | `student_obligations` + `obligation_allocations` is the single settlement authority. An enrolment tuition invoice must bill an obligation of that authority, not a parallel one. |
| **D-128** | A term may not be billed beyond what it bills. **This is the constraint that makes Option A safe and Option C unsafe** — see §4. |
| **D-116 / D-114** | Semester settlement and refund attribution key on the term. Unaffected by any option, since none changes how settlement is read. |
| **A-18** | The interim `other` classification this analysis exists to replace. |
| Canonical-authority rows 58 (Student tuition balance) and 70 (Enrollment lifecycle) | Row 58's authority is `student_semesters`; Option A/B make that true on the third path too. Row 70 is unchanged — the lifecycle is not touched. |

---

## 3. The options, assessed against the evidence

### Option A — split the enrolment invoice by purpose *(the owner's "split" option)*

Enrolment issues a `tuition` invoice for the `semester` (+ `retake`) fees, naming
the term's obligation, and a separate `other` invoice for `registration` (and any
other non-tuition fee). The semester row is written with the tuition portion.

* **Correctness:** highest. Every fee ends up on a document whose purpose matches it, and the tuition figure lands on the declared authority.
* **Requires:** the semester row must carry the tuition portion, otherwise D-128 refuses the tuition invoice outright (a term that bills 0 has 0 capacity). So Option A *contains* Option B.
* **Cost:** two documents per enrolment where there was one; two invoice numbers consumed; `journey.routes.ts` response shape (`{ enrollmentId, invoiceId, invoiceNumber }`) must express two invoices or a primary plus a list — **a breaking API change to one endpoint**.
* **Risk:** the response-shape change is the only real one. 4 test files touch fee snapshots; 0 assert invoice identity.

### Option B — one invoice, tuition figure onto the semester row

`student_semesters.fee_amount` / `net_fee_amount` receive the `semester`
(+`retake`) portion; the auto-invoice stays a single `other` document.

* **Correctness:** fixes the *authority* problem (tuition receivable becomes single-sourced) but leaves a document that bills tuition while declaring it does not. A payment against it still settles no term, so the operator must collect tuition at the desk against the term instead.
* **Cost:** smallest. One `INSERT` changes; no API shape change.
* **Residual:** the invoice and the obligation describe overlapping money with no link — precisely the ambiguity D-118 was written to remove. `reports.routes.ts` open-invoice "outstanding" would count the registration fee only, while tuition outstanding comes from the balance authority: arguably *cleaner* than today.

### Option C — keep the interim `other` permanently

* **Correctness:** lowest, and it does not merely freeze the status quo — it makes the zero-fee semester permanent. A student enrolled through the journey endpoint has a term that bills **0** forever, so `getStudentBalance` reports no tuition debt for them, the enrolment debt-hold never fires, and D-128's capacity check would refuse any later tuition invoice for that term ("already fully billed or settled"). **This option has a live consequence, not just an aesthetic one.**
* **Cost:** zero.
* **Assessment:** not recommended. It is the only option that leaves a student's tuition debt structurally invisible.

---

## 4. What the agent recommends, and why (BEST PRACTICE, not policy)

**Option A, implemented as B-then-A**, i.e. one slice that first puts the
tuition figure on the semester row and then splits the document.

Reasoning drawn from repository evidence, not preference:

1. **A requires B anyway.** D-128 gives a term a billing capacity of
   `netAmount − settled − claimed`. A term billing 0 has no capacity, so a
   tuition invoice against it is refused. Option A cannot be built without B.
2. **The blast radius is one endpoint**, not a work package (§2.1). The scope
   correction is material: this no longer needs a WP-05 re-certification.
3. **It is the only option that makes the declared canonical authority true**
   on all three doors, which is what LAW 1 requires of row 58.
4. **It invents no policy.** Which fee types are tuition is already declared by
   `fee_rules.fee_type`; `semester` and `retake` are tuition, `registration` is
   not. That mapping is read from the database, not chosen by the agent.

**The one thing the owner must still decide, because evidence cannot settle it:**
whether a **`retake` fee is tuition**. `buildFeeSnapshot` adds it only for
`repeat` / `partial_repeat` enrolments, and it is plausibly either a tuition
charge for repeating the term or a separate administrative charge. The other two
are unambiguous (`semester` = tuition; `registration` = not).

---

## 5. Dependent questions deliberately NOT resolved here (§106)

| # | Question | Why it is out of scope |
|---|---|---|
| F-18a | Is a `retake` fee tuition? | Business policy — owner only (§4). |
| F-18b | `reports.routes.ts` sums open invoices as "outstanding" while the balance authority derives tuition outstanding from `student_semesters`. On the conversion path both exist, so the two figures overlap. | A separate reporting-authority question, pre-existing, unchanged by every option above. Should become its own defect ID. |
| F-18c | The false single-writer comment at `enrollment-service.ts:163-168`. | Correct it in whichever slice touches that writer. |
| F-18d | `journey.routes.ts` defaults both `autoInvoice` and `writeSemester` to true while every other caller disables them. Is the default right? | Surfaces from §2.1; should be decided with the option. |

---

## 6. Evidence commands (reproducible)

```
grep -rn "INSERT INTO student_semesters|UPDATE student_semesters" server/src --include=*.ts | grep -v tests
grep -rn "autoInvoice" server/src --include=*.ts | grep -v "/tests/"
grep -n "writeSemester" server/src/core/academic/enrollment-service.ts
grep -rn "net_fee_amount|fee_amount" server/src --include=*.ts | grep -v tests | grep -v db/schema
grep -rln "autoInvoice|fee_snapshot|buildFeeSnapshot|feeSnapshot" server/src/tests --include=*.ts
grep -rln "invoiceId|invoiceNumber" server/src/tests/work-packages/wp05 --include=*.ts
sed -n '381,386p' server/src/core/academic/catalog-service.ts
sed -n '169p;463p;502,510p' server/src/core/academic/enrollment-service.ts
```
