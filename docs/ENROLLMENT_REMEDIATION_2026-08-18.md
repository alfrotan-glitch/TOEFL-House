# ENROLLMENT REMEDIATION REPORT

**Date:** 2026-08-18 · **Branch:** `arena/01a0062e-toefl-house`
**Audit baseline:** `d746150` (`docs/ENROLLMENT_SUBSYSTEM_AUDIT_2026-08-18.md`, verdict CONDITIONAL GO)
**Scope:** E-1 … E-4 only. No accessibility, GL-1/GL-2, UX-14, closed Student findings, or unrelated subsystems were touched.

---

## Verdict: **GO**

All four findings are fixed at the domain layer, every original exploit now fails, all nine required mutants are killed, concurrency and financial invariants hold under live load, and every regression gate is green with no test weakened.

One item is disclosed rather than hidden: a first draft of the E-2 constraint was **wrong**, and the existing suite caught it. Details in the E-2 section — it materially changed the fix.

---

## Findings

### E-1 — CRITICAL — transfer acted as an unguarded enrollment CREATE

| | |
|---|---|
| **Before** | `transfer()` treated the source enrollment as optional (`if (active)`) while running the destination INSERT unconditionally. It resurrected terminal enrollments, enrolled students with no enrollment at all, and consulted neither the placement gate nor the lifecycle state machine. |
| **After** | A transfer requires an **active** source enrollment. The source→`transferred` move is validated through `assertEnrollmentTransition` (the existing lifecycle authority), and the destination is subject to the same admission gates as `enroll()`: placement, gender, capacity, duplicate, branch. |
| **Root cause** | Admission invariants lived in *routes*, so every new caller had to remember to repeat them — and callers did not. |
| **Architecture change** | Invariants moved into the domain layer. New module `core/academic/class-admission.ts` owns the gender and duplicate rules; `classes.routes.ts` keeps its historical `assertClassGenderAllowsStudent` export but now **delegates** to it. No second implementation, no new lifecycle engine, no duplicated placement logic. |
| **Live before** | graduated-only → `200`, rows became `["active","graduated"]` · no enrollment → `200`, enrollment minted from nothing · placement required → `enroll-class 400` vs `transfer 200`. |
| **Live after** | graduated-only → `409` · terminal (`dropped`/`withdrawn`/`transferred`) → `409` · no enrollment → `409` · placement required → **both paths 400 with the identical placement error** · valid transfer → `200`, source `transferred`, destination `active`. |

**Additional vector found during Phase B and fixed under E-1:** the transfer-request approval path (`POST /api/enrollments/:id/transfer-requests`) called the service directly and therefore bypassed the route-level gender check entirely — a male student was admitted to a female-only class (`201`, verified live). Now `400`. This was not in the audit; it was found by tracing authorities before writing code, and it is the clearest evidence that route-level enforcement was the real defect.

### E-2 — HIGH — duplicate enrollments, and a corrected uniqueness dimension

| | |
|---|---|
| **Before** | The duplicate guard existed only as an inline check in `students.routes.ts` keyed on `status='active'`. `journey/enrollments` had none, so varying the caller-supplied `semesterName` produced six active enrollments in one class. |
| **After** | One rule in `class-admission.ts`, enforced at `EnrollmentService.enroll()` (which journey already delegates to), re-checked inside the transaction, and backed by a partial UNIQUE index (migration 074). |
| **Root cause** | No shared duplicate authority and no DB-level backstop — `enrollments` had no unique index at all. |

**The correction — disclosed in full.** My first implementation keyed uniqueness on `(student, class)`. It was wrong, and `balance-single-source-of-truth.test.ts` failed. Investigating rather than adjusting the test showed the failure was correct: `POST /students/:id/enroll-semester` legitimately enrolls one student in one class for **consecutive terms**, and that test pins the money — `'Term One'` 20,000 + `'Term Two'` 30,000 in a single class must yield **50,000** lifetime tuition. A `(student, class)` key rejects the second term with a 409 and silently destroys 30,000 AFN of billable revenue.

The rule is therefore keyed on **(student, class, semester)**, with a stricter companion (`assertNotAlreadySeatedInClass`, any semester) for operations that add a student to a class they are not currently attending — extra-class enrollment and transfer, where re-seating is meaningless. Both live side by side in one module so the scopes stay visible instead of drifting apart.

