# ENROLLMENT REMEDIATION — INDEPENDENT CLOSURE AUDIT

**Date:** 2026-08-18 · **Mode:** READ-ONLY. No production code, migration, test, or configuration was modified; no commits were created. All mutants were reverted and verified byte-identical against pre-audit backups.

---

## 1. VERDICT: **CONDITIONAL GO**

E-1 through E-4 are **independently reproduced as CLOSED**. Every original exploit now fails, all nine mutants were independently re-created and killed, concurrency holds under real parallel load, financial reconciliation is exact, and migration 074 is safe on both legitimate and colliding data.

Two items prevent an unqualified GO. Neither is an enrollment-remediation defect and neither is Critical/High:

- **C-1 (MEDIUM, pre-existing, open):** dropping an enrollment does not close its `student_semesters` projection row, so the student cannot re-enrol under the same semester name. Proven pre-existing at the branch point and untouched by this pass.
- **C-2 (ENVIRONMENT, blocking for release governance):** the sandbox was reset. Commit `34ffc1c` **does not exist**; git history is gone and the remediation survives only as uncommitted working-tree files. The code was audited and is sound, but it is **not committed or pushed**.

Per the stated verdict rule, CONDITIONAL GO applies: only bounded medium/low residual risks remain, and they are explicitly characterised below.

---

## 2. Environment Integrity

| Check | Expected | Actual |
|---|---|---|
| HEAD | `34ffc1c` | **`1b275cb`** (branch point) |
| Commit `34ffc1c` exists | yes | **NO** — `fatal: Not a valid object name` |
| Working tree clean | yes | **NO** — 251 uncommitted paths |
| Reflog | remediation history | only `clone` + `checkout` — **sandbox reset** |
| Remediation code present | — | **YES**, intact in working tree |

**Finding C-2 (ENVIRONMENT, HIGH for governance, not a code defect).** The workspace was reset between the remediation pass and this audit. `git reflog` shows only a fresh clone; `origin` has just `main`. The prior report recorded that the final push failed with an expired `GH_TOKEN`, so the work was never on the remote and the local history did not survive.

The remediation **content** is fully present and verified by hash-stable inspection:
- `server/src/core/academic/class-admission.ts` (new, 3 rule functions)
- `server/src/db/migrations/074_enrollment_class_uniqueness.sql` (new)
- `server/src/tests/enrollment-subsystem-remediation.test.ts` (new, 30 tests / 80 assertions)
- modified: `enrollment-service.ts`, `classes.routes.ts`, `students.routes.ts`

Because the audit target is the *code*, the audit proceeded against the working tree. **The evidence below applies to that code, not to a commit.** Dependencies were absent and were rebuilt (`npm install`, `npm install --ignore-scripts`, `node-gyp rebuild` for `better-sqlite3`).

### Baseline gates (all re-run from the rebuilt runtime)

| Gate | Result |
|---|---|
| Backend test suite | **1309 passed / 0 failed / 113 files** |
| ESLint (repo-wide, backend + frontend) | **0 errors**, 113 warnings |
| Typecheck server | **0 errors** |
| Typecheck frontend | **0 errors** |
| Build frontend | **PASS** |
| Build backend | **PASS** |
| Fresh-schema migration | **PASS — 73 migrations** |
| Schema drift | **none** |
| Release validation | **16 passed · 0 failed · 0 skipped** |

Green tests are recorded as a precondition only; the verdict rests on the live and mutation evidence below.

---

## 3. Original E-1 … E-4 Closure Evidence

All executed live against a **fresh disposable database** (`/tmp/clo/erp.sqlite`) with independently built fixtures.

### E-1 — transfer as unguarded CREATE — **CLOSED**

| Attack | Before (audit) | Now | DB effect |
|---|---|---|---|
| A. transfer from terminal `graduated` | 200, rows `["active","graduated"]` | **409** | no new row; seats 0 |
| terminal `dropped` / `withdrawn` / `transferred` / `completed` | (same class of defect) | **409 / 409 / 409 / 409** | rows unchanged (1 each) |
| B. transfer with zero enrollments | 200, enrollment minted | **409** | enrollments 0, semesters 0 |
| C. placement required — transfer | 200 (bypass) | **400** "placement assessment" | seats 0 |
| D. placement required — transfer-request approval | not covered | **400** | seats 0 |
| E. gender-restricted class | 201 via transfer-request | **400** on every path | seats 0 |

**F. Same invariant through every writer** (independently verified, not assumed):

