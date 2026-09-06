# TOEFL House — Unified Platform Reconciliation and Architecture

**Date:** 2026-09-05 (Asia/Kabul)  
**Status:** Architecture decision and implementation plan — accepted as the target architecture; not a production-readiness certification  
**Working branch:** `arena/01a07134-toefl-house`  
**Comparison ref:** `origin/arena/01a03298-toefl-house`  
**System names in this document:** System A is the comparison ref; System B is the current Laravel checkout.

## Executive decision

Neither source system is accepted unchanged.

The unified platform will use a **Laravel modular monolith with PostgreSQL** as the transactional backend and a **React/TypeScript feature frontend** as the operator and student experience. System B supplies the backend boundary discipline, PostgreSQL-oriented relational integrity, command/lifecycle patterns, authorization decisions, provenance controls, and source-linked corrections. System A supplies the broader operational product surface, the placement and academic engines, the financial subledger capabilities, the invariant-audit discipline, the reporting/backup/readiness posture, and the mature React experience.

System A's SQLite schema and route implementation are capability evidence, not the target persistence implementation. System B's existing Laravel schema is also evidence, not a reason to preserve every table or route. The final platform has one owner for each business fact, one write path for each mutation, and query/reporting projections that cannot write domain truth.

The mandatory, non-negotiable connected target architecture is defined by `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md` and ADR `2026-09-05-integrated-system-architecture-graph.md`. This reconciliation must be read as a conformance candidate against that graph, not as proof that the repository already satisfies every graph edge, authority, lifecycle, event, workflow, workspace, document, notification, search, reporting, concurrency, or failure requirement.

The most important authority decisions are:

- **Access:** Access/Identity owns authentication, actor status, permissions, delegations, expiry, and scope decisions.
- **Organization:** Organization owns the hierarchy and branch lifecycle. A branch identifier is never a wildcard when absent or unknown.
- **Student identity:** Students owns the student profile and profile lifecycle; Admissions owns applicant/admission workflow; Academic owns enrollment and delivery state.
- **Placement:** Placement owns assessment content, attempts, scoring, and placement recommendation evidence.
- **Money:** Finance owns obligations, invoices, payments, allocations, journals, corrections, funds, budgets, books, assets, debt, and recorded settlements. Payroll calculates and proposes; Finance records settlement facts.
- **Reporting:** Reporting owns read projections and invariant audits only. It never becomes a second ledger.
- **Integration:** Events and automation carry committed facts through a transactional outbox. They do not own a business state.
- **Lifecycle:** Every stateful aggregate has one transition graph and one guarded command boundary. Coarse UI status is derived, not independently written.

This document deliberately distinguishes **capability preservation** from **implementation preservation**. No production-data shape is treated as a permanent constraint. The current work remains subject to the deferred runtime validation listed at the end.

---

## Evidence, method, and limits

The comparison used source-tree inspection, route/module inventories, schema inspection, and targeted reading of domain services, lifecycle engines, financial invariant checks, authentication bootstrap, and frontend structure. The comparison ref was inspected through `git show` and `git ls-tree`; the working branch was not switched.

System A's own completion documents report 125 tables, 43 mounted route groups, 22 financial invariants, readiness/backup checks, 223 test files, and a broad ERP surface. These are useful claims about intended scope and implementation evidence, not independently certified facts in this phase. The SQLite schema and source were also inspected directly. System B contains a larger Laravel migration chain, modular domains, PostgreSQL-oriented constraints, command classes, API/web controllers, and feature/security/schema tests.

The runtime is intentionally unavailable for this phase. PHP, Composer/vendor dependencies, PostgreSQL, Node dependencies, test runners, migrations, and static analysis were not installed or executed. Therefore this is an architecture and source-reconciliation verdict, not a claim that either implementation or the new migration has passed execution.

Evaluation criteria were:

1. business correctness and invariant strength;
2. security, scope isolation, and separation of duties;
3. immutability, provenance, correction, and auditability;
4. concurrency, idempotency, retries, and partial failure behavior;
5. completeness of the user journey for every defined role;
6. API/controller/console parity;
7. database enforcement and recoverable migrations;
8. performance, reporting, observability, accessibility, and maintainability;
9. ability to evolve without retaining duplicate authorities.

---

## 1. Complete capability map — System A (comparison ref)

### 2.1 Organization, configuration, and operations

System A contains organization, campus, branch, branch-scoped operational records, policy/configuration catalogs, permission catalogs, workflow/rule versions, notifications, audit logging, health/readiness checks, database backup scheduling and verification, search, and export/report infrastructure. It carries branch provenance on most operational rows and has explicit organization-wide versus branch-scoped decisions.

The useful capability is not its SQLite choice. The useful capability is the explicit operational contract: a system should report readiness, verify backups, expose health separately from readiness, and refuse unsupported policy-dependent operations rather than fabricate defaults.

### 2.2 Identity and access

System A implements authenticated sessions, password-change quarantine, session-version revocation, scoped RBAC, permission resolution, role expiry/deny behavior, global-owner handling, branch scope resolution, class-ownership checks, student-level access checks, delegation, and audit middleware. The UI exposes settings, users/roles, workflows, rules, and audit views.

The principal risk is that route-level authorization and raw SQL are spread through a large Express route surface. The final platform must retain the policy semantics but centralize their execution behind the Access decision service and database scope predicates.

### 2.3 Admissions, visitors, and CRM

The product includes visitor/lead capture, applicant intake, duplicate-aware conversion, admission decisions, enrollment conversion, student records, visitor history, communications, and operational dashboards. The experience covers reception and admissions staff rather than presenting a finance-only administration console.

### 2.4 Placement

