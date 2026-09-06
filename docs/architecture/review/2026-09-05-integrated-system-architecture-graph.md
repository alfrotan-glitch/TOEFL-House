# TOEFL House — Integrated Enterprise System Architecture Graph

**Document:** `docs/architecture/review/2026-09-05-integrated-system-architecture-graph.md`  
**Date:** 2026-09-05  
**Status:** Target Architecture / Governing Architecture Specification  
**Scope:** Enterprise-wide logical architecture for TOEFL House  
**Primary objective:** One coherent system graph in which every major fact has one authoritative owner, every workflow has an explicit path, every action has enforceable authority, every cross-domain relationship is typed, and every important failure has defined behavior.

> **Important scope note:** This document is the reconstructed target architecture derived from the governing mandate and architectural critique supplied for this review. It is not a claim that an unseen repository already conforms to it. Repository conformance must be established by a subsequent code/schema/API audit.

**A. Executive System Map**

TOEFL House is modeled as **one enterprise organism**, not as a collection of independent modules.

The architecture has four layers of responsibility:

```
TOEFL HOUSE ENTERPRISE
│
├── 1. REALITY / FOUNDATION
│   ├── Organization
│   ├── Organizational structure
│   ├── People / Identity
│   ├── Time / Periods
│   └── Organizational context / provenance
│
├── 2. BUSINESS AUTHORITIES
│   ├── Workforce / Employment
│   ├── CRM / Admissions
│   ├── Placement / Assessment
│   ├── Student Lifecycle
│   ├── Academic Delivery
│   ├── Scheduling / Facilities
│   ├── Enrollment
│   ├── Finance
│   └── Payroll
│
├── 3. PLATFORM COORDINATION / EVIDENCE
│   ├── Authorization
│   ├── Work Management
│   ├── Documents
│   ├── Communication
│   ├── Events / Outbox
│   └── Notifications
│
└── 4. DISCOVERY / CONTROL
    ├── Search
    ├── Reporting / Analytics
    ├── Audit / Forensics
    └── Management Decision Support
```

The fundamental rule is:

```
ONE FACT
      ↓
ONE AUTHORITATIVE OWNER
      ↓
MANY READERS / PROJECTIONS
```

No UI, workspace, workflow engine, report, search index, document, notification, or event may silently become a second business authority.

**Enterprise graph**

```
OWNER / MANAGEMENT
        │
        ▼
ORGANIZATION ───────► ORGANIZATIONAL CONTEXT
        │                         │
        │                         ├── branch
        │                         ├── department / unit
        │                         ├── cost center
        │                         └── reporting scope
        │
        ▼
      PEOPLE
        │
        ├────────► IDENTITY / ACTOR
        │                │
        │                ├── authentication
        │                └── authorization context
        │
        ├────────► WORKFORCE / EMPLOYMENT
        │                │
        │                ├── position
        │                ├── assignment
        │                └── payroll inputs
        │
        └────────► CUSTOMER / ADMISSION / STUDENT PARTICIPATION
                         │
                         ├── CRM
                         ├── Admissions
                         ├── Placement
                         └── Student Lifecycle
                                    │
                                    ▼
                               ACADEMIC
                                    │
                       ┌────────────┴────────────┐
                       ▼                         ▼
                   OFFERING                 SCHEDULING
                       │                         │
                       └────────────┬────────────┘
                                    ▼
                                ENROLLMENT
                                    │
                                    ▼
                                  CLASS
                                    │
                                    ▼
                                 SESSION
                              ┌─────┴─────┐
                              ▼           ▼
                         ATTENDANCE   ASSESSMENT
                              │           │
                              └─────┬─────┘
                                    ▼
                            ACADEMIC RECORD
                                    │
                                    ▼
                               PROGRESSION
                                    │
                             ┌──────┴──────┐
                             ▼             ▼
                         COMPLETION     REPEAT / APPEAL
                             │
                             ▼
                         CREDENTIAL

Business sources ──────► FINANCE ◄────── PAYROLL
                           │
                    ┌──────┼──────┐
                    ▼      ▼      ▼
                  AR/AP   CASH    GL / SUBLEDGER
                    │      │      │
                    └──────┴──────┘
                           │
                           ▼
                    FINANCIAL TRUTH

ALL AUTHORITATIVE DOMAINS
             │
     ┌───────┼────────┬────────┬────────┐
     ▼       ▼        ▼        ▼        ▼
 WORKFLOW DOCUMENT COMMUNICATION SEARCH REPORTING
     │       │        │        │        │
     └───────┴────────┴────────┴────────┘
                      │
                      ▼
                    AUDIT
                      │
                      ▼
                 MANAGEMENT
```

**Typed enterprise relationship vocabulary**

Every architecture edge must be classified. `A → B` alone is insufficient.

```
OWNS                authoritative state / fact ownership
CREATES             originates a business record under domain authority
READS               obtains data without ownership
COMMANDS            requests a state-changing operation
AUTHORIZES          supplies authorization for an action
VALIDATES           checks preconditions / invariants
DEPENDS_ON          architectural prerequisite
CONSUMES_EVENT      reacts to an emitted event
EMITS_EVENT         publishes a domain/integration event
PROJECTS            builds a read representation
DOCUMENTS           renders evidence of an authoritative state/fact
ASSIGNS             routes work to an actor / queue
ESCALATES           moves work toward a stronger authority or SLA path
CORRELATES          links causal work across contexts
REFERENCES          maintains a stable external identity/reference
```

**B. Complete Connected Domain Graph**

**B1. Foundation graph**

```
ORGANIZATION
│
├── organizational units
├── campuses (optional hierarchy)
├── branches / operational locations
├── departments
├── cost centers
└── reporting structures
        │
        ├──────────────► PEOPLE
        ├──────────────► WORKFORCE
        ├──────────────► CRM / ADMISSIONS
        ├──────────────► ACADEMIC
        ├──────────────► FINANCE
        └──────────────► REPORTING
```

**Organization authority:** owns organization identity, organizational relationships, legal/operational identity, and organizational lifecycle.

**Creates:** organizational units, branches, scoped organizational relationships.

**Reads:** foundation consumers and management reporting.

**Changes:** authorized administrators through canonical organization commands.

**Authorizes:** organizational-scope administration, not individual business facts belonging to other domains.

**Depends on:** none beyond system identity and time.

**Produces:** organizational context.

**Events:** `OrganizationCreated`, `BranchCreated`, `BranchActivated`, `BranchSuspended`, `OrganizationalUnitChanged`.

**Consumes:** authorized administrative commands and governed master-data changes.

**Next:** context becomes available to identity, workforce, admissions, academic, finance, and reporting.

**B2. People and identity graph**

