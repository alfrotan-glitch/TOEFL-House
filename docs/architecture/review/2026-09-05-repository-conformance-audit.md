# TOEFL House — Repository Conformance Audit

**Date:** 2026-09-05  
**Repository:** `alfrotan-glitch/TOEFL-House`  
**Branch:** `arena/01a07134-toefl-house`  
**Target:** `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md`  
**Audit type:** repository-wide static conformance audit  
**Verdict:** **NOT CONFORMING**

> Historical baseline: this audit predates the convergence slices recorded in `2026-09-05-fourth-architecture-convergence.md`. Read that required report for the current static actual/gap/decision/implementation state; this document remains evidence of the earlier conformance starting point.

This document compares the target architecture with the repository as it exists in the current worktree. It is a conformance finding, not a production-readiness statement. The audit did not run PHP, Composer, PostgreSQL, migrations, PHPUnit, PHPStan, Pint, Node, browser, queue, HTTP, or integration execution.

## 1. Executive result

The repository contains a substantial, disciplined Laravel modular-monolith implementation with canonical Finance facts, Payroll results, Academic delivery, branch-aware authorization, append-only history, audit evidence, and a transactional domain-event recorder. It is nevertheless **not conforming** to the mandatory Integrated Enterprise System Architecture Graph.

The decisive gaps and contradictions are:

1. **Enrollment is implemented inside Academic.** The target makes Enrollment its own authority for enrollment membership and decision. `Academic\\Models\\Enrollment` and `Academic\\Commands\\MaintainEnrollment` remain the sole write path, so the authority is singular but the bounded-context boundary is wrong.
2. **Scheduling is implemented inside Academic.** `MaintainClass::scheduleSession()` creates `Academic\\Models\\ClassSession` and owns room, section, teacher, and timetable constraints. There is no Scheduling context or application boundary.
3. **Workflow / Work Management is missing.** Resource `WorkOrder` is a facilities/resource fact, not the target's separate Task, Approval, WorkItem, Exception, and process-coordination capability. Domain-specific approvals exist, but there is no Workflow authority.
4. **Employee Workspace is missing as a product capability.** There is no Workspace module, aggregate, query, controller, API route, web route, Blade view, React tree, or typed workspace contract.
5. **The event/outbox chain stops at append-only recording.** `domain_events` and `TransactionalEventRecorder` exist, but no static consumer/projector/relay was found that reads domain events and creates integration deliveries or durable internal projections. `ProcessDeliveries` processes pre-existing endpoint delivery rows; it is not a domain-event relay.
6. **Search and Notification capabilities are missing.** Communication messages are not a Notification authority, and no Search projection/index boundary was found.
7. **The documented frontend target and actual frontend disagree.** Existing architecture reconciliation documents select a React/TypeScript feature frontend; the repository contains a Blade employee console and no package/frontend feature tree.
8. **Finance has the strongest fact ownership, but the full accounting flow is incomplete.** Obligations, payments, allocations, corrections, payroll liability recognition, journals, and reconciliations exist. The static code does not demonstrate that every approved monetary source automatically produces an accounting event/subledger/GL entry through a governed flow.
9. **The migration result is not statically executable evidence.** Historical `final_settlements`, `compensation_components`, and `work_bases` definitions remain in migration history while later migrations remove or supersede them. The intended active authority is clear, but clean-schema and upgrade outcomes remain runtime questions.

No second Enrollment, Payment, Payroll Result, Payroll Liability, or Finance Settlement fact owner was found. The principal issue is therefore not uncontrolled duplication of every named fact; it is that several target contexts and propagation paths are absent or merged.

## 2. Method and comparison chain

The audit followed the required chain:

```text
TARGET ARCHITECTURE
 → ACTUAL DOMAIN STRUCTURE
 → ACTUAL BACKEND
 → ACTUAL DATABASE / MIGRATIONS
 → ACTUAL API / WEB ROUTES
 → ACTUAL FRONTEND
 → ACTUAL EVENTS / OUTBOX
 → ACTUAL REPORTING
 → ACTUAL AUTHORIZATION
 → ACTUAL WORKSPACE
```

Static evidence was cross-checked across:

- the target graph and governing architecture/ADR documents;
- `app/Modules/*/Models`, `Commands`, `Queries`, `Domain`, and supporting ports;
- `database/migrations/`, including migration ordering, historical drops, triggers, indexes, and foreign keys;
- `routes/api.php`, `routes/web.php`, and `app/Http/Controllers`;
- `resources/views/` and repository frontend/package inventory;
- Outbox, Integrations, Audit, Reporting, and authorization infrastructure;
- references to each required business concept, including raw table access and direct cross-module writes.

The comparison treats an ordered migration as an intended schema transition, not as proof of the deployed schema. It also distinguishes a read-side cross-domain query from an unauthorized write. A target concept was not invented merely to make the matrix appear complete.

## 3. Finding classification

| Classification | Meaning in this audit |
|---|---|
| `CONFORMING` | The actual owner, write boundary, schema representation, and principal contract agree with the target for the inspected scope. |
| `PARTIALLY CONFORMING` | A usable implementation exists, but one or more target edges, invariants, propagation paths, or boundary details are incomplete. |
| `CONTRADICTORY` | The repository chooses a boundary, authority, or mutation path that conflicts with a mandatory target decision. |
| `MISSING` | The target capability or authority has no actual repository implementation. |
| `DUPLICATED` | More than one active implementation claims the same authoritative fact. Historical migrations or clearly separate evidence records are not counted as active duplication without runtime evidence. |
| `UNRESOLVED` | Static inspection cannot establish the result, most commonly because it depends on the resultant database, runtime wiring, data, queue, or deployment. |

