# T-2 Remediation — `PUT /api/teachers/:id` money & score validation

**Date:** 2026-08-18
**Scope:** finding **T-2** from `docs/TEACHER_SUBSYSTEM_AUDIT_2026-08-18.md` only.
**Explicitly out of scope:** T-3 (not started), Class subsystem, frozen Enrollment subsystem.

---

## 1. Root cause

`POST /api/teachers` routes money through `assertMoney` (a parse with type discipline, two-decimal
rounding and a safe-integer-cents ceiling). `PUT /api/teachers/:id` validated the same fields with
`!Number.isFinite(Number(x)) || Number(x) < 0` — a **coercion, not a parse** — and clamped the
performance score with `Math.max(0, Math.min(100, Number(x)))`.

Same field, same table, two different definitions of "valid". This is the C-3 shape: validation
attached to the creation route instead of to the field boundary, so the update writer never
inherited it. `assertMoney` was already imported in the file and simply not used on these paths.

### Reproduced live on a fresh DB, each PUT paired with its POST control

| Input | PUT before | POST control | Verdict |
|---|---|---|---|
| `baseSalary: 1e15` | **200**, stored | 400 | divergence |
| `baseSalary: ''` | **200 → stored 0** | 400 | **worse than reported** |
| `baseSalary: true` | **200 → stored 1** | 400 | **not in the audit** |
| `baseSalary: [5]` | **200 → stored 5** | 400 | **not in the audit** |
| `baseSalary: '0x10'` | **200 → stored 16** | 400 | **not in the audit** |
| `defaultSkillRate: 1e15` / `true` | **200**, stored | 400 | divergence |
| `performanceScore: 5000` | **200**, silently clamped to 100 | — | clamp, not validation |
| `performanceScore: -20` | **200**, silently clamped to 0 | — | clamp, not validation |
| `performanceScore: 'abc'` | **500** (NaN reached the DB) | — | wrong status |
| `baseSalary: -5000` / `'abc'` | 400 | 400 | already correct |

The coercion cases are the most dangerous and were **not** in the audit: a blank form field became a
**zero salary**, and `true` became a salary of 1 AFN — each returning 200 as if accepted.

**Confirmed payroll propagation:** after `PUT baseSalary: 1e15`, `GET /:id/computed-salary`
returned `due = 1000000000000000`, which flows into budget consumption and the salary expense ledger.

### One audit claim REFUTED

The audit listed `targetSkillsPerMonth: -3` and `7.5` as accepted by PUT. Live reproduction shows:

| Input | PUT | POST | Reality |
|---|---|---|---|
| `-3` | **400** | 400 | audit wrong — already rejected |
| `'abc'` | **400** | 400 | audit wrong — already rejected |
| `7.5` | 200 (rounds to 8) | **201** | **no divergence** — both accept |
| `1e15` | 200 | **201** | **no divergence** — both accept |

There is no create/update disagreement to close. Hardening it would mean choosing a new upper bound
for a workload target — **inventing a business rule** — so it was deliberately left alone and the
current agreed behaviour is pinned by a test. This is recorded rather than silently skipped.

---

## 2. Blast radius (established before editing)

`stmtUpdateTeacher` has exactly **three** call sites:

| Line | Caller | Status |
|---|---|---|
| 262 | `PUT /api/teachers/:id` | **the defect — fixed** |
| 319 | `DELETE` (soft delete) | passes the row's own existing values; unaffected |
| 361 | `POST /:id/evaluation` | already validates `score`; unchanged (T-3 territory) |

No other writer touches `base_salary`, `default_skill_rate` or `performance_score`
(`stmtUpdateTeacherBranch` writes only `branch_id`). Frontend `editTeacher` sends
`baseSalary` as a number and never sends `performanceScore`, so no client behaviour changes.
Existing PUT tests (`teacher-history-integrity`, `teacher-skill-contract-forensic`) send
`baseSalary: 35000 / 24000 / 30000` — all still valid.

---

## 3. Exact changes

| File | Change |
|---|---|
| `server/src/utils/money.ts` | **added** `assertPerformanceScore(value, field, { allowZero })` — 0..100, same type discipline as `assertMoney` |
| `server/src/routes/teachers.routes.ts` | PUT now routes `baseSalary` and `defaultSkillRate` through `assertMoney`, and `performanceScore` through `assertPerformanceScore` (reject, not clamp) |
| `server/src/tests/teacher-update-validation.test.ts` | **new** — 45 adversarial regression tests |
| `server/scripts/teacher-update-mutation-test.mjs` | **new** — 13-mutant harness |

No schema change, no migration: this is input validation only.

**Score range 0..100 is derived, not invented.** 100 is the existing evaluation scale
(`POST /:id/evaluation` enforces `score <= 100`). Zero is the established "not yet evaluated"
sentinel — `POST /api/teachers` hardcodes `performance_score = 0` for every new teacher precisely so
no half-appraisal is fabricated — so zero is accepted. The `allowZero: false` option expresses the
stricter rule an evaluation *event* needs; the evaluation endpoint itself is untouched (T-3).

---

## 4. Regression tests — 45 tests

