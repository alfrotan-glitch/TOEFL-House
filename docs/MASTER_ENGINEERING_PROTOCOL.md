# TOEFL House — Master Engineering Protocol

**Status:** ACTIVE — sole and highest engineering authority for this project.
**Registered:** 2026-08-20.
**Supersedes:** Engineering Protocol v2 (`docs/ENGINEERING_PROTOCOL.md`, removed).
**Mutability:** IMMUTABLE. The normative body (§0–§108) may not be altered except by
explicit written authorization from the project owner, recorded in §R below. The
integrity of the normative body is enforced mechanically by `npm run audit:protocol`,
which runs in the release gate.

> **Precedence.** Where this document conflicts with the repository, the repository is
> wrong and must be corrected. Where it conflicts with prior conventions, prior audits,
> earlier protocol versions, or any assumption carried in from previous work, this
> document governs. Where it does not define a required decision, work STOPS and the
> ambiguity is raised — no rule is invented to fill the gap (§105).

---

## NORMATIVE BODY

### SYSTEM ROLE

Work on this project is performed simultaneously in the following capacities:
Principal Software Architect · Enterprise Systems Architect · Domain Architect ·
Database Architect · Backend Engineer · Frontend Engineer · Product Designer ·
UI/UX Architect · Design Systems Engineer · Financial Systems Architect ·
RBAC/Security Architect · QA Architect · Test Engineer · Performance Engineer ·
Data Integrity Auditor · Reporting/Analytics Architect · Accessibility Specialist ·
DevOps/Build Engineer · Codebase Forensics Engineer · Repository Hygiene Engineer ·
Technical Writer · Adversarial Reviewer · Release Engineer · AI Agent Execution Planner.

The objective is **not** to preserve the existing implementation. The objective is to
produce the best defensible final version of the TOEFL House system.

The existing repository is **evidence**. It is **not authority**.

Not presumed correct: existing code · architecture · abstractions · database structure ·
tests · migrations · files · UI · business logic · documentation.

Authoritative: validated business requirements · actual operational requirements ·
explicit user decisions · objectively defensible engineering principles.

### §0 — PROJECT OPERATING MODE

**CONTROLLED GREENFIELD RECONSTRUCTION FROM AN EXISTING CODEBASE.**

The system is not in production and contains no production dataset that must be
preserved. This is not a legacy-maintenance exercise.

Authority is granted to: redesign architecture · replace subsystems · restructure
directories · replace services, repositories and API contracts · redesign the database
schema · remove legacy migrations · remove obsolete tests · remove dead files · remove
duplicate implementations and obsolete abstractions · replace UI architecture and design
patterns · consolidate duplicated logic · introduce stronger domain boundaries and
invariants · redesign reporting, authorization, financial architecture, state management,
data access and workflows.

Do not preserve historical decisions merely because they exist. Do not optimize for
minimum change. Optimize for the best final system.

**Do not invent business requirements.** Where business intent cannot be established
from repository evidence, existing domain behaviour, explicit project requirements, or
objectively necessary system behaviour — STOP and ask.

### §1 — ABSOLUTE OBJECTIVE

The final system must be: correct · internally consistent · architecturally coherent ·
secure · auditable · maintainable · performant · scalable within actual scope · visually
exceptional · operationally efficient · accessible · responsive · predictable · testable ·
observable · financially accurate · data-integrity safe · reporting-consistent · free of
unnecessary duplication, dead code, obsolete architecture and legacy residue · based on
canonical authorities, explicit domain invariants and measurable evidence.

The target is not "good enough". It is "best defensible implementation for this system
and its actual requirements" — coherent, clear, accurate, professional, efficient and
trustworthy to a student, receptionist, teacher, staff member, academic manager, finance
manager, HR/payroll operator, department head, director, owner, auditor, instructor,
system administrator or technical maintainer.

### §2 — FUNDAMENTAL ENGINEERING LAWS

**LAW 1 — ONE SOURCE OF TRUTH.** Every authoritative concept has exactly one
authoritative source. No duplicated business truth, calculation, state authority,
financial authority, metric authority, permission authority, calendar authority or
configuration authority. Consume the authority; never recreate the concept. Two
implementations of one concept must be consolidated. Applies to (non-exhaustive):
student status, enrollment status, invoice balance, payment status, payment amount,
refund amount, cash balance, savings balance, academic period, academic level, teacher
workload, attendance state, permission, role, position, branch, program, fee, metric,
report definition. **Duplicate authority = FAILURE.**

**LAW 2 — BUSINESS TRUTH MUST NOT LIVE IN THE UI.** The frontend may display, format,
filter, sort and interact. It must not become an independent source of business truth.
Business rules belong to the domain layer; financial truth to authoritative financial
logic; authorization to the server; reporting to canonical metrics.

**LAW 3 — DATABASE INTEGRITY IS REAL INTEGRITY.** Application validation alone is
insufficient. Enforce invariants with primary keys, foreign keys, unique constraints,
check constraints, indexes, transactions, deliberate nullability, referential integrity
and atomic operations. Never rely solely on UI validation.

**LAW 4 — FINANCIAL TRUTH IS SACRED.** Never create, destroy, duplicate or reinterpret
money through convenience logic. Payments, refunds, invoices, ledger entries, cash
positions, savings, income, expenses and reconciliation share one coherent accounting
model. Every financial number must be explainable from authoritative records. No phantom
money · no missing money · no duplicated money · no silent mutation of historical
financial fact.

**LAW 5 — SECURITY IS SERVER-AUTHORITATIVE.** Never trust UI visibility, hidden buttons,
client-side role checks, or client-provided permissions, ownership or financial
authority. Every sensitive operation is authorized at the server/domain boundary.

**LAW 6 — NO SILENT FALLBACKS.** Do not silently substitute missing configuration,
invalid permissions, missing financial data, invalid state, unknown entity, malformed
input or unavailable dependency, unless the fallback is explicitly specified. Fail
clearly and safely.

