# Cross-module consolidation audit

**Date:** 2026-09-05  
**Role:** Supreme Technical Owner / Principal Architect  
**Scope:** repository-wide static authority, boundary, security, lifecycle, finance, transport, frontend, reporting, and integration review  
**Verdict:** **Not production-ready.** This pass is a historical consolidation baseline; the current static convergence state is recorded in `2026-09-05-fourth-architecture-convergence.md`. Runtime, database, concurrency, route, browser, and deployment validation remain deferred.

## 1. Method and decision standard

Both implementation lines present in the checkout were compared rather than treating either as the answer. The comparison considered correctness, security, usability, completeness, integrity, scalability, performance, failure behavior, concurrency, auditability, and maintainability. Capability was preserved where possible; implementation was not preserved merely because it existed. Where neither line provided a safe single authority, the third-system decision is recorded below.

This is a static audit. PHP, Composer, PostgreSQL, migrations, PHPUnit, PHPStan, Pint, Node, browser, HTTP, queue, and integration execution were deliberately not run in this phase.

## 2. Authority inventory

The following is the normative inventory after the consolidation decisions. “Read authority” means the query/projection that may present the concept; “authorization authority” is the server-side decision authority, not a controller check. A blank lifecycle/history entry means the concept is a value object or projection rather than an independent state machine.