## 4. Target-to-actual conformance matrix

### 4.1 Enterprise contexts and capabilities

| Target context / capability | Target responsibility | Actual repository structure | Status | Classification / finding |
|---|---|---|---|---|
| Organization | Organization, campus, branch, department, reporting scope | `Organization`, `Branch`, `Campus`, `Department`, `CampusAssignment`, structure commands, branch-scope links | Implemented with branch provenance and effective structure queries | `PARTIALLY CONFORMING` — the target's complete cost-center/reporting-context surface and emitted event/consumer chain are not demonstrated |
| People / Identity | Person identity, account identity, actor context | `Identity`, `Person`, `UserAccount`, authentication routes, `Actor` | Person and account authorities are separated | `CONFORMING` for the inspected identity scope |
| Workforce / Employment | Employment, position, assignment, lifecycle, work eligibility | `Hr` owns employment/contracts/leave/scales; `Access` owns `Position` and `PositionAssignment` | Employment exists, but position/assignment storage and commands are in Access | `CONTRADICTORY` — the target assigns position/assignment to Workforce, while Access treats them as authorization topology |
| Authorization | Effective resource/scope/lifecycle/context decision | `AccessResolution`, `AccessDecision`, `StructureDecision`, `ActorBranches`, capability-bearing commands | Server-side command decisions and read-side branch filtering exist | `PARTIALLY CONFORMING` — central decision infrastructure is present, but the full resource relationship model and all read contracts are not proven statically |
| CRM | Prospect, lead, source, interaction, follow-up, conversion trace | `Crm` models, commands, queries, routes, and views | CRM writes its own facts; downstream conversion lineage is recorded | `CONFORMING` for current CRM scope |
| Admissions / Application | Application/admission case and decision, distinct from Applicant participation | `Admissions\\Models\\Applicant`, `AdmissionDecision`; no `Application` model/table or application route | Applicant is carrying the intake/admission case role | `CONTRADICTORY` — the target explicitly separates Applicant participation from Application/case |
| Placement | Attempts, evidence, scoring, recommendation, result; no direct class assignment | Academic Placement sub-tree, placement tables, `DecidePlacement`, signed snapshot builder | Placement produces recommendation and snapshot; no direct enrollment write found | `PARTIALLY CONFORMING` — implementation is under Academic/Placement and snapshot creation is initiated by Placement while the ADR calls the snapshot an Academic fact |
| Student Lifecycle | Student participation and student status lifecycle | `Students\\Models\\Student`, append-only `StudentStatus`, status/hold/transfer commands | Student lifecycle state is owned by Students; admission conversion is orchestrated by Admissions | `PARTIALLY CONFORMING` — a static-phase correction now routes aggregate creation through `Students\\Domain\\StudentAdmissionRegistrar`; runtime boundary/authorization verification remains open |
| Academic Delivery | Program, version, level, offering, class, session, attendance, assessment, progression, completion | `Academic` models, commands, queries, migrations | Broad academic surface exists and writes are mostly centralized | `PARTIALLY CONFORMING` — Enrollment and Scheduling responsibilities are merged into Academic |
| Scheduling / Facilities | Timetable and room/teacher/availability constraint authority | No Scheduling module; `Academic\\Commands\\MaintainClass`, `ClassSession`, rooms, teacher assignments, `TimetableQuery` | One Academic command creates sessions and enforces conflicts | `CONTRADICTORY` — target requires Scheduling as a planning/constraint authority and Academic as delivery authority |
| Enrollment | Enrollment request/decision/membership consuming academic and financial eligibility | `Academic\\Models\\Enrollment`, `Academic\\Commands\\MaintainEnrollment`, `enrollments` | One actual authority, including financial gate evidence and eligibility snapshot reference | `CONTRADICTORY` — target explicitly makes Enrollment its own authority; the current Academic command decides and creates membership |
| Finance | Obligations, settlement, payment, allocation, corrections, subledger/GL and monetary truth | `Finance` models/commands/queries, obligations, payments, allocations, corrections, journals, reconciliation | Strong monetary fact boundary exists | `PARTIALLY CONFORMING` — accounting-event/subledger/GL propagation and complete AR/AP boundaries are not established |
| Payroll | Payroll periods, calculations, payroll result and adjustments | `Payroll\\Models\\PayrollPeriod`, `PayrollCalculation`, `PayrollResult`, `PayrollAdjustment`, commands | Payroll result is distinct from Finance liability | `CONFORMING` for calculation/result ownership |
| Workflow / Work Management | Process instances, tasks, approvals, work items, exceptions, coordination, escalation | No Workflow module, process/work-item tables, consumer, or workspace composition. `Resources\\Models\\WorkOrder` is a facilities work-order fact | Domain-specific staged approvals exist in several modules | `MISSING` — no target Workflow authority; resource WorkOrder must not be treated as the missing generic WorkItem |
| Documents | Versioned documentary evidence and immutable rendered artifacts | `Documents`, document/version/verification/retention models and commands | Dedicated Documents authority exists | `PARTIALLY CONFORMING` — source snapshot/render/delivery integration is not demonstrated for all document paths |
| Communication | Communication intent, delivery state, history | `Communication\\Models\\Message`, `SendMessage`, communication routes/view | Dedicated message/delivery record exists | `PARTIALLY CONFORMING` — no separate Notification event/artifact boundary and no durable event-to-message consumer found |
| Notifications | Delivery artifact informing an actor, separate from task/approval/exception | No Notification module/table/query/route/view found | Not represented as a separate capability | `MISSING` |
| Search | Search projection/index and authorization-filtered discovery | No Search module, index/projection, route, or query found | None | `MISSING` |
| Events / Outbox | Transactional domain event, relay, integration event, idempotent consumer/receipt | `Outbox\\DomainEvent`, `TransactionalEventRecorder`, `domain_events`; separate `Integrations\\IntegrationDelivery` processing | Append-only event recording and endpoint delivery machinery exist independently | `PARTIALLY CONFORMING` — the connecting relay, consumer receipts, event catalog, and required envelope fields are absent statically |
| Reporting / Analytics | Governed projections and management views, never source truth | `Reporting`, `MetricCatalog`, 11 calculators, projections, reconciliations, report runs, dashboards | Source ownership is documented and Finance balance calculator delegates to Finance | `PARTIALLY CONFORMING` — no event-fed projection path and management/workspace decision surface is missing |
| Audit / Forensics | Immutable evidence of actions and denied attempts | `AuditEvent`, `AuditRecorder`, attempted/rejected operation recorders, audit view | Audit is distinct from domain events | `PARTIALLY CONFORMING` — event envelope and durable consumer traceability are incomplete |
| Employee Workspace | First-class authorized work discovery/orchestration, never a fact owner | No Workspace module, controller, route, view, API contract, or query | Home page is a static module-link console | `MISSING` |
| Management Decision Support | Governed KPIs, staffing/capacity, risk, exceptions, pending decisions, command links | Reporting dashboards and report runs exist; no management workspace or exception/work queue | Analytical view exists without full work/decision composition | `PARTIALLY CONFORMING` |
| Calendar / Time | Shared authoritative period/date context | `Calendar\\CalendarAuthority` and academic/financial/payroll periods | Calendar authority is separate and explicit | `PARTIALLY CONFORMING` — period ownership is split by business period type as intended, but cross-context event/period contracts are not demonstrated |

