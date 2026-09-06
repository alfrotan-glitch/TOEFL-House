# TOEFL House — Final Platform Architecture Blueprint

**Date:** 2026-09-05 (Asia/Kabul)  
**Status:** Final target architecture for implementation; static reconstruction complete; runtime validation and production-readiness certification deliberately deferred  
**Working branch:** `arena/01a07134-toefl-house`  
**Repository:** `alfrotan-glitch/TOEFL-House`

> This is an architecture decision, not a claim that the current checkout is complete or production-ready. No PHP, Composer, PostgreSQL, migration, PHPUnit, PHPStan, Pint, Node build, browser, queue, integration, or runtime command was executed for this blueprint.

---

## 1. Scope, identity map, evidence, and limits

### 1.1 The three systems

The earlier comparison documents used an A/B shorthand that became ambiguous after the archive on `origin/main` was discovered. This blueprint establishes the identity map that governs all subsequent work:

| Identity | Static source | Actual system | Evidence boundary |
|---|---|---|---|
| **System A** | `origin/arena/01a03298-toefl-house`, commit `b2886a4` | The latest React/Vite + TypeScript frontend and Express/TypeScript backend using SQLite; broadest feature surface and most mature financial/academic hardening | `src/`, `server/src/`, `server/src/db/schema.sql`, route/core/test/document trees |
| **System B** | `origin/main:ERP.zip`, extracted only to a temporary inspection directory | An earlier packaged React/Vite + TypeScript + Express/TypeScript + SQLite ERP snapshot; same product lineage as A, materially smaller and less hardened | Archive manifest, 96-table schema, 32 route groups, older UI/core/docs; not a separate production authority |
| **System C** | Current checkout `HEAD e399ca3`, branch `arena/01a07134-toefl-house` | Laravel 12 modular monolith, PostgreSQL-oriented migrations, Blade transport/frontend, current authority and architecture work | `app/Modules/`, `database/migrations/`, `routes/`, `resources/views/`, current architecture/review documents |

System B is not treated as an independent backend to merge with System A. It is a historical/product-line evidence set: it proves earlier intended screens, naming, workflows, and capability experiments, while A is the later expression of the same React/Node design. System C is the current third system and the only repository being changed.

### 1.2 Inspection method

The reconstruction used static tree, source, route, schema, migration, controller, command, query, permission, frontend, test-name, and architecture-document inspection. Git refs were inspected without switching branches. `ERP.zip` was listed and extracted outside the repository solely for static reading.

Important source facts:

- A contains 138 declared SQLite business tables, 33 route files, domain cores for academic, books, calendar, configuration, dashboard, events, finance, funding, impact, journey, observability, operations, payroll, placement, RBAC, reporting, students, and visitors, plus a React feature frontend.
- B contains 96 declared tables, the same broad route family, and the same general product lineage, but lacks much of A's later financial subledger, placement content, lending, asset, supplier, loan, notification-read, and correction surface.
- C contains a large Laravel modular architecture, 144 migration-created table names in the inspected migration chain, substantial command/domain/query separation, PostgreSQL-oriented integrity, and a Blade frontend. Its own conformance audit remains **NOT CONFORMING** to the prior target graph.
- A and B source documentation claims tests and release gates, but those claims are not runtime evidence in this phase.

### 1.3 Decision standard

A capability is selected only if it is useful to TOEFL House, has a clear owner, can be authorized and audited, has a coherent lifecycle, and can be represented without a duplicate monetary or academic authority. A source implementation is not selected merely because it exists. A missing capability is not added merely because an ERP feature list names it.

---

## 2. Executive decision and non-negotiable principles

Neither source system is accepted unchanged. TOEFL House will build a **fourth approach**: a redesigned, capability-complete modular monolith that uses C's stronger domain/relational discipline, A's validated product breadth, and explicit redesign where both source systems are weak or contradictory.

### 2.1 Final technology decision

- **Backend:** Laravel 12 modular monolith on PHP 8.3+ with explicit module application services, commands, domain policies, queries, transport adapters, and PostgreSQL persistence.
- **Database:** PostgreSQL as the sole transactional database. No SQLite production authority and no second operational database.
- **Frontend:** One React + TypeScript application built with Vite, route-based feature slices, a shared design system, typed API contracts, server-state caching, responsive employee/management/student shells, and first-class English plus Persian/Dari RTL support.
- **Transport:** Versioned JSON HTTP API (`/api/v1`) used by React, with API and web/print adapters invoking the same application commands. Blade is not the final interactive product frontend; backend-rendered print/PDF documents are a rendering service, not a second application UI.
- **Integration:** Transactional outbox in PostgreSQL, an idempotent relay, internal queue delivery, notification projections, and explicit integration endpoints. No domain state is delegated to a message broker.
- **Accounting:** Finance is the sole monetary authority. A double-entry journal and bounded subledgers are the canonical accounting model; all operational money facts link to source evidence and journal postings.
- **Authorization:** Central AccessDecision evaluation using authenticated identity, employment/account state, permissions, delegation, lifecycle, object ownership, organization scope, branch scope, and separation-of-duties rules. Unknown scope is denial, never “all.”
- **Workspace:** Employee Workspace and Management Workspace are first-class composition layers over canonical domain facts. They are not a static role dashboard and never own permissions, balances, approvals, enrollments, payroll, or lifecycle state.

### 2.2 Architectural laws

1. One major fact has one owner, one write authority, one lifecycle authority, one authorization path, and one canonical database representation.
2. Read models, dashboards, search indexes, workspace cards, notifications, and reports are projections. They may be stale, rebuilt, or deleted without changing business truth.
3. A route/controller may parse and authorize; it may not become a second domain writer.
4. Corrections are source-linked compensating facts. Destructive deletes are not financial correction semantics.
5. Domain state and its outbox event commit atomically. Event delivery is at-least-once; consumers are idempotent.
6. A coarse status is derived from the detailed lifecycle when both would otherwise be independent writers.
7. Payroll calculates and proposes. Finance records liabilities and settlement facts.
8. Placement recommends; Academic admits/enrolls; Finance bills and settles.
9. Funding describes donor intent, awards, restrictions, and impact. Finance records money and enforces spendability.
10. Workspace visibility is not authorization. Every action is reauthorized at command time.

---

## 3. Master A/B/C capability inventory and classifications

Classification vocabulary: **A-only/B-only/C-only** means materially present only in that system; **A+B**, **A+C**, or **B+C** means shared by that pair; **A+B+C** means all three contain a meaningful implementation; **missing** means not materially present in any source or not sufficient for the target; **duplicated** means a source contains more than one competing authority; **incomplete** means a capability exists but cannot safely support the target lifecycle; **conflicting** means the sources implement incompatible ownership or semantics.

