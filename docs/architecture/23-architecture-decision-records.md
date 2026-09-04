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
| ADR-014 | Academic offerings/availability lifecycle, offering-targeted enrollment capacity, and ordered class waitlists stay in Academic (see `decisions/wp-academic-offerings-waitlist.md`) | offering-less soft seats and silent waitlist auto-activation rejected |
| ADR-015 | Academic rooms, class sections and the timetable/scheduling surface stay in Academic (see `decisions/wp-academic-rooms-sections-timetable.md`) | ad-hoc room strings and unconstrained per-class session lists rejected |
| ADR-016 | Released Placement recommendations produce an Academic-owned signed, versioned, immutable eligibility snapshot (see `decisions/wp-academic-eligibility-snapshot.md`) | live recomputation and unsigned downstream references rejected |
| ADR-017 | Enrollment activation is gated by an authoritative Finance assessment (payment/discount/waiver/funding, credit, installment, approved exception) — see `decisions/wp-enrollment-financial-gate.md` | Academic-side balances and off-DB frontend state rejected |
| ADR-018 | Level-aware progression, level prerequisites, immutable per-level academic history, and an offering-linked Finance charge reference — see `decisions/wp-academic-level-progression-and-packaging.md` | auto-progression from scores, Academic-owned fee amounts, and free-text prerequisite strings rejected |
| ADR-013-A | **REJECTED/WITHDRAWN 2026-08-25.** Original amendment text (historical record): "PHP + PostgreSQL remain; the Laravel framework is replaced by a framework-free modular monolith implementing the same approved architecture intent" | Historical alternatives text: "Laravel/Composer/Packagist are unreachable in the build environment (SSL connect failures; see `docs/implementation/22-environment-blocker-report.md`); user decision selected the framework-free variant". **Correction:** no user decision selected the framework-free variant; the environment blocker is not a technology decision. See the ADR-013-A rejection record below. ADR-013 remains authoritative. |

## ADR-013 record — technology selection

- **Decision:** The application is implemented in PHP with the Laravel framework; the database is PostgreSQL. The system remains a modular monolith with strict contexts (ADR-001) and module ownership per canonical domain (ADR-002).
- **Authority:** User decision, 2026-08-25, resolving previously open decision `D-F-003` and legacy findings L-002/L-003 in `docs/foundation/01-legacy-system-intelligence-report.md`.
- **Consequences:**
  - Schema ownership stays per module (ADR-002); migrations are owned by the owning module.
  - The database enforces structural invariants only (directive clause 15); it is not a competing business-rule engine. The legacy trigger-heavy schema is not reused.
  - Verification gates (typecheck, lint, static analysis, tests, migration validation) run under `docs/implementation/21-implementation-quality-directive.md` with the tooling chosen in each package plan.
  - No UI-first sequencing is authorized; package order follows `docs/implementation/17-implementation-sequence.md`.

## ADR-013-A amendment — environment-forced framework substitution — REJECTED/WITHDRAWN

> **Status: REJECTED/WITHDRAWN (2026-08-25) — does not take effect.**
> The text below is preserved verbatim as the historical record of the withdrawn amendment.
> The correction is recorded in the ADR-013-A rejection record that follows.

- **Decision:** PHP + PostgreSQL remain the application technology and persistence. The Laravel framework is substituted by a **framework-free modular monolith** that implements the approved architecture intent directly: module-owned contexts and persistence (ADR-001/002), owner-bound commands with atomic fact-plus-audit commits (ADR-003/010), policy-based Position + Assignment + Permission + Scope + Policy authorization (ADR-005), context-owned state machines (ADR-007), and contract-grade error/idempotency/audit behavior per `docs/implementation/`.
- **Authority:** Environment blocker verified 2026-08-25 (Composer/Packagist/getcomposer.org/raw.githubusercontent.com unreachable — SSL connection failures; evidence in `docs/implementation/22-environment-blocker-report.md`); user decision 2026-08-25 selecting the framework-free variant; Decision Ledger `D-F-102`.
- **What is preserved unchanged:** modular monolith with strict contexts (ADR-001); module ownership per canonical domain (ADR-002); owner-bound commands and post-commit notification model (ADR-003); transactional source facts (ADR-004); policy-based authorization (ADR-005); reusable approval records (ADR-006); context-owned state machines (ADR-007); separated domain boundaries (ADR-008); versioned projections (ADR-009); append-only audit (ADR-010); anti-corruption adapters (ADR-011); all module, authorization, lifecycle, error, idempotency, testing, and migration implementation contracts in `docs/implementation/`.
- **What changes:** the framework layer (Laravel's container, ORM, HTTP kernel, service providers) is replaced by a minimal, framework-free kernel implemented in this repository: PSR-4-style autoloader, typed PDO persistence, module-owned migrations, deterministic error taxonomy, idempotency store, and a custom test/verification harness. No business rule, lifecycle, authorization decision, or audit semantic is altered by the substitution.
- **Consequences:**
  - Verification tooling is framework-free: syntax lint (`php -l`), a repository static-analysis/typecheck tool, the package test harness, and migration up/down validation — all runnable with the installed PHP 8.2.27 CLI only.
  - No third-party PHP package is required; dependency discipline (directive clause 20) is satisfied by construction.
  - The substitution is environment-forced, not a preference; if Composer/Packagist ever become reachable in a maintained environment, this amendment must be re-reviewed before any framework reintroduction.

## ADR-013-A rejection record — environment blocker is not a technology decision

- **Status:** REJECTED/WITHDRAWN — the amendment does not take effect and does not override ADR-013.
- **Date:** 2026-08-25 (user correction).
- **Authority:** User correction, 2026-08-25; recorded in Decision Ledger `D-F-103`.
- **Decision:** ADR-013 is authoritative and remains in force: **PHP + Laravel** application technology, **PostgreSQL** persistence, **strict modular monolith** (ADR-001). The framework-free PHP variant is not adopted. No framework substitution is authorized — neither a custom framework nor Node.js, Express, Symfony, another PHP framework, or any other framework.
- **Reason:** The inability to obtain Laravel/Composer/Packagist in the current build environment is an **environment blocker**, not authorization to replace the approved technology. The statement in the withdrawn amendment that a "user decision selected the framework-free variant" is not an approved user decision and must not be treated as such.
- **Consequences:**
  - The environment blocker report `docs/implementation/22-environment-blocker-report.md` remains as evidence that Laravel could not currently be obtained; it records a blocker, not a technology decision.
  - Package 02 (Identity and Organization) **MUST NOT begin production implementation** while the approved Laravel dependency cannot be reproducibly obtained in the build environment. Status: **IMPLEMENTATION BLOCKED BY ENVIRONMENT**.
  - Business rules, architecture, module boundaries, authorization contracts, lifecycle contracts, persistence contracts, and implementation contracts are unchanged; none were rewritten to accommodate the environment limitation.
  - No production code exists in this repository, and none is created by this correction.
  - If the environment becomes able to provide Composer/Packagist reproducibly, implementation may resume under ADR-013 without a further technology decision.

Consequences of ADR-001–012 are captured in artifacts `01`–`22`; those ADRs select no technology. ADR-013 (user decision, 2026-08-25) selects PHP + Laravel + PostgreSQL and is authoritative. ADR-013-A was proposed as an amendment on 2026-08-25 and was rejected/withdrawn on 2026-08-25; it does not take effect.