| Concept | Canonical model/table | Command/service and write path | Read authority | Authorization authority | Lifecycle authority | Historical authority | Competitors / disposition |
|---|---|---|---|---|---|---|---|
| Organization | `Organization` / `organizations` | `CreateStructureUnit`, `RenameStructureUnit`, `TransitionStructureUnit` | `EffectiveStructureQuery` and organization console | `AccessResolution` + `StructureDecision` | `OrganizationLifecycle` | `audit_events`, domain events | No second structure root; organization-wide reads require organization-rooted capability |
| Campus | `Campus` / `campuses` | `CreateStructureUnit`, transfer command | `EffectiveStructureQuery` | `AccessResolution` | `OrganizationLifecycle` | `CampusAssignment`, audit | Campus attribution history is canonical; no controller-owned structure mutation |
| Branch | `Branch` / `branches` | `CreateStructureUnit`, transfer command | `EffectiveStructureQuery`, `ActorBranches` | `AccessResolution`, `BranchScopedAccess` | `OrganizationLifecycle` | `CampusAssignment`, audit | Branch is the operational isolation key; null is unknown, not wildcard |
| Person | `Person` / `people` | `RegisterPerson`, `VerifyPerson` | `PersonDirectoryQuery` | `AccessResolution` | Identity verification state | audit and append-only identity facts | No employee/person duplicate; employee is a relationship to Person |
| Account | `UserAccount` / `user_accounts`; Finance `Account` / `accounts` | Identity account commands; `MaintainChartOfAccounts` for Finance | identity directory; Finance queries | `AccessResolution`; Finance command capabilities | account/finance lifecycle respectively | audit; journal history | Same name, different bounded concepts; not merged |
| Employee | Person + `Employment` / `employments` | `MaintainEmployment` | HR console and employment reads | `AccessResolution` checks HR eligibility | `EmploymentLifecycle` | employment/contract history | No `Employee` duplicate table |
| Employment | `Employment`, `Contract`, `ContractVersion` | HR commands | HR contract queries | Access + HR command capabilities | HR lifecycle and contract version state | immutable contract versions, audit | Payroll consumes; it does not own employment |
| Position | `Position`, `PositionAssignment` | Access assignment commands | Access console | `AccessResolution` | `AccessLifecycle` | dated assignments and audit | Position is authorization topology, not an HR title duplicate |
| Authorization | `AccessPolicy`, `Role`, `ScopeGrant` | policy/grant commands | access console | `AccessResolution` only | access lifecycle | effective-dated grants/policies | Removed implicit controller/policy competitors |
| Delegation | `Delegation` / `delegations` | `DelegateAuthority`, `RevokeDelegation` | access console and `ActorBranches` | `AccessResolution` with delegator eligibility and dates | `AccessLifecycle` | immutable dated delegation/audit | No separate “temporary permission” mechanism |
| Student | `Student` / `students` | `Students\Domain\StudentAdmissionRegistrar` through Admissions conversion plus Student commands | `StudentRecordQuery`, `StudentLifecycleQuery` | branch provenance + `AccessResolution` | student status commands | status rows, branch transfers, holds | Student Lifecycle owns aggregate/status inserts; Admissions orchestrates the approved conversion |
| Applicant | `Applicant` / `applicants` | `RegisterApplicant`, `DecideAdmission`, `EnrollAdmittedApplicant` | Students/admissions queries | admissions command authority + branch visibility | admission lifecycle | decisions and provenance snapshots | No CRM conversion-owned applicant table |
| CRM / Lead | `Visitor` / `visitors` | CRM commands | `VisitorListQuery`, `VisitorTimelineQuery` | `CrmAccess` for writes; branch/global read gate for reads | `VisitorStatus` | interactions and conversion trace | CRM does not create Person, Applicant, Student, Message, or Document |
| Placement | Placement aggregate tables under Academic (`placement_tests`, profiles, attempts, recommendations) | Placement commands | placement queries | placement capabilities + branch provenance | placement state machines | attempts, scores, recommendations | Placement remains Academic-owned; no top-level duplicate module |
| Eligibility | `AcademicEligibilitySnapshot` / `academic_eligibility_snapshots` | placement/admission integration commands | `AcademicEligibilitySnapshotQuery` | Academic/Admissions authorities | snapshot state | immutable source snapshot | Snapshot is evidence, not a competing live admission rule |
| Program | `Program`, `ProgramVersion` | `MaintainAcademicStructure` | academic catalog queries | Academic structure authority | structure lifecycle | published versions | No program table in Reporting or Placement |
| Level | `ProgramVersionLevel` | `MaintainAcademicStructure::defineLevel` | academic catalog / progression queries | Academic structure authority | level lifecycle | immutable version-level facts | No independent Level aggregate; class-level FK must match version |
| Offering | `Offering` / `offerings` | `ManageAcademicOffering` | `OfferingCatalogQuery` | branch-scoped Academic structure authority | offering lifecycle | availability, waitlist, audit | Offering is the branch delivery anchor, not Class |
| Enrollment | `Enrollment` / `enrollments` | `MaintainEnrollment`, waitlist command | `ClassRosterQuery`, history queries | Academic access + Finance gate + branch provenance | `EnrollmentLifecycle` | branch snapshots, gate evidence, corrections | No admissions or reporting enrollment writes |
| Class / Section | `ClassModel` / `classes`, `ClassSection` / `class_sections` | `MaintainClass` | `GradesheetQuery`, class roster, timetable | Academic schedule authority against immutable class branch | class/section lifecycle | assignments, sessions, enrollment history | Class now has required provenance for new inserts; no offering/session inference for new truth |
| Room | `AcademicRoom` / `academic_rooms` | `MaintainRoom` | timetable/room queries | branch-scoped Academic structure authority | room lifecycle | audit and booking evidence | Canonical room table; no generic Resources room authority found |
| Timetable | `ClassSession` / `class_sessions` + `TimetableQuery` | `MaintainClass::scheduleSession` | Timetable query and session controllers | class branch plus same-branch room | session fact is append-only | session/attendance evidence | Calendar conversion is not timetable authority |
| Attendance | `AttendanceFact` / `attendance_facts` | `RecordAttendance` | attendance/academic queries | session/class branch and Academic attendance capability | fact/correction semantics | append-only correction chain | No mutable attendance total is authoritative |
| Assessment | attempts/results/corrections tables | `ManageAssessmentResult` | `GradesheetQuery`, transcript composition | separate assess/moderate/approve/release capabilities | assessment result lifecycle | result correction lineage | Reporting never edits assessment truth |
| Progression | `ProgressionDecision`, `LevelProgressFact` | `DecideProgression` | progression queries | staged Academic progression authority | progression lifecycle | decisions and evidence | No frontend transition bypass permitted |
| Completion | Academic completion evidence and terminal enrollment/class states | completion paths in enrollment/class/graduation commands | academic history | Academic completion capability | terminal guards | immutable terminal records | No duplicate `completion` monetary or student module |
| Graduation | `GraduationDecision` | `DecideGraduation` | `GraduationCertificationQuery` | proposal/review/approval/certification separation | graduation lifecycle | decision and certificate linkage | Certificate issuance follows graduation authority |
| Certificate | `Certificate` / `certificates` | graduation/certificate path | certification/printing queries | Academic certification authority + branch | certificate lifecycle | immutable issuance and document link | No Documents-owned certificate truth |
| Alumni | No canonical table/model | none | none | none | none | none | Missing concept, not a duplicate. Future design must choose a governed projection of graduated students or a separate aggregate; no shadow table is permitted now |
| Obligation | `Obligation`, `ObligationLine` | `PostObligation` | Finance balance/read queries | Finance capability + branch provenance | financial lifecycle | journals, corrections, audit | Finance sole monetary authority |
| Payment | `Payment`, `PaymentAllocation` | `RecordPayment`, `AllocatePayment` | Finance balance queries | Finance capability + branch provenance | payment/allocation lifecycle | allocation and reconciliation history | No Academic/Payroll payment table |
| Allocation | payment/fund allocation models | Finance allocation commands | Finance queries | Finance | allocation state | append-only allocation/reversal | Corrections compensate source facts |
| Refund | `Refund` | `RefundPayment` | Finance console | request/approve SoD | refund lifecycle | source-linked refund history | No destructive payment mutation |
| Discount | `Discount` | `MaintainDiscount` | Finance console | propose/approve SoD | discount lifecycle | proposal/approval audit | No Academic price calculation |
| Credit | `FinancialCredit` | `MaintainFinancialCredit` | Finance gate/balance queries | Finance propose/approve | credit lifecycle | source evidence and audit | No CRM or Admissions credit authority |
| Installment | `EnrollmentInstallmentPlan` | `MaintainInstallmentPlan` | Finance queries | Finance propose/approve | installment lifecycle | plan revisions/history | no duplicate enrollment payment plan |
| Financial Gate | `FinancialGateException`, gate query | `MaintainFinancialGateException`, `FinancialGateQuery` | gate read model | Finance gate authority | gate/exception lifecycle | gate decisions and source facts | Academic consumes gate; cannot override it |
| Financial Correction | `FinancialCorrection` | `MaintainFinancialCorrection` | Finance correction queries | independent Finance approval | proposed -> recorded; recorded immutable | source-linked compensating fact | no direct source rewrite |
| Journal | `Journal`, `JournalLine` | `PostJournal` | Finance journal queries | Finance journal capability | posted/reversal semantics | source-linked reversal history | no Payroll or Reporting journal |
| Payroll | Payroll calculation/result/adjustment tables | Payroll calculation/approval commands | Payroll console; Finance recognition reads source evidence | Payroll capabilities and SoD | payroll period/result lifecycle | immutable result and adjustment history | Payroll calculates; Finance recognizes monetary liability |
| Settlement | Finance `EmploymentSettlement` / `employment_settlements` | `MaintainEmploymentSettlement` | Finance settlement queries | Finance branch-scoped approval | immutable recorded fact | source-linked proposal and audit | Payroll `SettlementProposal` is workflow evidence only; duplicate Payroll final settlement removed |
| Document | Documents aggregate tables | document commands | `DocumentHistoryQuery` | document capabilities, branch/subject authority | document/retention lifecycle | versions, verification, retention decisions | no file path authority in controllers |
| Notification | `Message` / communication tables | `SendMessage` | Communication console/integration reads | communication capability | queued/sent/delivered/failed | delivery attempts/audit | no command emits ad-hoc notifications |
| Outbox | `domain_events` (new immutable transaction log); `integration_deliveries` endpoint projection | `AuditRecorder` -> `TransactionalEventRecorder`; `DispatchDelivery` for endpoint delivery | domain event and delivery queries | source command authority plus integration capability | events immutable; delivery progress lifecycle | event/audit evidence and delivery attempts | `audit_events` is evidence, not the bus; no generic `outbox_events` duplicate remains |
| Reporting | metric catalog/versions/projections/report runs | Reporting commands | catalog calculators and report runs | `reporting.*` plus organization/branch scope | metric/version/run lifecycle | reproducibility hash and metric reconciliation | calculators may not become source authority |
| Audit | `AuditEvent` / `audit_events` | `AuditRecorder`, attempted/rejected operation recorders | Audit console/query | audit access | append-only | immutable audit evidence | not conflated with domain events |