Placement is a major System A capability: test and content banks, test versions, blueprints, question/rubric content, attempts, answer capture, scoring, recommendations, placement reports, and branch-scoped access. It is designed as a content engine rather than a single hard-coded exam form.

The scoring and recommendation evidence should be preserved. The final system must separate immutable attempt/answer evidence from mutable recommendation display and must prevent a stale or unauthorized attempt from being associated with another student or branch.

### 2.5 Academic administration and delivery

System A covers academic setup, programs/levels, classes, class generation, class lifecycle, schedules, sessions, enrollments, attendance, homework, exams, assessments, grade lock/review/publish/lock workflow, progression, completion, graduation/certificates, teacher/class ownership, waitlists, and student portal views.

Its strongest design ideas are explicit transition graphs, teacher edit limits for locked grades, and a distinction between a coarse UI status and a detailed lifecycle stage. The final version must remove aliases and duplicate state vocabularies rather than carrying every historical spelling indefinitely.

### 2.6 Students and portal

The student experience includes profile and status, enrollment/class view, timetable, attendance, assessment/grade visibility, documents, communications, fee/invoice views, payment history, and a student portal. System A also models student operational eligibility separately from profile status in parts of the finance and student workflows.

This separation is retained: a historical student status is not rewritten merely to gate a new delivery, billing, or document operation.

### 2.7 Finance and economics

System A has the broadest economic surface discovered in the comparison:

- invoices and line items with explicit purpose;
- tuition obligations and term position;
- payments and payment allocation;
- overpayment/underpayment handling, refunds, discounts, credits, installment plans, and write-offs;
- income/expense classification, budgets, budget movements, branches, and savings/accounts;
- journals and financial transactions;
- books inventory, stock receipts, sales, and acquisition evidence;
- supplier invoices, payables, returns, and refunds;
- loans, principal repayment, interest facts, and positions;
- assets, custody, depreciation, disposal, and portfolio reporting;
- funding, donations, scholarships, sponsorships, restricted funds, impact, and clawback obligations;
- payroll calculations, clearances, withholdings, settlements, teacher-related financial calculations;
- bank reconciliation, aging, daily cash statements, P&L/operating reporting, and invariant checks.

The strongest financial ideas are the independent invariant checker, purpose-specific invoices, obligation-keyed payment allocation, explicit non-operating classifications, evidence identities for subledgers, and refusal of unrepresentable policy choices. The final system adopts those capabilities but moves them into PostgreSQL Finance commands and append-only facts.

A material architectural risk remains: the source implementation maintains some operational account balances alongside financial transaction evidence. Conditional updates and invariant checks reduce risk, but a balance cache is not itself historical truth. The final system treats balances as projections rebuilt from the journal/subledgers and proves them with reconciliation, rather than allowing independent monetary truths.

### 2.8 HR and payroll

System A includes employee/teacher records, employment contracts and versions, payroll periods, calculations, approvals, clearances, adjustments/reversals, teacher history, and settlement workflows. It also models withholding and reporting gates.

The calculation/proposal versus recorded-money distinction is retained. A Payroll route must not be able to create a Finance settlement merely because it has a route named `settle`.

### 2.9 Reporting, automation, and governance

System A includes dashboards, financial reports, operational reports, impact views, exports, workflow/rule versions, automation triggers/actions, event bus behavior, notifications, audit views, and extensive forensic/static/mutation tests.

The final system retains transactional outbox events, versioned rules, idempotent automation, audit correlation, and read-only reports. An in-memory event bus is not sufficient for a production commit boundary and will not be the final integration authority.

### 2.10 Frontend capability

System A has the more complete product interface: React 19/Vite pages for dashboard, finance, books, funding, impact, academic setup, classes, students, visitors, teachers, reports, rules, workflows, audit, settings, and student portal. It provides a credible role-oriented ERP experience instead of exposing only API/admin forms.

The final frontend preserves this breadth, but routes all mutations through generated contracts and server decisions. Client-side hiding is never treated as authorization.

---

## 2. Complete capability map — System B (current Laravel checkout)

### 3.1 Foundation and domain structure

System B is a Laravel/PHP modular monolith with modules for Academic, Access, Admissions, Audit, Calendar, Communication, CRM, Documents, Finance, Governance, HR, Identity, Integrations, Organization, Payroll, Privacy, Reporting, Resources, and Students. It uses migrations, models, domain commands, queries, lifecycle classes, API controllers, web controllers, and feature/security/schema tests.

Its main strength is explicit bounded-context structure: behavior is easier to locate and transactions can be made local to a domain command. Its main product gap versus System A is less complete operational UI and fewer broad subledger capabilities.

### 3.2 Identity, access, organization, privacy, and audit

System B has actor/person identity, access resolution, actor/branch structures, scoped permissions and delegations, organization structures and lifecycle, privacy controls, audit recording, idempotent execution, and branch-aware authorization. It has explicit work on stale permissions, inactive actors, scope failures, direct route bypasses, and denied-operation recording.

The current architecture still requires a single final policy evaluator and a complete inventory proving every controller, route, command, query, and job uses it. A policy object existing in the module is not proof that every writer is guarded.

### 3.3 Admissions and students

System B supports applicant registration, admission decisions, admitted-applicant enrollment, student profiles, guardians, communications preferences, student status transitions, branch transfers, holds, and operational eligibility. Student profile lifecycle and enrollment/delivery lifecycle are modeled separately.

This is a sound foundation. The unified design expands it with System A's reception/visitor pipeline, portal experience, duplicate-aware intake, document flows, and placement conversion.

### 3.4 Academic and calendar

System B has academic access rules, skill/assessment handling, attendance, enrollment maintenance, progression decisions, class waitlists, class/period and calendar structures, branch records, and lifecycle guards. Its current transition work distinguishes detailed state from coarse status and prevents invalid terminal transitions.

