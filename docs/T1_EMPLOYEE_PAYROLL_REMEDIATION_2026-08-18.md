# T-1 Remediation — Employee Salary Duplicate Payment

**Date:** 2026-08-18
**Scope:** finding **T-1** from `docs/TEACHER_SUBSYSTEM_AUDIT_2026-08-18.md` only.
**Explicitly out of scope:** T-2 and T-3 (untouched), the Class subsystem, the frozen Enrollment subsystem.
**Status:** remediated, 14/14 mutants killed, all gates green.

---

## 1. Root cause

`POST /api/employees/:id/pay-salary` (`server/src/routes/teachers.routes.ts`) was the **only** employee-salary
write path in the codebase, and it had **no idempotency of any kind**.

Every request unconditionally:
1. read the `employee_salary` budget line,
2. compared the balance in application code,
3. debited the budget with an unconditional `UPDATE`,
4. inserted a raw `financial_transactions` expense row.

Its sole duplicate protection was, for `payment_type = 'full'` only:

```sql
SELECT id FROM financial_transactions
 WHERE reference_id = ? AND category = 'salary'
   AND description LIKE '%full salary%<monthName>%'
```

Three independent defects in that one guard:

| # | Defect | Consequence |
|---|---|---|
| 1 | Matches on a **generated description string** | `'Asad 1405'` and `'1405-05'` are the same month but different strings, so both were paid |
| 2 | Applies to `full` only | `partial` and `advance` had **zero** duplicate protection |
| 3 | Check-then-act **outside** any transaction | Concurrent requests all pass the check together |

The endpoint also wrote **no ledger row at all**. `financial_transactions` was the only trace,
so there was no canonical payroll trail to reconcile against — unlike the teacher path,
which posts to `teacher_salary_ledger`.

### Reproduced live, on a fresh database, before any code was changed

| Scenario | Pre-fix result | Post-fix result |
|---|---|---|
| 3× sequential identical partials (1,000 AFN) | `[201,201,201]` → **3 payments, 3,000 AFN** | `[201,201,201]` → **1 payment, 1,000 AFN** |
| 6× concurrent identical partials | `[201×6]` → **6 payments, 6,000 AFN debited** | `[201×6]` → **1 payment, 1,000 AFN debited** |
| Same explicit `Idempotency-Key` twice | `[201,201]` → **2 payments** (header ignored) | `[201,201]` → **1 payment**, second `replayed: true` |
| Employee payment ledger rows | **0** | **1 per payment** |
| **CONTROL** — teacher path, 6 concurrent | 1 ledger row, 1 tx | unchanged: 1 ledger row, 1 tx |
| **CONTROL** — 4 genuinely distinct payments | 4 payments, 5,500 AFN | **unchanged: 4 payments, 5,500 AFN** |

The teacher control confirms this was an employee-path defect specifically, not a systemic one:
the teacher endpoint was hardened by migrations 040/044 and already behaved correctly.

---

## 2. Design decision — why a new table, not `teacher_salary_ledger`

The instruction was to reuse the existing teacher-payroll authorities. The **mechanisms** were reused
verbatim; the **table** could not be, for a hard structural reason:

```sql
teacher_salary_ledger.teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE
```

An employee id is not a teacher id. Posting employee rows there is not merely undesirable, it is
**impossible without dropping that foreign key**. Worse, the teacher payroll engine
(`core/payroll/class-payroll.ts` → `sumPaidForPeriod`, `hasFullPayForPeriod`) **SUMs that table**
to decide what a *teacher* is still owed. Foreign rows would silently corrupt teacher payroll
arithmetic — turning a duplicate-payment bug into a wrong-salary bug.

`employee_salary_ledger` therefore mirrors the proven teacher shape for the employee domain:
same columns, same semantics, same idempotency contract. One established pattern, two disjoint
populations. Every *authority* is reused:

| Authority | Teacher path | Employee path (new) |
|---|---|---|
| Idempotency derivation | `resolveIdempotency(...)` | **same function**, same shape |
| Race arbiter | `uq_teacher_salary_idempotency` (partial UNIQUE) | `uq_employee_salary_idempotency` |
| Period duplicate guard | `uq_teacher_salary_full_period` | `uq_employee_salary_full_period` |
| Transaction boundary | `BEGIN IMMEDIATE` + replay pre-check | identical |
| Budget debit | guarded `UPDATE … WHERE current_amount >= ?`, `changes !== 1` → 409 | identical |
| Concurrency backstop | `isUniqueViolation(err)` → replay winner | identical |
| Period normalisation | `toPeriodKey(monthName)` | same, with a raw-label fallback |

