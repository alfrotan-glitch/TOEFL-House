# ENROLLMENT SUBSYSTEM AUDIT

**Date:** 2026-08-18 · **Commit:** `1b2d2ca` · **Branch:** `arena/01a0062e-toefl-house`
**Scope:** Enrollment subsystem — creation, transition, transfer, capacity, duplication, financial coupling, authorization, shadow paths.
**Mode:** AUDIT ONLY. No production code, migration, test, or configuration was modified. Working tree verified clean (`git status --porcelain` = 0) at audit close.

---

## VERDICT: **CONDITIONAL GO**

The enrollment subsystem's **core invariants hold under adversarial and concurrent load**: capacity is never exceeded, financial obligations never double-count, transactions roll back atomically, and branch isolation is absolute. The state machine is correctly enforced *on the guarded route family*.

However, **one CRITICAL defect (E-1)** allows an admission gate to be bypassed entirely through a parallel write path, and **three surviving mutants** prove that several important guards have **zero test coverage**. These are correctness defects in reachable, role-authorized paths, not theoretical risks.

Conditional GO is contingent on remediating **E-1** and closing the test-blindness gap for the capacity/duplicate/merge guards. E-2, E-3, and E-4 are bounded and may ship with a tracked follow-up.

---

## Environment

| Item | Result |
|---|---|
| Commit / tree | `1b2d2ca`, clean |
| Test suite | **1277 passed / 0 failed / 112 files** |
| Lint | 0 errors (1 fixable warning) |
| Typecheck (server + frontend) | 0 errors |
| Builds | both succeed |
| Migration drift | `preflight:fresh-schema` — 72 migrations, no drift |
| Release validation | not re-run this pass (16/16 at `a6c27c3`) |
| Audit DB | disposable harness `/tmp/enr/erp.sqlite` (never the authoritative DB) |

**Harness state change (disclosed):** placement profile `pap1` was relaxed to `requirement_mode='not_required'` so capacity results would not be masked by the placement gate. This affects the harness only; it was re-installed as `required` when placement evidence was gathered for E-1.

---

## Writer Inventory

Exhaustive enumeration of production writers to `enrollments` (grep for `INSERT|UPDATE|DELETE INTO enrollments`, test files excluded):

| # | File / entry point | Operation | Actor roles | Transaction | Lifecycle check | Capacity check | Duplicate check | Placement gate |
|---|---|---|---|---|---|---|---|---|
| 1 | `core/academic/enrollment-service.ts` `enroll()` | INSERT | registrar, manager, HOD, owner | yes (`:317`) | yes | **inside tx** `:319` | no | **yes** `:312` |
| 2 | `core/academic/enrollment-service.ts` `transfer()` `:410` | UPDATE + INSERT | registrar, owner | yes (`:425`) | **NO** | inside tx `:426` | n/a | **NO** ← E-1 |
| 3 | `core/academic/enrollment-service.ts` `transitionEnrollment()` `:534` | UPDATE status | registrar, manager, HOD, owner | yes | **yes** `:543` (sole caller of `assertEnrollmentTransition`) | n/a | n/a | n/a |
| 4 | `routes/students.routes.ts` `:805` (extra-class) | INSERT | registrar, manager, HOD, owner | yes (`:804`) | yes | `:768` **outside tx** | **yes** `:781` | no |
| 5 | `core/journey/journey-engine.ts` `:148` | INSERT | registrar, manager, HOD, owner | caller-supplied | yes | yes | **NO** ← E-2 | no |
| 6 | `routes/classes.routes.ts` `:573` (class merge) | bulk UPDATE `class_id` | manager, HOD, owner | yes (`:570`) | n/a | pre-tx `:563` | n/a | n/a |

**Key question — is there exactly ONE authoritative Enrollment write authority?**
**No.** There are three independent INSERT authorities (service, students route, journey engine) plus one bulk UPDATE authority (class merge).

Applying the required test — *do all writers enforce the same invariant?* — the answer is **mixed, and the divergences are the findings**:

- **Capacity: CONVERGENT.** All writers call the single predicate `countActiveStudentsInClass()` (`core/academic/class-capacity.ts`, `ACTIVE_ENROLLMENT_STATUSES = ['active','confirmed','pending']`, `COUNT(DISTINCT student_id)`). The class-merge route uses a separate statement `stmtCountStrictActiveEnrolled` (`classes.routes.ts:83`) but with **byte-identical semantics** — verified by reading both. **Not a defect.**
- **Duplicate prevention: DIVERGENT.** Only writer #4 checks it (E-2).
- **Placement admission: DIVERGENT.** Only writer #1 enforces it (E-1).
- **State machine: DIVERGENT.** Only writer #3 enforces it (E-1).

