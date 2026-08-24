# Command and Query Registry

| Command family | Owner | Authorization/scope | Transaction/audit |
|---|---|---|---|
| structure, ownership, assignment, delegation | Organization/Access | operation-specific, Owner rules | owner fact + approval/audit |
| identity verify/link/deactivate | Identity | identity/admin scope | identity transaction |
| apply/admit/convert/enroll/withdraw | Admissions/Students | admissions/student scope | student/enrollment audit |
| place/score/approve/appeal/graduate | Academic | academic scope and SoD | evidence/decision transaction |
| schedule/assign/attendance-correct | Academic | class/branch scope | append-only audit |
| employ/contract/leave/terminate/calculate/payroll | HR/Payroll/Finance | HR/payroll/finance SoD | period transaction |
| obligation/payment/allocate/refund/discount/adjust/reverse/journal/reconcile | Finance | finance scope, approval | source-linked financial transaction |
| fund/award/allocate | Funding/Finance | agreement and finance authority | restriction/posting audit |
| issue/return/move/dispose/complete work | Assets/Inventory/Facilities | custody/location scope | movement audit |
| verify/disclose/consent/revoke/export/send | Privacy/Documents/Communication | purpose/scope/consent | privacy/audit transaction |
| metric define/run/reconcile | Reporting | reporting scope | immutable run metadata |

Queries include effective entity detail, authorized lists with scope/as-of parameters, workflow status, statements, evidence, decisions, audit history, report runs, reconciliation, and job status. All pagination, filtering, and sorting are read-only and scope-filtered. No query result is an authority to mutate.
