# WP-07 · WP07-F18b — READ-ONLY EVIDENCE ANALYSIS

**Protocol:** §65 CHECKPOINT · §61 (no invented policy) · §103 EVIDENCE · §106 SCOPE · LAW 1 · LAW 4
**Date:** 2026-08-21 · **Baseline:** `526df15` (release gate 22/22; suite 2817 passed · 162 skipped · 0 failed)
**Status:** analysis performed read-only; **owner approved Option 2 + "as at today" and it is IMPLEMENTED** (D-150/D-151). **See §7 — this analysis contained an error, corrected there.**

**Original status when written:** **ANALYSIS ONLY. Nothing was changed.** `git status` is clean; the probe used to prove the defect was run from a scratch database and deleted.

---

## 1. The two authorities

| | **A — the balance authority** | **B — the report's open-invoice figure** |
|---|---|---|
| Implementation | `getBranchOutstanding` (`server/src/utils/studentBalance.ts:303`) | inline SQL in `reports.routes.ts:389-409` |
| Source of truth | `student_semesters` (tuition due) − tuition-category `payments` | `invoices.net_amount` − payments against those invoices |
| Scope of money | **tuition only** | **every purpose** — tuition, registration, books, exam |
| Per-student floor | `MAX(0, …)` per student, so one credit cannot mask another's debt | none — a whole-branch subtraction |
| Period | none, and none claimed | **claims "at period end"; applies no date filter** |
| Aid-aware | yes (D-120/D-131: aid settles the obligation) | **no** |
| Consumer | `bos.routes.ts:286` → `BusinessOperatingSystemView.tsx:143`, labelled **"Student Arrears"** | `GET /api/reports/overview` → `OperationsReportView.tsx:215`, labelled **"Outstanding balances"** |

---

## 2. The defect, proven (§103)

A scratch database was built from the canonical schema and driven through the
**approved** scholarship lifecycle: a 10,000 AFN term, a tuition invoice naming
its obligation, and a donor settling the whole term with a scholarship
allocation.

```
Term bills                                   : 10000
Settled by donor (aid allocation)            : 10000
--
A) balance authority  "Student Arrears"      : 0        (BOS executive dashboard)
B) reports open-invoice "Outstanding balances": 10000    (Operations report)
```

**Two screens give opposite answers about the same student's same term.** The
owner is told simultaneously that the student owes nothing and that they owe
10,000 AFN.

**Root cause (FACT).** Aid settles an **obligation**; it writes no payment and
never touches the invoice, so the invoice stays `issued`. B measures unpaid
invoices, so **every term settled by a scholarship or a sponsorship is reported
as outstanding forever**. Slices E, G and J made aid a real, usable instrument —
which turned a latent inconsistency into a reachable, everyday misstatement.

### Second, independent defect in B

**FACT.** The block is introduced by the comment *"outstanding student balances
**at period end**"* and sits between two genuinely period-scoped figures. Its
SQL is:

```sql
FROM invoices i WHERE i.status != 'draft' AND i.status != 'cancelled' AND i.status != 'paid'
```

There is **no date filter**, while the discount query four lines above it in the
same handler filters `issue_date >= ? AND issue_date <= ?`. The figure is
all-time, is presented inside a period report, and is rendered next to a
*"vs previous period"* comparison. `from` and `to` are already in scope — the
omission is an inconsistency inside one handler, not a missing capability.

---

## 3. Which is canonical

**A is canonical for tuition.** It reads `student_semesters`, the declared
canonical authority for *Student tuition balance*
(`docs/registries/canonical-authority.md:58`), it honours the per-student floor,
and it is aid-aware through the settlement authority (D-120/D-131/D-141).

**B is not a second opinion about the same question — it is a different
question, asked wrongly.** "How much is unpaid on issued invoices" is a
legitimate operational figure (it drives collections), but B answers it
incorrectly on three counts: it ignores aid settlement, it claims a period scope
it does not apply, and it is named as though it were the tuition arrears figure.

**Neither contains the other**, which is why this cannot be resolved by deleting
one:
* B counts registration, books and exam receivable — money A never counts;
* A counts tuition debt carried by a term with no invoice (the payment-desk and conversion paths) — money B never counts.

---

## 4. Blast radius (measured)