| Capability family | System A | System B | System C | Classification | Final disposition |
|---|---|---|---|---|---|
| Organization, campuses, branches | Organizations, campuses, branches, branch scope | Same basic hierarchy | Organization, campuses, branches, scope links | A+B+C | Preserve as Foundation; C/PostgreSQL authority, fail-closed scope |
| Organization lifecycle and branch availability | Branch guards and profiles | Basic branch administration | Organization lifecycle and branch availability domains | A+B+C, incomplete in C | Keep; one Organization owner and one scope resolver |
| People/person identity | Student/teacher/employee rows, linked accounts | Same role-linked identity model | `people`, identity accounts and participation-oriented models | A+B+C, duplicated in A/B | Rebuild canonical Person; domain participations reference it |
| Authentication and sessions | HttpOnly session, password quarantine, session version | Same lineage, older | Laravel identity/account/auth flows | A+B+C | Keep C foundation; add MFA/recovery/session revocation policy |
| RBAC | Permission catalog, roles, scoped user roles | Same, older role vocabulary | Access positions, roles, scope grants, delegations | A+B+C, conflicting | Access owns canonical capability and ABAC decision; no role checks in domain code |
| Delegation and expiry | Event/role delegation concepts | `role_delegations` | `delegations`, expiry and grant workflows | A+B+C, incomplete | Keep explicit temporary delegation with SoD and audit |
| CRM sources/campaigns/visitors | Visitor pipeline, campaigns, follow-ups, duplicate lookup | Same | CRM visitor/source/campaign/follow-up/interactions | A+B+C | CRM owns prospect and interaction history |
| Admissions/applicant case | Visitor conversion to student | Visitor conversion | Applicant, admission decision, register/initiate/review/approve/enroll | A+B+C, boundary conflict | Admissions owns application/decision; Students owns student creation |
| Households/guardians | Households and student staff relations | Limited/no household model | Guardian relationships | A+C | Students owns relationships; Person remains identity authority |
| Student master and status | Students and lifecycle service | Students and statuses | Students module, status/hold events, operational eligibility | A+B+C, stronger C lifecycle | Students owns profile/status; no Admissions direct student insert |
| Student branch transfer | A table and guarded route | Limited/older | C table/command | A+C | Students owns home-branch transfer; historical provenance immutable |
| Placement content bank | Tests, sections, questions, rubrics, media | Basic placement rules/profile | Placement tests/questions/sections/rubrics/media | A+B+C, incomplete B/C | Placement owns versioned content and attempts; persist evidence |
| Placement attempts/scoring/results | Full attempt/response/result engine | Modal/basic attempt surface | Attempts/results/recommendations and appeals | A+C, incomplete B | Preserve A's content/evidence ideas; redesign scoring/result lifecycle |
| Placement recommendation and eligibility | Recommendation/decision engine | Placement rules | Eligibility snapshots and recommendation domain | A+B+C, conflicting | Placement owns evidence; Academic consumes signed eligibility snapshot |
| Program/course/subject/module catalog | Programs, versions, subjects, modules, levels | Programs, versions, subjects, modules | Programs, versions, levels and offerings | A+B+C | Academic Planning owns versioned immutable published catalog |
| Academic terms/calendar/holidays | Terms, time slots, academic holidays, Shamsi date helpers | Same | Calendar/period authority and academic periods | A+B+C, duplicated calendar rules | Calendar owns time; one Jalali/Gregorian conversion service |
| Skills and teacher rates | Skills, level skill rates, assignment validation | Same | Skills and assignment skills | A+B+C | Workforce owns skill/compensation inputs; Academic owns teaching assignment |
| Rooms and facilities scheduling | Rooms/time slots/classes/sessions | Same | Academic rooms, availability, timetable queries | A+B+C, scheduling embedded inconsistently | Separate Scheduling & Facilities context; Academic references reservations |
| Offerings, class generation, capacity | Generation engine, offerings, classes, lifecycle | Same | Offerings/classes/sections/lifecycle | A+B+C, incomplete C | Academic Delivery owns sections/capacity; derive occupancy and offering capacity |
| Enrollment, freeze, transfer, waitlist | Detailed transition engine and waitlist | Same | Enrollment/waitlist/freeze/transfer commands | A+B+C, conflicting lifecycle variants | Academic Enrollment owns all enrollment transitions; Finance gate is a policy check |
| Sessions and attendance | Session/roster/attendance and policy services | Same | Sessions/class sessions/attendance facts | A+B+C | Academic Delivery owns attendance; one session provenance path |
| Homework/quizzes/continuous assessment | Tables and UI concepts | Tables | Assessment attempts/results, less delivery breadth | A+B, incomplete C | Required academic capability; phase with gradebook redesign |
| Exams and certificates | Exams/results/certificates | Same | Assessment/certificate/transcript/graduation models | A+B+C | Academic Assessment and Certification own results and credentials |
| Gradebook/grade lock/history | Gradebook, grade lock and history | Same | Assessment results, correction/appeal models | A+B+C, duplicate correction risk | Academic owns grades; lock/publish/correct through one command graph |
| Progression/prerequisites/graduation | Promotion engine and rules | Promotion rules | Progression decisions/rules, graduation decisions, transcripts | A+B+C, incomplete C | Academic Progression owns rules and decisions; no grade/report writer |
| Student portal | React student view | React student view | Blade/API student surfaces, less complete | A+B+C, frontend conflict | Rebuild in single React app; self-scope by Access |
| Documents and printing | Receipt/invoice/certificate printing and audit | Same | Documents, versions, classifications, retention, print routes | A+B+C, incomplete A/B security | Documents owns metadata/version/retention; object access uses Access |
| Privacy/consent/disclosure/export | Limited policy/read controls | Limited | Consent, revocation, disclosures, subject export | C-only | Preserve as Privacy platform context |
| Communication/messages | Notifications and templates | Notifications | Message queue/delivery state | A+B+C, incomplete C | Communication owns delivery; Notifications owns recipient/read projection |
| Generic notification read state | Per-user read receipts in latest A | Shared read flag/older | No complete authority | A-only, missing C | Adopt A's per-user read state, branch scoped and idempotent |
| Finance obligations/invoices | Tuition obligations, invoices/items, installments, allocations | Invoices/items, no complete obligations | Obligations/lines/installments | A+C, incomplete B | Finance owns AR and invoice purpose; one obligation authority |
| Payments/refunds/allocations | Payment, refunds, LIFO/contra and allocation hardening | Payments/refunds | Payment allocations/refunds/corrections | A+B+C, conflicting semantics | Finance owns immutable payment and compensating refund/allocation |
| Discounts/credits/write-offs | Discount authorization, student credits, tuition/advance write-offs | Discounts, less complete | Discounts/financial credits/corrections | A+C, incomplete B | Finance owns approval and source-linked correction facts |
| Double-entry chart/journals/periods | Partial transaction ledger and categories; journals limited | Basic transaction/ledger | Accounts, journals/lines, periods, opening states, reconciliations | C-leading; A+B incomplete | Adopt C shape but strengthen into full Finance posting engine |
| Budgets/expense workflow | Categories, channels, budget lines, expense requests/movements | Budget, expense, savings | Budget/fund allocation and gate evidence, less complete | A+B+C, incomplete C | Finance owns budget and commitment; approval through Workflow, posting through Finance |
| Books inventory/sale | Catalog, receipts, adjustments, sales/refunds, lending/returns | Catalog, restock, sales | Book copies/issuances | A+B+C, conflicting scope | Resources owns stock/custody/lending; Finance posts sale/purchase money |
| Assets/custody/depreciation/disposal | Full fixed asset lifecycle and evidence | Not materially present | Assets/custodies/disposals | A+C, incomplete C | Resources owns physical custody; Finance owns valuation and journal entries |
| Suppliers/AP/returns/terms | Supplier invoices/payments/returns/terms | Not materially present | Not materially present | A-only, missing C | Required Phase 2; Resources owns supplier/receipt; Finance owns AP/payment |
| Loans/interest | Loans, repayments, interest facts and evidence | Not present | Not materially present | A-only, missing C | Required only under signed financing policy; Finance owns liability/interest |
| Donors/campaigns/donations | Donors, campaigns, donations, restrictions and entries | Donors/campaigns/donations | Funding sources/allocations but no complete donor domain | A+B, incomplete C | Funding owns donor/grant intent; Finance records cash and journals |
| Scholarships | Fundings, awards, aid allocation and reprice | Awards, less complete funding | No complete scholarship award | A+B, missing C | Funding owns award eligibility; Finance owns obligation credit/settlement |
| Sponsorships | Agreements, receipts, allocations and terminal lifecycle | Agreements | No complete sponsor domain | A+B, missing C | Funding owns agreement/commitment; Finance owns receipt and allocation |
| Restriction/release/clawback | Donor restrictions, restricted exposure, clawbacks | Limited sponsorship semantics | Fund allocations but no complete restriction enforcement | A+B, incomplete C | Required architecture; Finance enforces restricted spend and release |
| Impact reporting | Impact metrics/reports and derived reporting | Metrics/reports/success stories | Reporting projections/metrics | A+B+C, duplicated definitions | Reporting owns metric catalog; Funding supplies approved program facts |
| Workforce/HR contracts/employment | Employees, teachers, history, evaluations, rates | Employees/teachers, older | HR contracts, employment, leave, scales/statuses | A+B+C, conflicting teacher/employee boundaries | Workforce/HR owns employment; Academic owns teaching work; Payroll owns calculation |
| Payroll calculations/results | Teacher/employee payroll, salary ledgers, corrections/withholding | Teacher salary ledger/basic payroll | Payroll periods/calculations/results/liabilities/settlement proposals | A+B+C, settlement conflict | Payroll calculates; Finance owns liability, posting, and settlement fact |
| Employment settlement | A latest finance settlement semantics | Not materially present in older snapshot | Finance settlement plus retired Payroll compatibility history | A+C, conflicting historical authority | Finance `employment_settlements` is sole fact; remove compatibility authority |
| Rules/policies/versioning | Rule engine, policy catalog, policy versions | Same | Governed configuration and policy registry | A+B+C, scope conflict | Domain policy remains in owner context; cross-cutting governance only in Governance |
| Generic workflows/approvals | Workflow definitions/instances/history and automations | Same older | No complete generic workflow | A+B, missing C | Add Work Management; workflows coordinate, domain commands decide |
| Events and automation | Event registry/bus/handlers/subscriptions | Same | Domain events/outbox partial | A+B+C, incomplete C | Transactional outbox is platform authority; automation allowlisted |
| Audit and forensic evidence | Audit logs/failures, invariant checker | Audit logs | Audit events/attempted/rejected operations | A+B+C | Audit owns audit evidence; domain rows remain source truth |
| Search | Permission/branch-scoped global search | Search | No canonical search | A+B, missing C | Add Search projection with authorization-filtered queries |
| Dashboards/BOS/work queues | Executive BOS, operational work queue, dashboards | Same older | Dashboards/metrics/reporting but not work-first workspace | A+B+C, incomplete/conflicting | Rebuild as Reporting + first-class Workspace |
| Backup/readiness/observability | Backup verification, readiness, logs, invariants | Startup/readiness docs | Integrations/jobs/observability architecture | A+B+C, operationally incomplete C | Add production Operations context and prove restore/runtime |
| Employee Workspace | Role dashboards/queues, not full dynamic workspace | Same | Architecture principle only | A+B incomplete, C-only decision | Required redesign; dynamic, work-first, non-authoritative |
| Management Workspace | BOS/executive dashboards | Same | Reporting/dashboard intent | A+B+C, incomplete | Management decision-support context over canonical metrics |
| API/web parity | Express API + React | Same | Laravel API + Blade, uneven parity | A+B, C incomplete/conflicting | React consumes versioned API; commands shared by web/console |
| Migration/recovery discipline | SQLite schema/convergence scripts | Fresh schema/seed docs | Laravel migration chain, consolidation in progress | A+B+C, incomplete | Clean pre-production baseline; production path uses expand/contract |

---

## 4. Capability quality decisions

### 4.1 Preserve and strengthen

- A's placement content/evidence model, academic policy/lifecycle engines, waitlist/capacity controls, book lending, financial aging, restricted exposure, asset/economic evidence, and invariant mindset.
- C's explicit commands, domain boundaries, PostgreSQL constraints, branch provenance, governed configuration, audit separation, privacy model, Finance correction semantics, employment settlement boundary, and integration job concepts.
- B's earlier product vocabulary, screen composition, and low-friction operational flows only where they map to the final authority model.

### 4.2 Redesign rather than copy

- Finance: replace A/B's SQLite `financial_transactions`-centered approach with a PostgreSQL double-entry posting core plus source-linked subledgers. Keep the capability, not the table shape.
- Identity/access: merge A/B role catalogs and C positions/grants into one AccessDecision service. No frontend or route-local role inference.
- Academic setup: unify A/B catalog/generation with C's versioned program/level/eligibility/progression decisions.
- Funding: retain A's donor/restriction/award depth but make Finance the monetary posting authority.
- Workflows: retain A/B definitions and history but permit only approved internal command adapters, not arbitrary mutation scripts.
- Reporting: retain A/B report breadth and C metric definitions, but centralize formulas, period windows, access, reconciliation, and export.
- Frontend: port the best React product surfaces to a new typed API; do not wrap the existing Blade pages or copy A's monolithic `App.tsx` contract.

### 4.3 Required now, architecturally required, future, optional, or rejected

