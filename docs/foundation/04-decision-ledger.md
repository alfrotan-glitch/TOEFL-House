# Foundation Decision Ledger

**Status:** Discovery in progress
**Rule:** Repository behavior and prior documentation are not silently promoted to user decisions.

| ID | Decision | Authority | Evidence | State |
|---|---|---|---|---|
| D-F-001 | Work in this session remains on `arena/01a034c7-toefl-house`. | Arena session constraint | Session context | DECIDED |
| D-F-002 | Existing implementation is reference-only; no production changes are made during Foundation Phase. | User directive | Directive §§3–4, §66 | DECIDED |
| D-F-003 | Target backend/database choice is not finalized. Laravel/PostgreSQL are preferred recommendations requiring research, not implementation authorization. | User directive | Directive §§18–19 | OPEN |
| D-F-004 | Organization, authority, position, role, permission, scope, and workspace policy must be confirmed progressively. | User directive | Directive §§6, 67–68 | DECIDED |
| D-F-005 | Structural organizational changes require operation-specific authority through an approval matrix. Sensitive structural changes must not depend on one uncontrolled actor. | O-10 | User response, 2026-08-24 | DECIDED |
| D-F-006 | A sensitive administrative action affecting another Owner requires at least two Owner approvals. Emergency suspension requires a separate, time-limited, fully audited workflow with mandatory review. | O-19 | User response, 2026-08-24 | DECIDED |
| D-F-007 | Sensitive approvals use risk/value/action-based thresholds varying by action type, amount, risk, scope, or consequence. Exact thresholds remain unknown and must not be invented. | O-20 | User response, 2026-08-24 | DECIDED / THRESHOLDS OPEN |
| D-F-008 | Scope administration is differentiated by scope type and authority through an explicit scope-assignment authority matrix. | O-23 | User response, 2026-08-24 | DECIDED |
| D-F-009 | Workspace priority is Owner/Executive, General Manager, Finance, Reception/Admissions, Academic Management, Teacher, HR/Payroll, Test Officer, Campus/Branch Manager, Marketing/Social Media, Library/Books, Operations/Facilities, Security/Guard, Student, Parent/Guardian, System Administration. This is priority only, not workflow specification. | O-25 | User response, 2026-08-24 | DECIDED / WORKFLOW OPEN |
| D-F-010 | For creation of the first campus or branch, the General Manager prepares the request and at least two Owners give final approval. The same rule applies to both campus and branch creation. | O-35 | User response, 2026-08-24 | DECIDED |
| D-F-011 | Permanent closure of a campus or branch requires a request prepared by the General Manager and final approval from at least two Owners. | O-36 | User response, 2026-08-24 | DECIDED |
| D-F-012 | Reopening a closed campus or branch requires a request prepared by the General Manager and final approval from at least two Owners. | O-37 | User response, 2026-08-24 | DECIDED |
| D-F-013 | Transferring a branch from one campus to another requires a request prepared by the General Manager and final approval from at least two Owners. | O-38 | User response, 2026-08-24 | DECIDED |
| D-F-014 | After a branch transfer, records may be visible under the new campus for current operations, but every historical record must retain its original campus, branch, date, and historical attribution. | C-F-001 clarification | User response, 2026-08-24 | DECIDED |
| D-F-015 | Changing the official name of a campus or branch requires a General Manager request and approval from at least two Owners. | O-40 | User response, 2026-08-24 | DECIDED |
| D-F-016 | Creating a new department or operational unit requires a General Manager request and approval from at least two Owners. | O-41 | User response, 2026-08-24 | DECIDED |
| D-F-017 | A department may have units at multiple organizational levels; for example, an organization-wide department may also have campus or branch units. | O-42 | User response, 2026-08-24 | DECIDED |
| D-F-018 | Every formally established active branch must have a designated Branch Manager responsible for day-to-day branch operations. | O-43 | User response, 2026-08-24 | DECIDED |
| D-F-019 | The General Manager proposes a Branch Manager appointment or replacement, and at least two Owners approve it. | O-44 | User response, 2026-08-24 | DECIDED |
| D-F-020 | A Branch Manager may manage daily branch operations and change branch-level operating rules within limits approved by the Owners or General Manager. | O-45 | User response, 2026-08-24 | DECIDED / LIMITS OPEN |
| D-F-021 | A Branch Manager may approve routine branch financial actions within formally defined limits; higher-risk or higher-value actions require Finance or Owner approval. | O-46 | User response, 2026-08-24 | DECIDED / LIMITS OPEN |
| D-F-022 | A Branch Manager's limited routine financial authority may include routine expenses, discounts, and refunds, subject to formally defined limits; higher-risk or higher-value actions require Finance or Owner approval. | O-47 | User response, 2026-08-24 | DECIDED / LIMITS OPEN |
| D-F-023 | A Branch Manager may prepare or request an expense, discount, or refund but must not approve their own request. Another authorized person must approve it. | O-48 | User response, 2026-08-24 | DECIDED |
| D-F-024 | A Branch Manager's routine expense request is normally approved by the Finance Manager; the General Manager is the only substitute approver when the Finance Manager is unavailable. Refund and discount requests are always approved by the General Manager. | O-49, O-50, O-51, O-52 | User responses, 2026-08-24 | DECIDED / EXPENSE LIMITS OPEN |
| D-F-025 | Branch Managers may use pre-approved limits for low-impact operating-rule changes. Changes affecting staff, students, schedules, safety, or money require separate approval. | O-53 custom response | User response, 2026-08-24 | DECIDED / IMPACT RULES OPEN |
| D-F-026 | A non-financial branch-level change affecting staff, students, schedules, or safety requires review by the relevant department head and final approval by the General Manager. | O-54 | User response, 2026-08-24 | DECIDED |
| D-F-027 | A branch-level change affecting money requires Finance Manager review and final approval by the General Manager. If Finance disagrees, the General Manager and Finance Manager must jointly prepare written explanations, and the matter must be escalated to at least two Owners before approval. If the Owners approve despite the disagreement, Finance records and reports the transaction while preserving the objection and approvals. | O-55 through O-59 | User responses, 2026-08-24 | DECIDED / FINANCIAL CONTROL DETAILS OPEN |
| D-F-028 | The General Manager may prepare or request a money-related action but must not give final approval to their own request. If the General Manager submits the request, the Finance Manager reviews it and at least two Owners give final approval. | O-60, O-61 | User responses, 2026-08-24 | DECIDED |
| D-F-029 | No Branch Manager, General Manager, Finance Manager, or Owner may approve a money-related request that directly benefits themselves. | O-62 | User response, 2026-08-24 | DECIDED |
| D-F-030 | Emergency suspension of an Owner's access may be initiated only jointly by two other Owners; the mandatory review must occur within seven days; the two unaffected Owners decide whether access is restored, remains suspended, or is permanently changed; the action must remain fully audited. | O-63, O-64, O-65 | User responses, 2026-08-24 | DECIDED |
| D-F-031 | Granting or removing organization-wide access for a person requires approval from at least two Owners. | O-66 | User response, 2026-08-24 | DECIDED |
| D-F-032 | An Owner must submit a request for organization-wide access, and another Owner must approve it; the two-Owner approval rule remains mandatory. | O-67 | User response, 2026-08-24 | DECIDED |
| D-F-033 | The General Manager may request campus-wide access for a person, but at least two Owners must approve it. | O-69 | User response, 2026-08-24 | DECIDED |
| D-F-034 | The Branch Manager may request branch-wide access only for people working in that Branch Manager's own branch, and the General Manager gives final approval. The General Manager may request cross-branch access for a person working in another branch when there is a documented operational reason; at least two Owners must approve that cross-branch request. Cross-branch access always has an automatic end date and requires renewal. | O-70 through O-74 | User responses, 2026-08-24 | DECIDED |
| D-F-035 | The General Manager proposes a Head of Department appointment or replacement, and at least two Owners approve it. | O-75 | User response, 2026-08-24 | DECIDED |
| D-F-036 | Head of Department authority differs by department; each head manages only the scope explicitly assigned to that department. | O-76 | User response, 2026-08-24 | DECIDED / DEPARTMENT SCOPES OPEN |
| D-F-037 | A Head of Department may recommend team-member appointments or replacements, but an authorized higher authority must approve them. | O-77 | User response, 2026-08-24 | DECIDED |
| D-F-038 | A Head of Department may make routine duty changes, but changes affecting pay, position, branch, or access require separate approval. | O-78 | User response, 2026-08-24 | DECIDED / APPROVAL DETAILS OPEN |
| D-F-039 | Every cross-branch assignment for a Head of Department has an automatic end date and requires renewal. | O-79 | User response, 2026-08-24 | DECIDED |
| D-F-040 | Access outside a department requires review by the responsible department head and final approval by the General Manager; sensitive or organization-wide access follows stronger Owner rules. | O-80 | User response, 2026-08-24 | DECIDED |
| D-F-041 | A Head of Department may not approve a decision that directly benefits themselves. | O-81 | User response, 2026-08-24 | DECIDED |

