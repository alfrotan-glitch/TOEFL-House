# Certification — WP-05 Academic Structure

**Work Package:** WP-05 Academic Structure
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Recoverable pre-package baseline:** `47f618d57394aecf0b0c468c6cb0c49664a89c84`
**Required implementation checkpoint:** `9cbde9b` (`checkpoint WP-05 academic structure repairs`)
**Status:** READY — scope-limited certification complete

> This artifact certifies only WP-05. It does not certify Academic Delivery,
> Library, Finance, Payroll, Reporting, Workflow, Audit, final production
> operations, or the complete product.

## SCOPE

Included:

- academic programs, versions, levels, prerequisites, subjects and modules only
  where required to preserve the curriculum ownership graph;
- rooms, time slots, terms and structural planning values;
- course-offering identity, class links and derived capacity;
- configured and ad-hoc class identity, resources, lifecycle projection and
  seat capacity;
- enrollment lifecycle behavior assigned to WP-05 by §W, including exact
  transfer, freeze/request history and semester projection effects;
- waitlist queue, offer and conversion behavior;
- teacher evaluation provenance, teacher active-work guards and teaching-skill
  assignment integrity;
- exact UI/API contracts needed by the modified academic and teacher writers;
- canonical schema backstops and direct student/placement/class-generation
  dependencies required to keep those contracts coherent;
- replacement or explicit retirement of every mapped WP-05 legacy behavior.

Operative route boundary:

- `server/src/routes/academic.routes.ts`
- `server/src/routes/classes.routes.ts` — Academic Structure portions only
- `server/src/routes/offerings.routes.ts`
- `server/src/routes/enrollment.routes.ts`
- `server/src/routes/waitlist.routes.ts`
- `server/src/routes/skills.routes.ts`
- Academic Structure portions of `server/src/routes/teachers.routes.ts`

Excluded except as consumed regression dependencies:

- sessions, attendance, assessment, gradebook, exams and certificates/diplomas
  as Academic Delivery redesign (WP-06);
- teacher payroll computation, payment, posting, reversal and compensation
  policy (WP-08);
- Finance, Library, Reporting, Workflow, Audit and other later packages;
- any new tuition, placement, promotion, freeze, transfer, staffing,
  compensation or payroll policy.

Risk: **HIGH/CRITICAL** — curriculum identity, class lifecycle, seat occupancy,
academic history, transfer/freeze atomicity and teaching-work integrity are core
business facts.

## DISCOVER / MODEL

### Authority map

| Fact | Canonical authority | Required projection / consumer |
|---|---|---|
| Curriculum identity | `programs → program_versions → levels → subjects → modules`; branch inherited from program | offerings, generation, configured classes and admission consumers |
| Level prerequisite graph | validated `levels.prerequisites`; same-program/version-compatible DAG | version copy remaps ids; setup UI/API reads graph |
| Class lifecycle | `classes.lifecycle_stage` plus lifecycle service | `classes.status` is a constrained coarse projection |
| Configured class identity | complete correlated program/level pair, or neither for an ad-hoc class | offering links, placement/admission and planning |
| Offering capacity | sum of capacities of currently linked classes | offering API/UI; no stored capacity duplicate |
| Seat occupancy | canonical seat-consuming enrollment states | class admission, merge, transfer and waitlist |
| Enrollment transfer | one named active source enrollment | exact source semester, event, destination enrollment and rosters in one transaction |
| Freeze/request history | owning lifecycle command transaction | lifecycle and history commit or roll back together |
| Waitlist queue | active waiting/offered positions and FIFO order | offer requires real opening; conversion delegates to `EnrollmentService` |
| Teacher performance | evaluation command plus `teacher_evaluations` provenance | `teachers.performance_score` projection |
| Teacher active work | direct class and ongoing primary/assistant assignment | update, transfer and deletion/deactivation guards |
| Teaching assignment | class/teacher/branch/skill and optional class-session identity | bounded date/rate/uniqueness/workload projection |