---

## Findings

### E-1 — CRITICAL — `POST /api/students/:id/transfer` is an unguarded enrollment-creation path

- **Writer/path:** `routes/students.routes.ts` → `EnrollmentService.transfer()` (`core/academic/enrollment-service.ts:410-445`).
- **Root cause:** `stmtGetActiveEnrollment` (`:133`) matches `status='active'` **only**. The transfer-out UPDATE is made optional by `if (active)` at `:430`, while `stmtInsertNewEnrollment` (`:138-139`, `status='active'` hardcoded) executes **unconditionally**. Neither `assertEnrollmentTransition` nor `assertPlacementEligible` is consulted on this path.
- **Business invariant violated:** an enrollment may only be created through an admission gate, and a terminal enrollment is immutable.
- **Live reproduction (three proven consequences):**
  1. **Terminal-state resurrection** — a student whose only enrollment is `graduated` transfers with HTTP 200; DB rows become `["active","graduated"]`.
  2. **Placement bypass** — under a `required` placement policy, the same student+class returns **400 from `enroll-class`** but **200 from `transfer`**.
  3. **Transfer-as-create** — a student with **zero** enrollments gets a new `active` enrollment via `transfer`.
- **Guards that DO hold on this path** (limiting blast radius): capacity (400, seats unchanged), gender policy (400, route-level), branch equality, target-class `status==='active'`, and student lifecycle for `suspended`/`graduated` (both 409).
- **Reachability:** registrar 200, owner 200; manager/HOD 400; teacher/finance 403.
- **Existing test coverage:** **NONE.**
- **Mutation result:** **M2 SURVIVED** — adding the missing `if (!active) throw` guard left **1277/1277 passing**. (Control M1, removing the placement gate from `enroll()`, was **KILLED** with 15 failures — the suite covers the guarded path only.)
- **Impact:** admission control (placement testing) is optional in practice; academic history can be silently rewritten; students can be enrolled with no admission record.
- **Remediation boundary (description only):** `transfer()` must require an active source enrollment, and must route source→`transferred` / target→`active` through `transitionEnrollment()`, applying the same admission gates as `enroll()`.

### E-2 — HIGH — `POST /api/students/:id/journey/enrollments` creates unlimited duplicate active enrollments

- **Writer/path:** `core/journey/journey-engine.ts:148`, reached via the journey route.
- **Root cause:** the duplicate guard `stmtCheckActiveEnrollment` exists **only** in `students.routes.ts:781`. The journey writer has none, and `enrollments` has **no UNIQUE constraint** — only non-unique indexes.
- **Business invariant violated:** a student holds at most one active enrollment per class.
- **Live reproduction:** student "Dup A" — `enroll-class` into `cSrc` returns **409 "Already enrolled in this class."**, while `journey/enrollments` for the *same student and class* returns **201**, yielding 2 active rows. Escalated with student "Dup B": 5 calls with distinct `semesterName` values produced **6 active enrollments in one class**.
- **Bounding constraint discovered:** the partial unique index `uq_student_semester_active ON student_semesters(student_id, semester_name) WHERE status='active'` caps repeats **only when `semester_name` repeats** (subsequent identical calls return 409 "A record with this unique information already exists"). Varying `semesterName` defeats it entirely.
- **Blast radius is bounded — explicitly verified, not assumed:**
  - **Capacity: NOT violated.** `COUNT(DISTINCT student_id)` means duplicates consume one seat (`cSrc`: 13 raw active rows → **7** seats, matching `GET /classes` and `merge-candidates`).
  - **Financials: NOT corrupted.** Journey-created rows carry `fee_amount=0`; "Dup B" total obligation stayed **6000 AFN**, API balance `tuitionDue 6000 / paid 0 / outstanding 6000`.
- **Classification:** *correctness-preserved, data-integrity-degraded* — roster/history pollution and reporting noise, not financial or capacity loss.
- **Mutation result:** **M4 SURVIVED** — disabling the duplicate guard at `students.routes.ts:781` left **1277/1277 passing**. The one enforced duplicate rule is untested.
- **Remediation boundary:** enforce duplicate prevention in the shared service layer used by all INSERT writers, backed by a forward-only partial unique index on `enrollments(student_id, class_id) WHERE status IN ('active','confirmed','pending')`.

### E-3 — MEDIUM — Class merge strands non-active enrollments and over-reports the moved count

