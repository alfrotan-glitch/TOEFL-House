# Environment Blocker Report — Laravel/Composer Unobtainable

**Status:** OPEN — implementation blocker. Not a technology decision.
**Date:** 2026-08-25
**Environment:** sandboxed build environment for this repository session

## Blocked capability

ADR-013 (D-F-100) selected **PHP with the Laravel framework** and PostgreSQL. Laravel is distributed exclusively through Composer (Packagist). Composer itself is distributed from `getcomposer.org`; its metadata/metadata sources and package tarballs resolve through `repo.packagist.org`, `packagist.org`, and `raw.githubusercontent.com`. All of these endpoints are required to obtain Laravel or any Composer-based tooling (PHPUnit, phpstan, psr/log, symfony components, and so on).

## Verification evidence (2026-08-25)

| Probe | Result |
|---|---|
| `curl -sSI https://repo.packagist.org/packages.json` | `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to repo.packagist.org:443` |
| `curl -sSI https://getcomposer.org/download/latest-stable/composer.phar` | `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to getcomposer.org:443` |
| `curl -sSI https://raw.githubusercontent.com/composer/composer/2.7.7/composer.json` | `curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to raw.githubusercontent.com:443` |
| `which composer` / `composer.phar` on host | not present anywhere on the system |

`SSL_ERROR_SYSCALL` on connect indicates the network path is blocked, not a certificate or TLS-configuration issue. Retries and alternate mirror probing are not available in this environment. The PHP runtime itself was verified operational (PHP 8.2.27 built from the official release tarball; see below).

## Impact

1. **Laravel framework: unobtainable.** No package manager, no framework, no framework ecosystem.
2. **Composer-based quality tooling: unobtainable.** PHPUnit, PHPStan, and similar verification tools named in the Verification Gate Matrix cannot be installed as dependencies.
3. **The approved architecture is not Laravel-dependent in content.** ADR-001–012, the module implementation contracts (`04`), authorization contract (`06`), lifecycle contract (`07`), error contract (`13`), concurrency/idempotency contract (`12`), testing contract (`14`), migration contract (`15`), and the Implementation Quality Directive define behavior, ownership, and invariants — not framework APIs.

## Correction record (2026-08-25) — this report records a blocker, not a decision

An earlier version of this report (and ADR-013-A / Decision Ledger `D-F-102`) described the framework-free variant as resolved by a user decision. **That claim is corrected:** no user decision selected the framework-free variant. The approved technology decision remains **PHP + Laravel + PostgreSQL as a strict modular monolith (ADR-013, D-F-100)**, which is authoritative.

- ADR-013-A is **REJECTED/WITHDRAWN** and does not take effect (ADR records, `docs/architecture/23-architecture-decision-records.md`).
- Decision Ledger `D-F-103` records the correction; `D-F-102` stands only for its environment-blocker evidence.
- This report is preserved as evidence that Laravel could not currently be obtained. It is an **environment blocker**, not authorization to replace Laravel and not a technology decision.
- **Current status: IMPLEMENTATION BLOCKED BY ENVIRONMENT.** Package 02 (Identity and Organization) must not begin production implementation while the approved Laravel dependency cannot be reproducibly obtained in the build environment. No framework substitution (custom framework, Node.js, Express, Symfony, another PHP framework, or any other framework) is authorized.

## Environment workarounds executed

Because the environment blocks package distribution, the following were built from official sources and installed under `/opt/th` (outside the repository). These are environment workarounds only; they do not alter the approved technology decision and do not constitute production implementation:

| Component | Version | Source | Installed at |
|---|---|---|---|
| PHP CLI | 8.2.27 | official `php/web-php-distributions` release tarball | `/opt/th/php` |
| libpq (pdo_pgsql/pgsql client) | REL_16_4 era shared lib | npm `@embedded-postgres/linux-x64` bundled `libpq.so.5.18` + REL_16_4 headers | `/opt/th/pgsql` |
| PostgreSQL server (runtime for tests) | 18.4.0-beta-era binaries | npm `@embedded-postgres/linux-x64` (`initdb`, `pg_ctl`, `postgres`) | `/tmp/npm-inspect/package/native` |
| zlib, OpenSSL, curl, oniguruma, libxml2, pkgconf | 1.3.1 / 3.0.13 / 8.5.0-DEV / 6.9.9 / 2.16.0 / 2.1.0 | official release tarballs built from source | `/opt/th` |

PHP 8.2.27 runs with the required extension set verified: `pdo_pgsql`, `pgsql`, `mbstring`, `curl`, `openssl`, `bcmath`, `pcntl`, `posix`, `xml`, `dom`, `simplexml`, `iconv`, `zlib`.

## Verification consequence

Per the Quality Directive Verification Gate Matrix (clause 27), production verification under ADR-013 uses Laravel-native tooling (Artisan, PHPUnit, Laravel Pint, Larastan or equivalent) plus the migration validator. That tooling requires Composer/Packagist and is therefore not runnable while this blocker stands.

## Closure condition

This blocker closes only when Composer/Packagist (and therefore Laravel and its tooling) are reproducibly obtainable in a maintained build environment. Until then, production implementation under ADR-013 is **IMPLEMENTATION BLOCKED BY ENVIRONMENT**.