| D-F-042 | Final approval for a team-member appointment or replacement recommended by a Head of Department is given by the HR Manager; senior or sensitive positions remain subject to higher approval rules. | O-82 | User response, 2026-08-24 | DECIDED / SENIOR POSITION RULES OPEN |
| D-F-043 | A pay, allowance, bonus, or compensation change recommended by a Head of Department requires HR and Finance review, then General Manager approval; higher-risk cases escalate. | O-83 | User response, 2026-08-24 | DECIDED / THRESHOLDS OPEN |
| D-F-044 | Moving a team member between branches or departments requires review by current and receiving authorities, then General Manager approval. | O-84 | User response, 2026-08-24 | DECIDED |
| D-F-045 | Access changes caused by duty changes require department confirmation and approval by the General Manager or authorized security administrator according to scope. | O-85 | User response, 2026-08-24 | DECIDED |
| D-F-046 | A Head of Department may temporarily remove a team member from duties for an urgent safety, misconduct, or serious operational concern, with documentation and mandatory HR/General Manager review within a defined period. | O-86 | User response, 2026-08-24 | DECIDED / REVIEW PERIOD OPEN |
| D-F-047 | An acting Head of Department is recommended by the department and appointed by the General Manager for a defined start and end date. | O-87 | User response, 2026-08-24 | DECIDED |