- **`baseSalary` parity (10 tests)** — each non-amount asserted rejected on PUT *and* on POST, with the row proven byte-identical afterwards and no compensation-history row written.
- **`defaultSkillRate` parity (10 tests)** — same matrix.
- **`performanceScore` (9 tests)** — above 100, negative, non-numeric, boolean/array/object/empty-string all rejected; the full legitimate range `0, 1, 50, 87.5, 99.99, 100` accepted (`performance_score` is `REAL`, so fractions are legal).
- **Boundary units (3 tests)** — `assertMoney` / `assertPerformanceScore` reject `Infinity`, `-Infinity`, `NaN` directly, plus the 0..100 range and the `allowZero` contract.
- **Payroll propagation (1)** — `computed-salary` cannot be driven to an absurd figure via PUT.
- **Preserved behaviour (7)** — normal raise + history row; numeric strings; two-decimal rounding; zero salary/rate legal; omitted fields untouched and no spurious history; `defaultSkillRate` change; `targetSkillsPerMonth` unchanged.
- **Atomicity (2)** — a rejected multi-field update writes **no** field.

### A test bug I found and fixed honestly

Three tests initially failed asserting `Infinity` is rejected over HTTP. Investigation showed
**the test was wrong, not the code**: JSON has no `Infinity` literal, so `JSON.stringify` turns it
into `null`, which this route correctly reads as "field omitted" and answers 200. The transmissible
string `"Infinity"` is now used for the HTTP path, and the numeric form is asserted directly against
the boundary functions. No assertion was weakened to get green.

---

## 5. Mutation testing — 13/13 KILLED, zero survivors

`node server/scripts/teacher-update-mutation-test.mjs [--full]`

Mutants target **both** layers, because a route-only harness would miss a weakened boundary and a
boundary-only harness would miss a PUT that stopped calling it.

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | PUT → `assertMoney` for `baseSalary` (restores the exact pre-fix coercion) | KILLED |
| M2 | PUT → `assertMoney` for `defaultSkillRate` | KILLED |
| M3 | PUT rejects score (restores the silent clamp) | KILLED |
| M4 | `assertMoney` safe-integer-cents ceiling | KILLED |
| M5 | `assertMoney` type rejection | KILLED |
| M6 | `assertMoney` decimal-numeral parse | KILLED |
| M7 | `assertMoney` negative rejection | KILLED |
| M9 | `assertPerformanceScore` upper bound | KILLED |
| M10 | `assertPerformanceScore` negative rejection | KILLED |
| M11 | `assertPerformanceScore` type rejection | KILLED |
| M12 | `assertPerformanceScore` numeral parse | KILLED |
| M13 | `assertPerformanceScore` `allowZero:false` | KILLED |
| M14 | `assertMoney` two-decimal rounding | KILLED |

### M8 — removed as a PROVEN equivalent mutant (not waved through)

M8 disabled `assertMoney`'s `Number.isFinite` check and survived. Rather than assume or invent a
test, the mutated function was rebuilt by hand and executed against all three non-finite values:

```
Infinity  -> Math.round(Infinity*100) is not a safe integer -> still 400 (precision ceiling)
-Infinity -> caught earlier by the negative check           -> still 400
NaN       -> Math.round(NaN) is not a safe integer          -> still 400 (precision ceiling)
```

Behaviour is **identical with and without the check**, so no test can kill it and any test claiming
to would be theatre. The check is retained in the source — it is the clearest expression of intent
and guards the contract for `allowNegative: true` callers — but it is defence in depth, not a
load-bearing guard, so it is not a valid mutation target. The finiteness contract is still asserted
directly by the suite.

---

## 6. Gates

| Gate | Result |
|---|---|
| Server tests | 1455/1455 (116 files) — was 1410; **+45 new, 0 pre-existing tests modified** |
| Server lint | 0 errors (108 pre-existing warnings) |
| Server typecheck / build | clean |
| Frontend lint / typecheck / build | clean |
| Migration/drift | 74 migrations, no drift |
| Release validation | 16/16 |
| Mutation testing | 13/13 killed, 0 survivors |

---

## 7. Residuals — reported, NOT fixed (outside T-2)

- **`PUT /api/employees/:id` has the identical defect.** Found while establishing blast radius:
  `stmtUpdateEmployee.run(..., baseSalary ?? existing.base_salary, ...)` with **no validation at
  all**, so `1e15`, `''`, `true` and `[5]` are all storable on an employee salary. It is a separate
  writer from T-2 (employees, not teachers) and was not in the audit's T-2 scope, so it was
  deliberately left untouched. **Recommend a follow-up finding.**
- **T-3** (MEDIUM) — evaluation/employee-payroll input errors surface as 500. Not started.
- **RR-1** dead writer `stmtInsertSalaryLedger`; **RR-2** no teacher phone/email uniqueness;
  **RR-3** `performanceScore` dual-writer (PUT and the evaluation endpoint both write it — now
  validated on both paths, but the duplication itself remains).
- **`targetSkillsPerMonth`** accepts `7.5` (rounds to 8) and `1e15` on **both** writers. Not a
  divergence; bounding it requires a business decision.