System A has the more complete teacher/class/exam/grade product surface. The final design keeps System B's command and transition discipline while importing System A's assessment, grade-lock, class session, teacher ownership, and student portal capabilities.

### 3.5 Documents and communication

System B has documents and communication modules with privacy and student-facing concerns. System A provides broader portal and operational exposure. The unified version uses one document metadata/authorization authority with object-level branch/student checks, private storage, malware/content validation, signed short-lived download grants, and an audit trail for every access decision.

### 3.6 Finance

System B currently has Finance commands and models for obligations, payment allocation, payments, funds, discounts, credits, installment plans, journals, financial gates, reporting queries, corrections, and a Finance-owned employment settlement. It uses PostgreSQL-oriented foreign keys, numeric monetary columns, database triggers, open financial periods, source-linked compensating corrections, idempotency, and branch provenance.

The current work also separates Payroll settlement proposals from Finance settlement recording. The remaining architectural defect identified during reconciliation was the presence of the old Payroll `final_settlements` authority. The new consolidation migration removes that table and model from the final runtime schema instead of preserving it as a compatibility writer or projection.

System B does not yet contain System A's complete books, supplier debt, loans, asset lifecycle, funding/impact, bank matching, or rich invoice-purpose experience. These are selected capabilities to be implemented inside Finance, not copied as a second Express finance system.

### 3.7 HR and payroll

System B has employment lifecycle, payroll calculations/results/adjustments, payroll periods, clearances, settlement proposals, and API/controller workflows. Payroll has stronger separation from Finance after the current reconciliation work, but route parity and all direct-write paths remain to be verified at runtime.

Payroll remains the calculation and proposal authority. Finance records the settlement fact and all cash/journal consequences.

### 3.8 Reporting, APIs, web UI, and tests

System B has API and web route surfaces, finance/student/placement/payroll controllers, Blade views, feature tests, schema tests, security tests, and direct SQL attack tests. It has useful adversarial coverage but not the complete System A operator/student frontend.

The final system will expose one command contract through API and console/web adapters. Controllers will not contain alternative business rules. Reports will call query objects/projections and will never write balances or lifecycle state.

---

## 3. Capability-by-capability reconciliation

| Capability | System A contribution | System B contribution | Final decision and authority |
|---|---|---|---|
| Identity | Sessions, revocation, password quarantine, role/permission catalog | Modular Identity/Access, actor status, idempotency, audited decisions | **Combine and centralize.** Access/Identity owns authentication and authorization; no route-local RBAC. |
| Organization/branch | Organization-campus-branch hierarchy and broad branch-carrying schema | PostgreSQL structure lifecycle, branch provenance, explicit scopes | **Choose B foundation; add A hierarchy/read models.** Unknown/null branch scope fails closed. |
| Admissions/reception | Visitors, leads, duplicate-aware intake, conversion | Applicant/admission/enrollment commands | **Combine.** Admissions owns applicant state; Students owns created profile. |
| Placement | Content engine, attempts, rubrics, scoring, recommendations | Placement domain boundary and access checks | **Combine.** Placement owns evidence and recommendation; no duplicate student placement state. |
| Student profile | Portal and operational views | Profile lifecycle, guardians, holds, branch transfer, operational eligibility | **Choose B domain truth; import A UX.** Profile status is not billing/delivery eligibility. |
| Calendar/classes | Rich class/session/schedule frontend and lifecycle | Calendar/domain command structure and guards | **Combine.** Calendar owns schedule; Academic owns class/enrollment state. |
| Progression/grades | Detailed academic workflow and grade locks | Progression commands and lifecycle checks | **Combine.** One grade-lock transition graph; published/locked records are append-only or compensated. |
| Documents | Student-facing document experience | Documents/privacy module | **Combine.** Documents owns metadata and secure object access. |
| Finance obligations | Invoice purpose, tuition term position, aid, installments, write-offs | PostgreSQL obligations, payment allocations, corrections, periods | **Redesign on B storage.** Finance owns one obligation and one allocation position. |
| Payments/refunds | Payment channels, refunds, payer detail, overpayment/return controls | Idempotent command patterns and database guards | **Combine.** Payments are immutable facts; refunds/corrections append compensating facts. |
| Journals/ledger | Broad classifications, reports, invariant checker | Journal command, period/provenance/immutability controls | **Choose B transaction boundary and A invariant catalog.** One monetary authority. |
| Books/inventory | Books, stock receipts, sales, acquisition/reconciliation | No equivalent complete surface | **Import and redesign in Finance/Resources.** Inventory is not a cash ledger. |
| Suppliers/payables | Supplier invoices, returns, refunds, payables | No equivalent complete surface | **Import into Finance.** Every payable and cash event is source-linked. |
| Loans | Principal, interest evidence, repayment, positions | No equivalent complete surface | **Import only after policy gates.** Principal and interest are separate facts; no invented rates. |
| Assets | Custody, lifecycle, depreciation, disposal | No equivalent complete surface | **Import into Resources/Finance.** Custody is operational; depreciation/disposal are Finance facts. |
| Funding/impact | Donations, aid, sponsorship, restricted funds, clawbacks, impact | Funds and allocations foundation | **Combine.** Funding source and student obligation allocation remain distinct. |
| Payroll | Calculation, withholdings, clearances, settlement evidence | Employment lifecycle and Finance-owned settlement boundary | **Combine with strict ownership.** Payroll proposes; Finance records. |
| Reporting | Rich reports, aging, reconciliation, invariant checker | Query objects and audit/reporting module | **Combine.** Reports are projections; invariant auditor reads raw facts independently. |
| Automation/events | Rules, workflows, event bus, notifications | Integrations/audit/idempotency foundations | **Redesign around transactional outbox.** Automation cannot mutate facts without commands. |
| Audit/observability | Audit coverage, readiness, backup, health | Audit module and denied-operation evidence | **Combine.** Add correlation, metric, trace, backup-restore evidence. |
| Frontend | Broad React operator/student product | Laravel web/API and domain contracts | **Choose React/TypeScript experience; B remains backend authority.** |
| Database | Broad capability schema, triggers, SQLite WAL | PostgreSQL migrations, commands, relational constraints | **Choose PostgreSQL.** Port capabilities, not SQLite tables. |