```
PERSON
 │
 ├── identity profile
 ├── contact methods
 ├── addresses
 ├── relationships
 └── participations / roles
       │
       ├── Applicant
       ├── Student
       ├── Employee
       ├── Guardian / Contact
       └── External / Authorized Actor
```

`Person` owns human identity facts. It does not own employment, admission, academic, or financial state merely because those records point to a person.

The identity model is:

```
PERSON
  ↓
IDENTITY ACCOUNT
  ↓
AUTHENTICATION
  ↓
ACTOR CONTEXT
  ↓
AUTHORIZATION DECISION
```

A person can participate in multiple domains simultaneously without creating duplicate identity records.

**B3. Workforce graph**

```
PERSON
 ↓
EMPLOYEE PARTICIPATION
 ↓
EMPLOYMENT
 ↓
POSITION
 ↓
ASSIGNMENT
 ↓
ORGANIZATIONAL SCOPE
 ↓
WORK ELIGIBILITY
 ↓
WORK / ATTENDANCE / SESSION FACTS
 ↓
VALIDATED PAYROLL INPUT
 ↓
PAYROLL CALCULATION
 ↓
PAYROLL RESULT
 ↓
PAYROLL LIABILITY
 ↓
FINANCE
```

**Workforce owns:** employment truth, position, assignment, employment state, HR lifecycle.

**Payroll owns:** payroll calculation result and payroll-period process state.

**Finance owns:** monetary liability and accounting truth.

**B4. Customer / Admissions graph**

```
CAMPAIGN / SOURCE
       ↓
PROSPECT / CONTACT
       ↓
LEAD
       ↓
ADMISSION CASE
       ↓
APPLICANT PARTICIPATION
       ↓
APPLICATION
       ↓
REQUIREMENTS / DOCUMENTS
       ↓
PLACEMENT
       ↓
ELIGIBILITY
       ↓
ADMISSION DECISION
       ↓
STUDENT PARTICIPATION
```

Applicant is a participation context; Application is a distinct request/case. One person may have multiple applications while retaining one person identity.

**B5. Placement graph**

```
APPLICATION / PLACEMENT REQUEST
            ↓
PLACEMENT ATTEMPT
            ↓
MEASUREMENT / EVIDENCE
            ↓
SCORING
            ↓
PLACEMENT RESULT
            ↓
CEFR / OTHER CLASSIFICATION
            ↓
RECOMMENDATION
            ↓
ACADEMIC ELIGIBILITY SNAPSHOT
            ↓
ADMISSIONS / ACADEMIC DECISION
```

Placement does not directly assign a class.

**B6. Student graph**

```
PERSON
 ↓
STUDENT PARTICIPATION
 ↓
PROGRAM / LEVEL CONTEXT
 ↓
OFFERING ELIGIBILITY
 ↓
FINANCIAL ELIGIBILITY
 ↓
ENROLLMENT REQUEST
 ↓
ENROLLMENT DECISION
 ↓
CLASS / SECTION
 ↓
SESSION
 ↓
ACADEMIC RECORD
 ↓
PROGRESSION
 ↓
COMPLETION
 ↓
GRADUATION
 ↓
CREDENTIAL
 ↓
ALUMNI PARTICIPATION
```

**B7. Academic graph**

```
PROGRAM
 ↓
PROGRAM VERSION
 ↓
LEVEL
 ├── skills
 ├── prerequisites
 └── progression rules
 ↓
BRANCH / DELIVERY AVAILABILITY
 ↓
OFFERING
 ├── term
 ├── branch
 ├── capacity
 ├── eligibility
 └── delivery constraints
 ↓
ENROLLMENT
 ↓
CLASS / SECTION
 ↓
SESSION PLAN
 ↓
SESSION DELIVERY
 ├── attendance
 ├── assessment
 └── instructional facts
 ↓
ACADEMIC RECORD
 ↓
PROGRESSION
 ↓
COMPLETION
```

**B8. Scheduling graph**

```
ACADEMIC DEMAND
     │
     ├── class
     ├── teacher
     ├── room
     ├── branch
     ├── student constraints
     └── time constraints
            ↓
      SCHEDULING MODEL
            ↓
      CONSTRAINT CHECK
            ├── teacher conflict
            ├── room conflict
            ├── class conflict
            ├── capacity conflict
            ├── availability conflict
            └── period/holiday conflict
            ↓
       SCHEDULE DECISION
            ↓
          SESSION
```

Scheduling is a planning/constraint authority. It does not own academic results or payroll money.

**B9. Enrollment graph**

Enrollment is its own authority for the enrollment decision, while consuming academic and financial eligibility.

```
ENROLLMENT REQUEST
 │
 ├──► academic eligibility query / snapshot
 │
 ├──► offering capacity / availability
 │
 └──► financial eligibility query / gate
              │
              ▼
       ENROLLMENT DECISION
              │
        ┌─────┴─────┐
        ▼           ▼
    ENROLLED      REJECTED / PENDING
        │
        ▼
    CLASS MEMBERSHIP
```

Finance does not decide that a student is enrolled. Academic does not decide the financial gate. Enrollment combines the governed inputs into the enrollment decision.

**B10. Finance graph**

```
BUSINESS SOURCE FACT
 ├── admissions / registration
 ├── enrollment
 ├── services
 ├── payroll
 └── approved financial operations
          ↓
FINANCIAL OBLIGATION
          ↓
BILLING / AR OR AP
          ↓
SETTLEMENT
 ├── payment
 ├── credit
 ├── waiver
 ├── discount
 └── refund
          ↓
ALLOCATION / APPLICATION
          ↓
ACCOUNTING EVENT
          ↓
SUBLEDGER
          ↓
GENERAL LEDGER
          ↓
RECONCILIATION / CLOSE
          ↓
FINANCIAL REPORTING
```

**B11. Platform graph**

```
AUTHORITATIVE DOMAIN CHANGE
          │
          ├──► DOMAIN EVENT
          │       │
          │       ▼
          │   TRANSACTIONAL OUTBOX
          │       │
          │       ▼
          │   EVENT DELIVERY
          │       │
          │   ┌───┼───────────┬───────────┬──────────┐
          │   ▼   ▼           ▼           ▼          ▼
          │ Workflow Communication Reporting Search Audit
          │
          ├──► DOCUMENT REQUEST → DOCUMENT SNAPSHOT
          │
          └──► READ PROJECTION / WORK DISCOVERY
```

**C. Domain Boundaries**

The target logical bounded contexts are:

ContextPrimary responsibilityAuthoritative factsMust not ownOrganizationorganizational realityorg/unit/branch structureenrollment, moneyIdentityperson/account identityperson identity, account identityemployment status, paymentsWorkforceemploymentemployment, position, assignmentaccounting truthAuthorizationaccess decisionspolicy/configuration and decision inputsbusiness stateCRMprospect/customer interactionlead, interaction, follow-upstudent enrollmentAdmissionsapplication/admission caseapplications, admission processacademic records, moneyPlacementplacement measurementattempts, evidence, scores, resultfinal class assignmentStudent Lifecyclestudent participation statestudent lifecycle identity/statuspayment ledgerAcademiccurriculum and academic recordsprogram, level, academic record, progressionmonetary truthSchedulingdelivery planningtimetable, room/teacher schedulingacademic gradesEnrollmentenrollment decision/membershipenrollment statepayment ledger, payrollFinancemonetary truthobligations, transactions, allocation, accountingacademic truthPayrollpayroll calculationpayroll runs/results/input validationgeneral ledger truthWorkflowprocess coordinationprocess instances, work statebusiness factsDocumentsdocumentary evidencerendered/versioned document artifactoriginal business factCommunicationoutbound communicationcommunication intent/delivery statebusiness stateReportinggoverned analytical viewsreporting models/projectionsoperational authoritySearchdiscoverabilitysearch indexsource-of-truth recordsAuditevidence trailaudit/security evidencebusiness-state authority

These are logical boundaries. They do **not** require one microservice per context.

**Boundary rule**

A context may:

```
READ another context's published/query contract
SEND a command through a defined application boundary
CONSUME an event
KEEP a local projection/reference
```

A context may not:

```
UPDATE another context's authoritative tables directly
RE-derive another context's truth as a second authority
ASSUME UI visibility equals authorization
USE a report/search index as business truth
```

**D. Authority Graph**

**D1. Core authority map**

```
ORGANIZATION
  owns → organizational truth

IDENTITY / PEOPLE
  owns → person identity truth

WORKFORCE
  owns → employment truth

AUTHORIZATION
  owns → access policy/decision mechanism

CRM
  owns → prospect/lead relationship truth

ADMISSIONS
  owns → application/admission process truth

PLACEMENT
  owns → placement measurement/evidence/result

STUDENT LIFECYCLE
  owns → student participation lifecycle

ACADEMIC
  owns → curriculum/academic record/progression

SCHEDULING
  owns → scheduling/availability planning

ENROLLMENT
  owns → enrollment membership/decision

FINANCE
  owns → monetary/accounting truth

PAYROLL
  owns → payroll calculation/run truth

WORKFLOW
  owns → process/work state, not domain state

DOCUMENTS
  owns → rendered documentary evidence

COMMUNICATION
  owns → delivery state and communication history

REPORTING
  owns → analytical projection, not source truth

SEARCH
  owns → search representation, not source truth

AUDIT
  owns → evidence of actions/attempts, not source truth
```

**D2. Authority test**

For each field or state in implementation, ask:

```
Who can declare this value authoritative?
Who can change it?
Who can invalidate it?
What command changes it?
What invariant protects it?
What event announces the change?
```

If two contexts answer the first question with the same fact, the architecture has a source-of-truth defect.

**D3. Effective authority**

Effective authority is a decision result, not an independent business-state authority:

```
ACTOR
 │
 ├── identity
 ├── role
 ├── relationships
 ├── scope
 ├── lifecycle state
 ├── delegation
 ├── revocation
 └── request context
          │
          ▼
    AUTHORIZATION POLICY
          │
          ▼
   AUTHORIZATION DECISION
     ┌────────┴────────┐
     ▼                 ▼
   ALLOW              DENY
```

Fine-grained authorization should be resource- and relationship-aware rather than assuming role names are sufficient. Current OpenFGA guidance describes authorization as relationships between users and resources and supports RBAC/ReBAC/ABAC-style modeling. citeturn775489search1turn775489search5turn775489search8

**E. Dependency Graph**

Dependencies are typed and intentionally non-circular.

**E1. Foundation dependencies**

```
Organization
   ↓
Organizational Context
   ↓
People / Identity
   ↓
Actor Context
   ↓
Authorization
```

**E2. Business dependencies**

```
CRM
  ↓
Admissions
  ↓
Placement
  ↓
Academic Eligibility
  ↓
Admission Decision
  ↓
Student Lifecycle
  ↓
Academic / Offering
  ↓
Enrollment
  ↓
Academic Delivery
```

Finance is a cross-domain authority, not an upstream owner of academic truth:

```
Admissions ─────┐
Enrollment ─────┤
Services ───────┤
Payroll ────────┘
       ↓
     Finance
```

**E3. Permitted cycle-like interaction**

A query followed by an event is acceptable:

```
Enrollment ──query──► Finance
Enrollment ◄─event── FinancialEligibilityChanged
```

This is not the same as a circular write dependency.

**E4. Forbidden dependency**

```
Academic ──writes──► Finance
Finance ──writes──► Academic
```

Both are forbidden. They must communicate through contracts.

**F. Data-Flow Graph**

**F1. Write flow**

```
USER / EXTERNAL ACTOR
        ↓
API / APPLICATION COMMAND
        ↓
AUTHENTICATION
        ↓
AUTHORIZATION
        ↓
COMMAND VALIDATION
        ↓
DOMAIN AUTHORITY
        ↓
AGGREGATE / CONSISTENCY BOUNDARY
        ↓
TRANSACTION
        ├── authoritative state change
        ├── audit evidence as required
        └── outbox record
        ↓
COMMIT
```

**F2. Read flow**

```
USER / WORKSPACE
       ↓
AUTHORIZED QUERY
       ↓
QUERY MODEL / READ MODEL
       ↓
CANONICAL / PROJECTION DATA
       ↓
FILTERED RESPONSE
```

**F3. Projection flow**

```
AUTHORITATIVE FACT
       ↓
DOMAIN EVENT
       ↓
OUTBOX
       ↓
EVENT DELIVERY
       ↓
CONSUMER
       ↓
IDEMPOTENCY CHECK
       ↓
READ PROJECTION
```

A projection can be stale and must expose/handle freshness expectations appropriately. It must never be promoted to authoritative business state.

**G. API-Flow Graph**

**G1. Query path**

```
HTTP GET / query
        ↓
Authentication
        ↓
Authorization: can_read(resource, actor, context)
        ↓
Query handler
        ↓
Governed read model
        ↓
Response DTO
```

**G2. Command path**

```
HTTP POST / PUT / PATCH / command
             ↓
Authentication
             ↓
Authorization
             ↓
Idempotency check when required
             ↓
Command handler
             ↓
Domain validation / invariant check
             ↓
Transaction
             ├── state change
             └── outbox
             ↓
Commit
             ↓
202 / 200 / 409 / 422 / 403 / 404 as contractually appropriate
```

**G3. API boundary law**