| Writer | Gender (kFem) | Capacity (kCap1 full) |
|---|---|---|
| `POST /students/:id/transfer` | 400 | 409 |
| `POST /enrollments/:id/transfer-requests` | 400 | 409 |
| `POST /students/:id/enroll-class` | 400 | 409 |
| `POST /students/:id/journey/enrollments` | 400 | 409 |
| `POST /students/:id/enroll-semester` | 400 | 409 |

Placement enforced identically on all four applicable paths. Transfer cannot act as a hidden CREATE on any path.

### E-2 — duplicate enrollment — **CLOSED** (semantics independently re-derived)

The `(student, class, semester)` key was **not** accepted on the remediation's word; it was re-derived from behaviour:

| Case | Result | Interpretation |
|---|---|---|
| same student + class + **same** semester | **409** | duplicate correctly refused |
| same student + class + **different** semester | **201** | consecutive terms preserved — a `(student,class)` key would destroy billable revenue here |
| repeat of that new semester | **409** | correctly refused |
| same student + **different** class + same semester | 409 (from `uq_student_semester_active`, migration 056) | pre-existing projection rule, not the enrollment index |
| after a **drop**, re-enrol same semester | 409 (from migration 056) | **finding C-1**, see §4 |

**Layer attribution (Phase 2.6 requirement) — both layers independently confirmed:**

- **Application:** returns the domain message `"Already enrolled in this class."`
- **Database:** raw INSERT behind the service → `UNIQUE constraint failed: index 'uq_enrollment_active_seat_per_class'` for same-semester duplicates, while a genuinely new semester INSERT **succeeds** — proving the predicate is scoped correctly and not over-broad.

Blocked through **every** entry point: enroll-class 409 · journey 409 · transfer 400 · transfer-request 400 · enroll-semester 409. Seat rows remained 1 throughout.

### E-3 — class merge — **CLOSED**

| Scenario | Result |
|---|---|
| mixed active + confirmed + pending | `{movedStudents:3, movedEnrollments:3}`; actual distinct moved = **3**; source empty; source cancelled |
| fee rows follow enrollments | all three students: enrollment and `student_semesters` both on target |
| completed history | **stays** on the source class (`mC/completed`) while the live row moves — academic record preserved |
| exact fit (src 2 → dst 1/3) | 200, seats 3/3 |
| over capacity (src 3 → dst cap 2) | **400**, target 0/2, source intact 3/5, source still `active` |
| mid-transaction failure (`grading` source cannot cancel) | **409**; enrollments, semesters and target seats **byte-identical to pre-state** — full rollback |

`movedStudents` equals rows actually moved in every case. No enrollment stranded on a cancelled source.

### E-4 — HTTP error contract — **CLOSED**

15 adversarial validation failures; **zero 5xx**:

| Case | Status | Case | Status |
|---|---|---|---|
| missing target class | 404 | duplicate enroll-class | 409 |
| cross-branch target | 400 | terminal re-drop | 409 (invalid transition) |
| gender restricted | 400 | resume w/o suspended | 400 |
| capacity full | 409 | suspend w/o active | 400 |
| no eligible source | 409 | xfer-request bad class | 404 |
| same class | 400 | xfer-request cross-branch | 400 |
| missing `toClassId` | 400 | nonexistent student | 404 |

---

## 4. New Findings

### C-1 — MEDIUM — dropped enrollment leaves its semester projection `active` (PRE-EXISTING, OPEN)

- **Reproduction:** enrol student → `POST /enrollments/:id/drop` (200) → re-enrol same class + same semester name.
- **Expected:** allowed — the enrollment is closed, so repeating the term is legitimate (the remediation deliberately leaves closed rows unconstrained).
- **Actual:** **409 "A record with this unique information already exists."**
- **Root cause:** `transitionEnrollment` closes rosters on `dropped`/`withdrawn` but never closes the `student_semesters` row, which stays `status='active'` and collides with `uq_student_semester_active(student_id, semester_name)` from **migration 056**.
- **Evidence:** enrollment `dropped` while its semester row is `active`; rejection message is the generic DB text, not the domain guard.
- **Pre-existing:** the identical code exists at branch point `1b275cb` (`stmtDeleteFutureRosters` only, no semester close). Migration 056 predates this pass. **Not caused or worsened by the remediation.**
- **Impact:** operational friction — a re-enrolment must use a different semester name. No financial or capacity impact (verified: balance unaffected; a new semester name succeeds, HTTP 201).
- **Status:** **OPEN**, outside E-1…E-4 scope.

A related manifestation: after *enrollment* graduation the target semester row remains `active`, because `stmtCompleteSemestersOnGraduation` fires on **student** status change, not enrollment transition. Same root cause; same pre-existing classification; balance verified unaffected (that row carries fee 0).