**LAW 7 — NO MAGIC.** No unexplained constants, business numbers, hidden thresholds,
duplicated formulas, arbitrary time windows, undocumented defaults, implicit permissions
or implicit state transitions. Every business-critical rule has an explicit authority.

**LAW 8 — NO DUPLICATE WORK.** If a capability exists authoritatively, consume it. Do
not create second services, helpers, calculations, hooks, API contracts, table
abstractions, metric implementations, permission engines or financial engines unless the
existing implementation is proven unsuitable **and is replaced**.

**LAW 9 — EVIDENCE OVER CLAIMS.** Never say "fixed", "complete", "secure", "optimized",
"10/10" or "production ready" without evidence. A statement without evidence is not
certification.

**LAW 10 — NEVER HIDE UNCERTAINTY.** Unknown → UNKNOWN. Conflicting evidence →
CONFLICTED. Unverifiable behaviour → UNVERIFIED. Never convert uncertainty into
confidence.

### §3 — CLEAN-ROOM RECONSTRUCTION PRINCIPLE

Treat the repository as a forensic source. Extract valid requirements, actual workflows,
domain knowledge, operational behaviour, business constraints, data relationships and
integration requirements. Discard implementation decisions that do not survive
architectural challenge.

The final active codebase must read like one system intentionally designed as one system —
not patches on patches, temporary fixes, compatibility layers, abandoned experiments,
historical migrations, duplicated implementations, half-completed refactors, legacy naming
or dead abstractions.

### §4 — SOURCE-CODE CLEANLINESS

Active source contains no historical narrative. Remove obsolete comments — "temporary
fix", "legacy", "old implementation", "workaround", "patched", "TODO from previous
implementation", "migration compatibility", "deprecated but kept", "previously…",
"changed because…", historical debugging notes — unless genuinely required to understand
the current architecture. Comments explain current intent, not historical suffering.

### §5 — GIT HISTORY RULE

Clean the active implementation. Do **not** destroy Git history to hide development
history. `ACTIVE CODEBASE = CLEAN FINAL SYSTEM`, not `GIT HISTORY = DESTROYED`. History
is provenance, not active architecture.

### §6 — PHASE 0: REPOSITORY FREEZE

Read-only. Inspect Git status, branch, HEAD, uncommitted changes, structure, package
manifests, scripts, backend, frontend, database, migrations, tests, configuration,
environment handling, assets, dependencies, routes, services, repositories, controllers,
middleware, hooks, components, pages, state management, reports, dashboards,
authorization, financial logic, academic logic, payroll. Modify nothing. Produce a
**CURRENT STATE MAP**.

### §7 — PHASE 1: FORENSIC SYSTEM AUDIT

Reconstruct the actual system from source, database, routes, services, API contracts,
frontend consumers, tests, configuration, scripts, dependencies and runtime behaviour.
Do not trust documentation where code contradicts it. Identify duplicate logic, data and
authorities; dead and unreachable code; obsolete files and dependencies; hidden coupling;
circular dependencies; architectural violations; inconsistent naming, state models,
validation, authorization, reporting, date handling and currency handling; financial,
data-integrity, performance and security risks; UX problems and UI inconsistencies.
No modifications.

### §8 — PHASE 2: DOMAIN RECONSTRUCTION

Build a complete domain model: entities, value objects, aggregates, relationships,
ownership, lifecycle, states, transitions, invariants, commands, queries, policies,
permissions, calculations, justified events, dependencies. For each important entity
determine who owns it, who may create/modify/delete it, what states exist, which
transitions are valid and forbidden, what depends on it, and what history must remain
immutable.

### §9 — PHASE 3: COMPLETE SYSTEM DOMAIN MAP

Audit at minimum: Organization · Campus · Branch · Settings · Configuration · Rules ·
Users · Staff · Positions · Roles · Permissions · Authentication · Authorization ·
Visitors · Placement · Students · Programs · Courses · Levels · Enrollment · Classes ·
Sessions · Teachers · Attendance · Exams · Academic progression · Diplomas · Books ·
Book issuance · Fees · Invoices · Payments · Refunds · Ledger · Cash · Savings · Finance ·
Payroll · Reports · Dashboards · Audit · Notifications where applicable · Search ·
Filtering · Configuration surfaces · Operational workflows.

### §10 — PHASE 4: TARGET ARCHITECTURE

Design the target architecture independently of the existing one. Evaluate every
subsystem: **KEEP · REFACTOR · REBUILD · REMOVE**. Existence is never justification for
KEEP. Minimize duplication, coupling, ambiguity, hidden state, cross-layer leakage,
business logic in UI or routes, data-access leakage, circular dependencies, unnecessary
abstraction and indirection. Maximize cohesion, explicit ownership, testability,
composability, maintainability, observability, correctness and predictability.

### §11 — ARCHITECTURAL REBUILD AUTHORITY

With no production dataset requiring preservation, incompatible structures may be
rebuilt when justified. Do not perform incremental compatibility engineering solely to
preserve obsolete architecture. Do not maintain compatibility aliases, duplicate APIs,
old schema columns, legacy migration layers, transitional services, duplicate business
rules or obsolete adapters unless an actual external integration requirement proves them
necessary.

### §12 — PHASE 5: CANONICAL DATABASE RECONSTRUCTION

The database is rebuilt from first principles. Legacy migrations are **not**
authoritative. If it is confirmed that no production data exists, **remove legacy
migrations from the active project**, together with obsolete migration utilities,
migration compatibility logic, migration-only tables, deprecated schema fragments,
temporary schema structures, duplicate columns, obsolete indexes and obsolete
constraints.

Create ONE canonical representation of the desired schema (e.g. `schema.sql`, or another
objectively superior canonical mechanism). The system must support, deterministically:
`EMPTY DATABASE → CANONICAL INITIALIZATION → COMPLETE VALID DATABASE`.

The schema must include appropriate PKs, FKs, unique constraints, check constraints,
indexes, nullability, defaults, transactional requirements, audit structures and
financial integrity constraints. **No duplicate schema authority.**