The API layer must not become a second domain layer.

```
Controller
  ≠ business authority

Service / Application Handler
  = command orchestration

Domain Authority
  = invariant + authoritative state decision
```

**H. Event / Outbox Graph**

**H1. Transactional event model**

```
CANONICAL COMMAND
      ↓
DOMAIN AUTHORITY
      ↓
DB TRANSACTION
      ├── business fact/state
      └── transactional outbox message
      ↓
COMMIT
      ↓
OUTBOX RELAY
      ↓
EVENT BUS / DELIVERY
      ↓
CONSUMERS
```

The transactional outbox pattern is appropriate when the business state change and message publication must be coordinated without distributed two-phase commit; relay delivery can be repeated, therefore consumers must be idempotent. citeturn775489search6

**H2. Event layers**

```
Domain Event
  = internal declaration that something important happened

Integration Event
  = contract intended for another bounded context / integration boundary

Notification Event
  = communication-oriented trigger
```

Do not treat all three as synonyms.

**H3. Event envelope**

Each important event should support:

```
message_id
aggregate_type
aggregate_id
aggregate_version
event_type
event_version
occurred_at
recorded_at
organization_id
operational_context_id
actor_id
correlation_id
causation_id
payload
```

**H4. Consumer safety**

```
EVENT
 ↓
message_id seen?
 ├── YES → return idempotent success / no duplicate effect
 └── NO  → process → record consumer receipt
```

Microsoft Dynamics business-event/workflow patterns likewise distinguish workflow tasks, approvals, automated tasks and generated work items instead of treating every workflow artifact as one concept. citeturn775489search0turn775489search2

**I. Financial Flow Graph**

**I1. Monetary truth**

Finance is the sole monetary authority.

```
BUSINESS SOURCE
     │
     ├── admission / registration
     ├── enrollment
     ├── service delivery
     ├── payroll
     └── approved adjustment source
            ↓
      FINANCIAL OBLIGATION
            ↓
      BILLING / AR OR AP
            ↓
         SETTLEMENT
            │
      ┌─────┼────────────┐
      ▼     ▼            ▼
   PAYMENT CREDIT      REFUND
      │     │            │
      └─────┴────────────┘
              ↓
          ALLOCATION
              ↓
       ACCOUNTING EVENT
              ↓
          SUBLEDGER
              ↓
       GENERAL LEDGER
              ↓
     BANK / RECONCILIATION
              ↓
       PERIOD CLOSE
              ↓
     FINANCIAL REPORTING
```

**I2. Required separation**

```
Payment
  ≠
Accounting Entry

Financial Eligibility
  ≠
Enrollment Decision

Payroll Result
  ≠
Finance Ledger Entry

Receipt Document
  ≠
Payment Truth
```

**I3. Financial correction model**

Never mutate historical money silently.

```
Incorrect Fact
   ↓
Correction / Reversal / Compensating Entry
   ↓
New authoritative fact
   ↓
Event
   ↓
Updated projections
```

**J. Employee Lifecycle Graph**

```
PERSON
 ↓
EMPLOYEE PARTICIPATION
 ↓
EMPLOYMENT OFFER / CREATION
 ↓
ACTIVE EMPLOYMENT
 ↓
POSITION
 ↓
ASSIGNMENT
 ↓
ORGANIZATIONAL SCOPE
 ↓
CAPABILITY / ROLE
 ↓
WORK ASSIGNMENTS
 │
 ├── admissions tasks
 ├── academic tasks
 ├── approvals
 ├── scheduling
 └── finance preparation tasks
 ↓
LEAVE / SUSPENSION / OTHER STATE
 ↓
TERMINATION
 ↓
FINAL PAYROLL / CLEARANCE
 ↓
HISTORICAL EMPLOYMENT RECORD
```

Current employment status must not erase historical assignments.

**Employee authority journey**

```
LOGIN
 ↓
IDENTITY
 ↓
EMPLOYMENT STATE
 ↓
POSITION / ASSIGNMENT
 ↓
SCOPE
 ↓
DELEGATIONS / REVOCATIONS
 ↓
AUTHORIZATION DECISION
 ↓
WORKSPACE
 ↓
ACTION
 ↓
SERVER-SIDE AUTHORIZATION
 ↓
CANONICAL COMMAND
 ↓
DOMAIN FACT
 ↓
EVENT / AUDIT / WORKSPACE UPDATE
```

**K. Student Lifecycle Graph**

```
PROSPECT
 ↓
LEAD
 ↓
ADMISSION CASE
 ↓
APPLICANT
 ↓
APPLICATION
 ↓
DOCUMENT / REQUIREMENT VERIFICATION
 ↓
PLACEMENT ATTEMPT
 ↓
PLACEMENT RESULT
 ↓
ACADEMIC ELIGIBILITY
 ↓
ADMISSION DECISION
 ↓
STUDENT
 ↓
PROGRAM / LEVEL
 ↓
OFFERING
 ↓
ENROLLMENT REQUEST
 ├───────────────► ACADEMIC CHECK
 └───────────────► FINANCIAL CHECK
          ↓
ENROLLMENT DECISION
 ↓
CLASS / SECTION
 ↓
SCHEDULE
 ↓
SESSION
 ├── attendance
 ├── assessment
 └── learning evidence
 ↓
ACADEMIC RECORD
 ↓
PROGRESSION DECISION
 ├── advance
 ├── repeat
 ├── appeal
 └── hold/restriction
 ↓
COMPLETION
 ↓
GRADUATION
 ↓
CREDENTIAL / TRANSCRIPT
 ↓
ALUMNI
```

**Lifecycle transition contract**

Every consequential transition must define:

```
Current state
Command
Actor
Authorization
Preconditions
Atomic transaction boundary
New state
Audit evidence
Domain event
Failure result
```

**L. Branch-Provenance Graph**

Branch is not merely a current `branch_id` field. It is an operational context attached to the fact that was produced.

```
ORGANIZATION
 ↓
BRANCH / OPERATIONAL CONTEXT
 ↓
FACT CREATION
 ├── applicant context
 ├── enrollment context
 ├── class context
 ├── session context
 ├── payment collection context
 ├── employee assignment context
 └── document production context
```

**L1. Current vs historical branch**

```
Student.current_home_branch
        ≠
HistoricalEnrollment.branch
        ≠
Session.operational_branch
        ≠
Payment.collection_context
```

**L2. Provenance envelope**

For material facts:

```
organization_id
operational_branch_id
source_context
actor_id
authority_context
effective_at
recorded_at
correlation_id
source_reference
version
```

**L3. Transfer principle**

A transfer changes future/current context; it does not rewrite prior facts.

