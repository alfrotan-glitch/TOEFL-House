# P02 Environment Baseline — Canonical, Repository-Backed Specification

**Status:** ACTIVE — source of truth for reconstructing the Package 02 build/test environment.
**Version:** 1.2
**Date:** 2026-08-25
**Revision 1.2 (2026-08-25):** artifact-first recovery — checksummed prebuilt bundles (toolchain + vendor) with a versioned manifest restore the environment in seconds; the §8 source-build chain is now the FALLBACK for components an artifact restore cannot provide. Producer/consumer flows, exclusions and integrity rules in §8a. Revision 1.1 aligned the spec with the environment as actually built and verified: exact PHP configure flags (incl. the pgsql pair, sqlite disabled), libpq header acquisition route, PyPI build tools with PEP 668 fallback, `CMAKE_POLICY_VERSION_MINIMUM`, pkgconf static build at a neutral prefix, pkg-config metadata consolidation, PHP-based PostgreSQL client-tool shims, composer autoloader generator requirements, and the recovery-script exit-code fix. Earlier basis unchanged:
**Basis:** authoritative records `docs/implementation/22-environment-blocker-report.md` (remediation table + verified results), `docs/implementation/23-environment-readiness.md` (DISCOVER table, acquisition method, verification table), `docs/implementation/28-package-02-identity-organization-implementation.md` §3 (tooling versions), plus repository-pinned facts (`composer.json`, `composer.lock` content-hash, `phpunit.xml`, `phpstan.neon`, `.env.example`).
**Recovery procedure:** `docs/environment/P02-environment-recovery.sh` (same directory) — `--recover` restores the checksummed prebuilt bundles of §8a first (local cache or the GitHub Release) and falls back to the §8 source build only for components still missing.

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
- **Exact configure line (verified build, rev 1.1)** — prerequisites: the §3 libraries installed under `${TH_ROOT}`, `pkg-config` available on `PATH`, and libpq 5.18 + headers at `${TH_ROOT}/pgsql` (see §6):

