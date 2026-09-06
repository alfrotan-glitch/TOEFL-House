# Package 05 Checkpoint — Students and Admissions

**Package:** 05 — Students/Admissions (sequence row "Students/Admissions")
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 04 checkpoint (`26-package-04-documents-privacy-checkpoint.md`) at commit `a1c8654` — reused, not restarted

## Discover

- Environment reused exactly as certified (`--verify` → **ENVIRONMENT VALID**; `composer.lock` untouched).
- Governance inputs consumed: entity registry (foundation 29: Visitor/Applicant/Admission Decision → Admissions; Student/Student Status with history → Students; Guardian Relationship → People/Students), lifecycle registries (foundation 32 Student/Admission and Guardian rows), relationship registry (foundation 31: Person↔Student 1:0..N no silent merge, Student↔Guardian N:M verification required, Student↔Admission 1:N prior decisions retained), authority registry (foundation 33: Admissions chain Reception/Admissions → Academic/Admissions → policy owner, forbidden Reception-only permanent conversion; withdrawal/suspension/reactivation row), boundary contracts (foundation 43: Identity→Admissions rejects unverified identity; Admissions→Students/Academic/Finance approved admission facts, no downstream activation without approval), command registry (implementation 03 apply/admit/convert family), module contracts (implementation 04).

## Map (implemented scope)

- **Admissions module** (`app/Modules/Admissions`):
  - `Applicant` — a verified person with a program interest; one open admission file per person; lifecycle `prospect→applicant→admitted|rejected`, `rejected→applicant` (new decision).
  - `DecideAdmission` — the three-role authority chain of registry 33 (initiator `admissions.initiate`, reviewer `admissions.review`, approver `admissions.approve`), **three distinct actors enforced**; reason and evidence mandatory; decision rows append-only (DB trigger) with the full chain recorded; prior decisions retained.
  - `EnrollAdmittedApplicant` — applicant/student conversion in **one transaction** (student + initial `active` status + audit; rollback leaves nothing): only an `admitted` applicant, only once per admit decision, one student per person, person identity must remain verified.