---

## 4. Best capabilities selected from each system

### From System A

1. The role-complete React experience for reception, admissions, teachers, management, finance, operations, and students.
2. Placement content/version/attempt/rubric/scoring capability.
3. Explicit class, enrollment, attendance, assessment, progression, grade-lock, and portal product flows.
4. Invoice purpose and obligation settlement semantics that refuse ambiguous documents.
5. Broad Finance subledgers: books, suppliers, loans, assets, funding, aid, impact, and clawbacks.
6. An independent invariant checker that does not trust the same projection code used by request handlers.
7. Health/readiness separation, backup verification, operational dashboards, and honest `POLICY REQUIRED` refusals.
8. Versioned rules/workflows and automation as configurable operational capabilities.
9. Detailed financial reporting, aging, bank reconciliation, and evidence-oriented subledger positions.

### From System B

1. Laravel module boundaries and domain command/query separation.
2. PostgreSQL as the transactional financial database.
3. Migration-based evolution with relational foreign keys, numeric money, row locks, and database constraints.
4. Explicit access decisions, branch scope objects, delegation/expiry/inactive-actor handling, and denial audit.
5. Append-only financial facts, source-linked compensating corrections, open-period controls, and idempotent commands.
6. Separate Payroll calculation/proposal from Finance settlement recording.
7. Student operational eligibility without rewriting historical profile state.
8. API/console parity as a domain requirement rather than separate controller behavior.
9. Lifecycle engines and guarded commands for students, classes, enrollments, progression, and finance instruments.
10. Schema/security/direct-SQL tests as executable specifications.

---

## 5. Capabilities redesigned from scratch

The following are not copied from either implementation:

- **Canonical identity and scope contract:** one AccessDecision result containing actor status, effective permissions, valid time, organization scope, branch scope, and denial reason; all commands consume it.
- **Finance fact model:** one append-only journal and source-linked subledger facts with projections rebuilt or reconciled from those facts. No writable balance table can be an independent monetary truth.
- **Correction model:** typed compensating instruments tied to exactly one source fact, with independent approval, open-period checks, remaining-correctable amount, idempotency, and immutable recorded state.
- **Unified lifecycle kernel:** one transition primitive with explicit graph, prerequisites, actor capability, idempotency, transition event, audit, and database guard. No controller-specific state machine.
- **Transactional integration:** domain fact and outbox message commit atomically; delivery is retryable and idempotent; automation invokes commands and cannot write tables directly.
- **Frontend contract layer:** generated API types and capability-aware screens from one contract. A disabled control is a usability aid only; the server always decides.
- **Reporting semantic layer:** report definitions map to approved query objects and include scope/provenance metadata, period basis, as-of time, and reconciliation status.
- **Secure document access:** metadata authorization is separate from object storage; download grants are short-lived and audit-correlated.
- **Operational readiness:** health, readiness, migration state, backup freshness/restore evidence, invariant status, queue/outbox lag, and dependency status are separate signals.
- **Policy gate registry:** unsupported economic policies are represented as explicit refused capabilities with required owner decisions, never hidden defaults.

---

## 6. Capabilities intentionally removed

These are removed from the final design, not merely hidden:

1. Payroll-owned `final_settlements` storage as a competing monetary fact. The final schema has only Finance `employment_settlements`; the old model is deleted and migration `2026_09_05_000143_consolidate_employment_settlement_authority.php` removes the duplicate table after replacing its proposal guard.
2. Controller-local financial calculations that disagree with Finance queries.
3. Writable report/dashboard balances that can diverge from financial facts.
4. Null/unknown branch scope treated as organization-wide access.
5. Implicit invoice purpose, implicit tuition term, silent quantity/default/discount substitution, and ambiguous payment allocation.
6. Direct writes from automation, imports, seeders, or API handlers that bypass domain commands.
7. In-memory events as the only record of a business event.
8. Duplicate aliases for the same lifecycle state once the canonical vocabulary is migrated and the API compatibility window ends.
9. SQLite as the production system of record for multi-user financial operations.
10. “Legacy”, “temporary”, or “compatibility” models that remain writable or silently preserve a second authority. Historical migration files may describe the migration path, but runtime code must not expose the retired concept.

---

## 7. Duplicate authorities eliminated

| Concept | Retired competing path | Final authority |
|---|---|---|
| Employment settlement | Payroll `FinalSettlement`/`final_settlements` | Finance `EmploymentSettlement` |
| Settlement approval | A single request carrying both identities | Payroll proposal plus authenticated Finance approval |
| Student operational eligibility | Rewriting `students.status` to gate every operation | `StudentOperationalEligibility` policy plus specific lifecycle state |
| Branch scope | Controller fallback or absent branch interpreted globally | Access/Organization scope decision; unknown fails closed |
| Financial correction | Destructive edits or generic adjustment rows | Typed Finance compensating correction linked to source |
| Payment allocation | Manual balance subtraction and invoice-local assumptions | Finance allocation and obligation-position authority |
| Coarse class status | Independent status writes | Derived from canonical class lifecycle stage |
| Grade editability | Frontend role checks | Grade-lock lifecycle and server authorization |
| Reports | Per-controller SQL totals | Reporting query objects over Finance facts |
| Event processing | Direct automation mutation | Outbox delivery invoking an authorized command |