### 4.2 Required business-fact authority matrix

| Business fact | Target authority | Actual model/table | Actual command/query path | Duplicate / cross-module observation | Status |
|---|---|---|---|---|---|
| Enrollment | Enrollment | `Academic\\Models\\Enrollment` / `enrollments` | `Academic\\Commands\\MaintainEnrollment`; roster/history queries | Admissions creates students but does not create enrollment; Reporting reads; no duplicate enrollment table found | `CONTRADICTORY` |
| Academic eligibility | Academic-owned signed snapshot after Placement recommendation | `Academic\\Placement\\Models\\AcademicEligibilitySnapshot` / `academic_eligibility_snapshots` | `Placement\\Commands\\DecidePlacement` materializes; `AcademicEligibilitySnapshotQuery` verifies/reads; Admissions and Enrollment consume references | One snapshot table; creation is placed under Placement while ADR says Academic authority | `PARTIALLY CONFORMING` |
| Class membership | Enrollment decision/membership | `enrollments.class_id` | `MaintainEnrollment` creates/transitions membership; class roster reads | No separate `class_memberships` table; this is acceptable only if Enrollment remains the ownership boundary | `PARTIALLY CONFORMING` |
| Session | Academic Session / delivery fact, with Scheduling creating the schedule decision | `Academic\\Models\\ClassSession` / `class_sessions` | `MaintainClass::scheduleSession`; `TimetableQuery`; attendance and Payroll read session | No duplicate Session writer found; scheduling and delivery creation are merged | `PARTIALLY CONFORMING` |
| Scheduling | Scheduling planning/constraint decision | No Scheduling model/module; `MaintainClass` and `ClassSession` are actual path | `MaintainClass::scheduleSession`, room/section/teacher checks and DB triggers | No duplicate, but target authority is absent and embedded in Academic | `CONTRADICTORY` |
| Payroll result | Payroll | `Payroll\\Models\\PayrollResult` / `payroll_results` | `CalculatePayroll`, `ApprovePayrollResult` | Finance reads approved result; Finance liability is a separate recognized fact, not a duplicate | `CONFORMING` |
| Payroll liability | Finance | `Finance\\Models\\PayrollLiabilityFact` / `payroll_liability_facts` | `Finance\\Commands\\RecognizePayrollLiability`; reporting reads `payroll_liability_facts` | Unique source recognition and DB source guard; no Payroll monetary-liability writer found | `CONFORMING` |
| Employment settlement | Finance recorded settlement; Payroll proposal is workflow evidence | `Finance\\Models\\EmploymentSettlement` / `employment_settlements`; `Payroll\\Models\\SettlementProposal` / `settlement_proposals` | Payroll proposes; Finance `MaintainEmploymentSettlement` records immutable fact | Historical `final_settlements` migration is removed by `000143`; resultant schema and upgrade data are unresolved | `PARTIALLY CONFORMING` |
| Financial obligation | Finance | `Finance\\Models\\Obligation`, `ObligationLine` / `obligations`, `obligation_lines` | `PostObligation`; `FinancialBalanceQuery` | No Admissions/Academic obligation writer found; gate queries Finance | `CONFORMING` |
| Payment | Finance | `Finance\\Models\\Payment` / `payments` | `RecordPayment`; Finance API/web routes | Payment is not treated as accounting entry; no competing receipt authority found | `CONFORMING` |
| Allocation | Finance | `PaymentAllocation` / `payment_allocations`; `FundAllocation` / `fund_allocations` | `AllocatePayment`, `AllocateFunds`; Finance balance query | Payment allocation and funding allocation are distinct subtypes, not duplicate payment allocation authorities | `CONFORMING` |
| Financial correction | Finance | `FinancialCorrection` / `financial_corrections` | `MaintainFinancialCorrection` propose/approve and source-linked correction paths | Corrections append or compensate; no report/controller correction writer found | `CONFORMING` |
| Work item / task / approval / exception | Workflow | No generic model/table/query; resource `WorkOrder` only | Domain-specific commands stage approvals in their own fact tables | Multiple domain approvals are not one generic authority; no Workflow coordination exists | `MISSING` |
| Employee Workspace | Workspace projection/orchestration | None | None | Home/reporting pages are not a workspace and cannot supply its missing work concepts | `MISSING` |