| Surface | Exposure |
|---|---|
| `server/src/routes/reports.routes.ts` | one block, lines 389-409 |
| `src/types.ts:1596` | `outstanding: { openInvoices, gross, paid, remaining }` |
| `src/components/reports/OperationsReportView.tsx:214-216` | the card label and its sub-line |
| `server/src/tests/reporting-forensic.test.ts:169-171` | 3 assertions on `gross` / `paid` / `remaining` |
| BOS dashboard + `getBranchOutstanding` | **untouched by every option below** — A is already correct |

Small and contained: one server block, one type, one UI card, three assertions.

---

## 5. Options

### Option 1 — Make B honest, keep both figures
Rename to **"Unpaid invoices"**, subtract aid-settled amounts so a donor-funded
term stops appearing, and either apply the period filter or drop the "at period
end" claim. A remains the tuition arrears authority.
* Both legitimate questions survive, each correctly named and correctly computed.
* Two receivable figures still coexist; a reader must understand the difference.
* Smallest change; no contract shape change.

### Option 2 — One receivable, derived from the authorities *(recommended)*
The report publishes **total receivable = tuition outstanding (from A, already
aid-aware) + unpaid non-tuition invoices**, with the two components shown
separately and the open-invoice **count** retained as an operational metric.
* One coherent answer to "what are we owed", with no overlap and no double count: tuition comes from the tuition authority, everything else from invoices.
* Structurally cannot disagree with the BOS figure, because it contains it.
* Changes the `outstanding` contract shape and the UI card; largest of the three.

### Option 3 — Remove B
Delete the invoice-derived figure; the operations report links to the BOS
arrears figure.
* Guarantees one definition.
* **Loses real information** — non-tuition receivable and the open-invoice count would be reported nowhere. Not recommended.

**Recommendation: Option 2.** It is the only option that leaves the system with
one answer to "what are we owed" while keeping every component of that answer
visible. It also removes the overlap permanently rather than documenting it, and
it reuses A rather than creating a third computation — the same reasoning that
made `obligation_allocations` the single settlement authority (D-120).

Option 1 is a legitimate, cheaper choice if the owner wants the operations
report to keep answering the narrower collections question.

**Not a business-policy decision either way** — both options report money the
system already knows; the choice is which question the operations report should
answer. That is the owner's call, which is why nothing has been implemented.

---

## 6. Out of scope regardless of the option chosen (§106)

* **Slice-K residual** — both BOS revenue reports INNER JOIN `classes`, so tuition for a class-less term appears in neither total.
* **`payments.semester` retirement** — the agreed follow-on.
* **TR-4** — independent review remains outstanding.


---

## 7. ERRATUM and outcome

### 7.1 This analysis was wrong in one respect (D-152)

§1 tabulated authority **A** as *aid-aware: yes*, and §2's probe printed
`A) balance authority "Student Arrears": 0`.

**That was incorrect.** The probe subtracted aid **in its own arithmetic**
(`A.outstanding - aid.t`). Production's `getBranchOutstanding` — which is what
the dashboard actually calls — contained no aid subtraction at all
(`git show HEAD:server/src/utils/studentBalance.ts`). `getStudentBalance` is
aid-aware; `getBranchOutstanding` was not, and §1 conflated the two.

**The true pre-repair state:**

| Surface | Reported for a term fully settled by a donor |
|---|---|
| Student profile / roster (`getStudentBalance`) | **0** — correct |
| BOS "Student Arrears" (`getBranchOutstanding`) | **10,000** — wrong |
| Operations report (invoice-derived) | **10,000** — wrong |

The defect was **wider** than analysed, not narrower: two of the three surfaces
were wrong, and the two "competing authorities" framing understated it. This is
recorded rather than quietly amended.

### 7.2 What was implemented

* **D-150** — the report publishes one composed receivable: `{ tuition, nonTuition, total, openInvoices }`. Tuition from the tuition authority only; everything else from the documents that bill it. A position as at today.
* **D-151 (WP07-F23)** — `getBranchOutstanding` subtracts active aid allocations and accepts `branchId: string | null`, so the per-student, per-branch and organization-wide figures are one definition with different filters.

**Release gate:** 22 passed · 0 failed · 0 skipped. **Server suite:** 2825 passed · 162 skipped · 0 failed.

### 7.3 Still open after F-18b

* **TR-4** — independent review by a second reviewer.
* Slice-K residual — both revenue reports INNER JOIN `classes`.
* `payments.semester` retirement.
