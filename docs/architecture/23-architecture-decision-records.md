# Architecture Decision Records

| ADR | Decision | Alternatives/reason |
|---|---|---|
| ADR-001 | Modular monolith with strict contexts | microservices/SOA rejected as premature operational/distributed complexity |
| ADR-002 | Module ownership follows canonical domains | table/screen modules rejected as duplicate authority |
| ADR-003 | Owner-bound commands with post-commit notifications | shared writes/distributed hidden transactions rejected |
| ADR-004 | Transactional source facts; derived projections | mutable balances and report authority rejected |
| ADR-005 | Policy-based Position+Assignment+Permission+Scope+Policy | generic role-only ACL rejected |
| ADR-006 | Reusable approval records with domain-selected templates | hard-coded generic business workflows rejected |
| ADR-007 | Context-owned state machines and append-only correction | universal status and overwrites rejected |
| ADR-008 | Academic evidence separate from decision; HR/payroll/finance separated | inferred status and payroll accounting shortcuts rejected |
| ADR-009 | Versioned metric projections from canonical facts | independent dashboard calculations rejected |
| ADR-010 | Append-only audit committed with material facts | mutable logs as sole history rejected |
| ADR-011 | Anti-corruption integration adapters, idempotent jobs | vendor coupling and unsafe retries rejected |
| ADR-012 | RPO/RTO and migration values deferred as explicit operations | invented policy and legacy reuse rejected |

Consequences are captured in artifacts `01`–`22`; no framework, vendor, schema, API, or deployment technology is selected by these ADRs.
