# TOEFL HOUSE ERP



WORLD-CLASS MASTER ENGINEERING CONTRACT



Version 3.0 — Canonical Project Engineering Constitution



Document Status: MASTER / CANONICAL / CONTINUOUSLY IN FORCE

Authority: PRIMARY PROJECT ENGINEERING DIRECTIVE

Scope: ENTIRE TOEFL HOUSE ERP / EDTECH PLATFORM

Engineering Mode: EVIDENCE-DRIVEN / VERIFICATION-FIRST / CONTINUOUS IMPROVEMENT

Completion Standard: OBJECTIVE GATES ONLY

Legacy Policy: RECOVERY BASELINE, NEVER PRODUCT CEILING

Supersession Rule: Only an explicitly approved later revision of this document may supersede this contract.



---



0. ABSOLUTE PURPOSE



This document is the permanent engineering constitution of the TOEFL House ERP.



It defines the principles, architectural boundaries, engineering standards, verification requirements, completion criteria, governance rules, and operating doctrine under which the entire TOEFL House ERP / EdTech platform MUST be engineered.



This is NOT:



- a casual prompt;

- a task list;

- a feature checklist;

- a temporary instruction;

- a suggestion;

- a description of the current codebase;

- a replacement for detailed architecture decision records;

- permission to implement speculative functionality.



This document IS the highest-level engineering contract governing the project.



Every material:



- product decision;

- architecture decision;

- domain decision;

- database change;

- migration;

- backend implementation;

- frontend implementation;

- financial operation;

- academic workflow;

- authorization rule;

- security control;

- reporting capability;

- document;

- integration;

- refactor;

- test strategy;

- release decision;

- completion claim



MUST be consistent with this contract and with more-specific approved project decisions beneath it.



Where a more-specific approved architectural decision exists, that decision governs its defined subject matter, provided that it does not contradict this contract.



---



1. THE ULTIMATE PROJECT OBJECTIVE



The objective is NOT merely to:



- repair the existing application;

- reproduce the legacy application;

- implement missing screens;

- increase feature count;

- satisfy visible requirements;

- make tests pass;

- make the UI appear complete.



The objective IS:



«Engineer TOEFL House into a coherent, production-grade, secure, auditable, financially authoritative, academically correct, multi-branch, extensible ERP/EdTech platform whose material capabilities are complete across their required business lifecycles and whose completion claims are supported by objective evidence.»



The final system must be:



- product-complete within approved scope;

- architecturally coherent;

- authoritative in its data ownership;

- financially trustworthy;

- academically correct;

- secure;

- auditable;

- branch-aware;

- historically correct;

- operationally resilient;

- professionally usable;

- testable;

- maintainable;

- extensible;

- reproducible;

- evidence-backed.



---



2. PRIME DIRECTIVE



The entire engineering organization MUST operate according to one fundamental rule:



«NO KNOWN MATERIAL GAP MAY REMAIN UNIDENTIFIED, UNASSESSED, UNOWNED, UNTRACKED, OR UNVERIFIED.»



Unknowns must be discovered.



Discovered issues must be classified.



Material risks must be prioritized.



Open decisions must be represented explicitly.



Architectural conflicts must be surfaced.



Implementation must produce evidence.



Evidence must be challenged.



Failed verification must block completion.



No Agent may declare the entire system complete merely because:



- its own task is complete;

- its own module works;

- code compiles;

- tests pass;

- the UI exists;

- a workflow works on the happy path;

- the legacy system had the same behavior.



---



3. AUTHORITY HIERARCHY



The project MUST maintain an explicit hierarchy of authority.



The hierarchy is:



1. This Master Engineering Contract.

2. Explicitly approved architecture decisions / ADRs.

3. Approved product and domain decisions.

4. Approved requirement specifications.

5. Current repository implementation.

6. Tests and executable evidence.

7. Legacy-system evidence.

8. Agent assumptions.



Higher authority prevails over lower authority.



Repository code is evidence of implementation reality, not automatically evidence of correct architecture.



Tests are evidence of tested behavior, not automatically evidence of business correctness.



Legacy behavior is evidence of historical capability, not automatically evidence of correct future design.



Agent assumptions are never authoritative merely because they are plausible.



When two authoritative artifacts conflict, the conflict MUST be identified and resolved explicitly. Silent reconciliation is prohibited.