| Decision class | Capabilities |
|---|---|
| **Required for core launch** | Organization, identity/access, people, CRM/admissions, student lifecycle, placement minimum, academic setup, scheduling, enrollment, class/session/attendance, gradebook/assessment, documents, communication, finance AR/payments/periods/journals, HR/workforce, payroll calculation/liability, audit, reporting, API, React employee/student shells |
| **Architecturally required now; phased operational enablement** | Transactional outbox, Work Management, Search, Notifications, restricted funds, fund dimensions, asset boundary, privacy/retention, backup/restore, management workspace, accessibility, migration reconciliation |
| **Important Phase 2** | Full placement test-bank authoring, scholarships/sponsorships, supplier/AP, books lending and sales, fixed assets/depreciation/disposal, advanced progression/appeals, bank reconciliation, impact/grant reporting, payroll withholding and employee advances |
| **Important future** | LMS content delivery, mobile/PWA offline attendance, external payment gateways, advanced procurement/PO, alumni, transport, hostel, multi-currency/FX, advanced data warehouse |
| **Optional** | Campaign marketing automation, public self-service donor portal, biometric attendance, complex visual workflow designer, AI recommendations, endowment accounting |
| **Not required / rejected** | Microservices at launch, a second SQLite backend, micro-frontends, independent CRM student master, generic ledger in Funding, role-name security, frontend-only permissions, separate Payroll settlement authority, a dashboard that owns tasks/approvals, arbitrary workflow code execution, full LMS before core SIS/ERP integrity |

A phase label is not permission to omit the architecture. The boundaries, owner contracts, tables, events, and authorization decisions are defined now even when an operational UI arrives later.

---

## 5. Final business capability hierarchy

```text
TOEFL HOUSE ENTERPRISE
├── Foundation and control
│   ├── Organization and structure
│   ├── People and identity
│   ├── Calendar and periods
│   ├── Governance and configuration
│   └── Access, privacy, audit, and operations
├── Student and academic mission
│   ├── CRM and admissions
│   ├── Placement and assessment entry
│   ├── Student lifecycle and learner services
│   ├── Academic planning and curriculum
│   ├── Scheduling and facilities
│   ├── Academic delivery
│   │   ├── Enrollment and waitlist
│   │   ├── Classes, sessions, attendance
│   │   ├── Assessments, gradebook, exams
│   │   └── Progression, completion, transcripts, credentials
│   └── Student/guardian portal
├── Workforce and operations
│   ├── HR and employment
│   ├── Teacher work and evaluations
│   ├── Payroll calculation and clearance
│   ├── Resources, books, assets, custody
│   └── Procurement and suppliers
├── Economic control
│   ├── Finance and accounting
│   │   ├── Accounts, journals, periods, reconciliations
│   │   ├── Receivables, obligations, invoices, payments
│   │   ├── Payables, payroll liabilities, settlements
│   │   ├── Budgets, expenses, funds, restrictions
│   │   └── Assets, loans, interest, corrections
│   └── Funding, grants, scholarships, sponsorships, impact
└── Coordination and insight
    ├── Work Management and approvals
    ├── Documents and records
    ├── Communication and notifications
    ├── Search
    ├── Reporting and analytics
    ├── Employee Workspace
    └── Management Workspace
```

This hierarchy is a product hierarchy, not a table hierarchy. A capability may read another context, but it does not own the other's fact merely because it appears in the same workspace.

---

## 6. Final bounded contexts and module map

| Context/module | Owns | May read/command | Must not own |
|---|---|---|---|
| **Organization** | organization/campus/branch/department/cost-center hierarchy and lifecycle | all scoped contexts | student, employment, accounting, or permission facts |
| **People & Identity** | Person, contact methods, relationships, account links, authentication lifecycle | Access, Students, Workforce, CRM | student status, employment state, role grants |
| **Access** | roles, permissions, positions, scope grants, delegations, effective authorization decisions | Organization, Workforce, audit | domain business transitions |
| **Calendar & Governance** | canonical calendar versions, periods, governed configuration and policy metadata | all contexts | operational state or money |
| **CRM & Admissions** | prospects, visitors, campaigns, interactions, applications, admission decisions | People, Placement, Students, Documents, Workflow | student profile creation after approved registrar command; enrollment state |
| **Placement** | test bank, versions, attempts, responses, scoring evidence, recommendations, eligibility snapshots | Admissions, Academic Planning, Documents | class assignment, tuition, admission approval |
| **Students** | student participation/profile lifecycle, guardians, home branch, holds, communications preferences | People, Admissions, Academic, Finance, Documents | academic grade/enrollment state, payments |
| **Academic Planning** | programs, versions, subjects/modules, levels, prerequisites, progression policy, academic setup | Calendar, Placement, Scheduling, Finance fee policies | attendance, payment, payroll |
| **Scheduling & Facilities** | rooms, availability, time slots, reservations, calendar conflicts | Organization, Academic Planning/Delivery, Workforce | class enrollment, grade, monetary value |
| **Academic Delivery** | offerings, sections/classes, class lifecycle, enrollment, waitlist, sessions, attendance, assessments, gradebook, progression, completion, credentials | Scheduling, Students, Placement, Finance, Workforce | invoices/payments, employee salary, donor funds |
| **Workforce & HR** | employee participation, employment, contracts, positions, leave, skills, evaluations, work eligibility | Organization, Access, Academic Delivery, Payroll | payroll result posting, student state |
| **Payroll** | payroll periods, calculations, adjustments, result approval, clearance/proposal | Workforce, Academic teaching facts, Finance | cash/journal settlement, employment settlement fact |
| **Finance & Accounting** | chart of accounts, periods, journals, AR/AP, payments, allocations, budgets, funds, restrictions, payroll liabilities, settlements, asset/loan accounting, corrections | every business source through typed commands | academic grade/enrollment or donor program truth |
| **Funding & Impact** | donors, funders, campaigns, grant agreements, restrictions/intent, scholarship/sponsorship awards, program outcomes and narratives | Finance, Students, Academic, Reporting, Documents | cash, journal, payment, invoice, or bank balance |
| **Resources & Procurement** | book catalog/stock/lending, supplier identity/receipt, physical assets/custody, work orders | Finance, Organization, Students, Documents | accounting balance, payment, financial classification |
| **Work Management** | generic work item, assignment, SLA, approval routing, workflow instance/history | all command endpoints and events | domain approval truth where the domain owns it; permissions |
| **Documents & Records** | document metadata, versions, classification, verification, retention, secure object references | all contexts | underlying student, financial, or authorization fact |
| **Communication & Notifications** | templates, messages, delivery attempts, recipient/read projections | all event sources, Access | business state, permission, balance |
| **Search** | permission-filtered search index and query contract | projections from all contexts, Access | source fact, access grant |
| **Reporting & Analytics** | metric catalog/version, report definitions/runs, projections, reconciliations | all source contexts, Finance journal read model | any source fact or correction |
| **Employee/Management Workspace** | composition, presentation preferences, links to canonical work, freshness metadata | all read APIs, Work Management, Access | tasks/approvals/balances/permissions/lifecycle facts |
| **Integrations & Operations** | outbox relay, inbox/idempotency, delivery endpoints, jobs, readiness, backup/restore telemetry | all events and configured external systems | domain truth or authorization bypass |

The context map is a modular monolith boundary map. It is intentionally not a microservice deployment map. Deployment may be split later only after observed load, ownership, and operational maturity justify it.

---

## 7. Major-fact authority matrix

The following is the minimum authority contract. `DB` names the canonical representation; projections, caches, search rows, and workspace cards are explicitly non-canonical.