### Inventory conclusions

* There is one authoritative model per business fact after the changes above. Where two records remain, their roles are explicitly different evidence versus fact (Payroll proposal versus Finance settlement; Payroll result versus Finance liability recognition; audit evidence versus domain event; eligibility snapshot versus live admission decision).
* There is no Alumni implementation to consolidate. It is recorded as an intentional gap rather than invented during this pass.
* Calendar remains a distinct conversion/value authority for Solar Hijri dates. Academic owns periods, class sessions, rooms, sections, and timetable facts.

## 3. Duplicate authority inventory and dispositions

| Conflict | Evidence | Decision |
|---|---|---|
| Payroll `SettlementProposal` versus Payroll/Finance final settlement | `SettlementProposal`, Finance `EmploymentSettlement`, migrations `000056`, `000142`, `000143` | Finance `employment_settlements` is the only recorded monetary settlement. Payroll proposal remains non-monetary workflow evidence. Payroll `FinalSettlement` model is removed; migration `000143` prevents recreation. |
| Audit event versus outbound delivery versus domain event | `AuditRecorder`, `audit_events`, `IntegrationDelivery`, `integration_deliveries` | Audit stays append-only evidence. New `domain_events` is the transactional event/outbox boundary. `integration_deliveries` remains endpoint-specific progress and retry state. |
| Payroll total calculator versus Finance monetary authority | `PayrollTotalCalculator` previously summed Payroll tables | Finance now owns `payroll_liability_facts`; Payroll results/adjustments are source evidence and require Finance recognition. `payroll_total` catalog ownership is Finance. |
| Class branch inferred from room/offering versus no class provenance | `classes` had no branch; room and offering had branch | New class inserts require immutable `branch_id`; session scope comes from the class, and a room must match it. Historical nulls remain quarantined, not guessed. |
| Placement as a separate top-level domain versus Academic Placement | Placement models/commands are nested under Academic | Placement remains Academic-owned; Admissions consumes released evidence. |
| Generic room versus Academic room | `AcademicRoom` and no competing generic room model | `academic_rooms` is canonical. |
| Person versus Employee | Identity `Person` plus HR `Employment` | Preserve two facts with a relationship; do not add Employee table. |

