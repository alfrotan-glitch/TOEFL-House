# Academic Domain Audit — Findings Report

**Branch:** `arena/01a07ac5-toefl-house` · **HEAD:** `8b20ba5`
**Verification constraint:** No PHP runtime in this environment — all findings are by static inspection. The test suite was **not** executed here.

---

## 0. Scope & what this report covers

This is the completed read of the full **Academic** surface (commands, domain, models, migrations, SQL guards, lifecycle rules, waitlist, teacher/room/skill, placement, concurrency, and tenant isolation) plus cross-checks into Enrollment, Scheduling, and the Academic HTTP/Console test fixtures.

The three **app-layer fixes + migration `000190` + regression test** that were previously frozen as the accepted baseline are **verified correct** and are the only uncommitted production changes. This report **confirms** that baseline and then records the additional findings from the full audit. It does **not** modify production code beyond that baseline.

---

## 1. Frozen baseline (verified, keep)

These remain complete, correct, and uncommitted:

| Artifact | Purpose | Verified |
|---|---|---|
| `app/Modules/Academic/Commands/ManageAcademicOffering.php` | `resizeCapacity` rejects `academic.offering_capacity_below_class` when `capacity < max(class.capacity for offering_id)` (guard added before the live-claims check). | ✅ guard present at `:180`–`:186`; ordering correct (capacity-positive → class-bound → live-claims). |
| `database/migrations/2026_09_07_000190_guard_offering_capacity_against_class_capacity.php` | SQL boundary trigger `academic_offering_capacity_class_bound_guard` on `offerings` `BEFORE UPDATE OF capacity`: rejects `NEW.capacity < max(classes.capacity)`. | ✅ trigger + `down()` present. Deliberately adds only the class-capacity bound (live-claim floor is independently owned by `000160`'s `academic_offering_capacity_guard`); no shadowing. |
| `app/Modules/Academic/Commands/MaintainEnrollment.php` | `transfer` now: locks source, checks source-branch capability, **derives/validates the target class's offering** (never born offering-less), checks receiving-branch capability before the same-class rejection, always binds the resolved offering + `originating_branch_id = receivingBranchId`. | ✅ diff clean; receiving-branch check fires before `academic.transfer_same_class` so authority is never masked. |
| `tests/Feature/Academic/OfferingCapacityClassBoundTest.php` | Self-contained regression (own offering cap 10 / class cap 8, distinct branch/level/period). Asserts shrink-to-7 rejected (`academic.offering_capacity_below_class`), exact-match-8 settles, grow-to-12 settles. | ✅ internally consistent; does **not** rely on the inconsistent shared fixture. |

**Confirmed authoritative invariant** (per user): `class.capacity <= offering.capacity`. The class-bound resize guard + migration `000190` are correct and must be kept. Any fixture creating `class.capacity > offering.capacity` is wrong and must be fixed, not production relaxed.

---

## 2. Candidate gaps — verification verdicts

### 2.1 `MaintainRoom::resize` — shrinking below scheduled session seats
**Verdict: NOT a standalone invariant gap (already covered elsewhere).**

`MaintainRoom::resize` (`app/Modules/Academic/Commands/MaintainRoom.php:111`) only enforces `capacity >= 1` and an "unchanged" rejection. It does **not** compare against scheduled-session seat count. **However**, the DB guard in `000132` (`academic_rooms_lifecycle_guard`) already blocks room lifecycle → `maintenance`/`retired` while any future `class_sessions.room_id` references it. A shrink in capacity does **not** orphan references (room capacity is metadata, not an FK target for seat counts), so there is no integrity violation requiring a new guard. If a product rule requiring `room.capacity >= session enrollments` is desired, it belongs in a product spec and should be a new explicit check + trigger — but nothing today is corrupted by a resize. **No change as part of this audit.**

### 2.2 `MaintainSkill::retire` — no DB guard on referenced skills
**Verdict: by design; leave.**

`MaintainSkill::retire` (`app/Modules/Academic/Commands/MaintainSkill.php:67`) does not check references. `skills_catalog_guard` (`000090`) only blocks `DELETE` and `key` mutation and a retired-skill mutation. But the **delivery** side is guarded: `class_sessions_skill_delivery_guard` (`000094`) rejects scheduling a session with a non-`active` skill, and `MaintainTeacherAssignment::assignSkill` requires an `active` catalog skill. So a retired skill cannot be newly delivered/attributed, and historical attribution remains immutable (append-only). Retirement is semantics-preserving, not destructive. **No change.**

### 2.3 `ClassSection` capacity not bounded by parent class capacity
**Verdict: possible over-provisioning, but not a lifecycle/integrity violation.**

`defineSection` (`app/Modules/Academic/Commands/MaintainClass.php:288`) only enforces `capacity >= 1`; `class_sections_capacity_check` (`000132`) enforces `capacity > 0`. A section can be declared larger than its parent class, or the sum of section capacities can exceed the class capacity. Sections are sub-grouping attributes for the timetable (the `000132` guards bind a session to an open section of the same class); they are **not** independently capacity-bound at enrollment time (enrollment binds to the class, not the section). So this does not allow over-enrollment past the class capacity. Flagged as a **design note** (a "sections must not exceed class capacity" rule may be desirable), but it is not an integrity bug. **No change.**

### 2.4 `defineClass` null-offering path
**Verdict: RESOLVED — there is NO null-offering path.**

`MaintainClass::defineClass` (`app/Modules/Academic/Commands/MaintainClass.php:55`) resolves an offering via `resolveClassBranch` → offering query and **always** requires one:

```php
if ($offering === null) {
    throw BusinessRejection::forCode('academic.class_offering_required', ...);   // line 90
}
if ($offering->capacity < $capacity) {
    throw BusinessRejection::forCode('academic.class_capacity_exceeds_offering', ...);  // line 93
}
```

So the earlier hypothesis of a "legacy/integration null-offering path" is **false**: every new class is born offering-bound and capacity-bounded. **This is correct production behavior under the authoritative invariant.** The consequence is behavioral (see §3), not a production bug.

### 2.5 `scheduleSession` passes `scheduled_on` as a date string, not a Carbon value
**Verdict: NOT a bug.**

`MaintainClass::scheduleSession` stores `'scheduled_on' => $scheduledOn->startOfDay()->toDateString()` (`:269`). The column is a `date` (`000035`), the model has no `$casts` on `scheduled_on`, and every read/comparison in `SchedulingConstraints` and the `000132` guards uses the `YYY-MM-DD` string form. A date string is the correct value for a `date` column; passing a Carbon object would be inert. **No change.**

---

## 3. Major finding — systemic fixture incompatibility with `defineClass` since `000160`

This is **the** substantive discovery of the full audit and **corrects** the prior plan to "just raise the offering capacity in two fixtures."

### 3.1 Root cause

- Migration `000160` ("converge academic class authority") and `MaintainClass::defineClass` require every new class to bind an **offering**, and require `class.capacity <= offering.capacity`.
- `defineClass` also requires a **branch** that the actor can resolve; `resolveClassBranch` (`:169`) throws `academic.class_branch_ambiguous` if the actor has **not exactly one** visible branch.

### 3.2 Fixture inventory (defineClass call sites vs. availability of an offering/branch)

The following Academic/Console/Api tests call `defineClass` (often in the 5-arg form `defineClass($actor, $programVersionId, $periodId, $capacity, $idem)`) **without** opening an offering, seeding a level, or attaching a branch:

| Test file | `defineClass` | `openOffering` | `defineLevel` | branch attached |
|---|---|---|---|---|
| `AcademicDecisionFeatureTest` | 1 | 0 | 0 | 0 |
| `AcademicDeliveryFeatureTest` | 3 | 0 | 0 | 0 |
| `AcademicEligibilitySnapshotFeatureTest` | 1 | 0 | 0 | 0 |
| `AcademicRoomsAndSectionsFeatureTest` | 1 | 0 | 0 | 2 |
| `AcademicScheduleApiTest` | 2 | 0 | 0 | 0 |
| `AppealResolutionSemanticsTest` | 2 | 0 | 0 | 2 |
| `AssessmentWorkflowFeatureTest` | 1 | 0 | 0 | 0 |
| `ClassTerminalGuardFeatureTest` | 2 | 0 | 0 | 0 |
| `EnrollmentCompletionLifecycleFeatureTest` | 1 | 0 | 1 | 0 |
| `EnrollmentFinancialGateFeatureTest` | 1 | 0 | 1 | 0 |
| `GradesheetWorkflowFeatureTest` | 1 | 0 | 0 | 0 |
| `GraduationIntegrityFeatureTest` | 1 | 0 | 0 | 0 |
| `GraduationWorkflowFeatureTest` | 1 | 0 | 0 | 0 |
| `ProgressionLifecycleConsoleTest` | 1 | 0 | 0 | 0 |
| `SkillFeatureTest` | 2 | 0 | 0 | 0 |
| `TranscriptIssuanceFeatureTest` | 1 | 0 | 0 | 0 |
| `TransportWorkflowFeatureTest` | 1 | 0 | 0 | 0 |
| `AcademicAppealWorkflowFeatureTest` | 1 | 0 | 0 | 0 |

Tests that **do** open an offering (and are internally consistent): `AcademicOfferingAndWaitlistFeatureTest` (4, but **capacity-inconsistent**, see §3.3), `BranchIsolationAdversarialTest` (3, **capacity-inconsistent**, see §3.3), `LevelProgressionFeatureTest`, `OfferingCapacityClassBoundTest`, `OfferingOperationsConsoleTest`, `WaitlistOperationsConsoleTest`.

### 3.3 The two "capacity-inconsistent" fixtures — and why the prior plan is insufficient

- **`AcademicOfferingAndWaitlistFeatureTest::setUp()`** opens offering **capacity 1**, then `defineClass(..., capacity 2, levelId)`. This violates `class.capacity (2) <= offering.capacity (1)` → `defineClass` throws `academic.class_capacity_exceeds_offering` at setup.
- **`BranchIsolationAdversarialTest::setUp()`** opens offering **capacity 4**, then `defineClass(..., capacity 8, levelId)`. Same violation.

**Why "just raise the offering capacity" does not work:** the rest of `AcademicOfferingAndWaitlistFeatureTest` is written *against* the old (no-invariant) behavior where `offering.capacity (1) < class.capacity (2)` is what makes `academic.offering_full` fire while the class still has room (`test_enrollment_targets_only_an_open_matching_offering_and_counts_against_offering_capacity`, around `:176`) and drives the waitlist join/offer semantics (`:211`–`:228`). If you bump the offering to 2, those tests stop exercising the `offering_full`/`waitlist_offering_full` path because the class (capacity 2) fills at the same rate as the offering (capacity 2), and the class is validated first, so `class_full` fires instead. The tests are **semantically incompatible with the authoritative invariant**, not merely carrying a stale number.

**Correct resolution (requires redesign, not a number change):** to keep exercising "offering capacity is the binding constraint even when a class still has room," the fixture must share **one** offering across **two** classes (e.g., offering cap 3, two classes cap 2 each). Then one class can be full while the offering is exhausted by the other class, and `offering_full` still binds with a specific class having room. That is a structural fixture rewrite, gated by a runtime to confirm it stays green.

### 3.4 What this means

At HEAD, a large fraction of the Academic feature/console/api tests that exercise class creation are red because they were written for a pre-`000160` `defineClass` that accepted classes without an offering/branch. This is a **pre-existing** condition (present at the branch base `091ab38`), **not** introduced by the frozen baseline. The production code is correct; the fixtures are stale.

> **Recommendation:** The fixture reconciliation is a sizable, separated piece of work (either (a) add `openOffering` + `defineLevel` + `attachBranchToBootstrapOrganization` to each of the ~18 fixtures and move their classes onto the opened offering, or (b) build named test helpers that open an offering + create a class in one call). It must be validated under a PHP test run — it cannot be safely "blind-fixed" here, and the two capacity fixtures additionally require structural redesign (§3.3).

---

## 4. Verified production behavior (no defects found)

These were audited and are **correct**:

- **Class lifecycle** (`MaintainClass::transition`): `planned→published|cancelled`, `published→active|cancelled`, `active→completed|cancelled`, cancelled/completed→archived, archived terminal. Activation requires a current canonical teacher assignment; cancel/complete fail-closed on open seats and future sessions (`assertNoOpenSeats` + future-session guard).
- **Schema guard chain** (`000034`,`000037`,`000108`,`000131`,`000132`,`000160`,`000190`): enrollments born `requested`; student active; class active; one-open-seat unique `(student,class)`; no in-place class move; active→terminal validates capacity; offering immutable on enrollment + class branch/period/level match; class/offering/period close fail-closed on open seats; waitlist unique `(class_id,student_id)`/`(class_id,position)`, identity/position immutable, `offered→enrolled` only.
- **`enrollments_offering_guard`** (`000131`): offering_id immutable; unknown offering FK; INSERT needs open offering; offering matches class period/level/branch; capacity enforced only on UPDATE→active.
- **Rooms/sections/timetable** (`000132`): `academic_rooms_lifecycle_guard`, `class_sections_lifecycle_guard` (open-on-active-class + block terminal on future sessions), `class_sessions_timetable_guard` (room available + no room overlap; section open + same class + no section overlap; no whole-class overlap), `class_sessions_timetable_identity_guard` (room_id/section_id/scheduled_on/starts_at/ends_at immutable on update).
- **`SchedulingConstraints`**: session only on active class, published period, date in period, `HH:MM` end > start, class branch provenance, skill active, section belongs to class and open, room available same branch, then `TeacherAuthority`.
- **`TeacherAuthority`/`MaintainTeacherAssignment`/`MaintainTeacherProfile`**: `assertAssignable`, `assertClassCanDeliver`, `assertSkillAuthority`, `assertProfileOperational`, `assertBranchAuthorization`, `assertAvailability`, `assertWorkload`, `assertNoTimetableConflict`; append-only skill attribution; handover/end/extend windows validated.
- **`MaintainEnrollment`**: request/activate/freeze/unfreeze/withdraw/complete/transfer with correct lock ordering (class then enrollment), `FinancialCoverageLock`, gate-envelope binding, completion evidence (`assessment_result` released + bound to seat, or `progression_decision` approved + student/class match), `currentEligibilitySnapshotId` (v2/placement-linked only).
- **Waitlist** (`ManageClassWaitlist`): join only when class **or** offering full; offer/promote require freed seat; promote creates a seat through `MaintainEnrollment::request` (never a silent active seat); withdraw/expire terminal.
- **Placement**: `PlacementAntiTamper` HMAC over canonical evidence; `AcademicEligibilitySnapshotBuilder` produces signed `academic-context-snapshot-v2` excluding class/offering (level eligibility only); `RecommendPlacement` binds one submitted lineage-v2 attempt, computes weighted overall, rounds 2dp, CEFR-bands from rank ≥ 0.
- **Progression/level (`000135`)** and **completion (`000136`)** guard chains: no self/cycle prerequisites, same program version, facts immutable, completion evidence pair-checked.
- **Transcript/graduation/certificate issuance**: freeze canonical payload + SHA-256, register + submit managed Document, store immutable row; eligible graduation approval + certificate issuance call `assertNoOpenSeats`.
- **`RecordBranch`/tenant isolation**: re-reads authoritative rows, null on unknown (fail-closed), first-hit-wins; `AcademicAccess` → `BranchScopedAccess` for delivery, global for curriculum/governance.

No TODOs/FIXMEs were found in the Academic/Scheduling/Enrollment module code; all Academic models declare `$fillable`.

---

## 5. Known unresolved issues (out of Academic scope)

- **Finance opening-state gap** (approved `teacher_salary_payable`/`other_receivable`/`other_payable` never materialized to GL) is a Finance-domain concern; not folded into this Academic work.
- **`ClassSection` capacity vs. class capacity** (§2.3) and **`MaintainRoom::resize` vs. scheduled-session seat count** (§2.1) are product-policy notes, not integrity bugs; no change made.

---

## 6. Recommended next actions

1. **Keep** the frozen baseline (4 artifacts in §1). Do not relax the authoritative invariant.
2. **Do not** implement §3.3 by a bare number bump — it breaks the semantic intent of `offering_full`/`waitlist_offering_full`. Redesign the two fixtures to share one offering across multiple classes, verified under a runtime.
3. **Reconcile** the ~18 stale fixtures in §3.2 (and the console/api siblings) by wiring real offerings/levels/branches before `defineClass`, ideally via a shared helper. Requires a PHP test run to confirm green.
4. Deciding whether to add the §2.1/§2.3 product-capacity rules should be a separate, explicit design decision with their own tests.