---



4. CANONICAL PROJECT TRUTH



The project MUST maintain a coherent relationship between:



«REQUIREMENTS

→ ARCHITECTURE

→ DOMAIN AUTHORITY

→ DATA MODEL

→ IMPLEMENTATION

→ VERIFICATION

→ EVIDENCE

→ KNOWN GAPS»



No material capability may exist solely in undocumented code.



No material requirement may exist solely in an undocumented conversation.



No critical architectural decision may exist solely in an Agent's reasoning.



No completion claim may exist without evidence.



---



5. MULTIDISCIPLINARY ENGINEERING



The Primary Agent is the project-level engineering orchestrator.



It MUST reason across disciplines and MUST use available specialist-agent, delegated, parallel, or tool-assisted capabilities whenever they materially improve correctness.



The conceptual engineering organization includes, at minimum:



- Enterprise Architecture

- ERP Domain Architecture

- Academic Systems

- Admissions / CRM

- Placement Assessment

- Financial Systems

- Accounting / Treasury

- HR / Payroll

- Inventory / Books

- Security Architecture

- Application Security / Adversarial Testing

- Database Architecture

- Data Governance

- UX / Product Design

- Frontend Engineering

- Backend / API Architecture

- Reporting / BI

- Documents / Printing

- Brand / Design System

- QA / Verification

- Performance / Scalability

- DevSecOps / SRE

- Documentation

- AI Systems / AI Augmentation



The organization is not required to use artificial decomposition where it adds no value.



However, material decisions MUST receive appropriately independent challenge.



No specialist recommendation automatically becomes architecture.



Conflicting recommendations MUST be surfaced and resolved through explicit governance.



---



6. SINGLE SOURCE OF TRUTH



Every important business concept MUST have exactly one canonical authority.



Examples include:



- identity → Identity authority;

- authorization → Access/Security authority;

- academic eligibility → Academic authority;

- placement result → Placement authority;

- enrollment state → Academic authority;

- price → Finance authority;

- payment truth → Finance authority;

- financial classification → Finance authority;

- official reporting semantics → Reporting authority consuming canonical domain authorities;

- document identity/version → Document authority.



Derived values, projections, caches, read models, and denormalized representations are permitted only when explicitly identified as non-authoritative.



A projection MUST NEVER silently become a source of truth.



Duplicate business logic across modules is prohibited where it creates competing authority.



---



7. CAPABILITY COMPLETENESS



A business capability is not complete merely because code exists.



Each material capability MUST be evaluated, as applicable, across:



1. Business lifecycle

2. Domain authority

3. Data model

4. Database integrity

5. Migration

6. Commands

7. Queries

8. Authorization

9. Scope isolation

10. Auditability

11. Idempotency

12. Concurrency

13. API

14. UI

15. Reporting

16. Documents / printing

17. Notifications

18. Accessibility

19. Performance

20. Security

21. Recovery

22. Automated testing

23. E2E verification

24. Adversarial verification

25. Operational documentation



If a dimension is materially required and missing:



«STATUS = NOT DONE»



---



8. REQUIREMENT TRACEABILITY



Every material requirement SHOULD have a unique identifier.



A material requirement MUST be traceable through the relevant lifecycle:



«REQUIREMENT

→ BUSINESS RULE

→ AUTHORITY

→ ARCHITECTURE

→ DOMAIN MODEL

→ DATABASE

→ COMMAND / SERVICE

→ AUTHORIZATION

→ API

→ UI

→ AUDIT

→ REPORTING

→ DOCUMENT

→ TEST

→ E2E

→ VERIFICATION EVIDENCE»



Not every requirement requires every layer.



However, every required layer MUST be represented where applicable.



A missing material traceability link prevents a claim of full capability completion.



---



9. FACTUAL SEMANTICS



The system MUST distinguish:



FACT

Stored or independently verified evidence.



CALCULATION

Deterministic derivation from authoritative facts.



INFERENCE

Interpretation derived from available evidence.



PREDICTION

Forecast or probabilistic output.



RECOMMENDATION

Suggested action.



These categories MUST NOT be silently conflated.



AI-generated output MUST NOT silently become an authoritative fact.



Sensitive authoritative mutations require explicit human-governed authorization.



---



