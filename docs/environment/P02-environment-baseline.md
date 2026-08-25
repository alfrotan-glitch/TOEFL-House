# P02 Environment Baseline — Canonical, Repository-Backed Specification

**Status:** ACTIVE — source of truth for reconstructing the Package 02 build/test environment.
**Version:** 1.0
**Date:** 2026-08-25
**Basis:** authoritative records `docs/implementation/22-environment-blocker-report.md` (remediation table + verified results), `docs/implementation/23-environment-readiness.md` (DISCOVER table, acquisition method, verification table), `docs/implementation/28-package-02-identity-organization-implementation.md` §3 (tooling versions), plus repository-pinned facts (`composer.json`, `composer.lock` content-hash, `phpunit.xml`, `phpstan.neon`, `.env.example`).
**Recovery procedure:** `docs/environment/P02-environment-recovery.sh` (same directory).

> **CRITICAL RULE:** If the environment disappears or becomes corrupted, FIRST read this baseline, then execute
> `docs/environment/P02-environment-recovery.sh --recover`. Do NOT perform a fresh environment investigation
> unless this baseline is proven incomplete or invalid. The repository/GitHub is the persistent source of truth;
> the temporary agent sandbox is NOT.

---

## 1. OS / environment assumptions

| Item | Value | Evidence |
|---|---|---|
| OS | Debian GNU/Linux 12 (bookworm), x86_64 | verified sandbox OS |
| Shell | bash (≥ 4) | recovery script requires it |
| User | non-root user with passwordless `sudo` (used only where unavoidable; recovery prefers user-writable dirs) | verified |
| Network egress | **github.com / api.github.com / codeload.github.com reachable (TLS verified)**; `registry.npmjs.org` + `files.pythonhosted.org` reachable; **`packagist.org`, `repo.packagist.org`, `getcomposer.org`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `deb.debian.org`, `ftp.postgresql.org`, `www.php.net` BLOCKED** (connect-level `SSL_ERROR_SYSCALL` / TCP reset) | records 22/23 DISCOVER table; re-verified 2026-08-25 |
| Implication | All acquisition must use canonical GitHub (git clones / codeload tarballs / release assets via `github.com/.../releases/download/...` redirects) and npm/PyPI only. apt and Packagist are unusable. | records 22/23 |

## 2. PHP — exact version

- **PHP 8.2.27** (CLI, NTS), installed at `${TH_ROOT}/php/bin/php` (default `TH_ROOT=/opt/th`, symlinked to the workspace toolchain dir).
- Source: official release tarball `php-8.2.27.tar.gz` from the canonical `php/web-php-distributions` GitHub repository (acquired via the GitHub API raw-content endpoint because `raw.githubusercontent.com` is blocked).
- Tarball SHA-256 (verified 2026-08-25 from the fetched artifact): `179cc901760d478ffd545d10702ebc2a1270d8c13471bdda729d20055140809a`.
- Expected `php -v` first line: `PHP 8.2.27 (cli) (built: Aug 24 2026) (NTS)`.

## 3. Required PHP extensions (exact set, verified)

`php -m` must contain **all** of:

```
Core, PDO, Phar, Reflection, SPL, SimpleXML, bcmath, ctype, curl, date, dom, fileinfo,
filter, hash, iconv, json, libxml, mbstring, openssl, pcntl, pcre, pdo_pgsql, pgsql,
posix, random, session, standard, tokenizer, xml, xmlreader, xmlwriter, zlib
```

Laravel-12 hard requirements among these: `ctype, filter, hash, mbstring, openssl, session, tokenizer`.
PostgreSQL access requires `pdo_pgsql` (+ `pgsql`). Concurrency test harness requires `pcntl, posix`.
Source-build dependency libraries (pinned, per record 22): zlib 1.3.1, OpenSSL 3.0.13, curl 8.5.0-DEV, oniguruma 6.9.9, libxml2 2.16.0, pkgconf 2.1.0 — installed under `${TH_ROOT}` and made visible via `LD_LIBRARY_PATH`.