## 5. Authority and boundary findings

### 5.1 Authorities that are clear and should be preserved

The following actual authorities agree with the target's one-fact/one-owner law for the inspected scope:

- `Person` owns identity; `UserAccount` owns authentication account state.
- HR owns `Employment`, contracts, contract versions, leave, and compensation scale/rule records.
- Payroll owns payroll period process state, calculations, results, adjustments, and settlement proposals as evidence.
- Finance owns obligations, payments, payment/fund allocations, corrections, journals, reconciliations, the signed payroll liability fact, and recorded employment settlements.
- Student Lifecycle owns student status/history, holds, transfer history, and communication preference records. The static-phase registrar correction makes it the owner of student aggregate creation as well.
- Academic owns the academic catalog, class/session/assessment/progression records in the current implementation, subject to the Scheduling and Enrollment boundary defects below.
- Reporting owns projections and report/dashboards, not the underlying facts. The Finance outstanding-balance calculator delegates to `Finance\\Queries\\FinancialBalanceQuery`, which is the correct direction.
- Audit owns evidence of actions and attempted/denied operations; it is not used as the business fact owner.

### 5.2 Boundary contradictions

1. **Academic vs Enrollment:** `MaintainEnrollment` directly creates and transitions `Academic\\Models\\Enrollment`, performs the academic eligibility reference, calls Finance's financial gate query, freezes gate evidence, and records enrollment lifecycle. This is a coherent single writer, but it violates the target's explicit X5 decision that Enrollment owns the decision after consuming Academic and Finance inputs.
2. **Academic vs Scheduling:** `MaintainClass` handles class definition, class lifecycle, sessions, sections, teacher assignment, teacher skill assignment, room availability, timetable conflicts, and session scheduling. The database names the fact `class_sessions`, but no Scheduling boundary exists.
3. **Workforce vs Access:** `Position` and `PositionAssignment` are in Access and are used to derive authority. The target says Workforce owns position and assignment while Authorization consumes them. The repository therefore makes an authorization-topology module a partial Workforce authority.
4. **Admissions vs Student Lifecycle:** Before this audit correction, Admissions directly wrote Student and StudentStatus models. The write was moved to `Students\\Domain\\StudentAdmissionRegistrar`; Admissions still owns the authorized conversion orchestration and reads Student for duplicate checks. This removes the direct aggregate write without inventing a second compatibility path.
5. **Admissions/Application:** `Applicant` is the available admissions aggregate, but the target requires a distinct Application/case concept. No safe static rename or split was attempted because it would change persistence and transport semantics.
6. **Academic Eligibility:** The prior ADR explicitly declares the signed snapshot an Academic fact, while `Placement\\Commands\\DecidePlacement` creates it atomically with placement release. This is a defensible producer/consumer arrangement only if the implementation boundary is documented as an Academic eligibility port. It is not yet represented as a separate owner/application boundary.

### 5.3 No active duplicate was established for the named monetary and academic facts

Static inventory found no active second writer for Enrollment, PayrollResult, PayrollLiabilityFact, Obligation, Payment, PaymentAllocation, or FinancialCorrection. `SettlementProposal` is intentionally proposal evidence and `EmploymentSettlement` is the Finance fact. `AcademicEligibilitySnapshot` is immutable evidence and not a second live eligibility rule. `WorkOrder` is a resource/facilities work fact, not a generic Workflow WorkItem. These distinctions avoid incorrectly classifying separate evidence or subtypes as duplicate authorities.

## 6. Database and migration findings

### 6.1 Present schema authorities

Migration inventory includes the expected current fact tables, including:

- `students`, `admission_decisions`, `enrollments`, `classes`, `class_sections`, `class_sessions`, `attendance_facts`, assessments, progression, completion, certificates, and transcripts;
- `payroll_periods`, `payroll_calculations`, `payroll_results`, `payroll_adjustments`, `payroll_clearances`, and `settlement_proposals`;
- Finance `financial_periods`, `obligations`, `obligation_lines`, `payments`, `payment_allocations`, `refunds`, `financial_corrections`, journals, reconciliations, `employment_settlements`, and `payroll_liability_facts`;
- `academic_eligibility_snapshots` with signed payload, digest, key version, immutable trigger, and downstream references;
- branch provenance columns, `branch_scope_links`, idempotency, audit events, and `domain_events`.

The schema uses PostgreSQL-oriented checks, foreign keys, partial unique indexes, row/history triggers, append-only guards, and source-link guards in the later migrations. That is strong static evidence of the intended integrity model, not deployment evidence.

### 6.2 Missing target schema

No current migration creates tables or projections for:

- workflow process instances;
- generic tasks;
- generic approvals as actionable work items;
- generic exceptions;
- notification artifacts/receipts;
- search indexes/projections;
- employee workspace state/projection;
- application cases distinct from applicant participation;
- event-consumer receipts or domain-event relay cursor/state;
- a domain-event-to-integration-delivery projection.