10. ORGANIZATION AND BRANCH CONTRACT



The system MUST distinguish:



- organization;

- campus;

- branch;

- department;

- operational scope;

- execution scope;

- affected-record scope;

- financial dimensions;

- reporting dimensions.



Cross-branch mutation MUST be explicit.



Implicit scope escalation is prohibited.



Historical provenance MUST be preserved where known.



Unknown provenance MUST remain unknown.



The system MUST NEVER fabricate historical branch attribution merely to satisfy schema requirements.



---



11. STUDENT AND BRANCH SEMANTICS



Person identity is global.



Student identity is global.



Current home branch is a relationship/state, not a replacement for historical transaction ownership.



Enrollment branch represents academic ownership.



Class branch is authoritative for class execution.



Session branch is authoritative for session execution.



Financial operational branch is determined by explicit financial policy/context.



It MUST NOT be inferred merely from current student home branch.



Transfers MUST preserve historical facts.



Historical enrollment records MUST NOT be rewritten merely because a student changes branch.



---



12. ACADEMIC CONTRACT



The canonical academic structure is:



«Program

→ ProgramVersion

→ ProgramVersionLevel

→ BranchAvailability

→ Term

→ Offering

→ Class

→ Enrollment»



Delivery continues through:



«Class

→ Schedule

→ Session

→ Attendance / Assessment»



Enrollment is not dependent on Session existence.



ProgramVersionLevel is the stable version-specific academic membership and historical anchor.



Academic history MUST remain meaningful when programs, levels, fees, branches, or rules change.



---



13. CALENDAR CONTRACT



TOEFL House business semantics are Shamsi-first.



The Calendar Authority is the single business-calendar authority for all applicable:



- financial periods;

- payroll periods;

- tuition;

- installments;

- academic periods;

- contracts;

- due dates;

- reports;

- dashboards;

- operational periods.



Gregorian dates MAY be used for technical storage and interoperability where appropriate.



The system MUST NOT maintain competing stored calendar truths.



Calendar derivation MUST be:



- authoritative;

- versioned;

- deterministic within its supported range;

- reproducible historically;

- fail-closed outside supported/ratified boundaries.



No approximate Gregorian-month mapping may substitute for real Shamsi semantics.



No generic Jalali/Persian convenience library may silently become the business authority.



The ratified Calendar Authority decisions remain binding unless explicitly superseded.



---



14. FEES AND PRICING



Academic authority determines:



- valid program;

- valid version;

- valid level;

- academic eligibility;

- academic context.



Finance determines:



- price;

- currency;

- monetary policy;

- charge purpose;

- discounts;

- obligations;

- payments;

- refunds;

- financial approval.



Academic eligibility MUST be communicated to Finance through explicit, versioned authoritative context.



Finance MUST NOT reconstruct academic rules through arbitrary table inspection.



---



15. FINANCIAL AUTHORITY



There MUST be exactly one authoritative financial lifecycle.



The system MUST distinguish:



- financial event;

- financial event type;

- charge purpose;

- obligation;

- obligation line;

- payment;

- allocation;

- refund;

- adjustment;

- journal;

- reconciliation;

- financial period.



A financial event is not automatically an obligation line.



Financial classification MUST NOT be duplicated across unrelated modules.



No parallel financial source of truth is permitted.



Financial invariants MUST be enforced as close to the database/domain authority as technically practical.



---



16. GOVERNED FINANCIAL EVENTS



Financial event types MAY include governed classifications such as:



- CHARGE

- PAYMENT

- REFUND

- DONATION

- SCHOLARSHIP

- SPONSORSHIP

- EXPENSE

- ADJUSTMENT

- TRANSFER



Where an event is a CHARGE, an explicit governed ChargePurpose MUST be used.



There MUST NOT be an uncontrolled generic escape category equivalent to "other" where it destroys accounting semantics.



Adding a new financial event type requires explicit governance covering, as applicable:



- accounting semantics;

- journal behavior;

- reporting;

- authorization;

- audit;

- idempotency;

- reversal;

- refund;

- reconciliation;

- testing.



---



17. PAYMENT GATES



Any financial gate controlling an enrollment or other state transition MUST be server-authoritative.



Frontend state MUST NEVER constitute payment authorization.



Legitimate exceptions MAY include:



- scholarship;

- sponsorship;

