# ENROLLMENT C-1 REMEDIATION REPORT

**Date:** 2026-08-18 · **Branch:** `arena/01a0062e-toefl-house`
**Scope:** closure-audit residual risks only — C-1 (semester projection) and the dead `JourneyEngine.createEnrollment()` writer. E-1…E-4 were not reopened or rewritten.

---

## 1. Root Cause

`student_semesters` is a **derived projection** of an enrollment, and `EnrollmentService` is its single writer. `transitionEnrollment()` closed the enrollment on `dropped`/`withdrawn` and deleted future rosters, but **never closed the projection row**, which stayed `status='active'`.

Two consequences, both proven live before any code change:

1. **Blocked legitimate re-enrolment.** The still-`active` projection collided with `uq_student_semester_active(student_id, semester_name)` (migration 056), so re-enrolling into the same term returned an opaque DB-level `409 "A record with this unique information already exists."`
2. **Overstated current debt.** `utils/studentBalance.ts` filters the **active** scope on `status='active'`. A dropped term therefore kept counting as current debt — measured at **6000 AFN still reported as current** after the drop.

The correct closed state is **`deferred`**, derived from evidence rather than assumption:
- the schema CHECK permits only `active | completed | deferred`;
- `classes.routes.ts:1145` already maps a manual-review outcome of `drop`/`retake` to `'deferred'` **while calling this same service** — an existing precedent, not a new convention;
- `'completed'` would falsely assert the term was finished;
- the **lifetime** balance scope applies no status filter, so `deferred` preserves the obligation and every payment while removing the term from the *current* scope.

`JourneyEngine.createEnrollment()` was a separate residual risk: a raw `INSERT INTO enrollments` with no capacity, placement, gender, duplicate, branch or lifecycle checks.

---

## 2. Exact Files Changed

| File | Change |
|---|---|
| `server/src/core/academic/enrollment-service.ts` | Added `stmtDeferSemesterForClass` (class-scoped) and invoked it inside the existing `dropped`/`withdrawn` branch of `transitionEnrollment()` — within the existing transaction. |
| `server/src/core/journey/journey-engine.ts` | Removed `createEnrollment()` **and** its orphaned `stmtInsertEnrollment` prepared statement/field; replaced with an explanatory comment. The journey layer now records facts via `appendEvent()` only. |
| `server/src/tests/enrollment-subsystem-remediation.test.ts` | Appended 13 C-1 regression tests. No existing test modified. |

No route was patched independently; the rule lives in the one lifecycle authority every drop/withdraw path already funnels through.

---

## 3. Migration

**None.** The fix is pure application logic against the existing schema. Migration count remains **73**, no drift. No historical row was deleted, reconciled or rewritten.

---

## 4. Before / After

| | Before | After |
|---|---|---|
| enrollment after drop | `dropped` | `dropped` |
| `student_semesters` row | **`active`** (stale) | **`deferred`** |
| re-enrol same semester | **409** (opaque DB error) | **201** |
| re-enrol different semester | 201 | 201 |
| active-scope debt after drop | **6000** (overstated) | **0** |
| lifetime debt | 6000 | **6000** (unchanged) |
| payments | 2000 | **2000** (unchanged) |
| semester rows | 1 | 2 (1 `deferred` history + 1 new) — **nothing deleted** |
| `JourneyEngine.createEnrollment` | present, unguarded, 0 callers | **removed** |

---

## 5. Financial Impact

Controlled scenario (fee 6000, payment 2000, then drop, then re-enrol):

- lifetime obligation **6000 → 6000** (preserved)
- payments **2000 → 2000** (untouched)
- active-scope debt **6000 → 0** (correctly excludes an abandoned term)
- semester rows **1 → 2**: the dropped term survives as `deferred` history carrying its original 6000; the replacement term adds **no second charge**
- no invoice, payment or ledger row was created, altered or deleted

Independently re-verified on a fresh DB (Phase 9): `lifetime_due=6000 active_due=0 paid=1500`.

---

## 6. Concurrency

| Test | Result |
|---|---|
| 10 concurrent re-enrolments after a drop (same student/class/semester) | 1×201, 9×409 → **1** active semester row, **1** seat row |
| 12-way capacity race (cap 1) | 1×201, 11×409 → seats **1/1** |

**Global DB invariants after all load:** over-capacity classes `[]` · duplicate seats `[]` · **dropped-enrollment-with-still-active-semester (C-1 residue) = 0**.

