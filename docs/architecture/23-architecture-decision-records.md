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
| ADR-013 | Application technology: PHP with Laravel; persistence: PostgreSQL; remains a modular monolith per ADR-001 | Express/TypeScript + SQLite (legacy stack) rejected as untrusted legacy with trigger-heavy cross-domain schema; Node/TypeScript + PostgreSQL rejected by user decision; distributed services rejected per ADR-001 |

## ADR-013 record — technology selection

- **Decision:** The application is implemented in PHP with the Laravel framework; the database is PostgreSQL. The system remains a modular monolith with strict contexts (ADR-001) and module ownership per canonical domain (ADR-002).
- **Authority:** User decision, 2026-08-25, resolving previously open decision `D-F-003` and legacy findings L-002/L-003 in `docs/foundation/01-legacy-system-intelligence-report.md`.
- **Consequences:**
  - Schema ownership stays per module (ADR-002); migrations are owned by the owning module.
  - The database enforces structural invariants only (directive clause 15); it is not a competing business-rule engine. The legacy trigger-heavy schema is not reused.
  - Verification gates (typecheck, lint, static analysis, tests, migration validation) run under `docs/implementation/21-implementation-quality-directive.md` with the tooling chosen in each package plan.
  - No UI-first sequencing is authorized; package order follows `docs/implementation/17-implementation-sequence.md`.

Consequences of ADR-001–012 are captured in artifacts `01`–`22`; those ADRs select no technology. ADR-013 (user decision, 2026-08-25) selects PHP + Laravel + PostgreSQL.