`work_orders` is a Resource-owned facilities work-order table. `sessions` is not the Academic Session authority; the Academic fact is `class_sessions`. The same table name is used by the framework/application session infrastructure and should not be confused with delivery sessions.

### 6.3 Historical and obsolete migrations

The repository has intentionally retired competing architecture in migration history:

- `000096` drops the legacy `compensation_components` table and its trigger; active compensation is Contract Version plus Compensation Rule.
- `000097` drops `work_bases`; payroll volume is derived from academic teaching-delivery evidence rather than manual work bases.
- `000056` historically creates Payroll `final_settlements`; `000142` creates Finance-owned `employment_settlements`, and `000143` drops the competing runtime table and makes the consolidation one-way.
- The Payroll `FinalSettlement` model is deleted from the active tree; no active application reference to `final_settlements` was found.

The old create definitions and reversible `down()` bodies are migration history, not by themselves active duplicate tables. A migration history scan cannot establish whether a clean install, upgrade with data, rollback, or partially applied deployment produces the intended result. Those are runtime-only questions in §14.

No compatibility table or fallback writer was added in this audit. The `Payroll\\Domain\\SettlementProposalApproval` port is an ownership correction: it lets Payroll mutate its own proposal state while Finance records the Finance fact; it does not preserve the retired Payroll settlement authority.

## 7. API and web route findings

### 7.1 Actual transport shape

- `routes/web.php` exposes a broad server-rendered employee console through the `employee` middleware, including organization, identity, students/admissions, CRM, Academic, Placement, HR, Resources/Library, Finance, Communication, Payroll, Reporting, Documents, Access, Privacy, Audit, and printing.
- `routes/api.php` exposes JSON controllers for Students, Academic sessions/attendance, Identity, Finance, Payroll, Placement, and CRM, plus `/me`.
- Both transports delegate to shared command/query authorities for the covered operations; controller comments and inspected methods keep business decisions out of route code.
- Finance, Payroll liability recognition, Academic sessions, placement, CRM, and student operations have both web/API portions, but not complete route parity.

### 7.2 Mismatches and stale contracts

1. There is no Workspace route in either transport.
2. There is no Workflow, Task, WorkItem, Exception, Notification, or Search route.
3. The JSON API has no corresponding surface for many web modules, including HR, Resources, Communication, Reporting, Documents, Access, Privacy, Organization, Audit, printing, and much of Academic setup/lifecycle. The target/reconciliation requirement for API/web parity is therefore not met.
4. The API has no visible version prefix or generated typed contract boundary. Its route names and method aliases differ from the web surface, and error/record-resolution behavior still needs runtime comparison.
5. Controllers often call `findOrFail` before entering a command. Static code therefore leaves open whether an unauthorized caller can distinguish record existence from a command denial; this requires HTTP/security verification and, for sensitive resources, may require lookup authorization before failure behavior.
6. Existing architecture reconciliation documentation selects a React/TypeScript feature frontend; the actual API is session-authenticated Laravel JSON and the actual web product is Blade. The API is not a demonstrated React contract merely because it is JSON.

The absence of a Workspace route is a capability gap, not a reason to add a dashboard alias. A Workspace route must compose authorized work and link to canonical commands without becoming a new write authority.

## 8. Frontend findings

The actual frontend inventory is:

- Blade layout and module views under `resources/views/`;
- HTML forms and server-rendered pages for Academic, Finance, HR, Payroll, Students, CRM, Reporting, Placement, Documents, Communication, Access, Privacy, Resources, Organization, Identity, Audit, and print artifacts;
- no `package.json`, React feature tree, TypeScript source tree, Vite application, or browser-side workspace application found in the repository root/frontend inventory.

`resources/views/home.blade.php` is a module navigation page. `resources/views/reporting/index.blade.php` is a reporting/dashboard page. Neither is an Employee Workspace: neither composes effective employee positions, assignments, capability/scope, tasks, approvals, deadlines, notifications, authoritative context, and exceptions with direct canonical action links.

The Blade console is not inherently disallowed by the target graph, but it contradicts the selected React/TypeScript frontend decision in the existing reconciliation documents. Converting the entire surface or adding a thin React shell without typed contracts, workspace data ownership, accessibility, and runtime validation would not be a safe static correction.

## 9. Events and Outbox findings

### 9.1 What exists

`AuditRecorder` records a successful operation and calls `TransactionalEventRecorder` inside the caller's transaction. `DomainEvent` is append-only and linked to `AuditEvent` through `domain_events.audit_event_id`. The schema provides event type/version, aggregate identity, correlation ID, payload digest, occurrence time, and append-only protection. Denied attempts remain audit evidence rather than successful domain events.

`Integrations\\IntegrationDelivery`, `DispatchDelivery`, `DeliveryProcessor`, retry/backoff, dead-letter state, and `ProcessDeliveries` provide endpoint-specific delivery behavior. That is useful infrastructure and correctly distinct from the domain event log.

### 9.2 Missing link and envelope

The static repository does not demonstrate:

```text
DomainEvent
 → relay/cursor
 → IntegrationDelivery projection
 → endpoint delivery
```

`ProcessDeliveries` queries `integration_deliveries` directly. No consumer/projector/relay was found that reads `domain_events`, creates delivery rows, records consumer receipts, or makes internal reporting/workflow/communication/search consumers idempotent. The existence of both tables does not establish an outbox pipeline.