```
BRANCH A
  │
  ├── historical enrollment
  ├── historical session
  └── historical payment collection

TRANSFER
  ↓
BRANCH B
  │
  └── future operational facts
```

Unknown or contradictory provenance must fail closed for protected operations.

**M. Calendar / Period Graph**

Time has two distinct meanings: a moment and a governed business period.

```
TIME
├── instant
├── local date/time
├── timezone
└── presentation calendar
      ├── Gregorian
      └── Jalali presentation / conversion
```

Business periods are separate domain objects:

```
PERIOD AUTHORITY
│
├── Academic Term
├── Financial Period
├── Payroll Period
├── Operational Period
└── Other governed periods
```

A period is not created by whichever module happens to need one.

**Period rule**

```
Academic month
Financial month
Payroll month
Operational month
```

are not automatically the same concept.

Each period has:

```
period_type
start_at
end_at
status
closure_state
organization_scope
```

Period closure must prevent unauthorized retroactive mutation.

**N. Workspace Graph**

Workspace is an **experience/application projection**, not a business authority.

```
AUTHORITATIVE DOMAINS
      │
      ├── tasks
      ├── approvals
      ├── exceptions
      ├── deadlines
      ├── assignments
      ├── notifications
      └── recent work
             ↓
        WORK DISCOVERY
             ↓
     AUTHORIZATION FILTER
             ↓
       EMPLOYEE WORKSPACE
             ↓
        RECORD CONTEXT
             ↓
       AUTHORIZED ACTION
             ↓
       CANONICAL COMMAND
```

**N1. Work concepts are separate**

```
Task
  = a unit of work to perform

Approval
  = a controlled decision step requiring an authorized response

WorkItem
  = an actionable instance assigned to an actor/queue

Exception
  = a detected abnormal, blocked, violated or attention-required condition

Notification
  = a delivery artifact informing an actor
```

A workflow may create a work item for a task or approval; Microsoft Dynamics explicitly models tasks, approvals and automated tasks as distinct workflow elements and work items as their runtime actionable instances. citeturn775489search0

**N2. Employee workspace does not write domains directly**

```
Workspace
   ↓
Command
   ↓
Application Handler
   ↓
Authorization
   ↓
Domain Authority
```

**O. Management Graph**

Management consumes projections and then acts through authorized commands.

```
AUTHORITATIVE FACTS
   │
   ├── finance
   ├── academic
   ├── workforce
   ├── admissions
   ├── student
   └── operations
         ↓
   GOVERNED READ MODELS
         ↓
   MANAGEMENT WORKSPACE
         │
         ├── KPIs
         ├── financial health
         ├── branch performance
         ├── academic health
         ├── staffing
         ├── risk
         ├── bottlenecks
         ├── exceptions
         └── pending decisions
         ↓
      MANAGEMENT DECISION
         ↓
  AUTHORIZED COMMAND / APPROVAL
         ↓
      DOMAIN AUTHORITY
```

Management dashboards may aggregate; they may not silently rewrite or redefine business facts.

**P. Security Graph**

**P1. Authorization request**

```
ACTOR
 ↓
RESOURCE
 ↓
ACTION
 ↓
ORGANIZATIONAL CONTEXT
 ↓
RESOURCE OWNERSHIP / RELATIONSHIP
 ↓
ACTOR LIFECYCLE STATE
 ↓
CAPABILITY / ROLE
 ↓
DELEGATION
 ↓
REVOCATION
 ↓
POLICY
 ↓
AUTHORIZATION DECISION
```

**P2. Sensitive boundary checks**

At every protected operation evaluate as applicable:

```
identity
actor status
organization scope
branch scope
resource ownership / relationship
capability
lifecycle state
delegation
revocation
separation of duties
concurrency/version
idempotency
```

**P3. Frontend rule**

```
Hidden UI action
  ≠ authorization

Disabled button
  ≠ authorization

Route guard
  ≠ authorization

Server-side authorization
  = mandatory
```

**P4. Resource-centric model**

Authorization should be expressed in terms of resources and relationships when hierarchy or branch scope matters; role names alone become brittle as resource relationships grow. Current OpenFGA modeling guidance explicitly recommends starting from resources/objects and represents access through relationships, with attribute context where needed. citeturn775489search1turn775489search5turn775489search8

**Q. Failure / Concurrency Graph**

Every important command must define its behavior for:

```
NORMAL
DUPLICATE
CONCURRENT
STALE
UNAUTHORIZED
WRONG BRANCH
INVALID LIFECYCLE
MISSING PROVENANCE
UNIQUE CONSTRAINT
DOWNSTREAM FAILURE
EVENT RETRY
EVENT DUPLICATE
REPLAY
```

**Q1. Command behavior matrix**

ConditionRequired behaviorduplicate idempotent requestreturn the same logical result; no duplicate stateunauthorizedreject; create security evidence where appropriatewrong branchreject closed; no data mutationstale versionreturn conflict; require fresh read/retryinvalid lifecyclereject with domain validation resultmissing provenancereject for facts requiring provenancecapacity raceatomic constraint/locking/conditional update decides winnerdownstream event delivery failurebusiness commit remains; outbox retriesduplicate eventconsumer idempotency prevents duplicate effectdocument rendering failuresource business fact remains authoritative; document job retriescommunication failuresource business fact remains committed; communication retries/fails independentlyreport refresh failureoperational truth remains intact

**Q2. Optimistic concurrency**

Critical aggregates should expose versions:

```
Enrollment.version
Offering.version
FinancialObligation.version
Approval.version
Placement.version
StudentLifecycle.version
```

State-changing commands should use optimistic concurrency unless a stronger transaction/locking strategy is explicitly required.

**Q3. Capacity example**

```
Offering capacity = 20
Current enrollment = 19

Request A ─┐
           ├── atomic capacity decision ──► winner
Request B ─┘
```

A read-then-write check without an atomic concurrency boundary is insufficient.

**R. Reporting Graph**

```
AUTHORITATIVE DOMAIN FACTS
       ↓
CHANGE EVENTS / CONTROLLED QUERIES
       ↓
READ PROJECTIONS
       ↓
GOVERNED REPORTING MODEL
       ├── executive
       ├── branch
       ├── academic
       ├── finance
       ├── workforce
       ├── operations
       ├── audit
       └── analytics
       ↓
MANAGEMENT DECISION
```

**R1. Reporting rules**

Reporting may:

```
aggregate
join governed projections
calculate KPIs
calculate ratios
build trends
```

Reporting may not:

```
repair source facts silently
redefine balances
recalculate source authority differently
write operational truth
```

A calculated KPI must specify its source definitions and period semantics.

**S. Document Graph**