| Major fact | Owner/write authority | Lifecycle authority | Authorization path | Canonical database representation |
|---|---|---|---|---|
| Organization/branch | Organization commands | Organization lifecycle | Access + Organization scope | `organizations`, `campuses`, `branches`, `departments`, `cost_centers` |
| Person identity | People & Identity | Person lifecycle | Access identity administration | `people`, contacts, relationships |
| User account/session | People & Identity | Account/session commands | authentication + account status | `user_accounts`, sessions, revocation records |
| Role/permission/scope grant | Access | Access lifecycle | privileged AccessDecision + SoD | `roles`, `permissions`, `position_assignments`, `scope_grants`, `delegations` |
| Applicant/application | CRM & Admissions | Applicant/application state graph | Admissions permission + object scope | `applicants`, `applications`, requirements, `admission_decisions` |
| Visitor/lead | CRM | Lead lifecycle | CRM permission + branch scope | `visitors`, interactions, follow-ups, campaigns |
| Student | Students | Student status/hold/branch-transfer commands | Student permission + current scope | `students`, `student_statuses`, holds, branch transfers |
| Guardian/household relation | Students/People | relationship lifecycle | student/privacy scope | relationship tables linked to Person |
| Placement content | Placement | version/publish/archive graph | curriculum/test-bank permission | test/version/section/question/rubric/media tables |
| Placement attempt/evidence | Placement | attempt/submit/score/review/release graph | Placement + student/object scope | attempts, responses, section results, recommendations |
| Eligibility snapshot | Placement creates; Academic consumes | snapshot supersession | Placement/Academic authorization | signed `academic_eligibility_snapshots` |
| Program/curriculum | Academic Planning | draft → review → published → retired | curriculum-author permission | programs, program versions, subjects, modules, levels, prerequisites |
| Academic term/calendar | Calendar | draft → active → closed | governance/calendar permission | calendar versions, academic periods, holidays |
| Room/availability/reservation | Scheduling & Facilities | availability/reservation lifecycle | facilities + branch scope | rooms, branch availability, reservations |
| Offering/class/section | Academic Delivery | detailed class lifecycle | Academic permission + scope | offerings, class sections/classes, capacity derivation |
| Enrollment/waitlist | Academic Delivery | one enrollment transition graph | enrollment permission + finance gate + object scope | enrollments, enrollment events, waitlist entries |
| Session/timetable | Academic Delivery/Scheduling | scheduled → open → completed/cancelled | teacher/academic scope | sessions, session reservations, provenance links |
| Attendance | Academic Delivery | session attendance correction/lock | teacher own-class or authorized override | attendance facts and correction history |
| Assessment/grade | Academic Delivery | draft → submitted → moderated → published → locked/corrected | teacher/academic + lock/SoD policy | assessments, attempts/results, grade history |
| Progression/graduation/certificate | Academic Delivery | review → approved → issued/revoked if policy permits | academic approval + SoD | progression decisions, graduation decisions, transcripts, credentials |
| Employment/position | Workforce & HR | employment/contract/leave lifecycle | HR + organization scope | employments, contracts/versions, statuses, positions, leaves |
| Teacher assignment/work fact | Workforce + Academic Delivery | assignment/teaching lifecycle | teacher/academic scope | teacher assignments, skills, teaching delivery facts |
| Payroll calculation/result | Payroll | period → calculated → reviewed → approved → cleared | Payroll + SoD | payroll periods/calculations/results/adjustments/clearances |
| Payroll liability | Finance | open → posted → settled/corrected | Finance + Payroll evidence | liability subledger and linked journal lines |
| Employment settlement | Finance | proposed → approved → recorded/corrected | Finance authority + SoD | `employment_settlements` only |
| Obligation/invoice | Finance | draft → issued → open/partial/settled/discharged/corrected | Finance + source gate | obligations, lines, invoices, source links |
| Payment | Finance | received → posted → allocated/refunded/corrected | Finance + payment permission | payments, journal postings, idempotency record |
| Allocation/credit/refund | Finance | proposed → approved → posted/reversed | Finance + SoD | allocations, credits, refunds, correction records |
| Chart/account/journal | Finance | account lifecycle; journal posted/reversed | Finance + period close | accounts, journals, journal lines, posting periods |
| Budget/expense | Finance | draft → approved → committed/posted/rejected | budget/expense SoD | budgets, budget lines, expense requests, commitments |
| Fund/restriction/release | Finance owns monetary dimension; Funding owns intent | restriction → active → released/expired/clawed back | Finance + Funding evidence + SoD | funds, restrictions, fund transactions, releases |
| Donor/grant/scholarship/sponsor intent | Funding & Impact | agreement/award lifecycle | Funding + privacy/document authorization | donors, campaigns, awards, agreements, restrictions metadata |
| Book stock/lending | Resources | catalog/receipt/issue/return/loss/adjustment | resource + student scope | books, copies/receipts/adjustments, issuances/returns |
| Asset custody | Resources | acquired → assigned → transferred/lost/retired | resource + branch scope | assets, custody, transfer/loss/disposal requests |
| Asset accounting value | Finance | capitalized → depreciated → disposed | Finance + asset evidence | asset accounting subledger + journal lines |
| Supplier/AP | Resources creates supplier/receipt; Finance owns payable/payment | supplier/invoice/payment lifecycle | procurement + Finance SoD | suppliers, supplier invoices, AP/payment subledger |
| Loan/principal/interest | Finance | proposed → issued → repayment/interest/closed | Finance + SoD | loans, repayment/interest subledgers, journals |
| Workflow instance/task | Work Management | definition/instance/task/approval lifecycle | command-time domain authorization | workflow definitions/instances/history/work items |
| Domain approval | Owning domain | domain-specific approval graph | domain permission + SoD | domain approval/proposal table; workflow links only |
| Document/version/retention | Documents | registered → submitted → verified → active → expired/archived | Access + document classification | documents, versions, verifications, retention decisions, object refs |
| Message/delivery/read state | Communication/Notifications | queued → sent/delivered/failed/read | recipient scope + Access | messages, attempts, notification/read projections |
| Audit event | Audit | append-only | audit writer; read permission | audit events, rejected/attempted operations |
| Domain/outbox event | Integrations & Operations records; source domain emits | pending → claimed → delivered/dead-letter | internal service authorization | `domain_events`/outbox, inbox/delivery records |
| Metric/report/projection | Reporting | definition/version/run/reconcile | report permission + scope | metric definitions/versions/projections/report runs |
| Search index | Search | build/update/delete/reindex | query-time Access filter | projection index only; rebuildable |
| Workspace composition | Workspace | freshness/assignment/personalization | Access decision on every command | rebuildable workspace projection/preferences; never source authority |

---

## 8. Student, admissions, and placement lifecycles

### 8.1 Admissions and student creation

```text
lead → contacted → qualified → applicant case → requirements pending
     → ready for decision → admitted / waitlisted / rejected / withdrawn
     → student registration command → active student
```

- CRM owns the lead and interaction history.
- Admissions owns applications, requirements, decisions, and admission workflow.
- Students owns the Student aggregate and initial student status creation. Admissions calls a Students registrar port after an approved admission; it does not insert `students` directly.
- A Person may have multiple applications and one student participation. Duplicate detection proposes candidates; only an authorized command resolves identity.
- Admission does not silently enroll or post money. Enrollment and Finance commands are explicit and idempotent.

### 8.2 Placement

```text
requested → scheduled → in_progress → submitted → scored
         → moderated → recommended → reviewed → approved → released
         ↘ appealed / superseded
```

Attempt evidence (questions, responses, media, scoring inputs, assessor identity, timestamps, version) is immutable after submission except through an explicit correction/appeal path. Recommendations are evidence-backed and versioned. Academic consumes a signed eligibility snapshot; placement does not assign a class or bypass an academic/financial gate.

### 8.3 Student lifecycle

```text
registered/active → inactive
active → suspended → active
active → graduated
active → withdrawn/closed (if policy enables it)
```

Student status is a historical lifecycle, not a convenient operational flag. Academic operational eligibility (hold, outstanding required gate, class/period terminal state) is evaluated separately. A student must not be made “inactive” merely to bypass an academic or financial hold.

### 8.4 Enrollment lifecycle

```text
requested → pending_gates → offered/waitlisted → active
active → frozen/paused → active
active → transferred/completed/withdrawn/cancelled
```

One Academic Enrollment command writes enrollment state, enrollment event/history, roster effect, and any required Finance request in one coherent transaction or an explicit outbox follow-up. The Finance gate verifies a canonical obligation/eligibility position; it does not create a second enrollment status. Waitlist ordering, seat capacity, term/program/version correlation, and branch scope are enforced at command and database boundaries.

---

## 9. Complete academic setup and delivery model

Academic setup is not just “programs and levels.” The final model is:

```text
Organization
 └── Campus / Branch
      ├── Academic calendar version
      │    ├── academic year / Jalali periods
      │    ├── terms and holidays
      │    └── active/closed windows
      ├── Facilities
      │    ├── rooms / capacity / type
      │    ├── time slots / weekdays
      │    └── availability / reservations
      ├── Curriculum
      │    ├── Program
      │    ├── Program Version (published immutable snapshot)
      │    ├── Subject / Module
      │    ├── Level / CEFR mapping
      │    ├── ordered version-level membership
      │    ├── prerequisites / progression rules
      │    ├── grading scale / attendance policy
      │    └── placement requirement/profile
      ├── Offering plan
      │    ├── term + branch + program version + level
      │    ├── fee policy reference/snapshot
      │    ├── target capacity and generation rules
      │    └── open/closed lifecycle
      └── Delivery
           ├── class sections and teacher assignments
           ├── room/time reservations
           ├── enrollment and waitlist
           ├── sessions and rosters
           ├── attendance and make-up rules
           ├── assessments/exams/gradebook
           ├── progression/completion
           └── transcript/certificate/diploma output
```

### 9.1 Setup ownership rules

- **Program/version/level/subject/module/prerequisite:** Academic Planning.
- **Term/holiday/calendar conversion:** Calendar.
- **Room/time slot/availability/reservation:** Scheduling & Facilities.
- **Fee schedules and financial policy:** Finance; Academic references a versioned fee policy and snapshots it at the financial command boundary.
- **Placement requirement:** Placement owns assessment profile; Academic validates the released eligibility snapshot.
- **Class/section/capacity/teacher assignment:** Academic Delivery, with Workforce validation for employment/skill eligibility.
- **Attendance/grades/progression/certificate:** Academic Delivery.

Published curriculum versions are immutable. A correction creates a new version or an explicit academic correction record; it does not rewrite historical enrollments and transcripts. Capacity is derived from linked sections and seat-consuming enrollment states, not maintained as a second editable total. Time and branch correlation are database-backed where possible and command-validated everywhere.

### 9.2 Academic financial boundary

Academic can request a tuition/fee quote and require an eligibility gate. Only Finance creates obligations, invoices, payments, discounts, credits, and allocations. Enrollment stores no monetary authority beyond a stable reference to the Finance obligation/quote snapshot. A transfer preserves the historical obligation and does not fabricate a new charge; a retake creates a new explicitly priced financial fact.

---

## 10. Employee, HR, payroll, and management architecture

### 10.1 Workforce lifecycle

```text
person → candidate/employee participation → employed
       → active assignment(s) → leave/suspended → active
       → terminated/settled
```

Workforce/HR owns contracts, contract versions, positions, organizational assignment, leave, skills, evaluations, and employment eligibility. Academic owns the teacher's actual teaching assignment and delivery facts. A person may hold several legitimate positions; Access resolves the effective capabilities and scope from all active assignments.

### 10.2 Payroll lifecycle and settlement

```text
period open → inputs collected → calculated → reviewed → approved
            → liability recognized by Finance → paid/cleared → period closed
```

- Payroll calculates from approved employment/teaching facts and produces a reproducible result with input references and policy version.
- Finance recognizes the liability, posts journals, controls cash, and records payment/settlement.
- `employment_settlements` in Finance is the only final settlement fact.
- Payroll's proposal and clearance are workflow evidence, not a second monetary ledger.
- Salary advances, deductions, bonuses, withholding, write-offs, and corrections must each have explicit policy, source linkage, period treatment, SoD, and compensating-entry semantics. No developer may invent rates or classifications from a UI requirement.

### 10.3 Employee Workspace

The Employee Workspace is the primary operational environment. It composes, at request time, from:

- current Person/account and employment status;
- all active positions and assignments;
- current organization/branch/department scope;
- effective permissions and delegations;
- assigned work items and domain proposals;
- deadlines, SLAs, approvals, blocked items, exceptions, and notifications;
- canonical links to student, academic, HR, Finance, document, and communication commands;
- freshness and provenance labels.