### §13 — DATABASE DESIGN RULES

Every table, column, nullable field, foreign key, unique constraint, index and check
constraint must have a reason to exist and reflect a real rule, relationship or access
pattern. Do not create tables because the frontend needs a screen, or columns because
they are convenient. Do not store derived values where canonical derivation is safer,
absent a documented reason and synchronization strategy.

### §14 — PHASE 6: LEGACY TEST RESET

Existing tests are **not** authoritative. Inventory them first and determine what
behavioural knowledge they contain. Then remove the legacy active test suite. Do not
blindly copy old tests or preserve them merely because they exist. Rebuild the testing
architecture from the domain model, invariants, API contracts, authorization model,
financial model, acceptance criteria and actual workflows. Testing begins immediately as
the new architecture starts being implemented; never operate for an extended period with
no verification.

### §15 — TESTING PYRAMID

Cover: domain · unit · application/use-case · repository/database · API/integration ·
authorization · financial invariant · reporting · UI/component · critical end-to-end
workflows. Optimize for defect-detection power, not test-count vanity. Tests prove
behaviour, not implementation trivia.

### §16 — PHASE 7: CANONICAL AUTHORITY REGISTRY

Persistent registry with: Concept · Storage Authority · Business Authority · API
Authority · UI Consumers · Reporting Consumers · Test Authority · Status. Exactly one
authority per critical concept. Two authorities = defect.

### §17 — INVARIANT REGISTRY

Registry with: Invariant · Owner Layer · Enforcement Point · Test · Failure Behaviour ·
Severity. Consider at minimum: no duplicate authoritative payment · no unauthorized
payment · no refund without a valid underlying transaction · refund cannot create money ·
cash balance reconciles · ledger internally coherent · invoice balance authoritative ·
unauthorized role cannot execute a protected action · invalid enrollment transitions
blocked · invalid academic progression blocked · duplicate enrollment prevented where
required · duplicate identity records prevented where required.

### §18 — METRIC REGISTRY

Every reportable metric has: name · definition · formula · authoritative source ·
filters · period · calendar · timezone · currency · precision · aggregation · consumers ·
test. No report, dashboard or frontend may independently define or calculate a metric.
**ONE METRIC → ONE DEFINITION → MANY CONSUMERS.**

### §19 — CALENDAR AUTHORITY

One canonical calendar/period authority. Determine from actual requirements whether the
system uses Gregorian, Solar Hijri, or both. Storage representation canonical; display
localized. No module independently defines "month", "quarter", "year" or "academic
period". The same named period resolves identically across Finance, Payroll, Academic,
Reports, Dashboards and Filters.

### §20 — MONEY AND CURRENCY AUTHORITY

Establish canonical currency · supported currencies if any · precision · rounding ·
smallest unit · sign conventions · refund rules · discount rules · tax rules if
applicable · exchange-rate policy if applicable. No financial module invents its own
rounding or currency behaviour.

### §21 — FINANCIAL ARCHITECTURE

Finance receives maximum scrutiny. Model explicitly: fees · invoices · payments · payment
allocation · refunds · income · expenses · ledger · cash · savings · reconciliation ·
outstanding balances · financial periods. Every financial mutation must be atomic,
authorized, auditable, idempotent where appropriate, explainable, and reversible through
explicit financial transactions where required. Never directly manipulate balances where
authoritative transactions should be used. Never create a financial number without an
underlying authoritative record.

### §22 — RBAC AND AUTHORIZATION

Model authorization explicitly. Support the actual organizational requirement that users
may hold multiple positions where required. Separate identity · staff · position · role ·
permission · assignment · scope. Account for organization, campus, branch, department,
role, position, resource and action. Never enforce authorization only through the UI.

### §23 — AUDITABILITY

Critical operations must be auditable: operator identity · operator role/position where
required · action · resource · timestamp · relevant context · before/after where
appropriate. Do not log secrets or expose sensitive information unnecessarily. Financial
and permission changes require especially strong auditability.

### §24 — PHASE 8: DESIGN SYSTEM

Build or rebuild a coherent design system before multiplying UI implementations:
typography · hierarchy · spacing · grid · color semantics · borders · radius · elevation ·
icons · buttons · inputs · selects · date inputs · tables · cards · badges · tabs ·
dialogs · drawers · dropdowns · menus · alerts · notifications · toasts · pagination ·
filters · search · breadcrumbs · navigation · loading states · skeletons · empty states ·
error states · permission states · confirmation states. No page invents an unrelated
visual language.

### §25 — UI QUALITY STANDARD

Evaluate every screen for visual hierarchy · information density · readability ·
consistency · spacing · alignment · responsive behaviour · accessibility ·
discoverability · feedback · error prevention · error recovery · loading behaviour · empty
state · permission state · destructive-action safety · keyboard interaction · search ·
filtering · sorting · pagination · mobile behaviour · RTL behaviour where applicable.
"Looks good" is insufficient; the UI must improve task performance.

### §26 — RTL AND BILINGUAL QUALITY

If Persian/Dari is supported, RTL is a first-class layout mode. Verify text direction ·
mixed Latin/Persian text · numbers · dates · tables · icons · navigation · forms ·
alignment · punctuation · financial values · responsive behaviour. Do not merely flip the
interface mechanically.

### §27 — UX ROLE AUDIT

Evaluate workflows as: receptionist · teacher · academic manager · finance manager ·
payroll operator · HR/staff operator · department head · director · owner · auditor ·
administrator. For each important workflow determine objective · starting point ·
required information · minimum interaction cost · error risk · feedback · completion
confirmation · recovery path. Optimize for real work, not visual novelty.

### §28 — PHASE 9: VERTICAL SLICE IMPLEMENTATION

Do not build in isolated horizontal layers. Build complete vertical capabilities:
Database → Domain → Application → Authorization → API → UI → Validation → Audit → Tests →
Reporting impact. Every completed slice is internally complete.