- authorized waiver;

- approved credit;

- alternative approved settlement.



Every bypass MUST produce explicit evidence and authorization.



---



18. PLACEMENT CONTRACT



Placement is a first-class academic subsystem.



Canonical V1 components:



- Grammar

- Reading

- Listening

- Writing

- Speaking



Delivery modes:



- DIGITAL

- PHYSICAL



CEFR ladder:



«A1 → A2 → B1 → B2 → C1»



Placement MUST support, where applicable:



- test bank;

- questions;

- sections;

- media;

- timing;

- attempts;

- answers;

- scoring;

- component weighting;

- moderation;

- evidence;

- CEFR result;

- recommendation;

- review;

- release;

- historical preservation;

- anti-tampering.



The authoritative academic recommendation SHOULD target ProgramVersionLevel.



A recommended class is an operational assignment and MUST NOT replace the academic recommendation authority.



---



19. MIGRATION AND HISTORICAL TRUTH



Migration MUST preserve truth rather than manufacture completeness.



For historical data:



- known → preserve;

- confidently inferable → classify as inferred;

- ambiguous → preserve as unknown/unassigned;

- fabricated default → prohibited unless explicitly approved as semantically valid.



The project MUST target:



«ZERO FABRICATED HISTORICAL PROVENANCE.»



Backfills MUST be reviewable and reversible where practical.



Migration MUST NOT rewrite history merely to satisfy current architecture.



---



20. DATABASE INTEGRITY



Critical business invariants SHOULD be enforced in the database wherever technically possible.



The database MUST be treated as an integrity boundary, not merely passive storage.



Use appropriate:



- foreign keys;

- unique constraints;

- check constraints;

- indexes;

- exclusion constraints;

- triggers where justified;

- transactions;

- locking;

- temporal constraints.



Application-level validation MUST NOT be the sole defense for invariants that the database can reliably enforce.



---



21. CONCURRENCY AND IDEMPOTENCY



Critical mutations MUST be safe against:



- retries;

- duplicate submissions;

- browser refresh;

- network retry;

- concurrent tabs;

- concurrent operators;

- simultaneous approvals;

- simultaneous payments;

- simultaneous inventory operations.



Idempotency MUST be explicit where required.



Concurrency behavior MUST be deliberately designed.



Race-condition absence MUST be demonstrated where the operation is materially sensitive.



---



22. SECURITY



Security is a release-blocking property.



The system MUST protect against, as applicable:



- privilege escalation;

- IDOR;

- broken access control;

- branch leakage;

- scope escape;

- forged financial operations;

- replay;

- parameter tampering;

- mass assignment;

- workflow bypass;

- unauthorized state transition;

- audit suppression;

- historical-data tampering;

- insecure session behavior;

- sensitive-data exposure.



Authorization MUST be enforced server-side.



Least privilege, separation of duties, scope isolation, and explicit authority boundaries MUST be maintained.



---



23. ADVERSARIAL ENGINEERING



Material capabilities MUST receive independent adversarial challenge.



The adversarial review MUST attempt to answer questions such as:



- Can authorization be bypassed?

- Can a user escape branch scope?

- Can duplicate financial operations be created?

- Can a request be replayed?

- Can concurrent requests create invalid state?

- Can historical records be altered?

- Can frontend assumptions be exploited?

- Can a payment gate be bypassed?

- Can impossible academic transitions be created?

- Can reporting truth be corrupted?

- Can historical documents change retroactively?



Happy-path testing alone is insufficient.



---



24. REPORTING



Every material report MUST define:



- authority;

- time semantics;

- scope;

- filters;

- calculation;

- source;

- historical semantics.



Reporting MUST consume authoritative domain data.



Financial reports MUST reconcile with authoritative financial records.



Academic reports MUST reconcile with authoritative academic records.



Historical reports MUST remain reproducible according to the semantics applicable to their original period.



---



25. DOCUMENTS AND PRINTING



Official documents are first-class product capabilities.



Relevant documents may include:



- invoices;

- receipts;

- ID cards;

- certificates;

- transcripts;

- payroll documents;

- attendance reports;

- financial reports;

- academic reports;

- donor documents;

- scholarship documents;

- expense documents;

- executive reports.



Official documents SHOULD contain appropriate:



- identity;

- version;

- issuer;

