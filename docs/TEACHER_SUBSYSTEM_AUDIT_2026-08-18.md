# Teacher Subsystem — Independent Forensic Audit (findings only, no remediation)

**Date:** 2026-08-18
**Base commit:** `91590a014b55a71e02dd9f7a9aa570d7521a8081` (Class subsystem FROZEN)
**Scope:** teachers, employees, teacher payroll, compensation, evaluations,
branch transfer, teaching assignments (`class_teacher_skills`), and every
writer/authorization/financial path reaching them.
**Frozen and untouched:** Enrollment (`1567004`) and Class (`91590a0`).

**STATUS: AUDIT COMPLETE — NO CODE FIXED.** Per instruction, remediation is
deferred until each finding has a proven root cause, blast radius, and
regression-test design. All are recorded below.

---

## 0. Method

Evidence-first. Every finding was reproduced live over HTTP on a **fresh
disposable SQLite database** through the real routers with real RBAC, each
paired with a **control** proving the same operation behaves correctly
elsewhere in the codebase. Probe suites were deleted after evidence capture;
no production code was modified during the audit.

---

## 1. Baseline (independently re-verified, not assumed)

| Gate | Result |
|---|---|
| Backend tests | **1387 / 1387** (114 files) |
| Backend lint + typecheck | PASS (0 errors, 108 pre-existing warnings) |
| Fresh-schema preflight | **73 migrations, no drift** |
| Release validation | **16 / 16 PASSED** |
| Git | local == remote (`91590a0`), tree clean, frozen checkpoints intact |

---

## 2. Writer inventory (traced for runtime reachability)

| Writer | Reachable via | Notes |
|---|---|---|
| `stmtInsertTeacher` | `POST /api/teachers` | validates money |
| `stmtUpdateTeacher` | `PUT /api/teachers/:id`, `DELETE` (soft) | **partial validation → T-2** |
| `stmtUpdateTeacherBranch` | `POST /:id/transfer` | + `teacher_branch_history` |
| `stmtDeactivateLinkedTeacherUser` | `DELETE /api/teachers/:id` | |
| `stmtInsertSalaryLedgerWithIdempotency` | `POST /:id/pay-salary` | hardened (040/044/066) |
| `stmtVoidSalaryLedger` | `POST /:id/payroll/:ledgerId/void` | + contra tx + budget refund |
| `stmtInsertCompensationHistory` | `PUT /api/teachers/:id` | |
| `stmtInsertEvaluation` | `POST /:id/evaluation` | **→ T-3** |
| `stmtInsertEmployee` / `stmtUpdateEmployee` | employees CRUD | |
| `stmtSoftDeleteEmployee` | `DELETE /api/employees/:id` | |
| `stmtInsertFinTx` + `stmtUpdateBudgetAmount` | teacher pay, void, **employee pay** | **→ T-1** |
| `stmtInsertSalaryLedger` (non-idempotent) | **NONE — dead writer** | → RR-1 |
| `stmtDeleteClassTeacherSkills` | `DELETE /api/classes/:id` | Class-owned (frozen) |
| `skills.routes.ts` CTS insert/update/delete | assignment engine | in scope, no defect found |

---

## 3. CONFIRMED FINDINGS

### T-1 — CRITICAL — Employee salary payment has no idempotency, no ledger, and no cumulative cap

**Reproduction (fresh DB, all controls included)**
```
3 sequential identical partials, employee base_salary 8000:
  POST /api/employees/:id/pay-salary {monthName:'Asad 1405', amountPaid:1000, partial}
  → [201, 201, 201]   3 expense rows, 3000 AFN paid

6 CONCURRENT identical partials:
  → [201,201,201,201,201,201]  6 expense rows, 6000 AFN, budget -6000

Explicit Idempotency-Key header, sent twice, identical:
  → [201, 201]  2 expense rows      (header is ignored entirely)

10 sequential partials of 5000 against base_salary 5000:
  → 10 accepted, 50,000 AFN paid = 10x the employee's salary

CONTROL (teacher path, same shapes):
  6 concurrent identical  → 1 ledger row, 1 expense row
  10 distinct-key 5000s   → [201, then 9x409] capped at the computed due
```

**Expected** — the same guarantees the teacher path already provides:
server-derived idempotency (`resolveIdempotency`), a durable ledger row, and a
cumulative cap against what is actually owed.

**Actual** — `POST /api/employees/:id/pay-salary`:
1. never calls `resolveIdempotency` and ignores `Idempotency-Key`;
2. writes **only** a raw `financial_transactions` expense — **zero ledger
   rows** (`teacher_salary_ledger` is teacher-only), so an employee payment has
   no period record, no `paid_amount` history, no void path and no audit trail
   of its own;
