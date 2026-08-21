# WP-07 · E1b — CHECKPOINT (§65): one settlement authority for cash

**Protocol:** §65 CHECKPOINT · §61 (no invented policy) · §106 SCOPE · LAW 1 · LAW 4
**Date:** 2026-08-21 · **Baseline:** `b7d127e` (release gate 22/22; server suite 2788 passed · 160 known skips)
**Outcome:** **BLOCKED on one owner decision** — see §3. Everything else is ready.

---

## 1. What E1b is

`obligation_allocations.source_kind` declares three instruments. Two are live:
`scholarship` (D-120) and `sponsorship` (D-131). **`payment` is declared and
unused.** Cash tuition is still attributed by `payments.semester`, a free-text
column, and the two mechanisms are reconciled by one reader:

```
getSemesterTuitionSettled = getSemesterTuitionPaid   (payments.semester, free text)
                          + getSemesterScholarshipSettled (obligation_allocations)
```

E1b makes cash settle the same way everything else does, so the term a payment
pays is a foreign key rather than a string that happens to match.

**Why it matters (FACT).** `uq_student_semester_active` is
`UNIQUE(student_id, semester_name) WHERE status = 'active'`, so a term NAME is
unique only among active terms and **not over time**. A student who takes
"Term One" twice has two terms with one name; `payments.semester = 'Term One'`
cannot say which one was paid. An allocation naming `obligation_id` can.

## 2. Inventory (measured)

**Writers of `payments.semester` — 4:**

| Writer | Line |
|---|---|
| `routes/invoices.routes.ts` | 58 (tuition invoice payment, added in slice F) |
| `routes/students.routes.ts` | 144 (payment desk), 197 (refund) |
| `routes/visitors.routes.ts` | 94 (conversion payment, added in slice F) |

**Readers:**

| Reader | Nature |
|---|---|
| `utils/studentBalance.ts:174` `getSemesterTuitionPaid` | THE settlement read — the only one that decides what a term still owes |
| `routes/students.routes.ts` 452, 1327 | display only |
| `routes/students.routes.ts` 1443, 1469 | a refund inherits its target's semester (D-114) |
| `routes/bos.routes.ts` | revenue-by-class / by-time-slot still guess attribution ("matched by name when the payment records one, else the student's most recent active one") — **out of scope, see §4** |

`getStudentBalance` sums tuition-category payments across all terms and does not
use `semester` at all, so the student-level position is unaffected by the key
change; only the per-term position is.

## 3. THE BLOCKER — how does a refund reduce an allocation?

**FACT.** A refund is a **negative payment**: `stmtInsertRefundPayment.run(payId,
student.id, -refundAmount, …, target.id, target.semester ?? null)`
(`students.routes.ts:1441`). Partial refunds are supported and capped by
`stillRefundable`.

**FACT.** `obligation_allocations.amount` is `INTEGER NOT NULL CHECK (amount > 0)`
(`schema.sql:2771`). **A refund cannot be expressed as an allocation today.**

This is a genuine modelling fork and the agent will not choose it:

### Option A — the refund reverses the allocation it targets
The refund reverses the original payment's allocation through the mechanism that
already exists (`status='reversed'`, `reversed_at`, `reversed_by`,
`reversal_reason`), and for a *partial* refund writes a fresh allocation for the
amount retained.
* Reuses the mechanism scholarships and sponsorships already use — **one way to undo an allocation**.
* No schema change; `amount > 0` keeps protecting every instrument.
* A partially refunded payment ends up with two allocation rows (one reversed, one active), which is an accurate history but more rows.

### Option B — the refund writes its own signed allocation
Relax the CHECK so a `payment` allocation may be negative; settled = `SUM(amount)`.
* Mirrors a convention the repository already uses twice: `payments.amount` stores refunds signed, and `recordIncome` posts a negative ledger row for a reversal.
* Cost: two ways to undo an allocation (`status='reversed'` **and** a negative row), and `amount > 0` stops guarding the table.

### Option C — refunds stay outside allocations
`settledCash = SUM(active payment allocations) + SUM(refund payments for that term)`.
* Smallest change.
* Cost: cash settlement would again be computed from two mechanisms — **exactly the duplication E1b exists to remove** (LAW 1).

**Agent recommendation: Option A.** It is the only option that leaves one way to
undo an allocation, needs no schema change, and keeps the `amount > 0` guard
that currently protects scholarship and sponsorship money. Its cost is row count,
which is not a correctness cost.

## 4. Deliberately out of scope (§106)

* **BOS revenue attribution** (`stmtRevenueByClass`, `stmtRevenueByTimeSlot`) still guesses the term by name. E1b makes a correct attribution *possible*; using it is a separate, reporting-side change that should carry its own defect ID.
* **F-18b** — `reports.routes.ts` open-invoice "outstanding" overlapping the balance authority. Untouched.
* **Retiring the `payments.semester` column itself.** The migration should first make allocations authoritative and prove it; dropping the column is a follow-on step once no reader remains.