This is exactly the failure mode the audit warned about: *do not use the existing partial index as proof of the business rule*. The old `uq_student_semester_active` index was a projection guard, not the business rule; had I mirrored it, or trusted my own first instinct over the suite, I would have shipped a revenue-destroying regression.

**Live after:** exact duplicate → `409` · same semester via journey → `409` · **different semester → `201` (legitimate next term preserved)** · repeat of that semester → `409` · raw INSERT behind the service → `UNIQUE constraint failed`.

### E-3 — MEDIUM — class merge now moves exactly what it counts

| | |
|---|---|
| **Before** | Counted `active|confirmed|pending` but moved only `active`. Reported `movedStudents:2` while moving 1, stranding a pending enrollment on a class the same transaction cancelled, while its fee row moved — splitting the student across two classes. |
| **After** | The moved set is `ACTIVE_ENROLLMENT_STATUSES`, the same seat-consuming predicate used by capacity and duplicate detection. `movedStudents` is derived from the population actually moved, and `movedEnrollments` reports affected rows. |
| **Semantics defined per state** | `active`/`confirmed`/`pending` → **move** (they occupy a source seat). `completed`/`graduated` → **remain** (they record where the student actually studied; rewriting them falsifies the academic record). `transferred`/`dropped`/`withdrawn` → **remain** (closed history). |
| **Bug found while fixing** | The population snapshot ran *after* the UPDATE, so once the UPDATE moved the rows the roster loop would have seen nothing. Resequenced inside the transaction. |
| **Live after** | 1 active + 1 pending → `{movedStudents:2, movedEnrollments:2}`, source empty, both students' enrollment **and** fee row on the target. Completed history stays on the source. Full destination → `400`. Empty merge → `movedStudents:0`, source still cancelled. |

### E-4 — LOW — error contract

| | |
|---|---|
| **Before** | The service threw bare `Error` for business validation, surfacing as HTTP 500. |
| **After** | All 13 bare `throw new Error(...)` sites in `enrollment-service.ts` now throw typed `HttpError` with correct codes (404 missing, 409 state conflict, 400 invalid request). No new error class — the existing `HttpError` was already imported. |
| **Second defect found** | The students transfer route wrapped **every** service error in a blanket `HttpError(400)`, flattening the new typed statuses — and it would have relabelled a genuine 500 as a client error. It now rethrows `HttpError` untouched and only wraps unknown throwables. |
| **Live after** | cross-branch `400` (was 500) · missing class `404` · inactive class `400` · full class `409` · no active source `409`. Unexpected failures are **not** laundered into 4xx — explicitly tested. |

---

## Tests

| | |
|---|---|
| Before | **1277** passed / 112 files |
| After | **1309** passed / 113 files |
| New | **32** (`server/src/tests/enrollment-subsystem-remediation.test.ts`) |
| Existing test files modified | **0** |
| Tests weakened / deleted / skipped | **NO** — `git diff --name-only -- 'server/src/tests/*'` returns nothing; zero `.skip`/`.only`/`todo` added |

Every new test fails against pre-remediation code. Fixtures are behavioural and route-level; raw INSERTs are used only to age a row into a state the API cannot reach directly (e.g. forcing `pending`), never to fake a result the code under test should produce.

---

## Mutation Testing

| Mutant | Invariant | Result | Killing test |
|---|---|---|---|
| M1 | transfer lifecycle/source guard removed | **KILLED** (6 failures) | terminal-source and no-source transfer tests |
| M2 | transfer placement gate removed | **KILLED** (1) | "applies the placement gate on transfer exactly as enroll-class does" |
| M3 | transfer duplicate guard removed | **KILLED** (1) | "refuses a transfer into a class where the student already holds a seat" |
| M4 | journey/enroll duplicate guard removed | **KILLED** (1) | "journey/enrollments cannot create a second seat…" |
| M5 | UNIQUE index downgraded to plain index | **KILLED** (1) | "is enforced at the DATABASE level, not only in the application" |
| M6 | merge count/move mismatch restored | **KILLED** (3) | merge pending/movedStudents/fee-linkage tests |
| M7 | merge capacity guard removed | **KILLED** (1) | "refuses to merge when the destination lacks free seats" |
| M8 | typed errors flattened back to 400 | **KILLED** (9) | E-1 and E-4 status-code assertions |
| M9 | semester move hoisted out of the merge transaction | **KILLED** (1) | "a merge that fails partway rolls back EVERY write" |

