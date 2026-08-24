# Architecture Boundary Model

**Purpose:** business architecture boundary only; no technology, schema, API, UI, or implementation decision is made here.

| Boundary | Owns | May consume | Must not own |
|---|---|---|---|
| Organization/Governance | structure, ownership, policy decisions, approvals | identity and audit evidence | operational facts owned by domains |
| Identity | person identity, account linkage, authentication identity | verified person evidence | permissions or business status |
| Access/RBAC/Scope | position, assignment, permission, policy, scope, delegation | organization structure and approvals | identity, financial, academic, or HR facts |
| Admissions/Students/Guardians | applications, admission, student and verified relationship facts | identity, academic and financial outcomes | grades, balances, access grants |
| Academic/Placement/Classes/Attendance/Assessment | academic evidence and official decisions | student, staffing, program configuration | financial truth or payroll truth |
| HR/Teachers/Payroll | employment, contracts, work basis, payroll calculation/results | assignments, attendance/work evidence, finance posting | academic decisions or payment truth |
| Finance/Receivables/Payments/Refunds/Discounts/Funding | posted financial transactions, obligations, settlement, funds, reconciliation | approved business facts | mutable dashboard balances |
| Books/Inventory/Assets/Facilities | custody, stock, asset, and operational work facts | people, locations, approvals, finance outcomes | financial journal truth |
| Communication/Documents/Privacy | documents, consent, disclosure, delivery, verification, retention | authoritative domain facts and authorization | recipient authority or source business facts |
| Audit | append-only accountability evidence | all material domain events and approvals | business-state ownership |
| Reporting | metric definitions, derived calculations, report runs | canonical facts and period/scope definitions | any authoritative fact |
| Infrastructure | availability, storage, transport, recovery controls | none as business authority | business policy and domain meaning |

Application/service orchestration may coordinate commands and transactions, but cannot become an additional source of truth. Authorization evaluates every material operation before the owning domain accepts it. Configuration is versioned input; it never rewrites facts.

## Architecture readiness conclusion

The boundary is translatable without importing legacy semantics. Unresolved numeric thresholds and agreement-specific rules remain explicit configuration/policy inputs and fail closed where absent.