| D-F-084 | Owner approval is required for senior, sensitive, or organization-wide positions; ordinary team appointments remain with HR and the General Manager. | O-88 | User response, 2026-08-24 | DECIDED / POSITION CATEGORIES OPEN |
| D-F-085 | An urgent temporary removal from duties requires HR and General Manager initial review within 24 hours. | O-89 | User response, 2026-08-24 | DECIDED / FULL REVIEW PERIOD OPEN |
| D-F-086 | During temporary removal, only protective access or scheduling restrictions may occur; permanent pay or employment changes require separate approval. | O-90 | User response, 2026-08-24 | DECIDED |
| D-F-087 | A Head of Department's own leave, expense, bonus, or schedule exception is approved by the General Manager after HR or Finance review as relevant; higher-risk matters escalate. | O-91 | User response, 2026-08-24 | DECIDED |
| D-F-088 | A Head of Department may approve routine team leave, schedule changes, or duty swaps within staffing rules; material effects require higher review. | O-92 | User response, 2026-08-24 | DECIDED / IMPACT RULES OPEN |
| D-F-089 | A Head of Department may formally evaluate team members; HR and the General Manager review consequences affecting pay, position, or employment. | O-93 | User response, 2026-08-24 | DECIDED |

| D-F-048 | At least two Owners approve appointments or replacements for General Manager, Finance Manager, HR Manager, Security lead, System Administrator, and every Head of Department; ordinary positions remain with HR and the General Manager. | O-94, C-F-002, O-75 | User responses, 2026-08-24 | DECIDED |
| D-F-049 | After an urgent temporary removal, the full employment decision must be completed within seven days. | O-95 | User response, 2026-08-24 | DECIDED |
| D-F-050 | HR reviews a permanent employment decision after urgent removal; the General Manager decides, with serious or senior cases escalated. | O-96 | User response, 2026-08-24 | DECIDED |
| D-F-051 | HR may approve ordinary appointments within approved staffing plans; unusual cost, authority, or sensitivity requires higher approval. | O-97 | User response, 2026-08-24 | DECIDED / EXCEPTION RULES OPEN |
| D-F-052 | A routine leave, schedule change, or duty swap affecting minimum staffing or student service requires Head recommendation and Branch Manager or General Manager approval. | O-98 | User response, 2026-08-24 | DECIDED |
| D-F-053 | HR reviews every formal performance evaluation before it is used for promotion, pay, discipline, or termination. | O-99 | User response, 2026-08-24 | DECIDED |