---

## 3. What was NOT done, deliberately

**No salary-cap semantics were invented.** Whether an employee's cumulative payments for a period
may exceed `base_salary`, and how `advance` interacts with such a cap, has **no precedent anywhere**
in the schema, services, routes, tests or data. The teacher path caps against a *computed due amount*
derived from contract type and skill assignments — machinery employees do not have.

Inventing a cap here could **refuse a legitimate payment**, which is a worse failure than the one
being fixed. It remains an open business decision. A regression test explicitly pins the current
behaviour (repeated distinct partials are *not* capped) so the decision is visible rather than implicit.

**Legitimate partial/advance behaviour is preserved and test-locked**: different amounts, different
months, and an advance in the same month all still succeed.

---

## 4. Exact changes

| File | Change |
|---|---|
| `server/src/db/migrations/075_employee_salary_ledger.sql` | **new** — creates `employee_salary_ledger` + 2 partial UNIQUE indexes + 2 lookup indexes |
| `server/src/db/schema.sql` | same table/index definitions added (fresh installs; drift preflight enforces parity) |
| `server/src/routes/teachers.routes.ts` | employee `pay-salary` rewritten; removed `stmtCheckDuplicateEmployeePay`; added 2 ledger statements |
| `server/src/tests/employee-payroll-idempotency.test.ts` | **new** — 23 regression tests |
| `server/scripts/employee-payroll-mutation-test.mjs` | **new** — 14-mutant harness |

Migration 075 creates a new, initially empty table. It reads, rewrites and deletes **nothing**;
existing employee salary expenses in `financial_transactions` are untouched.
Historical rows predate the ledger and therefore have no ledger counterpart — expected, and
the reconciliation test is scoped to its own branch so it does not falsely flag them.

### Required properties

| Property | How it is satisfied |
|---|---|
| Server-side idempotency | `resolveIdempotency` runs on **every** request, not only when a client sends a header |
| Atomic transaction boundary | `BEGIN IMMEDIATE` … debit + expense + ledger … `COMMIT`, `ROLLBACK` on any failure |
| Canonical ledger path | every payment writes `employee_salary_ledger` linked to its `financial_transactions` row |
| Concurrency safety | guarded conditional debit + partial UNIQUE index as the race arbiter + replay backstop |
| Exact rollback | proven: on failure, budget unchanged, 0 expense rows, 0 ledger rows |
| No shadow writer | the removed string guard was the only alternative path; a test asserts no employee salary expense exists without a ledger row |

---

## 5. Regression tests — 23 tests

| Group | Tests |
|---|---|
| Sequential duplicates | 3 identical → 1 payment; retry reports `replayed: true` with the same `ledgerId` |
| Concurrent duplicates | 6 concurrent → 1 payment / 1 debit; **teacher control** unchanged |
| Explicit `Idempotency-Key` | repeat honoured; reuse across a different **employee** → 409; across a different **period** → 409 |
| Legitimate distinct payments | different amounts / months / advance all succeed (4 payments, 5,500 AFN); partials not capped |
| Full-period guard | second full → **409 with the route's own message**; duplicate caught **across month formats** |
| Failure rollback | insufficient budget → no residue; concurrent exhaustion never negative; inactive → 400; bad amounts → 400 |
| Database race arbiter | duplicate key rejected by the DB; NULL keys still allowed; two posted FULLs rejected; voided frees the slot |
| Atomicity | ledger failure after debit+expense rolls back **all three** |
| Reconciliation | ledger ↔ expense 1:1 and balanced; totals agree with the budget debit; no employee rows in the teacher ledger; no orphan expense |

---

## 6. Mutation testing — 14/14 KILLED, zero survivors

`node server/scripts/employee-payroll-mutation-test.mjs`