**Critical survivors: ZERO.**

Three mutants (M2, M3, M4) **survived on first run** and are reported rather than hidden. Each survival was a real gap in my tests, not a false alarm:

- **M2/M3** — my E-1 fixtures used bare `A1` classes with no `level_id`, so `assertPlacementEligibleForClass` exited early and the guard was never reached. Fixed by building a genuine program → published version → level → `required` branch profile fixture. M3 needed the one state where the destination duplicate guard is reachable (active in SRC, `pending` seat in DST), since identical from/to is rejected earlier.
- **M4** — the DB constraint from migration 074 caught the write even with the application guard deleted, so the test saw 409 either way. Fixed by asserting the **domain message** (`'Already enrolled in this class.'`), which distinguishes the clean application 409 from a raw `SQLITE_CONSTRAINT` 500. Both layers are now independently verified.

M9 also survived initially; killing it required a real mid-transaction failure (a `grading` class cannot transition to `cancelled`) rather than a simulated one.

---

## Concurrency

| Test | Setup | Result | Seats |
|---|---|---|---|
| J1 | 10 concurrent `enroll-class`, cap 2 | 2×201, 8×409 | 2/2 |
| J3 | mixed `enroll-class` + `journey`, cap 2 | 1×E201, 1×J201, 3×E409, 3×J409 | 2/2 |
| J4 | 6 concurrent transfers, cap 1 | 1×200, 5×409 | 1/1 |
| J5 | 10 concurrent duplicates (same student+class+semester) | 1×201, 9×409 | 1 seat row |

**Global DB invariants after all load:** classes over capacity → `[]` · duplicate seats `(student, class, semester)` → `[]`.

---

## Financial Reconciliation

Single student, exact figures at each step:

| Step | Obligation | Paid | Enrollments | Semester rows | Invoices |
|---|---|---|---|---|---|
| After enrollment | 6000 | 0 | 1 | 1 | 0 |
| After 2000 payment | 6000 | 2000 | 1 | 1 | 0 |
| **Failed** transfer (dest full, 409) | 6000 | 2000 | 1 | 1 | 0 |
| **Failed** duplicate (409) | 6000 | 2000 | 1 | 1 | 0 |
| **Successful** transfer (200) | **6000** | **2000** | 2 | 2 | 0 |

API balance after transfer: `tuitionDue 6000 / tuitionPaid 2000 / outstanding 4000 / paidPercentage 33`. Enrollments `[cDst active, cSrc transferred]`; semesters `[cSrc completed 6000, cDst active 0]` — obligation moved, **not duplicated**. Failed operations left financial state byte-identical.

---

## Security

Re-verified live after remediation — all refused server-side:

| Attack | Result |
|---|---|
| b1 registrar reads / drops a b2 enrollment | 403 / 403 |
| b1 registrar transfers or journey-enrolls a b2 student | 403 / 403 |
| Cross-branch class injection (transfer / enroll-class) | 400 / 400 |
| teacher / finance attempt transfer | 403 / 403 |

---

## Schema

**Migration added: YES** — `074_enrollment_class_uniqueness.sql` (forward-only; no historical migration modified).

```sql
DROP INDEX IF EXISTS uq_enrollment_active_seat_per_class;
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_active_seat_per_class
  ON enrollments(student_id, class_id, COALESCE(semester_name, ''))
  WHERE class_id IS NOT NULL AND status IN ('active','confirmed','pending');
```

**Historical-data handling.** Collisions were inventoried **before** authoring the migration: freshly seeded DB **0**, Student-subsystem harness **0**, Enrollment audit harness **4** — all created by the audit's own E-2 exploit probes hours earlier. No naturally occurring collision exists in any non-exploit dataset.