- **Students module** (`app/Modules/Students`):
  - `Student` — exactly one per person (partial unique index), created only by conversion; student code unique.
  - `StudentStatus` — **append-only status facts** (DB trigger; immutable rows); the current status is the latest row (deterministic `seq` ordering); registry transitions `active→suspended|withdrawn|completed`, `suspended|withdrawn→active` (**reactivation only with the separate approval capability** `students.reactivate`), `completed→alumni`, terminal `alumni`; every transition requires a reason and is audited; **no silent status overwrite** — history only accumulates.
  - `GuardianRelationship` — effective-dated, recorded `unverified`, explicit verification step, revocation retains history; **only verified, effective, active relationships carry their relationship-specific permissions**; one open row per (student, guardian, relationship); a student cannot be their own guardian (this delivers the guardian access deferred from Package 04's decision #1).
  - `StudentRecordQuery` — read-only: effective status as of a day (latest fact ≤ day) and currently-effective verified guardians with permissions.
- Persistence: 5 migrations (`2026_08_26_000026`–`000030`) owned solely by these modules; CHECK constraints (applicant states, decision outcomes, status values, guardian verification/lifecycle states); `students_one_per_person` and `guardian_relationships_one_open_per_pair` partial unique indexes; append-only triggers on `admission_decisions` and `student_statuses`.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 158 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (179 tests, 657 assertions)** |
| integration tests | PASS | register→decide→convert chain, status history, guardian chain (Admissions 7, Students 6 tests) |
| invariant tests | PASS | one student per person; one open guardian row per pair; append-only decisions and statuses (model + raw SQL vs triggers); CHECK-constrained states |
| authorization tests | PASS | Reception-only chain denied (reviewer/approver capabilities + distinct-actor rule) with audit; unprivileged status transitions denied with audit; reactivation requires the separate approval capability |
| lifecycle tests | PASS | applicant chain incl. rejection→re-application; student suspend→reactivate, withdraw→reactivate, complete→alumni; forbidden paths (suspended→suspended, alumni→active, draft conversions) fail closed |
| rollback-transaction tests | PASS | conversion creates student+status+audit atomically; failed conversion leaves no student rows; double conversion rejected |
| financial tests | NOT APPLICABLE | no financial module in Package 05 scope (liable-party facts flow to Finance when it exists) |
| concurrency/idempotency tests | PASS | replay returns original outcome (conversion); same-key different-payload rejected; duplicate open admission file rejected |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (students/guardian indexes; applicant/guardian state CHECKs); dev DB migrated to all 30 migrations |
| contract verification | PASS | universal command contract; only Admissions/Students write their persistence; Identity boundary enforced (unverified person cannot apply, conversion re-checks verification) |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Reception-only permanent conversion — clerk in reviewer or approver position denied (`admissions.reviewer_denied` / `approver_denied`), audited, no decision row.
2. Single actor holding all three roles — denied (`admissions.single_actor`).
3. Rejected applicant conversion — rejected (`admissions.convert_requires_admission`).
4. Unverified person applying / person losing verification before conversion — rejected.
5. Duplicate open admission file / second student for the same person / second conversion of the same decision — rejected.
6. Silent status overwrite — impossible: statuses are append-only facts; raw SQL `UPDATE student_statuses` rejected by the trigger.
7. Decision rewriting — raw SQL `UPDATE admission_decisions` (flipping admit→reject) rejected by the trigger.
8. Self-reactivation without approval — manager capability insufficient; `students.reactivate` required.
9. Alumni resurrection — `alumni→active` forbidden.
10. Unverified guardian permissions — an unverified relationship exposes no permissions in the read model; revoked relationships retain history but carry nothing.
11. Student as their own guardian / duplicate open guardian row — rejected.

Defects found by verification and repaired (each followed by full-suite regression): an over-strict unique index first forbidding same-day transitions, then forbidding legitimate same-day status cycles (removed — the transition table itself is the authority); ambiguous "latest status" ordering under same-timestamp inserts (solved with a deterministic sequence column); two phpstan annotation defects.

## Independent review

Reviewed against the contracts as a separate pass. Recorded reviewed decisions (not silent, per directive §22):

1. **Enrollment is deferred to the Academic delivery package** — the sequence row mentions enrollment, but the entity/ownership registries (foundation 29/30) assign Enrollment/Class Membership to Academic Delivery with mandatory class/period references that do not exist yet; creating placeholder academic persistence here would cross module ownership. The student identity and status machinery delivered now is what enrollment will attach to.
2. **Applicant states delivered from the registry row "Student/Admission"** — the prospect→applicant→admitted prefix is Admissions-owned; Active onward is Students-owned status history, per the entity registry split.
3. **Status history is append-only facts, not periods** — closing periods would require UPDATEs; the registry demands no-overwrite history, so current status = latest fact, ordered by a deterministic sequence.
4. **Reactivation is a separate capability** (`students.reactivate`) — registry 32 "reactivation only by approval"; a manager who can suspend must not silently reactivate.
5. **Guardian verification is explicit, not implied** — recorded relationships carry zero permissions until verified; the read model never exposes unverified or revoked permissions (foundation 21/37 boundary).
6. **Financial gates NOT APPLICABLE with reason** (no financial module yet); liable-party facts will flow to Finance per boundary 43 when that package lands.

## Clean handoff

- Working tree contains only this package's artifacts; dev DB `toefl_house` migrated to 30 migrations, 0 rows; recovery verify ENVIRONMENT VALID; `.gitignore` unchanged.

## Certification

All gates PASS (or NOT APPLICABLE with recorded reason). Package 05 — Students/Admissions is **CERTIFIED**. Certified cumulative suite: **OK (179 tests, 657 assertions)**; phpstan level 6 clean; pint clean (158 files).
