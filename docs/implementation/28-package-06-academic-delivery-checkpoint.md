# Package 06 Checkpoint — Academic Delivery

**Package:** 06 — Academic Delivery (sequence row "Academic delivery": programs, classes, scheduling, attendance, placement of the enrollment deferred from Package 05)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 05 checkpoint (`27-package-05-students-admissions-checkpoint.md`) at commit `4a09b52` — reused after a full sandbox reset through the committed recovery mechanism (see Discover)

## Discover

- The platform reset the sandbox: local git was rewound to `368eef3` with the P02–P05 content present only as uncommitted files, `/opt/th` toolchain and `vendor/` were gone. Recovery followed the sanctioned mechanism only: working tree verified byte-identical to remote tip `4a09b52` (stash → `reset --hard FETCH_HEAD` → empty diff → drop), then `docs/environment/P02-environment-recovery.sh --recover` rebuilt the toolchain from the digest-verified release artifacts (now at `/home/user/toolchain`). Post-recovery: full regression **OK (179 tests, 657 assertions)** and `--verify` → **ENVIRONMENT VALID** before any new work. No rebuild beyond the committed script; no dependency change.
- Governance inputs consumed: lifecycle registry (foundation 32 Class/Session and Enrollment/Membership rows), academic lifecycle rules (foundation 22: published program/level/period history is never silently rewritten; corrections create attributable correction history), authority registry (foundation 33 withdrawal/suspension row and the separate-facts rule), relationship registry (foundation 31: Enrollment↔Program/Period, Class↔Session 1:N, Class↔Teacher N:M dated, attendance = student+session), entity registry (foundation 29), command registry (implementation 03 schedule/assign/attendance-correct family), module contracts (implementation 04).

## Map (implemented scope)

- **Academic structure**: `Program` (draft→published via first version publication; archived terminal) with **immutable published versions** (`ProgramVersion`, append-only DB trigger; corrections are new versions); `AcademicPeriod` (draft→published→closed, period CHECK; published periods are the only valid class hosts).
- **Class/Session**: `ClassModel` on `classes` (published program version + published period + positive capacity) with the registry lifecycle `planned→published→active→completed→archived`, `cancelled` reachable from planned/published/active preserving the record; **activation requires at least one open teacher assignment**. `ClassSession` (date + time window CHECK) schedulable only on active classes. `TeacherAssignment` effective-dated, one open assignment per teacher per class (partial unique index); substitution is a separate assignment.
- **Enrollment** (the fact deferred from Package 05 — its owning module now exists): `requested→active` under the **separate approval capability** (`academic.enroll_approve`); `active→frozen|transferred|withdrawn|completed`, `frozen→active|withdrawn`. **Capacity invariant** enforced under row lock at activation and transfer (count of active seats < capacity). **No duplicate active seat** — domain check plus partial unique index `enrollments_one_active_seat`. **Transfer closes the old enrollment as `transferred` and opens a new `requested` row in the target class** under the same invariants; same-class transfer rejected. Enrollment requires the student's *current* status to be `active` (reads the append-only status history).
- **Attendance**: `AttendanceFact` — append-only facts (DB trigger) tied to a session and an **active enrollment of that session's class**; corrections append a linked row (`corrects_id`) with a **mandatory reason**, targeting a fact of the same enrollment; the original is never rewritten.
- **Queries**: `ClassRosterQuery` — read-only roster (active/frozen seats, active seat count vs capacity, open teacher assignments).
- Persistence: 8 migrations (`2026_08_26_000031`–`000038`) owned solely by the Academic module; CHECK constraints (program/class/enrollment states, period windows, session time windows, teacher assignment periods, attendance statuses, positive capacity); partial unique indexes (one open teacher assignment per class+teacher, one active seat per student+class); append-only/immutability triggers on `program_versions` and `attendance_facts`.
- Capabilities through the canonical resolver: `academic.structure`, `academic.schedule`, `academic.enroll`, `academic.enroll_approve`, `academic.attendance`.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 184 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (193 tests, 732 assertions)** |
| integration tests | PASS | structure/class/enrollment/attendance chains against PostgreSQL atomically (7 feature tests + 2 unit suites) |
| invariant tests | PASS | capacity under lock; no duplicate active seat (domain + partial index); one open teacher assignment; immutable program versions; append-only attendance (model + raw SQL vs trigger); CHECK-constrained states/windows/statuses |
| authorization tests | PASS | clerk cannot activate seats (approval capability separate); unprivileged structure definition denied with audit and no row |
| lifecycle tests | PASS | class chain incl. cancellation preserving record and teacher-required activation; enrollment chain incl. transfer closing the old row; frozen/terminal paths fail closed |
| capacity/evidence tests | PASS | third activation into capacity 2 rejected with seat left `requested`; attendance evidence carries correction chain with reason |
| financial tests | NOT APPLICABLE | no financial module in Package 06 scope |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (enrollment/teacher indexes; program-state and attendance-status CHECK vectors); dev database migrated to all 38 migrations |
| contract verification | PASS | universal command contract; only Academic writes academic persistence; Students boundary consumed read-only (current status), never mutated |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair; post-recovery baseline regression green before any new work |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Program version tampering — raw SQL `UPDATE program_versions` rejected by the trigger.
2. Attendance tampering — raw SQL `UPDATE attendance_facts` (flipping status) rejected by the trigger.
3. Correction without reason / correction targeting another enrollment's fact — rejected.
4. Attendance on a frozen enrollment — rejected (`academic.attendance_enrollment_not_active`).
5. Planned→active class shortcut and teacher-less activation — rejected.
6. Session scheduling on a non-active class — rejected.
7. Clerk (requester) activating a seat — denied (approval capability), audited.
8. Duplicate seat (requested/active/frozen) for the same student and class — rejected.
9. Capacity overflow at activation and at transfer — rejected under lock; the seat stays `requested`.
10. Same-class transfer — rejected; frozen→transferred shortcut — rejected.
11. Enrollment of a suspended/withdrawn student — rejected (current-status check).
12. Unprivileged structure definition — denied with audit evidence and no row.

