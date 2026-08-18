# Remediation — `PUT /api/employees/:id` salary validation

**Date:** 2026-08-18
**Scope:** the employee salary writers only (`PUT` and `POST /api/employees`).
**Out of scope and untouched:** Enrollment (frozen), Class, Teacher findings T-1/T-2/T-3 (all closed).

---

## 1. Root cause

`PUT /api/employees/:id` bound the raw request value straight into a `REAL NOT NULL` column:

```js
stmtUpdateEmployee.run(..., baseSalary ?? existing.base_salary, ...);
```

There was **no validation of any kind** — not even a `Number()` coercion. `POST /api/employees`
checked only `baseSalary == null` and was equally unvalidated. Neither writer used `assertMoney`,
the boundary the teacher writers already use for the same field.

### Why the `REAL` column did not save us

The decisive point, proven directly against `better-sqlite3`: SQLite type affinity converts text
that *looks* numeric, but **stores non-numeric text verbatim** rather than rejecting it.

```
INSERT INTO t(s REAL) VALUES ('abc'), ('50abc'), (''), (1000)
  -> typeof(s) = text, text, text, real
  -> SUM(s)    = 1050
```

So `'abc'` and `''` persist as TEXT and contribute `0` to payroll totals, while `'50abc'` silently
contributes `50`. A branch payroll total therefore comes out **wrong in a way no constraint, error
or log ever reveals**. This is corruption of financial data, not merely a bad status code.

---

## 2. Evidence — reproduced live on a fresh DB before any code change

Each case paired with both controls:

| Value | PUT (employee) | POST (employee) | POST (teacher) — control |
|---|---|---|---|
| `1e15` | **200, stored 1000000000000000** | 201 | 400 |
| `-5000` | **200, stored −5000** (negative salary) | 201 | 400 |
| `'abc'` | **200, stored TEXT `'abc'`** | 201 | 400 |
| `''` | **200, stored TEXT `''`** | 201 | 400 |
| `'   '` | **200, stored TEXT `'   '`** | 201 | 400 |
| `'0x10'` | **200, stored TEXT `'0x10'`** | 201 | 400 |
| `'50abc'` | **200, stored TEXT `'50abc'`** | 201 | 400 |
| `[5]` | **200, stored 5** | 201 | 400 |
| `true` / `false` / `{}` | **500** (raw SQLite bind error leaked) | 500 | 400 |
| `null` | 200, unchanged (correct) | 400 | 400 |

Downstream confirmation: `GET /api/employees` returned `baseSalary: "abc"` as a **string** through
`mapEmployee` (which is typed `number`), straight into the UI's `formatAFN`.

**A misleading first reading, corrected.** An early probe appeared to show legitimate updates
storing `0`. Re-running each value against its own fresh employee proved that false — it was an
artefact of reusing one employee across a sequence, where the final `baseSalary: 0` case won. This
is why every case in the final suite uses an isolated fixture.

---

## 3. Blast radius (established before editing)

- **Writers of `employees.base_salary`:** exactly two — `stmtInsertEmployee` (POST) and
  `stmtUpdateEmployee` (PUT). `stmtUpdateEmployeeBranch` touches only `branch_id`.
  Both writers were unvalidated, so fixing PUT alone would have left the hole open.
- **Readers:** `mapEmployee` (passes the raw value through, typed `number`), `GET /api/employees`,
  and any `SUM(base_salary)` aggregate.
- **Callers:** any `Employee.Edit` holder.
- **Existing tests:** one test posts an employee (`baseSalary: 8000`) — unaffected.
- **Frontend:** `EmployeeDirectoryPanel`, `TeachersModals` render `formatAFN(emp.baseSalary)`; no
  client sends non-numeric values, so no client behaviour changes.

---

## 4. Fix — smallest evidence-backed change

No new validator, no schema change, no migration, `money.ts` untouched.

| File | Change |
|---|---|
| `server/src/routes/teachers.routes.ts` | `POST /api/employees` → `assertMoney(baseSalary, 'Base salary')`, insert the parsed value; `PUT /api/employees/:id` → `baseSalary != null ? assertMoney(...) : Number(existing.base_salary)`, write the parsed value |
| `server/src/tests/employee-salary-validation.test.ts` | **new** — 41 adversarial regression tests |
| `server/scripts/employee-salary-mutation-test.mjs` | **new** — 7-mutant harness |