It is **work-first and exception-first**: “what needs attention, what is overdue, what is blocked, what changed, what can I do now, and which canonical command completes it?” A multi-position employee sees combined legitimate work without a static role lock. Every sensitive action is reauthorized against current state; a stale card cannot preserve authority after termination, scope removal, delegation expiry, or branch transfer.

Workspace may own presentation preferences and rebuildable aggregation rows. It may not own a task outcome, approval decision, financial balance, enrollment, grade, employment status, or permission.

### 10.4 Management Workspace

Management views are separate from employee queues and emphasize:

- trend and period comparison;
- enrollment, attendance, outcomes, retention, staffing, cash, receivables, restricted-fund exposure, budget, payroll, and risk;
- exceptions, unresolved approvals, policy breaches, and branch comparison within authorized scope;
- drill-through to the owning command or source evidence;
- as-of timestamp, freshness, formula/version, scope, and reconciliation status.

Management cannot bypass domain authorization because a metric is visible. Sensitive drill-through is individually authorized.

---

## 11. Donor, funding, scholarship, sponsorship, and restricted-fund decision

### 11.1 Decision

Funding is an **architecturally required bounded context and a Phase 2 operational capability**. The static evidence in A/B is coherent enough to justify donor, campaign, scholarship, sponsorship, and impact workflows, especially for NGO/scholarship-supported learners. It is not permitted to become a second monetary subsystem.

### 11.2 Ownership split

| Fact | Funding & Impact | Finance |
|---|---|---|
| Donor identity, contact, relationship | owns | reads |
| Campaign, program, grant agreement, narrative outcome | owns | references |
| Donor restriction/eligibility intent | owns the legal/business intent and evidence | enforces spendability in monetary posting |
| Donation receipt/cash/bank movement | requests/links | owns payment, journal, cash, and reconciliation |
| Fund/balance/restricted net position | reads and explains | owns fund subledger and journal |
| Scholarship eligibility/award | owns | receives an approved allocation command |
| Sponsorship agreement/seat commitment | owns | records sponsor receipt and obligation settlement |
| Tuition waiver/credit/obligation allocation | requests with award evidence | owns financial credit/allocation |
| Expense charged to a program/fund | supplies program linkage | posts and rejects restriction violations |
| Impact report | supplies approved outcomes/narrative | supplies reconciled financial facts; Reporting publishes |
| Clawback/release | proposes under agreement/policy | posts monetary reversal/release |

Campaign target amounts and award commitments are not bank balances. Actual cash, receivable, revenue classification, fund balance, obligation, payment, and release are Finance facts.

### 11.3 Fund model

A fund is a Finance dimension/subledger, not a separate bank account and not a Funding-owned ledger. Each restricted contribution stores structured restriction type, purpose/program target, time window, source agreement/document, and allowed dimensions. A restricted expense or scholarship allocation is accepted only when Finance can prove eligibility. Release/reclassification is an explicit source-linked fact with evidence. Restricted and unrestricted balances are reported separately even if physical cash is pooled.

No free-text “restricted” flag, campaign sum, scholarship total, or sponsorship total may be treated as financial truth. Every funding action has an idempotency key, branch/organization scope, document/evidence link, and audit event.

---

## 12. Finance, accounting, budgets, resources, and operational economics

### 12.1 Canonical finance model

Finance uses AFN as the launch currency. Amounts are stored as integer minor units through a currency value object; AFN is configured with the approved local scale. Non-AFN transactions are rejected until an explicit FX policy, rate source, valuation date, and gain/loss treatment are approved. No floating-point money is accepted.

The accounting core is:

```text
source fact (invoice/payment/payroll/AP/asset/fund/loan)
        ↓ source-linked Finance command
subledger position + journal entry
        ↓ posted period
accounts / journal lines / reconciliations
        ↓ read-only
P&L, balance, aging, fund exposure, budget, management projections
```

- `journals` and `journal_lines` are the accounting authority.
- Subledgers are the operational authority for their fact and must link to journal entries.
- Account balances are derived from posted journal lines or a rebuildable materialized projection; a mutable balance cache is never the only truth.
- Posted facts are immutable. Corrections reverse or compensate with a reason, actor, source ID, period, and audit trail.
- Period close prevents unapproved posting; a controlled reopening creates an auditable event.

### 12.2 Finance capabilities

**Receivables:** obligations, invoice purpose/line items, due dates, installments, discounts, credits, payment allocation, refunds, write-offs/discharges, aging, and student balances.

**Payables:** supplier, invoice, goods receipt, payment terms, due/overdue status, return/refund, payable aging, and settlement. A supplier receipt without a payable is not silently classified as an expense.

**Payroll liabilities:** Payroll result approval creates a Finance liability; payment reduces liability and cash; withholding creates a liability until remitted; settlement is Finance-owned.

**Budgets:** annual/period budget, branch/program/fund/cost-center dimensions, commitments, approved expense, available balance, transfers/returns, and budget variance. Budget is a control projection tied to journal/commitment facts, not a second cash store.

**Assets:** Resources owns physical asset identity, custody, transfers, loss, and condition. Finance owns capitalization, carrying value, depreciation, impairment policy when approved, and disposal proceeds/gain/loss through journal evidence.

**Books:** Resources owns catalog/copies/stock/issue/return/loss. Finance owns acquisition cost, sale revenue, refund, and inventory journal treatment. A book sale is not a generic payment with an inferred category.

**Loans:** Finance owns principal, lender, terms, repayments, interest facts, outstanding position, and journal classification. This capability remains disabled until policy supplies lender/rate/schedule semantics.

### 12.3 Financial invariants

At minimum, runtime validation must prove:

- journal debits equal credits per entry and period;
- cash/account derived position reconciles to posted journals and approved opening state;
- every payment/refund/allocation is idempotent and source-linked;
- no allocation exceeds an obligation, fund, payment, or award position;
- no restricted expense or scholarship allocation bypasses restriction eligibility;
- no closed period mutation bypasses correction/reopen policy;
- no payroll payment exceeds approved due/liability and settlement is not duplicated;
- asset disposal cannot produce cash or income without a custody/value fact;
- budget availability and commitments remain non-negative under concurrent commands;
- every report number identifies its metric, formula version, scope, period, and source projection.

---

## 13. Documents, communication, notifications, workflow, and approvals

### 13.1 Documents and records

Documents owns metadata, classification, versions, verification state, retention decisions, legal hold, and secure object references. Business contexts own whether a document is required and what decision it supports. The object store is private; access is granted through a short-lived authorized download/preview path. File MIME, size, malware, hash, version, uploader, and retention policy are recorded. A printed invoice, transcript, certificate, or payroll slip renders an authoritative source snapshot and never creates a new source fact.

### 13.2 Communication and notifications

Communication owns message templates, recipient resolution, queued message, delivery attempts, provider response, retry, and failure. Notifications are event-derived user/branch alerts with per-user read receipts. A notification is never a command authorization or a source of truth. Sensitive messages are minimized, redacted, and retention-controlled.

### 13.3 Work Management and workflow

Workflow definitions, instances, tasks, assignments, approvals, deadlines, escalation, and history are centralized in Work Management, but a domain-specific approval remains owned by its domain. For example, a Finance correction approval is a Finance fact; Workflow records the work and route around it.

Allowed workflow effects are explicit typed adapters:

```text
workflow trigger → authorize current actor → call registered domain command
                 → domain transaction commits → outbox event → projection/notification
```

No arbitrary PHP/JavaScript expression, direct table mutation, hidden financial transition, or undeclared webhook is allowed. Automatic actions start with internal notifications and safe work assignment; domain mutations require a registered command with its own authorization, idempotency, and audit behavior.

---

## 14. Security, privacy, audit, and separation of duties

### 14.1 Authorization

AccessDecision evaluates `(actor, action, resource, organization, branch, department, object ownership, employment/account lifecycle, delegation, time, SoD, purpose)` on every sensitive command and protected read. A user may have multiple positions; effective permission is the deterministic union/intersection policy declared by Access, with explicit denies and narrower-scope restrictions. A missing or unknown branch is denied. Cross-branch organization authority is explicit, not inferred from `null`.

Frontend `tabAccess` is a usability projection only. API routes, controller commands, queries, object storage, background jobs, and integrations all call the same policy service. Queries must scope at the database/query-builder boundary, not merely filter arrays after broad retrieval.

### 14.2 Separation of duties

Examples enforced by policy and validated at command time:

- admission decision, student registration, and financial receipt may be performed by different capabilities;
- teacher records attendance/grades but cannot approve their own grade override or payroll result;
- payroll prepares/calculates while Finance approves/post/settles;
- expense requester cannot be the sole approver where threshold policy requires separation;
- donor/funding operator can record intent but cannot release restricted cash without Finance authority;
- reconciliation observer cannot approve their own reconciliation;
- Access administrator cannot silently grant self-escalating organization-wide permission;
- audit readers cannot mutate audited records.

### 14.3 Privacy and threat controls

The platform requires password hashing, secure same-origin cookies or short-lived tokens as appropriate, CSRF protection, rate limiting, session revocation, secure headers, secrets outside source, structured redacted logs, input/schema validation, SQL parameterization, object-level authorization, signed document access, data export approval for bulk sensitive data, retention/legal hold, and audit of rejected attempts.

Threat matrices must include IDOR, branch/campus leakage, stale delegation, inactive employee access, replay/double post, direct SQL bypass, mass assignment, report export leakage, document URL leakage, search leakage, workflow privilege escalation, queue retry duplication, and cross-tenant/cross-organization access.

---

## 15. Reporting, analytics, search, and management control

### 15.1 Reporting

Reporting defines a versioned metric catalog. Each metric declares:

- stable ID and business definition;
- owner/source tables or projection;
- period/calendar semantics and timezone;
- unit, currency, precision, and null behavior;
- scope dimensions and required permission;
- formula version and reconciliation rule;
- freshness expectation and export policy.

A report run captures metric versions, filters, as-of timestamp, actor/scope, source snapshot/projection version, and output hash. Dashboard, CSV, print, workspace cards, and management views consume the same report/metric executor. Browser reducers never define enrollment, revenue, payroll, or financial truth.

### 15.2 Search

