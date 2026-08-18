# Finance Subsystem — Forensic Audit & Remediation

**Date:** 2026-08-19
**Scope:** Finance subsystem only. Enrollment, Class, Teacher and Employee treated as frozen.
**Baseline:** `6835816` — 1549/1549 tests, 0 lint errors, 74 migrations no drift.

---

## 1. Financial architecture — authorities established

Every financial truth was traced to its authoritative writer before any hypothesis was formed.

| Truth | Authority | Notes |
|---|---|---|
| Income + savings sweep | `utils/income.ts` → `recordIncome()` | Refuses to run outside a transaction; writes ledger, credits main, sweeps `daily_saving_percent`; a negative amount reclaims from savings. **10 callers, no bypass found.** |
| Cash position | `utils/financeAccounts.ts` | `increment/decrement*IfSufficient`. Only 2 non-test files touch it directly (`finance.routes`, `bos.routes`), both legitimately. |
| Expense from budget | `payFromBudgetLine()` (`finance.routes.ts:160`) | Guarded conditional debit + ledger row. 2 callers. |
| Treasury | `POST /finance/treasury/deposit` | **Model authority:** `assertMoney` + explicit `> 0`. |
| Money parsing | `utils/money.ts` → `assertMoney` | 136 call sites. |
| Reconciliation | `utils/reconciliation.ts` | Checks cash position, not just payments↔ledger. |

**No shadow writer was found for income or cash.** Raw `INSERT INTO financial_transactions` exists in
`finance.routes.ts`, `bos.routes.ts` and `teachers.routes.ts`, but each is an *expense/transfer* row
paired with its own balance movement — not an income bypass.

### Verified NOT defects (recorded so they are not re-reported)

- **Expenses do not reduce branch cash.** Deliberate and documented: expenses are paid *from budget
  lines*, which were funded from the org treasury. `cash-position-reconciliation.test.ts` states the
  invariant and notes an earlier draft that subtracted expenses reported a false −69,500 variance.
- **Non-global roles cannot spend another branch's budget line.** `finance`/`manager` → **403**
  ("Budget line belongs to another branch"). Only a global `owner` crosses branches — intended RBAC.
- **`POST /budget-lines/:id/charge` amount handling is safe.** `!amount || amount <= 0` rejects
  `true`, `[500]`, `'0x10'`, `[[7]]`; `assertMoney` inside the balance helper catches the rest.
  Probed and confirmed — **not** the same defect class as `/operational-payments`.
- **Duplicate operational payments are not collapsed.** 3 sequential + 5 parallel identical payments
  all posted (2,250 AFN). Unlike payroll, an operational expense has no natural idempotency key and
  two identical utility bills are legitimate. **Business decision, not a defect** — see §7.

---

## 2. CONFIRMED FINDINGS

### F-1 — HIGH — operational payment books the expense to the wrong branch

`POST /api/finance/operational-payments` debited the **budget line's** branch but wrote the
`expense_requests` row and the `financial_transactions` row with **`user.branchId`**.