`assertMoney` is the same authority used by teacher create/update and every other money path
(136 call sites). **No business rule was invented**: the accepted range is exactly what the rest of
the codebase already enforces. The pre-existing contract "omitting `baseSalary` leaves it unchanged"
is preserved and test-locked.

---

## 5. Regression tests — 41 tests

- **Storage-layer proof (1)** — demonstrates in-memory that a `REAL` column stores TEXT verbatim and
  that `SUM` yields `1050`, documenting *why* route validation is mandatory.
- **PUT rejection (11)** — every non-amount returns 400; all three writers agree; the row is
  byte-identical afterwards; no leaked SQLite text.
- **Storage-class integrity (1)** — after the full barrage, `typeof(base_salary)` is still `real`.
- **Aggregate integrity (1)** — `SUM` over the branch is still exact after 22 rejected updates.
- **POST rejection (12)** — every non-amount returns 400 and creates no employee; missing salary
  keeps its required-fields message.
- **Legitimate values (10)** — `35000`, `'24000.50'`, `12345.67`, `1.005 → 1.01`, `0` on PUT and
  POST, each asserting the **stored** value and its storage class; omitted and explicit-`null`
  salaries unchanged; multi-field updates; invalid status still rejected at the route.
- **Atomicity (1)** — an invalid salary writes no other field.
- **Payroll safety (1)** — a rejected update leaves a payable numeric salary.

---

## 6. Mutation testing — 7/7 KILLED, zero survivors

`node server/scripts/employee-salary-mutation-test.mjs [--full]`

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | PUT `assertMoney` (restores the unvalidated writer) | KILLED |
| M2 | PUT writes the parsed value | KILLED |
| M3 | PUT "omitted means unchanged" | KILLED |
| M4 | POST `assertMoney` | KILLED |
| M5 | POST inserts the parsed value | KILLED |
| M6 | POST required-field check | KILLED |
| M7 | PUT status enum guard | KILLED |

### Three mutants survived the first run — all three were real gaps, and the TESTS were strengthened

No implementation was weakened and no mutant was dismissed without proof.

- **M5** — my POST tests asserted only the HTTP response. A numeric string serialises identically
  whether the raw or parsed value was inserted, so the response could not reveal that TEXT had
  reached the column. Tests now assert the **stored value and `typeof(base_salary)`**.
- **M6** — removing the explicit `baseSalary == null` check still yields 400, because `assertMoney`
  rejects `undefined`. Status alone could not distinguish "missing" from "malformed"; the test now
  asserts the required-fields **message** for `{}`, `null` and `undefined`.
- **M7** — `employees.status` also carries a schema `CHECK`, so deleting the route guard still
  fails, but as a leaked constraint error instead of a clean 400. The test now asserts the route's
  own message and that no `CHECK constraint` text leaks.

---

## 7. Gates

| Gate | Result |
|---|---|
| Server tests | 1549/1549 (118 files) — was 1508; **+41 new, 0 pre-existing tests modified** |
| Server lint | 0 errors (108 pre-existing warnings) |
| Server typecheck / build | clean |
| Frontend lint / typecheck / build | clean |
| Migration/drift | 74 migrations, no drift |
| Release validation | 16/16 |
| Mutation testing | 7/7 killed, 0 survivors (full-suite run) |

---

## 8. Residuals (not in scope, unchanged)

- **Pre-existing corrupt rows.** This fix stops new corruption; it does **not** repair employees
  whose `base_salary` is already TEXT or negative from before. No such rows exist in this repo's
  fixtures, and a data-repair migration on live financial records is a decision for the owner, not
  something to infer. **Recommend a follow-up audit** if the defect reached production.
- **`mapEmployee` types `baseSalary` as `number` but does not coerce.** Now unreachable via the API
  since both writers validate, but the type assertion remains unenforced at that layer.
- **RR-1** dead writer `stmtInsertSalaryLedger`; **RR-2** no teacher phone/email uniqueness;
  **RR-3** `performanceScore` dual-writer.
- **Open business decision (T-1)** — whether employee cumulative payments per period should be
  capped against `base_salary`.
- **`targetSkillsPerMonth`** accepts `7.5` and `1e15` on both teacher writers — not a divergence;
  bounding it needs a business decision.