## 4. Schema conflicts and implemented invariants

1. **Class provenance:** migration `2026_09_05_000144_add_class_branch_provenance.php` adds a nullable historical-compatible `classes.branch_id`, foreign key/index, an insert guard requiring new provenance, and an immutability guard. `MaintainClass` resolves an explicit branch (or a single unambiguous visible branch for programmatic callers), authorizes it, and persists it. This avoids fabricating branch attribution for existing rows while making new truth safe.
2. **Session/resource consistency:** scheduling authorizes the class branch and rejects a room from another branch. `TimetableQuery::forBranch` uses class provenance, so room-less sessions no longer evade branch filtering.
3. **Finance source linkage:** `payroll_liability_facts` is append-only, source-unique, amount-checked, branch-provenanced, and records period, employment, Finance actor, correlation, and evidence reference. Finance recognition requires an approved Payroll source, exact signed amount match, a Payroll/Finance actor split, active employee branch provenance, and branch-scoped Finance authorization.
4. **Event immutability:** `domain_events` has a unique audit source, actor/aggregate/correlation identity, payload digest, and database append-only protection.
5. **Existing migration concern:** historical settlement migrations still reference `final_settlements`; `000143` is intentionally one-way. Clean-schema and upgrade paths are unresolved until runtime validation and data-reconciliation preflight exist.