| D-F-054 | The relevant Head of Department may request department-level access for a person. | O-100 | User response, 2026-08-24 | DECIDED |
| D-F-055 | Department-level access requires department confirmation and final General Manager approval; sensitive or organization-wide access follows stronger Owner rules. | O-101 | User response, 2026-08-24 | DECIDED |
| D-F-056 | Every department-level access assignment has an automatic end date and requires renewal. | O-102 | User response, 2026-08-24 | DECIDED |
| D-F-057 | Academic Management assigns teachers to classes or student groups. | O-103 | User response, 2026-08-24 | DECIDED |
| D-F-058 | A teacher may keep normal class access until the academic term ends after the class assignment ends. | O-104, O-106, C-F-004 | User responses, 2026-08-24 | DECIDED |
| D-F-059 | After an approved assignment ends, at least two Owners must approve or perform ordinary access removal when Owner authority is used; this aligns with the organization-wide access rule. | O-105, C-F-003 | User response, 2026-08-24 | DECIDED |

| D-F-061 | Academic Management approves a teacher handover period after assignment end. | O-107 | User response, 2026-08-24 | DECIDED |
| D-F-062 | When an assignment ends during an active examination, grading period, or assessment, Academic Management decides whether it continues. | O-108 | User response, 2026-08-24 | DECIDED |
| D-F-063 | A temporary assignment extension may be requested by the Branch Manager or Academic Management, depending on operational or academic reason. | O-109 | User response, 2026-08-24 | DECIDED |
| D-F-064 | Academic Management approves temporary teacher assignment extensions. | O-110 | User response, 2026-08-24 | DECIDED |
| D-F-065 | Every temporary access or assignment extension requires a reason and explicit end date. | O-111 | User response, 2026-08-24 | DECIDED |

| D-F-066 | After a teacher assignment ends, the teacher may retain access until the academic term ends for viewing, but access is read-only and cannot edit grades, attendance, or comments. | O-112 | User response, 2026-08-24 | DECIDED |

| D-F-067 | When a teacher assignment ends during active grading or assessment, Academic Management may edit or assign remaining grade and assessment work. | O-113 | User response, 2026-08-24 | DECIDED |

| D-F-068 | Academic Management edits to grades or assessment records after a teacher assignment ends require a reason and an audit record. | O-114 | User response, 2026-08-24 | DECIDED |

| D-F-069 | When a teacher assignment ends before term end, the former teacher, newly responsible academic authority, and relevant manager must be notified of the access and responsibility change, with minimum necessary student information. | O-115 | User response, 2026-08-24 | DECIDED |

