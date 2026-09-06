# Architecture Traceability

| Foundation requirement/rule | Entity/domain | Architecture component | Command/boundary | Audit | Future test |
|---|---|---|---|---|---|
| canonical ownership | all contexts | module owner/repository boundary | owner command | material audit | contract |
| financial transaction integrity | Finance | financial boundary plus student coverage serialization | post/allocate/refund/adjust/approve/enrollment gate | transaction audit | financial/concurrency |
| authority and scope | Access/Organization | policy decision point | authorize operation | decision/approval audit | auth/scope |
| effective topology provenance | Organization/Access/Reporting/Resources | effective-dated campus attribution and matching provenance guards | resolve as-of day / reject future or stale topology | scope and correction audit | scope/provenance |
| immutable history | all material facts | history/audit boundary | correct/reverse/appeal | before/after/effective | history |
| academic evidence/decision | Academic | evidence and decision components | submit/approve/appeal | academic audit | academic |
| payroll separation | HR/Payroll/Finance | period/calculation/posting boundaries | calculate/approve/pay | payroll/finance audit | payroll |
| privacy | Privacy/Documents | purpose/consent/export gate | disclose/revoke/export | disclosure audit | privacy |
| derived reporting | Reporting | metric registry/projection | run/reconcile | run/source metadata | reporting |
| cross-domain contracts | all | application coordinator/adapters | command/event | correlation audit | contract/integration |
| resilience | Infrastructure boundary | backup/recovery/job durability | restore/replay | recovery evidence | resilience |
| employee workspace composition | employee identity, employment, positions, assignments, scope, capabilities | workspace composition/orchestration | compose/link/execute canonical action | correlation and material action audit | workspace contract |
| workspace authorization | Access/Organization plus owning domain | server policy decision point and owner command | authorize/recheck/execute | decision and owner audit | workspace/auth |
| workspace tasks and exceptions | owning domain facts plus outbox/projections | task/notification/work-context projection | acknowledge/link/route, never redefine | projection and source correlation | workspace/integration |
| workspace productivity | presentation preferences | isolated personalization layer | save/apply preference | preference audit where material | workspace/usability |
| integrated enterprise graph | all major facts, contexts, commands, events, projections, workflows, documents, notifications, search, reports, and management decisions | owner/boundary/typed-edge registry | canonical command/query/event path | correlation and source lineage | architecture/conformance |
| critical failure behavior | duplicate, concurrent, stale, unauthorized, provenance, downstream, retry, replay conditions | command/event failure contract | idempotent/retry/conflict handling | failure evidence | resilience/concurrency |

Broken chains: **none identified** at the documented target level. Detailed operation acceptance examples and organization-specific resilience targets remain future inputs, not broken ownership chains. Integrated graph repository conformance, Employee Workspace runtime, API/web parity, freshness, concurrency, and authorization proof remain deferred validation.
