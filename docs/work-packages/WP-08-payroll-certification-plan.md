# WP-08 Payroll — Certification Repair Plan

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§42, 49, 53, 58–74, 95–101 and §W  
**Work package:** WP-08 Payroll — teacher and employee payroll behavior hosted by `teachers.routes.ts`  
**Date:** 2026-08-22  
**Pre-repair baseline:** `3e5683dcadbd4f995100e754ef2b70570e8b9053`

> This is a bounded payroll plan. It does not certify generic teacher workload
> assignment (WP-05), report-catalog ownership (WP-11), or the wider finance
> package. Payroll-to-report and payroll-to-budget dependencies are tested where
> they are required to preserve payroll truth.

## SCOPE

Included:

- teacher and employee salary payment, correction and idempotency behavior;
- Shamsi payroll-period input and salary calculation boundaries;
- payroll-rule failure behavior;
- employee transfer target authorization;
- teacher salary-ledger database backstops, idempotency index semantics and
  duplicate-index removal owned by WP-08 in conflict C-18;
- affected payroll API response and frontend contract alignment.

Excluded:

- class/skill workload eligibility and assignment management (WP-05);
- generic rule authoring and report-catalog architecture (WP-01/WP-11);
- invoice, payment, treasury and budget-movement redesign (WP-07);
- production deployment operations.

Risk classification: **Critical/High**. Payroll writes expense-side financial
facts, debits branch envelopes, controls person compensation and carries
branch-scoped HR authority.

## DISCOVER / MODEL

The authoritative payment path is:

```text
Payroll.Edit + scoped person
  -> canonical Shamsi period
  -> teacher due calculation / employee amount boundary
  -> idempotency replay check
  -> conditional payroll-envelope debit
  -> financial_transactions expense row
  -> salary ledger row
  -> audit and notification
```

Teacher money is capped by the computed period due and represented by
`teacher_salary_ledger`; employee full/partial salary and genuine advances are
represented separately by `employee_salary_ledger`. The budget envelope is
identified by `budget_lines.payroll_target`, not by a display label. Teacher
correction is a void state transition plus signed financial contra entry.

The following invariants must hold:

1. A retry is one business event even when it crosses the derived-key bucket
   edge; explicit keys remain scoped to person and period.
2. A voided teacher payment does not answer as a live replay and a corrected
   payment creates a new posted fact, debit and expense.
3. Every route and stored ledger period is a canonical Shamsi period.
4. Payroll policy evaluation cannot silently substitute neutral multipliers.
5. A branch-scoped employee editor cannot move an employee to an unauthorized
   target branch.
6. Salary-ledger money cannot be negative through a direct database writer.
7. One covering index implements one teacher period lookup shape.

## CHALLENGE / DECIDE

| Surface | Decision | Reason |
|---|---|---|
| Derived idempotency | Refactor | `resolveIdempotency()` already returns current + prior candidate keys, but payroll consumed only the current one. The route must consume the full authority. |
| Voided teacher retry | Refactor schema + route | A status-independent idempotency unique index and replay lookup made a correction appear successful without posting money. Live facts, not voided history, own replay identity. |
| Period handling | Consolidate | Reuse the existing Jalali normalizer, expose one validated-period predicate, and reject supplied invalid values at every payroll edge. |
| Rule failure | Refactor | Payroll must propagate a corrupt active-rule failure to a clear business rejection; it may not invent neutral policy outputs. |
| Employee transfer | Repair | Apply the same target-branch authorization already present on the equivalent teacher transfer. |
| Ledger storage | Strengthen | Add canonical triggers for positive whole-AFN teacher ledger facts and remove the duplicate `idx_teacher_salary_period` index identified by C-18. |
| Teacher UI/API type | Align | The browser must not offer teacher `advance`, which owner decision D-14 removed from the server contract. |

## CHECKPOINT

Classification: financial behavior change · RBAC/security repair · canonical-schema
change · index removal. The failing adversarial suite is deliberately retained as
executable evidence at
`server/src/tests/work-packages/wp08/payroll-certification.attack.test.ts`.

Checkpoint `173ba66` is the recoverable pre-repair state. It contains this
plan's first version, the 9/9 failing attack evidence, and no implementation
repair.

## INDEPENDENT-REVIEW AMENDMENT / RE-DECIDE

A cold review of the repaired diff and the payroll report consumer found four
additional defects. `payroll-certification.review.test.ts` reproduced all four
against the first repair (4/4 failing):

1. Employee ledger rows have the same correction-state columns as teacher rows,
   but no authorized employee void command exists.
2. Payroll reports constrain timestamp text against date-only bounds, which
   excludes a payment made later on the current date.
3. A direct ledger insert may omit the financial transaction that makes the
   money explainable.
4. A posted salary row can be directly rewritten or deleted despite being a
   financial history fact.

A final direct-delete probe then found one linked consequence (1/1 failing):
removing a ledger's linked financial transaction left an orphaned payroll fact.
The second repair guards both the ledger and its linked original/contra
transactions.

The plan is therefore extended, before the second repair, to:

- expose an employee void command with the same atomic envelope restoration,
  signed contra entry, audit and reason requirements as teacher correction;
- make the declared payroll report consume the linked transaction's canonical
  accounting date and only posted ledger facts;
- require a matching financial transaction for each new salary ledger fact;
- permit exactly one ledger update transition — `posted` to `voided` with
  operator and reason — and reject direct deletion or fact mutation.

This is a deliberate WP-08 → WP-11 dependent-consumer re-scope: the report
catalog remains WP-11's authority, but its payroll metric must consume the
corrected WP-08 ledger lifecycle rather than publishing a contradictory number.
Checkpoint `a72f0ea` is the second recoverable schema/financial checkpoint:
it retains the first repair and the independently constructed failing review
suite before the second correction begins.

## FINAL AUTHORITY-AUDIT FOLLOW-UP

The final authority pass replayed a keyed teacher partial payment and found one
more API-truth defect: the retry reported `previouslyPaid = due - paid`, which
turned a first 1,000 AFN payment against a 10,000 AFN due into a fabricated
9,000 AFN prior payment. The focused assertion failed 1/1 before repair.

Each new teacher ledger row now stores the original due, prior-paid and
remaining-after snapshot alongside its calculation breakdown. A replay returns
that snapshot; rows whose existing notes contain only a breakdown use the live
posted-period total as an explicit conservative fallback. The final attack
suite is 10/10.