| D-F-070 | A teacher may appeal removal of a class assignment or related access change through HR; HR investigates and records the outcome. | O-116 | User response, 2026-08-24 | DECIDED |

| D-F-071 | An appeal by a teacher against removal of a class assignment or related access pauses the reassignment until HR decides the appeal. | O-117 | User response, 2026-08-24 | DECIDED / STUDENT-CONTINUITY RISK OPEN |

| AD-001 | Academic Management may appoint a temporary replacement while an HR appeal is reviewed; the temporary assignment is dated, scope-limited, and notified. | Best-practice default under Discovery Execution Optimization Directive | Agent analysis, 2026-08-24 | AGENT-DECIDED DEFAULT |

| D-F-072 | The General Manager proposes new job positions and at least two Owners approve them. | O-118 | User response, 2026-08-24 | DECIDED |
| D-F-073 | An Owner submits permission changes; the responsible business authority reviews them; sensitive or organization-wide increases require at least two Owner approvals. | O-119 | User response, 2026-08-24 | DECIDED |
| D-F-074 | Any Owner may assign an existing role to a person after the role exists. | O-120 | User response, 2026-08-24 | DECIDED / CONFLICT-OF-INTEREST CONTROL OPEN |
| D-F-075 | Role access automatically ends when the underlying position, employment, or approved scope ends, unless a separate dated extension is approved. | O-121 | User response, 2026-08-24 | DECIDED |
| D-F-076 | Permission exceptions must be temporary, separately approved, specifically scoped, justified, dated, and auditable. | O-122 | User response, 2026-08-24 | DECIDED |
| D-F-077 | A person may hold multiple roles for multiple positions; each assignment is separately scoped and dated and combined authority is checked for conflicts. | O-123 | User response, 2026-08-24 | DECIDED |

| D-F-078 | O-124 selected that any Owner may assign any existing role to themselves. This conflicts with the established two-Owner requirement for organization-wide access and with separation-of-duties controls for sensitive powers. | O-124 vs D-F-031/D-F-073 | User response, 2026-08-24 | CONFLICT / CLARIFICATION REQUIRED |
| D-F-079 | At least two Owners must approve assignment of a sensitive role to another Owner. | O-125 | User response, 2026-08-24 | DECIDED |
| D-F-080 | A proposed permission combination that permits one person to request, approve, and record the same financial action may be approved by the General Manager when operationally necessary. | O-126 | User response, 2026-08-24 | DECIDED / CONTROL EXCEPTION OPEN |
| D-F-081 | A person may request additional access for themselves, but cannot approve or grant it. | O-127 | User response, 2026-08-24 | DECIDED |
| D-F-082 | A requester should receive the reason when a permission change is rejected, without disclosure of confidential reviewer information. | O-128 | User response, 2026-08-24 | DECIDED |
| D-F-083 | Sensitive or organization-wide access must be reviewed at least annually. | O-129 | User response, 2026-08-24 | DECIDED |

| D-F-096 | Consolidated decisions MD-001 through MD-065 are accepted as the current TOEFL House business-policy baseline; earlier compatible decisions remain active, and conflicting earlier recommendations are superseded. | Consolidated user decision document | User response, 2026-08-24 | DECIDED |
| D-F-097 | Residual exact campus/branch inventory, legal succession details, agreement-specific scholarship/funding rules, and additional contract variations are recorded as non-blocking UNKNOWN items and must be resolved before their specific configuration or implementation. | OPEN-01 through OPEN-04 | User response, 2026-08-24 | UNKNOWN / NON-BLOCKING |
| D-F-098 | The earlier agent default allowing temporary replacement during a teacher reassignment appeal is superseded by the user decision to pause reassignment; no replacement is assumed without explicit policy. | O-117 and AD-001 | User response, 2026-08-24 | SUPERSEDED |
| D-F-099 | The earlier permissive permission-combination answer is superseded by the consolidated rule that one person must never initiate, approve, record, and reconcile the same financial transaction. | MD-007 | User response, 2026-08-24 | SUPERSEDED |

