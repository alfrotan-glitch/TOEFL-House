# Architecture Traceability

| Foundation requirement/rule | Entity/domain | Architecture component | Command/boundary | Audit | Future test |
|---|---|---|---|---|---|
| canonical ownership | all contexts | module owner/repository boundary | owner command | material audit | contract |
| financial transaction integrity | Finance | financial boundary | post/allocate/refund/adjust | transaction audit | financial/concurrency |
| authority and scope | Access/Organization | policy decision point | authorize operation | decision/approval audit | auth/scope |
| immutable history | all material facts | history/audit boundary | correct/reverse/appeal | before/after/effective | history |
| academic evidence/decision | Academic | evidence and decision components | submit/approve/appeal | academic audit | academic |
| payroll separation | HR/Payroll/Finance | period/calculation/posting boundaries | calculate/approve/pay | payroll/finance audit | payroll |
| privacy | Privacy/Documents | purpose/consent/export gate | disclose/revoke/export | disclosure audit | privacy |
| derived reporting | Reporting | metric registry/projection | run/reconcile | run/source metadata | reporting |
| cross-domain contracts | all | application coordinator/adapters | command/event | correlation audit | contract/integration |
| resilience | Infrastructure boundary | backup/recovery/job durability | restore/replay | recovery evidence | resilience |

Broken chains: **none identified**. Detailed operation acceptance examples and organization-specific resilience targets remain future inputs, not broken ownership chains.
