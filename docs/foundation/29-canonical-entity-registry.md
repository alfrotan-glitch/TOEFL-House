# Canonical Entity Registry

**Status:** Gate 3 remediation model

| Entity | Type | Owning domain | Authoritative responsibility | Immutable facts |
|---|---|---|---|---|
| Organization/Campus/Branch/Department | domain entities | Organization | structure and current scope | identity, historical attribution |
| Person | domain entity | People | verified human identity | identity evidence and merge history |
| User Account | domain entity | Identity | authentication identity | account creation/deactivation history |
| Position/Position Assignment | entity + relationship | Identity/HR | job and effective responsibility | assignment dates and approver |
| Role/Permission/Scope Grant | entity + relationship | Access | effective authorization | grant, scope, dates, approver |
| Delegation | relationship entity | Governance | temporary authority | delegator, recipient, limits, dates |
| Guardian Relationship/Consent/Disclosure | relationship entities | Student/Privacy | relationship and disclosure authority | verification, consent, revocation |
| Visitor/Applicant/Admission Decision | entities | Admissions | prospect and admission outcome | decision, reason, evidence |
| Student/Student Status | entity + history | Students | student identity and lifecycle | identity, status transitions |
| Program/Version/Level/Academic Period | entities | Academic Structure | academic definitions | published definitions and dates |
| Enrollment/Class Membership/Class/Session | entities | Academic Delivery | participation and delivery | membership, schedule, attendance facts |
| Teacher Assignment/Substitution | relationship entities | Academic Delivery | teaching responsibility | assignment scope and dates |
| Attendance Record | fact entity | Academic Delivery | attendance fact | original mark and correction history |
| Assessment Attempt/Evidence/Result | entities | Assessment | evidence and result | submitted evidence and approved result |
| Progression Decision/Academic Appeal | decision entities | Academic | progression and appeal outcomes | decision, reason, reviewer |
| Employment/Contract/Compensation | entities | HR | employment terms and entitlement | signed terms, effective dates |
| Leave/Performance/Termination/Settlement | entities | HR | employee events and closure | approvals and history |
| Payroll Period/Calculation/Result/Adjustment | entities | Payroll | calculated entitlement and payment instruction | approved calculation and correction |
| Account/Financial Period/Journal/Journal Line | entities | Finance | accounting truth | posted financial facts |
| Obligation/Payment/Allocation/Refund/Discount/Adjustment/Reversal | entities | Student Finance | receivable lifecycle | source, amount, approval, reversal links |
| Cash Drawer/Cash Movement/Reconciliation | entities | Finance | physical cash and variance | custody and observed counts |
| Funding Source/Fund/Restriction/Scholarship Award | entities | Funding | restricted funding truth | agreement and restriction |
| Book/Issuance/Return/Loss/Damage/Asset/Custody | entities | Resources | resource ownership and custody | custody and movement history |
| Facility/Maintenance Request/Work Order | entities | Facilities | operational work | request, approval, completion |
| Document/Version/Verification/Retention Decision | entities | Documents | evidence and retention | original/version/verification history |
| Incident/Complaint/Report/Export/Notification | entities | Security/Reporting/Communication | controlled operational outputs | actor, purpose, outcome |
| Approval Request/Review/Decision/Conflict | entities | Governance | decision evidence | approvers and decisions |
| Audit Event | append-only evidence | Audit | accountability | actor, target, before/after, time |

No entity above owns another domain's truth. States, events, configuration, value objects, and projections are not substituted for domain entities.