### C-2 — ENVIRONMENT/GOVERNANCE — remediation is uncommitted and unpushed (OPEN)

- **Evidence:** `34ffc1c` absent; reflog shows only clone + checkout; `origin` has only `main`; 251 uncommitted paths.
- **Impact:** the verified code exists solely in this sandbox's working tree. A further reset loses it. The GitHub token was reported expired at the end of the remediation pass.
- **Status:** **OPEN** — requires reconnecting GitHub and committing/pushing. Not a code defect.

### Explicitly NOT findings (checked and dismissed)

- **`JourneyEngine.createEnrollment()`** (`journey-engine.ts:407`) performs a raw `INSERT` with **no** capacity/placement/gender/duplicate checks. Exhaustive search (including tests and dynamic dispatch) found **zero callers** — **dead code, not a reachable bypass**. Flagged as a latent hazard in §13, not a defect.
- **Multiple `active` enrollments for one student** — observed once; both rows were the same class with *different* semesters, i.e. the intentional sequential-terms case.

---

## 5. Writer Inventory (rebuilt from scratch)

| # | Writer | Via service? | Lifecycle | Placement | Gender | Capacity | Duplicate | Tx | Branch | Financial |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `enrollment-service.enroll()` | authority | ✅ | ✅ | ✅ (callers + service) | ✅ (pre + in-tx) | ✅ (pre + in-tx) | ✅ | ✅ | ✅ |
| 2 | `enrollment-service.transfer()` | authority | ✅ `assertEnrollmentTransition` | ✅ | ✅ | ✅ in-tx | ✅ in-tx | ✅ | ✅ | ✅ |
| 3 | `enrollment-service.transitionEnrollment()` | authority | ✅ sole gate | n/a | n/a | n/a | n/a | ✅ | ✅ | ✅ |
| 4 | `students.routes` extra-class INSERT (`:96`) | raw SQL | `assertStudentOperable` | ✅ | ✅ | ✅ | ✅ shared rule | ✅ | ✅ | ✅ |
| 5 | `students.routes` graduation UPDATE (`:169`) | raw SQL | closes only seat statuses | n/a | n/a | frees seats | n/a | ✅ | ✅ | ✅ |
| 6 | `classes.routes` merge UPDATE (`:164`) | raw SQL | preserves closed history | n/a | n/a | ✅ same predicate | n/a | ✅ | ✅ (403 cross-branch) | ✅ |
| 7 | `journey-engine.createEnrollment()` (`:407`) | raw SQL | ❌ none | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

Writers 1–6 share one capacity predicate (`ACTIVE_ENROLLMENT_STATUSES`), one duplicate authority (`class-admission.ts`), one gender rule, one placement gate, one lifecycle engine. **Writer 7 is unreachable dead code.** Route callers (`journey.routes`, `visitors.routes`, `students.routes` manual/semester) all delegate to `enroll()`.

---

## 6. State-Machine Matrix

Reconstructed independently by forcing each source status and attempting every guarded route. **Allowed transitions observed (all 200):**

`active` → completed · dropped · withdrawn · frozen  ·  `completed` → graduated  ·  `frozen` → dropped · withdrawn  ·  `suspended` → dropped · withdrawn  ·  `pending` → dropped  ·  `confirmed` → dropped  ·  `retake` → dropped

Every observed transition is present in `ENROLLMENT_TRANSITIONS`; **no transition outside the matrix was accepted**. Terminal states (`graduated`, `dropped`, `withdrawn`, `transferred`) refused every route.

**Bypass hunt — can any endpoint dodge the state machine?**

| Vector | Result |
|---|---|
| transfer from `graduated`/`dropped`/`withdrawn`/`transferred`/`completed` | **409** each, row count unchanged |
| `suspend` / `resume` on a graduated enrollment | 400 / 400 |
| class merge mutating a terminal status | no — merge only rewrites `class_id` for seat statuses |
| generic `PATCH`/`PUT /enrollments/:id` | **does not exist** |

---

## 7. Concurrency Results

| Test | Concurrency | HTTP outcomes | Final DB |
|---|---|---|---|
| A. capacity race, cap 2 | 12 | 2×201, 10×409 | seats **2/2** |
| B. mixed-path race, cap 2 (enroll-class + journey + enroll-semester + manual) | 12 | 1×EC201, 1×JN201, 2×EC409, 2×JN409, 3×ES409, 3×MN409 | seats **2/2** |
| C. duplicate race (same student+class+semester) | 12 | 1×201, 11×409 | **1** seat row, 1 semester row |
| D. transfer into cap-1 | 8 | 1×200, 7×409 | seats **1/1** |
| E. merge at capacity boundary | — | exact-fit 200; over-capacity 400 | no overflow |
| G. simultaneous transfer + complete + drop + withdraw on one enrollment | 4 | 1×200 (withdraw), 3×409 | single coherent state `withdrawn` |