The target event envelope requires `message_id`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `event_type`, `event_version`, `occurred_at`, `recorded_at`, `organization_id`, `operational_context_id`, `actor_id`, `correlation_id`, `causation_id`, and payload. The actual table lacks explicit aggregate version, organization/context identifiers, causation ID, and recorded-at semantics distinct from generic timestamps. These may be derivable in some commands, but the envelope contract is not established.

Reporting calculators currently read authoritative tables synchronously and write governed projections. That is not a second authority, but it is not proof of an event-fed rebuildable projection path. Outbox replay, consumer idempotency, ordering, and failure behavior remain unresolved.

## 10. Reporting and management findings

The Reporting module is materially better than a free-form dashboard implementation:

- `MetricCatalog` registers metric owner, period authority, scopes, and calculator;
- `MetricProjection`, `MetricVersion`, `MetricDefinition`, `MetricReconciliation`, and `ReportRun` provide governed derived-data records;
- Finance `OutstandingBalanceCalculator` delegates to `FinancialBalanceQuery`, preserving Finance as balance authority;
- `PayrollTotalCalculator` reads Finance-recognized `payroll_liability_facts`, not Payroll result totals;
- academic, placement, CRM, attendance, and fund metrics have explicit calculator paths.

The remaining issues are:

- the event/outbox projector path is not present, so freshness/replay/rebuild behavior is not connected to the target event graph;
- there is no Workspace or management decision workspace that combines projections with pending decisions, exceptions, deadlines, staffing/capacity, and canonical command links;
- AR/AP and complete accounting/subledger source lineage are not represented as full target contexts;
- historical reporting checkpoint documents describe older metric counts and settlement architecture. They have historical notices in the worktree, but the new audit is the current conformance comparison.

Status: `PARTIALLY CONFORMING`, not a reporting authority duplication.

## 11. Authorization and security findings

### 11.1 Conforming mechanisms

- `AccessDecision` is a server-side port with deny-by-default semantics.
- `AccessResolution` resolves effective permissions from positions, assignments, policies, grants, delegations, lifecycle, dates, and scope.
- Commands define capability constants and perform authorization at the mutation boundary.
- `ActorBranches` is a read-side visibility query derived from the canonical grant/delegation/organization topology and treats null provenance as unknown, not wildcard.
- Sensitive operations include separation-of-duties and beneficiary checks in application logic and PostgreSQL guards for settlement, contract, grant, correction, and other facts.
- Idempotency keys and row locks are widely used in critical commands.

### 11.2 Gaps

- Position/assignment authority is structurally in Access instead of Workforce.
- Many web/API read surfaces require parity and data-dependent checks; static route presence is not proof of branch isolation.
- A generic Workspace cannot safely be built until its query uses authorization-filtered work discovery and every action re-enters the canonical command boundary.
- The target's resource/relationship-centric authorization model is only partially represented; static capability strings and branch scopes are not equivalent to a fully typed resource relationship graph.
- Domain event and workspace envelopes do not yet carry the full organization/operational context required for authorization-filtered downstream consumption.

Status: `PARTIALLY CONFORMING`.

## 12. Lifecycle, provenance, branch, and concurrency findings

### 12.1 Lifecycle and concurrency strengths

The repository statically shows:

- explicit lifecycle classes for Enrollment, Class, Section, Room, Assessment, Progression, Admission, Student, Finance, Payroll, HR, Documents, Resources, and other domains;
- append-only or immutable records for eligibility snapshots, academic delivery evidence, payroll results, Finance settlements/liabilities, corrections, audit, and domain events;
- `lockForUpdate()` in high-risk state transitions and allocation/settlement paths;
- idempotency execution around critical command operations;
- PostgreSQL checks/triggers for period closure, session conflict, capacity, immutable timetable identity, settlement source matching, liability source matching, and correction limits.

These properties do not cure the context-boundary defects: an invariant enforced by a correct Academic command is still an Academic-owned Enrollment decision when the target requires Enrollment ownership.

### 12.2 Remaining lifecycle gaps

- No Workflow process state, work-item assignment, SLA/deadline, escalation, exception, or notification lifecycle exists.
- No aggregate version/optimistic concurrency field or HTTP version contract was statically found for the general command surface; locking is the dominant mechanism.
- No durable event-consumer duplicate receipt or replay state was found.
- Settlement proposal approval is a Payroll-owned transition coupled to Finance fact creation. The static correction now routes the proposal mutation through a Payroll owner port, but the full event/approval/workflow representation remains absent.
- Admissions Application and Enrollment Request are not distinct persisted cases as required by the target graph.

### 12.3 Branch and provenance

Present controls include:

- `originating_branch_id` and `current_home_branch_id` on key student/enrollment/Finance/contract records;
- immutable originating branch guards;
- class branch provenance and class-based timetable reads, including room-less sessions;
- `branch_scope_links` for explicit affected scope;
- branch-aware access and null-provenance fail-closed reads;
- Finance settlement and Payroll liability evidence checks.

The target provenance envelope is still incomplete. Domain events and audit rows do not explicitly carry organization and operational context fields. `class_sessions` derives branch from the class rather than carrying a frozen branch field. Payroll results and some source facts rely on related employment/organization context rather than a uniform envelope. Existing provenance columns are nullable to avoid fabricated history; whether all new writes populate them and whether old rows are safely handled is runtime/data dependent. Finance settlement uses the employee's home branch designation; whether that is the correct historical operational settlement context requires policy and data verification.

Status: `PARTIALLY CONFORMING` and `UNRESOLVED` for deployed-data coverage.

## 13. Finance conformance findings

### 13.1 Strong alignment

