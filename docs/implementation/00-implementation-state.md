# Implementation State

**Current package:** Package 02 — Identity and Organization
**Status:** CERTIFIED — PASS (checkpoint: `24-package-02-identity-organization-checkpoint.md`)
**Environment status:** ENVIRONMENT READY (2026-08-25 — restored via `P02-environment-recovery.sh --recover`; artifacts published and digest-verified on release `p02-artifacts`)
**Package 03 status (Authorization and Scope):** NOT STARTED (cleared to begin through the package protocol when authorized)
**Updated:** 2026-08-25

The repository baseline was inspected and verified as documentation-only. No production source, database, schema, migrations, package tooling, or tests are present in this checkout. The implementation contract, deferred-input boundaries, package order, traceability convention, and verification expectations are established without changing business behavior.

## Standing implementation standard

The Implementation Quality Directive — Absolute Engineering Standard was adopted by user directive on 2026-08-25 and codified at `docs/implementation/21-implementation-quality-directive.md` (Decision Ledger `D-F-101`). It is the mandatory quality and verification standard for every implementation artifact in every future package. It establishes no business policy and authorizes no package.

## Technology selection

The previously open technology decision (Decision Ledger `D-F-003`; legacy findings L-002/L-003) was resolved by user decision on 2026-08-25: **PHP + Laravel** application technology and **PostgreSQL** persistence, remaining a modular monolith with strict contexts. Recorded as ADR-013 in `docs/architecture/23-architecture-decision-records.md` and Decision Ledger `D-F-100`. ADR-013 is authoritative. The proposed ADR-013-A amendment (framework-free variant) was rejected/withdrawn on 2026-08-25 (Decision Ledger `D-F-103`); it does not take effect and no framework substitution is authorized.

## Environment status (2026-08-25)

The environment blocker is **CLOSED**: the approved stack is now reproducibly obtainable and operational.

- **Laravel 12.67.0** installed through Composer 2.10.2 from canonical official GitHub sources (Packagist unreachable in this sandbox; remediation uses official GitHub `vcs` repositories with `no-api` git clones — the canonical sources Packagist itself mirrors). `composer.lock` committed; `composer install` reproducible; `composer audit` clean.
- **Verified:** PHP 8.2.27 + Laravel Framework 12.67.0 boots; PostgreSQL 18.4 reachable standalone (PDO) and through Laravel (`php artisan db:show` → database `toefl_house`, user `postgres`).
- Evidence: `docs/implementation/23-environment-readiness.md` (**final status ENVIRONMENT READY**, all checks passed); blocker closure in `docs/implementation/22-environment-blocker-report.md`.

The technology decision is unchanged and authoritative: **PHP + Laravel + PostgreSQL, strict modular monolith (ADR-013 / D-F-100)**; no framework substitution is authorized.

## Package boundary

Package 02 — Identity and Organization is **CERTIFIED** (2026-08-25, checkpoint `24-package-02-identity-organization-checkpoint.md`): Organization module (structure units, registry lifecycle, effective-dated campus attribution, two-Owner authority chain), Identity module (person verification, account link/deactivate with history), append-only Audit module with structural immutability, and the shared kernel (error taxonomy, default-deny authorization port, idempotency store). Gates: phpunit **OK (78 tests, 371 assertions)**, phpstan level 6 clean, pint clean, schema/migration, authorization, lifecycle, invariant, idempotency and adversarial suites pass; financial gates recorded NOT APPLICABLE. The implementation was created from the governance records after recorded evidence established no prior implementation existed anywhere reachable.

Package 03 — Authorization and Scope is **NOT STARTED**; it begins only through the package protocol. Business rules, architecture, module boundaries, and implementation contracts are unchanged.