**Global invariants after all load:** over-capacity classes `[]` · duplicate seats `[]` · orphan enrollments `0` · orphan semesters `0` · no impossible status combination.

---

## 8. Financial Reconciliation

Controlled scenario, exact figures:

| Step | Obligation | Paid | Enr | Sem | Inv |
|---|---|---|---|---|---|
| after enrollment | 6000 | 0 | 1 | 1 | 0 |
| after 2500 payment | 6000 | 2500 | 1 | 1 | 0 |
| **failed** duplicate | 6000 | 2500 | 1 | 1 | 0 |
| **failed** transfer (full) | 6000 | 2500 | 1 | 1 | 0 |
| **failed** transfer (gender) | 6000 | 2500 | 1 | 1 | 0 |
| **successful** transfer | **6000** | **2500** | 2 | 2 | 0 |

API `payments/balances`: `tuitionDue 6000 / tuitionPaid 2500 / outstanding 3500 / paidPercentage 42` — **exactly matches DB truth**. Semesters `[kSrc completed 6000, kDst active 0]`: obligation moved, not duplicated. **Merge:** total obligation 12000 → **12000**, semester rows 2 → 2 (no loss, no duplication). Failed operations left **zero** financial residue.

Full lifecycle (Phase 13: enrol → pay 3000 → dup rejected → transfer → suspend → resume → complete → graduate) reconciled to `due 6000 / paid 3000 / outstanding 3000 / 50%`, seats released to 0/0.

---

## 9. RBAC / Branch Isolation

All 16 attacks refused server-side:

| Attack | Result |
|---|---|
| branch-A registrar: GET / drop / complete a branch-B enrollment | 403 / 403 / 403 |
| branch-A registrar: transfer / journey-enrol a branch-B student | 403 / 403 |
| branch-A registrar: transfer-request on a branch-B enrollment | 403 |
| forged `classId` (b1 student → b2 class) via transfer / enroll-class | 400 / 400 |
| forged `branchId` in request body | 400 |
| cross-branch **merge** | 403 |
| teacher: transfer / enroll-class / drop / merge | 403 × 4 |
| finance: transfer / merge | 403 / 403 |

---

## 10. Migration 074 Safety

Definition verified in the live DB and on a fresh seed:

```sql
CREATE UNIQUE INDEX uq_enrollment_active_seat_per_class
  ON enrollments(student_id, class_id, COALESCE(semester_name, ''))
  WHERE class_id IS NOT NULL AND status IN ('active','confirmed','pending');
```

| Check | Result |
|---|---|
| fresh DB receives the constraint | **YES** |
| legitimate history (2 same-semester **closed** rows + 2 distinct active terms) | **migrates cleanly**, index created, **4 rows preserved** |
| true duplicate (2 `active`, same semester) | **fails loudly**: `UNIQUE constraint failed` → `Migration failed … Rolled back`; index **NOT** created; **both rows preserved** |
| silent mutation of academic history | **none** — no `DELETE`/`UPDATE` in the migration |
| historical `completed`/`dropped` rows constrained | **no** — partial predicate excludes them (proven by the legit case) |
| sequential legitimate semesters remain possible | **yes** — raw INSERT of a new semester succeeded |
| same-semester duplicate blocked at DB level | **yes** |
| concurrent writes safe | **yes** — 12-way duplicate race → 1 winner |

`DROP INDEX IF EXISTS` before creation is safe here (074 is unreleased) and prevents a stale definition persisting.

---

## 11. Mutation Results (independently re-created, not trusted from the report)

| Mutant | Invariant | Result | Failures |
|---|---|---|---|
| M1 | transfer lifecycle/source guard removed | **KILLED** | 6 |
| M2 | transfer placement guard removed | **KILLED** | 1 |
| M3 | transfer gender guard removed | **KILLED** | 1 |
| M4 | application duplicate guard removed (both sites) | **KILLED** | 1 |
| M5 | DB uniqueness downgraded to plain index | **KILLED** | 1 |
| M6 | merge capacity guard removed | **KILLED** | 1 |
| M7 | merge moves fewer rows than counted | **KILLED** | 3 |
| M8 | typed errors flattened (bare-Error behaviour) | **KILLED** | 9 |
| M9 | semester write hoisted outside the merge transaction | **KILLED** | 1 |