- Finance owns `Obligation` and `ObligationLine`, `Payment`, `PaymentAllocation`, `Refund`, credits, discounts, installment plans, gate exceptions, funding allocations, corrections, journals, and reconciliation.
- Payment is not treated as an accounting entry.
- Enrollment financial eligibility is derived through `FinancialGateQuery` from Finance facts; Academic stores the signed/frozen gate evidence rather than becoming Finance.
- Payroll calculates `PayrollResult`; Finance recognizes the approved source into unique `PayrollLiabilityFact` rows with exact source identity and amount checks.
- Employment settlement is a Finance immutable fact linked to a matching Payroll proposal, HR termination, clearances, independent actors, beneficiary separation, and branch evidence.
- Financial correction paths are source-linked and append/compensate rather than silently mutating historical money.
- Reporting's financial balance path delegates back to Finance.

### 13.2 Incomplete target flow

The target Finance graph is:

```text
source fact → obligation → AR/AP → settlement → allocation → accounting event → subledger → GL → reconciliation/close → reporting
```

The repository contains the endpoints of much of this graph, but static inspection does not establish:

- distinct AR/AP authority and lifecycle contracts;
- automatic accounting-event creation from every approved obligation/payment/allocation/payroll liability/correction;
- a complete subledger boundary separate from manually posted journals;
- controlled linkage between Finance liability recognition and the journal/GL source event;
- settlement/disbursement flow beyond the recorded employment-settlement fact.

`PostJournal` and journal tables are not enough to prove the target accounting flow. The correct classification is `PARTIALLY CONFORMING`, not `DUPLICATED` and not a reason to make Payroll write Finance.

## 14. Employee Workspace findings

The target Workspace is explicitly a first-class work environment, not a generic dashboard. It must compose, at request time or through rebuildable authorized projections:

- effective employee identity and employment eligibility;
- all positions and assignments;
- capabilities, organizational/branch scope, lifecycle state;
- separate tasks, approvals, work items, exceptions, deadlines, notifications, and recent work;
- authoritative context and direct canonical workflow links;
- management-specific decision work where authorized;
- freshness/failure state where projections are involved.

The repository has none of the required Workspace surface. It has:

- a static Home module-link page;
- separate module pages;
- Reporting dashboards;
- resource-specific WorkOrders;
- domain-local approval/proposal queues;
- no unified authorized work-discovery query.

It is not safe to add a thin `/workspace` page that queries unrelated tables and calls that conformance. Until Workflow, Notification, Search/projection, and route contracts are designed against the target, Workspace remains `MISSING`. This is a required implementation gap, not a justification for a new business authority or a generic role dashboard.

## 15. Deleted obsolete architecture and dispositions

The following obsolete architecture is deleted from the active application path or explicitly retired by ordered migrations:

| Retired architecture | Evidence | Disposition |
|---|---|---|
| Flat compensation components | No active model/command reference; `000096` drops table and trigger; contract version/rules are the active path | Retired; do not restore as fallback |
| Manual/academic `work_bases` volume | No active model/command reference; `000097` drops table and trigger; `TeachingDeliveryFact` is the evidence path | Retired; do not add compatibility writes |
| Payroll `FinalSettlement` fact | Model deleted; `000143` drops `final_settlements`; Finance `employment_settlements` is the recorded fact | Retired; `SettlementProposal` remains evidence only |
| Report-owned Finance balance | Reporting calculator delegates to `Finance\\Queries\\FinancialBalanceQuery` | Correctly removed as a competing balance authority |
| Academic session branch inference from room only | Class branch provenance and class-based timetable filtering are now the intended path | Static correction present; runtime isolation still required |
| Admissions direct Student aggregate write | `Students\\Domain\\StudentAdmissionRegistrar` now owns the Student and initial status inserts | Static boundary correction present; runtime behavior unverified |
| Finance direct Payroll proposal table update | `Payroll\\Domain\\SettlementProposalApproval` now owns proposal lifecycle mutation; Finance records its own fact | Static boundary correction present; runtime/DI/trigger behavior unverified |

Historical documents and migration `down()` definitions are not deleted merely to hide history. They must remain clearly marked as historical and must not be used as active authority or compatibility fallback.

## 16. Implemented safe static corrections in this phase

Two contradictions had a behavior-preserving, ownership-preserving static correction and were changed:

1. **Student aggregate ownership:** added `app/Modules/Students/Domain/StudentAdmissionRegistrar.php`. Admissions retains admission authorization, applicant locking, provenance validation, and conversion orchestration; the Students boundary now performs Student and initial StudentStatus inserts. This removes Admissions' direct write to Student Lifecycle tables without adding a duplicate path.
2. **Settlement proposal ownership:** added `app/Modules/Payroll/Domain/SettlementProposalApproval.php`. Finance still validates and records the authoritative Finance settlement, but proposal lifecycle closure is requested through a Payroll-owned port instead of Finance directly updating `settlement_proposals`. Finance remains the monetary authority; Payroll remains proposal/process evidence authority.

Since the original audit baseline, the static convergence slice has added the explicit contracts and guarded boundaries that were previously missing: versioned `/api/v1`, a React/TypeScript workspace root, branch-safe Search, Employee/Management Workspace queries, Work Management coordination (`workflow_instances`, `work_items`, append-only history), recipient/read Notifications, an allowlisted domain-event relay with consumer receipts, explicit envelope context, workflow/notification consumers, projection invalidations, and scheduled `outbox.relay` registration. These additions do not remove the original gaps that remain: concrete materialized projectors/rebuild commands, notification/read-state authority, automatic domain-to-workflow adapters, Scheduling/Enrollment boundary extraction, full React migration, and runtime verification. Historical findings above remain the pre-slice baseline; the current convergence status is maintained in `2026-09-05-fourth-architecture-convergence.md`.

