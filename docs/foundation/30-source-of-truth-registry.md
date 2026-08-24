# Source-of-Truth Registry

| Fact | Canonical source | Allowed writer | Forbidden writer | Derived? | Historical rule |
|---|---|---|---|---|---|
| Person identity | Person + verified identity evidence | People authority | Student/HR screens | No | merge only by verified decision |
| User identity | User Account | Identity authority | Person profile | No | deactivate, never erase |
| Employment | Employment/Contract | HR | Payroll/manager shortcuts | No | append effective terms |
| Position assignment | Position Assignment | HR/governance | Role editor | No | close prior assignment |
| Role/permission/scope | Role/Permission/Scope Grant | Access governance | UI or domain consumer | No | dated, approved, auditable |
| Delegation | Delegation | Governance authority | recipient | No | expires automatically |
| Student identity/status | Student + Student Status History | Students | Enrollment/report | Status summary derived | preserve transitions |
| Guardian relationship | Guardian Relationship | Student/People authority | parent portal | No | verification/revocation history |
| Admission | Admission Decision | Admissions/Academic authority | Reception conversion alone | No | decision and evidence retained |
| Enrollment/class membership | Enrollment + Class Membership | Academic Delivery | Student balance/report | No | transfer closes old membership |
| Academic period | Academic Period | Academic Structure | report/payroll | No | published period immutable |
| Class/session/attendance | Class, Session, Attendance Record | Academic Delivery | Teacher profile | Attendance metrics derived | corrections append history |
| Assessment/placement/progression | Evidence, Result, Progression Decision | Assessment/Academic | score widget/report | summaries derived | original decisions retained |
| Graduation/certificate | Graduation Eligibility Decision + Certificate | Completion | level/status summary | No | issued record immutable |
| Compensation/payroll | Contract/Compensation; Payroll Calculation/Result | HR/Payroll | manager or report | totals derived | corrections reverse/adjust |
| Financial obligation | Obligation/Obligation Line | Student Finance | balance field | Balance derived | original charge retained |
| Payment/allocation/refund | Payment, Allocation, Refund | Finance | student UI | Balance derived | source never deleted |
| Discount/adjustment/reversal | Discount, Adjustment, Reversal | Finance under approval | direct balance writer | No | original obligation preserved |
| Journal/ledger | Journal + Journal Lines | Finance | operational modules | Ledger balance derived | posted journals immutable |
| Cash/reconciliation | Cash Drawer, Movement, Reconciliation | Finance | cashier summary | position derived | observed variance retained |
| Scholarship/funding | Award, Fund, Restriction, Allocation | Funding + Finance | student profile | utilization derived | agreement and restriction retained |
| Book/asset custody | Issuance/Custody/Movement | Resources | student or branch summary | stock derived | movement history retained |
| Document/consent/disclosure | Document Version, Consent, Disclosure | Documents/Privacy | arbitrary URL/UI | No | retention and revocation retained |
| Audit event | Audit Event | Audit subsystem | end users | No | append-only |
| Report | Report Definition + authoritative source facts | Reporting | dashboard copy | Metrics derived | reproducible by period/scope |