### State models

- Class: `draft → scheduled → enrollment_open ↔ enrollment_closed → activated →
  in_progress ↔ suspended → grading ↔ in_progress → completed → archived`, with
  guarded cancellation from permitted stages.
- Enrollment: established pending/reserved/confirmed/active transitions; active
  can freeze, transfer, drop, withdraw, complete, retake or conditional-pass
  only through the existing lifecycle authority.
- Waitlist: `waiting → offered → converted`, or active entry → `cancelled`.
- Teacher: evaluation writes score plus provenance atomically; active teaching
  work blocks `inactive` and administrative branch transfer.

### Corrected historical boundary

Protocol §W assigns enrollment and waitlist routes to WP-05. The corrected
historical core was **15 files / 229 statically declared cases / 325 baseline
runtime cases (323 passed, 2 build-artifact-dependent skips)**. Seven former
whole-file attributions were corrected because they actually belong to generic
configuration, Payroll or Reporting, or contain mixed behavior.

All fifteen mapped suites now live under
`server/src/tests/work-packages/wp05/`. Their corrected/rebased authority is
**327 runtime cases**. Two explicitly contradictory behaviors were retired:

1. a full class may not issue a waitlist offer;
2. generic teacher update may not write any performance score.

The 17-case adversarial suite and four prerequisite/copy cases bring final WP-05
authority to **17 files / 348 passing tests**, with no WP-05 skip.

## CHALLENGE / DECIDE

| Subsystem | Decision | Reason |
|---|---|---|
| Catalog and planning writers | REFACTOR | negative, fractional, coerced and reversed structural facts reached storage |
| Curriculum/class/offering storage | REBUILD integrity backstops | independent foreign keys did not prove one ownership graph |
| Prerequisite graph/version copy | REBUILD graph boundary | JSON allowed dangling, foreign, duplicate and cyclic edges; copying retained source ids |
| Offering capacity | REMOVE stored duplicate / derive | manual links and later class edits could make `capacity_total` stale |
| Class lifecycle projection | REFACTOR + database guard | coarse status could drift from lifecycle stage |
| Enrollment transfer | REFACTOR exact command | student-wide source selection and broad semester completion could move unrelated study |
| Freeze/transfer request workflows | REFACTOR transaction | history could fail after lifecycle effects committed |
| Waitlist | REFACTOR | offer ignored capacity/FIFO and conversion duplicated semester/roster writers |
| Teacher score/deactivation | REFACTOR authority | generic edits were a second score writer; one deactivation path bypassed active work |
| Teaching assignments | REFACTOR + database backstop | direct writers bypassed branch/session/date/rate/NULL identity/workload rules |
| Teacher UI edit contract | REPAIR | collected `defaultSkillRate` was omitted from the request |
| Historical tests | REPLACE / explicitly retire | permissive contracts contradicted selected canonical authorities |

Decisions D-86–D-92 preserve existing policy and select only authority,
integrity, lifecycle and transaction behavior. No new financial or academic
threshold policy was introduced.

## CHECKPOINT

Classification: canonical schema change · core lifecycle/transaction change ·
authority replacement · legacy-test replacement.

The recoverable SCOPE-through-DECIDE checkpoint is commit `9cbde9b`, based on
pre-package state `47f618d57394aecf0b0c468c6cb0c49664a89c84`. The checkpoint
contains the exact plan, corrected inventory, decisions, conflict record and an
initial **15/15 intentionally failing** attack suite. Production implementation
began only after this checkpoint.

## IMPLEMENT

### Curriculum, planning, classes and offerings

- Academic writers now use strict whole-count, money, boolean, ISO-date and
  `HH:MM` boundaries instead of coercion or silent fallback.
- Program/version/level/subject and offering/class/branch/term identifiers are
  correlated by route validation and canonical triggers.
- Level prerequisites reject malformed, duplicate, missing, self, cross-program,
  cross-version and cyclic edges. Referenced levels deactivate rather than
  delete. Program-version copy allocates/remaps level ids in dependency order.