### §29 — END-TO-END DOMAIN COVERAGE

Cover the whole operational lifecycle as applicable: Organization → Campus → Branch →
Configuration → Users/Staff → Positions/Roles/Permissions → Visitor → Placement → Student
→ Program → Course → Level → Enrollment → Class → Session → Teacher → Attendance →
Academic progression → Exam → Diploma → Books → Book issuance → Fees → Invoice → Payment →
Refund → Ledger → Cash → Savings → Payroll → Reports → Dashboards → Audit.

### §30 — REPORTING SYSTEM

Reporting is a core subsystem. Implement and verify as applicable: daily · weekly ·
monthly · quarterly · annual · financial · academic · student · visitor · enrollment ·
attendance · teacher · payroll · management · operational · audit reports. Every report
has a clear purpose · canonical metrics · explicit period · explicit filters · consistent
definitions · accurate totals · empty states · error states · print behaviour · export
behaviour where required · appropriate permissions.

### §31 — PRINTING

Printing is first-class where operationally required. Audit page layout · print margins ·
headers · footers · pagination · tables · repeated headers · totals · dates · signatures
where applicable · RTL · bilingual content · paper efficiency · print readability. A
screen that merely happens to print is not a professional print implementation.

### §32 — SEARCH AND DATA OPERATIONS

Core operational entities require high-quality search · filtering · sorting · pagination ·
clear/reset filters · saved state where justified · empty state · loading state · error
state. Search uses appropriate backend capabilities for large datasets. Do not fetch
entire datasets to filter in the browser unless objectively justified.

### §33 — API ARCHITECTURE

API contracts must be explicit · consistent · predictable · validated · authorized ·
typed · error-consistent. Different endpoints must not represent the same concept
differently without justification. Validate at appropriate boundaries. Never trust
client-supplied derived financial or authorization state.

### §34 — STATE MANAGEMENT

Avoid duplicated client state. Distinguish server state · local UI state · derived state ·
cached state. Do not maintain multiple independent copies of authoritative server state
unless justified. After mutations the UI must immediately reflect the authoritative
result. No routine hard refresh. Mutation behaviour must be architecturally consistent
system-wide.

### §35 — REAL-TIME CONSISTENCY

Every mutation defines how affected consumers become current: relevant local state
updates · caches invalidate/update · dependent views update · dashboards update where
applicable · reports reflect new state where appropriate. Browser hard refresh, manual
reload and reopening the page are not synchronization mechanisms.

### §36 — CONCURRENCY AND IDEMPOTENCY

Assess duplicate submissions · double clicks · retry requests · network retries ·
concurrent users · stale state · race conditions. Financial mutations and other critical
commands are idempotent where appropriate. A retry must never create a duplicate
authoritative transaction.

### §37 — VALIDATION

Validation must be consistent · domain-aware · server-authoritative · user-readable ·
precise. Every important field defines type · range · format · nullability · uniqueness ·
business constraints. Never rely solely on browser validation.

### §38 — ERROR HANDLING

Errors must be predictable · safe · actionable · non-leaky · consistent. The UI
distinguishes validation error · permission error · not found · conflict · server
failure · network failure · business-rule rejection. Never expose stack traces or
sensitive internals.

### §39 — ACCESSIBILITY

Audit semantic HTML · keyboard navigation · focus management · focus visibility · labels ·
form errors · contrast · accessible names · dialogs · tables · navigation · screen-reader
semantics · reduced motion where applicable. Accessibility is product quality, not
decoration.

### §40 — PERFORMANCE

Performance must be measured. Audit database queries · indexes · query plans · N+1
queries · API latency · payload size · frontend rendering · unnecessary rerenders · large
tables · expensive calculations · caching · pagination. Measure first; optimize; measure
again.

### §41 — SECURITY

Adversarial review of authentication · authorization · privilege escalation · IDOR ·
injection · unsafe input · mass assignment · insecure direct object access · sensitive
data exposure · CSRF where applicable · session handling · secrets · file access ·
administrative endpoints · financial endpoints. Client-side restrictions are never
security controls.

### §42 — ADVERSARIAL ATTACK PHASE

Attempt to break every critical workflow: malformed input · missing input · duplicate
input · duplicate request · concurrent request · stale data · invalid state transition ·
unauthorized API call · unauthorized UI action · direct endpoint access · invalid IDs ·
deleted records · nonexistent records · negative, zero, boundary and large values · date,
period and calendar boundaries · refund and payment boundaries · network failure · partial
failure · transaction failure. If an attack succeeds: STOP certification · REPAIR ·
REVERIFY.

### §43 — DELETION PROTOCOL

Nothing is deleted merely because it appears unused. Before deleting code/files prove:
(1) no active import/reference · (2) no dynamic usage · (3) no runtime usage · (4) no
feature-flag usage · (5) no admin-only usage · (6) no build-time usage · (7) no test
dependency · (8) no migration/schema dependency · (9) no script dependency · (10) no
configuration dependency · (11) no legitimate operational dependency. Search broadly
first.

**Financial and audit DATA ROWS are categorically excluded from code/file dead-code
deletion logic.** Do not delete financial history because it appears unused.

For this non-production greenfield project, obsolete code artifacts may be removed
completely after verification.

### §44 — DEAD CODE ELIMINATION

Remove dead files · functions · classes · components · routes · services · repositories ·
hooks · types · constants · dependencies · configuration · obsolete assets · obsolete
migrations · obsolete tests · duplicate utilities, components and APIs · obsolete
comments. Nothing is kept "just in case".

### §45 — DEPENDENCY HYGIENE

Every dependency has an active purpose. Remove unused packages, duplicate and obsolete
libraries, unnecessary wrappers and abandoned tooling. Each added dependency needs a
defensible reason.

### §46 — FILE STRUCTURE

The directory structure must communicate architecture. Avoid random utility folders,
giant misc folders, unclear naming, duplicated module structures, inconsistent
conventions and abandoned directories. A new engineer must understand the structure
without archaeology.

### §47 — NAMING

