# WP-05 Academic Structure — implementation and verification record

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Pre-package baseline:** `47f618d57394aecf0b0c468c6cb0c49664a89c84`
**Lifecycle state:** CERTIFY — scope-limited certification complete
**Required checkpoint:** `9cbde9b` (`checkpoint WP-05 academic structure repairs`)

> This record began as the recoverable SCOPE-through-CHECKPOINT plan and now
> records completion of the remaining lifecycle. It covers only WP-05 and the
> direct dependencies required to make its contracts coherent.

## SCOPE

Included route ownership:

- `server/src/routes/academic.routes.ts`
- `server/src/routes/classes.routes.ts` (academic-structure portions only)
- `server/src/routes/offerings.routes.ts`
- `server/src/routes/enrollment.routes.ts`
- `server/src/routes/waitlist.routes.ts`
- `server/src/routes/skills.routes.ts`
- academic-structure portions of `server/src/routes/teachers.routes.ts`

Included supporting authority:

- academic catalog/version, class generation/planning/lifecycle, capacity,
  admission, enrollment, promotion, grade-lock and policy services;
- canonical schema constraints for the WP-05 ownership graph and lifecycle;
- exact academic setup, offering, class and teacher UI/API contracts;
- placement and student admission gates only as consumed dependencies;
- historical enrollment and waitlist behavior because the operative §W route
  boundary assigns those routes to WP-05.

Excluded except for direct regression checks:

- Academic Delivery sessions, attendance, assessment, gradebook, exam and
  certificate/diploma redesign (WP-06);
- teacher payroll computation, posting, reversal and compensation policy
  redesign (WP-08);
- Finance, Reporting, Workflow, Audit, Library and other later packages;
- any new tuition, promotion, freeze, transfer, staffing or compensation policy.

Risk: **HIGH/CRITICAL** — curriculum identity, class lifecycle, seat occupancy,
transfer/freeze atomicity, teacher workload and academic history are core data
integrity concerns.

## DISCOVER / MODEL

### Authority map

| Fact | Canonical owner | Required projection/consumer |
|---|---|---|
| Curriculum identity | program → program version → level → subject → module, with branch inherited from program | offerings, generation runs, classes, enrollment and placement gates |
| Class coarse status | `lifecycle_stage` plus `deriveCoarseClassStatus` | `classes.status` is a constrained projection only |
| Offering capacity | sum of linked class capacities | offering API and generation UI; no stored `capacity_total` authority |
| Seat occupancy | distinct students in seat-consuming enrollment states | class capacity, merge, enrollment and waitlist |
| Enrollment transition | exact source enrollment plus lifecycle transition graph | events and the source semester projection in the same transaction |
| Freeze/transfer request history | request command transaction | lifecycle effect and history either both commit or both roll back |
| Waitlist order | active queue position | only the earliest waiting entry can be offered after a real seat opens |
| Teacher performance | evaluation command and `teacher_evaluations` provenance | teacher score projection; generic teacher edit is not a writer |
| Teacher teaching work | class/teacher/skill/session-correlated assignment | branch, dates, role, uniqueness and three-distinct-ongoing-skill limit |

### State models

- Class: `draft → scheduled → enrollment_open ↔ enrollment_closed → activated →
  in_progress ↔ suspended → grading ↔ in_progress → completed → archived`, with
  guarded cancellation from pre-grading stages.
- Enrollment: pending/reserved/confirmed → active; active can freeze, transfer,
  drop, withdraw, complete, retake or conditional-pass according to the existing
  transition graph. A transfer names one exact active source.
- Waitlist: `waiting → offered → converted`, or active entry → cancelled; offer
  requires both an open seat and FIFO priority.
- Teacher: active work cannot coexist with an administrative transition to
  `inactive`; evaluation score changes occur only with an evaluation record.

### Corrected historical boundary