## 5. API and transport conflicts

* Web and JSON routes remain separate transports over shared command authorities. That is acceptable only when validation, error mapping, idempotency, read scope, and response contracts are compared explicitly.
* The web/API Academic session reads now use class branch provenance. The prior JSON path admitted room-less sessions without a branch condition; this was an IDOR/isolation defect.
* Payroll console and API period/calculation bulk reads now require organization-rooted `payroll.period`/`payroll.calculate` authority. Reporting, Organization, Home, Academic bulk console, and CRM bulk console reads likewise require explicit organization-wide authority where the query intentionally remains broad.
* CRM JSON visitor detail/timeline reads now invoke `requireBranchVisible`; the bulk endpoint and web console use organization-rooted authority. Mutating commands continue to own branch authorization.
* Students and Finance already had branch-derived bulk filters. Their parity is retained rather than replaced by controller-local authorization.
* New Finance Payroll Liability recognition is exposed through both web and API routes and delegates to the same Finance command.
* Remaining route parity risks include differences in error serialization, controller `findOrFail` timing before command denial, omitted API fields, and unreviewed high-risk read methods outside the named consolidation set. They are not claimed resolved by shared commands alone.

## 6. Lifecycle conflicts

* **Class/session:** class transitions and terminal-seat guards remain in `MaintainClass`; session creation is not a class transition and inherits class provenance.
* **Enrollment:** requested/active/frozen/transferred/withdrawn/completed remains `EnrollmentLifecycle`; Finance gates and branch snapshots are inputs, not competing state machines.
* **Assessment:** submit, score, moderate, approve, release, and correction are distinct authority stages. Released results are never rewritten.
* **Graduation/certificate:** graduation approval/certification precedes certificate issuance; transcripts are read projections of certified evidence.
* **Finance corrections:** source facts remain immutable; corrections are proposed then independently recorded and source-linked.
* **Payroll/settlement:** Payroll result and adjustment history is immutable. A proposal is not a settlement. Finance recognition/settlement is the monetary boundary.
* **Delivery:** domain events are immutable facts; integration delivery status may progress under its delivery state machine and never rewrites event identity.

## 7. Security findings and decisions

### Findings fixed in this pass

* Broad controller reads did not consistently invoke `ActorBranches`; write command authorization did not protect read paths. The base controller now supports an explicit organization-rooted read gate, and the named broad consoles use it.
* Room-less Academic sessions had no canonical branch provenance. Class provenance and class-based read filtering now close that fail-open path for new truth.
* Timetable branch reads previously depended on room ownership and therefore omitted room-less sessions. They now use class branch provenance.
* CRM detail/timeline API methods could resolve a visitor without a read-side branch gate. They now fail closed through `requireBranchVisible`.
* Organization structure read capability was missing from the bootstrap capability set even though structure decisions used its three capabilities. The three canonical capabilities are now seeded for the Owner role.
* Payroll reporting could expose Payroll monetary sums as if Finance owned them. Finance recognition is now explicit and auditable.

### Remaining security risks