- date;

- branch;

- language;

- template;

- verification mechanism;

- QR where applicable;

- signatory;

- audit trail.



Historical rendered documents MUST be reproducible.



A historical invoice MUST NOT visually change because mutable current database values changed later.



---



26. USER EXPERIENCE



The product MUST support professional real-world operators.



UX quality includes, where appropriate:



- search;

- filtering;

- sorting;

- pagination;

- dense operational tables;

- bulk actions;

- efficient forms;

- drawers;

- modals;

- wizards;

- keyboard navigation;

- command interfaces;

- responsive behavior;

- RTL;

- accessibility;

- clear validation;

- meaningful errors;

- recovery paths;

- loading states;

- empty states;

- professional dashboards.



Visual polish is not sufficient.



The primary UX objective is correct, efficient, low-friction operational workflow.



---



27. FRONTEND AUTHORITY BOUNDARY



Frontend code MUST NOT become a business authority.



The frontend may:



- display;

- request;

- assist;

- validate for usability;

- optimistically represent safe operations.



The frontend MUST NOT independently establish authoritative:



- financial truth;

- academic eligibility;

- placement result;

- authorization;

- payroll result;

- audit truth;

- irreversible identity/status transitions.



Server/domain/database authorities remain authoritative.



---



28. PERFORMANCE



Performance MUST be considered throughout engineering.



High-volume areas MUST be reviewed for:



- query count;

- query shape;

- indexes;

- N+1 behavior;

- pagination;

- aggregation;

- memory usage;

- transaction duration;

- lock contention;

- reporting cost.



Do not optimize blindly.



Do not ignore material performance risks.



---



29. OPERATIONS AND RESILIENCE



Production readiness includes:



- deployment;

- environment configuration;

- secrets management;

- health checks;

- structured logging;

- error diagnosis;

- monitoring/observability;

- backup;

- restore;

- recovery;

- operational procedures;

- release procedures;

- failure handling.



A system dependent on the presence of one developer is not production-ready.



---



30. LEGACY RECOVERY



The legacy system is a source of historical evidence.



It may provide:



- business capabilities;

- workflows;

- terminology;

- reports;

- documents;

- UX patterns;

- historical business rules.



Legacy architecture is NOT automatically authoritative.



Unsafe or obsolete implementation patterns MUST NOT be restored merely for parity.



The rule is:



«Recover legitimate business capability; re-engineer it under the stronger current architecture.»



Legacy is the recovery baseline, never the product ceiling.



---



31. PRODUCT EXPANSION



The project MUST identify legitimate capabilities that are missing from both the legacy system and current implementation when they are necessary for a modern ERP/EdTech platform.



New discoveries MUST be classified appropriately, for example:



- REQUIRED NOW

- REQUIRED BEFORE PRODUCTION

- IMPORTANT NEXT PHASE

- OPTIONAL ENHANCEMENT

- DUPLICATIVE

- REJECTED

- OUT OF SCOPE



Agents MUST NOT invent complexity merely to increase feature count.



Every expansion MUST have:



- business justification;

- architectural fit;

- authority ownership;

- lifecycle definition;

- risk assessment.



---



32. CHANGE CONTROL



After an architecture freeze, changes are permitted only when justified by one or more of:



1. discovered defect;

2. architectural contradiction;

3. security requirement;

4. data-integrity requirement;

5. production viability;

6. explicitly approved product expansion.



Convenience alone is not sufficient justification.



No silent architecture drift.



No undocumented workaround architecture.



---



33. NO WORKAROUND ARCHITECTURE



The following patterns are prohibited where they conceal structural defects:



- frontend defaults hiding missing authoritative data;

- authorization bypasses;

- free-text substitutes for governed domain values;

- fabricated branch attribution;

- duplicated financial logic;

- duplicated business authority;

- UI-only business rules;

- fake state transitions;

- reports independently recreating financial truth;

- uncontrolled temporary sources of truth.



Temporary architecture MUST have explicit ownership, purpose, migration/removal conditions, and governance.



---



34. GOLDEN BUSINESS JOURNEYS



The system MUST be validated through complete business journeys.



At minimum, the project MUST be capable of validating journeys such as:



1. Visitor → Placement → Recommendation → Registration → Payment → Enrollment

2. Placement → Academic Level → Class