The migration **deletes and rewrites nothing**. On colliding data `CREATE UNIQUE INDEX` fails loudly at migration time (verified: `UNIQUE constraint failed: enrollments.student_id, enrollments.class_id`) so an operator reconciles deliberately rather than having rows silently discarded. The exploit rows in my own harness were closed with a real terminal transition (`status='dropped'` + explanatory note), preserving every row.

`COALESCE(semester_name,'')` is required because SQLite treats NULLs as distinct — without it two seat rows that both omit the semester would not collide. `DROP INDEX` first ensures the index is built from this definition even where an earlier form exists (074 is unreleased).

---

## Regression Gates

| Gate | Baseline | After |
|---|---|---|
| Backend tests | 1277 / 112 files | **1309 / 113 files** |
| ESLint | 0 errors, 113 warnings | **0 errors, 113 warnings** |
| Typecheck (server + frontend) | 0 errors | **0 errors** |
| Builds | both pass | **both pass** |
| Fresh-schema / drift | 72 migrations, no drift | **73 migrations, no drift** |
| Release validation | 16/16 | **16/16** |

---

## Explicitly Rejected Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| R-1 | `(student, class)` is the duplicate-enrollment key | **REJECTED — proven harmful** | Rejects legitimate consecutive terms; destroys 30,000 AFN in the pinned scenario. Corrected to `(student, class, semester)`. |
| R-2 | The failing balance tests encoded the old defect and should be adjusted | **REJECTED** | They encode correct, financially material behaviour; the fix was wrong, not the tests. No existing test was modified. |
| R-3 | Class merge uses a divergent capacity predicate | **REJECTED** | `stmtCountStrictActiveEnrolled` is semantically identical to `countActiveStudentsInClass`; the defect was the *move* set, not the count. |
| R-4 | Transfer-request auto-approve is a privilege-escalation path | **REJECTED** | teacher/finance 403 on both direct transfer and transfer-request; no lower-privileged role reaches the writer. It did bypass **gender** (fixed under E-1), which is a validation gap, not escalation. |
| R-5 | `students.routes.ts` capacity check outside its transaction causes overbooking | **REJECTED as defect; retained as residual risk** | Not reproducible under 10-way concurrency; SQLite serialises writers. Real only on a concurrent-writer engine. |
| R-6 | Historical data blocks the new constraint | **REJECTED** | 0 collisions in every non-exploit dataset. |

---

## Residual Risks

1. **Out-of-transaction capacity check** (`students.routes.ts:768` vs its tx) — benign under SQLite, a genuine overbooking window on Postgres/MySQL. Not touched: fixing it is outside E-1…E-4 and would alter an unrelated write path.
2. **Four write authorities remain** (service, students route, journey engine, merge). They now share one predicate for capacity, one duplicate rule, one gender rule, one placement gate and one lifecycle engine, but the raw-SQL INSERT in `students.routes.ts` is still a separate writer — the structural consolidation is out of scope here.
3. **`semester_name` is free text.** The corrected key depends on it, so two spellings of one term (`"Term One"` vs `"term one"`) are distinct seats. Normalising it is a data-model change beyond this pass.
4. **GL-1 / GL-2 remain unperformed** — real-browser inspection at 1920×1080 and one actually printed fee bill. Neither is claimed as verified.

---

## Commits

| Commit | Content |
|---|---|
| `d746150` | Enrollment subsystem audit (baseline for this pass) |
| _this commit_ | E-1…E-4 remediation: `class-admission.ts`, `enrollment-service.ts`, `classes.routes.ts`, `students.routes.ts`, migration `074`, `enrollment-subsystem-remediation.test.ts` |

---

## Final Decision: **GO**

- All four findings fixed at the domain/service layer, not the frontend — ✅
- Every original exploit re-run and now rejected, including a gender-bypass vector the audit missed — ✅
- All 9 required mutants killed; zero critical survivors (3 initial survivors disclosed and closed by strengthening tests, never by weakening them) — ✅
- Concurrency holds: no overbooking, no duplicate, no partial financial state — ✅
- Financial reconciliation exact against DB truth — ✅
- Full gates green; 1309 tests, no test weakened or removed; clean tree — ✅

This verdict rests on live behaviour and DB truth, not on the suite being green — the suite was green for all four defects before this pass, and green again for three mutants until the tests were strengthened.