* Historical null-provenance rows remain inaccessible to branch-scoped paths but need a governed remediation/reporting process.
* Some controllers and API detail methods outside the reviewed set still query first and rely on commands later; static IDOR review must continue.
* `ActorBranches` and `AccessResolution` both traverse access topology. They intentionally share lifecycle/date semantics but still need executable contract tests proving no stale delegation, inactive employment, or organization mapping divergence.
* Direct SQL can bypass command-level contracts until every high-risk table has database protection; the migrations cover important facts but not every aggregate.
* File/document authorization and path traversal require runtime and storage-adapter validation.
* Organization-rooted read gates may be stricter than some branch-operational workflows. A later usability review should add explicit branch-scoped query objects, not weaken the fail-closed gate.

## 8. Finance findings

* Finance remains the sole monetary authority for obligations, payments, allocations, refunds, credits, discounts, installment plans, corrections, journals, employment settlements, and recognized payroll liabilities.
* Payroll remains responsible for deterministic calculation and source-linked approved adjustments. It cannot write `payroll_liability_facts`.
* `payroll_total` now sums only Finance-recognized liability facts. An approved Payroll result that Finance has not recognized is intentionally absent from the monetary report; this prevents a report from silently becoming a second posting authority.
* The new Finance recognition command enforces approved source state, exact amount, source uniqueness, Finance organization-wide capability, evidence reference, idempotency, audit, and transactional domain event creation.
* No claim is made that recognition is yet wired to a disbursement/GL posting policy. That downstream lineage is an unresolved runtime/business validation item.

## 9. Frontend findings

* Blade views were generally thin transport surfaces, but Academic classes offered no branch input even though branch is now required. The class form and controller now carry `branch_id` and remove the misleading “legacy class” wording.
* Academic session selectors and resource lists are now expected to contain only visible class branches. Empty results for a user without visible branch authority are intentional fail-closed behavior.
* Reporting and Payroll views continue to use their command endpoints; their broad index reads now have server authorization rather than relying on hidden navigation.
* Web/API input contracts for Finance payroll-liability recognition are aligned at field level: source type, source id, amount, and evidence reference.
* Runtime rendering, accessibility, responsive layout, stale route links, browser behavior, and JavaScript/API consumers were not executed. Frontend correctness is therefore not signed off.

## 10. Outbox and event findings

Before this pass, `integration_deliveries` was the only outbox-like table. It correctly carried endpoint, idempotency, source, payload digest, retries, dead-letter progress, and delivery evidence, but it was not a generic transactional domain-event stream. `audit_events` was append-only evidence and was not a bus.

The implemented third boundary is:

1. a successful command writes its fact;
2. `AuditRecorder` writes immutable audit evidence;
3. in the same transaction, `TransactionalEventRecorder` writes one immutable `domain_events` row linked to that audit event;
4. commit is the publication boundary;
5. an eventual integration projector may turn a domain event into endpoint-specific `integration_deliveries` rows with their own idempotency and retry state;
6. no event recorder performs network I/O or mutates audit evidence.

Denied attempts remain audit evidence and do not become business domain events. This prevents conflating security evidence with a successful state transition.

Unresolved: no projector/consumer contract is implemented yet, and no runtime proof exists for rollback, duplicate delivery, poison payloads, dead-letter requeue, or ordering.

## 11. Reporting findings

* Metric ownership is registered in `MetricCatalog`; report runs carry metric version/period/scope and reproducibility metadata.
* Finance owns `student_outstanding_balance`, fund utilization inputs, and now `payroll_total` monetary recognition. Academic, CRM, Placement, and Reporting do not post monetary facts.
* Payroll total lineage changed from “approved Payroll results plus adjustments” to “Finance-recognized Payroll liability facts.” The old calculation was a duplicate monetary authority and has been removed from the calculator path.
* Reporting still contains derived calculators that need runtime reconciliation against source facts, especially period boundaries, branch scopes, and correction semantics.
* No report is a source of truth. A metric catalog entry without a valid source-period contract must fail, not invent a Reporting period.