The settlement consolidation is implemented in the working tree as a migration and model removal. Other rows are the target architecture and require the remaining work listed below.

---

## 8. Final architecture

### 9.1 Topology

The first production topology is a modular Laravel application with:

- PostgreSQL primary database;
- stateless HTTP/API workers;
- queue workers for outbox delivery, notifications, report generation, and document processing;
- object storage for private documents and verified backups;
- Redis or equivalent for queues, short-lived locks, rate limiting, and cache only;
- React/TypeScript frontend served separately or through the web edge;
- an Employee Workspace composition layer deriving effective work context, tasks, approvals, deadlines, notifications, and exceptions from canonical authorities;
- centralized logs, metrics, traces, audit storage, and alerting.

The application may begin as a modular monolith. Module boundaries are enforced in code review, dependency rules, namespaces, route registration, and architecture tests. Splitting a module into a service is deferred until measured load or team ownership justifies the operational cost.

### 9.2 Request path

`HTTP/API/console adapter -> authentication -> AccessDecision -> command/query -> domain transaction -> PostgreSQL facts/projections/outbox -> audit/metrics -> response`.

A controller may normalize transport input and render a response. It may not own a business invariant, calculate a financial balance, or directly update a domain table.

### 9.3 Data path

Financial writes use a transaction that locks the source aggregate and relevant position rows, validates the invariant, appends the fact, updates only derived projections, records audit/outbox evidence, and commits. Retry keys bind the operation name and canonical payload. A replay with a different payload is rejected.

---

## 9. Final domain and module boundaries

- **Identity:** people, credentials, authentication sessions, actor lifecycle, password/session invalidation.
- **Access:** roles, capabilities, scope grants, delegations, expiry, deny rules, decision explanations.
- **Organization:** organization/campus/branch hierarchy, lifecycle, current scope, cross-branch legitimate operations.
- **Admissions/CRM:** visitor, lead, applicant, duplicate review, admission decision, conversion.
- **Students:** profile, guardians, preferences, documents relationship, student status, portal identity.
- **Placement:** content, blueprint, attempt, answers, scoring, recommendation evidence.
- **Calendar:** terms, periods, holidays, rooms, schedule slots, session time.
- **Academic:** programs, classes, teachers, enrollment, attendance, assessments, grades, progression, completion.
- **Documents/Privacy:** document metadata, classification, retention, access grants, private storage, privacy requests.
- **HR:** person employment, contracts, employment lifecycle, clearances, employee eligibility.
- **Payroll:** periods, calculations, adjustments, proposals, payslip/withholding evidence; no recorded settlement cash fact.
- **Finance:** obligations, invoices, payments, allocations, refunds, credits, funds, budgets, journal, corrections, suppliers, loans, assets, books, funding, and recorded settlements.
- **Reporting:** read models, reports, exports, invariant auditor, reconciliation status.
- **Communication:** templates, consent, delivery attempts, notifications; never a domain state owner.
- **Integrations:** outbox, inbound idempotency, external reference mapping, retries, dead-letter review.
- **Governance/Audit:** policy decisions, audit records, attempted operations, retention, release evidence.
- **Resources/Operations:** rooms, equipment, inventory custody, backup/readiness/health.

Module dependencies point inward toward shared primitives and explicit contracts. Finance may read HR/Academic source facts through query contracts but owns its recorded money facts. Reporting may read all approved projections but may write none.

---

## 10. Final frontend architecture and rationale

React/TypeScript is selected because System A already demonstrates the broadest product experience and because dynamically composed, role-aware but not role-locked responsive workflows are easier to compose as feature slices than as a growing set of server-rendered administrative pages. The final frontend will be a single product shell with feature modules. Its primary employee experience is the first-class Employee Workspace, which composes authorized work across these modules rather than replacing them with static role dashboards:

- reception/admissions;
- placement;
- academic/classroom/teacher;
- students/portal;
- documents/communications;
- finance/payroll;
- reporting/management;
- operations/settings/audit.

Rules:

1. API contracts are generated or type-checked from the backend contract; no hand-maintained duplicate DTO truth.
2. Server state uses query caching with explicit invalidation after committed commands; local state is limited to drafts and view state.
3. Permission/capability checks improve navigation and accessibility but never replace server authorization.
4. Every mutation shows idempotency/retry-safe behavior, conflict/stale-state messaging, and a meaningful audit/reference result.
5. Finance screens display source, period, branch, status, correction history, and reconciliation state, not only a number.
6. Keyboard navigation, visible focus, labels, contrast, responsive tables/cards, screen-reader status, and mobile reception/teacher workflows are acceptance criteria.
7. Student portal views expose only object-authorized records and never infer branch access from a client-provided identifier.

System A's visual/page surface is preserved as a product baseline, but its route-local assumptions and SQLite-specific data access are not.

### Employee Workspace acceptance

The Employee Workspace is a first-class operational work environment, not a generic dashboard. At request time it composes effective employee identity, employment eligibility, all current positions, assignments, capabilities, organizational/branch scope, lifecycle state, assigned work, approvals, deadlines, notifications, authoritative context, and exceptions. It is work-first and exception-first, supports management-specific decision workspaces, and gives direct routes to canonical workflows.

A multi-position employee is not statically role-locked: the workspace may expose several legitimate work areas, while each action is independently authorized and scope-checked on the server. Personalization changes layout, shortcuts, filters, and reminders only; it cannot grant authority, alter financial truth, bypass lifecycle rules, or create a shadow task/approval/business authority. Workspace state is rebuildable and freshness/failure is visible where relevant.

