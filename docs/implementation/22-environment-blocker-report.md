# Environment Blocker Report — Laravel/Composer Unobtainable

**Status:** CLOSED — resolved by user decision (Decision Ledger `D-F-102`; ADR-013-A)
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

## Resolution (user decision, 2026-08-25)

- **PHP + PostgreSQL remain** the application technology and persistence.
- **Laravel is substituted by a framework-free modular monolith** implementing the approved architecture intent directly, with a minimal in-repository kernel (autoloader, typed PDO persistence, module-owned migrations, deterministic error taxonomy, idempotency store, test/verification harness).
- Recorded as ADR-013-A (`docs/architecture/23-architecture-decision-records.md`) and Decision Ledger `D-F-102`. The technology decision is not reopened.

## Environment workarounds executed to satisfy the stack

Because the environment blocks package distribution, the following were built from official sources and installed under `/opt/th` (outside the repository):

| Component | Version | Source | Installed at |
|---|---|---|---|
| PHP CLI | 8.2.27 | official `php/web-php-distributions` release tarball | `/opt/th/php` |
| libpq (pdo_pgsql/pgsql client) | REL_16_4 era shared lib | npm `@embedded-postgres/linux-x64` bundled `libpq.so.5.18` + REL_16_4 headers | `/opt/th/pgsql` |
| PostgreSQL server (runtime for tests) | 18.4.0-beta-era binaries | npm `@embedded-postgres/linux-x64` (`initdb`, `pg_ctl`, `postgres`) | `/tmp/npm-inspect/package/native` |
| zlib, OpenSSL, curl, oniguruma, libxml2, pkgconf | 1.3.1 / 3.0.13 / 8.5.0-DEV / 6.9.9 / 2.16.0 / 2.1.0 | official release tarballs built from source | `/opt/th` |

PHP 8.2.27 runs with the required extension set verified: `pdo_pgsql`, `pgsql`, `mbstring`, `curl`, `openssl`, `bcmath`, `pcntl`, `posix`, `xml`, `dom`, `simplexml`, `iconv`, `zlib`.

## Verification consequence

The Verification Gate Matrix (Quality Directive clause 27) is satisfied with framework-free tooling owned by this repository:

| Gate | Tool |
|---|---|
| typecheck | repository static-analysis tool (token-level type resolution + reflection contract checks) |
| lint | `php -l` over the entire source tree |
| static analysis | repository static-analysis tool (undefined symbols, unresolved imports, duplicate declarations, forbidden debug patterns, quality-directive marker scan) |
| unit/integration/invariant/authorization/lifecycle/historical/concurrency/idempotency tests | repository test harness (`tests/`) |
| migration/schema validation | repository migration runner up/down validation |
| contract verification | contract verification suite in `tests/` |

## Closure

The blocker is closed by ADR-013-A / D-F-102. Reopening the technology decision requires a documented Critical architectural contradiction; framework reintroduction also requires Composer/Packagist reachability in a maintained environment.