One row shows an active enrollment with no active semester: it is the **extra-class** path (`semester_name='Extra Class'`), which by design never creates a projection row. Verified pre-existing and unrelated to C-1 — this fix concerns *closing* an existing projection, not creating one.

---

## 7. Mutation Results

| Mutant | Invariant | Result | Failures |
|---|---|---|---|
| N1 | remove the projection update entirely | **KILLED** | 7 |
| N2 | wrong target status (`completed` instead of `deferred`) | **KILLED** | 4 |
| N3 | remove class scoping (defer all the student's terms) | **KILLED** | 1 |
| N4 | remove the projection write from the transaction body | **KILLED** | 8 |
| N5 | reintroduce a raw enrollment INSERT on `JourneyEngine` | **KILLED** | 1 |

**Survivors: ZERO.**

**N3 survived on the first run** and is reported rather than hidden. The gap was real: no test had a student holding **two concurrent classes**, so a student-wide `UPDATE` looked identical to a class-scoped one. That matters — an unscoped close would silently deactivate a term the student is still attending and remove a real obligation from the current-debt scope. I added a test asserting that dropping one class leaves the other `active` and reduces current debt by *exactly* the abandoned term's fee; N3 then died. Production code was not weakened to kill it.

---

## 8. Full Gate Results

| Gate | Before | After |
|---|---|---|
| Backend tests | 1309 / 113 files | **1320 passed / 113 files** |
| New tests | — | **+13** (C-1), 0 existing modified, 0 skipped |
| ESLint | 0 errors, 113 warnings | **0 errors, 113 warnings** |
| Typecheck server / frontend | 0 / 0 | **0 / 0** |
| Builds | pass | **pass** |
| Migrations / drift | 73, none | **73, none** |
| Release validation | 16/16 | **16/16** |

**Phase 9 independent adversarial re-run (fresh DB, separate from the regression tests):**

- **E-1** — terminal-source transfer 409 (0 rows created) · no-source transfer 409 · placement enforced identically on enroll-class / transfer / transfer-request (400 each) · gender 400 on transfer and transfer-request · capacity 409 (seats 1/1) · cross-branch 400
- **E-2** — same-semester duplicate 409 · **different semester 201** (consecutive terms still legal) · 1 seat consumed
- **E-3** — active+pending+confirmed merge → `{movedStudents:3, movedEnrollments:3}`, actual moved **3**, stranded **0**
- **E-4** — 7 validation failures, **zero 5xx** (404/400/409/409/409/400/400)
- **C-1** — semester `deferred`, re-enrol 201, financials exact

---

## 9. Remaining Risks

1. **`semester_name` is free text.** Both the E-2 uniqueness key and this projection close depend on it; two spellings of one term are distinct.
2. **Extra-class path creates no semester projection** (pre-existing, by design). An `Extra Class` enrollment has no fee row, so it contributes nothing to either balance scope — consistent, but it means "active enrollment ⇒ active semester" is not a global invariant.
3. **`suspend()` still defers student-wide** via `stmtDeferActiveSemesters`. That is its documented intent (the whole load pauses), unchanged here, but it is a second projection-writing path with different scope.
4. **Out-of-transaction capacity pre-check** in `students.routes.ts` — unchanged, not reproducible under SQLite, a real window on a concurrent-writer engine.
5. **GL-1 / GL-2 and accessibility NOT performed** and not claimed.

---

## 10. Git Commits

| Commit | Content |
|---|---|
| `3281609` | **Recovery** of the E-1…E-4 remediation (was lost: `34ffc1c` never pushed, sandbox reset destroyed local history). Rebased onto the real remote history at `d746150` rather than force-pushing over it. |
| `db41bcd` | This pass: C-1 projection fix + JourneyEngine dead-writer removal + 13 regression tests. |

---

## 11. Remote Push

**VERIFIED SUCCEEDED.** GitHub authentication (previously expired) is working again.

- `3281609` — pushed and confirmed via `git ls-remote` (`d746150..3281609`)
- `db41bcd` — pushed and confirmed via `git ls-remote`; local `HEAD` and `refs/heads/arena/01a0062e-toefl-house` match exactly

Working tree clean at end of pass.

---

## Verdict: **GO** for C-1

C-1 is closed at the domain layer with financial truth preserved, all five new mutants killed (one survivor found, disclosed, and closed by strengthening tests), the dead unguarded writer removed, E-1…E-4 independently re-verified as still closed, and every gate green with no test weakened.