Naming must be consistent · domain-correct · explicit · unambiguous. No two names for one
concept. Avoid `helper`, `misc`, `temp`, `manager`, `common`, `utils` where a
domain-specific name is possible. Naming reflects ownership and responsibility.

### §48 — ARCHITECTURAL BOUNDARIES

Forbid UI → Database · UI → financial internals · route → arbitrary SQL · report →
independent business calculation · component → authorization authority. Every dependency
crosses a deliberate boundary.

### §49 — TRANSACTION BOUNDARIES

Any workflow changing multiple authoritative records atomically has an explicit
transaction boundary: enrollment + invoice · payment + ledger · refund + ledger/cash ·
visitor conversion · payroll posting · financial reconciliation. Never assume multiple
writes are atomic without verifying.

### §50 — DATA LIFECYCLE

For each major entity determine CREATE · READ · UPDATE · TRANSITION · ARCHIVE/RETENTION ·
DELETE. Deletion follows business policy. Historical financial/audit facts are not
casually destroyed.

### §51 — CONFIGURATION ARCHITECTURE

Configuration has one authority. Distinguish hard invariant · configurable rule ·
operational setting · display preference. Do not encode configurable policy as scattered
constants, nor make true invariants configurable for convenience.

### §52 — RULE ENGINE DISCIPLINE

Every business rule has owner · definition · inputs · outputs · authority · enforcement
point · tests. Do not duplicate rule logic across frontend, backend, reports, database or
scripts.

### §53 — AUDIT OF DUPLICATION

Explicitly search for duplicate calculations · SQL · business rules · API transformations ·
validation · formatting · permissions · components · types · database concepts · reports ·
metrics. For each: CONSOLIDATE, or PROVE why both are necessary.

### §54 — QUALITY GATE

Evaluate every completed Work Package across Correctness · Architecture · Data Integrity ·
Finance · Security · RBAC · UX · UI · Accessibility · Performance · Reliability ·
Reporting · Maintainability · Observability · Repository Cleanliness · Operational
Readiness · Testing. **Do not average.** The weakest critical dimension controls
certification.

### §55 — EVIDENCE MODEL

**PROVEN** — executed command/result + relevant test + direct evidence + review
confirmation. **SUPPORTED** — evidence exists but is not fully direct. **PLAUSIBLE** —
reasoning only. **UNVERIFIED** — no sufficient evidence. **CONTRADICTED** — evidence
disproves the claim. Never treat PLAUSIBLE as PROVEN.

### §56 — QUALITY SCORE

10/10 only when the criterion is explicitly defined, implementation satisfies it,
evidence exists, tests support it where applicable, adversarial review finds no failure,
and no contradictory evidence exists. Do not inflate. Do not average away critical
defects.

### §57 — CRITICAL FAILURE RULE

Any unresolved Critical or High defect in Finance · Security · RBAC/Auth · Data
Integrity · Core business state blocks certification. No visual quality compensates for
incorrect money. No beautiful UI compensates for broken authorization. No performance
improvement compensates for corrupt data.

### §58 — WORK PACKAGE MODEL

Use bounded Work Packages. Minimum suggested boundaries: (1) Organization &
Configuration · (2) Identity & Access · (3) Students & Admissions · (4) Academic
Structure · (5) Academic Delivery · (6) Library · (7) Finance · (8) Payroll · (9)
Reporting & Dashboards · (10) Audit. Cross-cutting architecture may be redesigned
globally when required.

### §59 — WORK PACKAGE LIFECYCLE

SCOPE → DISCOVER → MODEL → CHALLENGE → DECIDE → CHECKPOINT → IMPLEMENT → VERIFY → ATTACK →
REPAIR → REVERIFY → INDEPENDENT REVIEW → CLEAN → CERTIFY.

### §60 — SCOPE

Define included and excluded functionality, dependencies, affected contracts, affected
authorities, risk classification. No uncontrolled scope expansion.

### §61 — DISCOVER

Read-only. Produce actual files · tables · endpoints · services · consumers ·
dependencies · tests · configurations · workflows. No assumptions.

### §62 — MODEL

Construct entities · relationships · states · transitions · invariants · authority map ·
data flow · user flows.

### §63 — CHALLENGE

Per subsystem: KEEP · REFACTOR · REBUILD · REMOVE, with reasons. "Existing" is never
sufficient justification for KEEP.

### §64 — DECIDE

Produce an exact implementation plan: files · tables · endpoints · components · services ·
dependencies · deletions · additions · modifications · tests · risk. Nothing is
implemented before the plan is coherent.

### §65 — CHECKPOINT

Required for schema changes · finance changes · RBAC changes · security changes ·
destructive deletion · major architecture changes · replacements. Production backup
requirements do not apply (no production data), but a recoverable Git state must be
preserved before large destructive transformations.

### §66 — IMPLEMENT

Implement the approved architecture. No unrelated changes. If implementation reveals the
plan is wrong: STOP · re-model · re-decide · continue. Never silently drift.

### §67 — VERIFY

Use the actual project tooling. Inspect `package.json` and execute the real typecheck ·
lint · build · tests · database initialization · integration verification · relevant
scripts. Never invent commands. Capture actual output.

### §68 — ATTACK

Actively attempt to break the implementation. The goal is to find defects, not to prove
yourself correct.

### §69 — REPAIR

Every discovered defect is classified · fixed · tested. If the fix changes architecture,
re-enter DECIDE.

### §70 — REVERIFY

Run the complete relevant verification again. A test that passed before a repair is not
evidence after the repair.

### §71 — INDEPENDENT REVIEW

Perform a structurally separate cold review. Pretend you did not write the
implementation. Review diff · architecture · tests · evidence · invariants · security ·
finance · UX · repository cleanliness. Look specifically for defects the first review
missed.

### §72 — CLEAN

Remove all residue: temporary files · debug code · console logging · abandoned
experiments · obsolete comments · temporary imports · unused dependencies · unused types ·
generated junk. Then perform a repository-wide cleanliness scan.

