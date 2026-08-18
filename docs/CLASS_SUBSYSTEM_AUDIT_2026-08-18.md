# Class Subsystem — Independent Forensic Audit & Remediation

**Date:** 2026-08-18
**Base checkpoint:** `1567004` (`15670044d441447cdb6bfc2dc392baca8b5eb138`)
**Scope:** the Class subsystem — classes, class lifecycle, capacity/roster,
merge, cancellation, assessments/gradebook linkage, class-related writers,
authorization and list/export surfaces.
**Out of scope (frozen):** the Enrollment subsystem. Its behaviour at `1567004`
is treated as the baseline contract and was not modified.

---

## 0. Method

The audit was evidence-first. Nothing below is asserted from reading code
alone: every finding was reproduced by driving the real routers over HTTP with
real permissions through six throwaway forensic probe suites, and every
remediation is locked by a regression test that fails against the
pre-remediation code, plus a mutation test that must be killed.

Raw SQL was used only to age fixtures into states the API cannot reach directly
(e.g. forcing an enrollment to `pending`), never to fabricate a result that
production code is supposed to produce.

---

## 1. Baseline (Phase 1) — verified before any change

| Gate | Result |
|---|---|
| Backend tests | **1320 / 1320 passed** (113 files) |
| Backend lint + typecheck (eslint + tsc + test tsc) | PASS |
| Frontend typecheck | PASS |
| Frontend lint | PASS (0 errors, 6 warnings — pre-existing) |
| Frontend build | PASS |
| Backend build | PASS |
| Migrations / schema drift | **73 migrations, no drift** |
| Release validation | **16 / 16 PASSED** |
| Git | HEAD == remote, working tree clean |

Baseline was green, so the audit proceeded.

---

## 2. Inventory (Phase 2)

### 2.1 Class-related tables

`classes` (core), plus tables keyed to it: `sessions`, `rosters` (via session),
`class_teacher_skills`, `class_assessments`, `student_grades`, `grade_history`,
`class_waitlist`, `class_generation_runs`, `class_generation_items`,
`course_offerings`, and the FK-bearing consumers `enrollments`,
`student_semesters`, `registrations`, `attendance`, `exams`,
`enrollment_transfer_requests`.

### 2.2 Constraints actually present on `classes`

- `status` CHECK — `draft|active|completed|cancelled` (derived projection).
- `lifecycle_stage` CHECK — 11 stages.
- `gender_policy` CHECK — `female|male|mixed`.
- `branch_id` NOT NULL, `ON DELETE RESTRICT`.
- Indexes on `lifecycle_stage`, `branch_id`, `program_id`, `level_id`,
  `teacher_id`.
- **No constraint at all on `capacity`, `min_viable_size` or `fee`** beyond
  `NOT NULL DEFAULT 0` — they are typeless in SQLite terms and accept anything.
  This is the substrate for C-3.
- `merged_into_id` has **no** foreign key (unlike every other class reference).

### 2.3 Writers (all traced for runtime reachability)

| Writer | Reachable via | Notes |
|---|---|---|
| `stmtInsertClass` | `POST /api/classes` | validates fee via `assertMoney` |
| `stmtUpdateClass` | `PUT /api/classes/:id` | **did not validate fee/capacity → C-3** |
| `stmtUpdateClassGender` | `PUT /api/classes/:id` | |
| `stmtDeleteClass` | `DELETE /api/classes/:id` | guarded by live-seat + history checks |
| `stmtLinkMergedClass` | `POST /api/classes/:id/merge` | **overwrote notes → C-5** |
| `ClassLifecycleService` (3 statements) | 11 transition endpoints | sole writer of `lifecycle_stage`/`status`; **no roster-drain guard → C-1** |
| `ClassGenerationEngine.stmtInsertClass` | `POST /api/catalog/class-generation/:runId/publish` | uses `deriveLegacyClassStatus` correctly |
| `stmtLinkClass` | `POST /api/offerings/:id/link-class` | branch-checked; see RR-1 |
| `stmtDeleteSessionsForClass` | **none — dead writer** (see RR-3) | |

