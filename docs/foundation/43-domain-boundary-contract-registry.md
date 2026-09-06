# Domain Boundary Contract Registry

| Source → receiver | Fact exchanged | Owner | Direction and mode | Failure/audit |
|---|---|---|---|---|
| Organization → Access | active structure and assignments | Organization/Access respectively | access decision reads effective structure | deny if unavailable; audit |
| Identity → Admissions/HR | verified person identity | Identity | command input/read | reject unverified identity; audit |
| Admissions → Students/Academic/Finance | approved admission and liable-party facts | Admissions/Students | decision then notification | no downstream activation without approval |
| Students → Academic/Finance | student/enrollment facts | Students/Enrollment | read/decision input | reject stale/inactive membership |
| Academic → HR/Payroll | approved work basis/teaching evidence | Academic for teaching fact; HR for employment | controlled input | hold disagreement; preserve evidence |
| Academic → Students | approved results and decisions | Academic | decision output | no inference from raw evidence |
| HR → Payroll/Access | contract, assignment, status | HR | decision input | deny expired employment; audit |
| Finance → Reporting | posted journals and transactions | Finance | read/derived | report unavailable or flagged on incomplete close |
| Finance ↔ Funding | restricted fund and allocation facts | Finance/Funding by fact | controlled command/read | hold unauthorized reclassification |
| Finance → Students | obligation/payment status | Finance | derived read | no student-side mutation |
| Assets/Inventory → Finance | approved asset/custody events with financial effect | Assets/Inventory source event; Finance posting | command/event | reject unapproved posting; audit |
| Privacy → Communication | consent and disclosure authorization | Privacy | synchronous authorization/read | deny absent purpose/authority |
| All domains → Audit | material change and approval evidence | Audit | append-only notification/record | operation cannot claim complete without audit evidence |
| All domains → Reporting | canonical facts and metric metadata | each source domain | read/derived | no alternate metric authority |

A contract names owner, allowed input, authority context, scope, effective date, outcome, and failure behavior. Notifications cannot transfer ownership. Circular authority is prohibited: a receiver may validate prerequisites but cannot rewrite the source fact.