The defensible WP-05 core is **15 files / 229 statically declared cases / 325
baseline runtime cases (323 passed, 2 artifact-dependent skips)**. Enrollment and
waitlist suites move from the old WP-06 heading into WP-05 under §W. Seven
configuration, payroll, compensation, reporting or mixed files are excluded or
split as recorded in `docs/legacy-test-inventory.md`.

## CHALLENGE

| Subsystem | Disposition | Reason |
|---|---|---|
| Catalog and planning scalar writers | REFACTOR | negative/coerced duration and capacity facts, reversed slots and weak graph checks reached storage |
| Curriculum/class/offering schema | REBUILD integrity backstops | foreign keys alone do not enforce branch/version/level/term correlation or lifecycle projection |
| Offering capacity | REMOVE stored duplicate / derive | manual links and class edits can leave `capacity_total` stale |
| Enrollment transfer | REFACTOR exact command | student-wide source selection and semester completion move unrelated study |
| Freeze/transfer request workflows | REFACTOR transaction | lifecycle writes currently commit before history writes |
| Waitlist | REFACTOR | offer currently ignores capacity and FIFO; conversion duplicates the semester/roster writer |
| Teacher evaluation and deactivation | REFACTOR | generic edit is a second score writer and a second deactivation path bypasses active-work guards |
| Teacher skill assignments | REFACTOR + database backstop | direct writes bypass branch, rate, date, session, NULL uniqueness and workload limits |
| UI teacher edit contract | REPAIR | `defaultSkillRate` is collected but omitted by `apiStore.editTeacher` |
| Historical tests | REPLACE / explicitly retire | permissive full-class offers and direct performance edits conflict with the selected authorities |

The pre-implementation adversarial suite contains **15 tests, all reproduced
failing**. It directly demonstrates every defect class selected for repair,
including six assignment constraints grouped in one database attack.

## DECIDE — exact implementation plan

### Schema: `server/src/db/schema.sql`

1. Add strict numeric/boolean/date-shape checks to academic catalog, planning,
   class, teacher and assignment facts where the API already treats them as
   bounded structural values.
2. Add program-version/level/subject, offering, class resource and linked-class
   correlation triggers for insert and relevant updates.
3. Add class `status`/`lifecycle_stage` projection guards.
4. Remove `course_offerings.capacity_total`; capacity is selected as
   `COALESCE(SUM(classes.capacity), 0)`.
5. Add assignment branch, teacher/class/session, non-negative integer rate,
   date-order, class-scoped NULL uniqueness and three-distinct-ongoing-skill
   backstops.
6. Preserve canonical-schema-only initialization; do not introduce migrations
   or compatibility columns.

### Catalog, classes and offerings

- `academic.routes.ts`: parse non-negative integer duration/order/capacity
  values, validate level setup symmetrically on create/update, validate time
  syntax/order and preserve existing strict term ranges.
- `classes.routes.ts`: resolve one program/level/branch identity, reject partial
  or contradictory curriculum identifiers, and validate direct class planning
  inputs before insert.
- `offerings.routes.ts`: derive capacity in reads, validate full curriculum
  correlation on create/update/link, and reject curriculum mutation while linked
  classes would be invalidated.
- `class-generation-engine.ts`: remove stored-capacity maintenance and continue
  to validate offering/run/item correlation before one transaction publishes.

### Enrollment and waitlist

- `enrollment-service.ts`: transfer by exact source enrollment id; update only
  its matching active semester projection; preserve concurrent extra study;
  retain placement, gender, duplicate and capacity gates.
- `enrollment.routes.ts`: wrap freeze/history, resume/history,
  auto-transfer/history and approval/history in explicit transactions; propagate
  the route/request source identity into the service.
- `students.routes.ts`: adapt the existing student-scoped transfer endpoint to
  resolve and pass its canonical active non-extra source without changing its
  public contract.
- `waitlist.routes.ts`: verify open capacity and earliest waiting position before
  offer; conversion must use `EnrollmentService.enroll()` as the sole semester
  and future-roster writer inside the queue transaction.