### Role experience acceptance map

| Role | Complete experience required | Hard boundary |
|---|---|---|
| Administrator | organization, branches, users/roles, policy/rules, audit, readiness, configuration | cannot use a generic admin role to bypass Finance SoD or object scope |
| Reception | visitor/lead intake, applicant registration, duplicate review, placement booking, enrollment, receipts, document capture | cannot approve own admission/discount/refund or view another branch without explicit scope |
| Teacher | assigned classes, calendar, sessions, attendance, homework, assessments, grade submission/review status, student communication | cannot edit published/locked grades, payroll, invoices, or unassigned classes |
| Management | cross-branch approved dashboards, KPIs, staffing/class capacity, reports, controlled approvals | cross-branch views are explicit and marked as organization scope; no direct fact mutation through reports |
| Finance | invoices/purposes, obligations, collections, allocation, refunds, corrections, periods, journals, books, debt, assets, funding, payroll settlement approval, reconciliations | sole monetary writer; independent approval and source-linked history are mandatory |
| Student | application status, placement attempt, timetable, class, attendance, grades, documents, invoices, payment history, communication preferences | sees only own authorized objects; cannot infer or alter scope from IDs or client state |
| Operations | rooms/resources, books/inventory custody, documents, notifications, queues, backups/readiness, incident controls | operational projections cannot silently create financial or academic facts |

Responsive and accessible behavior is part of acceptance: keyboard-complete workflows, visible focus, labels, screen-reader state announcements, high contrast, no color-only status meaning, usable tables/cards at mobile widths, safe retry/conflict messages, and no destructive action hidden behind an ambiguous button.

---

## 11. Final backend architecture and rationale

Laravel modular monolith is selected over preserving the Express route implementation because System B already provides the stronger transactional/domain boundary and PostgreSQL-oriented migration model, while System A's breadth can be ported as bounded capabilities. TypeScript remains the frontend contract language; it is not necessary to maintain two independent backend implementations.

Backend rules:

- commands own mutations and enforce invariants;
- queries own projections and are read-only;
- policies/AccessDecision own authorization;
- repositories/adapters isolate persistence details where needed;
- controllers, console commands, jobs, seeders, imports, and listeners call the same application commands;
- all money is represented as fixed-scale decimal/validated value objects, never binary floating point;
- all external commands accept an idempotency key where a retry could create a fact;
- transaction boundaries are explicit and documented;
- outbox records commit with the fact;
- exceptions map to stable problem codes without leaking sensitive existence information;
- logging contains correlation IDs and safe identifiers but not credentials or unnecessary personal data.

System A's large route files are treated as a capability inventory. They are not copied as a second backend or allowed to reintroduce raw SQL business rules.

---

## 12. Final database architecture and rationale

PostgreSQL is the production database. It provides transactional row locking, numeric precision, foreign keys, partial/conditional indexes, exclusion/uniqueness constraints, trigger-level enforcement where justified, explainable query plans, mature backup/replication tooling, and safer multi-user concurrency than a single SQLite file.

The database design separates:

- **facts:** immutable or controlled lifecycle rows that state what happened;
- **workflow evidence:** proposals, approvals, clearances, and attempts;
- **projections:** balances, dashboard totals, search indexes, and report materializations;
- **audit/outbox:** evidence of who/what/when and delivery state.

Money facts are source-linked and append-only after recording. Corrections are new rows with direction and source identity. A database trigger is used for non-negotiable invariants that must survive direct SQL; it is not a substitute for the command/policy layer. All trigger rules have a matching adversarial specification.

Migration policy:

- forward migrations are versioned and reversible where safe;
- destructive consolidation requires an explicit preflight, backup, reconciliation, and deployment gate;
- migration rollback never silently fabricates financial history;
- schema and code deploy compatibility is documented;
- the final schema must not contain retired runtime authorities;
- a clean-schema build and an upgrade-path build are both required before release.

The System A SQLite `schema.sql` is mined for capability and constraint requirements. It is not copied into production and is not treated as a migration system.

---

## 13. Final security architecture

### Authorization and scope

Every protected operation evaluates authenticated actor status, capability, organization scope, branch scope, object ownership, lifecycle state, and delegation validity. Unknown actor, inactive employment, expired grant, missing branch provenance, malformed scope, or stale session fails closed. Organization-wide access is an explicit capability, not the result of `NULL`.

### Separation of duties

Preparation, approval, beneficiary, posting, refund, correction, and settlement roles are distinct where the policy requires them. The server derives the actor identity from the authenticated session. A request body cannot nominate a second identity to satisfy SoD.

### Threats explicitly covered

- IDOR across student, invoice, document, class, branch, report, and audit identifiers;
- privilege escalation via stale roles, expired delegation, inactive employment, role mutation, or session replay;
- branch/null-scope fail-open and cross-branch reporting;
- API versus web/controller authorization drift;
- direct SQL writes bypassing application checks;
- duplicate/replayed payment, refund, correction, payroll, and settlement requests;
- concurrent allocation, settlement, approval, and balance races;
- lifecycle bypasses such as graduated/suspended student billing or locked-grade mutation;
- unsafe file access, path traversal, MIME confusion, and unbounded downloads;
- automation/import/seed paths bypassing commands;
- audit tampering and missing attempted-denial evidence;
- backup exposure and sensitive log leakage.

### Controls

Use secure password/session handling, CSRF protection for browser mutations, rate limits for authentication and payment endpoints, parameterized queries, validated uploads, private object storage, signed short-lived access, encryption in transit/at rest, secret management, dependency scanning, security headers, audit correlation, and least-privilege database roles. A database role used by the application must not be able to casually disable audit/immutability triggers.