## 4. Composer — exact version

- **Composer 2.10.2**, at `${TH_ROOT}/dev/bin/composer`.
- Bootstrapped from the canonical `github.com/composer/composer` at annotated tag `2.10.2` (commit `8d4439f572a97670a9edc039eb3b093cc976b4bc`); runtime dependencies installed from their official GitHub repositories at composer's own committed `composer.lock` references.
- Expected `composer --version`: `Composer version 2.10.2 2026-07-01`.
- `COMPOSER_HOME` is set to `${TH_ROOT}/composer-home`.

## 5. Laravel / framework — exact version

- **laravel/framework 12.67.0** (selected because v13 requires PHP ^8.3; v12.67.0 is the highest 12.x compatible with PHP 8.2.27).
- Declared in `composer.json` as `"laravel/framework": "^12.67.0"` with Packagist disabled and **126 `vcs` repositories** (125 package repos + packagist-disabled entry) each pointing at the package's canonical official GitHub repository with `"no-api": true`.
- Installed via `composer install` from the committed `composer.lock` (73 packages; content-hash `d6eab7208db9f0891547ef361ee7478b`). **NEVER use `composer update` for restoration** — `composer install` with the committed lock only.
- Expected `php artisan --version`: `Laravel Framework 12.67.0`.

## 6. PostgreSQL — exact version

