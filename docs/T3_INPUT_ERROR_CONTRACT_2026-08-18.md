# T-3 Remediation — malformed input returned HTTP 500 instead of 4xx

**Date:** 2026-08-18
**Scope:** finding **T-3** from `docs/TEACHER_SUBSYSTEM_AUDIT_2026-08-18.md` only.
**Explicitly out of scope:** the newly discovered `PUT /api/employees/:id` salary defect (untouched),
Class subsystem, frozen Enrollment subsystem.

---

## 1. The contract

The codebase states its own standard in `server/src/utils/money.ts`:

> "a malformed amount is INVALID CLIENT INPUT, not a server fault. Previously this threw a plain
> Error, so posting an invoice line without unitPrice returned 500 — which hides a user-correctable
> mistake behind an alarming 'server error' and pollutes error monitoring."

So the required contract is: **malformed input ⇒ 4xx with a useful message, never a leaked
`SqliteError`, and never any database or financial residue.** No new business rule is introduced by
this fix; the accepted value ranges are unchanged.

---

## 2. Root cause

Two non-parses:

- **Evaluation:** `if (score == null || score <= 0 || score > 100)` is a **comparison**, not a parse.
  `NaN <= 0` and `NaN > 100` are both `false`, so `Number('abc') → NaN` passed every branch and
  reached SQLite, where `NOT NULL` fired and leaked as a 500.
- **Pay-salary (both):** `Number(amountPaid)` is a **coercion**. `true → 1` and `'0x10' → 16` are
  finite and positive, so they passed the guard and became real payments.

In both cases validation had effectively been delegated to the database.

### Reproduced live on a fresh DB (each with a residue check)

| Site | Input | Before | After |
|---|---|---|---|
| evaluation | `'abc'` / `{}` / `'50abc'` | **500** `NOT NULL constraint failed: teacher_evaluations.score` | **400** |
| evaluation | `true` | **201 — stored score 1** | **400** |
| evaluation | `'0x10'` | **201 — stored 16, response echoed `'0x10'`** | **400** |
| employee pay | `0.001` | **500** (two-decimal DB trigger) | **400** |
| employee pay | `true` | **201 — a real 1 AFN payment** | **400** |
| employee pay | `'0x10'` | **201 — a real 16 AFN payment** | **400** |
| **teacher pay** | `0.001` | **500** | **400** |

Residue was zero in every rejected case, before and after — no evaluation row, no expense row, no
ledger row, budget delta 0. The pre-fix problem was the *status code and the silent coercions*, not
data corruption.

### Findings beyond the audit

1. **The audit's control was wrong.** It recorded teacher pay-salary as correct
   (`'abc' → 400, 1e15 → 400`). It never tested `0.001`, which returned **500** on that path too.
   The fix therefore covers **three** sites, not the two the audit listed.
2. **Silent coercions were not reported at all.** `score: true → 1`, `score: '0x10' → 16`,
   `amountPaid: true → 1 AFN`, `amountPaid: '0x10' → 16 AFN`. These are worse than the 500s: they
   returned success and wrote real data. The evaluation response even echoed the raw `'0x10'` back
   while the stored row held `16`.

---

## 3. Fix — narrowest authoritative layer

No new validator was written and **`money.ts` was not modified**. Both authorities already existed:

| Site | Before | After |
|---|---|---|
| `POST /:id/evaluation` | `score == null \|\| score <= 0 \|\| score > 100` | `assertPerformanceScore(score, 'Evaluation score', { allowZero: false })` |
| `POST /employees/:id/pay-salary` | `Number(x)` + finite/`>0` | `assertMoney(x, 'Payment amount')` then `> 0` |
| `POST /teachers/:id/pay-salary` | `Number(x)` + finite/`>0` | `assertMoney(x, 'Payment amount')` then `> 0` (optional amount preserved) |

`assertPerformanceScore(..., { allowZero: false })` was built during T-2 for exactly this case and
expresses this endpoint's documented rule — *"a positive number between 1 and 100"* — verbatim.
Verified equivalent on the full range: `null/0/-5/101` rejected, `1/50/87.5/100/'75'` accepted.

The parsed score is now what is **persisted, audited and returned** (previously the raw body value
was echoed while the coerced number was stored).

### Why parse-then-`> 0`, and why `assertMoney` was NOT changed

`assertMoney(0.001)` returns `0` — it rounds. That is **established, test-locked behaviour**
(`money-boundary-property.test.ts:103`, `exam-fee-monetary-validation.test.ts:60`, 136 call sites),
so changing it was never an option. Ordering matters:

- pre-fix, `0.001 > 0` passed and the **database** rejected it ⇒ 500;
- post-fix, `assertMoney` rounds it to `0`, which the endpoint's own `> 0` rule refuses ⇒ clean 400.

Any amount ≥ 0.01 is unaffected, and `1234.567` is still accepted and rounded to `1234.57`.

---

## 4. Regression tests — 53 tests

- **Evaluation malformed (11)** — the 10-value non-number matrix plus a missing score: 4xx, no
  evaluation row, `performance_score` unchanged.
- **Evaluation range (4)** — `null / 0 / -5 / 101` still 400.
- **Evaluation criteria (1)** — malformed criteria still 400, no residue.
- **Evaluation accepted (6)** — `1 / 50 / 87.5 / 100 / '75'` plus a full evaluation with criteria and
  notes; the response value and the stored row must agree.
- **Employee pay (14)** — the matrix, sub-cent, precision overflow: 4xx with budget, expense rows and
  ledger rows all unchanged; legitimate `1234.567 → 1234.57` and `2000` still pay.
- **Teacher pay (16)** — the matrix, sub-cent, **zero-value payments**, the optional-amount contract
  (omitting `amountPaid` still pays the full balance), and a legitimate partial.
- **Contract sweep (1)** — drives all three endpoints across the whole matrix and asserts **no**
  response is ≥ 500 and **none** contains `constraint failed` / `SqliteError`.

One test initially failed on `500000 - 498765.43 = 1234.570000000007` — IEEE-754 float subtraction of
two `REAL` columns, not a defect. The budget *delta* now uses `toBeCloseTo`; the stored ledger and
expense values are still asserted exactly.

---

## 5. Mutation testing — 9/9 KILLED, zero survivors

`node server/scripts/teacher-input-contract-mutation-test.mjs [--full]`

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | evaluation parse (restores the raw comparison) | KILLED |
| M2 | `allowZero: false` on the evaluation score | KILLED |
| M5 | response reports the parsed score | KILLED |
| M6 | employee amount parse (restores `Number()`) | KILLED |
| M7 | employee `> 0` rule | KILLED |
| M8 | teacher amount parse (restores `Number()`) | KILLED |
| M9 | teacher `> 0` rule | KILLED |
| M10 | teacher optional-amount contract | KILLED |
| M11 | evaluation criteria guard | KILLED |

### Three mutants survived the first run — all three were investigated, none waved through

- **M9 was a REAL coverage gap and the fix was to STRENGTHEN the tests.** `assertMoney` returns `0`
  for both `0` and `0.001`, so parsing alone does not stop a **zero-amount payment** — only the
  endpoint's `> 0` rule does, and nothing covered it. A zero payment would have posted a ledger row
  and an expense row for no money. Three tests were added (`0`, `'0'`, `0.001`). → KILLED.
- **M3 and M4 were PROVEN equivalent and removed from the harness.** They swapped the persisted
  `numericScore` back to `Number(score)`. By the time those lines run the parse has already
  succeeded, so the input is a number or a plain decimal numeral — and for every such value the two
  expressions are provably identical (`1, 50, 87.5, 100, '75', ' 75 ', '87.50'`). Every input where
  they would differ (`'0x10'`, `true`, `'abc'`) is rejected earlier. The equivalence holds *only*
  because the parse runs first — and M1, which removes that parse, **is** killed. No test can kill
  an equivalent mutant, and writing one would assert a distinction that cannot exist.

---

## 6. Gates

| Gate | Result |
|---|---|
| Server tests | 1508/1508 (117 files) — was 1455; **+53 new, 0 pre-existing tests modified** |
| Server lint | 0 errors (108 pre-existing warnings) |
| Server typecheck / build | clean |
| Frontend lint / typecheck / build | clean |
| Migration/drift | 74 migrations, no drift |
| Release validation | 16/16 |
| Mutation testing | 9/9 killed, 0 survivors |

---

## 7. Residuals (unchanged, not in scope)

- **`PUT /api/employees/:id`** — `baseSalary` written with no validation at all. Discovered during
  T-2; deliberately untouched per instruction. **Recommend a follow-up finding.**
- **RR-1** dead writer `stmtInsertSalaryLedger` (0 call sites).
- **RR-2** no teacher phone/email uniqueness.
- **RR-3** `performanceScore` dual-writer (`PUT` and the evaluation endpoint) — both now validated,
  but the duplication itself remains.
- **Open business decision (T-1)** — whether employee cumulative payments per period should be
  capped against `base_salary`.
- **`targetSkillsPerMonth`** accepts `7.5` and `1e15` on both writers — not a divergence; bounding it
  needs a business decision.