```
AUTHORITATIVE FACT / STATE
        ↓
DOCUMENT REQUEST
        ↓
TEMPLATE VERSION
        ↓
SOURCE FACT VERSION / SNAPSHOT
        ↓
IMMUTABLE RENDER SNAPSHOT
        ↓
DOCUMENT ARTIFACT
        ↓
OPTIONAL VERIFICATION / SIGNATURE
```

A document records evidence of a business state. It is not that state.

**Document metadata**

```
document_id
subject_type
subject_id
template_id
template_version
source_fact_version
generated_at
generated_by
verification_state
signature_state
checksum
```

Old certificates/transcripts/receipts must remain historically reproducible even after current student data changes.

**T. Communication Graph**

```
AUTHORITATIVE EVENT / APPROVED ACTION
             ↓
     COMMUNICATION POLICY
             ↓
    COMMUNICATION INTENT
             ↓
   CONSENT / PREFERENCE CHECK
             ↓
      TEMPLATE VERSION
             ↓
       CHANNEL SELECTION
       ┌──────┼──────┐
       ▼      ▼      ▼
      SMS    EMAIL   PUSH
       │      │      │
       └──────┴──────┘
              ↓
       DELIVERY STATE
              ↓
       RETRY / FAILURE
              ↓
    COMMUNICATION HISTORY
```

Business transaction and outbound communication must be decoupled:

```
Enrollment committed
       ↓
Welcome communication requested
       ↓
SMS fails
       ↓
Enrollment remains committed
SMS delivery retries independently
```

**U. Missing-Capability Analysis**

The objective is not to maximize module count. A capability is added only when a business problem, authority boundary, compliance requirement, or scalable lifecycle justifies it.

CapabilityClassificationArchitectural reasonOrganization / branches / unitsRequired nowfoundational scope and provenanceIdentity / authenticationRequired nowactor identityFine-grained authorizationRequired nowbranch/resource/action protectionCRM / leadsRequired nowadmissions pipelineAdmissions / applicationsRequired nowapplicant lifecyclePlacementRequired nowTOEFL-specific academic entry pathStudent lifecycleRequired nowcore education processAcademic curriculum / offeringRequired nowcourse delivery authorityEnrollmentRequired nowmembership/registration authoritySchedulingRequired nowdelivery viabilityAttendanceRequired nowacademic + operational factAssessmentRequired nowacademic evidenceFinance / ARRequired nowmonetary truthPayrollArchitecturally required if payroll is internalkeeps payroll calculation distinct from finance ledgerDocumentsRequired nowcredentials/receipts/evidenceCommunicationRequired nowoperational/customer messagingWorkflowRequired nowhuman coordination and approvalsEvents / outboxArchitecturally requiredreliable propagationAuditRequired nowaccountability / forensicsSearchRequired now for scale/UXdiscovery without source mutationReportingRequired nowmanagement visibilityCash managementArchitecturally required as finance growspayment/cash controlBank reconciliationLater / required with bank-heavy operationsfinancial controlGeneral ledgerRequired if formal accounting is in scopeaccounting truthCost centersRequired if branch profitability/cost accounting mattersmanagement accountingBudgetingLaterplanning rather than transaction processingProcurementLateronly if TOEFL House operates purchasing workflows internallyVendorsConditionalrequired with procurement/AP vendor managementInventory / books / materialsConditionalrequired only if stock is operationally materialAsset managementLaterrequired when fixed assets need controlled lifecycleScholarshipsConditional, likely laterdependent on business policySponsorshipsConditionaldependent on business modelComplaints / student supportLaterservice-management maturityAppointmentsLateruseful if admissions/support is appointment-centricRoom bookingRequired within scheduling if rooms are shared resourcesfacility conflict controlStaff recruitmentLaterHR expansionLeaveRequired for mature workforce managementpayroll/availability impactTime attendanceConditionalrequired if payroll depends on hours/attendanceStaff performanceLaterHR maturityStaff trainingLaterworkforce developmentHelpdesk / service requestsLatersupport operating modelDocument verificationRequired for controlled credentialsevidence authenticityE-signaturesLater / conditionallegal/policy requirementCompliance managementArchitecturally required as a cross-cutting concernpolicy/evidence/retentionIncident managementLateroperational and security maturityAnomaly detectionLateranalytics maturity; not core authorityWorkflow escalationRequired within workflowSLA/exception managementAI decisioningNot a core authoritymust not replace governed business decisions

**V1 focus**

The first architecture should be complete for:

```
Organization
Identity
Authorization
Workforce
CRM
Admissions
Placement
Student
Academic
Scheduling
Enrollment
Finance
Payroll boundary
Documents
Communication
Workflow
Events/Outbox
Audit
Search
Reporting
```

Advanced ERP capabilities should be added only when requirements justify them.

**V. Research Findings**

The architecture was compared conceptually with established enterprise patterns in ERP/workflow, education management, authorization and reliable event publication.

**V1. Education enterprise pattern**

Large education-management systems commonly connect admissions, academics/enrollment, student accounts and credentials rather than treating them as isolated applications. Oracle's Student Cloud materials describe an integrated student management model spanning admissions, academics, enrollment, student accounts and credentials. The important architectural lesson is **continuous lifecycle traceability**, not a requirement to copy Oracle's module naming.

**V2. Workflow pattern**

Microsoft Dynamics explicitly separates workflow tasks, approvals and automated tasks; runtime work items are created for actionable user steps. This supports maintaining distinct concepts for `Task`, `Approval`, `WorkItem`, `Exception` and `Notification`. citeturn775489search0turn775489search7

**V3. Workflow security**

Microsoft's approval-flow guidance checks that the workflow instance/work item is still valid before allowing completion, demonstrating an important rule for TOEFL House: **a previously issued approval link or work item must not become a bypass around current domain state and authorization**. citeturn775489search2

**V4. Event reliability**

Transactional outbox is a strong fit where a business transaction and event publication must be coordinated. Relay duplicates are possible, therefore consumers require idempotent handling. citeturn775489search6

**V5. Authorization**

Relationship-based access control is especially relevant to TOEFL House because access may depend on organization, branch, resource relationship, delegation and current context. OpenFGA's current guidance models authorization from resources and relationships and supports attribute-based contextual conditions. citeturn775489search1turn775489search5turn775489search8

**V6. Architectural interpretation**

The external patterns support, but do not dictate, the following TOEFL House design decisions:

```
Use bounded contexts
Use domain ownership
Use workflow as coordination, not business authority
Use typed events
Use transactional outbox
Use idempotent consumers
Use resource/scope-aware authorization
Use versioned evidence/documents
Use projections for reporting/search/workspace
```

**W. Alternatives Considered**

**W1. Module-centric monolith**

```
UI
 ↓
Modules
 ↓
Shared tables
```