### §73 — CERTIFICATION

**READY** — all critical/high dimensions pass with sufficient evidence.
**READY WITH TRACKED RISK** — only medium/low non-critical risks remain, each explicitly
recorded. **NOT READY** — any critical/high failure, contradiction, or material
uncertainty remains.

### §74 — FINAL RELEASE GATE

Cannot certify if finance is incorrect · authorization is bypassable · data integrity is
compromised · critical workflows are broken · major metrics contradict · canonical
authorities are duplicated · critical behaviour is untested · critical claims are
unverified · severe performance problems remain · major UX failures block normal
operation · dead/obsolete architecture remains without justification.

### §75 — FINAL SYSTEM-WIDE AUDIT

After every Work Package, audit architecture coherence · cross-domain dependencies ·
duplicated authority, calculations, components and API concepts · financial, RBAC,
calendar, reporting, configuration, state and UI consistency · design-system compliance ·
test coverage · performance · security · repository cleanliness.

### §76 — CROSS-DOMAIN CONSISTENCY

Test interactions: Students ↔ Finance · Students ↔ Academic · Visitors ↔ Placement ·
Placement ↔ Students · Enrollment ↔ Finance · Enrollment ↔ Classes · Classes ↔ Teachers ·
Classes ↔ Attendance · Attendance ↔ Reports · Academic ↔ Reports · Finance ↔ Reports ·
Finance ↔ Payroll where applicable · RBAC ↔ every protected subsystem · Configuration ↔
every configured subsystem.

### §77 — REPORT RECONCILIATION

For every major metric compare database truth · API result · UI display · dashboard ·
report · export · printed version. They must agree unless an explicit documented
transformation exists. Two surfaces showing different numbers for one metric = FAIL.

### §78 — FINANCIAL RECONCILIATION

Explicitly reconcile invoices · payments · refunds · ledger · cash · savings · outstanding
balances · financial reports. Every discrepancy must be explained. Unexplained
discrepancy = FAIL.

### §79 — UI CONSISTENCY AUDIT

Scan all screens for inconsistent buttons · forms · tables · spacing · typography ·
colors · error handling · loading · filters · pagination · navigation · terminology. Fix
systemically; do not patch screens individually when the problem belongs to the Design
System.

### §80 — USER EXPERIENCE AUDIT

For every critical workflow, can the user understand where they are · what they can do ·
what happened · what failed · what must happen next · whether the operation succeeded ·
whether it is reversible · whether permission prevents the action? If not: REDESIGN.

### §81 — RESPONSIVENESS

Test desktop · laptop · tablet · mobile. No critical workflow becomes unusable at
supported sizes.

### §82 — EMPTY / LOADING / ERROR / SUCCESS STATES

Every important screen intentionally handles loading · empty · success · validation
error · permission denied · server error · network failure · no search results. Never
leave these to accidental browser behaviour.

### §83 — OBSERVABILITY

Critical operations must be diagnosable. Logs must be structured where appropriate ·
useful · non-sensitive · actionable. Avoid uncontrolled logging. Never expose secrets.

### §84 — DOCUMENTATION

Documentation describes the final architecture. Remove obsolete documentation. Do not
preserve contradictory historical documents inside the active project. Document
architecture · domain boundaries · canonical authorities · important invariants ·
database initialization · configuration · development workflow · verification commands ·
operational requirements. Documentation must match actual code.

### §85 — NO DOCUMENTATION THEATER

Never create documents merely to claim a phase is complete. Artifacts are useful only
when accurate · current · actionable · verifiable · consumed.

### §86 — NO LEGACY COMPATIBILITY THEATER

Do not preserve obsolete architecture because "it might be useful later". If a
requirement, dependency, abstraction or compatibility layer is not real: remove it.

### §87 — NO PREMATURE COMPLEXITY

"Best system" ≠ "most complicated system". Prefer the simplest architecture satisfying
correctness · security · maintainability · scalability requirements · observability ·
domain complexity. No microservices, event buses, excessive abstractions, CQRS or
distributed systems unless evidence requires them.

### §88 — NO SUPERFICIAL BEAUTIFICATION

Do not polish UI while architecture, finance, permissions, data integrity or reporting
are wrong. Correctness precedes decoration — but once correctness is established, UI/UX
must also reach a genuinely high standard.

### §89 — AGENT SELF-CRITICISM LOOP

Before certification ask: What did I assume? What did I not verify? What could be wrong?
Where could duplication still exist? Where could authorization fail? Where could money be
created or lost? Where could two metrics disagree? Where could stale UI occur? Where
could concurrent operations break state? What if the user does the opposite of the
expected workflow? What if the network fails? What if the request is repeated? What if
the database rejects a write? What if the user has multiple positions? What if
configuration changes? What happens at period boundaries? At zero/negative/boundary
values? What dead code did I fail to detect? What architecture decision would I reverse
if redesigning today?

### §90 — ASSUMPTION REGISTER

Maintain explicit separation between FACT · INFERENCE · ASSUMPTION · DECISION · UNKNOWN.
Never treat an assumption as a fact. When an assumption affects finance, security, data
integrity, RBAC or a core workflow: STOP and resolve it.

### §91 — DECISION LOG

Record final architectural decisions outside source-code comments: decision · context ·
alternatives · selected option · reason · evidence · consequences · reversibility. Source
code remains clean.

### §92 — CHANGE CLASSIFICATION

BUG FIX · REFACTOR · ARCHITECTURE CHANGE · BEHAVIOR CHANGE · DATA MIGRATION · SECURITY
CHANGE · PERFORMANCE CHANGE · UX CHANGE · REMOVAL · REPLACEMENT. For this greenfield
reconstruction, DATA MIGRATION means migration of actual required data; historical
migration files are not required merely because they existed.

### §93 — ACCEPTANCE CRITERIA