## 12. Changes implemented

* Added immutable `domain_events` schema/model/recorder and wired successful `AuditRecorder` operations to it transactionally.
* Added immutable class branch provenance migration, command support, room/class branch consistency, class-scoped timetable reads, and UI/controller branch input.
* Added Finance-owned `payroll_liability_facts`, model, recognition command, bootstrap capability, web route, API route, and Finance-backed payroll total calculation.
* Added base-controller organization-wide read authorization and applied it to the identified broad Academic, Payroll, Reporting, Home, Organization, and CRM console reads.
* Added API payroll bulk read protection, CRM detail/timeline branch protection, and class-based Academic API session filtering.
* Updated the metric catalog specification to Finance ownership and updated the direct-class schema specification to include branch provenance.
* Preserved command-centric mutations; no controller-side domain mutation authority was introduced.

## 13. Deleted or retired obsolete architecture

* The duplicate Payroll `FinalSettlement` model is deleted in the consolidation changes; the Finance `EmploymentSettlement` fact is canonical.
* `final_settlements` is not recreated by the current settlement consolidation migration. Its one-way rollback is deliberate because recreating a competing authority would be unsafe.
* The Payroll total calculator no longer treats Payroll result/adjustment tables as the monetary reporting authority.
* No duplicate Alumni, room, level, employee, placement, or generic outbox implementation was invented or retained.

## 14. Unresolved risks and decisions requiring later work

1. Reconcile historical `final_settlements` rows before any upgrade is considered safe; prove migration `000056`/`000103`/`000112` interactions on clean and upgraded schemas.
2. Define and implement the Finance recognition-to-journal/disbursement lineage, including corrections after recognition and period close behavior.
3. Build the domain-event projector to endpoint deliveries and prove idempotency/concurrency under retries.
4. Complete branch provenance remediation for historical classes and other null anchors without fabricating ownership.
5. Replace remaining broad high-risk reads with named branch-scoped query objects where organization-wide access is not the intended UX.
6. Compare every web/API route pair for validation, response shape, authorization timing, error code, idempotency key, and audit correlation.
7. Add a governed Alumni decision: projection from graduated students versus a separate aggregate with explicit ownership and history.
8. Validate file access, document subject authorization, queue workers, scheduler behavior, and frontend contracts.
9. Perform the mandatory Integrated Enterprise System Architecture Graph conformance audit: map every major fact, context, typed relationship, command/query/event path, workflow, task, approval, work item, exception, notification, document, search projection, report, management decision, and critical failure behavior to repository evidence.

## 15. Later runtime validation plan

This plan is specification only and was not executed:

* run clean-schema and upgrade migrations against PostgreSQL, including trigger/index/FK checks;
* run PHP syntax, static analysis, formatting, and the full test suite;
* test concurrent class creation/session scheduling, class branch mismatch, room mismatch, and historical null fail-closed reads;
* test command rollback proves no fact, audit event, or domain event survives a failed transaction;
* test duplicate idempotency keys and unique-source Finance payroll recognition;
* test Payroll adjustment recognition, Finance period close, correction lineage, and report reproducibility;
* exercise web/API parity for Academic sessions, CRM visitor detail, Payroll reads, Finance liability recognition, and reporting;
* run browser/accessibility/responsive tests for changed class/session/finance views;
* test domain-event projection retries, duplicate endpoint delivery, dead-letter/requeue, payload digest, and ordering;
* perform security tests for IDOR, inactive employment, expired delegation, stale grants, unknown/null provenance, direct SQL writes, SoD, and unsafe document access.

## 16. Employee Workspace findings

