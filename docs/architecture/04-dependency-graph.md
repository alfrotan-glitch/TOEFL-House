# Dependency Graph

Acyclic authority direction:

```text
Organization -> Authorization/Scope
Identity -> Admissions/Students, HR
Admissions/Students -> Enrollment, Academic, Finance
Enrollment -> Academic (canonical delivery facts/read constraints), Finance (eligibility gate)
Academic -> Students, Scheduling (planning constraints), HR/Payroll, Reporting
Scheduling -> Academic, Enrollment, Organization/Resources (read/constraint contracts only)
HR -> Payroll, Authorization; Payroll -> Finance (approved posting input)
Finance -> Reporting, Students, Funding
Funding -> Finance (restriction input)
Assets/Inventory/Facilities -> Finance (approved financial-effect input)
Privacy/Documents -> Communication and every disclosure gate
All source contexts -> Outbox -> Work Management, Communication/Notifications, Reporting, Search, Integrations
All contexts -> Audit and Reporting (read/record only)
Effective identity/authority/lifecycle + all relevant contexts -> Employee Workspace (composition/read/action links only)
Employee Workspace -> canonical owner commands (authorized command entry; no direct writes)
Work Management -> canonical source commands only through explicit action links; never direct source writes
```

Employee Workspace is an orchestration sink for effective context and canonical work entry. It must not become an upstream authority or a dependency of domain truth.

Dependencies are fact-oriented and must use the integrated graph's typed relationship vocabulary: the receiver reads an owner-owned fact, submits a command to the owner, validates a precondition, consumes an event, or projects a read representation as explicitly classified. Synchronous calls are used for authorization, preconditions, and decisions requiring immediate outcome. Asynchronous notifications are used after commit for reporting refresh, communication, and integrations. No receiver writes another context's tables or storage. This eliminates circular authority; application coordination may call multiple contexts only through commands and compensating/reversal operations.