---

## 14. Final financial architecture

Finance is the sole monetary authority.

### Canonical model

1. A charge becomes an obligation with source, student/organization, branch provenance, period, amount, purpose, and lifecycle.
2. An invoice is a document over an explicitly declared purpose; a tuition invoice names one term/obligation.
3. A payment is an immutable cash fact with idempotency identity, channel, payer detail where known, source branch, and date.
4. Allocation links a payment to an obligation or permitted non-obligation purpose. It cannot exceed payment, source capacity, or obligation position.
5. Journal/subledger facts capture economic classification. Operational balances are projections.
6. Refunds, write-offs, aid reversals, allocation reversals, settlement corrections, and clawbacks append compensating evidence linked to their source.
7. Reports calculate positions from facts and expose reconciliation status.

### Settlement

Payroll calculates a settlement proposal with amount, basis, employment, preparer, and supporting clearances. Finance independently approves and records one `employment_settlements` fact after locking the proposal/employment and verifying termination, branch provenance, active status, independent actors, and idempotency. The old Payroll settlement table/model has been removed from the target runtime schema.

### Concurrency and failure

Lock the source obligation/payment/settlement aggregate in a deterministic order. Use unique idempotency keys, unique source constraints, conditional remaining-capacity checks, and serializable or appropriately locked transactions. If an outbox insert fails, the fact transaction rolls back. If external delivery fails, the fact remains and delivery retries. A partial report read never writes a compensating adjustment.

### Policy gates

Cash drawer variance, supplier credit policy, loan/interest policy, write-off authority, withholding, FX, capital return, restricted-fund enforcement level, and depreciation policy remain explicit owner decisions until defined. The system refuses those operations with a named policy code rather than inventing a classification.

---

## 15. Final lifecycle architecture

All transitions follow:

`current state -> command -> actor/scope check -> prerequisite check -> row lock -> transition graph -> append transition/audit/outbox -> derived projection -> commit`.

Canonical lifecycle families:

- applicant: captured -> under_review -> admitted/rejected/withdrawn;
- student profile: active/inactive/suspended/graduated, with graduation terminal and resume workflow for suspension;
- class: draft -> scheduled -> enrollment_open/closed -> activated -> in_progress/suspended -> grading -> completed -> archived/cancelled;
- enrollment: pending/reserved/confirmed -> active -> frozen/transfer/drop/withdraw/complete -> graduate/retake;
- grade assessment: draft -> submitted -> reviewed -> approved -> published -> locked, with a separate gated unlock/correction path;
- financial period: open -> closing -> closed, with no uncontrolled post-close facts;
- correction: proposed -> approved/recorded, then immutable;
- settlement proposal: proposed -> approved; Finance recording is a separate authenticated command;
- employment: active/suspended -> terminated, with settlement prerequisites after termination;
- document: draft -> verified -> published/expired/withdrawn, while stored bytes remain protected and audited.

Terminal states cannot be reopened by generic update endpoints. A state that needs a reversal has a named compensating workflow with its own permission, reason, approval, and audit evidence. Display status fields are projections of the canonical state.

---

## 16. ADRs created or superseded

1. **Created:** this document, `2026-09-05-unified-platform-reconciliation.md`, establishes the third architecture and supersedes any assumption that either source system should be mechanically preserved.
2. **Superseded in part:** `docs/architecture/decisions/2026-09-05-production-authority-and-correction.md` remains authoritative for provenance and correction semantics, but its historical Payroll compatibility approach is superseded by settlement consolidation migration `000143`.
3. **Retained and extended:** existing access, lifecycle, finance-period, idempotency, audit, and branch-isolation decisions remain valid only where they agree with the one-authority rules in this document.
4. **Required next ADRs:** PostgreSQL deployment/backup, React contract/versioning, outbox delivery, document storage/security, supplier/loan/FX/withholding policy gates, and migration cutover/reconciliation.

Existing decisions are not silently deleted. When a later decision changes an authority, the superseding document names the replaced authority and the runtime migration removes it.

---

## 17. Major refactors performed in this reconciliation

The current working tree contains a broad prior hardening wave covering authorization, branch scope, lifecycle, finance provenance/corrections, payroll settlement proposal/Finance recording, reporting, and UI/controller parity. The changes relevant to this reconciliation include:

- Finance employment settlement command/model and database enforcement were added as the recorded settlement authority.
- Finance correction types, source shape, open-period and immutable-recording guards were added.
- Branch provenance and fail-closed access behavior were strengthened across the affected controllers and domain commands.
- Student operational eligibility was separated from historical student profile status.
- Payroll proposal/settlement paths were aligned toward Finance ownership.
- The failed assumption that a read-only Payroll compatibility model was an acceptable final architecture was corrected: `FinalSettlement.php` is removed, and migration `000143` drops `final_settlements` after replacing the settlement-proposal guard with the Finance table.
- Settlement approval was moved to explicit Finance web/API routes and `MaintainEmploymentSettlement`; Payroll now owns only clearance and proposal preparation.
- The architecture and capability reconciliation is recorded here rather than hidden in implementation comments.

These changes have not been executed against a runtime in this phase.

---

## 18. Dead and duplicate code removed or scheduled for removal

Removed now:

- Payroll `FinalSettlement` model as a runtime authority;
- the final-schema `final_settlements` table through migration `000143`;
- the old proposal guard dependency on that table through the same migration.

Scheduled for removal during implementation waves:

- duplicate Express/SQLite backend route implementations from the product runtime;
- controller-local finance totals and direct financial table writes;
- unreferenced lifecycle aliases after API compatibility migration;
- duplicate permission catalogs and route-specific role checks;
- report code that writes or “repairs” financial facts;
- direct automation/import/seed mutations that do not call commands.

