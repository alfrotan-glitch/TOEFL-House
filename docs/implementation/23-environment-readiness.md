# Environment Readiness — Laravel Acquisition Plan and Record

**Status:** ENVIRONMENT READY — checkpoint passed (verification below)
**Date:** 2026-08-25
**Task:** Environment-readiness only. Package 02 (Identity and Organization) remains NOT STARTED.

## Approved technology (ADR-013, authoritative)

- Architecture: Strict Modular Monolith
- Application: **PHP + Laravel**
- Database: **PostgreSQL**
- No framework substitution is authorized.

## DISCOVER results (reproduced independently on 2026-08-25)

| Item | Finding |
|---|---|
| PHP | 8.2.27 (CLI, NTS) at `/opt/th/php/bin/php` (built from official `php/web-php-distributions` release tarball) |
| PHP extensions present | Core, PDO, Phar, Reflection, SPL, SimpleXML, bcmath, ctype, curl, date, dom, fileinfo, filter, hash, iconv, json, libxml, mbstring, openssl, pcntl, pcre, pdo_pgsql, pgsql, posix, random, session, standard, tokenizer, xml, xmlreader, xmlwriter, zlib |
| Composer | not installed anywhere; no composer.phar, no COMPOSER_HOME cache, no vendor directory on the host (scanned) |
| Packagist | unreachable: `curl` fails with `SSL_ERROR_SYSCALL` on `packagist.org:443`, `repo.packagist.org:443` (TCP/TLS reset by egress filter; not a certificate problem) |
| getcomposer.org | unreachable (`SSL_ERROR_SYSCALL`) |
| raw.githubusercontent.com / objects.githubusercontent.com / release-assets.githubusercontent.com | unreachable (`SSL_ERROR_SYSCALL`) |
| GitHub (github.com, api.github.com, codeload.github.com) | **reachable**, TLS verified (`ssl_verify_result=0`), HTTP 200 |
| git smart HTTP to github.com | **works** (`git ls-remote https://github.com/symfony/console.git` returns tags) |
| DNS | resolves for all probed hosts (packagist.org, repo.packagist.org, getcomposer.org, github.com, api.github.com, codeload.github.com) |
| Proxy/environment variables | none configured |
| IPv6 egress | not available |
| CA certificates | system trust store used by curl/OpenSSL; TLS verification succeeds on reachable hosts |
| PostgreSQL | 18.4 server running (binaries from npm `@embedded-postgres/linux-x64`, `initdb`/`pg_ctl`/`postgres`); PHP `pdo_pgsql` verified connecting |

## Laravel version selection (recorded before installation)

**Selected: Laravel `12.67.0` (laravel/framework v12.67.0).**