**Reproduced live on a fresh DB** (global owner in branch A spends branch B's line):

```
B budget 5000 -> 3800          (1,200 AFN left branch B)
ledger row    -> branch_id = A  (branch A carries the expense)
branch expense totals: A = 1200, B = 0
```

**The intended invariant was derived, not invented.** The sibling caller of the same helper,
`POST /expense-requests/:id/decide`, already enforces it:

```js
if (budgetLine.branch_id !== request.branch_id) throw new HttpError(409, '...different branches.');
payFromBudgetLine({ ..., branchId: budgetLine.branch_id || user.branchId });
```

Two callers of one authority, two different rules — the classic shape of every finding in this
codebase's audit history.

**Second-order effect:** a *pending* cross-branch request was stored with the actor's branch, so
`/decide` later refused it with its own 409 — a payment that could be created but never approved.

**Blast radius:** branch-scoped expense totals feed `/finance/overview`, `/finance/dashboard`,
`reports` P&L (`type='expense'` grouped by branch) and BOS break-even/teacher-cost KPIs.

### F-2 — HIGH — operational payment amount is coerced, not parsed

`Number(amount)` accepted values that are not amounts. **Reproduced live**, each moving real money:

| Input | Before | After |
|---|---|---|
| `true` | **201 — 1 AFN paid** | 400 |
| `[500]` | **201 — 500 AFN paid** | 400 |
| `'0x10'` | **201 — 16 AFN paid** | 400 |
| `[[7]]` | **201 — 7 AFN paid** | 400 |
| `['12']` | **201 — 12 AFN paid** | 400 |
| `0.001` | **500** (leaked two-decimal DB trigger) | 400 |
| `1e15` | 409 (masked as "insufficient budget") | 400 |

`requireApproval: true` stored a **1 AFN pending request** from `amount: true`.

---

## 3. Fix — smallest evidence-backed change

One file, `server/src/routes/finance.routes.ts`. No schema change, no migration, no new validator,
`money.ts` untouched, no frozen subsystem touched.

- **F-2:** `assertMoney(amount, 'Expense amount')` — the boundary `/treasury/deposit` on this same
  router already uses — with the endpoint's existing `> 0` rule applied to the **parsed** value.
  Ordering matters: `0.001` rounds to `0` and is refused cleanly instead of reaching the DB trigger.
  Any amount ≥ 0.01 behaves exactly as before.
- **F-1:** `const expenseBranchId = budgetLine.branch_id || user.branchId;` used for the ledger row
  and for **both** the pending and approved `expense_requests` rows — matching `/decide` exactly.

---

## 4. Regression tests — 26 tests (`finance-operational-payment-integrity.test.ts`)

- **F-1 (5):** cross-branch payment books to the funding branch and the budget drained equals the
  expense recorded; pending request carries the budget line branch; a cross-branch pending request
  can now be approved and paid end to end; same-branch unaffected; **non-global roles still 403**.
- **F-2 (14):** 9 non-amounts each 400 with no budget movement, no expense row, no request row, and
  no leaked DB text; coerced amount on the approval path; zero/negative/negative-string; precision
  overflow; 4 legitimate amounts including `100.005 → 100.01`; overspend still 409.
- **Concurrency (1):** 5 concurrent 1,000 AFN payments against a 1,000 balance → exactly 1 paid,
  balance 0, never negative, exactly 1 ledger row.
- **Reconciliation (1):** across a mixed run of valid and rejected payments, budget drained per
  branch == expense recorded per branch.

---

## 5. Mutation testing — 7/7 KILLED, zero survivors (full-suite run)

`node server/scripts/finance-operational-payment-mutation-test.mjs [--full]`

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | `assertMoney` parse (restores `Number()`) | KILLED |
| M2 | positive-amount rule on the parsed value | KILLED |
| M3 | ledger row booked to budget line branch | KILLED |
| M4 | approved request booked to budget line branch | KILLED |
| M5 | pending request booked to budget line branch | KILLED |
| M6 | `expenseBranchId` prefers budget line branch | KILLED |
| M7 | `requireBudgetLine` branch isolation guard | KILLED |

**M7 was initially INVALID** (pattern matched twice — `/expense-requests` has a byte-identical
line). Anchored on the preceding parse. The harness refuses any pattern not matching exactly once,
so a mutation can never silently no-op.

**M8 removed as a PROVEN equivalent mutant.** It made `payFromBudgetLine`'s debit unconditional and
survived. The cause is structural, not a coverage gap: `better-sqlite3` is **synchronous**, so
`Promise.all` requests still execute one at a time and the application-level pre-check always sees
the true balance. Verified by replaying the mutated sequence directly — 5 serialized 1,000 AFN
attempts against a 1,000 balance with an *unconditional* debit still yields `paid=1, balance=0`,
identical to the guarded version. The guard is **kept in the source** as the only protection if the
API is ever run in multiple processes; it is defence in depth, not a mutation target here.

---

## 6. Gates

| Gate | Result |
|---|---|
| Server tests | **1575/1575** (119 files) — was 1549; **+26 new, 0 pre-existing tests modified** |
| Server lint / typecheck / build | 0 errors (108 pre-existing warnings) · clean · clean |
| Frontend lint / typecheck / build | 0 errors (6 pre-existing warnings) · clean · clean |
| Migration / drift | 74 migrations, no drift |
| Release validation | 16/16 |
| Mutation testing | 7/7 killed, 0 survivors |

---

## 7. Remaining financial risks & business decisions (NOT defects)

1. **No idempotency on operational payments.** 3 sequential + 5 parallel identical payments all
   posted. Unlike payroll (which has a natural employee+period key), two identical utility bills on
   one day are legitimate. Adding an idempotency window here could **refuse a real second payment**.
   *Business decision:* should operational payments collapse duplicates within a short window, or
   require an explicit client `Idempotency-Key`?
2. **Historical mis-attributed expenses are not repaired.** F-1 stopped new misattribution; expense
   rows already written to the actor's branch remain. Detection query:
   `SELECT ft.id FROM financial_transactions ft JOIN expense_requests er ON er.id = ft.reference_id
    JOIN budget_lines bl ON bl.id = er.budget_line_id WHERE ft.branch_id <> bl.branch_id;`
   A data-repair migration on live financial records is an owner decision.
3. **Cross-branch spending by a global owner is permitted by design** — now correctly attributed,
   but whether an owner *should* spend another branch's budget line remains a policy question.
4. **Employee salary cap (T-1)** — still open; no precedent to derive from.
5. **`targetSkillsPerMonth`** accepts `7.5`/`1e15` on both teacher writers — needs a bound decision.
6. **RR-1** dead writer `stmtInsertSalaryLedger`; **RR-2** no teacher phone/email uniqueness;
   **RR-3** `performanceScore` dual-writer.
7. **Pre-existing corrupt employee salary rows** — none in this repo; repair is an owner decision.

## 8. Areas mapped and found sound (no findings)

`recordIncome` savings sweep and reversal-reclaim path; `finance_accounts` balance helpers;
treasury deposit; budget-line charge; `/decide` dual-control (requester ≠ approver, enforced);
reconciliation cash-variance check; ledger classification; refund/void contra rows; period-boundary
report queries; RBAC on all mutating finance endpoints (view-only roles are 403 on money movement).