## 17. Unresolved issues

The following require follow-up implementation or architectural closure; they are not resolved by this audit:

1. Establish the target Enrollment authority boundary without duplicating `enrollments` or retaining Academic as a hidden writer.
2. Establish Scheduling as a planning/constraint boundary while preserving Academic Session delivery facts and Payroll evidence lineage.
3. Decide whether to split `Position`/`PositionAssignment` from Access into Workforce or formally amend the target boundary with a governing ADR.
4. Add a distinct Application/case authority if the target's Applicant/Application distinction is required for current TOEFL House.
5. Design and implement separate Workflow process state, Task, Approval, WorkItem, Exception, deadline/SLA, escalation, and assignment contracts. Do not collapse them into one generic status/task table.
6. Implement Notification and Search as projections/communication artifacts, never source authorities.
7. Implement the transactional outbox relay, event catalog, full event envelope, consumer receipts, idempotent projector behavior, replay, ordering, retry, and dead-letter semantics.
8. Define the Finance accounting-event/subledger/GL integration and AR/AP scope; do not infer it from the existence of journals.
9. Resolve complete API/web parity, API versioning/typed contracts, authorization-before-resource-disclosure behavior, and frontend direction.
10. Implement the first-class Employee Workspace only after its authorized work-discovery input contracts exist.
11. Complete migration clean-install/upgrade/reconciliation strategy for the one-way settlement consolidation and all nullable provenance additions.
12. Verify every domain event has the required organization/operational context and causal lineage, or explicitly document a safe derivation contract.
13. Resolve management decision-support and exception visibility without allowing dashboards/reports/workspace to mutate source facts.

## 18. Runtime-only questions deliberately not answered

These questions cannot be answered from static inspection and were intentionally not tested:

- Does the complete ordered migration set build the intended live PostgreSQL schema from empty state?
- Does an upgrade with historical `final_settlements` data reconcile safely before `000143`?
- Do `down()` paths, trigger replacement order, foreign keys, and one-way migrations behave as intended?
- Does Laravel resolve the new registrar and settlement-port constructor dependencies in every controller, test, and seeder path?
- Do failed transactions roll back facts, audit rows, and domain events together?
- Do row locks, unique indexes, trigger order, and idempotency behavior hold under concurrent enrollment, allocation, correction, settlement, payroll recognition, and timetable requests?
- Are branch visibility, null provenance, transferred students, terminated employees, expired delegations, revocations, and organization-wide grants isolated correctly with real data?
- Do API and web responses have equivalent validation, denial, error codes, idempotency, and record-disclosure behavior?
- Do queue workers, relay retries, event replays, consumer receipts, endpoint delivery, dead letters, and out-of-order events behave safely?
- Are Reporting projections fresh, rebuildable, reconciled, and traceable to source facts after failure or replay?
- Does the actual browser interface meet accessibility, mobile/responsive, workflow-efficiency, freshness, and management decision requirements?
- Does any real deployment contain legacy rows or provenance values that invalidate the intended static authority model?

## 19. Scope classification for next work

| Category | Findings |
|---|---|
| Required for Current TOEFL House | Preserve the single Finance/Payroll boundary; preserve append-only corrections and provenance; complete current Enrollment and Scheduling authority decisions; provide the required Employee Workspace if the graph is the current product target; close direct cross-module writes; make API/web security behavior explicit; implement event delivery for any workflow/reporting/communication capability actually relied upon |
| Architecturally Required | Workflow coordination with separate work concepts; transactional outbox relay and idempotent consumers; Search and Notification projection boundaries; full event/provenance envelope; Finance accounting-event/subledger/GL contract; authorized Workspace orchestration; migration/reconciliation plan |
| Future / Policy-Gated | Distinct AR/AP or supplier scope beyond current student/employee flows; Alumni; advanced management workspaces; mobile/React migration details; additional integrations and notification channels; broader cost-center/organizational reporting policy |
| Not Required merely to obtain conformance | One microservice per logical context; event sourcing every fact; a second database; a generic role dashboard; a compatibility copy of retired settlement/compensation tables; a report-owned balance; UI-only authorization |
| Unjustified Complexity | Generic task/approval/status table that conflates separate target concepts; rebuilding authoritative facts in Workspace/Search/Reporting; adding a React façade without contract and accessibility work; restoring `final_settlements`, `work_bases`, or flat compensation as fallback; making Payroll write Finance or Finance write Academic/Enrollment directly |

## 20. Precise final verdict

**NOT CONFORMING.**

This verdict is based on mandatory target contradictions and missing capabilities, not on a claim that the repository is generally poor or unimplemented. The repository has several `CONFORMING` authorities, especially Finance monetary facts, Payroll results, Finance payroll liability recognition, payment/allocation/correction ownership, audit separation, and server-side command authorization. It also has meaningful `PARTIALLY CONFORMING` infrastructure for provenance, reporting, documents, communication, and events.

It cannot be classified as `CONFORMING` or merely `CONDITIONALLY CONFORMING` because the target's Enrollment and Scheduling boundaries are merged into Academic, Workflow/Work Management, Search, Notifications, and Employee Workspace are missing, the event/outbox propagation chain is incomplete, the actual Blade frontend contradicts the selected React/TypeScript product decision, and Finance's complete accounting flow is not established. Static implementation corrections were limited to the two clear direct cross-module writes described above. No production readiness, runtime correctness, deployed-schema correctness, browser usability, queue safety, or integration reliability is claimed.