### Teachers, skills and UI

- `teachers.routes.ts`: reject `performanceScore` in generic updates; reuse the
  active-work guard when a generic update requests `inactive`; retain the
  evaluation transaction as score provenance authority.
- `skills.routes.ts`: use the canonical money boundary on updates and
  substitutes, validate dates/session/class/branch consistently and rely on
  database backstops for direct/concurrent writes.
- `src/apiStore.ts` and `src/components/teachers/TeachersView.tsx`: align the
  `editTeacher` signature and call order so `defaultSkillRate` is sent exactly
  once with no payroll behavior change.

### Tests and legacy disposition

- Keep `work-packages/wp05/attack.test.ts` as adversarial authority and add
  focused integration/architecture cases while implementing.
- Rebase or replace the 15-file historical core under
  `server/src/tests/work-packages/wp05/`; explicitly retire contradictory
  full-class waitlist offers and direct generic performance-score edits.
- Split mixed teacher-skill/input knowledge so WP-05 claims only academic
  assignment/evaluation behavior; leave payroll/reporting assertions for their
  owning packages.
- Run focused WP-05, dependent Placement/Student/Academic Delivery tests, full
  server suite, canonical schema verification, frontend/server builds, lint,
  typecheck, audits and release validation before certification.

## CHECKPOINT REQUIREMENT

Classification: canonical schema change; core lifecycle/transaction change;
authority replacement; legacy-test replacement.

Recoverability is provided by baseline commit
`47f618d57394aecf0b0c468c6cb0c49664a89c84`. The attack fixtures, reproduced
failures, corrected inventory, decisions and this exact plan must be committed
as a separate checkpoint before production implementation begins.


## IMPLEMENT → VERIFY → ATTACK → REPAIR → REVERIFY

Implementation followed D-86–D-92 and the checkpoint above:

- curriculum, offering and class identifiers are correlated at route and storage
  boundaries; level prerequisites are a validated acyclic ownership graph and
  program-version copies remap dependency ids;
- offering capacity is derived from linked class capacities;
- exact-source transfer, freeze history and transfer-request decisions commit
  with their lifecycle/projection effects;
- waitlist offers require a real FIFO opening, active queue positions remain
  unique across waiting/offered states, and conversion delegates to
  `EnrollmentService`;
- evaluation is the only performance-score provenance command, teacher
  deactivation paths share the active-work guard, and assignment identity,
  branch, session, date, rate and workload limits have storage backstops;
- the teacher UI/API contract now forwards `defaultSkillRate`;
- all fifteen historical suites were rebased under `work-packages/wp05`, with
  contradictory full-class-offer and generic-score-write expectations retired.

The initial 15-case attack suite intentionally failed before implementation.
The expanded package authority now passes **17 files / 348 tests**. Final
clean-data full-suite evidence is **2536 passed / 160 explicit WP-04 retirement
skips**. Canonical preflight passes at **112 tables / 238 indexes / 117
triggers**. Both TypeScript projects, production builds, lint (zero errors),
all static/protocol/registry/design/logging/cleanliness/dependency/bundle audits,
19 scoped mutation attacks and full release validation pass.

## INDEPENDENT REVIEW → CLEAN → CERTIFY

The cold review re-read the ownership graph, transactions, schema triggers,
route errors, UI contract, replacement tests and package boundary. It found and
repaired four final defects before re-verification:

1. duplicate prerequisite ids were normalized instead of rejected at the API;
2. joining behind an offered waitlist entry could reuse an active queue
   position and surface a storage conflict;
3. direct teacher-score updates lacked a database provenance guard;
4. changing a fourth guest assignment to an ongoing role surfaced the database
   workload backstop as HTTP 500 instead of a 409 business conflict.

Generated databases and build output are removed during CLEAN. The authoritative
scope-limited evidence and certification matrix are in
`docs/certification/WP-05-academic-structure.md`. No later Work Package is
certified by this record.