**Rejected.** It encourages multiple modules to mutate the same business fact and hides authority boundaries.

**W2. Microservice-per-module**

```
20+ services
20+ databases
many synchronous calls
```

**Rejected as the default physical implementation.** The domain model is not mature enough to justify operational complexity. Logical bounded contexts should exist even if implemented in one deployable application.

**W3. Event-sourced everything**

```
Every business fact = event stream
Current state = projection
```

**Rejected as the default.** Auditability and history do not automatically require global event sourcing. It adds operational, modeling and replay complexity that is not justified for every context.

**W4. Shared database as shared authority**

```
All modules can update all tables
```

**Rejected.** A shared physical database is acceptable only if logical ownership and write boundaries are enforced.

**W5. Workflow-owned business truth**

```
Workflow says enrollment approved
therefore student is enrolled
```

**Rejected.** Workflow may coordinate a decision but Enrollment must authoritatively change Enrollment state.

**W6. Report-driven truth**

```
Report calculates a new balance
system trusts report balance
```

**Rejected.** Reports are projections.

**W7. Search-as-authority**

```
Search index is faster → therefore system reads/writes search as truth
```

**Rejected.** Search is a projection.

**X. Final Decisions**

**X1. Final architectural shape**

**Decision:** TOEFL House will be a **domain-oriented modular enterprise system**, preferably a modular monolith at the current stage, with strict logical bounded contexts and authority boundaries.

**X2. Source of truth**

**Decision:** exactly one authoritative owner per major business fact.

**X3. Workspace**

**Decision:** workspace is a projection/orchestration surface, never a fact owner.

**X4. Finance**

**Decision:** Finance owns monetary truth; other domains request financial actions or consume financial decisions.

**X5. Enrollment**

**Decision:** Enrollment owns enrollment membership/decision; it consumes academic and financial eligibility rather than delegating enrollment authority to either.

**X6. Placement**

**Decision:** Placement owns measurement/evidence/result; it does not directly assign classes.

**X7. Workflow**

**Decision:** Workflow owns process state/work items/coordination, not domain facts.

**X8. Events**

**Decision:** transactional outbox + idempotent consumers are mandatory for durable asynchronous business-event propagation.

**X9. Security**

**Decision:** authorization is resource/scope/lifecycle/context aware and enforced server-side.

**X10. History**

**Decision:** historical facts are preserved; current attributes never overwrite prior provenance.

**X11. Documents**

**Decision:** documents are immutable/versioned evidence snapshots of authoritative facts.

**X12. Reporting**

**Decision:** reports consume governed projections and cannot redefine source truth.

**Y. Rejected Architectures**

The following are explicitly rejected unless a future ADR reverses them:

```
1. UI-owned business logic
2. Shared-table unrestricted writes
3. Multiple balance authorities
4. Applicant = Application
5. Student = Enrollment
6. Payment = Accounting Entry
7. Payroll = Finance
8. Workflow = Domain Authority
9. Event = Source of Truth
10. Document = Source of Truth
11. Search = Source of Truth
12. Current branch overwrites historical branch
13. Hidden authorization in UI only
14. GET requests that mutate business state
15. Report calculations treated as transaction truth
16. Microservice-per-module by default
17. Event sourcing everywhere by default
18. One generic “status” field for all lifecycle meanings
19. One generic “approval” concept for business eligibility and human authorization
20. One generic “task” concept for task, approval, exception and notification
```

**Z. Implementation Sequence**

Implementation follows architecture rather than the other way around.

**Z1. Phase 0 — Architecture contract**

```
Define contexts
Define ownership matrix
Define entity/aggregate ownership
Define command catalog
Define query catalog
Define event catalog
Define API contracts
Define authorization model
Define provenance contract
Define lifecycle/state machines
Define concurrency rules
```

**Z2. Phase 1 — Foundation**

```
Organization
Organizational Structure
People
Identity
Time / Periods
Actor Context
Authorization
Audit foundation
```

**Z3. Phase 2 — Workforce**

```
Employment
Position
Assignment
Workforce lifecycle
Leave / attendance as justified
Payroll boundary
```

**Z4. Phase 3 — Customer to Student**

```
CRM
Admissions
Application
Placement
Eligibility
Admission Decision
Student lifecycle
```

**Z5. Phase 4 — Academic Delivery**

```
Program
Program Version
Level
Offering
Scheduling
Enrollment
Class / Section
Session
Attendance
Assessment
Progression
Completion
Credentials
```

**Z6. Phase 5 — Finance**

```
Obligations
Billing
Payments
Allocation
Refunds
Credits / waivers
Subledger
General Ledger
Reconciliation
Period close
```

Payroll integrates here through controlled financial liability contracts.

**Z7. Phase 6 — Platform coordination**

```
Workflow
Task
WorkItem
Approval
Exception
Notification
Document service
Communication service
Outbox / event delivery
Search projections
Reporting projections
```

**Z8. Phase 7 — Management and control**

```
Executive dashboards
Branch dashboards
Academic dashboards
Finance dashboards
Workforce dashboards
Audit views
Exception management
SLA / escalation
```

**Z9. Phase 8 — Hardening**

```
Concurrency tests
Authorization tests
Branch-isolation tests
Lifecycle transition tests
Idempotency tests
Outbox/replay tests
Historical/provenance tests
Financial correction tests
Document reproducibility tests
Reporting reconciliation
```

**Final Integrated Enterprise Graph**

The complete architecture is intentionally readable as a continuous chain.

**Owner → Management path**

```
OWNER / MANAGEMENT
 → ORGANIZATION
 → ORGANIZATIONAL CONTEXT
 → BRANCH / UNIT
 → PERSON
 → EMPLOYEE PARTICIPATION
 → EMPLOYMENT
 → POSITION
 → ASSIGNMENT
 → ACTOR CONTEXT
 → AUTHORIZATION POLICY
 → AUTHORIZATION DECISION
 → EMPLOYEE WORKSPACE
 → WORK DISCOVERY
 → AUTHORIZED ACTION
 → CANONICAL COMMAND
 → DOMAIN AUTHORITY
 → TRANSACTION
 → AUTHORITATIVE FACT
 → DOMAIN EVENT
 → OUTBOX
 → EVENT DELIVERY
 → REPORTING PROJECTION
 → MANAGEMENT VIEW
 → MANAGEMENT DECISION
 → AUTHORIZED COMMAND / APPROVAL
 → DOMAIN AUTHORITY
```

**Lead → credential path**