Enrollment-side writers that consume class state (capacity, status, gender)
were traced but belong to the frozen subsystem and were not modified, except
`students.routes.ts` extra-class enrollment, whose defect (C-6) is caused by a
Class-path write and is classified under Class.

### 2.4 Guard inventory

- **Route-level:** `requirePermission('Class.View'|'Create'|'Edit'|'Delete')`,
  `authorize(...)` role lists on lifecycle/gradebook endpoints.
- **Object-level:** `requireClass()` → branch scope + `assertClassAccess()` for
  class-scoped (teacher) principals.
- **Service-level:** `ClassLifecycleService.transition()` (state machine),
  `class-admission.ts` (gender, duplicate seat),
  `class-capacity.ts` (`ACTIVE_ENROLLMENT_STATUSES` — the canonical seat
  predicate).
- **DB-level:** CHECKs above, `uq_enrollment_active_seat_per_class` (074),
  `trg_payments_idempotency_required_insert` (063), non-negative money
  triggers (069).

---

## 3. Reconstructed Class state machine (Phase 3)

Derived from `CLASS_TRANSITIONS`, `deriveLegacyClassStatus`, and confirmed by
driving every stage.

| From | Allowed targets | Authority |
|---|---|---|
| draft | scheduled, cancelled | `CLASS_TRANSITIONS` |
| scheduled | enrollment_open, activated, cancelled | " |
| enrollment_open | enrollment_closed, cancelled | " |
| enrollment_closed | enrollment_open, activated, cancelled | " |
| activated | in_progress, suspended, cancelled | " |
| in_progress | suspended, grading, cancelled | " |
| suspended | in_progress, activated, cancelled | " |
| grading | in_progress, completed | " (cancellation deliberately closed once grades exist) |
| completed | archived | " |
| archived | — terminal | " |
| cancelled | — terminal | " |

Verified: invalid transitions return 409; terminal states reject everything;
concurrent conflicting transitions resolve to exactly one winner
(`start-teaching` 409 / `cancel` 200).

**Legacy `status` projection** (`draft→draft`, `cancelled→cancelled`,
`completed|archived→completed`, everything else `→active`) means **six distinct
stages all report `status='active'`**. Every enrollment writer gates on
`status === 'active'`, so a class in `scheduled`, `enrollment_closed`,
`suspended` or `grading` accepts new enrollments (confirmed live: 201 in all
four). This is the documented design of the projection, not a defect — recorded
as residual risk **RR-2**, not a finding.

---

## 4. Confirmed findings

### C-1 — HIGH — Cancelling a class strands live enrollments

**Reproduction**
```
POST /api/students/manual        {classId: X}      → 201  (X holds 1 active seat)
POST /api/classes/X/cancel       {reason: "..."}   → 200
SELECT status FROM enrollments WHERE class_id = X  → 'active'
DELETE /api/classes/X                              → 400 "has 1 active enrollment(s)"
```

