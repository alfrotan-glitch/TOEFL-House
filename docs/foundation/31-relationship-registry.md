# Relationship Registry

| Parent ↔ Child | Cardinality | Required | Owner | Effective dates | History/transfer/deletion |
|---|---|---|---|---|---|
| Organization ↔ Campus | 1:N | campus requires one | Organization | active dates | close, never delete history |
| Campus ↔ Branch | 1:N over time | branch has one active campus | Organization | from/to required | transfer closes prior link |
| Organization/Campus/Branch ↔ Department Unit | 1:N | unit has one scope | Organization | from/to | scope change appends link |
| Person ↔ User | 1:0..N | account requires person | Identity | account dates | deactivate, no duplicate verified account |
| Person ↔ Position Assignment | 1:N | assignment requires person/position | HR | required | close prior assignment |
| Position ↔ Role | N:M via role policy | role may have many | Access | policy version dates | version, do not rewrite active history |
| Role ↔ Permission | N:M | permission required | Access | policy dates | grant history |
| Permission ↔ Scope Grant | 1:N | grant has scope | Access | required | expiry/revocation retained |
| Person ↔ Student/Employee | 1:0..N | identity required | People/Students/HR | status dates | no silent merge |
| Student ↔ Guardian | N:M via relationship | verification required | Students | from/to | revoke, retain history |
| Student ↔ Admission | 1:N | applicant/admission | Admissions | decision date | prior decisions retained |
| Student ↔ Enrollment | 1:N | period required | Academic | from/to | transfer closes old enrollment |
| Enrollment ↔ Program/Level/Period | N:1 each | required | Academic Structure | effective period | published references immutable |
| Enrollment ↔ Class Membership | 1:N over time | class required | Academic Delivery | from/to | old membership retained |
| Class ↔ Session | 1:N | session needs class | Academic Delivery | scheduled date | cancellation retained |
| Class ↔ Teacher Assignment | N:M via assignment | dates required | Academic Delivery | from/to | substitution is separate |
| Teacher/Employee ↔ Branch | N:M via assignment | explicit scope | HR/Academic | from/to | branch history retained |
| Employee ↔ Contract | 1:N | effective contract | HR | from/to | prior contract closed |
| Contract ↔ Compensation | 1:N | contract basis | HR | from/to | entitlement immutable once used |
| Employee ↔ Leave/Payroll | 1:N | period required | HR/Payroll | period dates | correction/reversal retained |
| Obligation ↔ Payment | N:M via Allocation | source required | Finance | posting date | allocation cannot exceed source |
| Payment ↔ Refund | 1:N via Refund Line | source required | Finance | refund date | original payment retained |
| Obligation ↔ Discount | 1:N | approval required | Finance | effective date | original charge retained |
| Adjustment ↔ Journal | 1:N source link | journal required | Finance | posting date | source and reversal linked |
| Journal ↔ Journal Lines | 1:N | balanced journal | Finance | period | posted lines immutable |
| Fund ↔ Restriction/Allocation | 1:N | restriction as applicable | Funding | agreement dates | no silent reclassification |
| Scholarship ↔ Student | N:1 | award required | Funding | award dates | revocation retains history |
| Book ↔ Issuance/Inventory | 1:N | item/source required | Resources | movement dates | custody history retained |
| Asset ↔ Custody | 1:N | custodian/location | Resources | from/to | disposal closes custody |
| Document ↔ Person/Student/Employee | N:1 target | owner required | Documents | version dates | archive, do not expose by URL |
| Consent ↔ Subject/Purpose | N:1 per purpose | purpose required | Privacy | from/to/revoked | revocation retained |
| Disclosure ↔ Recipient/Purpose | N:1 event | authority required | Privacy | disclosure time | append-only |
| Approval ↔ Action/Resource | 1:N reviews | action required | Governance | request/decision dates | rejection/cancel retained |
| Audit Event ↔ Actor/Target | N:1 each | actor/target as applicable | Audit | event time | append-only |
