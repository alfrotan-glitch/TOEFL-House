# Certification — WP-03 Students & Admissions

**Work Package:** WP-03 Students & Admissions
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`
**Date:** 2026-08-21
**Recoverable baseline:** `a215d495b27eb222d0d1f533aac710b61b3bbd9d`
**Status:** READY — scope-limited certification complete

> This artifact certifies only WP-03. It does not certify Placement, Academic
> Structure, Academic Delivery, Finance, Reporting, Audit, the full system, or
> production release readiness.

## SCOPE

Included:

- student profile creation, identity fields, normalized duplicate prevention,
  profile editing, roster/search/summary/export, and branch/class/own access;
- student profile lifecycle, graduation, suspension, resume, transfer, class and
  semester admission, capacity, gender, placement-gate consumption, and debt-hold
  consumption;
- visitor/lead intake, filtering, assignment, follow-ups, stage transitions,
  duplicate handling, placement snapshot consumption, and conversion to student;
- conversion branch, class-fee, discount-result, invoice/payment, enrollment, and
  transaction boundaries only as directly written or consumed by admissions;
- student journey chronology, canonical current-state overlays, manual notes, and
  financial redaction;
- exact server/UI consumers needed to keep WP-03 authority, confidentiality, and
  workflow controls coherent;
- replacement or explicit retirement of every mapped WP-03 legacy-test behavior.

Excluded except as consumed dependencies:

- placement assessment policy/content/scoring design;
- academic catalog, class lifecycle, curriculum, grade, promotion, and delivery
  policy;
- finance policy, ledger definitions, treasury, payroll, reporting, and audit
  product design;
- new admissions stages, lifecycle states, discount categories, fee policy, or
  ownership relations.

Risk: **HIGH/CRITICAL** — legal identity, admissions eligibility, occupied seats,
student lifecycle, cross-branch access, tuition-adjacent writes, and student
financial confidentiality are affected.

## DISCOVER

### Runtime and storage surface

| Area | Authority / files | Observed contract |
|---|---|---|
| Student profile and roster | `server/src/routes/students.routes.ts`, `server/src/core/students/student-input.ts` | strict create/patch input, normalized identities, paginated roster/search, authoritative summary and CSV |
| Student lifecycle | `student-lifecycle.ts`, `enrollment-service.ts` | guarded profile transitions; suspension/resume couples profile, every live enrollment, exact semesters, rosters, events, and capacity checks |
| Lead/CRM | `server/src/routes/visitors.routes.ts`, `server/src/core/visitors/*` | branch-scoped intake, lifecycle buckets, follow-ups, duplicate checks, placement eligibility preview, transactional conversion |
| Journey | `server/src/core/journey/journey-engine.ts`, `server/src/routes/journey.routes.ts` | append-only chronology; current facts overlaid from owning tables; bounded manual notes only |
| Object authority | `server/src/middleware/auth.ts`, `server/src/core/rbac/abac.ts` | operation permission and branch boundary correlate; student class/own collections stay object-filtered |
| Tuition consumption | `server/src/utils/studentBalance.ts` | one balance definition over semesters and completed tuition-category payments; explicit authorized-ID aggregation for CSV |
| UI consumers | student and visitor views, profile/journey/convert panels, `src/apiStore.ts` | exact workflow capabilities, server-redacted finance shape, fixed lead branch/class tuition, persisted callback date |
| Canonical schema | `server/src/db/schema.sql` | normalized student identity constraints; cross-table Tazkira guards; suspension batch and exact-semester mapping |

### Legacy-test knowledge

The mapped inventory contained **14 files / 326 statically declared cases**. The
untouched runtime baseline executed **331 tests** because
`student-subsystem-remediation.test.ts` contained 47 tests rather than the 42
recorded by the static inventory. All fourteen files now live under
`server/src/tests/work-packages/wp03/`. The mapped replacement authority is
**15 files / 355 executed tests**, including a **24-case** adversarial suite. One
supplemental mixed-roster finance/resume-dispatch regression makes the executable
WP-03 directory **16 files / 356 tests** without inflating the C-2 mapped count.

### Reproduced defects

The initial attack authority reproduced 13 intended failures before implementation.
Subsequent challenge and artifact-only review reproduced additional defects:

1. non-money values and zero-fee overpayments reached admissions money paths;
2. graduated students could enter an alternate enrollment path;
3. whole-student suspension changed only one enrollment and broad resume could
   reactivate unrelated deferred history;
4. general profile PATCH could forge placement/card workflow-owned state;
5. journey state acted as a shadow lifecycle/ledger and manual events could write
   status, graduation, promotion, or placement claims;
6. student financial fields and nested money payloads were visible with
   `Student.View` alone;
7. normalized phone variants and visitor/student Tazkira identities could evade
   route-only duplicate checks;
8. neighboring permissions and role labels substituted for exact workflow
   capabilities;
9. account home branch or unrelated assignment authority could lend admission,
   finance-view, or debt-hold authority to another branch;
10. CSV export widened class/own scope, aggregated classes outside the exported
    set, and could aggregate balances for the wrong population;
11. conversion accepted caller branch/gross fee, silently replaced payment
    methods, and committed placement reporting before late enrollment failure;
12. program-change placement invalidation and visitor profile persistence were
    not one transaction;
13. conversion notifications exposed invoice and tuition figures to the broad
    branch bell;
14. callback follow-ups did not require or persist the next-contact date;
15. malformed persisted placement JSON could break visitor reads, while current
    journey placement could remain stale behind old events;
16. class capacity counted rows rather than distinct students and active-seat
    uniqueness did not preserve sequential same-class terms;
17. a Payment.View assignment from branch B unredacted branch-A student profile,
    journey, direct finance timeline, and export fields;
18. invalid lead phone syntax was accepted at intake and then surfaced as a raw
    database failure during conversion;
19. ordinary status PATCH changed a suspended profile to inactive while leaving
    suspension-owned enrollments and semester effects suspended;
20. `enrollmentType: resume` on the general journey admission endpoint created a
    new active enrollment for a suspended profile instead of using the dedicated
    whole-student resume workflow;
21. the mixed-branch roster UI treated a unioned Payment.View code plus one
    finance-bearing row as authority for every row and could label a redacted,
    missing balance as paid.

## MODEL

### Canonical student and lead model

- `students` owns current profile identity and profile lifecycle status.
- `visitors` owns lead identity, independent stage/status axes, CRM facts, and
  conversion linkage through `students.lead_id`.
- student email, phone, and Tazkira are globally unique under their canonical
  normalized forms; unrelated visitor/student Tazkira identities cannot coexist.
- a converting lead keeps its branch and may preserve only its own linked
  Tazkira identity.
- phone syntax and matching are shared between lead intake, student input,
  conversion preflight, route checks, and the database backstop.

### Lifecycle and admission model

- ordinary active/inactive/graduated transitions use the guarded student-status
  authority; graduation is terminal and completes live enrollment/semester rows.
- suspension/resume is an enrollment workflow because it changes the student,
  every compatible live enrollment, rosters, journey/enrollment events, and the
  exact active semesters captured by one open suspension batch. A suspended
  profile cannot use ordinary status or enrollment-type fields as a substitute
  for that dedicated resume command.
- an occupied seat is a distinct student in a seat-consuming enrollment status.
  Active uniqueness is student/class/semester, so duplicate current seats are
  refused while sequential completed terms remain legal.
- the selected class owns branch, active state, gender policy, capacity, level,
  and conversion gross tuition. Placement and discount services remain consumed
  authorities, not reimplemented policy.

### Journey and confidentiality model

- `student_journey_events` is append-only chronology, not a second status,
  enrollment, placement, card, or ledger authority.
- current lifecycle, primary enrollment, card, and persisted placement snapshot
  are overlaid from owning tables.
- manual journey writes are bounded notes with optional same-student enrollment
  correlation; lifecycle commands use their dedicated endpoints.
- financial events, finance summary, discount/installment/semester fee fields,
  nested money-shaped payloads, and CSV financial columns require
  branch-correlated `Payment.View`. Authorized self-service remains separate.

## CHALLENGE

| Subsystem | Decision | Reason |
|---|---|---|
| Student table/profile API | REFACTOR | retain established profile while making create/patch validation and identity comparison identical |
| Normalized identity schema | REFACTOR | retain fields, add database backstops matching application keys |
| Status endpoint | KEEP / tighten | preserve ordinary transitions; make graduation terminal and transactional |
| Suspension/resume | REBUILD | single-row/class-wide restoration could not represent whole-student exact effects |
| Enrollment service | REFACTOR | preserve sole admission writer; enforce terminal status, class level, distinct capacity, and exact restoration |
| Student roster/search/summary | REFACTOR | retain API while preserving class/own scope and server totals |
| CSV export | REBUILD at scope boundary | page/client and branch-wide balance/class aggregation contradicted roster authority |
| Lead lifecycle and CRM | KEEP / tighten | established stages and buckets retained; strict fields, callback date, and branch correlation added |
| Conversion | REBUILD transaction boundary | preserve workflow while making branch, class fee, discount result, eligibility, and all side effects atomic |
| Journey event stream | REFACTOR | retain append-only evidence; remove shadow state/ledger and manual command paths |
| Role-label and neighboring-permission guards | REMOVE | only exact effective capabilities authorize workflow actions |
| Mapped legacy tests | REPLACE / explicitly retire | preserve requirement knowledge without contradictory authorities |

## DECIDE

The implementation plan was bounded to:

1. unify student and converting-lead phone syntax/matching and add normalized
   identity database guards;
2. preserve one command authority per lifecycle effect;
3. capture exact semester IDs during whole-student suspension and restore only
   that batch;
4. enforce class/semester seat, capacity, gender, level, branch, and placement
   contracts at the admission service boundary;
5. preserve class/own student object scope in list/search/summary/detail/export;
6. correlate finance visibility and debt-hold overrides to the student branch;
7. make visitor conversion and program-change invalidation transactional;
8. make journey chronology note-only for manual writes and overlay current facts
   from canonical tables;
9. propagate exact capabilities and server-redacted financial shape through UI
   consumers;
10. replace all mapped tests, register authorities/invariants/decisions, and run
    package, dependent, full-suite, schema, lint, audit, build, bundle, and
    release gates.

No new admissions, identity, lifecycle, placement, discount, or finance policy
was introduced.

## CHECKPOINT

**Checkpoint classification:** schema change · security/RBAC change ·
financial-adjacent write change · lifecycle architecture change · legacy-test
replacement.

The recoverable pre-package state is commit
`a215d495b27eb222d0d1f533aac710b61b3bbd9d` on the fixed Arena branch. Canonical
schema changes are confined to `server/src/db/schema.sql` and remain recoverable
through Git. The changes add normalized email/phone enforcement, cross-table
Tazkira guards, `student_suspension_batches`,
`student_suspension_semesters`, and one-open-batch uniqueness.

Registered decisions D-74–D-78 govern lifecycle/suspension, conversion,
journey/redaction, identity uniqueness, and C-2 replacement. Protocol conflict
C-1 records the measured schema shape; C-2 records complete WP-03 replacement;
C-7 records the suspension mapping schema.

## IMPLEMENT

### Student identity, profile, and lifecycle

- Create and PATCH share strict text, gender, date, phone, and workflow-owned
  field validation. Numeric/boolean coercion into identity text is refused.
- Student/lead phone syntax uses one authority; normalized phone and email keys
  have database uniqueness backstops. Cross-table Tazkira triggers permit only
  the linked conversion identity.
- General profile PATCH cannot forge placement results or card design and bounds
  installment-plan structure/size/money.
- Graduation is terminal and atomically completes open enrollment/semester rows.
- Suspension validates the complete live enrollment set, records one exact
  semester batch, suspends every active enrollment, removes future rosters,
  defers captured active semesters, changes profile status, and appends events in
  one transaction.
- Resume validates every target class, gender and distinct-student capacity,
  restores exact mapped semesters, resumes every suspended enrollment, restores
  future rosters, closes the batch, and changes profile status atomically. An
  older suspended row without an exact restoration mapping fails closed with
  409 rather than reactivating deferred history by student or class.
- While suspended, ordinary status PATCH and general enrollment creation both
  return 409. The UI offers no ordinary transition and exposes Resume only when
  the exact `Student.Resume` capability is present.

### Admissions, scope, and financial confidentiality

- Enrollment refuses graduates, class/level mismatch, duplicate current seats,
  and placement/capacity/gender violations at the service boundary.
- Roster, search, summary, and CSV use the same student authority filter.
  Class/own grants never become branch-wide; explicit-ID balance and class
  aggregation cannot include unexported students.
- Student rows may carry finance fields per authorized branch. CSV uses one
  uniform schema and omits all financial columns when a multi-branch result is
  only partially finance-authorized.
- Profile, journey, direct finance timeline, balances, and debt-hold override
  decisions correlate the supplying permission/role assignment to the student
  branch. An unrelated finance position cannot lend authority.

### Leads, CRM, and conversion

- Intake/update/CRM inputs are bounded and typed; lead phone syntax is valid for
  eventual student conversion. Filter enums fail closed.
- Callback outcomes require and persist a valid next-contact date.
- Branch access comes only from the permission assignment, never account home
  branch. Assignee, campaign, program, class, and conversion branch relations
  are validated.
- Conversion preserves the lead branch, derives gross tuition from the class,
  rejects unsupported payment methods and unauthorized discount transformations,
  and performs visitor, student, semester/enrollment, invoice/payment, journey,
  and placement-reporting effects in one transaction.
- Program change atomically invalidates the live placement attempt/snapshot with
  the visitor profile update.
- Conversion notifications contain operational identity/class facts only; money
  remains in finance-authorized records and the audit trail.

### Journey and UI

- Journey chronology parses malformed payloads safely, orders deterministically,
  recursively removes money-shaped nested fields, and exposes financial events
  only to branch-correlated finance authority.
- Current status, enrollment, card, and actual persisted placement fields overlay
  chronology. Tuition is supplied only by `studentBalance`.
- Manual journey writes accept a bounded note and reject lifecycle/placement/
  graduation commands or foreign-student enrollment references.
- Student and visitor screens use effective permission codes rather than role
  labels, hide unavailable finance shape, preserve fixed conversion branch/class
  fee, display actual and historical placement snapshots, collect callback
  dates, and print the full outstanding amount on unpaid conversion receipts.

## VERIFY

| Evidence | Final executed result |
|---|---|
| WP-03 mapped replacement authority | **15 files / 355 tests passed** |
| Supplemental mixed-roster finance/resume UI regression | **1 file / 1 test passed**; executable WP-03 total **16 files / 356 tests** |
| WP-03 adversarial authority | **24 / 24 passed** |
| Dependent enrollment/academic/balance/discount evidence | **9 files / 157 tests passed** |
| Full server suite | **162 files / 2605 passed / 0 skipped / 0 failed** |
| Canonical schema | **112 tables / 234 indexes / 72 triggers**; standalone, sound, idempotent, sole authority |
| Frontend lint | **0 errors / 12 warnings** |
| Server lint/typecheck | **0 errors / 92 warnings**; production and test TypeScript checks passed |
| Frontend TypeScript/build | direct `tsc --noEmit` and production build passed |
| Audits | protocol, registries, product integrity, high-assurance static, dependency isolation, design system, logging, and source cleanliness passed |
| Registry audit | **6 registries / 254 rows / 394 path references / 31 endpoint references**, all live |
| Dependency isolation | **284 server import-graph files / 32 declared packages** |
| Bundle | **494 KB first paint / 560 KB budget**, 19 lazy route chunks |
| Release gate | **22 passed / 0 failed / 0 skipped** |
| Release database checks | fresh canonical install at 112 tables; idempotent re-init, integrity and financial reconciliation passed |

The handled `SqliteError: account failed` on full-suite stderr is the expected
forced branch-provisioning rollback regression; the suite exits successfully.
The lint warnings are the established repository warning baseline under the
existing configuration; both lint commands exit zero.

## ATTACK

The final adversarial package actively exercises:

- non-money coercion, overpayment, invalid tender, oversized JSON/text, malformed
  dates, and non-text foreign identifiers;
- phone-format collisions, invalid lead/student phone syntax, normalized email,
  route-bypass identity writes, and unrelated visitor/student Tazkira collision;
- graduated enrollment, multi-enrollment suspension/resume, unmapped legacy
  suspension, unrelated deferred semesters, full-class resume, duplicate seats,
  and sequential repeat terms;
- general PATCH attempts to forge placement/card state and manual journey
  attempts to forge lifecycle facts;
- class/own CSV leakage, branch-home substitution, cross-branch conversion, and
  unrelated-branch finance unredaction/debt-hold override;
- nested lifecycle money payloads, direct finance timeline access, student
  profile/installment/balance leakage, and financial notification disclosure;
- caller-priced conversion fee, unauthorized discount transformation, unsupported
  payment methods, late eligibility rollback, and duplicate conversion;
- callback without date, malformed CRM payload, stale placement event overlay,
  and foreign-student journey enrollment references.

## REPAIR AND REVERIFY

The first full-suite run after schema/input tightening exposed stale dependent
fixtures that generated alphabetic phone placeholders and three Placement-owned
suites that submitted client tuition values contradicting the canonical class
fee. The fixtures were corrected to valid unique phones and stopped submitting a
client fee where the class owns it; product guards were not weakened.

Artifact-only review then reproduced two additional security failures after the
initial release gate:

- `Payment.View` from another branch unredacted student profile, CSV, journey,
  finance summary, and direct finance timeline data and could lend a debt-hold
  override;
- invalid lead phone text was accepted and failed only when the student database
  trigger executed during conversion.

The repair correlated finance and hold decisions to the student branch, made
financial row serialization per-branch, used a safe uniform CSV rule, added
shared lead/student phone syntax checks at intake/update/conversion, and extended
the attack case. Package count increased from 354 to 355 and attack count from
23 to 24.

A final lifecycle review then reproduced two bypasses inside the existing
multi-enrollment suspension attack: ordinary `suspended → inactive` PATCH
returned 200, and a general journey enrollment carrying
`enrollmentType: resume` returned 201. The canonical lifecycle guard and the
enrollment service now reject both with 409, leaving the profile, suspended
enrollments, and mapped semesters unchanged until the dedicated resume workflow
runs. The frontend ordinary-status controls mirror that restriction. A final UI
projection review also removed the assumption that one finance-bearing row made
missing balances authoritative for every branch.

The final independent pass removed the residual class-wide compatibility
fallback for an old suspension lacking an exact restoration batch: that case now
fails closed without changing the profile, enrollment, or deferred semester.
Status writes also compare the expected source state inside their transaction,
and search-result Resume dispatch carries the opened profile status instead of
consulting a potentially incomplete roster cache.

Package, dependent, WP-02 authority, full-suite, typecheck, schema, audit,
build, bundle, dependency and release gates were rerun after the repairs.

## INDEPENDENT REVIEW

A separate cold, artifact-only pass read the final diff and direct consumers
without following the implementation narrative. It checked:

- every student/visitor/journey route guard for exact permission and correlated
  branch/object reach;
- every profile, lead, conversion, suspension, resume, enrollment, journey, and
  notification writer for transaction and authority boundaries;
- normalized identity keys against application comparisons and schema triggers;
- capacity/uniqueness semantics across enrollment and semester identities;
- financial shape across list/search/detail/export/journey/UI and multi-position
  cross-branch principals;
- UI controls and API loading against server-redacted capability shape,
  including partial multi-branch finance projections and absent balances;
- suspended-profile ordinary status, stale-search dispatch, general-enrollment,
  unmapped-restoration, and concurrent-source-state bypasses against the
  dedicated whole-student resume command;
- C-2 file placement, registry references, schema counts, generated artifacts,
  and Git diff/status.

The review produced the branch-correlated finance/debt-hold, lead-phone,
suspended-lifecycle, alternate-resume, unmapped-restoration, and row-correlated
UI projection/dispatch repairs above, corrected false/historical comments, and made redacted frontend finance
types optional. No unresolved Critical or High WP-03 defect, contradictory
authority, or mapped legacy behavior remains. As recorded by TR-4,
this review was performed by the same agent and is mitigated by executable
findings rather than represented as independent personnel.

## CLEAN

- All fourteen mapped suites reside under `work-packages/wp03`; no old active
  path or contradictory manual lifecycle/payment fallback remains.
- No debug service logging, temporary database, generated build output,
  dependency change, or abandoned experiment is tracked.
- Source cleanliness, logging, design-system, dependency, protocol, registry,
  static, product, bundle, and release-hygiene gates pass.
- `git diff --check`, canonical-schema preflight, and tracked-artifact scans pass.

## LEGACY-TEST RESET (C-2)

Historical WP-03 inventory: **14 files / 326 statically declared cases / 331
executed baseline cases**.

Final replacement authority: **15 mapped package files / 355 executed cases**:

- 14 rebased requirement suites — 331 cases;
- `students-admissions.attack.test.ts` — 24 cases.

`students-admissions-ui-regression.test.ts` contributes one supplemental mixed-roster finance/resume-dispatch case,
bringing the executable directory to 16 files / 356 tests; it is deliberately
excluded from the mapped replacement total above.

The exact disposition of every historical file is recorded in
`docs/legacy-test-inventory.md`.

## QUALITY GATE

| Dimension | Verdict | Evidence / limit |
|---|---|---|
| Correctness | PASS | 355 mapped package tests plus 1 supplemental UI regression, 157 dependent tests, and full suite at 2605 passed / 0 skipped / 0 failed |
| Architecture | PASS | one profile lifecycle model, one enrollment writer, chronology not shadow state, registered canonical authorities |
| Data integrity | PASS | normalized identity and Tazkira backstops, exact suspension mappings, transactional conversion/lifecycle effects |
| Security / RBAC | PASS | exact workflow permission, branch/object scope, cross-position laundering, finance redaction, and notification attacks pass |
| Privacy | PASS (scope) | financial events/fields require branch-correlated finance authority; class/own student scope remains filtered |
| UX / UI | PASS (scope) | callback date, actionable eligibility, actual placement snapshot, capability controls, and unpaid balance output are coherent |
| Reliability | PASS | atomic lifecycle/conversion, deterministic journey order, malformed-payload protection, idempotent schema/release probes |
| Performance | SUPPORTED | prepared/batched roster projections, explicit-ID balance/class aggregation, bounded inputs, bundle budget passes |
| Maintainability | PASS | shared input/lifecycle/balance/ABAC authorities, explicit registries, package-owned tests |
| Repository cleanliness | PASS | lint has zero errors; protocol/registry/static/dependency/design/logging/cleanliness gates pass |
| Testing | PASS | C-2 complete for WP-03; package, attack, dependent, full, schema, build, bundle, and release evidence |
| Operational readiness | PASS (package only) | production builds and 22-step release validation pass without certifying full-system readiness |

## CERTIFY

**WP-03 Students & Admissions: READY.**

This is a bounded package certification under §§54–76 and §W. It certifies only
the student profile/lifecycle, visitor/CRM/conversion, journey chronology,
direct admissions writers, and exact consumers listed in SCOPE. Placement,
Academic Structure, Academic Delivery, Finance, Reporting, Audit, and all later
Work Packages remain uncertified. This artifact does **not** claim full-system or
production release readiness.
