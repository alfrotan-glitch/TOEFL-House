# Finance Subsystem — Independent Round-2 Audit

**Date:** 2026-08-19
**Baseline:** `59bcc3a` — 1575/1575 tests, 0 lint errors, 74 migrations no drift.
**Method:** the round-1 audit was treated as *evidence, not truth*. Every claim was re-derived from
code, schema, database behaviour and real HTTP on a fresh disposable DB.
**Frozen:** Enrollment, Class, Teacher, Employee — untouched.

---

## 1. Priority 1 — can historical mis-attributed expenses actually exist?

**Answer: NO. No repair migration is justified.**

Round 1 recommended a possible data-repair migration. That recommendation is **withdrawn** on
evidence.

**Step 1 — can the detector produce false positives?** No. `budget_lines.branch_id` and
`expense_requests.branch_id` are written once at INSERT and **never updated** by any writer
(verified by grepping every `UPDATE budget_lines` / `UPDATE expense_requests` statement: they touch
`cost_type`, `is_marketing`, `current_amount`, `allocated_amount`, `status`, `approved_by`,
`reject_reason` — never `branch_id`). A mismatch can therefore only mean genuine mis-attribution.

**Step 2 — is the detector actually sound?** Verified by construction: a synthetic pre-fix row
(request in branch A against a branch-B line) makes the detector fire, and removing it returns 0.

**Step 3 — run it against the real database** (`server/data/erp.sqlite`):

| Check | Result |
|---|---|
| branches | **1** |
| expense_requests | **0** |
| financial_transactions | **0** |
| F-1 mis-attributed expense rows | **0** |
| F-3b request/line branch mismatches | **0** |
| non-numeric amounts (requests / ledger / budget lines) | **0 / 0 / 0** |
| notifications with illegal type `'alert'` | **0** |

The installation has a **single branch**, so cross-branch mis-attribution is not merely absent, it is
**structurally impossible** — both defects require ≥2 branches. Repairing data that cannot exist
would be inventing a rule, so nothing was repaired.

**Step 4 — is the fix still reachable-proof?** Every reachable path was exercised
(`/operational-payments` same-branch and cross-branch, auto-pay and approval-required,
`/expense-requests` + `/decide`) and the detector returned **0** afterwards.

---

## 2. Priority 2 — global-owner cross-branch budget behaviour

**Technically correct. The remaining question is a business decision, not a defect.**

| Question | Evidence |
|---|---|
| Can a non-global role spend another branch's line? | **No** — `finance` and `manager` both get **403** "Budget line belongs to another branch", on both the direct-pay and the approval-required path. |
| Can a global `owner`? | **Yes** — `requireBudgetLine` → `canAccessBranchResource` grants global scope by design. |
| Is the money now correctly attributed? | **Yes** — after round 1, the budget debited, the ledger row and the request row all carry the funding branch. Verified: branch B's line drops, branch B's expense total rises, branch A's is untouched. |
| Does it disturb cash/treasury? | **No** — branch `main_balance` unchanged for both branches (expenses are paid from budget lines, which is the documented invariant). |

**Unresolved business decision (NOT a defect):** *should* a global owner be able to spend another
branch's budget line at all? The system permits it deliberately and now records it correctly. Any
restriction would be new policy and was not invented.

---

## 3. Priority 3 — NEW independently reproduced defects

### F-3 — HIGH — `POST /api/finance/expense-requests` (the sibling endpoint round 1 missed)

Round 1 fixed `/operational-payments` and did not examine its approval-first sibling, which carried
**both** of the same defects.

**F-3a — validated a coercion, then stored the raw value.** The guard was
`!Number.isFinite(Number(amount)) || Number(amount) <= 0`, but the INSERT bound the **raw** `amount`.
Check and write disagreed. Reproduced live:

| Input | Before | After |
|---|---|---|
| `'0x10'` | **201 — persisted as TEXT `'0x10'` in a REAL column** | 400 |
| `[500]` | **201 — persisted as 500** | 400 |
| `true` | **500** — `SQLite3 can only bind numbers, strings, bigints…` | 400 |
| `[[7]]` | **500** (same raw bind error) | 400 |
| `0.001` | **500** — leaked the two-decimal DB trigger | 400 |
| `1e15` | **201 — persisted** | 400 |

A TEXT amount is not inert: `/expense-report` accumulates with `r.totalAmount += er.amount`
(**string concatenation**), the dashboard sums pending value, and `/decide` feeds `request.amount`
straight into `payFromBudgetLine`.

**F-3b — request booked to the actor's branch.** Stored `user.branchId` while the budget line could
belong to another branch. `/decide` checks `budgetLine.branch_id !== request.branch_id` **before**
the approve/reject split, so such a request could be **neither approved nor rejected** — verified
permanently stuck in `pending`. A cross-branch request was creatable but unusable forever.

### F-4 — MEDIUM — rejecting an expense request reports failure on a successful operation

Found while proving F-3b. The reject path called
`addNotification(..., 'alert', ...)`, but `notifications.type` is
`CHECK (type IN ('info','warning','critical','success'))` — **`'alert'` has never been legal**.

The rejection `UPDATE` had **already committed** when the CHECK fired, so the caller received
**400 "Invalid data provided. Please check your inputs."** while the database recorded
`status = 'rejected'`. Response and state disagreed.