The approved Employee Workspace Principle is now incorporated into the Master Engineering Contract addendum, the Supreme Technical Governance Mandate §37, the architecture state, system topology, module boundaries, dependency graph, transaction, Finance, authorization, workflow, lifecycle, reporting, audit, integration, background-processing, error, observability, resilience/security, testing, invariant, traceability, gate-review, implementation-state, employee-interface, and coverage-matrix documents. ADR `2026-09-05-employee-workspace-principle.md` records the architectural decision.

The requirement is first-class and remains unimplemented as a concrete workspace product surface. A generic dashboard, static role dashboard, cached task list, or frontend-only hidden menu would not satisfy it. The target must dynamically compose effective identity, employment eligibility, positions, assignments, capabilities, scope, lifecycle, tasks, approvals, deadlines, notifications, authoritative context, and exceptions; support multiple positions and management-specific work; optimize real employee efficiency; and route every mutation through canonical server-authorized domain commands. Workspace visibility, personalization, aggregation, and projections must not create authority, permission, financial truth, lifecycle truth, or independent approval/task state.

The current frontend/API artifacts are historical transport coverage, not proof of workspace readiness. Runtime validation must cover command-time revocation after suspension/termination/expiry/transfer/delegation changes, branch isolation, API/web parity, freshness and rebuildability, projection failure, accessibility, usability, exception visibility, and efficiency metrics.

## 17. Final static contract review

The pre-runtime contract review covered changed route/action mappings, imported application classes, Payroll source fields, Finance recognition boundaries, migration ordering, model fillable fields, and audit integration call sites:

* Changed web/API controller action references resolve to existing public methods by static inventory: 356 route controller actions checked, with no unresolved action or import; changed `App\\...` imports resolve to repository files.
* Payroll result compatibility is explicit: approved result source fields are `lifecycle_state`, `period_id`, `employment_id`, and `amount`; approved adjustment source fields are `result_id` and `amount`. Finance recognition derives period and employment from the result, requires approved state, rejects zero sources, requires exact amount equality, and the database trigger repeats source existence, approval, identity, and amount checks.
* `PayrollLiabilityFact` fillable fields match migration columns and the reporting calculator reads only the Finance table. `ClassModel` fillable/provenance fields match the class migration and gradesheet output includes `branch_id`.
* `AuditRecorder::record()` retains the existing required six-argument call shape and adds only an optional correlation argument; a static argument scan covered 234 application call sites and found only six- or seven-argument calls (trailing commas excluded). Successful audit writes create a linked domain event; denied-attempt recording remains audit-only by operation convention.
* Migrations `000140`–`000146` are ordered so Finance settlement storage precedes the one-way Payroll settlement consolidation, class provenance precedes event/liability additions, and Payroll source tables precede Finance liability guards. The historical settlement upgrade path, one-way rollback behavior, trigger ordering/locking, and clean-schema execution remain unverified.

This review is static only. No PHP/Composer/PostgreSQL/Node execution, migrations, tests, builds, commits, or pushes were performed.

## 18. Final architectural verdict

The repository is materially closer to one coherent third-system architecture: command writes are retained, authorities are named, Finance monetary recognition is explicit, class/session provenance is no longer inferred for new truth, audit evidence is separated from transactional domain events and endpoint delivery progress, the Employee Workspace requirement is governed across the architecture, and the mandatory Integrated Enterprise System Architecture Graph is now the target conformance contract.

The graph is mandatory and non-negotiable, but repository conformance has not yet been established. It requires a subsequent enterprise-wide code/schema/API audit covering every major fact owner, typed relationship, lifecycle, command, projection, event, workflow, document, notification, search path, reporting path, and failure behavior.

It is **not production-ready**. The remaining risks are substantive conformance, runtime, usability, security, and data-reconciliation risks, not documentation gaps. No production-readiness claim should be made until the graph conformance audit and deferred validation plan pass and the unresolved Employee Workspace implementation/validation, settlement, event projection, provenance remediation, route parity, and Finance posting decisions are closed.