- **Writer/path:** `routes/classes.routes.ts:563-592`.
- **Root cause:** the capacity gate counts `('active','confirmed','pending')` via `stmtCountStrictActiveEnrolled`, but `stmtUpdateEnrollmentsMerge` (`:144`) moves only `WHERE status = 'active'`. The response reports the **counted** figure, not the **moved** figure. `stmtUpdateSemestersMerge` (`:141`) moves the fee row on a different predicate.
- **Live reproduction:** `mSrc2` (1 active + 1 pending) merged into `mDst2` → **HTTP 200 `{"movedStudents":2}`**, but only 1 enrollment moved. Result: source class `status='cancelled'`, the **pending enrollment still points at the cancelled class**, and that student's fee row moved to `mDst2` — enrollment and obligation **split across two classes**. The student occupies no seat in either class and has 0 roster rows.
- **Capacity impact: none** — counting more than it moves is *conservative* (over-reserves), so no overbooking is possible.
- **UI impact: none** — `ClassesView.tsx:760` awaits `mergeClass` and discards the payload; the inflated count is never rendered. API-level inaccuracy only.
- **Existing test coverage:** **NONE** for merge with non-active enrollments.
- **Mutation result:** **M3 SURVIVED** — disabling the merge capacity gate entirely left **1277/1277 passing**.
- **Remediation boundary:** make the moved set and the counted set the same predicate, and move the enrollment and its `student_semesters` row together within the existing transaction.

### E-4 — LOW — Domain validation errors surface as HTTP 500

- **Writer/path:** `EnrollmentService.transfer()` throws bare `Error` (`:412-421`) while the same function throws `HttpError(409)` for capacity (`:428`).
- **Live reproduction** on `POST /api/enrollments/:id/transfer-requests`: same-class → 400 ✅; missing reason → 400 ✅; nonexistent class → 404 ✅; **cross-branch class → HTTP 500** with message "Target class belongs to another branch."; valid → 201 ✅.
- **Impact:** a client-correctable 403/400 is reported as a server fault — misleading for clients, pollutes error monitoring. **Security is not affected**: the operation is still correctly refused.
- **Remediation boundary:** throw typed `HttpError` for all domain validation in the service layer.

---

## Explicitly Rejected Hypotheses

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| R-1 | Capacity check outside the transaction (`students.routes.ts:768` vs tx at `:804`) permits overbooking | **REJECTED as a confirmed defect; recorded as latent risk** | 10-way concurrency produced no overbooking; SQLite single-writer serialization masks the window. Real under a concurrent-writer engine. |
| R-2 | Class merge uses a divergent capacity predicate | **REJECTED** | `stmtCountStrictActiveEnrolled` is semantically identical to `countActiveStudentsInClass`. |
| R-3 | `inactive` students can enroll/transfer — a lifecycle hole | **REJECTED** | Intentional: the locked Student decision "`inactive→graduated` allowed" implies `inactive` is operable. `suspended` and `graduated` are both correctly blocked (409). |
| R-4 | Transfer duplicates the student's fee obligation | **REJECTED** | Live: enroll 6000 → pay 2000 → transfer ⇒ old semester `completed`/new `active` at fee 0; total stays **6000**, paid **2000**, API `outstanding 4000`, `paidPercentage 33`. |
| R-5 | Transfer-request auto-approve is a privilege-escalation path | **REJECTED** | teacher/finance 403 on both direct transfer and transfer-request. No lower-privileged role reaches the writer. |
| R-6 | Stale transfer-requests can be approved into a since-filled class | **REJECTED** | Capacity is enforced at request creation; tenure-qualifying requests execute immediately and are marked `approved`, so no stale pending request survives to bypass capacity. |
| R-7 | Enrollment list endpoint repeats the Student 2000-row truncation | **REJECTED (N/A)** | No enrollment list/export endpoint exists; `enrollment.routes.ts` exposes only `GET /:id` and sub-resources. Defect class not reachable here. |
| R-8 | Metric drift in class enrolled counts | **REJECTED** | DB canonical 7 = `GET /classes` 7 = `merge-candidates` 7, even with E-2 duplicates inflating raw rows to 13. `DISTINCT` applied consistently. |

---

## Concurrency Results

Single predicate `countActiveStudentsInClass()`; **invariant "seats never exceed capacity" held in every trial.**

| Test | Setup | Result | Final seats |
|---|---|---|---|
| A | enroll into full `cRace` (2/2) | 409 | 2/2 |
| B | 10 concurrent `enroll-class`, `cC1` cap 2 | 2×201, 8×409 | 2/2 |
| C | **mixed-path**: 4 `enroll-class` + 4 `journey` + 3 `manual`, `cC2` cap 2 | 1×201 (E), 1×201 (J), 9×409 | 2/2 |
| D | 6 concurrent transfers, `cT` cap 1 | 1×200, 5×400 | 1/1 |
| F/G/H/X | `complete` / `drop` / `withdraw` / `freeze` on `cRel` cap 1 | 200 each; follow-up enroll 201 | 1→0 (seat released in all four) |