```sh
./configure --prefix="${TH_ROOT}/php" --with-config-file-path="${TH_ROOT}/php/etc" --enable-cli \
  --with-openssl="${TH_ROOT}" --with-curl="${TH_ROOT}" --with-zlib="${TH_ROOT}" --with-libxml="${TH_ROOT}" --with-iconv \
  --enable-mbstring \
  --enable-bcmath --enable-pcntl --enable-posix \
  --enable-dom --enable-simplexml --enable-xml --enable-xmlreader --enable-xmlwriter \
  --enable-session --enable-tokenizer --enable-fileinfo --enable-filter --enable-ctype \
  --without-sqlite3 --without-pdo-sqlite \
  --with-pgsql="${TH_ROOT}/pgsql" --with-pdo-pgsql="${TH_ROOT}/pgsql" \
  LDFLAGS="-Wl,-rpath-link,${TH_ROOT}/pgsql/lib -Wl,-rpath-link,${PG_NPM_DIR}/native/lib"
```

  Flag notes: `--with-oniguruma` is **not** a recognized PHP 8.2 option (ext/mbstring finds the external oniguruma 6.9.9 via `pkg-config`); `--enable-hash` is always-on; `sqlite3`/`pdo_sqlite` **must be disabled** — configure enables them by default and hard-fails on hosts without sqlite dev headers (apt unreachable, and sqlite is not part of the recorded dependency set or §3 extension set); the `rpath-link` LDFLAGS are required because ld does not search `-L` dirs for transitive `NEEDED` entries of `libpq.so.5` (its bundled `libssl.so.1.1`/`libcrypto.so.1.1` live in the npm package's `native/lib`).

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

**Metadata/layout contract (rev 1.1)** — builds drop artifacts in `lib64` (OpenSSL), `lib/x86_64-linux-gnu` (meson) and `share/pkgconfig` (cmake). The recovery script consolidates after building pkgconf:

- `${TH_ROOT}/bin/pkgconf` and `${TH_ROOT}/bin/pkg-config` → the **static** pkgconf at `${TH_ROOT}/tools/pkgconf/bin/pkgconf` (neutral prefix — see §8).
- `.pc` files for openssl/libssl/libcrypto/libxml-2.0/zlib symlinked into `${TH_ROOT}/lib/pkgconfig` (the script's `PKG_CONFIG_PATH`); `Cflags: -I${includedir}` appended to the OpenSSL `.pc` files when missing (`make install_sw` omits it — without it PHP's configure gets no `-I${TH_ROOT}/include`).
- Runtime libs symlinked into `${TH_ROOT}/lib` per the `LD_LIBRARY_PATH` contract: `libssl.so.3`, `libcrypto.so.3` (from `../lib64`), `libxml2.so(.16)` (from `x86_64-linux-gnu`).

## 4. Composer — exact version

- **Composer 2.10.2**, at `${TH_ROOT}/dev/bin/composer`.
- Bootstrapped from the canonical `github.com/composer/composer` at annotated tag `2.10.2` (commit `8d4439f572a97670a9edc039eb3b093cc976b4bc`); runtime dependencies installed from their official GitHub repositories at composer's own committed `composer.lock` references.
- Expected `composer --version`: `Composer version 2.10.2 2026-07-01`.
- `COMPOSER_HOME` is set to `${TH_ROOT}/composer-home`.
- **Deterministic autoloader requirements (rev 1.1)** — the generated `vendor/autoload.php` in the composer source tree must: give psr-4 dirs a trailing separator (Composer ClassLoader semantics — `"src" . "Foo.php"` ≠ `"src/Foo.php"`); load classmap stub entries on demand (symfony polyfill `Resources/stubs` → global classes such as `Normalizer`; php-enum stubs) — eager loading is forbidden (would redeclare PHP ≥ 8 classes like `ValueError`); load `files` entries (`React\Promise\resolve()` etc.); and **return a `Composer\Autoload\ClassLoader` instance** — composer's `src/bootstrap.php` type-checks the include result as `?ClassLoader` and dies otherwise.
- **Wrapper note:** `${TH_ROOT}/dev/bin/composer` merges stderr into stdout (`exec … "$@" 2>&1`). Composer 2.10.2 writes install/verify output to **stderr** while the recovery script's lock-sync check greps the wrapper's **stdout**; without the merge a fully-in-sync vendor tree is reported as out of sync.

## 5. Laravel / framework — exact version

- **laravel/framework 12.67.0** (selected because v13 requires PHP ^8.3; v12.67.0 is the highest 12.x compatible with PHP 8.2.27).
- Declared in `composer.json` as `"laravel/framework": "^12.67.0"` with Packagist disabled and **126 `vcs` repositories** (125 package repos + packagist-disabled entry) each pointing at the package's canonical official GitHub repository with `"no-api": true`.
- Installed via `composer install` from the committed `composer.lock` (73 packages; content-hash `d6eab7208db9f0891547ef361ee7478b`). **NEVER use `composer update` for restoration** — `composer install` with the committed lock only.
- Expected `php artisan --version`: `Laravel Framework 12.67.0`.

## 6. PostgreSQL — exact version

- **PostgreSQL 18.4** server, running locally at `127.0.0.1:5432`, user `postgres` / password `postgres`.
- Binaries from npm `@embedded-postgres/linux-x64` (`initdb`, `pg_ctl`, `postgres` in the package's `native/` dir — the package ships **no other binaries and no headers**).
- Client lib `libpq.so.5.18` (REL_16_4 era) copied from the same npm package to `${TH_ROOT}/pgsql/lib`.
- **libpq headers (rev 1.1):** the npm package ships none, and tag tarballs of `postgres/postgres` ship no `./configure` (autotools chain unavailable) — the public headers (`libpq-fe.h`, `libpq-events.h`, `libpq/libpq-fs.h`, `postgres_ext.h`, generated `pg_config_ext.h` with `#define PG_INT64_TYPE long long int`) are extracted from the canonical `codeload.github.com/postgres/postgres/tar.gz/REL_16_4` tag tarball into `${TH_ROOT}/pgsql/include`. `REL_16_4` matches the `libpq.so.5.18` ABI era.
- **Client tools (rev 1.1):** the base image has no `psql`/`createdb`/`pg_isready` (apt unreachable) — deterministic shims implementing exactly the invocation modes the recovery script uses are installed at `${TH_ROOT}/pgdev/bin/{psql,createdb,pg_isready}`, dispatching to `${TH_ROOT}/pgdev/lib/p02-pg-shim.php` (the environment's own PHP 8.2.27 + `pdo_pgsql`). `psql -lqt` output keeps the `name | owner | …` pipe layout the script's `cut -d'|' -f1` expects.
- Server data dir: `${TH_ROOT}/pgdata`; log: `${TH_ROOT}/pg.log`; start via the package's `pg_ctl` with `-o "-p 5432 -k /tmp -h 127.0.0.1"`.
- Expected `select version()`: `PostgreSQL 18.4 on x86_64-pc-linux-gnu`.

## 7. Node / npm — exact versions

- **Node v22.22.3**, **npm 10.9.8** (verified present in the working sandbox).
- Required only to acquire the `@embedded-postgres/linux-x64` npm package (PostgreSQL binaries + libpq). No Node runtime is used by the application or tests.

## 8. Required system packages

Base image provides: `gcc`, `g++`, `make`, `perl`, `git`, `curl`, `wget`, `python3` (3.11), `pip3` (23.0.1). No apt packages are used (apt is unreachable). The pinned dependency libraries (zlib, OpenSSL, curl, oniguruma, libxml2, pkgconf) are built from source into `${TH_ROOT}` from canonical codeload tag tarballs. Build-system tools are obtained deterministically from PyPI wheels (reachable): `python3 -m pip install --user cmake ninja meson`, with a `--break-system-packages --user` fallback for PEP 668 externally-managed pythons (installs only into `~/.local`). Two environment floors are exported by the recovery script before any build:

```sh
export CMAKE_POLICY_VERSION_MINIMUM=3.5   # oniguruma 6.9.9 declares cmake_minimum_required < 3.5;
                                          # PyPI wheels ship CMake >= 4, which rejects it otherwise
```

Build routes per component (all CMake/Meson — no autotools chain is required):

| Component | Recorded version (record 22) | Deterministic recovery pin | Build system |
|---|---|---|---|
| zlib | 1.3.1 | codeload `madler/zlib` tag `v1.3.1` | CMake |
| OpenSSL | 3.0.13 | codeload `openssl/openssl` tag `openssl-3.0.13` | `./Configure` (perl) |
| curl | 8.5.0-DEV (snapshot, no pinned ref) | codeload `curl/curl` tag `curl-8_5_0` (release line; **documented divergence** — recorded DEV snapshot had no recorded ref; PHP requires curl ≥ 7.61) | CMake |
| oniguruma | 6.9.9 | codeload `kkos/oniguruma` tag `v6.9.9` | CMake |
| libxml2 | 2.16.0 | codeload `GNOME/libxml2` tag `v2.15.3` (GitHub mirror max; **documented divergence** — 2.16.0 tarball exists only on the blocked GNOME gitlab) | Meson |
| pkgconf | 2.1.0 | codeload `pkgconf/pkgconf` tag `pkgconf-2.1.0` — built **static** at the neutral prefix `${TH_ROOT}/tools/pkgconf` (**rev 1.1 change**) | Meson |

**pkgconf neutral-prefix requirement (rev 1.1):** a pkgconf installed at `${TH_ROOT}` itself resolves its "system include dir" to `${TH_ROOT}/include` and **silently strips `-I${TH_ROOT}/include` from `pkg-config --cflags`** — standard system-dir filtering, misdirected — which broke PHP's OpenSSL header detection (empty `OPENSSL_CFLAGS`). The static build at `${TH_ROOT}/tools/pkgconf` has no runtime library dependency and its filter list points at its own (nonexistent) include dir. Canonical names `${TH_ROOT}/bin/pkgconf` and `${TH_ROOT}/bin/pkg-config` are symlinks to it.

All tarballs downloaded from `codeload.github.com/<owner>/<repo>/tar.gz/<tag>` (verified reachable, TLS verified). Every build is followed by its own verification step; a component that cannot be reconstructed deterministically stops the recovery with an explicit missing-component report (per the CRITICAL RULE — no fresh investigation).

## 8a. Artifact-first recovery (rev 1.2)

The §8 source build takes ~11 minutes on 2 vCPU. A **verified** environment can instead be snapshotted once into checksummed bundles and restored in seconds. Nothing large ever enters Git — bundles are attached to a **GitHub Release** (`gh`), which is the artifact/cache mechanism.

**Artifacts** (produced by `bash docs/environment/P02-environment-recovery.sh --bundle [DIR]`, default `DIR=/home/user/p02-artifacts`):

| File | ~Size | Contents (tar roots) | Excluded |
|---|---|---|---|
| `p02-toolchain-<id>.tar.gz` | ~79 MB | `php/ lib/ lib64/ include/ share/ bin/ tools/ pgdev/ pgsql/ dev/ pg-npm/ src/composer-2.10.2` | the 842 MB `src/` build trees, `pgdata/`, `composer-home/` cache, all `.git` dirs |
| `p02-vendor-<id>.tar.gz` | ~39 MB | repo `vendor/` tree | — |
| `p02-manifest.json` | 1 KB | bundle `sha256` + bytes; pinned versions (php/composer/postgres/pg_npm/libpq); **`composer_lock_sha256`** | — |

`<id>` is `P02_ARTIFACT_ID` (default `1`); bump it when producing a new artifact generation.

**Publication** (when the bundles should serve fresh sandboxes):

```sh
bash docs/environment/P02-environment-recovery.sh --publish [DIR]   # gh release upload -> tag p02-artifacts
```

Release asset URL base: `https://github.com/<repo>/releases/download/p02-artifacts` (override with `P02_ARTIFACT_REPO` / `P02_ARTIFACT_TAG` / `P02_ARTIFACT_BASE_URL`).

**Consumption — `--recover` order (rev 3 script):**

1. Verify; if already valid, stop (never restores over a working environment).
2. One-time host prep: create `/opt/th -> /home/user/toolchain` (§17) if missing.
3. `restore_from_artifacts` — manifest located from `${P02_ARTIFACT_DIR}` (local cache) first, then the release (anonymous https; on TLS-blocked asset CDNs the authenticated `gh release download` route is attempted — restricted sandboxes that firewall `release-assets.githubusercontent.com` fall back to the local cache or, last resort, the §8 source build). Integrity gates, all non-fatal:
   - manifest pinned versions must equal the script pins (php 8.2.27 / composer 2.10.2 / postgres 18.4), else artifacts are ignored;
   - every bundle is `sha256`-verified before extraction (cached copy first, then download);
   - the vendor bundle is extracted **only** when the repo `composer.lock` sha256 equals the manifest's `composer_lock_sha256` — otherwise it is skipped and `composer install` from the committed lock (§5) runs instead.
4. Any component still missing is repaired by the untouched §8 source-build chain — **source compilation is fallback-only**.
5. PostgreSQL is never bundled: `pgdata/` is re-`initdb`'d and the two empty databases re-created (§12); the schema stays owned by the application's migrations.

**Measured (2026-08-25, 2 vCPU sandbox):** clean host → `--recover` → `RECOVERY COMPLETE … exit 0` in **~7 s** (bundle extraction + initdb + createdb + full verification), versus ~11 min for the source build. Idempotent re-run reports `Environment already valid` immediately.

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
export PATH="${TH_ROOT}/php/bin:${TH_ROOT}/bin:${TH_ROOT}/dev/bin:${TH_ROOT}/pgdev/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="${TH_ROOT}/lib:${TH_ROOT}/pgsql/lib:${PG_NPM_DIR}/native/lib:${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="${TH_ROOT}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
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

Expected result (certified cumulative suite since Package 08, 2026-08-26): **OK (222 tests, 847 assertions)**. (Package 02 closed at 78/371, P03 at 118/477, P04 at 158/590, P05 at 179/657, P06 at 193/732, P07 at 209/792; the cumulative suite only grows.)

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
| `${TH_ROOT}` (default `/opt/th`) | toolchain root; `/opt/th` is a symlink into the persistent workspace (`/home/user/toolchain`). One-time host prep (requires sudo, nothing else does): `mkdir -p /home/user/toolchain && sudo ln -sfn /home/user/toolchain /opt/th` |
| `/home/user/p02-artifacts` | local artifact cache: `p02-manifest.json` + toolchain/vendor bundles (§8a) |
| `/home/user/toolchain` | real toolchain directory (user-writable; `/opt` itself is root-owned) |
| `${TH_ROOT}/php` | PHP 8.2.27 prefix |
| `${TH_ROOT}/bin/pkgconf`, `${TH_ROOT}/bin/pkg-config` | symlinks to the static pkgconf at `${TH_ROOT}/tools/pkgconf/bin/pkgconf` |
| `${TH_ROOT}/tools/pkgconf` | pkgconf 2.1.0 static install (neutral prefix — see §8) |
| `${TH_ROOT}/lib/pkgconfig` | the consolidated `PKG_CONFIG_PATH` dir (openssl/libssl/libcrypto/libxml-2.0/zlib/oniguruma/libcurl `.pc`) |
| `${TH_ROOT}/dev/bin/composer` | Composer 2.10.2 (stderr→stdout merging wrapper) |
| `${TH_ROOT}/composer-home` | COMPOSER_HOME cache |
| `${TH_ROOT}/pgsql` | libpq 5.18 (`lib/`) + REL_16_4 headers (`include/`) |
| `${TH_ROOT}/pgdev/bin` | `initdb`/`pg_ctl`/`postgres` symlinks into the npm package + the `psql`/`createdb`/`pg_isready` shims |
| `${TH_ROOT}/pgdev/lib/p02-pg-shim.php` | shared PHP backend of the client-tool shims |
| `${TH_ROOT}/lib` | built dependency libs + consolidated runtime symlinks (see §3 metadata contract) |
| `${TH_ROOT}/src` | downloaded source tarballs + extracted build trees |
| `${TH_ROOT}/pgdata`, `${TH_ROOT}/pg.log` | PostgreSQL 18.4 data dir / server log |
| `${TH_ROOT}/pg-npm` | npm staging dir for `@embedded-postgres/linux-x64` |
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
| 0 | `bash docs/environment/P02-environment-recovery.sh --verify` | all component checks OK; final line `ENVIRONMENT VALID — reuse it. Do not rebuild.`; **exit code 0** (rev 1.1 — the script previously returned 1 for a fully valid environment due to an inverted success flag in `check_tools`) |
| 1 | `php -v` | `PHP 8.2.27 (cli) (built: Aug 24 2026) (NTS)` |
| 2 | `composer --version` | `Composer version 2.10.2 2026-07-01` |
| 3 | `php artisan --version` | `Laravel Framework 12.67.0` |
| 4 | `php -m` | full extension set of §3, including `pdo_pgsql`, `pcntl`, `posix`, `mbstring`, `openssl` |
| 5 | `composer validate --no-check-publish` | `composer.json is valid` (lock content-hash matches) |
| 6 | `composer install --dry-run` | `in sync` (nothing to install/update/remove) |
| 7 | `composer audit` | no known security advisories |
| 8 | `php artisan db:show` | connects to `toefl_house` as `postgres`; server version `PostgreSQL 18.4` |
| 9 | `php vendor/bin/phpunit` | `OK (222 tests, 847 assertions)` (cumulative Package 02–08 suite; Package 02 closed at 78/371, P03 at 118/477, P04 at 158/590, P05 at 179/657, P06 at 193/732, P07 at 209/792; the earlier 52/229 R3-closure state was never committed and no longer exists) |
| 10 | `php vendor/bin/phpstan analyse --memory-limit=1G` | `[OK] No errors` |
| 11 | `php vendor/bin/pint --test` | `PASS` |

The recovery script implements exactly this battery in `--verify` mode.