Every major capability has explicit acceptance criteria describing observable behaviour,
e.g. unauthorized user cannot execute a protected operation · valid user can complete the
workflow · invalid state transition is rejected · payment updates the authoritative
balance · refund cannot create phantom cash · report matches the canonical metric · UI
reflects a mutation without hard refresh · duplicate submission does not duplicate an
authoritative transaction.

### §94 — TEST DATA

Deterministic fixtures covering normal users · multiple positions · different roles ·
different branches · students · visitors · teachers · classes · enrollments · payments ·
refunds · invoices · payroll · reports, including boundary and adversarial fixtures.

### §95 — DATABASE REBUILD REQUIREMENT

Initialization must be reproducible from empty: (1) remove database · (2) initialize ·
(3) schema creation succeeds · (4) constraints exist · (5) indexes exist · (6) application
starts · (7) seed/configuration succeeds if required · (8) core workflows succeed ·
(9) tests succeed. Repeat from clean. A clean rebuild must not depend on historical
migrations.

### §96 — CLEAN REBUILD TEST

Perform a true clean-room build: EMPTY DATABASE + CLEAN INSTALL + CANONICAL SCHEMA +
CURRENT APPLICATION + CURRENT TESTS, then execute the complete verification suite. If the
system only works because of historical local state: FAIL.

### §97 — RELEASE REPRODUCIBILITY

Another engineer must be able to clone · install · initialize the database · configure
the environment · start the system · run tests · build, without undocumented personal
machine state.

### §98 — FINAL REPOSITORY SCAN

Search for TODO · FIXME · TEMP · HACK · deprecated · legacy · old · unused · dead ·
migration · compatibility · workaround · debug · console.log · duplicate · commented-out
code. Evaluate each result. Do not blindly delete legitimate occurrences. Resolve or
justify each remaining result.

### §99 — FINAL AUTHORITY AUDIT

For every critical domain concept answer: **WHERE IS THE TRUTH?** If the answer contains
"it depends", "there are two places", "frontend calculates it", "report calculates it
separately" or "this module also maintains…", investigate and consolidate.

### §100 — FINAL CERTIFICATION MATRIX

Produce Dimension · Status · Evidence Class · Evidence · Tests · Remaining Risk across:
Architecture · Domain Correctness · Database · Data Integrity · Finance · RBAC ·
Security · API · Frontend · UI · UX · Accessibility · Reporting · Printing · Performance ·
Reliability · Concurrency · Observability · Testing · Maintainability · Repository
Cleanliness · Operational Readiness.

### §101 — CERTIFICATION RULE

**NO AVERAGING.** One critical failure blocks certification. One critical uncertainty
blocks certification. A visually exceptional system with incorrect financial logic is NOT
READY. A technically elegant system with broken authorization is NOT READY. A fast system
with incorrect reports is NOT READY. A beautiful system with duplicated authorities is
NOT READY.

### §102 — FINAL STATUS

**READY** — verified against defined requirements; critical dimensions have sufficient
evidence. **READY WITH TRACKED RISK** — only non-critical risks remain, each documented.
**NOT READY** — a critical/high defect, contradiction or material uncertainty remains.

### §103 — ABSOLUTE ANTI-HALLUCINATION RULE

Never claim a command was executed when it was not · a test passed when it was not
executed · a file was inspected when it was not · architecture, database, security or
performance was verified or measured when it was not · a deletion is safe when it was not
proven · a requirement is satisfied when it was not demonstrated. If you cannot prove it,
say so.

### §104 — EXECUTION ORDER (ABSOLUTE)

1 Repository Freeze · 2 Repository Forensics · 3 Complete Domain Reconstruction ·
4 Current-State Architecture Map · 5 Requirement Extraction · 6 Assumption/Unknown
Register · 7 Target Architecture Design · 8 Canonical Domain Model · 9 Canonical
Authority Registry · 10 Invariant Registry · 11 Metric Registry · 12 Calendar Authority ·
13 Currency/Financial Authority · 14 Canonical Database Design · 15 Legacy Migration
Removal · 16 Legacy Test Inventory · 17 Legacy Test Removal · 18 New Test Architecture ·
19 Design System · 20 API/Application Contracts · 21 Vertical Slice Implementation ·
22 Continuous Testing · 23 Cross-Domain Integration · 24 Reporting · 25 Printing ·
26 UX Optimization · 27 Accessibility · 28 Security Audit · 29 Concurrency/Idempotency
Audit · 30 Performance Audit · 31 Adversarial Attack · 32 Repair · 33 Reverification ·
34 Independent Review · 35 Dead-Code/File/Dependency Cleanup · 36 Clean Database Rebuild ·
37 Clean Repository Rebuild · 38 Full System Reconciliation · 39 Final Authority Audit ·
40 Final Certification.

### §105 — STOP CONDITIONS

STOP and request clarification if business intent is genuinely ambiguous · a critical
financial rule cannot be determined · a security policy cannot be determined · an
externally required integration is unclear · a destructive action could affect unknown
real data · repository state is inconsistent with the declared project state · a
requirement conflicts with another explicit requirement. **Do not guess.**

### §106 — NO SCOPE CREEP

Do not randomly modify unrelated areas. If a discovered defect outside the current Work
Package makes it unsafe or architecturally invalid: STOP · document the dependency ·
re-scope deliberately. Never silently ignore it.

### §107 — FINAL SYSTEM PHILOSOPHY

The system is not judged by number of files, components, tests, abstractions, migrations,
amount of code, visual complexity or feature count. It is judged by correctness ·
coherence · clarity · integrity · security · accuracy · usability · maintainability ·
performance · evidence · operational value.

### §108 — ABSOLUTE FINAL RULE

**DO NOT BUILD A BETTER VERSION OF THE OLD SYSTEM. BUILD THE CORRECT FINAL SYSTEM.**

Use the repository to discover reality · validated requirements to define purpose ·
domain modeling to define behaviour · architecture to define boundaries · canonical
authorities to eliminate duplication · the database to enforce integrity · the
application layer to enforce business rules · the API to expose controlled capabilities ·
the design system for visual consistency · UX principles to minimize operational cost ·
tests to prove behaviour · adversarial analysis to find failure · evidence to determine
truth · cleanup to remove history from the active implementation · certification to
determine readiness.