- Configured classes require one complete program/level identity and inherit the
  owning program branch and level configuration. Ad-hoc classes carry neither
  configured id.
- Class status is an exact coarse projection of lifecycle stage. Teacher, room,
  slot, term and offering links are branch/curriculum correlated.
- `course_offerings.capacity_total` and its generation refresh path are removed.
  Offering reads derive `capacityTotal` from linked class capacities.
- Offering updates refuse curriculum mutation that would invalidate an existing
  linked class.

### Enrollment and waitlist

- `EnrollmentService.transfer()` requires `sourceEnrollmentId`, verifies it is
  still active inside the transaction, updates exactly that row, completes only
  its matching active semester and opens one destination projection.
- Capacity, gender, placement, duplicate-seat and branch checks remain shared in
  the enrollment authority.
- Freeze request/resume and automatic/manual transfer-request decisions commit
  lifecycle, event, request/history and semester effects atomically. CAS checks
  reject stale state.
- Freeze and transfer-request rows are enrollment/student/branch/class
  correlated in storage; active uniqueness and date/state projections are
  enforced.
- Waitlist offer counts active occupancy plus outstanding offers, requires a
  positive-capacity opening and only advances the earliest waiting entry.
- Waiting and offered positions remain unique; new entries append after the
  highest active position rather than reusing an offered identity.
- Conversion rechecks capacity/FIFO state and calls `EnrollmentService.enroll()`
  as the sole enrollment, semester and future-roster writer.

### Teachers, assignments and UI

- Generic teacher PUT rejects the presence of `performanceScore`; only the
  evaluation command inserts provenance and changes the score atomically.
- Canonical storage rejects a score change that does not match the latest
  evaluation provenance row.
- One active-work guard is reused by generic inactive update, transfer and
  deletion/deactivation. Storage independently blocks inactive transition while
  direct or ongoing teaching work remains.
- Teacher counts, names, rates and setup text use the canonical input boundaries.
- Assignment create/update/substitute paths validate whole AFN rate and ISO
  dates; session-scoped dates must contain the linked session date.
- Storage enforces class/teacher/session branch correlation, active teacher on
  new work, class-scoped NULL-session uniqueness and at most three distinct
  ongoing primary/assistant skills.
- An update that reaches the workload backstop returns a 409 business conflict,
  not HTTP 500.
- `src/apiStore.ts` forwards the edited `defaultSkillRate` exactly once. Payroll
  behavior was not redesigned.

## VERIFY / ATTACK / REPAIR / REVERIFY

| Gate | Final result |
|---|---|
| Initial challenge | **15/15 attack cases intentionally failed before implementation** |
| Final WP-05 authority | **17 files / 348 tests passed / 0 skipped** |
| Final adversarial file | **17/17 passed** |
| Full server suite on clean data | **159 files / 2536 tests passed; 13 files / 160 explicit WP-04 retirement tests skipped** |
| Canonical schema | **PASS — 112 tables / 238 indexes / 117 triggers; standalone, sound, idempotent, sole authority** |
| Frontend TypeScript | PASS |
| Server production and test TypeScript | PASS |
| Frontend and backend production builds | PASS |
| Frontend lint | PASS — 0 errors / 12 repository warnings |
| Backend lint/typecheck | PASS — 0 errors / 78 repository warnings |
| Product integrity | PASS |
| High-assurance static audit | PASS |
| Protocol audit | PASS — sealed Protocol |
| Registry audit | PASS — 6 registries / 301 rows / all references live |
| Design-system/direction audit | PASS — 106 files |
| Logging audit | PASS — 112 runtime modules |
| Source cleanliness audit | PASS |
| Server dependency isolation | PASS — 295 files / 32 declared packages |
| Bundle gate | PASS — 494 KB first paint within 560 KB budget |
| Scoped mutation testing | **PASS — 19/19 killed, 0 survived, 0 invalid** |
| Full release validation | **PASS — 22 passed / 0 failed / 0 skipped** |
| `git diff --check` | PASS |