| Mutant | Guard disabled | Result |
|---|---|---|
| M1 | idempotency key derivation | KILLED |
| M2 | key persistence | KILLED |
| M3 | replay pre-check | KILLED |
| M4 | replay ownership check (employee/period) | KILLED |
| M5 | `uq_employee_salary_idempotency` → non-unique | KILLED |
| M6 | `uq_employee_salary_full_period` → non-unique | KILLED |
| M7 | conditional budget debit → unconditional | KILLED |
| M8 | insufficient-budget rejection | KILLED |
| M9 | unique-violation backstop | KILLED |
| M10 | ledger row insert | KILLED |
| M11 | atomic transaction boundary | KILLED |
| M12 | period normalisation | KILLED |
| M13 | amount validation | KILLED |
| M14 | inactive-employee rejection | KILLED |

### Three mutants survived the first run. None was waved through.

Per the standing rule, remediation stopped and coverage was strengthened until each was killed —
**no test was ever weakened**.

- **M5 (index → non-unique) SURVIVED.** Cause: `better-sqlite3` is **synchronous**, so HTTP requests
  fired with `Promise.all` never truly interleave inside the route. The service-layer replay check
  absorbs them all and the unique index is **never reached via HTTP**. The index is the only
  protection left if that pre-check is ever bypassed (e.g. a second process), so three tests now
  assert the constraint **directly against the database**. → KILLED.
- **M11 (transaction boundary) SURVIVED — and the mutant itself was wrong.** It committed an *empty*
  transaction and immediately opened another around every write: an **equivalent mutant** that
  changed no behaviour. It was redesigned to commit the debit and expense **before** the ledger
  insert — the real corruption mode — and a test now forces a ledger failure at the last step and
  asserts all three effects roll back together. → KILLED.
- **M9 (unique-violation backstop) SURVIVED.** Cause: the global `errorHandler` **also** maps
  `SQLITE_CONSTRAINT_UNIQUE` to 409, so status code alone cannot distinguish the route's deliberate
  conflict from a raw constraint error leaking out. The test now asserts the route's **own message**.
  → KILLED.
- **M9 was also reported INVALID initially** — its pattern matched twice, because the teacher path
  contains a byte-identical line. Anchoring on the employee-specific lookup fixed the harness.
  (The harness refuses any pattern that does not match exactly once, so a mutation can never
  silently no-op and be scored for the wrong reason.)

---

## 7. Financial reconciliation

For every payment: **1 ledger row ↔ 1 expense row**, equal amounts, `type = 'expense'`,
`category = 'salary'`, `reference_id` = employee id, matching `branch_id`.

Verified on a fresh database: three payments (300 + 450 + 725) plus one retry →
ledger total **1,475** = expense total **1,475** = budget debit **1,475**, with
`COUNT(ledger) == COUNT(expense)` (no orphans on either side).
Rejected attempts contribute **0** to all three. `teacher_salary_ledger` remains free of employee rows.

---

## 8. Gates

| Gate | Result |
|---|---|
| Server tests | **1410/1410** passing (115 files) — was 1387; +23 new, **0 pre-existing tests changed** |
| Server lint | 0 errors (108 pre-existing warnings, unchanged) |
| Server typecheck | clean |
| Fresh-schema drift | **74 migrations, no drift** |
| Frontend lint / build | clean |
| Release validation | 16/16 |
| Mutation testing | 14/14 killed, 0 survivors |

---

## 9. Residuals (unchanged, not in scope)

- **T-2** (HIGH) — `PUT /api/teachers/:id` accepts `baseSalary: 1e15`; POST correctly rejects it. Not touched.
- **T-3** (MEDIUM) — non-numeric evaluation score → 500 instead of 400 (0 rows persisted). Not touched.
- **RR-1** — dead writer `stmtInsertSalaryLedger` (0 call sites).
- **RR-2** — no teacher phone/email uniqueness.
- **RR-3** — `performanceScore` dual-writer.
- **OPEN BUSINESS DECISION** — whether employee cumulative payments per period should be capped
  against `base_salary`, and how `advance` should interact with it. Deliberately not invented here.

## 10. Known limitation

The derived idempotency fingerprint uses `resolveIdempotency`'s **90-second window**. Two *genuinely
intended* identical payments (same employee, month, amount and type) made within 90 seconds by the
same operator collapse into one; the second returns `replayed: true`. This is the exact trade-off
the teacher path already makes, and it is the intended behaviour for a duplicate-payment guard.
A caller that truly needs two identical payments in that window can pass distinct
`Idempotency-Key` headers.