**Survivors: ZERO.** The reported 9/9 is **confirmed**.

Two specifically demanded proofs:
- **M4** — with the DB constraint fully intact, deleting the *application* guard still fails a test, because the test asserts the domain message `"Already enrolled in this class."` rather than merely a 409. The application layer is therefore verified **independently** of the constraint.
- **M5** — with the application guard intact, downgrading the index to non-unique still fails a test. The DB layer is verified independently.
- **M9** — killed by a test that induces a **real** mid-transaction failure (a `grading` class cannot transition to `cancelled`), not a simulated throw.

All source files restored and confirmed byte-identical (`diff -q` clean on all five backups).

---

## 12. Regression Quality

| Check | Result |
|---|---|
| Enrollment remediation modified any existing test file | **NO** — zero enrollment-specific edits (`E-1..E-4`, new guard names, `movedEnrollments`, etc.) in any pre-existing test |
| Tests skipped / only / todo anywhere | **0** |
| New test file | `enrollment-subsystem-remediation.test.ts` — **30 tests, 80 assertions** |
| New tests detect real defects | **Yes** — every one of M1…M9 produced failures |
| Test count | **1309** (report claimed 1309) |

The 13 test files that differ from branch point `1b275cb` belong to **earlier** passes (placement, finance, visitor, teacher, payment) — git history loss makes the diff span all passes. Across all of them, removed `expect()` = 9 vs added = 39, and none contains enrollment-remediation content. **No assertion weakening attributable to this pass.**

---

## 13. Residual Risks

1. **C-2 — the remediation is uncommitted and unpushed.** Highest practical risk: another reset destroys verified work. Requires GitHub reconnection.
2. **C-1 — dropped/graduated enrollments leave `student_semesters` rows `active`** (pre-existing). Blocks same-semester-name re-enrolment; no financial or capacity impact.
3. **`JourneyEngine.createEnrollment()` is unguarded dead code.** Harmless today (zero callers); becomes a full E-1-class bypass the moment anything calls it.
4. **`semester_name` is free text.** The uniqueness key depends on it, so `"Term One"` and `"term one"` are distinct seats.
5. **Out-of-transaction capacity check** in `students.routes.ts` (pre-flight at `:768`, tx at `:804`). Not reproducible under 12-way concurrency (SQLite serialises writers); a genuine window on a concurrent-writer engine.
6. **Four raw-SQL writers remain** (service, extra-class, graduation closer, merge). They now share the same rules, but structural consolidation was out of scope.
7. **GL-1 / GL-2 NOT performed.** No real-browser inspection at 1920×1080 and no physically printed fee bill. **Not claimed as verified.** No accessibility verification was performed.

---

## 14. Exact Test / Gate Counts

| Metric | Value |
|---|---|
| Backend tests | **1309 passed / 0 failed** |
| Test files | **113** |
| ESLint | 0 errors, 113 warnings |
| Typecheck server / frontend | 0 / 0 errors |
| Builds | backend PASS, frontend PASS |
| Migrations | **73**, no drift |
| Release validation | 16 passed / 0 failed / 0 skipped |
| Mutants killed | **9 / 9** |
| New regression tests | 30 (80 assertions) |

---

## 15. Git / Tree Status

| Item | Value |
|---|---|
| HEAD | `1b275cb` (unchanged by this audit) |
| Commits created by this audit | **0** |
| `34ffc1c` | **does not exist** (sandbox reset) |
| Production files modified by this audit | **0** — all mutants reverted, `diff -q` byte-identical |
| Uncommitted paths | 251 (all pre-existing from prior passes + this remediation) |

---

## Final Question

> *Can we now trust Enrollment as a production-grade subsystem, based on independent evidence rather than the remediation author's claims?*

**Yes, on the code — with one governance caveat.**

Independently, without relying on the remediation report: every original E-1…E-4 exploit was re-run and now fails; the duplicate-enrollment semantics were re-derived from behaviour rather than accepted (and the `(student, class, semester)` key is correct — a narrower key would destroy billable revenue, which I verified is real); all five writer paths enforce identical gender, capacity and placement rules; the state machine cannot be bypassed by any reachable endpoint; 12-way concurrency produced no overbooking, no duplicate and no orphan; financial reconciliation matched DB truth exactly at every step; migration 074 preserves history and fails loudly on collisions; and all nine mutants were re-created from scratch and killed, including the two layer-independence proofs.

The caveat is not about correctness: **this verified code is not committed and not pushed** (C-2). Until GitHub is reconnected and the work is pushed, the subsystem is trustworthy but the artefact is fragile. C-1 is a genuine, bounded, pre-existing defect that should be tracked separately.