3. has **no cumulative cap**: nothing compares total paid against
   `base_salary`, so unlimited partials are accepted;
4. its only duplicate guard is `type === 'full'` matched with
   `description LIKE '%full salary%<monthName>%'` — a string match on a
   generated description. Partials and advances are entirely unguarded.

**Root cause** — payroll hardening (migrations 040/044/045/066 and the
`resolveIdempotency` model) was applied to the **teacher** path only. The
employee path is the pre-hardening implementation, still live.

**Blast radius** — every employee salary payment. A double-click, refresh,
network retry or second tab pays a real salary again, bounded only by the
branch budget line. Money leaves the budget and enters the expense ledger with
no ledger row to reconcile against and no void capability.

**Financial impact** — CRITICAL: unbounded duplicate salary expense; budget
depletion; P&L overstatement of salary expense.
**Security impact** — none (authorized roles only).
**Concurrency impact** — CONFIRMED: 6 concurrent → 6 payments.
**Existing coverage** — none.

**Remediation design (NOT applied)** — route the employee payment through the
same `resolveIdempotency` + DB-unique-index model as the teacher path; give
employee payroll a real ledger row (reusing the existing ledger shape or an
employee equivalent) so it is voidable and reconcilable; add a cumulative
period cap; replace the `LIKE` guard with a keyed uniqueness constraint.
Regression tests: sequential duplicates, concurrent burst, explicit-key replay,
cumulative cap, and a legitimate second distinct payment must still succeed.

---

### T-2 — HIGH — `PUT /api/teachers/:id` writes money and score fields with no validation (POST validates them)

**Reproduction**
```
PUT baseSalary: 1e15        → 200, stored 1000000000000000
   GET /:id/computed-salary → due = 1000000000000000   (flows straight into payroll)
PUT defaultSkillRate: 1e15  → 200, stored 1000000000000000
PUT performanceScore: 5000  → 200, silently clamped to 100
PUT performanceScore: -20   → 200, stored 0
PUT targetSkillsPerMonth: -3 / 7.5 → accepted

CONTROL — POST /api/teachers refuses the same values:
  baseSalary -5000 / 1e15 / "abc"        → 400 / 400 / 400
  defaultSkillRate -100 / 1e15           → 400 / 400
```

**Expected** — create and update agree on what a valid salary/rate is.

**Actual** — `PUT` validates `baseSalary` only for negatives and non-numerics;
`1e15` passes and **propagates directly into the payroll due calculation**
(confirmed: `computed-salary` returned 1e15). `defaultSkillRate` accepts `1e15`
on update but is refused on create. `performanceScore` is silently clamped
rather than rejected, so an out-of-range value returns 200 and stores something
the caller never sent.

**Root cause** — identical in shape to Class finding C-3: validation applied at
the creation route instead of at the field boundary, so the update writer never
inherited it. `assertMoney` is imported in this file and simply not used on
these `PUT` paths.

**Blast radius** — any `Teacher.Edit` holder (owner, manager, **finance**).
A corrupted `base_salary` flows into `computeTeacherDueAmount`, the payroll due
figure, budget consumption and the salary expense ledger.

**Financial impact** — HIGH (payroll due is computed from these fields).
**Security impact** — none. **Concurrency impact** — none.
**Existing coverage** — none for `PUT`.

**Remediation design (NOT applied)** — route `baseSalary` and
`defaultSkillRate` through `assertMoney`, `targetSkillsPerMonth` through the
existing `assertSeatCount`-style integer boundary, and **reject** rather than
clamp an out-of-range `performanceScore`, at both writers. Regression tests
mirroring the C-3 suite (garbage refused + nothing stored, legitimate updates
work, omitted fields untouched), plus a payroll-propagation test asserting
`computed-salary` cannot be driven to an absurd value.

---

### T-3 — MEDIUM — Evaluation and employee-payroll input errors surface as HTTP 500

**Reproduction**
```
POST /:id/evaluation {score:'abc'} → 500  SqliteError: NOT NULL constraint failed
POST /:id/evaluation {score:{}}    → 500  (same)
POST /:id/evaluation {score:null}  → 400  (correct)
POST /employees/:id/pay-salary {amountPaid:'abc'}  → 500  NOT NULL constraint failed: budget_lines.current_amount
POST /employees/:id/pay-salary {amountPaid:0.001}  → 500  two-decimal-places trigger
CONTROL — teacher pay-salary: 'abc' → 400, 1e15 → 400
```