Migration history may retain the old creation migration as historical deployment context. That does not make its table a final runtime authority.

---

## 19. New architectural risks discovered

1. **Integration scope:** React System A screens cannot be connected safely by copying endpoints; a typed contract and semantic mapping are required.
2. **Schema breadth:** importing books/assets/loans/funding into System B without a bounded subledger model could recreate a finance monolith with hidden duplicate balances.
3. **SQLite assumptions:** System A's WAL/busy-timeout behavior is not an adequate substitute for PostgreSQL deployment, failover, backup, and multi-worker testing.
4. **Migration cutover:** dropping the old settlement table is safe for the declared clean-schema redesign, but a real deployment with historical rows needs an export/reconciliation gate before `000143`.
5. **Policy incompleteness:** unrecorded owner policy for cash variance, withholding, FX, loan interest, write-off, depreciation, and restricted funds can tempt future developers to invent classifications.
6. **Scope drift:** legitimate organization-wide operations could be incorrectly narrowed if every payroll/report query is forced into a branch without an ownership decision.
7. **Projection trust:** dashboard/cache/account balances can silently diverge unless rebuild and reconciliation are first-class operations.
8. **Outbox correctness:** retries, dead letters, and poison messages need operational ownership; an event table alone does not guarantee delivery.
9. **Document security:** database row authorization and object-store authorization must be tested together.
10. **Review independence:** same-agent or same-team tests are not a substitute for independent security/financial review.
11. **Performance:** PostgreSQL row locks and invariant queries need indexes and measured contention tests once dependencies are available.
12. **Accessibility/product parity:** System A's broad UI is a baseline, not proof that every workflow is usable at mobile widths or with assistive technology.
13. **Workspace authority drift:** a cross-module work environment could become a shadow authority if it stores independent tasks, approvals, balances, permissions, or lifecycle state; composition, command-time authorization, rebuildability, and owner links must be enforced together.

---

## 20. Remaining implementation work

### Foundation

- finalize the PostgreSQL target schema and bounded subledger tables;
- add contract versioning/OpenAPI or an equivalent typed API boundary;
- create the transactional outbox and delivery/retry/dead-letter operations;
- implement migration preflight, backup, restore, and reconciliation gates;
- complete a route/controller/command/query writer inventory.

### Product capabilities

- port the React System A feature slices to the unified API;
- implement visitor/CRM, placement content/attempts, teacher/class/session, grade lock, portal, books, suppliers, loans, assets, funding, impact, bank reconciliation, and advanced reports within the final module boundaries;
- implement secure document storage/access and communication delivery;
- implement the first-class Employee Workspace and management workspaces with work-first/exception-first composition, canonical workflow links, responsive/mobile workflows, API/web parity, and measurable employee-efficiency acceptance.

### Security and correctness

- finish API/console/web parity for every command;
- prove branch isolation for every object and report;
- complete stale permission, inactive employee, delegation, replay, IDOR, direct SQL, race, and rollback test matrices;
- add database guards where application-only rules would be bypassable;
- define and register unresolved owner policies before enabling their commands.

### Operations

- backup/restore drills, readiness dependency checks, metrics/alerts, queue/outbox monitoring, log redaction, incident runbooks, and disaster recovery objectives;
- performance plans for obligations, payment allocation, reports, invariant checks, and branch-scoped dashboards;
- independent security and financial review.

---

## 21. Tests created or updated, and tests deliberately not executed

The working tree includes or updates feature, payroll, schema-invariant, direct-SQL attack, controller, branch-scope, placement, student-lifecycle, finance, and settlement workflow specifications from the current hardening wave. The settlement consolidation requires additional specifications for:

- absence of the Payroll settlement model/table in the final schema;
- proposal insertion and approval after the Finance table is authoritative;
- direct SQL attempts against the removed table/model path;
- Finance settlement idempotency and concurrent duplicate approval;
- historical migration preflight behavior when old settlement rows exist;
- source-linked compensating settlement corrections;
- API, web, and console parity;
- Employee Workspace composition for multi-position employees, effective employment/lifecycle changes, scope/capability changes, management-specific context, task/deadline/approval/exception prioritization, personalization isolation, projection rebuild/freshness, and command-time reauthorization.

These tests are executable specifications only at this stage. No PHPUnit, PHPStan, Pint, migration, PostgreSQL, Node, Vitest, or frontend test command was run. The absence of execution is intentional and must not be reported as a pass.

---

## 22. Work deliberately deferred to final runtime validation

The following are explicitly deferred:

1. PHP syntax/autoload/container resolution and Laravel boot;
2. migration application on a clean PostgreSQL database;
3. migration upgrade/cutover with representative historical data;
4. migration rollback and restore behavior;
5. PostgreSQL trigger ordering, locking, isolation, and concurrent races;
6. API/web/console authorization behavior in a running server;
7. React build, generated contract alignment, browser navigation, and accessibility checks;
8. dependency vulnerability and license scans;
9. queue/outbox retry and crash recovery;
10. backup restore and readiness failure drills;
11. performance/query plans under realistic branch, student, finance, and report volumes;
12. independent security, financial, and operational review;
13. Employee Workspace runtime composition, API/web parity, freshness, lifecycle revocation, scope isolation, concurrency, accessibility, usability, and employee-efficiency validation.

**Verdict:** the repository now has a documented third architecture and an explicit authority consolidation, but it is **not certified production-ready**. The architecture is suitable for implementation; production readiness remains blocked on runtime execution, migration/recovery evidence, complete capability implementation including the Employee Workspace, and independent review.