| G1-D-001 | Approval thresholds are configurable by action type with fail-closed behavior when no applicable threshold exists. | G1-B01 | User response, 2026-08-25 | USER-DECIDED |
| G1-D-002 | Refunds or discounts outside standard policy require Finance review and General Manager final approval; higher-risk cases escalate. | G1-B02 | User response, 2026-08-25 | USER-DECIDED |
| G1-C-001 | G1-B03 selected General Manager approval for all expenses, conflicting with O-51/O-52, which establish Finance Manager as normal approver and General Manager only as substitute. | G1-B03 vs O-51/O-52 | User response, 2026-08-25 | CONFLICT / CLARIFICATION REQUIRED |
| G1-D-004 | Compensation changes, restricted-fund allocations, material asset disposal, and financial-period reopening require approval from at least two Owners. | G1-B04 | User response, 2026-08-25 | USER-DECIDED |

| G1-D-003 | Routine Branch Manager expense requests are normally approved by the Finance Manager; the General Manager is the only substitute when Finance is unavailable. | G1-C-001 clarification | User response, 2026-08-25 | USER-DECIDED; supersedes G1-B03 interpretation |

| G2-D-001 | Refunds/cancellations are permitted only under documented conditions; original payment remains immutable and Finance records the refund. | G2-B01 | User response, 2026-08-25 | USER-DECIDED |
| G2-D-002 | Discounts may be applied only when published or separately approved, with eligibility, dates, and audit; reversal is a controlled correction. | G2-B02 | User response, 2026-08-25 | USER-DECIDED |
| G2-D-003 | If no program-specific progression rule exists, a student does not advance automatically; Academic Management must review and decide. | G2-B03 | User response, 2026-08-25 | USER-DECIDED |
| G2-D-004 | If an employment contract is silent on absence, overtime, advances, or deductions, Payroll holds the affected entry for HR and Finance review and does not invent a charge or payment. | G2-B04 | User response, 2026-08-25 | USER-DECIDED |
| G2-D-005 | If a restricted-fund agreement is silent after its supported student or program ends, funds remain restricted and on hold until authorized clarification. | G2-B05 | User response, 2026-08-25 | USER-DECIDED |
| D-F-100 | Application technology is PHP with the Laravel framework; the database is PostgreSQL. The system remains a modular monolith with strict contexts. This resolves the previously open D-F-003 and legacy findings L-002/L-003; ADR-013 records the architectural decision. | User response, 2026-08-25 | USER-DECIDED; supersedes D-F-003 |
| D-F-101 | The Implementation Quality Directive is adopted as the mandatory standing engineering standard for every implementation artifact in every package, codified at `docs/implementation/21-implementation-quality-directive.md`. It does not by itself authorize any package. | User directive, 2026-08-25 | USER-DIRECTED |

## Decisions explicitly not imported

Existing repository decisions about currency, language, notifications, treasury thresholds, backup, placement, finance, or prior work packages remain legacy evidence. They are not part of this session's approved business decision set until explicitly confirmed.

## Decision protocol

Each future critical decision must include the plain-language question, options, recommendation, operational consequences, affected domains, rules, invariants, permissions/scopes, and the user's explicit decision.

## Gate 3 remediation decisions

- **D-G3-001:** Financial balances are derived from posted source facts; payment, refund, discount, adjustment, reversal, journal, allocation, and reconciliation remain distinct.
- **D-G3-002:** Academic evidence is not an official academic decision; appeals and corrections preserve prior history.
- **D-G3-003:** Contractual entitlement, payroll calculation, payroll result, and actual payment remain distinct.
- **D-G3-004:** Authority is modeled as Position + Assignment + Permission + Scope + Policy, with default deny and expiration for temporary authority.
- **D-G3-005:** Gate 3 remediation passes with non-blocking open items; Gate 4 is not automatically started.