**Expected** — the class does not enter a terminal state while students still
hold a seat in it. This is not an invented rule: it is the contract the
**merge** path already upholds (it relocates every seat-consuming enrollment
into the target and only *then* cancels the source — locked by the frozen
Enrollment audit's E-3 test, which names "a live enrollment pointing at a dead
class" as the defect it fixed), and the same invariant `DELETE /:id` states for
a different terminal operation ("Transfer or complete them before deleting").

**Actual** — `POST /:id/cancel` applied no roster check at all. The seats stayed
counted (the class still reported `enrolled: 2` in the list), the student stayed
"enrolled" in a class that no longer runs, and the class became **undeletable
forever**: its own stranded seats trip the delete guard.

**Root cause** — the roster-drain invariant was implemented in the *merge route*
rather than at the lifecycle authority, so the direct `/cancel` endpoint — a
second path to the same terminal stage — never inherited it.

**Blast radius** — every cancelled class with a live roster. Students appear
enrolled in a dead class; the class is stuck in an unrecoverable state;
capacity/reporting counts include seats that can never be attended.

**Financial impact** — none directly (no money moves), but the stranded
enrollment keeps its fee/semester obligation attached to a dead class.

**Security impact** — none.

**Concurrency impact** — none (single-writer SQLite; guard is inside the
transition).

**Existing coverage** — none. `academic-lifecycle.test.ts` cancelled only an
*empty* class, so the defect was invisible.

**Remediation** — roster-drain guard added to
`ClassLifecycleService.transition()`, the single funnel every lifecycle write
passes through, so `/cancel` and any future writer reaching `cancelled` inherit
it. Scoped to `cancelled` **only**: `completed`/`archived` deliberately retain
`active` rows for the manual-review workflow
(`GET /:id/promotion/pending-review` returns rows *only* for those two stages,
and `POST /:id/promotion/resolve/:studentId` closes them — verified 200 on a
completed class). Merge is unaffected because it drains the roster inside its
transaction before calling `cancel()`.

**Mutation evidence** — M1, M2 KILLED.

---

### C-2 — HIGH — Class merge bypasses the gender admission policy

**Reproduction**
```
female-only class S (1 female student), male-only class T
POST /api/students/:id/enroll-class {classId: T} → 400 "…is for male students only."
POST /api/classes/S/merge          {targetClassId: T} → 200, student now seated in T
```

**Expected** — merge is an admission path (it seats students in the target), so
it applies the class gender policy like every other admission path: manual
registration, extra-class enrollment, enroll-semester, waitlist conversion,
visitor conversion and transfer all call the domain authority in
`core/academic/class-admission.ts`.

**Actual** — merge called none of them. HTTP 200, student admitted.

**Root cause** — the same class of defect the frozen Enrollment audit closed as
E-1 (a write path that bypassed a route-level rule), in a path that audit did
not cover. The `merge-candidates` endpoint *does* filter by gender, which proves
the intent existed — but it is a UI-only filter on the read path, trivially
bypassed by posting `targetClassId` directly, and strictly weaker than the real
rule (a `mixed` source can hold male students a `female` target must refuse — a
policy-vs-policy comparison cannot see that; confirmed live).

**Blast radius** — any merge into a gender-restricted class. In the operating
context this policy encodes, seating a student in a class of the wrong gender is
a real-world compliance failure, not a cosmetic one.

**Financial impact** — none. **Security impact** — policy bypass, not privilege
escalation (the caller already holds `Class.Edit`).

**Concurrency impact** — none.

**Existing coverage** — none.

**Remediation** — the merge route now checks the **actual students being moved**
against the target's policy using `assertClassGenderAllows` — the same single
authority every other writer calls, not a second implementation. Refusal is
pre-transaction, so nothing is moved and the source is not cancelled.
Legitimate merges (female→female, male→male, anything→mixed, empty source,
closed-history-only) all verified still working.

**Mutation evidence** — M3, M18 KILLED.

---

### C-3 — HIGH — `PUT /api/classes/:id` writes `fee` and `capacity` with no validation

**Reproduction**
```
PUT /api/classes/X {fee: -1000}  → 200, stored -1000
PUT /api/classes/X {fee: "abc"}  → 200, stored "abc"   (TEXT in a REAL column)
PUT /api/classes/X {fee: "0x10"} → 200, stored "0x10"
PUT /api/classes/X {fee: 1e15}   → 200, stored 1000000000000000
PUT /api/classes/X {capacity: 7.5}  → 200, stored 7.5
PUT /api/classes/X {capacity: 1e15} → 200
POST /api/classes  {fee: -1000 | "abc" | 1e15} → 400   ← the same field, refused
```

**Expected** — the two writers of the same column agree. `POST` has always run
the fee through `assertMoney`.

**Actual** — `PUT` performed no validation, an asymmetry with real downstream
effect:

- `fee: 1e15` → a genuine **1,000,000,000,000,000 AFN invoice** persisted via
  the extra-class path.
- `fee: "abc"` → `netFee` computed as `null`; the enrollment succeeded (201)
  with `fee_snapshot_json {"baseFee":"abc","netFee":null}`, and with a payment
  attached the **"amount paid cannot exceed the payable fee" guard was
  bypassed** (`99999 > NaN` is `false`; the control with a numeric fee correctly
  returned 400).
- `capacity: 2.5` → the class admitted **3** students (`3 >= 2.5`).

**Root cause** — validation implemented per-route at creation instead of at the
field's boundary, so the update writer was never covered. Reachable by any
`Class.Edit` holder — owner, general manager **and head of department**
(verified).

**Blast radius** — every class; the corrupted value propagates into invoices,
semester fee rows, fee snapshots and the capacity gate.

**Financial impact** — HIGH: fabricated invoice amounts and a bypassed
overpayment guard.

**Security impact** — none (authorized role, invalid data).

**Concurrency impact** — none.

**Existing coverage** — none for `PUT`; `POST` was covered, which is exactly why
the asymmetry survived.

**Remediation** — `PUT` now runs `fee` through the same `assertMoney` boundary
as `POST`. Seat counts (`capacity`, `min_viable_size`) go through a new
`assertSeatCount` in `utils/money.ts` — whole, non-negative, bounded — applied
at **both** writers so they cannot diverge again. Level-pinned fees and
room-pinned capacities are untouched (those branches never read the client
value). `capacity: 0` remains legal: it means "no configured limit" throughout
this codebase (every gate is written `capacity > 0 && …`).

**Mutation evidence** — M4, M5, M6 KILLED.

---

### C-5 — MEDIUM — Class merge destroys operator notes

**Reproduction** — source class with
`notes = "Room booked until March. Do not reuse."` → merge → notes become
`"Merged into … with 1 student(s)."` The original text is gone, with no copy
anywhere.

**Expected** — an administrative action does not silently delete unrelated
operator data (the codebase's own stated principle: "never delete historical
data silently").

**Root cause** — `stmtLinkMergedClass` used `SET notes = ?` instead of
appending.

**Blast radius** — every merged class that carried a note.
**Financial/Security/Concurrency impact** — none.
**Existing coverage** — none.

**Remediation** — the statement now appends the merge line to any existing
note (`CASE WHEN notes IS NULL OR TRIM(notes)='' THEN ? ELSE notes||char(10)||? END`).

**Mutation evidence** — M7 KILLED.

---

### C-6 — HIGH — Paid extra-class enrollment always returned HTTP 500

**Reproduction**
```
POST /api/students/:id/enroll-class {classId: X, amountPaidNow: 3000}
  → 500 {"error":"payment idempotency_key is required"}   (ordinary numeric fee)
POST /api/students/:id/enroll-class {classId: X}          → 201
```

**Expected** — collecting a fee at extra-class enrollment works, and the
payment is idempotent like every other money writer.

**Actual** — the insert passed `idempotency_key = NULL`, which migration 063's
trigger rejects by design. **Every** paid extra-class enrollment failed and
rolled back. The feature was entirely unusable whenever money was involved;
only the unpaid path worked, which is why it was never noticed.

**Root cause** — migration 063 made the key mandatory and updated the call
sites it knew about; this one was missed. Confirmed *not* a side effect of C-3
by a control run against a normal numeric fee.

**Blast radius** — 100% of paid extra-class enrollments. Front-desk staff
collecting a concurrent-class fee received a server error; the operational
workaround (enroll unpaid, then take payment separately) breaks the link
between the enrollment and its receipt.

**Financial impact** — HIGH by unavailability, **not** by corruption: rollback
was clean. Verified zero residue (no enrollment, payment, invoice, ledger row
or roster) and no receipt-sequence burn.

**Security impact** — none. **Concurrency impact** — the missing key also meant
`uq_payments_idempotency` could never arbitrate a double submit on this path.

**Existing coverage** — none: no test exercised this route *with* a payment.

**Remediation** — the payment is keyed `extra-class:<enrollmentId>`.

The first attempt keyed it `extra-class:<studentId>:<classId>`, reasoning from
the route's duplicate-seat rule. **Mutation testing proved that wrong** (M8
survived round 1; see §8.2): a student who enrolls, pays, drops, and later
legitimately re-enrolls in the same class had the second valid payment refused
with 409 — silently destroying billable revenue, the same trap migration 074
documents for the enrollment index. Keying on the enrollment makes the key
unique per real financial event and keeps it traceable to it.

Double-submit protection does not rely on this key: it comes from
`assertNotAlreadySeatedInClass` backed by `uq_enrollment_active_seat_per_class`.

Verified: 201, exactly one payment, one income row, API == DB == ledger; 5
concurrent submits → exactly 1×201 + 4×409 with 1 payment / 1 income row;
enroll→pay→drop→re-enroll→pay → 2 payments, 2 distinct keys, 4,000 income.

**Mutation evidence** — M8 KILLED (round 2, after the key was corrected).

---

### C-7 — MEDIUM — `GET /api/classes` accepts pagination parameters and ignores them

**Reproduction** — with 326 classes, `GET /api/classes?limit=10` returned **all
326** rows.

**Expected** — either honour the parameters or reject them; silently ignoring
them makes any paging client operate on a false premise.

**Root cause** — the endpoint never parsed `limit`/`offset`.

**Blast radius** — any client that believes it is paging; unbounded response
growth as the academy grows.
**Financial impact** — none. **Security impact** — none (branch scoping was
correct and remains verified). **Concurrency impact** — none.

**Remediation** — the window is applied **only when explicitly requested**, plus
`?includeTotal=1` for an authoritative total. The default deliberately stays an
unbounded bare array: the workspace store (`apiStore.ts`) fetches `/classes`
once and filters client-side, so introducing a default page here would silently
truncate that view — trading an honest unbounded read for silent data loss,
which is strictly worse. Verified: `?limit=10` → 10 rows; offset paging has no
overlap or gaps; `includeTotal` matches the full count; hostile limits
(`-1`, `0`, `abc`, `99999999`) cannot unbound the query; pages stay
branch-scoped.

**Mutation evidence** — M9 KILLED.

---

## 5. Rejected hypotheses (investigated, not defects)

| # | Hypothesis | Evidence |
|---|---|---|
| RH-1 | Capacity gate is racy (TOCTOU) | 6 concurrent enrollments into a 1-seat class → `[201,409,409,409,409,409]`, 1 seat. Re-checked under the write lock. **Not a defect.** |
| RH-2 | Concurrent merges double-move a roster | src→d1 = 200, src→d2 = 409; d1 = 2 seats, d2 = 0. **Correct.** |
| RH-3 | Merge over-fills the target | Refused with the exact free-seat count; capacity counts DISTINCT students. **Correct.** |
| RH-4 | Merge can create a cycle | A→B then B→A refused ("Target class must be active"). Chains are recorded truthfully. **Correct.** |
| RH-5 | Cross-branch users can act on a class | Every writer 403 for a branch-B registrar/manager; cross-branch merge and create-into-other-branch both 403; list returns 0 rows. **Correct.** |
| RH-6 | Teachers can mutate their own class | Teacher: edit/capacity/cancel all 403, lifecycle read 200. Object-level check present. **Correct.** |
| RH-7 | `PUT` can change a class's branch | Ignored; `branch_id` unchanged. **Correct.** |
| RH-8 | `PUT status=cancelled` bypasses the lifecycle guard | Routed through `ClassLifecycleService` (400 without a reason; 409 on an invalid transition). **Correct** — and it now inherits the C-1 guard too. |
| RH-9 | Merge violates the duplicate-seat unique index | Colliding dual seat → clean 409, no partial state. **Correct.** |
| RH-10 | Teacher assignment accepts inactive/cross-branch teachers | 400 / 400 / 404. **Correct.** |
| RH-11 | Waitlist conversion ignores class lifecycle | 409 "Selected class is not active." **Correct.** |
| RH-12 | List `enrolled` count drifts from the authoritative predicate | Matches `countActiveStudentsInClass` exactly (pending counted, dropped not). **Correct.** |
| RH-13 | Failed class operations leave financial residue | Verified zero residue on the C-6 failure and on the refused overpayment. **Correct.** |

---

## 6. Residual risks (documented, not remediated)

- **RR-1 — `merged_into_id` has no foreign key and no reader.** A merge chain
  (A→B→C) leaves A pointing at the cancelled B rather than the surviving C, and
  nothing in the codebase reads the column. Harmless today; noted so a future
  reader does not assume it resolves to a live class. Adding an FK would require
  a table rebuild for no current benefit.
- **RR-2 — Six lifecycle stages project to `status='active'`.** A class in
  `scheduled`, `enrollment_closed`, `suspended` or `grading` accepts new
  enrollments, because every enrollment writer gates on the coarse legacy
  projection. This is the documented design of `deriveLegacyClassStatus`;
  tightening it would change Enrollment-path behaviour, which is **frozen**.
  Flagged as the highest-value candidate for the next subsystem pass.
- **RR-3 — `stmtDeleteSessionsForClass` is a dead writer.** Declared in
  `classes.routes.ts` and never invoked; the delete route refuses (409) before
  reaching it whenever sessions exist, so it is unreachable. Left in place: its
  removal is cosmetic and this audit's remit is not to churn unrelated code.
- **RR-4 — Capacity may be shrunk below the current roster.** `PUT` allows
  capacity 5→1 with 3 seated. No over-admission results (further enrollment is
  correctly refused at 409) and the honest over-subscribed state is visible in
  the list. Whether shrinking below the roster should warn is a business
  decision (see below), not a correctness defect.
- **RR-5 — Cancelling a class does not settle outstanding obligations.** With
  the C-1 guard in place a class can only be cancelled once its roster is
  drained, so a stranded obligation can no longer be created by cancellation.
  Whether an already-issued invoice should be voided when a class is cancelled
  is a business decision.

## 7. Insufficient business decisions (STOP — not guessed)

1. **Should cancelling a class automatically void or credit outstanding
   invoices for its students?** No existing behaviour, test or document
   establishes an answer, and either choice moves money. Not implemented; the
   C-1 guard makes the operator resolve each enrollment explicitly first, which
   is the conservative option.
2. **Should reducing capacity below the current roster be blocked or merely
   warned?** No precedent exists either way; the current over-subscribed state
   is honest and non-corrupting. Left as-is.

---

## 8. Mutation testing (Phase 10)

`server/scripts/class-mutation-test.mjs` — 18 mutants, each removing exactly one
critical invariant, each requiring the full suite to fail.

Covered: C-1 roster-drain guard and its seat predicate; C-2 merge gender gate
and the shared admission rule; C-3 fee and capacity validation and seat
integrality; C-5 note preservation; C-6 payment idempotency; C-7 pagination
window; plus the pre-existing capacity gate, duplicate-seat guard, branch
isolation, teacher object-level authorization, merge capacity check, merge
transaction boundary, canonical seat predicate and delete guard.

### 8.1 Harness correctness (two traps caught and closed)

Mutation testing is only meaningful if "suite fails" really means "the mutant
was detected". Two ways that can silently be false were hit during this audit
and are now structurally prevented:

1. **Red baseline.** If the suite already fails on unmutated code, *every*
   mutant is reported KILLED and the run is worthless. This actually happened
   (leftover forensic probe files carried failing tests). The harness now
   **verifies the unmutated baseline is green and aborts (exit 2) if it is
   not.**
2. **Mutation residue.** A harness killed mid-run left exactly one mutant (M7,
   `CASE WHEN 1=1`) in the source tree, which later surfaced as a mysterious
   failing test. The harness now restores on `exit`/`SIGINT`/`SIGTERM`/
   `SIGHUP`/`SIGQUIT`/`uncaughtException`/`unhandledRejection`, and
   **verifies after each mutant that the restore actually landed**, aborting
   (exit 3) if not. A residue scan is also part of the final gate.

### 8.2 Round 1 — 15/18 killed, 3 survived (STOP invoked)

Per the stop rule, remediation halted and each survivor was investigated rather
than explained away.

- **M8 SURVIVED — and exposed a real regression in my own fix.** The C-6
  remediation initially keyed the payment on `(student, class)`. Mutation
  testing showed no test constrained the key's *shape*; probing then proved the
  key was **wrong**: a student who enrolls, pays, **drops**, and later
  legitimately re-enrolls in the same class had the second, entirely valid
  payment refused with 409 — silently destroying billable revenue, the exact
  failure mode migration 074 documents for the enrollment index. **Fixed:** the
  key is now `extra-class:<enrollmentId>`, unique per real financial event.
  Double-submit protection never depended on it — it comes from the
  duplicate-seat guard backed by `uq_enrollment_active_seat_per_class`
  (verified: 5 concurrent submits → 1×201, 4×409). Two tests added: the
  legitimate re-enrollment-after-drop flow (two payments, two distinct keys,
  4,000 income) and the key's exact derivation.
- **M12 SURVIVED — pre-existing branch isolation had no direct test.** The
  guard in `requireClass()` was correct at 1567004 (cross-branch writers were
  observed returning 403), but nothing would have failed if it were deleted.
  Coverage added: a foreign-branch manager is refused on edit/capacity/fee/
  cancel/suspend/delete with the class row byte-identical afterwards, on
  cross-branch reads, and on a cross-branch merge target.
- **M17 SURVIVED — pre-existing delete guard had no direct test.** Same
  situation. Coverage added for all three seat-consuming statuses (active,
  confirmed, pending) plus the negative case (closed history still deletable).

No test was weakened at any point. Round 2 results: see §10.

---

## 9. Files changed

| File | Change |
|---|---|
| `server/src/core/academic/class-lifecycle-service.ts` | C-1 roster-drain guard at the single transition authority |
| `server/src/routes/classes.routes.ts` | C-2 merge gender gate; C-3 fee/capacity validation on both writers; C-5 note append; C-7 pagination |
| `server/src/routes/students.routes.ts` | C-6 extra-class payment idempotency key |
| `server/src/utils/money.ts` | new `assertSeatCount` boundary |
| `server/src/tests/class-subsystem-remediation.test.ts` | 61 regression/adversarial tests (new) |
| `server/scripts/class-mutation-test.mjs` | mutation harness (new) |
| `docs/CLASS_SUBSYSTEM_AUDIT_2026-08-18.md` | this report (new) |

No migration was required: every remediation is an application-layer guard at an
existing single authority. No historical data was deleted, rewritten or
reconciled.

---

## 10. Final gate results

| Gate | Baseline (`1567004`) | After remediation |
|---|---|---|
| Backend tests | 1320 / 1320 | **1381 / 1381** (114 files, +61 new, 0 regressions) |
| Backend lint + typecheck | PASS (0 errors) | **PASS** (0 errors, 108 pre-existing warnings) |
| Frontend typecheck | PASS | **PASS** |
| Frontend lint | PASS (6 warnings) | **PASS** (6 pre-existing warnings) |
| Frontend build | PASS | **PASS** |
| Backend build | PASS | **PASS** |
| Fresh-schema preflight | 73 migrations, no drift | **73 migrations, no drift** |
| Release validation | 16 / 16 | **16 / 16 PASSED** |
| Mutation testing | n/a | **18 / 18 KILLED, 0 survived** (exit 0) |
| Mutation residue scan | n/a | **CLEAN** |

Reproduce with:

```bash
npm run release:validate
cd server && node scripts/class-mutation-test.mjs   # expects 18/18 KILLED, exit 0
```

No migration was added, so the migration count is unchanged at 73 and there is
no drift. No historical data was deleted, rewritten or reconciled.

**Enrollment subsystem remains FROZEN at 1567004.** No Enrollment file was
modified. C-6 touches `students.routes.ts`, which is a Student-subsystem file
hosting a Class-admission writer; the change is a one-line idempotency key on a
class-enrollment payment and does not alter any Enrollment-service behaviour,
lifecycle transition or Enrollment contract. All Enrollment regression suites
(including `enrollment-subsystem-remediation.test.ts`) pass unchanged.
