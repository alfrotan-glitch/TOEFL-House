# Dependency Graph

Acyclic authority direction:

```text
Organization -> Authorization/Scope
Identity -> Admissions/Students, HR
Admissions/Students -> Academic, Finance
Academic -> Students, HR/Payroll, Reporting
HR -> Payroll, Authorization; Payroll -> Finance (approved posting input)
Finance -> Reporting, Students, Funding
Funding -> Finance (restriction input)
Assets/Inventory/Facilities -> Finance (approved financial-effect input)
Privacy/Documents -> Communication and every disclosure gate
All contexts -> Audit and Reporting (read/record only)
```

Dependencies are fact-oriented: the receiver reads an owner-owned fact or submits a command to the owner. Synchronous calls are used for authorization, preconditions, and decisions requiring immediate outcome. Asynchronous notifications are used after commit for reporting refresh, communication, and integrations. No receiver writes another context's tables or storage. This eliminates circular authority; application coordination may call multiple contexts only through commands and compensating/reversal operations.