```
LEAD
 → ADMISSION CASE
 → APPLICANT
 → APPLICATION
 → REQUIREMENT / DOCUMENT
 → PLACEMENT ATTEMPT
 → EVIDENCE
 → SCORING
 → PLACEMENT RESULT
 → ACADEMIC ELIGIBILITY SNAPSHOT
 → ADMISSION DECISION
 → STUDENT
 → PROGRAM / LEVEL
 → OFFERING
 → FINANCIAL ELIGIBILITY
 → ENROLLMENT REQUEST
 → ENROLLMENT DECISION
 → CLASS
 → SCHEDULE
 → SESSION
 → ATTENDANCE
 → ASSESSMENT
 → ACADEMIC RECORD
 → PROGRESSION
 → COMPLETION
 → GRADUATION
 → CREDENTIAL
 → DOCUMENT SNAPSHOT
```

**Employee → settlement path**

```
EMPLOYEE
 → EMPLOYMENT
 → POSITION
 → ASSIGNMENT
 → WORK / VALIDATED PAYROLL INPUT
 → PAYROLL CALCULATION
 → PAYROLL RESULT
 → PAYROLL LIABILITY
 → FINANCE
 → ACCOUNTING EVENT
 → SUBLEDGER
 → GENERAL LEDGER
 → RECONCILIATION / CLOSE
 → SETTLEMENT
 → AUDIT EVIDENCE
```

**Exception path**

```
DOMAIN FACT / EVENT
 → RULE / MONITOR
 → EXCEPTION
 → WORKFLOW
 → WORK ITEM
 → AUTHORIZED EMPLOYEE
 → VALIDATE CURRENT STATE
 → COMMAND
 → DOMAIN AUTHORITY
 → RESULT
 → EVENT / AUDIT
 → WORKFLOW COMPLETE OR ESCALATE
```

**Document path**

```
AUTHORITATIVE FACT
 → DOCUMENT REQUEST
 → TEMPLATE VERSION
 → SOURCE VERSION SNAPSHOT
 → IMMUTABLE RENDER
 → DOCUMENT
 → VERIFICATION / SIGNATURE
 → DELIVERY
```

**Search path**

```
AUTHORITATIVE FACT
 → CHANGE EVENT
 → SEARCH PROJECTION
 → AUTHORIZATION-FILTERED QUERY
 → WORKSPACE RESULT
 → CANONICAL RECORD
 → CANONICAL ACTION
```

**Governing Laws of TOEFL House**

These rules govern the architecture above.

```
LAW 01 — ONE FACT, ONE OWNER

LAW 02 — WORKSPACE IS NOT AUTHORITY

LAW 03 — REPORTING IS NOT AUTHORITY

LAW 04 — SEARCH IS NOT AUTHORITY

LAW 05 — DOCUMENTS ARE EVIDENCE, NOT SOURCE TRUTH

LAW 06 — EVENTS ANNOUNCE FACTS; THEY DO NOT SILENTLY OWN THEM

LAW 07 — WORKFLOW COORDINATES; DOMAIN AUTHORITIES DECIDE BUSINESS STATE

LAW 08 — AUTHORIZATION MUST BE ENFORCED AT THE SERVER-SIDE COMMAND BOUNDARY

LAW 09 — CURRENT CONTEXT MUST NEVER REWRITE HISTORICAL PROVENANCE

LAW 10 — MONETARY TRUTH HAS ONE OWNER: FINANCE

LAW 11 — ENROLLMENT DECIDES ENROLLMENT, AFTER CONSUMING GOVERNED ELIGIBILITY INPUTS

LAW 12 — PLACEMENT MEASURES AND RECOMMENDS; IT DOES NOT ASSIGN CLASSES

LAW 13 — PAYROLL CALCULATES; FINANCE RECORDS MONETARY TRUTH

LAW 14 — SYNCHRONOUS PATHS PROTECT DECISIONS; ASYNC PATHS PROPAGATE CONSEQUENCES

LAW 15 — EVERY DURABLE EVENT CONSUMER MUST BE IDEMPOTENT

LAW 16 — EVERY CRITICAL COMMAND MUST DEFINE DUPLICATE, CONCURRENT, STALE,
         UNAUTHORIZED AND RETRY BEHAVIOR

LAW 17 — READ DEPENDENCY MUST NOT IMPLY WRITE AUTHORITY

LAW 18 — BUSINESS PERIODS ARE GOVERNED OBJECTS, NOT LOCAL MODULE CONVENTIONS

LAW 19 — HISTORICAL FACTS ARE PRESERVED; CORRECTIONS CREATE NEW FACTS WHERE REQUIRED

LAW 20 — ARCHITECTURE IS DEFINED BY RESPONSIBILITY AND AUTHORITY, NOT BY SCREEN COUNT
```

**Architectural Acceptance Criteria**

The architecture is considered internally coherent only when all of the following can be answered without ambiguity:

```
1. Who owns this fact?
2. Which command changes it?
3. Which authorization permits that command?
4. Which actor and organizational context performed it?
5. Which aggregate/boundary protects its invariants?
6. What happens under concurrent modification?
7. What happens if the request is repeated?
8. What happens if the event is repeated?
9. What event announces the committed change?
10. Which projections consume it?
11. Which workflow, if any, is created?
12. Which document, if any, is generated?
13. Which notification, if any, is sent?
14. Which reports consume the result?
15. How is the historical state reconstructed?
16. How is branch provenance retained?
17. What does an unauthorized attempt leave in audit evidence?
18. Can any other module mutate the fact directly?
19. Can the source fact be corrected without rewriting history?
20. Can management trace a KPI back to authoritative source facts?
```

If any answer is unclear, that part of the architecture is not finished.

**Final Architectural Position**

TOEFL House is therefore not defined as:

```
CRM + Admissions + Academic + Finance + HR + Reports + etc.
```

It is defined as:

```
ORGANIZATIONAL REALITY
        ↓
PEOPLE + CONTEXT + TIME
        ↓
AUTHORITY
        ↓
BUSINESS LIFECYCLES
        ↓
AUTHORITATIVE FACTS
        ↓
TRANSACTIONAL EVENTS
        ↓
WORK / DOCUMENT / COMMUNICATION / SEARCH / REPORTING
        ↓
MANAGEMENT DECISION
        ↓
AUTHORIZED ACTION
        ↓
NEW AUTHORITATIVE FACT
```

The system is coherent when a user can trace any meaningful outcome from:

```
WHO
→ ACTOR
→ AUTHORITY
→ CONTEXT
→ COMMAND
→ DOMAIN OWNER
→ FACT
→ EVENT
→ OUTCOME
```

and when every business lifecycle can be followed without encountering:

```
multiple sources of truth
hidden authority
unbounded shared writes
branch leakage
historical rewriting
lifecycle contradictions
workflow/business-state confusion
financial duplication
non-idempotent event effects
or unexplained circular dependencies.
```

**This is the governing target architecture for the next repository audit and implementation phase.**
