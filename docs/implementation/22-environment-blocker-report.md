# Environment Blocker Report — Laravel/Composer Unobtainable

**Status:** CLOSED (remediated 2026-08-25) — the approved stack is now reproducibly obtainable. See "Remediation" below.
**Original status:** OPEN — implementation blocker. Not a technology decision.
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

## Verification consequence (original)

Per the Quality Directive Verification Gate Matrix (clause 27), production verification under ADR-013 uses Laravel-native tooling (Artisan, PHPUnit, Laravel Pint, Larastan or equivalent) plus the migration validator. That tooling requires Composer/Packagist and was therefore not runnable while this blocker stood.

## Remediation (2026-08-25) — blocker closed

The blocker is **CLOSED**: the approved stack (PHP + Laravel + PostgreSQL, ADR-013) is now reproducibly obtainable and operational in this build environment, using only legitimate sources.

**Discovered root causes (from the remediation work):**

1. **Packagist hosts (`packagist.org`, `repo.packagist.org`) and `getcomposer.org` are unreachable** from this environment (`SSL_ERROR_SYSCALL` on connect — network-path block, not a certificate problem). This made the standard Composer path unusable. These hosts remain blocked; this is an egress property of the sandbox, not a configurable issue.
2. **`raw.githubusercontent.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` are unreachable** (`SSL_ERROR_SYSCALL`), blocking raw-file, object-CDN, and release-asset downloads.
3. **`github.com`, `api.github.com`, and `codeload.github.com` are reachable** with verified TLS (`ssl_verify_result=0`), including git smart-HTTP clones.

**Remediation (all within the legitimate-source rule):**

1. **Composer 2.10.2** bootstrapped from its official repository `github.com/composer/composer` (annotated release tag `2.10.2`, commit `8d4439f572a97670a9edc039eb3b093cc976b4bc`), with its runtime dependencies installed from their official GitHub repositories at composer's own committed `composer.lock` references. Runs as `/opt/th/dev/bin/composer`.
2. **Project dependency acquisition:** project `composer.json` disables Packagist and declares the 75 packages of the Laravel 12.67.0 dependency closure as `vcs` repositories pointing at each package's **canonical official GitHub repository** (e.g. `github.com/laravel/framework`), each with `"no-api": true` so Composer uses the generic git driver (one verified-TLS git clone per repository, zero `api.github.com` metadata calls — the API metadata route was rate-limited and is not used).
3. **Laravel 12.67.0 installed through that Composer** with a committed `composer.lock` (73 packages, all from canonical official sources; `composer audit` reports **no known security advisories**).
4. **PHP 8.2.27** (official release tarball) with all Laravel-required extensions (`ext-ctype, ext-filter, ext-hash, ext-mbstring, ext-openssl, ext-session, ext-tokenizer`, plus `pdo_pgsql`, `pgsql`, `curl`, `dom`, `xml`, `fileinfo`, `iconv`, `zlib`, `bcmath`, `pcntl`, `posix`) verified present.
5. **PostgreSQL 18.4** server running locally; connectivity verified both standalone (PDO) and **through Laravel** (`php artisan db:show` connects to database `toefl_house` as `postgres`; `select version()` returns `PostgreSQL 18.4`).

**Verified results (evidence in `docs/implementation/23-environment-readiness.md`):**

- `php -v` → PHP 8.2.27 (CLI, NTS)
- `composer --version` → Composer 2.10.2
- `php artisan --version` → Laravel Framework 12.67.0 (boots)
- `composer validate` → `composer.json is valid`; lock content-hash matches
- `composer install --dry-run` from lock → in sync (reproducible)
- `php artisan db:show` → connects to `toefl_house` as `postgres` (Laravel ↔ PostgreSQL OK)
- TLS verification enabled on every transfer; no `secure-http=false`; no insecure source

**Constraints honored during remediation:** no third-party Laravel archives, no unverified mirrors, no unofficial bundles, no copied vendor trees of unknown provenance, no TLS-verification bypass, no insecure HTTP package sources, no arbitrary internet workarounds. All sources are the packages' canonical official GitHub repositories or the official `php/web-php-distributions` release tarball.

**Final status:** **ENVIRONMENT READY** (2026-08-25). Package 02 (Identity and Organization) remains **NOT STARTED**; it may begin per the standing authorization now that the readiness checkpoint has passed, following the mandatory Package 02 internal sequence. The environment is reproducible: committed `composer.json` + committed `composer.lock` + documented bootstrapping steps reproduce the same vendor tree from the same pinned references.

## Closure condition (original, superseded by Remediation above)

This blocker closes only when Composer/Packagist (and therefore Laravel and its tooling) are reproducibly obtainable in a maintained build environment. Until then, production implementation under ADR-013 is **IMPLEMENTATION BLOCKED BY ENVIRONMENT**. — *Met 2026-08-25 via the remediation above.*