Search begins as a PostgreSQL-backed projection with normalized names, identifiers, phones, branch/object type, and access metadata. It is queried with a server-side access predicate and bounded result cap. Search results link to authorized source views; they do not reveal restricted fields simply because an index contains them. OpenSearch/Elasticsearch is a future read-scale option, not a second business database.

### 15.3 Management controls

The management workspace exposes finance and operating measures only through Reporting and Finance read contracts. It shows reconciliation status, stale projections, outbox backlog, failed deliveries, overdue receivables/payables, restricted-fund exposure, budget variance, payroll liability, academic outcomes, staffing, and unresolved work. It provides drill-through to evidence and source owners, not hidden direct writes.

---

## 16. System topology and technology decisions

```text
Browser / responsive React application
        │ same-origin HTTPS, typed JSON, accessibility/i18n shell
        ▼
Laravel API + web/print adapters
        │ authentication, rate limit, request validation, AccessDecision
        ▼
Application services / commands / queries
        │ module contracts; transaction boundary; idempotency
        ├── bounded domain modules
        ├── PostgreSQL repositories and constraints
        ├── transactional outbox + audit write
        └── projection/report query services
                  │ commit
                  ▼
PostgreSQL primary
        ├── canonical domain tables
        ├── journal/subledger tables
        ├── audit and outbox tables
        └── rebuildable projections/index tables
                  │ async relay
                  ▼
queue/relay → notifications, search, reporting projections, documents, integrations
```

### 16.1 Why modular monolith

A single deployable application keeps Finance, Academic, Student, Payroll, Access, and workflow commands transactionally consistent while the institution is small enough that service-network failure and distributed data ownership would be overengineering. Modules have strict dependency direction and contracts. If scale later proves a split necessary, the outbox/API contracts permit extraction without first allowing duplicate authorities.

### 16.2 Why React rather than Blade plus React fragments

A single React application provides consistent workspace composition, route-level permission projections, mobile/reception/teacher flows, shared form validation, RTL, accessible stateful controls, server-state caching, and API/web parity. Blade remains only for backend-rendered print/PDF output where it is a document renderer. A second interactive Blade frontend would duplicate navigation, authorization presentation, and validation.

### 16.3 Frontend decisions

- React + TypeScript + Vite.
- React Router for explicit route boundaries.
- TanStack Query or equivalent typed server-state cache; no business truth in global UI state.
- OpenAPI-derived TypeScript contracts or an equivalent generated contract package; no hand-maintained A/B/C response shapes.
- Shared design system with semantic HTML, keyboard operation, focus management, form errors, loading/empty/error/permission states, responsive tables, 44px practical touch targets, and WCAG 2.2 AA target.
- English and Persian/Dari translations with first-class RTL, locale-aware dates, and a single calendar formatting policy.
- Feature folders aligned to bounded contexts, not one monolithic `App.tsx` or server route file.

---

## 17. Data architecture and database ownership

### 17.1 PostgreSQL schema organization

Use one PostgreSQL database with schema ownership conventions and module prefixes only where helpful; do not create separate databases per module at launch. Every table has:

- UUID/opaque ID and created/updated metadata as appropriate;
- organization/branch provenance when the fact is scoped;
- actor/source/correlation/idempotency fields on commands;
- foreign keys and unique constraints for structural invariants;
- check constraints for enum/value bounds;
- explicit effective dates and lifecycle columns rather than overloaded booleans;
- append-only history or correction records for sensitive state;
- indexes designed for scope, lifecycle, period, and source lookups.

Canonical table groups include `foundation`, `identity_access`, `crm_admissions`, `students`, `placement`, `academic`, `scheduling`, `workforce`, `payroll`, `finance`, `funding`, `resources`, `workflow`, `documents`, `communication`, `reporting`, `audit`, `outbox`, and `operations`. These are ownership conventions, not permission bypasses.

### 17.2 No duplicate representations

- `students.status` is not duplicated in Admissions or CRM; their views project student status.
- `enrollments` do not own payment totals; Finance obligations do.
- Payroll results do not own cash or final settlements.
- Funding totals do not replace Finance funds/journals.
- Dashboard balances, report projections, search rows, and workspace cards are rebuildable.
- `financial_transactions` as a generic catch-all is not the final accounting authority. Legacy rows are mapped to typed source facts and journals during migration.
- Historical migration names may remain in Git history, but obsolete final-schema tables are removed from the target baseline.

### 17.3 Concurrency

PostgreSQL transactions use appropriate row locks and unique/idempotency constraints for payment allocation, enrollment seats, waitlist offers, budget movement, payroll approval, fund allocation, corrections, and workflow actions. Projection consumers use inbox/deduplication records. Long reports use consistent snapshot/as-of semantics or a versioned projection, never an unbounded live join that silently mixes periods.

---

## 18. API, command, query, event, and frontend contract

### 18.1 API shape

The final API is `/api/v1` with resource reads and command endpoints. Examples:

```text
GET  /api/v1/me
GET  /api/v1/students/{id}
POST /api/v1/admissions/applications/{id}/approve
POST /api/v1/students/{id}/register
POST /api/v1/enrollments/{id}/freeze
POST /api/v1/finance/payments
POST /api/v1/finance/payments/{id}/refund-proposals
POST /api/v1/finance/settlements/{proposalId}/approve
POST /api/v1/payroll/calculations/{id}/approve
POST /api/v1/academic/placement-attempts/{id}/submit
POST /api/v1/work-items/{id}/complete
GET  /api/v1/reports/catalog
POST /api/v1/reports/runs
GET  /api/v1/search?q=...
```

Every mutation accepts a client idempotency key where replay is possible and returns a stable command/result envelope containing correlation ID, source ID, lifecycle outcome, and relevant projection freshness. Errors have stable code, message, field errors, authorization outcome, and retryability.

### 18.2 Transport rules

Controllers/FormRequests handle syntax, authentication context, request limits, and response serialization. Application commands perform authorization, lifecycle, business rules, transaction, source write, audit, and outbox recording. Queries return DTOs from canonical sources or named projections. Console/web/API/queue handlers invoke the same command/query layer.

No frontend endpoint may directly expose a table or let the browser calculate permissions, balances, academic eligibility, finance categories, or lifecycle transitions. Every response declares scope and, where applicable, as-of/freshness metadata.

### 18.3 Compatibility

A/B route names are not preserved as authority. A temporary compatibility adapter may translate a legacy client to `/api/v1` only if it calls the same command and carries no duplicate write. Legacy aliases are removed after the React cutover and contract tests prove no consumers remain.

---

## 19. Dependency and data graph

### 19.1 Dependency direction

```text
Organization / People / Calendar
          ↓
Access ───────────────┐
          ↓           │ authorization only
CRM → Admissions → Placement
  │          │          ↓ eligibility evidence
  └──────────┴────→ Students
                         ↓
Academic Planning → Scheduling → Academic Delivery
       │                 │              │
       └──────────────→ Finance gate ←──┘

People → Workforce → Payroll → Finance
Students / Academic / Resources / Funding ───────→ Finance
All contexts ─────────→ Documents / Communication / Work Management
All canonical facts ──→ Outbox → Reporting / Search / Notifications / Integrations
Reporting / Finance / Work Management ───────────→ Employee & Management Workspace
```

### 19.2 Typed edges

- `OWNS`: domain writes canonical fact.
- `COMMANDS`: one context requests a state transition in another through a typed application port.
- `VALIDATES`: a context checks an invariant without writing the other context.
- `REFERENCES`: stable source ID/link only.
- `CONSUMES_EVENT`: asynchronous projection/notification/integration reaction.
- `PROJECTS`: rebuildable read model.
- `DOCUMENTS`: renders evidence from a source fact.
- `ASSIGNS`: Work Management routes human work; it does not decide domain truth.

A dependency may not point from Reporting, Search, Workspace, Notification, or UI back into a source table to mutate it.

---

## 20. Event, outbox, automation, and integration graph

```text
Domain command
  ├─ transaction: canonical source fact
  ├─ transaction: audit event
  └─ transaction: outbox event {id, type, version, aggregate, actor, scope,
                                  correlation, causation, occurred_at, payload}
                         │ commit
                         ▼
                outbox relay / claim lease
                         │ at-least-once
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
Reporting projection  Search index    Notification/work item
       │                 │                  │
       └───────┬─────────┴──────────┬───────┘
               ▼                    ▼
          management UI        external integrations
```

### 20.1 Event rules

- Domain events describe committed facts, not requests that might fail.
- Event schemas are versioned and contain tenant/organization/branch scope, aggregate ID, actor, correlation/causation, and idempotency identity.
- The outbox row is written in the same transaction as the source fact.
- Relay claims are leased; retries back off; dead letters are visible; poison events do not block unrelated events.
- Consumers use an inbox/processed-event key and idempotent upserts.
- Per-aggregate order is preserved where state transitions require it; global ordering is not assumed.
- Audit events and outbox events are different: audit answers “who attempted/changed what,” outbox answers “what committed and needs delivery.”
- Workflow automations consume only registered event types and call allowlisted commands. No handler may write Finance/Academic/HR tables directly.

### 20.2 Representative event vocabulary

`BranchActivated`, `ApplicantAdmitted`, `StudentRegistered`, `PlacementReleased`, `ProgramVersionPublished`, `EnrollmentActivated`, `SessionCompleted`, `AttendanceRecorded`, `GradePublished`, `GraduationApproved`, `PayrollResultApproved`, `FinanceLiabilityRecognized`, `PaymentPosted`, `RefundPosted`, `FundRestrictionCreated`, `RestrictedAllocationPosted`, `AssetTransferred`, `DocumentVerified`, `WorkflowTaskAssigned`, `ReportProjectionRebuilt`.

---

## 21. Finance and end-to-end business graphs

### 21.1 Student money path

```text
Academic fee policy snapshot
       ↓
Enrollment command requests Finance obligation
       ↓
Finance obligation + invoice (purpose and source enrollment)
       ↓
Payment received → journal cash/AR → allocation to obligation
       ├─ scholarship/sponsorship allocation (approved Funding evidence)
       ├─ installment position
       ├─ refund/credit/correction
       └─ discharge/write-off under Finance policy
       ↓
student balance / aging / academic gate / reports
```