- **PostgreSQL 18.4** server, running locally at `127.0.0.1:5432`, user `postgres` / password `postgres`.
- Binaries from npm `@embedded-postgres/linux-x64` (`initdb`, `pg_ctl`, `postgres` in the package's `native/` dir).
- Client lib `libpq.so.5.18` (REL_16_4 era) + headers from the same npm package, installed at `${TH_ROOT}/pgsql`.
- Expected `select version()`: `PostgreSQL 18.4 on x86_64-pc-linux-gnu`.

## 7. Node / npm — exact versions

- **Node v22.22.3**, **npm 10.9.8** (verified present in the working sandbox).
- Required only to acquire the `@embedded-postgres/linux-x64` npm package (PostgreSQL binaries + libpq). No Node runtime is used by the application or tests.

## 8. Required system packages

Base image provides: `gcc`, `g++`, `make`, `perl`, `git`, `curl`, `wget`, `python3` (3.11), `pip3` (23.0.1). No apt packages are used (apt is unreachable). The pinned dependency libraries (zlib, OpenSSL, curl, oniguruma, libxml2, pkgconf) are built from source into `${TH_ROOT}` from canonical codeload tag tarballs. Build-system tools are obtained deterministically from PyPI wheels (reachable): `python3 -m pip install --user cmake ninja meson`. Build routes per component (all CMake/Meson — no autotools chain is required):

| Component | Recorded version (record 22) | Deterministic recovery pin | Build system |
|---|---|---|---|
| zlib | 1.3.1 | codeload `madler/zlib` tag `v1.3.1` | CMake |
| OpenSSL | 3.0.13 | codeload `openssl/openssl` tag `openssl-3.0.13` | `./Configure` (perl) |
| curl | 8.5.0-DEV (snapshot, no pinned ref) | codeload `curl/curl` tag `curl-8_5_0` (release line; **documented divergence** — recorded DEV snapshot had no recorded ref; PHP requires curl ≥ 7.61) | CMake |
| oniguruma | 6.9.9 | codeload `kkos/oniguruma` tag `v6.9.9` | CMake |
| libxml2 | 2.16.0 | codeload `GNOME/libxml2` tag `v2.15.3` (GitHub mirror max; **documented divergence** — 2.16.0 tarball exists only on the blocked GNOME gitlab) | Meson |
| pkgconf | 2.1.0 | codeload `pkgconf/pkgconf` tag `pkgconf-2.1.0` | Meson |

All tarballs downloaded from `codeload.github.com/<owner>/<repo>/tar.gz/<tag>` (verified reachable, TLS verified). Every build is followed by its own verification step; a component that cannot be reconstructed deterministically stops the recovery with an explicit missing-component report (per the CRITICAL RULE — no fresh investigation).

## 9. Composer dependencies — authoritative lockfile

- `composer.json` (committed): `require { php ^8.2, laravel/framework ^12.67.0 }`; `require-dev { laravel/pint ^1.30.4, phpunit/phpunit ^11.5.50, phpstan/phpstan ^2.2.0, larastan/larastan ^3.10.0, mockery/mockery ^1.6.12 }`.
- `composer.lock` (committed): 73 packages, content-hash `d6eab7208db9f0891547ef361ee7478b`. **The lockfile is authoritative; never regenerate it.**
- Resolved tool versions (record 28 §3): PHPUnit 11.5.56, Pint 1.30.4, PHPStan 2.2.9, Larastan 3.10.x.

## 10. Node dependencies

- Only `@embedded-postgres/linux-x64` (pinned by the recovery script to the version that ships PostgreSQL 18.4 binaries; install via `npm pack`/`npm install` from the registry). No committed Node lockfile is required.

## 11. Required environment variables and safe `.env.example`

Runtime/test variables (used by the recovery script and verification commands):

```sh
export TH_ROOT="${TH_ROOT:-/opt/th}"                                   # toolchain root (symlink to workspace toolchain dir)
export PATH="${TH_ROOT}/php/bin:${TH_ROOT}/bin:${TH_ROOT}/dev/bin:${TH_ROOT}/pgdev/bin:$PATH"
export LD_LIBRARY_PATH="${TH_ROOT}/lib:${PG_NPM_DIR}/native/lib:${LD_LIBRARY_PATH:-}"
export COMPOSER_HOME="${TH_ROOT}/composer-home"
export PGUSER=postgres PGPASSWORD=postgres PGHOST=127.0.0.1 PGPORT=5432
export APP_ENV=testing                                                  # for test runs
```

Safe committed `.env.example` (gitignored `.env` is derived from it; no secrets):

```dotenv
APP_NAME="TOEFL House"
APP_ENV=local
APP_KEY=                 # generated locally: php artisan key:generate
APP_DEBUG=true
APP_URL=http://localhost
APP_LOCALE=en
APP_FALLBACK_LOCALE=en
APP_FAKER_LOCALE=en_US
LOG_CHANNEL=stderr
LOG_LEVEL=debug
DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=toefl_house
DB_USERNAME=postgres
DB_PASSWORD=
DB_SSLMODE=prefer
```

## 12. Database creation / configuration

- Two databases on the local PostgreSQL 18.4 instance: **`toefl_house`** (dev) and **`toefl_house_test`** (tests), both owned/usable by `postgres` (trust/`postgres` password auth on 127.0.0.1).
- `phpunit.xml` pins the test connection: `APP_ENV=testing`, `DB_CONNECTION=pgsql`, `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_DATABASE=toefl_house_test`, `DB_USERNAME=postgres`, `DB_PASSWORD=postgres`.
- Creation: `createdb -h 127.0.0.1 -U postgres toefl_house` and `... toefl_house_test` (recovery script performs this).
- Migrations: 20 migrations (`database/migrations/2026_08_25_000001…000020`); applied by the test suite (DatabaseMigrations) and by `php artisan migrate` for dev. Expected: 20/20 Ran, 22 tables, 5 immutability triggers (record 28 §4/§18).

## 13. Migration / bootstrap commands

```sh
php artisan migrate --force            # dev database (toefl_house)
php artisan db:show                    # verify Laravel ↔ PostgreSQL connectivity
# tests apply migrations automatically via DatabaseMigrations (no wrapping transaction);
# concurrency tests require the DB server, not artisan.
```

## 14. Required test commands

```sh
php vendor/bin/phpunit                                        # full suite: Unit + Feature
php vendor/bin/phpunit tests/Unit/Organization/...            # focused suites as needed
```

Expected result (recorded at R3 closure): **OK (52 tests, 229 assertions)**.

## 15. PHPStan configuration / command

- Config: `phpstan.neon` — includes `vendor/larastan/larastan/extension.neon`; `level: 6`; paths `app/Modules`, `app/Support`; `tmpDir: /tmp/phpstan-p02`; `treatPhpDocTypesAsCertain: false`.
- Command: `php vendor/bin/phpstan analyse --memory-limit=1G`
- Expected result: `[OK] No errors` (124 files at R3 closure).

## 16. Pint / lint command

- `php vendor/bin/pint --test` — expected result: `PASS` (154 files at baseline; per-file runs on changed files).
- Plain syntax gate: `php -l <file>` on every modified PHP file.

## 17. Project-specific paths / environment variables

| Path/var | Meaning |
|---|---|
| `${TH_ROOT}` (default `/opt/th`) | toolchain root; `/opt/th` is a symlink into the persistent workspace (`/home/user/toolchain`) |
| `${TH_ROOT}/php` | PHP 8.2.27 prefix |
| `${TH_ROOT}/dev/bin/composer` | Composer 2.10.2 |
| `${TH_ROOT}/composer-home` | COMPOSER_HOME cache |
| `${TH_ROOT}/pgsql`, `${TH_ROOT}/lib` | libpq + built dependency libs |
| `${PG_NPM_DIR}` (`…/node_modules/@embedded-postgres/linux-x64`) | PostgreSQL 18.4 binaries + bundled libpq |
| `APP_ENV=testing` | required for phpunit runs |
| `/tmp/pg-npm` | historical npm staging dir for embedded-postgres (recovery script re-creates as needed) |

## 18. Known compatibility constraints

- **Laravel 13 requires PHP ^8.3 — not usable** with the pinned PHP 8.2.27; do not raise the framework constraint.
- **Packagist/getcomposer.org/raw.githubusercontent.com/deb.debian.org unreachable** — never attempt apt or Packagist installs; always use the canonical GitHub/npm/PyPI route with TLS verification enabled (`ssl_verify_result=0` on GitHub; no `secure-http=false`, no TLS bypass).
- `composer install` only from the committed lock; **`composer update` is forbidden** (would regenerate the lock).
- PHPUnit 11.5.x requires PHP ≥ 8.2 (satisfied); Pint 1.30.5 requires PHP ^8.3 → **Pint must stay at 1.30.4**.
- Concurrency tests fork real OS processes (`pcntl_fork`) and require `pcntl`/`posix` and a live PostgreSQL server; `DatabaseMigrations` (not `RefreshDatabase`) because the fork harness needs committed fixture rows on per-child connections.
- The PHP CLI is built NTS (non-thread-safe); the embedded PostgreSQL is a single local instance — dev/test only, not a production deployment.

## 19. Exact verification commands and expected results (canonical battery)

| # | Command | Expected result |
|---|---|---|
| 1 | `php -v` | `PHP 8.2.27 (cli) (built: Aug 24 2026) (NTS)` |
| 2 | `composer --version` | `Composer version 2.10.2 2026-07-01` |
| 3 | `php artisan --version` | `Laravel Framework 12.67.0` |
| 4 | `php -m` | full extension set of §3, including `pdo_pgsql`, `pcntl`, `posix`, `mbstring`, `openssl` |
| 5 | `composer validate --no-check-publish` | `composer.json is valid` (lock content-hash matches) |
| 6 | `composer install --dry-run` | `in sync` (nothing to install/update/remove) |
| 7 | `composer audit` | no known security advisories |
| 8 | `php artisan db:show` | connects to `toefl_house` as `postgres`; server version `PostgreSQL 18.4` |
| 9 | `php vendor/bin/phpunit` | `OK (52 tests, 229 assertions)` (R3 closure baseline; grows as tests are added) |
| 10 | `php vendor/bin/phpstan analyse --memory-limit=1G` | `[OK] No errors` |
| 11 | `php vendor/bin/pint --test` | `PASS` |

The recovery script implements exactly this battery in `--verify` mode.