Compatibility basis:
- `laravel/framework` `v13.26.1` (current major) requires `"php": "^8.3"` — **incompatible** with the available PHP 8.2.27.
- `laravel/framework` `v12.67.0` (latest v12.x) requires `"php": "^8.2"` and extensions `ext-ctype, ext-filter, ext-hash, ext-mbstring, ext-openssl, ext-session, ext-tokenizer` — all present in PHP 8.2.27. PostgreSQL is used through `pdo_pgsql` (present and verified).
- Laravel 12 is therefore the highest Laravel major compatible with the available PHP 8.2 runtime; it is a supported release line (12.x receives maintenance per the project's support policy).
- Additional runtime needs verified present: `ext-json` (core in 8.2), `ext-dom`, `ext-xml`, `ext-fileinfo`, `ext-curl`, `ext-zlib`.

## Dependency acquisition method (legitimate and reproducible)

Packagist and getcomposer.org are unreachable; GitHub (github.com, api.github.com, codeload.github.com) is reachable with verified TLS. The acquisition method therefore uses **the canonical official sources**:

1. **Composer 2.10.2** is bootstrapped from its official source repository `github.com/composer/composer` (tag `2.10.2`) with its runtime dependencies installed from their **official GitHub repositories** at the exact references pinned in composer's own committed `composer.lock`.
2. **Laravel 12.67.0** is installed through that Composer using **official package repositories** (`vcs` type pointing at each package's canonical GitHub repository, e.g. `github.com/laravel/framework`), with the Packagist repository disabled in the project configuration.
3. A `composer.lock` is produced and committed so every future `composer install` is reproducible from pinned references.

Constraints honored:
- No third-party Laravel archives, no unverified mirrors, no unofficial bundles, no copied vendor trees of unknown provenance.
- TLS certificate verification is never disabled; all transport is HTTPS.
- All package sources are the packages' official GitHub repositories (the same canonical sources Packagist itself mirrors).
- The resulting environment is reproducible: pinned references (composer.lock) + committed project dependency configuration + documented commands.

## Security verification plan

- TLS verification active on every transfer (`ssl_verify_result=0` on GitHub hosts; failure mode observed on blocked hosts is connect-level, not certificate).
- Composer source acquired from the official `composer/composer` repository at a signed/annotated release tag `2.10.2`; dependencies pinned by the official `composer.lock`.
- Dependency integrity enforced by Composer's lock content-hash and pinned commit references at install time.
- No insecure HTTP package source is used; no `secure-http=false` override.

## Files to be created (minimum framework bootstrap only)

- `composer.json` — project dependency configuration (require `php ^8.2`, `laravel/framework ^12.67`; vcs repositories; packagist disabled)
- `composer.lock` — pinned dependency graph (reproducibility)
- `artisan` — Laravel CLI entry point
- `bootstrap/app.php`, `bootstrap/providers.php` — minimal framework bootstrap
- `config/app.php`, `config/database.php`, `config/logging.php` — minimum config for boot + PostgreSQL connection
- `.env.example` (committed) and `.env` (local, gitignored)
- `.gitignore` — excludes `vendor/`, `.env`, and runtime artifacts
- `docs/implementation/23-environment-readiness.md` — this record (updated at completion with verification results)

No domain entities, migrations, controllers, routes, commands, queries, authorization logic, UI, or business services are created.

## Verification plan (at completion)

- `php -v` (8.2.27), `composer --version` (2.10.2), `php artisan --version` (Laravel Framework 12.67.0)
- required extensions listed by `php -m`
- `php artisan db:show` establishes the approved PostgreSQL connection
- `composer validate` (lock integrity), `composer install` reproducibility from lock
- security verification per above; remaining blockers recorded

## Verification results (2026-08-25) — checkpoint PASSED

All checks executed in this environment (PHP 8.2.27 at `/opt/th/php/bin/php`; `COMPOSER_HOME=/opt/th/composer-home`; `LD_LIBRARY_PATH` includes `/opt/th` runtimes):

| # | Check | Command | Result |
|---|---|---|---|
| 1 | PHP version | `php -v` | **PHP 8.2.27 (cli) (built: Aug 24 2026) (NTS)** |
| 2 | Composer version | `composer --version` | **Composer version 2.10.2 2026-07-01** (bootstrapped from official `github.com/composer/composer` tag `2.10.2`) |
| 3 | Laravel boot | `php artisan --version` | **Laravel Framework 12.67.0** (minimal `bootstrap/app.php`; no domain code) |
| 4 | Required extensions | `php -m` | **ctype, filter, hash, mbstring, openssl, session, tokenizer** (Laravel 12 requirement) + pdo, pdo_pgsql, pgsql, curl, dom, fileinfo, xml, pcntl, posix, bcmath, iconv, zlib — **all present** |
| 5 | Dependency resolution | `composer update` | **73 packages resolved and installed from canonical official GitHub vcs repositories** (all with `"no-api": true`; Packagist disabled) |
| 6 | Lock integrity | `composer validate --no-check-publish` | **`composer.json is valid`** (lock content-hash consistent) |
| 7 | Reproducibility | `composer install --dry-run` | **in sync** — no install/update/remove required (lock-pinned vendor tree) |
| 8 | Dependency security | `composer audit` (during install) | **No security vulnerability advisories found** |
| 9 | PG connectivity standalone | PHP PDO `pgsql:host=127.0.0.1;port=5432` | **PostgreSQL 18.4** on `toefl_house` (database created, `select version()` OK) |
| 10 | **Laravel ↔ PostgreSQL** | `php artisan db:show` + `select version()` via Laravel | **`Database toefl_house`, `Username postgres`; `PostgreSQL 18.4 on x86_64-pc-linux-gnu`; DDL through Laravel OK** |
| 11 | TLS/security | all transfers | TLS verification active on every transfer (`ssl_verify_result=0` on reachable hosts); no `secure-http=false`, no insecure source, no TLS bypass |

**Dependency acquisition method (legitimate and reproducible):** Composer 2.10.2 bootstrapped from the official `composer/composer` repository at annotated tag `2.10.2` with its own committed lock-pinned dependencies; the project `composer.json` disables Packagist and declares each package of the Laravel 12.67.0 closure as a `vcs` repository at its canonical official GitHub repository with `"no-api": true` (generic git driver — one verified-TLS clone per repository, no `api.github.com` metadata calls); `composer.lock` is committed so every future install reproduces the exact pinned tree. No third-party archives, no unverified mirrors, no unofficial bundles, no copied vendor trees, no TLS-verification bypass.

**Network/config issue discovered and remediation:** Packagist hosts (`packagist.org`, `repo.packagist.org`), `getcomposer.org`, and `raw.githubusercontent.com` are unreachable from this sandbox (`SSL_ERROR_SYSCALL` — network-path block). `github.com`/`api.github.com`/`codeload.github.com` are reachable with verified TLS. Remediation: use official GitHub VCS sources via git clones (`no-api`), which are the canonical sources Packagist itself mirrors. See `docs/implementation/22-environment-blocker-report.md` (closed by this remediation).

**Boot success:** `php artisan --version` and a full framework boot (`Illuminate\Foundation\Application::configure` minimal bootstrap) succeed; `php artisan about` reports environment `local`, application **TOEFL House**.

**Package 02 untouched:** no domain entities, migrations, controllers, routes, commands, queries, authorization logic, UI, or business services were created. The only application files are the minimum framework bootstrap (`artisan`, `bootstrap/app.php`, `bootstrap/providers.php`, `config/app.php`, `config/database.php`, `config/logging.php`, `.env.example`, `.gitignore`) and the dependency manifest (`composer.json`, `composer.lock`).

## Possible final states

- **ENVIRONMENT READY** — only when Laravel is reproducibly obtainable and operational under PHP + Laravel + PostgreSQL, with PostgreSQL connectivity verified through Laravel.
- **ENVIRONMENT BLOCKED** — if no legitimate reproducible acquisition path exists.

## Final status (2026-08-25)

**ENVIRONMENT READY** — all verification checks above passed; the approved stack (PHP 8.2.27 + Laravel 12.67.0 + PostgreSQL 18.4) is reproducibly obtainable and operational. The environment blocker (`docs/implementation/22-environment-blocker-report.md`) is **CLOSED** by this remediation.

Package 02 (Identity and Organization) remains **NOT STARTED**; per the standing authorization it may begin following the mandatory Package 02 internal sequence now that this readiness checkpoint has passed. The technology decision is unchanged and authoritative: **PHP + Laravel + PostgreSQL, strict modular monolith (ADR-013 / D-F-100)**; no framework substitution is authorized.