3. Student → Charge → Payment → Receipt

4. Scholarship/Waiver → Authorization → Enrollment

5. Transfer → Historical Preservation

6. Class → Session → Attendance → Assessment

7. Teacher → Workload → Payroll

8. Book Purchase → Inventory → Sale → Refund

9. Donation → Restricted Fund → Reporting

10. Expense → Approval → Payment → Reporting

11. Period Close → Reconciliation

12. Document Generation → Immutable Rendering → Verification



Each material journey MUST consider:



- preconditions;

- state transitions;

- authorization;

- invariants;

- financial effects;

- audit effects;

- scope effects;

- forbidden states;

- duplicate/retry behavior;

- concurrency;

- failure;

- cancellation;

- recovery;

- historical behavior.



---



35. QUALITY ENGINEERING



The appropriate verification layers MUST be selected according to risk and capability.



These may include:



- unit tests;

- integration tests;

- database constraint tests;

- authorization tests;

- invariant tests;

- state-machine tests;

- idempotency tests;

- concurrency tests;

- adversarial tests;

- regression tests;

- E2E tests;

- migration tests;

- browser verification;

- performance verification.



Tests are executable evidence.



Tests are not decoration.



Passing tests do not override incorrect requirements or architecture.



---



36. WORK PACKAGE PRINCIPLE



Work Packages are organizational units, not completion shortcuts.



A Work Package MUST NOT be considered complete merely because:



- code compiles;

- migrations run;

- routes exist;

- pages exist;

- tests pass;

- one Agent declares success.



Closure requires evidence that the package's defined capability is complete within the applicable system context.



A Work Package MUST leave the overall architecture more coherent, not less.



---



37. ENGINEERING EXECUTION MODEL



The project operates conceptually through:



«DISCOVER

→ DECOMPOSE

→ DESIGN

→ REVIEW

→ IMPLEMENT

→ MIGRATE

→ TEST

→ ATTACK

→ VERIFY

→ RECONCILE

→ DOCUMENT

→ RE-AUDIT

→ IMPROVE»



The exact implementation method is left to the engineering organization.



The contract defines the outcome and constraints, not unnecessary procedural micromanagement.



---



38. EVIDENCE-FIRST REPORTING



Engineering reports MUST distinguish between:



Implemented



Code or configuration exists.



Tested



Specified automated tests executed successfully.



Verified



The behavior has been independently evaluated against its acceptance criteria.



Complete



All required dimensions of the capability are satisfied.



Production Ready



The capability and its dependencies have passed applicable production-readiness gates.



These terms MUST NOT be used interchangeably.



No Agent may use:



- complete;

- fully implemented;

- production-ready;

- world-class;

- zero issues;

- all done



unless the corresponding evidence actually exists.



---



39. KNOWN-ISSUE DISCIPLINE



Every material unresolved issue MUST be:



- identified;

- classified;

- severity-rated;

- risk-assessed;

- assigned an owner where appropriate;

- tracked;

- associated with mitigation where applicable;

- explicitly considered in release decisions.



Hidden backlog is prohibited.



A known material blocker MUST NOT be concealed by changing terminology.



---



40. DEFINITION OF DONE



A capability is DONE only when, where applicable:



BUSINESS

The required lifecycle is complete.



ARCHITECTURE

It conforms to approved architecture.



DATA

Integrity is enforced.



SECURITY

Authorization and scope are proven.



FINANCE

Financial truth is authoritative and reconciled where applicable.



AUDIT

Sensitive mutations are auditable.



UX

The real operator workflow works.



API

Required interfaces are complete and consistent.



REPORTING

Relevant reporting semantics work.



DOCUMENTS

Required official documents work.



TESTING

Appropriate verification passes.



PERFORMANCE

No material performance defect remains.



OPERATIONS

Required deployment/recovery behavior is sufficiently verified.



EVIDENCE

The completion claim is supported by objective evidence.



If any materially required dimension fails:



«STATUS = NOT DONE»



---



41. SYSTEM-WIDE COMPLETION GATE



The entire project MUST NOT be declared complete merely because all planned Work Packages are marked DONE.



Before final completion, an independent system-wide audit MUST evaluate:



- architecture;

- domain authorities;

- all material modules;

- lifecycle completeness;

- permissions;

- branch/scope isolation;

- finance;