Defects found by verification and repaired (each followed by full-suite regression): a self-referencing foreign key on `attendance_facts.corrects_id` unbuildable on the char(36) primary key in PostgreSQL (removed — the correction chain integrity is domain-enforced: same-enrollment validation in the command, plus the append-only trigger); missing table-name override on `ClassModel` (`class_models` → `classes`); two test-side expectation-ordering defects; an unused parameter removed during review.

## Independent review

Reviewed against the contracts as a separate pass. Recorded reviewed decisions (not silent, per directive §22):

1. **Enrollment delivered here** — Package 05 decision #1 executed as recorded: enrollment belongs to Academic Delivery, whose owning tables now exist.
2. **`transferred` is terminal by design** — a transfer creates a *new* enrollment row in the target class; reopening the transferred row would duplicate identity of the participation fact and blur history.
3. **Capacity counted over `active` seats only** — `requested` and `frozen` seats do not consume delivery capacity; a frozen seat is unfrozen through `frozen→active`, which re-checks capacity under the same lock.
4. **Attendance correction chain is domain-validated, not FK-chained** — PostgreSQL cannot build the self-referencing FK on the bpchar primary key; the command validates that the corrected fact belongs to the same enrollment, and the append-only trigger makes both rows immutable evidence.
5. **Placement/scoring and assessment decisions are NOT in this package** — the sequence row names them, but they are the *Academic decisions* package (moderation/progression/appeal/certification) with its own contracts; only the delivery fabric (programs, classes, sessions, teachers, enrollment, attendance) is delivered here.
6. **Financial gates NOT APPLICABLE with reason** (no financial module yet).

## Clean handoff

- Working tree contains only this package's artifacts; `.gitignore` unchanged; dev database `toefl_house` migrated to 38 migrations, 0 rows; recovery verify **ENVIRONMENT VALID** after the reset-recovery; release artifacts untouched.

## Certification

All gates PASS (or NOT APPLICABLE with recorded reason). Package 06 — Academic Delivery is **CERTIFIED** at this checkpoint. Certified cumulative suite: **OK (193 tests, 732 assertions)**; phpstan level 6 clean; pint clean (184 files).
