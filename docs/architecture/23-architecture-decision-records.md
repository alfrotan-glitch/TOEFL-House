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
| ADR-013-A | AMENDMENT (2026-08-25): PHP + PostgreSQL remain; the Laravel framework is replaced by a framework-free modular monolith implementing the same approved architecture intent | Laravel/Composer/Packagist are unreachable in the build environment (SSL connect failures; see `docs/implementation/22-environment-blocker-report.md`); user decision selected the framework-free variant; approved architecture (ADR-001–012, module contracts, authorization/lifecycle/audit contracts) preserved without framework substitution |

## ADR-013 record — technology selection

- **Decision:** The application is implemented in PHP with the Laravel framework; the database is PostgreSQL. The system remains a modular monolith with strict contexts (ADR-001) and module ownership per canonical domain (ADR-002).
- **Authority:** User decision, 2026-08-25, resolving previously open decision `D-F-003` and legacy findings L-002/L-003 in `docs/foundation/01-legacy-system-intelligence-report.md`.
- **Consequences:**
  - Schema ownership stays per module (ADR-002); migrations are owned by the owning module.
  - The database enforces structural invariants only (directive clause 15); it is not a competing business-rule engine. The legacy trigger-heavy schema is not reused.
  - Verification gates (typecheck, lint, static analysis, tests, migration validation) run under `docs/implementation/21-implementation-quality-directive.md` with the tooling chosen in each package plan.
  - No UI-first sequencing is authorized; package order follows `docs/implementation/17-implementation-sequence.md`.

## ADR-013-A amendment — environment-forced framework substitution

- **Decision:** PHP + PostgreSQL remain the application technology and persistence. The Laravel framework is substituted by a **framework-free modular monolith** that implements the approved architecture intent directly: module-owned contexts and persistence (ADR-001/002), owner-bound commands with atomic fact-plus-audit commits (ADR-003/010), policy-based Position + Assignment + Permission + Scope + Policy authorization (ADR-005), context-owned state machines (ADR-007), and contract-grade error/idempotency/audit behavior per `docs/implementation/`.
- **Authority:** Environment blocker verified 2026-08-25 (Composer/Packagist/getcomposer.org/raw.githubusercontent.com unreachable — SSL connection failures; evidence in `docs/implementation/22-environment-blocker-report.md`); user decision 2026-08-25 selecting the framework-free variant; Decision Ledger `D-F-102`.
- **What is preserved unchanged:** modular monolith with strict contexts (ADR-001); module ownership per canonical domain (ADR-002); owner-bound commands and post-commit notification model (ADR-003); transactional source facts (ADR-004); policy-based authorization (ADR-005); reusable approval records (ADR-006); context-owned state machines (ADR-007); separated domain boundaries (ADR-008); versioned projections (ADR-009); append-only audit (ADR-010); anti-corruption adapters (ADR-011); all module, authorization, lifecycle, error, idempotency, testing, and migration implementation contracts in `docs/implementation/`.
- **What changes:** the framework layer (Laravel's container, ORM, HTTP kernel, service providers) is replaced by a minimal, framework-free kernel implemented in this repository: PSR-4-style autoloader, typed PDO persistence, module-owned migrations, deterministic error taxonomy, idempotency store, and a custom test/verification harness. No business rule, lifecycle, authorization decision, or audit semantic is altered by the substitution.
- **Consequences:**
  - Verification tooling is framework-free: syntax lint (`php -l`), a repository static-analysis/typecheck tool, the package test harness, and migration up/down validation — all runnable with the installed PHP 8.2.27 CLI only.
  - No third-party PHP package is required; dependency discipline (directive clause 20) is satisfied by construction.
  - The substitution is environment-forced, not a preference; if Composer/Packagist ever become reachable in a maintained environment, this amendment must be re-reviewed before any framework reintroduction.

Consequences of ADR-001–012 are captured in artifacts `01`–`22`; those ADRs select no technology. ADR-013 (user decision, 2026-08-25) selects PHP + Laravel + PostgreSQL; ADR-013-A (user decision, 2026-08-25) amends the framework selection to framework-free PHP while keeping PostgreSQL, per the environment blocker report.