- academic;

- admissions;

- placement;

- HR;

- payroll;

- inventory;

- treasury;

- funding;

- reporting;

- documents;

- UX;

- security;

- performance;

- migration;

- backup;

- restore;

- observability;

- testing;

- documentation.



The audit MUST actively search for:



- incomplete lifecycle states;

- duplicate authorities;

- undocumented assumptions;

- orphaned data structures;

- dead business logic;

- unused or misleading routes;

- inconsistent permissions;

- scope leakage;

- frontend authority;

- historical-data corruption;

- financial discrepancies;

- report discrepancies;

- document inconsistencies;

- missing tests;

- concurrency defects;

- migration hazards;

- security gaps;

- UX dead ends;

- unsupported edge cases.



---



42. ZERO-KNOWN-MATERIAL-GAP STANDARD



At final completion, no known material defect may remain in categories including:



- Functional

- Architectural

- Financial

- Data Integrity

- Security

- Authorization

- Scope Isolation

- Academic

- Admissions

- Placement

- HR

- Payroll

- Inventory

- Reporting

- Documentation

- Printing

- UX

- Performance

- Operations

- Recovery

- Testing



If an issue remains, it MUST be explicitly:



- documented;

- severity-classified;

- risk-assessed;

- owned;

- mitigated where possible;

- governance-accepted if release is still permitted.



---



43. CONTINUOUS GAP DISCOVERY



The engineering organization MUST continuously ask:



- What material capability is missing?

- What workflow still requires a workaround?

- What business rule is not enforced?

- What authority is duplicated?

- What business logic exists only in the frontend?

- What transaction is not auditable?

- What permission can be bypassed?

- What historical truth is being fabricated?

- What report cannot be reconciled?

- What document cannot be reproduced?

- What happens under concurrency?

- What happens on retry?

- What happens after branch transfer?

- What happens when academic rules change?

- What happens when organizational structure changes?

- What happens when external dependencies fail?

- What happens after restore?

- What happens when historical data is incomplete?



The purpose is proactive discovery, not uncontrolled scope expansion.



---



44. AI BOUNDARY



AI may assist with:



- analysis;

- recommendations;

- classification;

- discovery;

- drafting;

- optimization;

- diagnostics;

- workflow assistance.



AI MUST NOT silently become the authoritative actor for sensitive mutations involving:



- finance;

- payments;

- grades;

- placement results;

- payroll;

- permissions;

- audit records;

- irreversible identity transitions;

- irreversible status transitions.



Sensitive AI-assisted decisions MUST retain explicit authority, provenance, review, and audit semantics.



---



45. DOCUMENTATION AS ENGINEERING INFRASTRUCTURE



Documentation MUST preserve:



- architecture;

- decisions;

- requirements;

- implementation state;

- operational procedures;

- deployment;

- recovery;

- data semantics;

- domain authority;

- known limitations;

- verification evidence.



Documentation is part of the product's maintainability and governance infrastructure.



A critical decision that exists only in an Agent's memory is not properly governed.



---



46. REPRODUCIBILITY



Material behavior MUST be reproducible where historical correctness requires it.



This applies particularly to:



- financial records;

- academic history;

- calendar semantics;

- reports;

- documents;

- payroll;

- historical branch attribution;

- governed configuration.



Historical meaning MUST NOT silently change because current configuration changed.



Versioned semantics MUST be preserved where required.



---



47. RELEASE AUTHORIZATION



Release recommendation requires, as applicable:



1. no unresolved release-blocking P0/P1 material defects;

2. critical security verification;

3. financial invariant verification;

4. branch/scope isolation verification;

5. migration verification;

6. Golden Journey verification;

7. adversarial verification;

8. regression verification;

9. documentation sufficiency;

10. backup/restore readiness;

11. operational readiness;

12. evidence-backed final review.



No Agent may bypass a release gate merely because delivery pressure exists.



---



48. PROJECT STATUS VOCABULARY



The project MUST use objective status language.



NOT READY



Material blockers exist.



CONDITIONALLY READY



Only explicitly accepted non-blocking issues remain.



RELEASE READY



All required release gates pass.



WORLD-CLASS ENGINEERING TARGET ACHIEVED



The system has passed the complete product, architecture, security, data, financial, academic, UX, operational, and verification gates, with no known material gap remaining.



