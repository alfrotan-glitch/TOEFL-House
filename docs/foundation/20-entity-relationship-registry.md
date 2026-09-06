# Entity and Relationship Registry

**Status:** Foundation model draft

## Canonical business entities

| Entity | Owning domain | Key relationships | Historical requirement |
|---|---|---|---|
| Organization | Organization | contains campuses and departments | preserve structural history |
| Campus | Organization | belongs to organization; contains branches/units | effective attribution |
| Branch | Organization | belongs to campus; has manager and units | transfer history immutable |
| Department / Unit | Organization | scoped to organization/campus/branch; has head | scope history |
| Person | People | may have accounts, roles, relationships | verified merge only |
| User Account | Identity | belongs to person; has assignments | access history |
| Position Assignment | Identity/HR | person + position + scope + dates | immutable assignment history |
| Role Assignment | Access | person/account + role + scope + dates | approval and expiry |
| Delegation | Governance | delegator + recipient + authority + scope + dates | approval and audit |
| Visitor / Applicant | Admissions | person/contact; may become student | conversion trace |
| Student | Students | person; guardians; enrollments; obligations | academic/financial history |
| Guardian Relationship | People/Students | guardian + student + permissions | verification and revocation |
| Program / Version | Academic Structure | levels, courses, rules | published version immutable |
| Academic Period | Academic Structure | program/classes/payroll/reporting | published period immutable |
| Class / Session | Academic Delivery | period, level, teacher, room | schedule and attendance history |
| Enrollment | Academic Delivery | student + class + period | state history |
| Attendance Fact | Academic Delivery | student + session | correction history |
| Assessment / Result | Assessment | student + class/attempt | result and correction history |
| Employment / Contract | HR | person + position + compensation | employment history |
| Leave / Performance Record | HR | employee + period + approver | decision history |
| Payroll Period / Entry | Payroll | employee/teacher + financial period | locked history |
| Account / Journal / Transaction | Finance | financial events and periods | immutable financial fact |
| Obligation / Payment / Allocation | Student Finance | student + source + financial records | reconciliation |
| Discount / Refund | Student Finance | obligation/payment + approval | no silent mutation |
| Scholarship / Fund / Sponsorship | Funding | student/program + restriction | agreement history |
| Book / Inventory Item / Asset | Resources | location, custodian, movement | custody history |
| Facility / Work Order | Facilities | branch/campus + requester | operational history |
| Document / Version | Documents | owner resource + permissions | retention and version history |
| Approval Request / Decision | Governance | resource + actor + approvers | append-only decision history |
| Audit Event / Security Incident | Audit/Security | actor + resource + context | append-only |
| Report Definition / Run | Reporting | authority source + period + scope | reproducible output |
| Notification / Communication | Communication | event + recipient + template | delivery history |

## Relationship principles

- Relationships are explicit records when they affect authority, privacy, money, or history.
- Scope is not inferred from a person's home branch when a narrower or different assignment exists.
- A student, teacher, employee, guardian, donor, or sponsor may have multiple relationships without duplicate person identities.
- A record may have a current owner and historical owners; current ownership never erases prior attribution.
- Derived reporting relationships consume authoritative records and do not become new authorities.