Test C is the strongest result: **three independent writers racing on the same class did not overbook.**

---

## Financial Reconciliation

| Scenario | Obligation | Paid | API balance | Verdict |
|---|---|---|---|---|
| Enroll (fee 6000) | 6000 | 0 | due 6000 / out 6000 | ✅ |
| Pay 2000 | 6000 | 2000 | out 4000 | ✅ |
| **Transfer to new class** | old sem → `completed` (6000), new sem → `active` (0); **total 6000** | 2000 preserved | due 6000 / paid 2000 / **out 4000** / 33% | ✅ no duplication |
| E-2 duplicates (5 extra enrollments) | still **6000** (journey rows fee 0) | 0 | out 6000 | ✅ no inflation |

**Transactional atomicity (induced failure):** manual student creation with a 6000 payment into a full class → **HTTP 409 "Selected class is full."**; students 71→71, payments 1→1, enrollments 45→45, **0 orphan rows**. Full rollback proven.

---

## Authorization Results

Branch-1 registrar attacking branch-`b2` objects — **all refused server-side**:

| Attack | Result |
|---|---|
| `GET /enrollments/{b2}` | 403 |
| `POST /enrollments/{b2}/drop` · `/complete` · `/withdraw` | 403 · 403 · 403 |
| `POST /students/{b2}/transfer` · `/enroll-class` · `/journey/enrollments` | 403 · 403 · 403 |
| Cross-branch **class injection** (b1 student → `cB2`) via all three writers | 400 · 400 · 400 |

No forged-ID or object-substitution bypass found.

---

## Test Blindness (surviving critical mutants)

| Mutant | Mutation | Suite | Outcome |
|---|---|---|---|
| M1 (control) | Remove placement gate from `enroll()` | 15 failures | **KILLED** ✅ |
| M2 | Add the missing `if (!active)` guard to `transfer()` | 1277/1277 pass | **SURVIVED** ❌ E-1 |
| M3 | Disable merge capacity gate (`if (false && enrolled > free)`) | 1277/1277 pass | **SURVIVED** ❌ E-3 |
| M4 | Disable duplicate guard (`students.routes.ts:781`) | 1277/1277 pass | **SURVIVED** ❌ E-2 |

**3 of 4 mutants survived a fully green 1277-test suite.** Coverage is concentrated on `enroll()` and the guarded transition routes; the transfer path, the merge path, and duplicate prevention are effectively untested. All mutants were reverted and the tree verified clean.

---

## Residual Risks

1. **R-1 latent concurrency window** — `students.routes.ts:768` checks capacity outside its transaction. Benign under SQLite; becomes a real overbooking defect on Postgres/MySQL or WAL with concurrent writers. Re-test if the engine changes.
2. **No DB-level uniqueness on `enrollments`** — duplicate prevention is purely application-level, so any new writer inherits E-2 by default.
3. **Four independent write authorities** — every future invariant must be implemented in four places; this architecture is the common root cause of E-1, E-2, and E-3.
4. **Historical data** — E-1/E-2/E-3 may have produced stranded, duplicated, or gate-bypassing rows already; a reconciliation query is advisable before remediation.

---

## GO / NO-GO

**CONDITIONAL GO.**

- **Blocking for production:** **E-1** (CRITICAL — admission-gate bypass and terminal-state resurrection through a role-authorized path with zero test coverage).
- **Strongly recommended before release:** kill mutants **M2/M3/M4** with real behavioural tests — the green suite currently provides false confidence on exactly the paths where defects were found.
- **Non-blocking, track as follow-ups:** E-2 (bounded: no financial or capacity impact), E-3 (bounded: conservative on capacity, invisible in UI), E-4 (cosmetic error mapping).
- **Positive assurances, live-proven:** capacity integrity under three-writer concurrency, financial reconciliation exactness, transactional atomicity with full rollback, branch/object authorization, seat release across all terminal and hold states, and absence of metric drift.

This verdict is **not** based on the passing test suite. Per the governing standard — MUTATION EVIDENCE > GREEN SUITE — the suite is demonstrably blind to three of the four guards probed.

**Out of scope / unchanged this pass:** UX-14 phone policy (owner decision D1), Category-A stale-seat reconciliation (D2), visitor UI-vs-API phone contradiction (D3), accessibility blockers, and GL-1 / GL-2 — the latter two require a real browser at 1920×1080 and one actually printed fee bill, **neither of which was performed and neither of which may be claimed as verified.**