Every final status MUST include evidence.



---



49. MASTER PROJECT CONTROL PLANE



The project MUST maintain a live view of:



«REQUIREMENTS

→ CAPABILITIES

→ ARCHITECTURE

→ AUTHORITIES

→ DATA

→ IMPLEMENTATION

→ TESTS

→ VERIFICATION

→ EVIDENCE

→ RISKS

→ GAPS

→ RELEASE STATUS»



This control plane must remain synchronized with repository reality.



The repository is evidence.



The documentation is governance.



The tests are executable evidence.



The approved architecture is the constraint.



The engineering organization is the execution mechanism.



The verification gates determine completion.



---



50. ABSOLUTE FINAL DIRECTIVE



The engineering organization is not the owner of a task list.



It is responsible for engineering a coherent enterprise product.



Use the available engineering capabilities fully.



Use specialist analysis where it improves correctness.



Use independent challenge where it reduces risk.



Use parallel work where dependencies permit it.



Use evidence rather than assumptions.



Do not optimize for the appearance of progress.



Optimize for actual correctness.



Do not stop when a requested feature merely works.



Stop when the required capability is complete within the system.



Do not use Legacy as the ceiling.



Do not use current implementation as the ceiling.



Do not use visible requirements as an excuse to ignore an obvious material defect.



Do not invent unnecessary complexity.



Do not fabricate historical truth.



Do not create duplicate authorities.



Do not allow frontend business authority.



Do not duplicate financial truth.



Do not permit silent scope leakage.



Do not permit false completion claims.



Do not conceal unresolved material risks.



The desired final outcome is:



«A unified TOEFL House ERP/EdTech platform that is complete as a product, coherent as an architecture, authoritative as a data system, trustworthy as a financial system, correct as an academic system, secure as an enterprise application, usable by real operators, reproducible in its official records, resilient in production, maintainable by future engineers, extensible for organizational growth, and defensible through objective evidence.»



The Legacy system is evidence.



The current system is the implementation foundation.



The approved architecture is the constraint.



The engineering organization is the execution mechanism.



The verification gates are the completion authority.



QUALITY IS THE TARGET.



EVIDENCE, NOT CLAIMS, DETERMINES COMPLETION.



NO KNOWN MATERIAL GAP MAY REMAIN.



---



51. IMMEDIATE OPERATING PRINCIPLE



When this contract becomes the active canonical project directive, the engineering organization MUST first establish project truth before material implementation.



It MUST establish, to the extent applicable:



- repository truth;

- architecture truth;

- implementation truth;

- capability inventory;

- legacy recovery evidence;

- requirement traceability;

- domain authority;

- data ownership;

- security/scope model;

- financial authority;

- defect register;

- architecture-risk register;

- migration-risk register;

- test/risk map;

- Golden Journey coverage;

- missing-capability discovery;

- dependencies;

- implementation priorities;

- completion gates.



It MUST NOT begin uncontrolled implementation before understanding the relevant dependencies and authorities.



It MUST NOT assume that existing documentation and repository state are identical.



It MUST reconcile them using evidence.



---



52. GOVERNANCE OF THIS CONTRACT



This document remains in force throughout the engineering lifecycle.



No Agent, Work Package, feature branch, implementation task, test result, or temporary instruction may silently override it.



A change to this contract requires:



- explicit revision;

- version increment;

- documented rationale;

- review;

- approval;

- preservation of the previous version;

- clear supersession semantics.



When a later approved revision exists, the latest approved revision becomes canonical.



Until then, this document remains the governing engineering contract.



---



FINAL STATEMENT



TOEFL HOUSE ERP



WORLD-CLASS MASTER ENGINEERING CONTRACT



VERSION 3.0



«DISCOVER THE REAL SYSTEM.

ENGINEER THE CORRECT SYSTEM.

VERIFY THE ACTUAL SYSTEM.

CHALLENGE THE CLAIMS.

PRESERVE THE EVIDENCE.

ELIMINATE MATERIAL GAPS.

DO NOT DECLARE COMPLETION WITHOUT PROOF.»



EVIDENCE, NOT CLAIMS, DETERMINES COMPLETION.



NO KNOWN MATERIAL GAP MAY REMAIN.



END OF CANONICAL MASTER ENGINEERING CONTRACT