The academic screen can display the Finance position, but it cannot subtract a payment from a local total.

### 21.2 Workforce money path

```text
Employment/teaching facts
       ↓
Payroll calculation + review + approval
       ↓
Finance liability recognition + journal
       ↓
payment / withholding remittance / correction / employment settlement
       ↓
ledger, cash, payroll reports, management projections
```

### 21.3 Funding money path

```text
Donor/grant agreement + restriction evidence
       ↓ Funding intent
Donation receipt / grant receivable command
       ↓ Finance payment/journal → restricted fund dimension
       ↓ eligible program/student expense or scholarship allocation
       ↓ explicit release/reclassification/clawback + impact evidence
```

No Funding total may update cash. No Finance expense may ignore a structured restriction. No impact report may claim outcomes from an unapproved or unreconciled source.

### 21.4 Resource money path

```text
Supplier / book receipt / asset acquisition
       ↓ Resources physical fact
Finance payable/capitalization/inventory journal
       ↓ payment / return / sale / depreciation / disposal
       ↓ reconciled resource and accounting projections
```

---

## 22. Migration, schema consolidation, and data cutover strategy

### 22.1 Pre-production baseline

The target is a clean, consolidated PostgreSQL schema after the architecture stabilizes. Do not preserve obsolete migration history as a runtime design merely because it is historically present. The current C chain is evidence and migration input, not the final schema.

Sequence:

1. freeze the authority matrix and target table catalog;
2. classify every current C migration/table as **retain**, **reshape**, **merge**, **project**, **archive**, or **drop**;
3. create a new target baseline migration set grouped by bounded context with explicit foreign keys, check constraints, indexes, outbox/audit/idempotency tables, and journal/subledger rules;
4. remove obsolete authorities, including retired Payroll settlement tables/models and any duplicate compensation/work-base/final-settlement authority;
5. define deterministic seed data only for roles, permissions, calendar defaults, accounting chart templates, and policies whose ownership is approved;
6. run static schema lint and migration preflight before any runtime application;
7. build import mappings for A/B/C source data only after each source field has an owner and reconciliation rule;
8. cut frontend/API contracts to `/api/v1` after source mappings are stable.

### 22.2 Migration classes

- **Foundation:** organizations, campuses, branches, departments, people, accounts, access.
- **Academic:** programs/version/levels, calendar, rooms, offerings, classes, enrollment, attendance, assessments, progression.
- **Economic:** accounts, periods, chart, obligations, payments, journals, funds, budgets, payroll liabilities, assets/AP/loans.
- **Evidence/platform:** documents, audit, outbox, idempotency, workflow, reporting metadata, search projection.

Each migration must be forward-compatible and safe to rerun only where the operation is declared idempotent. Business seeders cannot invent money, students, employees, roles, or approvals.

### 22.3 Clean versus historical cutover

The static source register currently gives no production-data preservation guarantee. If the owner confirms a clean pre-production environment, the target baseline may be destructive and faster. If any historical data exists, cutover requires a read-only source snapshot, row counts, duplicate identity report, branch-scope report, financial trial balance, obligation/payment allocation reconciliation, payroll liability reconciliation, document hash inventory, and signed acceptance before dropping anything.

No migration may silently convert a loan to capital, a restricted donation to unrestricted revenue, a Payroll settlement to a second Finance settlement, or a report projection to source truth.

### 22.4 Backup and recovery

Before each migration rehearsal: PostgreSQL backup, checksum, restore into an isolated database, migration apply, constraint/FK validation, journal trial balance, projection rebuild, search rebuild, outbox replay, and report reconciliation. Runtime restore and disaster-recovery evidence is a release gate, not a documentation claim.

---

## 23. Missing-capability analysis and explicit non-goals

### 23.1 Capabilities missing or materially incomplete in C

The current C checkout does not statically demonstrate a complete final implementation of: A's full placement test bank and scoring breadth; generic Work Management/workflows; Search; per-user Notifications; Employee Workspace; Management Workspace; full donor/restriction/scholarship/sponsorship; books sale/lending parity; supplier/AP; loans/interest; fixed-asset accounting; bank reconciliation; advanced operational report catalog; complete event consumer chain; React frontend; and a fully proven transactional outbox delivery path.

These are implementation gaps against the final architecture, not reasons to copy A's route/table structures wholesale.

### 23.2 Capabilities intentionally postponed

- multi-currency/FX;
- full LMS and digital content delivery;
- hostel/transport/canteen/alumni unless business discovery proves demand;
- biometric or face-recognition attendance;
- arbitrary third-party workflow scripting;
- public donor portal;
- data warehouse/event lake;
- microservice extraction;
- advanced procurement purchase-order commitments until supplier/payment policy is approved.

### 23.3 Policy gates that must not be invented

Before enabling affected commands, the owner must define: cash variance/counting, withholding rate/tax treatment, FX, loan rate/schedule, supplier terms and payable recognition, asset depreciation/impairment, disposal policy, restricted-fund release, write-off thresholds/recovery, data retention/legal hold, and donor gift acceptance. A missing policy is a controlled “not enabled” state, not an invitation to default to `other` income/expense.

---

## 24. Independent research findings and adopted patterns

The source reconstruction was supplemented by independent reference research. The findings are architectural inputs, not legal or accounting advice.