Root cause is a **type/schema contract drift**: `NotificationType` in TypeScript declared
`'alert' | 'info' | 'success' | 'warning'` — it both *allowed* a value the DB rejects and *omitted*
`'critical'` which the DB allows. TypeScript green-lit a guaranteed runtime failure. `'alert'` was
the lone outlier among 26 call sites (7 `info`, 15 `success`, 3 `warning`).

---

## 4. Fixes — smallest surface

| File | Change |
|---|---|
| `routes/finance.routes.ts` | `/expense-requests`: `assertMoney` parse + store the parsed value; book to `budgetLine.branch_id`; notification/audit report the parsed amount and the paying branch. Reject path: `'alert'` → `'warning'`. |
| `utils/notifications.ts` | `NotificationType` narrowed to exactly the schema CHECK (`info|warning|critical|success`), with a comment binding the two. Any future `'alert'` is now a **compile error**. |

No schema change, no migration, no data repair, `money.ts` untouched, no frozen subsystem touched,
no new business rule.

---

## 5. Regression tests — 27 tests (`finance-expense-request-integrity.test.ts`)

- **F-3a (16):** 10 non-amounts each 400 with no stored request and no leaked driver/trigger text; a
  storage-class sweep proving no TEXT ever lands in the REAL column; 3 legitimate amounts including
  `100.005 → 100.01`; zero/negative still rejected.
- **F-3b (6):** stores the budget line branch; cross-branch request **approvable** end to end with
  the expense attributed to the funding branch; cross-branch request **rejectable**; a sweep asserting
  no reachable path leaves a request/line branch mismatch; same-branch unaffected;
  **non-global role still 403**.
- **F-4 (4):** rejection answers 200 with `status: 'rejected'` and no "Invalid data provided";
  rejection without a reason; a rejected request cannot be re-decided and never charges the budget;
  a class-level guard asserting all four legal notification types insert and `'alert'` throws.
- **Reconciliation (1):** budget drained == expense booked per branch across the request lifecycle,
  with rejected inputs contributing nothing.

---

## 6. Mutation testing — 8/8 KILLED, zero survivors

`node server/scripts/finance-expense-request-mutation-test.mjs [--full]`

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | `assertMoney` parse (restores validate-one/store-another) | KILLED |
| M2 | parsed amount stored (restores raw `amount`) | KILLED |
| M3 | positive-amount rule on the parsed value | KILLED |
| M4 | `requestBranchId` prefers the budget line branch | KILLED |
| M5 | `requestBranchId` actually used in the INSERT | KILLED |
| M6 | rejection notification type is schema-legal | KILLED |
| M7 | `NotificationType` ↔ schema CHECK lockstep (paired with the schema) | KILLED |
| M8 | `requireBudgetLine` branch isolation guard | KILLED |

**M3 was initially INVALID** — after round 1, `/operational-payments` contains a byte-identical
line. Anchored on this endpoint's distinct error message. The harness refuses any pattern that does
not match exactly once, so a mutation can never silently no-op.

The round-1 harness (F-1/F-2, 7 mutants) was re-run unchanged to prove no regression.

---

## 7. Verdict

### Proven defects — CLOSED
- **F-3a** raw amount stored on `/expense-requests` (TEXT in a REAL column, 500s).
- **F-3b** request booked to the actor's branch → permanently un-decidable cross-branch requests.
- **F-4** expense rejection returned 400 on a committed, successful rejection.

### False positives — disproven, not reported as defects
- `POST /budget-lines/:id/charge` amount handling — `!amount` already rejects the coercion cases.
- Expenses not reducing branch cash — documented, intentional invariant.
- Non-global cross-branch spending — correctly 403.
- **Reconciliation `healthy: false`** — observed in a probe, traced to *my own synthetic legacy rows*
  in that probe; a pristine branch and both real branches report `healthy: true`, all variances 0.
- `bos.routes.ts` profit withdrawal — uses `branchId` consistently and debits cash correctly.

### Business decisions — unresolved, deliberately not invented
1. Should a global owner be able to spend **another branch's** budget line at all?
2. Should operational payments be idempotent? (identical utility bills are legitimately repeatable)
3. Employee salary cap (T-1); `targetSkillsPerMonth` bounds.

### Historical-data risks — measured, none actionable
- **No corruption exists.** The real DB has 1 branch, 0 expense rows, 0 non-numeric amounts, 0
  mis-attributions, 0 illegal notification types. Both branch defects are structurally impossible
  with a single branch. **The round-1 repair-migration recommendation is withdrawn.**
- If this code ever ran multi-branch elsewhere, the detection queries in §1 identify affected rows;
  repair would still require owner authorization.

### Verified-safe areas (re-checked this round)
`recordIncome` (income + savings sweep + reversal reclaim), `financeAccounts` balance helpers,
treasury deposit, budget-line charge, `payFromBudgetLine` guarded debit, `/decide` dual control and
branch check, reconciliation cash/saving/budget variances, expense-report and P&L branch scoping,
BOS profit-withdrawal guards, RBAC on every mutating finance endpoint.

**Finance is NOT yet declared FROZEN** — see the freeze criteria in the final report section.