**Expected** — malformed client input is 400, not 500. This is the codebase's
own documented standard (`utils/money.ts`: "a malformed amount is INVALID
CLIENT INPUT, not a server fault").

**Actual** — `Number('abc')` → `NaN` reaches SQLite and the DB constraint
throws, leaking a raw `SqliteError` as a 500.

**Root cause** — `Number()` coercion instead of `assertMoney`, so validation is
left to the database.

**Blast radius** — user-correctable mistakes appear as server faults and
pollute error monitoring. **No data corruption**: verified zero residue —
budget delta 0, no expense row, no evaluation row persisted.

**Financial impact** — none (clean rollback verified).
**Security impact** — none. **Concurrency impact** — none.

**Remediation design (NOT applied)** — `assertMoney` on the employee amount and
a numeric guard on evaluation `score`. Regression tests asserting 400 (not 500)
and zero residue.

---

## 4. REJECTED HYPOTHESES (investigated, not defects)

| # | Hypothesis | Evidence |
|---|---|---|
| RH-1 | Teacher payroll is duplicable under concurrency | 6 concurrent identical → **1** ledger row, 1 expense row. Idempotency always applied. **Correct.** |
| RH-2 | Employee budget check is TOCTOU-exploitable | budget 1000, 5×1000 concurrent → `[201,409,409,409,409]`, final budget **0, never negative**. The conditional `UPDATE ... WHERE current_amount >= ?` holds. **Rejected** (duplication is T-1, not overdraft). |
| RH-3 | `LIKE` duplicate guard is wildcard-injectable | `monthName:'%'` returned 409, i.e. it matched *more* than intended and **failed closed**, not open. Sloppy but not exploitable. Folded into T-1. |
| RH-4 | Cross-branch users can act on teachers | branch-B manager: edit/pay/delete/evaluate/employee-pay all **403**, list returns 0. **Correct.** |
| RH-5 | A teacher can self-evaluate or self-raise | teacher role: evaluate **403**, salary raise **403**; score and salary unchanged. **Correct.** |
| RH-6 | Payroll void is unsafe / double-voidable | void → 200, ledger `voided`, contra tx written, budget refunded exactly; second void → **409**. **Correct.** |
| RH-7 | Voiding permanently blocks re-payment of the period | re-pay after void → **201**, exactly 1 posted row (migration 066 excludes voided). **Correct.** |
| RH-8 | Inactive teachers can still be paid | **400** "Cannot pay salary to an inactive teacher." **Correct.** |
| RH-9 | Teacher status accepts arbitrary values | `status:'banana'` → **400**, stored value unchanged. **Correct.** |
| RH-10 | Deactivation ignores active teaching load | blocked **409** listing the active classes/assignments. **Correct.** |
| RH-11 | Transfer accepts a bad/same branch | nonexistent → 4xx; history row written on a valid transfer. **Correct.** |
| RH-12 | Evaluation score bounds unenforced | 101, 1e9, −50 all **400**; 100 accepted. Bounds hold (the *type* gap is T-3). **Correct.** |

---

## 5. PRE-EXISTING RESIDUALS (outside Teacher scope or non-defect)

- **RR-1 — `stmtInsertSalaryLedger` is a dead writer.** The non-idempotent
  ledger insert has **zero call sites**; only the idempotent variant is used.
  Harmless today, but it is exactly the statement a future edit could
  reintroduce. Removal is safe but cosmetic — recorded, not actioned.
- **RR-2 — Teachers have no identity uniqueness.** Two teachers may share the
  same phone and email (confirmed: both 201). Students and visitors have unique
  identity indexes (migrations 072/073); teachers never did. This is a
  **pre-existing design gap, not a regression**, and adding a constraint
  requires a historical-collision inventory plus a business decision on whether
  staff may legitimately share a contact number. Deferred as an insufficient
  business decision.
- **RR-3 — `performanceScore` is caller-writable on `PUT`.** It is also derived
  from evaluations, so two writers exist for one value. Not exploitable across
  a trust boundary (no self-raise; RH-5), but it is a competing-authority smell
  worth converging.

## 6. INSUFFICIENT BUSINESS DECISIONS (not guessed)

1. **Should employee payroll be capped at `base_salary` per period, and should
   employees get a real ledger like teachers?** T-1's *duplication* is
   unambiguously a defect; the correct *cap semantics* (per month? advances
   allowed to exceed?) is a business rule with no precedent in code or tests.
2. **May two teachers share a phone/email?** (RR-2.)

---

## 7. Proposed remediation order (on approval)

1. **T-1** (CRITICAL, financial, concurrency-proven) — idempotency + ledger + cap.
2. **T-2** (HIGH, propagates into payroll) — validate at both writers.
3. **T-3** (MEDIUM, contract hygiene) — 400 instead of 500.

Each with adversarial regression tests and permanent mutants, matching the
Class subsystem's standard (mutant must be proven to SURVIVE before the fix and
be KILLED after).

**Enrollment remains FROZEN at `1567004`; Class remains FROZEN at `91590a0`.**
No production code was modified by this audit.