1. **Education ERP/SIS patterns:** mature education platforms converge on an integrated student lifecycle from inquiry/admission through enrollment, attendance, assessment, transcript/graduation, fee management, portals, HR/payroll, communication, and reporting. They also distinguish these operational areas rather than making one student table own every fact. This supports the Academic/Admissions/Students/Finance/Workforce split. Useful comparative references include [OpenEduCat's education ERP capability overview](https://openeducat.org/education-erp/) and its [module overview](https://openeducat.org/open-source-education-erp/).
2. **Transactional outbox:** AWS Prescriptive Guidance describes saving business state and the outbox notification in one local transaction, then relaying committed events; duplicate delivery and ordering require idempotent consumers and explicit sequence handling. The final design adopts exactly that reliability model, rather than claiming exactly-once delivery. See [AWS Transactional Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).
3. **Zero-trust authorization:** NIST SP 800-207 rejects implicit trust based on network location or account ownership and requires authorization decisions around the subject, device/resource, and request context. This supports command-time AccessDecision, object/scope checks, deny-by-default unknown scope, and no frontend security. See [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final).
4. **Restricted resources:** Donor restrictions must remain distinguishable from unrestricted resources, carry source documentation, constrain eligible spend, and support release/reclassification reporting. Campaign totals or a free-text restriction field are not sufficient. The final architecture therefore makes restrictions structured Finance dimensions with Funding evidence and explicit release. Comparative guidance: [PwC donor-imposed restrictions](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/not-for-profit-entities/Not-for-profit-entities/Nfp06_1/67_Donorimposed_restrictions_14.html) and [IRS Schedule D guidance](https://www.irs.gov/instructions/i990sd).
5. **Accessibility:** WCAG 2.2 adds or emphasizes focus visibility, keyboard/touch operation, consistent help, redundant-entry reduction, and accessible authentication. The React design system targets WCAG 2.2 AA, with keyboard, focus, mobile, RTL, form-error, and accessible-authentication acceptance tests. See [W3C WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/).
6. **ERP/finance control pattern:** mature systems keep operational subledgers close to their source processes while centralizing accounting posting and reporting. This supports Resources owning physical custody, Funding owning intent, Payroll owning calculation, and Finance owning journal/liability/settlement truth.
7. **Research limitation:** these sources benchmark patterns; they do not prove local Afghan legal, tax, donor, employment, currency, or education policy. Local policy gates remain explicit prerequisites.

---

## 25. Rejected alternatives

| Alternative | Rejection reason |
|---|---|
| Keep System A unchanged | SQLite and route-level SQL are not a sufficient final multi-worker financial/authorization platform; large route files encourage hidden writers; its feature breadth does not remove deployment and ownership problems |
| Keep System B unchanged | It is an older packaged subset of A, with materially less academic placement, finance, resource, correction, and accounting depth |
| Keep System C unchanged | C has strong architecture but is incomplete in product capability and uses Blade/uneven transport against the final product requirement |
| Merge all three schemas and routes | Produces duplicate identities, roles, finance balances, lifecycle tables, route semantics, and migration hazards; breadth is not architecture |
| Treat B as an independent product to preserve | Static inspection shows B is an earlier sibling/package in the A lineage, not a separately justified authority |
| Microservices now | Adds network, distributed transaction, deployment, and observability complexity before organizational scale requires it; modular boundaries are sufficient and extractable later |
| Keep SQLite for simplicity | File-level backup/WAL is not the required PostgreSQL concurrency, row-locking, constraint, restore, and reporting posture |
| Use Blade plus React pages as a permanent hybrid | Duplicates navigation, state, accessibility, validation, and permission presentation; only print/PDF rendering remains backend-side |
| Let Funding own donation balances | Creates a second monetary authority and makes restrictions/receipts diverge from Finance |
| Let Payroll own final settlement | Creates a second cash/liability authority and was already identified as an unsafe compatibility path |
| Let Academic own tuition totals | Academic facts and financial facts have different lifecycles; local totals drift and bypass Finance corrections |
| Let Workflow mutate domain tables generically | Generic mutation cannot safely encode domain invariants, SoD, accounting, or lifecycle semantics |
| Let dashboard/workspace/search projections become convenient writers | Projections are stale/rebuildable and must not become shadow authorities |
| Use static roles or browser tab hiding as authorization | Fails with multiple positions, scope, delegation expiry, direct API calls, and stale UI state |
| Preserve every migration for historical purity | Pre-production redesign allows clean baseline consolidation; obsolete runtime authorities must be removed |
| Implement every ERP feature immediately | Transport, policy, and authority quality would be sacrificed to feature count; phase capability by value and proof |

---

## 26. Implementation sequence and release waves

### Wave 0 — Architecture and contract freeze

- ratify this blueprint and the authority matrix;
- freeze bounded contexts, naming, lifecycle graphs, event envelope, API error/idempotency contract, money/currency policy, and policy gates;
- create the target table/command/query/event registries;
- identify any actual data that contradicts the clean-baseline assumption.

### Wave 1 — Platform foundation

- PostgreSQL baseline, organization, People/Identity, AccessDecision, Calendar, Governance;
- audit, idempotency, transactional outbox, correlation, error contract;
- document storage boundary, secret/session/security baseline;
- React shell, design system, locale/RTL, auth/session, typed API client.

### Wave 2 — Student acquisition and identity

- CRM visitors/sources/campaigns/follow-ups;
- Admissions applications/requirements/decisions;
- Students/person links/guardians/status/holds/branch transfer;
- Documents and communication primitives;
- reception and student profile workspaces.

### Wave 3 — Academic setup and delivery

- calendar/terms/holidays, programs/versions/levels/modules/prerequisites;
- placement minimum and signed eligibility snapshot;
- rooms/availability/time slots/scheduling;
- offerings/classes/capacity/teacher assignments/enrollment/waitlist;
- sessions/attendance, assessment/gradebook/grade lock;
- progression, transcripts, graduation, certificates;
- academic and teacher workspaces.

### Wave 4 — Finance core and payroll

- chart of accounts, posting periods, journals/lines, opening/reconciliation;
- obligations/invoices/payments/allocations/refunds/discounts/installments;
- budgets/expenses/commitments and financial approvals;
- Workforce/HR employment and Payroll calculation;
- Finance payroll liability, cash payment, settlement, correction;
- student and finance workspaces with reconciled reports.

### Wave 5 — Resources and funding

- books catalog/stock/issue/return/sale with Finance integration;
- physical assets/custody and Finance asset accounting;
- donor/fund/restriction/award/scholarship/sponsorship/impact;
- supplier/AP/returns/terms;
- enable loan/interest and withholding only after policy gates.

### Wave 6 — Work, insight, and operational scale

- Work Management definitions/instances/tasks/SLAs/escalations;
- notifications/read state, Search, report catalog/projections/reconciliation;
- Employee Workspace and Management Workspace composition;
- API/web/console parity, exports/prints, advanced management controls;
- backup/restore, readiness, monitoring, runbooks, retention, incident operations.

### Wave 7 — Migration and independent assurance

- source data mapping and reconciliation;
- clean or expand/contract cutover rehearsal;
- runtime test matrix, accessibility/security/financial review;
- performance/load, backup restore, outbox crash/retry, browser usability;
- owner acceptance and production-readiness decision.

Every wave must finish with authority review, migration/schema review, API contract review, threat review, projection reconciliation, and a documented rollback/disable path. “Screen exists” is not completion.

---

## 27. Runtime-only validation plan

Runtime work is intentionally deferred. When dependencies and an approved environment are available, execute the following in a controlled validation phase; do not report static completion as runtime success.

### 27.1 Foundation and migration

- clean PostgreSQL migration apply and seed idempotency;
- migration upgrade from a representative C snapshot and mapped A/B fixtures;
- rollback/restore rehearsal and backup checksum verification;
- foreign-key, check, unique, trigger, index, and partition verification;
- migration preflight rejection for duplicate identities, orphan rows, unknown branches, invalid money, unbalanced journals, duplicate settlements, and unsupported policy facts.

### 27.2 Domain and lifecycle

- admissions → student registration → placement → academic eligibility → enrollment → class/session/attendance → assessment/grade → progression/graduation end-to-end;
- exact invalid transition matrix for every aggregate;
- terminal guards, hold/transfer/freeze/waitlist/capacity races;
- grade lock, correction, appeal, transcript/certificate immutability;
- workforce/leave/teaching assignment/payroll calculation/liability/payment/settlement;
- scholarship/sponsorship/restriction/eligible allocation/release/clawback;
- book, asset, supplier, loan, interest, and disposal paths where enabled.

### 27.3 Security and privacy

- login rate limit, session revocation, inactive employee, expiry/delegation, MFA policy;
- branch/campus/department/object IDOR matrix across API, web, console, jobs, exports, documents, search, reports, and workspace;
- multi-position capability composition and SoD attacks;
- direct SQL bypass and mass assignment attempts;
- document signed URL, retention, export approval, consent/revocation, redacted logging;
- workflow privilege escalation and stale workspace command reauthorization.

### 27.4 Finance and concurrency

- debit/credit balance and period close;
- payment/refund/allocation idempotency under replay and concurrent requests;
- budget movement and restricted fund overspend races;
- payroll double-pay/settlement races and correction/reversal;
- AP terms/returns, asset depreciation/disposal, loan principal/interest if enabled;
- trial balance, cash position, AR/AP/payroll/fund/asset subledger reconciliation;
- report/dashboard/workspace equality against source queries and projection rebuild.

### 27.5 Events and operations

- crash between source commit and relay; prove committed facts produce an outbox row and failed transaction produces none;
- relay retry, duplicate delivery, ordering, poison/dead-letter recovery, inbox deduplication;
- notification/read isolation, search projection rebuild, report projection rebuild;
- queue backlog, readiness dependency failure, backup age, restore drill, log/metric/trace correlation;
- external integration timeout/signature/replay/credential rotation behavior.

### 27.6 Frontend and usability

- React build/typecheck and API generated-contract alignment;
- route navigation, deep links, empty/loading/error/permission/freshness states;
- keyboard-only, focus visibility, screen reader semantics, contrast, accessible authentication, touch targets, RTL and Persian/Dari layout;
- mobile/reception/teacher/finance/HR/management/student workflows;
- employee-efficiency study: task completion time, error rate, context switching, unresolved exception rate, and user comprehension of scope/freshness;
- browser print/PDF and secure document access.

### 27.7 Independent review gates

Runtime validation must include independent security review, independent financial/control review, migration/recovery review, accessibility review, and representative employee/student acceptance. Production readiness is blocked until all critical and high findings have dispositions and evidence.

---

## 28. Final self-critique, risks, and growth assessment

### 28.1 Capabilities deliberately not carried forward

The final architecture does not preserve every convenience in A/B: single-file SQLite assumptions, direct route SQL, static role dashboards, generic residual income/expense categories, loosely modeled success stories, `saving_accounts` as an independent balance, legacy IDs/aliases, arbitrary automation actions, or broad UI claims unsupported by an owner contract. Some source features will look smaller initially because they are now constrained by Finance, Access, and lifecycle authority.

### 28.2 Ambiguous boundaries that still need disciplined implementation

- Funding versus Finance: Funding intent/award/restriction evidence versus Finance money must remain explicit.
- Resources versus Finance: physical stock/custody versus valuation/journal must not drift.
- Academic Planning versus Delivery versus Scheduling: catalog, operation, and physical reservation are distinct.
- Workflow versus domain approvals: generic work routing must not become approval truth.
- Reporting versus Management Workspace: a composed decision surface must retain metric/source/freshness identity.
- Person, Student, Applicant, Employee, and User Account: one person can participate in many contexts without one context owning all identity facts.

### 28.3 Underserved users and risks

Reception staff need fast low-error capture, cash receipt context, duplicate warnings, and daily work queues. Teachers need mobile attendance and grade entry without exposing finance/HR. Finance needs reconciled subledgers, not colorful totals. HR needs effective-dated employment/leave/settlement context. Donor managers need restriction evidence and impact traceability. Students need accessible self-service and clear holds without revealing internal notes. Management needs exception-oriented decisions, not merely KPIs. The blueprint addresses these, but only runtime usability work can prove them.

### 28.4 Accounting, audit, security, and database risks

The strongest remaining risks are policy incompleteness, migration mapping errors, unbalanced legacy finance, reporting projection drift, row-lock contention, object-store authorization, outbox poison messages, overbroad organization-scope grants, and developer pressure to use a residual category when a fact lacks a policy. The final architecture reduces these risks with explicit gates but does not remove the need for review and operations.

### 28.5 5× and 10× growth

At 5×, a modular PostgreSQL monolith with indexed branch/period/source queries, queue projections, and a React client is appropriate. At 10×, audit/outbox/message tables and report workloads may require partitioning, read replicas, a dedicated search engine, a reporting warehouse, queue sharding, and extraction of the heaviest bounded context. Those are deployment evolutions, not reasons to pre-split ownership into microservices now. The event envelope and API boundaries preserve that option.

### 28.6 Overengineering check

The design is intentionally more rigorous than A/B in Finance, Access, outbox, migration, and Workspace because those are high-consequence facts. It avoids premature microservices, arbitrary workflow languages, broad LMS/transport/hostel scope, and multi-currency complexity. A feature is postponed when its business policy, owner, or operational value is not proven. The main overengineering risk is a too-large initial academic/report catalog; wave sequencing and feature flags must keep the first release operationally focused.

### 28.7 Decisions postponed, not hidden

FX, tax/withholding rates, depreciation/impairment, loan policy, donor gift acceptance, cash counting, write-off thresholds, supplier terms, legal retention, and advanced external integrations remain explicit policy gates. The architecture does not pretend they are resolved.

---

## 29. Exact final architecture verdict

The three inspected systems are evidence, not authorities. System A supplies breadth and several strong operational/financial patterns. System B is an older packaged sibling of A and is useful for lineage and product intent, not for independent schema preservation. System C supplies the strongest starting point for PostgreSQL, modular commands, authority boundaries, lifecycle controls, privacy, audit, and corrections, but it is incomplete and not conforming to the full target.

TOEFL House should therefore build one React/TypeScript frontend over one Laravel modular monolith backed by PostgreSQL, with explicit bounded contexts, one authority per fact, Finance as the sole monetary owner, Academic as the owner of learning delivery, Payroll as calculator/proposer rather than settlement authority, Funding as restricted-intent/award/impact owner without a second ledger, Access as command-time authorization, Work Management and Workspace as non-authoritative orchestration, Reporting/Search/Notifications as rebuildable projections, Documents as secured evidence, and a transactional outbox for reliable integration.

This blueprint is the final target. It is not a production-readiness declaration. Production readiness begins only after the runtime-only validation plan, migration/recovery evidence, independent review, and policy gates pass.

**THIS IS THE FINAL ARCHITECTURE TOEFL HOUSE SHOULD BUILD.**