The 19 scoped mutants comprise 16 class/admission/capacity/ownership mutants,
two evaluation-input/response mutants and one generic-score-writer mutant.
Payroll-only mutants remain with WP-08 and are not claimed here.

Adversarial evidence includes cross-branch and partial curriculum identity,
invalid structural scalars, direct lifecycle projection drift, offering/class
mutation, prerequisite graph attacks, exact-source substitution, unrelated
semester preservation, forced late request/freeze-history failure, transfer CAS,
full/out-of-order waitlist offers, active-position reuse, generic score writes,
direct score provenance bypass, deactivation with work, assignment branch/rate/
date/session/identity/workload bypass and fourth-skill update error mapping.

## INDEPENDENT REVIEW / CLEAN

A separate cold review pass re-read the diff, route and schema authorities,
transaction nesting, queue arithmetic, version-copy order, dependent contracts,
UI request and replacement inventory. It found and repaired before the final
full suite:

1. duplicate prerequisite ids were being normalized rather than rejected by the
   API, despite database uniqueness authority;
2. a new join behind an offered waitlist row counted only waiting rows and could
   reuse an active position;
3. direct `teachers.performance_score` updates lacked a database provenance
   backstop;
4. changing a fourth guest assignment into an ongoing role surfaced the storage
   workload guard as HTTP 500 instead of an explicit 409 conflict.

Focused tests, canonical preflight, TypeScript, mutation tests and the complete
server suite were rerun after these repairs.

CLEAN removes generated `data/`, build output and test residue. No database,
compiled artifact, credential, temporary evidence or debug output is tracked.
The remaining lint warnings are repository-wide accepted warnings; all lint
commands exit successfully with zero errors.

## CERTIFICATION MATRIX

| Dimension | Status | Evidence | Remaining risk inside WP-05 |
|---|---|---|---|
| Architecture / canonical authority | READY | D-86–D-92; authority/invariant registries; package tests | none material |
| Curriculum/domain correctness | READY | graph, lifecycle, offering and promotion suites | none material |
| Database/data integrity | READY | 117 triggers; canonical preflight; direct-write attacks | none material |
| Enrollment/history atomicity | READY | exact-source/CAS and forced rollback attacks | none material |
| Capacity/waitlist concurrency | READY | capacity authority, FIFO/opening/position and conversion tests | SQLite single-writer deployment model remains assumed |
| Teacher evaluation integrity | READY | evaluation/generic-update/direct-storage tests; mutation evidence | none material |
| Teaching-work integrity | READY | active-work and assignment route/storage tests | compensation calculation remains WP-08 |
| RBAC/object scope | READY for altered academic objects | existing canonical RBAC plus class/branch ownership suites | no claim over later-package routes |
| API/error contracts | READY | strict input, CAS and 400/409 regression cases | none material |
| Frontend/UX | READY for altered teacher request contract | typecheck, build, source assertion | no claim over unrelated screens |
| Testing / legacy replacement | READY | 17 files / 348 tests; no WP-05 skips; C-15 | 160 skips belong only to explicitly retired WP-04 knowledge |
| Maintainability/cleanliness | READY | registries, static/protocol/dependency/cleanliness gates | independent review was performed by the same agent |
| Operational readiness | OUT OF PACKAGE | build, schema and release gates pass | deployment/production operations are not certified here |

## CERTIFICATION

**WP-05 Academic Structure is READY.** Every critical/high dimension inside the
defined package has executable evidence. No material curriculum-ownership,
capacity, class-projection, transfer/freeze atomicity, waitlist FIFO, teacher
score-provenance, active-work or assignment-integrity contradiction remains in
scope.

This certification is deliberately bounded. It does not advance or certify
WP-06 Academic Delivery, WP-07 Library, WP-08 Payroll, Finance, Reporting,
Workflow, Audit, production operations or complete-system release readiness.