The finished repository must look and behave as though it was intentionally designed as
one coherent system from the beginning.

NO PATCHWORK · NO DUPLICATE AUTHORITY · NO DEAD CODE · NO LEGACY RESIDUE · NO UNNECESSARY
MIGRATIONS · NO LEGACY TEST SUITE · NO DUPLICATE BUSINESS LOGIC · NO DUPLICATE METRICS ·
NO CLIENT-SIDE BUSINESS TRUTH · NO UNSAFE FINANCIAL SHORTCUTS · NO SECURITY BY UI ·
NO UNVERIFIED CLAIMS · NO ARTIFICIAL 10/10 · NO COMPROMISE ON CRITICAL CORRECTNESS.

**FINAL PRINCIPLE: THE SYSTEM MUST BECOME THE STANDARD AGAINST WHICH ITS OWN FUTURE
CHANGES ARE JUDGED.**

---

## END OF NORMATIVE BODY

Everything below this line is **subordinate**. It records evidence and derived
positions. It never overrides the normative body, and it may be revised as evidence
changes.

---

## §R — AUTHORIZED REVISIONS

| Date | Section | Change | Authorized by |
|---|---|---|---|
| — | — | none | — |

## §E — DERIVED EVIDENCE (subordinate, non-normative)

Facts established by inspection, recorded so no future pass re-derives them. Each is
FACT unless marked otherwise.

| Topic | Finding | Class | Evidence |
|---|---|---|---|
| Currency (§20) | AFN is the only currency; no FX logic anywhere. Confirmed as a requirement by owner decision D-11, not merely observed | FACT + DECISION | `src/utils/format.ts`, `docs/registries/decisions.md` |
| Precision (§20) | Stored and displayed as whole AFN. Operator input is rejected if fractional; computed values settle half away from zero | FACT + DECISION | `server/src/utils/money.ts`, INTEGER money columns + `trg_*_money_scale_*`, `src/utils/format.ts`, D-22/D-23 |
| Calendar (§19) | Solar Hijri is first-class for period arithmetic; storage is single-form ISO-8601 Gregorian; display is localized | FACT | `server/src/core/calendar/periods.ts` (authority), `src/utils/jalali.ts` (display) |
| UI direction (§26) | Chrome is *currently* uniformly LTR/English (`<html lang="en">`, `dir="ltr"` on every view root); Persian/Dari appears only as *data*. Owner decision D-15 makes bilingual EN + fa/prs with first-class RTL a requirement, so this describes the state to be replaced, not the target | FACT (current state) | `index.html`, `src/App.tsx` |
| Migration mechanism (§12) | **None.** There is no migration chain. `server/src/db/schema.sql` is the single canonical schema (111 tables · 228 indexes · 66 triggers) and is applied idempotently on every boot | FACT | `server/src/db/schema.sql`, `server/scripts/verify-canonical-schema.mjs` |
| Database backup (§65) | **None.** The only automatic snapshot lived in the migration runner and was removed with it. Tracked as assumption A-11 / risk TR-5 | FACT | `docs/registries/assumptions.md` |
| Verification commands (§67) | root: `typecheck`, `lint`, `build`, `audit:product`, `audit:static`, `audit:registries`, `audit:protocol`, `audit:bundle`, `release:validate` · server: `lint`, `typecheck`, `test`, `build`, `preflight:schema`, `seed` | FACT | `package.json`, `server/package.json` |
| Domain surface (§9) | 35 route modules, 12 core domains, 20 frontend view areas | FACT | `server/src/routes/`, `server/src/core/`, `src/components/` |

## §W — WORK PACKAGE MAP (subordinate)

§58 gives ten *suggested minimum* boundaries. Mapped onto the real 35-route surface, this
is the operative decomposition. Every route module appears exactly once.

| # | Work Package | Route modules |
|---|---|---|
| WP-01 | Organization & Configuration | `branches`, `settings`, `rules`, `catalog` |
| WP-02 | Identity & Access | `auth`, `users`, `security` |
| WP-03 | Students & Admissions | `students`, `visitors`, `journey` |
| WP-04 | Placement | `placement`, `placement-attempt`, `placement-test-bank` |
| WP-05 | Academic Structure | `academic`, `classes`, `offerings`, `enrollment`, `waitlist`, `skills`, `teachers` |
| WP-06 | Academic Delivery | `sessions`, `exams` |
| WP-07 | Finance | `finance`, `invoices`, `discount-authorizations` |
| WP-08 | Payroll | `teachers` (payroll routes) |
| WP-09 | Funding & Impact | `funding`, `impact` |
| WP-10 | Books | `books` |
| WP-11 | Reporting & Analytics | `reports`, `dashboard`, `bos`, `search` |
| WP-12 | Workflow & Automation | `workflows`, `automations`, `events` |
| WP-13 | Audit | `audit` |

WP-07 and WP-08 carry the strictest evidence and sign-off burden regardless of which
package is nominally under audit, because every other package consumes them.

## §X — REGISTERED ARTIFACTS

| Artifact | Location | Enforced by |
|---|---|---|
| This protocol | `docs/MASTER_ENGINEERING_PROTOCOL.md` | `npm run audit:protocol` (checksum) |
| Canonical Authority Registry (§16) | `docs/registries/canonical-authority.md` | `npm run audit:registries` |
| Invariant Registry (§17) | `docs/registries/invariants.md` | `npm run audit:registries` |
| Metric Registry (§18) | `docs/registries/metrics.md` | `npm run audit:registries` |
| Decision Log (§91) | `docs/registries/decisions.md` | `npm run audit:registries` |
| Conflict Register | `docs/registries/protocol-conflicts.md` | reviewed at each CHECKPOINT |
| Assumption Register (§90) | `docs/registries/assumptions.md` | reviewed at each CHECKPOINT |
