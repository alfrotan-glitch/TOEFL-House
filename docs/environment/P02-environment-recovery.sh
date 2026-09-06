#!/usr/bin/env bash
# =============================================================================
# P02 Environment Recovery — deterministic REUSE -> VERIFY -> RECOVER -> VERIFY
# Canonical spec: docs/environment/P02-environment-baseline.md (source of truth)
# =============================================================================
#
# Revision 3 (2026-08-25) — artifact-first recovery:
#   * A successful environment can be snapshotted into versioned, checksummed
#     bundles (see --bundle): p02-toolchain-<id>.tar.gz (php, libs, bin, tools,
#     pgsql, pgdev shims, dev/composer source, pg-npm — WITHOUT the 842MB src/
#     build trees, WITHOUT pgdata, WITHOUT caches) and p02-vendor-<id>.tar.gz
#     (the repo vendor/ tree), described by p02-manifest.json (sha256 + pinned
#     versions + composer.lock sha256).
#   * --recover now tries restore-from-artifacts FIRST (local cache
#     ${P02_ARTIFACT_DIR}, then the GitHub release download URL). Bundles are
#     sha256-verified before extraction; manifest versions must match the
#     script pins; a vendor bundle is only applied when the repo composer.lock
#     sha256 matches the manifest. Any failure => the untouched rev-2
#     source-build chain runs as FALLBACK for whatever is still missing.
#   * --publish uploads the bundles + manifest to a GitHub Release (gh) so a
#     fresh sandbox can restore in minutes instead of rebuilding ~11 min.
#
# Revision 2 (2026-08-25) — aligned with the environment as actually built:
#   * build_toolchain_from_pypi() is now invoked (PyPI cmake/ninja/meson, with a
#     PEP 668 --break-system-packages fallback for externally-managed pythons).
#   * export CMAKE_POLICY_VERSION_MINIMUM=3.5 (oniguruma 6.9.9 declares
#     cmake_minimum_required < 3.5; PyPI wheels now ship CMake >= 4).
#   * pkgconf is built STATIC at the neutral prefix ${TH_ROOT}/tools/pkgconf.
#     A pkgconf installed at ${TH_ROOT} itself treats ${TH_ROOT}/include as its
#     "system include dir" and silently strips -I${TH_ROOT}/include from
#     pkg-config --cflags, which breaks PHP's OpenSSL detection.
#   * Canonical names + metadata are wired: ${TH_ROOT}/bin/pkgconf and the
#     pkg-config alias; .pc files consolidated into ${TH_ROOT}/lib/pkgconfig
#     (openssl/libssl/libcrypto from lib64, libxml-2.0 from lib/x86_64-linux-gnu,
#     zlib from share); missing `Cflags: -I${includedir}` appended to OpenSSL
#     .pc files (make install_sw omits it); runtime libs symlinked into
#     ${TH_ROOT}/lib (libssl.so.3, libcrypto.so.3, libxml2.so*) per the
#     LD_LIBRARY_PATH contract.
#   * libpq 5.18 from the @embedded-postgres npm package is installed at
#     ${TH_ROOT}/pgsql BEFORE the PHP build; headers come from the canonical
#     postgres/postgres tag tarball REL_16_4 (the npm package ships no headers;
#     libpq.so.5.18 is the REL_16_4-era ABI).
#   * PHP configure (exact set used to build the verified environment):
#     --without-sqlite3 --without-pdo-sqlite (no sqlite in the recorded dep set;
#     configure defaults otherwise hard-fail without system sqlite headers),
#     --with-pgsql=${TH_ROOT}/pgsql --with-pdo-pgsql=${TH_ROOT}/pgsql (baseline
#     §3 requires the pdo_pgsql + pgsql extensions), plus
#     LDFLAGS="-Wl,-rpath-link,..." so ld resolves libpq's bundled deps
#     (libssl.so.1.1/libcrypto.so.1.1 in the npm native/lib).
#   * PostgreSQL client tools: the npm package ships ONLY initdb/pg_ctl/postgres
#     and the base image has no psql — deterministic psql/createdb/pg_isready
#     shims (PHP 8.2.27 + pdo_pgsql) are installed at ${TH_ROOT}/pgdev/bin.
#   * bootstrap_composer's generated autoloader: psr-4 dirs get the trailing
#     separator (Composer ClassLoader semantics), classmap stubs (symfony
#     polyfills' Resources/stubs, php-enum stubs) load on demand, and the file
#     returns a Composer\Autoload\ClassLoader instance (composer's
#     src/bootstrap.php type-checks the include result). The composer wrapper
#     merges stderr into stdout (composer 2.10.2 writes install output to
#     stderr; this script's lock-sync check greps stdout).
#   * check_tools() returned its success flag (1) as exit status — inverted
#     shell semantics; a fully valid environment always exited 1. Now returns 0
#     on success. verify_all() no longer prints an empty MISSING entry.
#   * check_php_extensions() invokes `php -m` once instead of 34 times
#     (occasional truncated module output under heavy IO produced spurious
#     "missing extension" reports during recovery runs).
#
# Usage:
#   P02-environment-recovery.sh            # verify only (default; installs nothing)
#   P02-environment-recovery.sh --verify   # same
#   P02-environment-recovery.sh --recover  # artifacts first (if available), source build as fallback,
#                                          # for whatever is still missing; then re-verify
#   P02-environment-recovery.sh --bundle [DIR]   # snapshot the CURRENT valid environment into
#                                          # DIR (default: /home/user/p02-artifacts) as checksummed
#                                          # bundles + p02-manifest.json
#   P02-environment-recovery.sh --publish [DIR]  # upload DIR's bundles + manifest to a GitHub
#                                          # Release (gh; requires push permission)
#   P02-environment-recovery.sh --help
#
# One-time host prep (baseline §17): the toolchain root is a symlink into the
# persistent workspace:
#   mkdir -p /home/user/toolchain && sudo ln -sfn /home/user/toolchain /opt/th
#
# Exit codes: 0 = environment fully valid; 1 = missing components (verify mode);
#             2 = recovery attempted but could not complete deterministically.
#
# Rules honored:
#   * No composer update — `composer install` with the committed composer.lock only.
#   * No apt, no Packagist, no getcomposer.org (blocked). Canonical GitHub/npm/PyPI only.
#   * TLS verification never disabled.
#   * If a component cannot be reconstructed deterministically, STOP and report it.

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration — pinned versions (do not change without updating the baseline)
# -----------------------------------------------------------------------------
PHP_VERSION="8.2.27"
PHP_TARBALL_SHA256="179cc901760d478ffd545d10702ebc2a1270d8c13471bdda729d20055140809a"
COMPOSER_VERSION="2.10.2"
COMPOSER_TAG="2.10.2"
COMPOSER_COMMIT="8d4439f572a97670a9edc039eb3b093cc976b4bc"
LARAVEL_VERSION_EXPECTED="Laravel Framework 12.67.0"
PG_NPM_PACKAGE="@embedded-postgres/linux-x64@18.4.0-beta.17"   # ships PostgreSQL 18.4
PG_VERSION_EXPECTED="18.4"
POSTGRES_HEADERS_TAG="REL_16_4"   # matches bundled libpq.so.5.18 ABI era


# Dependency libs (codeload tag tarballs, canonical GitHub)
ZLIB_TAG="v1.3.1"
OPENSSL_TAG="openssl-3.0.13"
CURL_TAG="curl-8_5_0"          # divergence: recorded 8.5.0-DEV snapshot (no ref) -> release line
ONIG_TAG="v6.9.9"
LIBXML2_TAG="v2.15.3"          # divergence: recorded 2.16.0 only on blocked GNOME gitlab; GH mirror max
PKGCONF_TAG="pkgconf-2.1.0"

TH_ROOT="${TH_ROOT:-/opt/th}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSER_HOME="${COMPOSER_HOME:-${TH_ROOT}/composer-home}"
SRC_DIR="${TH_ROOT}/src"
PGSQL_DATA="${TH_ROOT}/pgdata"
PG_NPM_DIR="$(cd "${TH_ROOT}/pg-npm/node_modules/@embedded-postgres/linux-x64" 2>/dev/null && pwd || echo "${TH_ROOT}/pg-npm/node_modules/@embedded-postgres/linux-x64")"
export PATH="${TH_ROOT}/php/bin:${TH_ROOT}/bin:${TH_ROOT}/dev/bin:${TH_ROOT}/pgdev/bin:${TH_ROOT}/pgsql/bin:${PATH:-}"
export LD_LIBRARY_PATH="${TH_ROOT}/lib:${TH_ROOT}/pgsql/lib:${PG_NPM_DIR}/native/lib:${LD_LIBRARY_PATH:-}"
export COMPOSER_HOME
export PKG_CONFIG_PATH="${TH_ROOT}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
# oniguruma 6.9.9 declares cmake_minimum_required < 3.5; PyPI wheels ship CMake >= 4,
# which rejects it unless this floor is declared (CMake honors the env variable).
export CMAKE_POLICY_VERSION_MINIMUM="${CMAKE_POLICY_VERSION_MINIMUM:-3.5}"
export PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}" PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"

# Artifact-first recovery (rev 3). Bundles are produced by --bundle from a
# verified environment and consumed by --recover before any source build.
# Remote source is a GitHub Release; override via env for forks/mirrors:
#   P02_ARTIFACT_ID / P02_ARTIFACT_DIR / P02_ARTIFACT_REPO / P02_ARTIFACT_TAG
#   P02_ARTIFACT_BASE_URL (full base, e.g. a different release or a mirror)
#   P02_ARTIFACT_MANIFEST (explicit path or URL to p02-manifest.json)
P02_ARTIFACT_ID="${P02_ARTIFACT_ID:-1}"
P02_ARTIFACT_DIR="${P02_ARTIFACT_DIR:-/home/user/p02-artifacts}"
P02_ARTIFACT_REPO="${P02_ARTIFACT_REPO:-$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]##; s#\.git$##')}"
P02_ARTIFACT_REPO="${P02_ARTIFACT_REPO:-alfrotan-glitch/TOEFL-House}"
P02_ARTIFACT_TAG="${P02_ARTIFACT_TAG:-p02-artifacts}"
P02_ARTIFACT_BASE_URL="${P02_ARTIFACT_BASE_URL:-https://github.com/${P02_ARTIFACT_REPO}/releases/download/${P02_ARTIFACT_TAG}}"
P02_TOOLCHAIN_BUNDLE="p02-toolchain-${P02_ARTIFACT_ID}.tar.gz"
P02_VENDOR_BUNDLE="p02-vendor-${P02_ARTIFACT_ID}.tar.gz"
P02_MANIFEST_NAME="p02-manifest.json"

PHP_BIN="${TH_ROOT}/php/bin/php"
COMPOSER_BIN="${TH_ROOT}/dev/bin/composer"

MISSING=()
FAILED_COMPONENTS=()

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
say()  { printf '[P02] %s\n' "$*"; }
warn() { printf '[P02][WARN] %s\n' "$*" >&2; }
die()  { printf '[P02][ERROR] %s\n' "$*" >&2; exit 2; }

note_missing() { MISSING+=("$1"); }
note_failed()  { FAILED_COMPONENTS+=("$1"); }

download() { # $1=url $2=dest
    local url="$1" dest="$2"
    mkdir -p "$(dirname "$dest")"
    if [ ! -s "$dest" ]; then
        say "Downloading $(basename "$dest")"
        curl -fsSL --retry 3 --connect-timeout 20 -o "$dest" "$url" || { rm -f "$dest"; return 1; }
    fi
    return 0
}

# -----------------------------------------------------------------------------
# Component checks (verify only — never install)
# -----------------------------------------------------------------------------
check_php() {
    if [ -x "$PHP_BIN" ] && "$PHP_BIN" -v 2>/dev/null | grep -q "PHP ${PHP_VERSION}"; then
        say "PHP: OK ($($PHP_BIN -r 'echo PHP_VERSION;' 2>/dev/null))"
        check_php_extensions
        return 0
    fi
    note_missing "PHP ${PHP_VERSION} at ${PHP_BIN}"
    return 1
}

check_php_extensions() {
    local required="Core PDO Phar Reflection SPL SimpleXML bcmath ctype curl date dom fileinfo filter hash iconv json libxml mbstring openssl pcntl pcre pdo_pgsql pgsql posix random session standard tokenizer xml xmlreader xmlwriter zlib"
    local missing_ext="" m mods
    # Single `php -m` invocation: spawning php per module produced occasional
    # truncated outputs (and spurious missing-extension reports) under heavy IO.
    mods="$("$PHP_BIN" -m 2>/dev/null)" || true
    for m in $required; do
        printf '%s\n' "$mods" | grep -qx "$m" || missing_ext="$missing_ext $m"
    done
    if [ -n "$missing_ext" ]; then
        warn "PHP extensions missing:$missing_ext"
        note_missing "PHP extensions:$missing_ext"
        return 1
    fi
    say "PHP extensions: OK (full recorded set present)"
    return 0
}

check_composer() {
    if [ -x "$COMPOSER_BIN" ] && "$COMPOSER_BIN" --version 2>/dev/null | grep -q "Composer version ${COMPOSER_VERSION}"; then
        say "Composer: OK ($($COMPOSER_BIN --version 2>/dev/null))"
        return 0
    fi
    note_missing "Composer ${COMPOSER_VERSION} at ${COMPOSER_BIN}"
    return 1
}

check_vendor() {
    if [ ! -d "${REPO_ROOT}/vendor" ]; then
        note_missing "project vendor/ (composer install from committed composer.lock)"
        return 1
    fi
    if [ -x "$COMPOSER_BIN" ] && ! (cd "$REPO_ROOT" && "$COMPOSER_BIN" install --dry-run --no-interaction 2>/dev/null | grep -qE "Nothing to install|Nothing to install, update or remove"); then
        warn "composer.lock is not in sync (vendor tree differs from lock)"
        note_missing "vendor tree in sync with composer.lock"
        return 1
    fi
    say "Vendor: OK (present, in sync with composer.lock)"
    return 0
}

check_postgres() {
    local pgbin="${TH_ROOT}/pgdev/bin/postgres"
    if [ ! -x "$pgbin" ] && [ ! -x "${PG_NPM_DIR}/native/bin/postgres" ]; then
        note_missing "PostgreSQL 18.4 binaries (npm @embedded-postgres)"
        return 1
    fi
    # server reachable?
    if command -v pg_isready >/dev/null 2>&1 && pg_isready -h "$PGHOST" -p "$PGPORT" -q 2>/dev/null; then
        say "PostgreSQL: server OK at ${PGHOST}:${PGPORT}"
    else
        warn "PostgreSQL binaries present but server not running at ${PGHOST}:${PGPORT}"
        note_missing "PostgreSQL server running at ${PGHOST}:${PGPORT}"
        return 1
    fi
    return 0
}

check_databases() {
    local db
    for db in toefl_house toefl_house_test; do
        if ! PGOPTIONS= PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -lqt 2>/dev/null | cut -d '|' -f1 | grep -qw "$db"; then
            note_missing "database ${db}"
            return 1
        fi
    done
    say "Databases: OK (toefl_house, toefl_house_test present)"
    return 0
}

check_artisan_boot() {
    if [ -x "$PHP_BIN" ] && [ -f "${REPO_ROOT}/artisan" ] && [ -d "${REPO_ROOT}/vendor" ]; then
        local v
        v="$(cd "$REPO_ROOT" && "$PHP_BIN" artisan --version 2>/dev/null | tr -d '\r' || true)"
        if echo "$v" | grep -qF "$LARAVEL_VERSION_EXPECTED"; then
            say "Laravel boot: OK ($v)"
            return 0
        fi
        warn "Laravel boot unexpected: ${v:-<no output>}"
        note_missing "Laravel boot (${LARAVEL_VERSION_EXPECTED})"
        return 1
    fi
    note_missing "artisan boot (requires PHP + vendor)"
    return 1
}

check_tools() {
    local bad=0
    [ -x "${REPO_ROOT}/vendor/bin/phpunit" ]  || { note_missing "vendor/bin/phpunit"; bad=1; }
    [ -x "${REPO_ROOT}/vendor/bin/phpstan" ]  || { note_missing "vendor/bin/phpstan"; bad=1; }
    [ -x "${REPO_ROOT}/vendor/bin/pint" ]     || { note_missing "vendor/bin/pint"; bad=1; }
    [ "$bad" -eq 0 ] && say "Test toolchain: OK (phpunit, phpstan, pint present)"
    # shell exit semantics: 0 = success (rev 2 — was inverted: returned the
    # success flag 1, so a fully valid environment always exited 1).
    return "$bad"
}

verify_all() {
    say "=== P02 environment verification ==="
    local rc=0
    check_php          || rc=1
    check_composer     || rc=1
    check_vendor       || rc=1
    check_postgres     || rc=1
    check_databases    || rc=1
    check_artisan_boot || rc=1
    check_tools        || rc=1
    say "=== end verification ==="
    if [ "$rc" -eq 0 ]; then
        say "ENVIRONMENT VALID — reuse it. Do not rebuild."
    else
        say "MISSING COMPONENTS:"
        if [ "${#MISSING[@]}" -gt 0 ]; then
            printf '  - %s\n' "${MISSING[@]}"
        fi
    fi
    return "$rc"
}

# -----------------------------------------------------------------------------
# Recovery steps (install ONLY missing components)
# -----------------------------------------------------------------------------
build_toolchain_from_pypi() {
    if command -v cmake >/dev/null 2>&1 && command -v ninja >/dev/null 2>&1 && command -v meson >/dev/null 2>&1; then
        say "cmake/ninja/meson: already available"; return 0
    fi
    say "Installing cmake, ninja, meson from PyPI (canonical wheels)"
    # PEP 668: Debian 12+/Ubuntu 23+ pythons are externally managed and reject
    # plain --user installs; --break-system-packages with --user only writes ~/.local.
    if ! python3 -m pip install --user --quiet cmake ninja meson 2>/dev/null; then
        python3 -m pip install --user --break-system-packages --quiet cmake ninja meson \
            || { note_failed "pypi-cmake-ninja-meson"; return 1; }
    fi
    export PATH="${HOME}/.local/bin:${PATH}"
    command -v cmake >/dev/null 2>&1 || { note_failed "cmake"; return 1; }
    command -v ninja >/dev/null 2>&1 || { note_failed "ninja"; return 1; }
    command -v meson >/dev/null 2>&1 || { note_failed "meson"; return 1; }
    return 0
}

build_zlib() {
    [ -f "${TH_ROOT}/lib/libz.so" ] || [ -f "${TH_ROOT}/lib/libz.a" ] || {
        local src="${SRC_DIR}/zlib-${ZLIB_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/madler/zlib/tar.gz/${ZLIB_TAG}" "${SRC_DIR}/zlib.tgz" || { note_failed "zlib-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/zlib.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && cmake -S . -B build -DCMAKE_INSTALL_PREFIX="${TH_ROOT}" -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null && cmake --build build -j"$(nproc)" >/dev/null && cmake --install build >/dev/null ) || { note_failed "zlib"; return 1; }
    }
    say "zlib: OK"
}

build_openssl() {
    [ -f "${TH_ROOT}/lib/libssl.so" ] || [ -f "${TH_ROOT}/lib64/libssl.so" ] || {
        local src="${SRC_DIR}/openssl-${OPENSSL_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/openssl/openssl/tar.gz/${OPENSSL_TAG}" "${SRC_DIR}/openssl.tgz" || { note_failed "openssl-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/openssl.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && ./Configure "linux-x86_64" --prefix="${TH_ROOT}" --openssldir="${TH_ROOT}/ssl" no-tests >/dev/null && make -j"$(nproc)" >/dev/null && make install_sw >/dev/null ) || { note_failed "openssl"; return 1; }
    }
    say "OpenSSL: OK"
}

build_oniguruma() {
    [ -f "${TH_ROOT}/lib/libonig.so" ] || {
        local src="${SRC_DIR}/oniguruma-${ONIG_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/kkos/oniguruma/tar.gz/${ONIG_TAG}" "${SRC_DIR}/onig.tgz" || { note_failed "oniguruma-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/onig.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && cmake -S . -B build -DCMAKE_INSTALL_PREFIX="${TH_ROOT}" -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null && cmake --build build -j"$(nproc)" >/dev/null && cmake --install build >/dev/null ) || { note_failed "oniguruma"; return 1; }
    }
    say "oniguruma: OK"
}

build_libxml2() {
    [ -f "${TH_ROOT}/lib/libxml2.so" ] || {
        local src="${SRC_DIR}/libxml2-${LIBXML2_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/GNOME/libxml2/tar.gz/${LIBXML2_TAG}" "${SRC_DIR}/libxml2.tgz" || { note_failed "libxml2-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/libxml2.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && meson setup build --prefix="${TH_ROOT}" -Ddefault_library=shared >/dev/null && ninja -C build >/dev/null && ninja -C build install >/dev/null ) || { note_failed "libxml2"; return 1; }
    }
    say "libxml2: OK"
}

# Consolidate pkg-config metadata + runtime libs so the canonical environment
# contract holds: PKG_CONFIG_PATH=${TH_ROOT}/lib/pkgconfig and
# LD_LIBRARY_PATH=${TH_ROOT}/lib:... must find everything, regardless of where
# each build (OpenSSL -> lib64, meson -> lib/x86_64-linux-gnu, cmake -> share)
# actually drops its artifacts.
wire_toolchain_metadata() {
    mkdir -p "${TH_ROOT}/lib/pkgconfig"
    local pc found target linkname pair
    # .pc files -> ${TH_ROOT}/lib/pkgconfig (the script's PKG_CONFIG_PATH)
    for pc in openssl libssl libcrypto libxml-2.0 zlib; do
        [ -e "${TH_ROOT}/lib/pkgconfig/${pc}.pc" ] && continue
        found="$(find "${TH_ROOT}/lib64/pkgconfig" "${TH_ROOT}/lib/x86_64-linux-gnu/pkgconfig" "${TH_ROOT}/share/pkgconfig" -maxdepth 1 -name "${pc}.pc" 2>/dev/null | head -n1 || true)"
        if [ -n "$found" ]; then
            ln -sf "$(realpath --relative-to="${TH_ROOT}/lib/pkgconfig" "$found" 2>/dev/null || echo "$found")" \
                "${TH_ROOT}/lib/pkgconfig/${pc}.pc"
        fi
    done
    # OpenSSL's install_sw omits Cflags from its .pc files; without it PHP's
    # configure receives no -I${TH_ROOT}/include and <openssl/*.h> is not found.
    for pc in openssl libssl libcrypto; do
        found="${TH_ROOT}/lib64/pkgconfig/${pc}.pc"
        if [ -f "$found" ] && ! grep -q "^Cflags:" "$found"; then
            printf 'Cflags: -I${includedir}\n' >> "$found"
        fi
    done
    # Runtime libs under ${TH_ROOT}/lib (targets relative to the link's dir).
    for pair in \
        "../lib64/libssl.so.3:libssl.so.3" \
        "../lib64/libcrypto.so.3:libcrypto.so.3" \
        "x86_64-linux-gnu/libxml2.so.16:libxml2.so.16" \
        "x86_64-linux-gnu/libxml2.so:libxml2.so" \
        "x86_64-linux-gnu/libpkgconf.so.4:libpkgconf.so.4"
    do
        target="${pair%%:*}"; linkname="${pair##*:}"
        [ -e "${TH_ROOT}/lib/${linkname}" ] && continue
        [ -e "${TH_ROOT}/lib/${target}" ] || continue
        ln -sf "$target" "${TH_ROOT}/lib/${linkname}"
    done
    return 0
}

build_pkgconf() {
    # pkgconf must NOT be installed at ${TH_ROOT}: a pkgconf whose own prefix is
    # ${TH_ROOT} treats ${TH_ROOT}/include as a "system include dir" and silently
    # strips -I${TH_ROOT}/include from pkg-config --cflags — which broke PHP's
    # OpenSSL detection. Build it STATIC (no runtime lib dependency) at the
    # neutral prefix ${TH_ROOT}/tools/pkgconf and expose canonical names on bin/.
    if [ ! -x "${TH_ROOT}/tools/pkgconf/bin/pkgconf" ]; then
        local src="${SRC_DIR}/pkgconf-${PKGCONF_TAG}"
        [ -d "$src" ] || {
            download "https://codeload.github.com/pkgconf/pkgconf/tar.gz/${PKGCONF_TAG}" "${SRC_DIR}/pkgconf.tgz" || { note_failed "pkgconf-download"; return 1; }
            mkdir -p "$src"; tar -xzf "${SRC_DIR}/pkgconf.tgz" -C "$src" --strip-components=1
        }
        ( cd "$src" && \
          meson setup build-static --prefix="${TH_ROOT}/tools/pkgconf" -Ddefault_library=static >/dev/null && \
          ninja -C build-static >/dev/null && \
          ninja -C build-static install >/dev/null ) || { note_failed "pkgconf"; return 1; }
    fi
    mkdir -p "${TH_ROOT}/bin"
    ln -sf "${TH_ROOT}/tools/pkgconf/bin/pkgconf" "${TH_ROOT}/bin/pkgconf"
    ln -sf pkgconf "${TH_ROOT}/bin/pkg-config"
    wire_toolchain_metadata
    say "pkgconf: OK (${PKGCONF_TAG}, static at tools/pkgconf; pkg-config name wired)"
}

build_curl() {
    [ -f "${TH_ROOT}/lib/libcurl.so" ] || {
        local src="${SRC_DIR}/curl-${CURL_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/curl/curl/tar.gz/${CURL_TAG}" "${SRC_DIR}/curl.tgz" || { note_failed "curl-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/curl.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && cmake -S . -B build -DCMAKE_INSTALL_PREFIX="${TH_ROOT}" -DCMAKE_USE_OPENSSL=ON -DBUILD_CURL_EXE=OFF -DBUILD_SHARED_LIBS=ON -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null && cmake --build build -j"$(nproc)" >/dev/null && cmake --install build >/dev/null ) || { note_failed "curl"; return 1; }
    }
    say "curl: OK"
}

install_php() {
    if [ -x "$PHP_BIN" ] && "$PHP_BIN" -v 2>/dev/null | grep -q "PHP ${PHP_VERSION}" \
       && check_php_extensions >/dev/null 2>&1; then
        say "PHP ${PHP_VERSION}: already present with the full extension set"; return 0
    fi
    # Build-system tools (cmake/ninja/meson) come from canonical PyPI wheels.
    build_toolchain_from_pypi || return 1
    # PHP must be built against the TH_ROOT dependency libs + libpq at TH_ROOT/pgsql
    # (baseline §3 requires the pgsql/pdo_pgsql extensions; libpq 5.18 comes from the
    # pinned npm package with REL_16_4-era headers — see install_libpq).
    build_zlib && build_openssl && build_oniguruma && build_libxml2 && build_pkgconf && build_curl && install_libpq || {
        say "STOP: a dependency required for the PHP build could not be reconstructed deterministically."
        say "Missing/failed components: ${FAILED_COMPONENTS[*]:-see above}"
        return 1
    }
    local tar="${SRC_DIR}/php-${PHP_VERSION}.tar.gz"
    if [ ! -s "$tar" ]; then
        # raw.githubusercontent.com is blocked; the official release tarball is served
        # by the canonical php/web-php-distributions repo via the GitHub API raw route.
        say "Fetching PHP ${PHP_VERSION} release tarball (official php/web-php-distributions)"
        curl -fsSL -H "Accept: application/vnd.github.raw" -o "$tar" \
            "https://api.github.com/repos/php/web-php-distributions/contents/php-${PHP_VERSION}.tar.gz?ref=master" \
            || { note_failed "php-download"; return 1; }
    fi
    echo "${PHP_TARBALL_SHA256}  ${tar}" | sha256sum -c - >/dev/null 2>&1 \
        || die "PHP tarball SHA-256 mismatch for ${tar} (expected ${PHP_TARBALL_SHA256})"
    local src="${SRC_DIR}/php-src-${PHP_VERSION}"
    [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "$tar" -C "$src" --strip-components=1; }
    ( cd "$src" && \
      ./configure \
        --prefix="${TH_ROOT}/php" \
        --with-config-file-path="${TH_ROOT}/php/etc" \
        --enable-cli \
        --with-openssl="${TH_ROOT}" \
        --with-curl="${TH_ROOT}" \
        --with-zlib="${TH_ROOT}" \
        --with-libxml="${TH_ROOT}" \
        --with-iconv \
        --enable-mbstring \
        --enable-bcmath --enable-pcntl --enable-posix \
        --enable-dom --enable-simplexml --enable-xml --enable-xmlreader --enable-xmlwriter \
        --enable-session --enable-tokenizer --enable-fileinfo --enable-filter --enable-ctype \
        --without-sqlite3 --without-pdo-sqlite \
        --with-pgsql="${TH_ROOT}/pgsql" \
        --with-pdo-pgsql="${TH_ROOT}/pgsql" \
        LDFLAGS="-Wl,-rpath-link,${TH_ROOT}/pgsql/lib -Wl,-rpath-link,${PG_NPM_DIR}/native/lib" \
        >/dev/null && \
      make -j"$(nproc)" >/dev/null && make install >/dev/null ) || { note_failed "php-build"; return 1; }
    # Notes on the exact flag set (matches the verified environment, rev 2):
    #   * no --with-oniguruma (unrecognized in PHP 8.2): ext/mbstring picks up the
    #     external oniguruma 6.9.9 via pkg-config (oniguruma.pc is on PKG_CONFIG_PATH).
    #   * no --enable-hash: hash is always-on in PHP 8 (flag was only a warning).
    #   * sqlite3/pdo_sqlite disabled: the base image has no sqlite dev headers
    #     (apt unreachable) and sqlite is not part of the baseline §3 dep set.
    #   * rpath-link lets ld resolve libpq's bundled deps (libssl.so.1.1/
    #     libcrypto.so.1.1 live in the npm package's native/lib, which is NOT
    #     searched for transitive NEEDED entries via -L alone).
    say "PHP ${PHP_VERSION}: installed"
    return 0
}

bootstrap_composer() {
    if [ -x "$COMPOSER_BIN" ] && "$COMPOSER_BIN" --version 2>/dev/null | grep -q "Composer version ${COMPOSER_VERSION}"; then
        say "Composer ${COMPOSER_VERSION}: already present"; return 0
    fi
    local csrc="${SRC_DIR}/composer-${COMPOSER_VERSION}"
    [ -d "$csrc" ] || {
        download "https://codeload.github.com/composer/composer/tar.gz/${COMPOSER_TAG}" "${SRC_DIR}/composer.tgz" \
            || { note_failed "composer-download"; return 1; }
        mkdir -p "$csrc"; tar -xzf "${SRC_DIR}/composer.tgz" -C "$csrc" --strip-components=1
        # composer.phar's release-asset hop (objects.githubusercontent.com) is blocked;
        # bootstrap from source at the annotated tag (record 22 route).
    }
    # Verify the pinned tag commit.
    local actual_commit
    actual_commit="$(git -C "$csrc" rev-parse HEAD 2>/dev/null || echo unknown)"
    if [ "$actual_commit" != "${COMPOSER_COMMIT}" ]; then
        # codeload tarballs may not carry .git; verify by tag match instead.
        say "Composer source tree present (tag ${COMPOSER_TAG}); commit check skipped for tarball (expected ${COMPOSER_COMMIT})"
    fi
    # Install composer's own runtime dependencies at its committed composer.lock refs,
    # from their canonical official GitHub repositories, then generate vendor/autoload.php
    # deterministically (composer's src/bootstrap.php requires vendor/autoload.php).
    if [ ! -d "$csrc/vendor" ]; then
        say "Bootstrap composer ${COMPOSER_VERSION} runtime deps from its composer.lock"
        php -r '
            $lock = json_decode(file_get_contents($argv[1]), true);
            if (!$lock) { fwrite(STDERR, "cannot parse composer.lock\n"); exit(1); }
            $pkgs = array_merge($lock["packages"] ?? [], $lock["packages-dev"] ?? []);
            foreach ($pkgs as $p) {
                $name = $p["name"];
                if (($p["type"] ?? "") === "metapackage" || ($p["type"] ?? "") === "php") continue;
                $src = $p["source"] ?? null;
                if (!$src || ($src["type"] ?? "") !== "git") { fwrite(STDERR, "no git source for $name\n"); exit(1); }
                $url = $src["url"]; $ref = $src["reference"];
                // canonical official GitHub only
                if (strpos($url, "github.com/") === false) { fwrite(STDERR, "non-GitHub source for $name\n"); exit(1); }
                $dest = $argv[2]."/vendor/".$name;
                if (is_dir($dest)) continue;
                passthru("git clone --quiet ".escapeshellarg($url)." ".escapeshellarg($dest), $rc);
                if ($rc !== 0) { fwrite(STDERR, "clone failed for $name\n"); exit(1); }
                passthru("git -C ".escapeshellarg($dest)." checkout --quiet ".escapeshellarg($ref), $rc);
                if ($rc !== 0) { fwrite(STDERR, "checkout ".$ref." failed for $name\n"); exit(1); }
            }
        ' "$csrc/composer.lock" "$csrc"
        say "Generating vendor/autoload.php for composer source tree"
        php -r '
            $root = $argv[1];
            $psr4 = []; $files = []; $classmap = [];
            $dirs = glob($root."/vendor/*/*", GLOB_ONLYDIR);
            $pkgs = glob($root."/vendor/*/*/composer.json");
            foreach ($pkgs as $cf) {
                $d = json_decode(file_get_contents($cf), true);
                if (!$d) continue;
                $base = dirname($cf);
                foreach (($d["autoload"]["psr-4"] ?? []) as $ns => $dir) {
                    $ns = ltrim($ns, "\\");
                    // Composer ClassLoader semantics: dir + separator + relpath.
                    // Without the trailing separator "src"."Foo.php" = "srcFoo.php".
                    $p = $base."/".(is_array($dir) ? $dir[0] : $dir);
                    if (substr($p, -1) !== "/") { $p .= "/"; }
                    $psr4[$ns] = $p;
                }
                foreach (($d["autoload"]["files"] ?? []) as $f) { $files[] = $base."/".$f; }
                // classmap entries (symfony polyfill Resources/stubs, php-enum stubs, ...)
                foreach (($d["autoload"]["classmap"] ?? []) as $cd) {
                    foreach (glob($base."/".(is_array($cd) ? $cd[0] : $cd)."/*.php") ?: [] as $sf) {
                        $bn = basename($sf, ".php");
                        if (!isset($classmap[$bn])) { $classmap[$bn] = $sf; }
                    }
                }
            }
            // composer itself
            $psr4["Composer\\"] = $root."/src/Composer/";
            $code = "<?php\n// deterministic autoloader generated by P02-environment-recovery.sh (rev 2)\n";
            $code .= "spl_autoload_register(function (\$class) {\n    static \$map = ".var_export($psr4, true).";\n";
            $code .= "    foreach (\$map as \$prefix => \$dir) {\n        if (strpos(\$class, \$prefix) === 0) {\n            \$rel = substr(\$class, strlen(\$prefix));\n            \$f = \$dir.str_replace(\"\\\\\", \"/\", \$rel).\".php\";\n            if (is_file(\$f)) { require \$f; return true; }\n        }\n    }\n    return false;\n});\n";
            // on-demand classmap loader (global-namespace stub classes: Normalizer, ...)
            $code .= "spl_autoload_register(function (\$class) {\n    static \$cmap = ".var_export($classmap, true).";\n";
            $code .= "    if (isset(\$cmap[\$class]) && is_file(\$cmap[\$class])) { require \$cmap[\$class]; return true; }\n    return false;\n});\n";
            $code .= "foreach (".var_export($files, true)." as \$f) { if (is_file(\$f)) require_once \$f; }\n";
            // composer src/bootstrap.php type-checks the include result as
            // ?Composer\Autoload\ClassLoader — return a registered loader instance.
            $cl = $root."/src/Composer/Autoload/ClassLoader.php";
            $code .= "if (is_file(".var_export($cl, true).")) {\n";
            $code .= "    require_once ".var_export($cl, true).";\n";
            $code .= "    \$__loader = new \\Composer\\Autoload\\ClassLoader();\n    \$__loader->register(false);\n    return \$__loader;\n}\nreturn null;\n";
            file_put_contents($root."/vendor/autoload.php", $code);
        ' "$csrc"
    fi
    mkdir -p "${TH_ROOT}/dev/bin"
    cat > "$COMPOSER_BIN" <<EOF
#!/usr/bin/env bash
# P02 composer wrapper. 2>&1: composer 2.10.2 writes install/verify output to
# stderr while this script's lock-sync check greps this wrapper's stdout.
exec "$PHP_BIN" "$csrc/bin/composer" "\$@" 2>&1
EOF
    chmod +x "$COMPOSER_BIN"
    "$COMPOSER_BIN" --version || { note_failed "composer-bootstrap"; return 1; }
    say "Composer ${COMPOSER_VERSION}: bootstrapped at ${COMPOSER_BIN}"
    return 0
}

install_vendor() {
    if [ -d "${REPO_ROOT}/vendor" ] && (cd "$REPO_ROOT" && "$COMPOSER_BIN" install --dry-run --no-interaction 2>/dev/null | grep -qE "Nothing to install"); then
        say "vendor/: already present and in sync"; return 0
    fi
    say "composer install from committed composer.lock (no update)"
    ( cd "$REPO_ROOT" && "$COMPOSER_BIN" install --no-interaction --prefer-dist ) || { note_failed "composer-install"; return 1; }
    say "vendor/: installed"
    return 0
}

# libpq 5.18 (+ headers) at ${TH_ROOT}/pgsql — prerequisite for the PHP build.
# The npm package bundles libpq.so.5.18 (REL_16_4-era ABI) but ships NO headers;
# the matching headers come from the canonical postgres/postgres tag tarball.
install_libpq() {
    local native="${PG_NPM_DIR}/native"
    if [ -f "${TH_ROOT}/pgsql/lib/libpq.so.5.18" ] && [ -f "${TH_ROOT}/pgsql/include/libpq-fe.h" ]; then
        say "libpq: OK (5.18 + ${POSTGRES_HEADERS_TAG} headers at ${TH_ROOT}/pgsql)"
        return 0
    fi
    if [ ! -x "${native}/bin/postgres" ]; then
        say "Installing ${PG_NPM_PACKAGE} from npm registry (for libpq)"
        mkdir -p "${TH_ROOT}/pg-npm"
        ( cd "${TH_ROOT}/pg-npm" && npm install --no-audit --no-fund --silent "${PG_NPM_PACKAGE}" ) \
            || { note_failed "pg-npm-libpq"; return 1; }
    fi
    mkdir -p "${TH_ROOT}/pgsql/lib" "${TH_ROOT}/pgsql/include/libpq"
    cp -P "${native}/lib/libpq.so" "${native}/lib/libpq.so.5" "${native}/lib/libpq.so.5.18" \
        "${TH_ROOT}/pgsql/lib/" || { note_failed "libpq-copy"; return 1; }
    local hdr_tgz="${SRC_DIR}/pgsql-headers-${POSTGRES_HEADERS_TAG}.tgz"
    local hdr_root="${SRC_DIR}/postgres-${POSTGRES_HEADERS_TAG}/src"
    if [ ! -f "${SRC_DIR}/postgres-${POSTGRES_HEADERS_TAG}/.p02-headers-extracted" ]; then
        [ -s "$hdr_tgz" ] || download "https://codeload.github.com/postgres/postgres/tar.gz/${POSTGRES_HEADERS_TAG}" "$hdr_tgz" \
            || { note_failed "pg-headers-download"; return 1; }
        tar -xzf "$hdr_tgz" -C "${SRC_DIR}" \
            "postgres-${POSTGRES_HEADERS_TAG}/src/interfaces/libpq/libpq-fe.h" \
            "postgres-${POSTGRES_HEADERS_TAG}/src/interfaces/libpq/libpq-events.h" \
            "postgres-${POSTGRES_HEADERS_TAG}/src/include/libpq/libpq-fs.h" \
            "postgres-${POSTGRES_HEADERS_TAG}/src/include/postgres_ext.h" \
            "postgres-${POSTGRES_HEADERS_TAG}/src/include/pg_config_ext.h.in" \
            || { note_failed "pg-headers-extract"; return 1; }
        touch "${SRC_DIR}/postgres-${POSTGRES_HEADERS_TAG}/.p02-headers-extracted"
    fi
    cp "${hdr_root}/interfaces/libpq/libpq-fe.h" "${hdr_root}/interfaces/libpq/libpq-events.h" "${TH_ROOT}/pgsql/include/"
    cp "${hdr_root}/include/libpq/libpq-fs.h" "${TH_ROOT}/pgsql/include/libpq/"
    cp "${hdr_root}/include/postgres_ext.h" "${TH_ROOT}/pgsql/include/"
    sed -e 's/^#undef PG_INT64_TYPE/#define PG_INT64_TYPE long long int/' \
        "${hdr_root}/include/pg_config_ext.h.in" > "${TH_ROOT}/pgsql/include/pg_config_ext.h"
    say "libpq: installed (5.18 + ${POSTGRES_HEADERS_TAG} headers at ${TH_ROOT}/pgsql)"
    return 0
}

# psql / createdb / pg_isready client tools. The npm package ships ONLY
# initdb/pg_ctl/postgres and the base image has no postgresql-client (apt is
# unreachable), so these deterministic shims implement the exact client
# behaviors this script needs, over the recorded environment's own PHP 8.2.27
# + pdo_pgsql stack (bundled libpq 5.18).
install_pg_clients() {
    if [ -x "${TH_ROOT}/pgdev/bin/psql" ] && [ -x "${TH_ROOT}/pgdev/bin/createdb" ] \
       && [ -x "${TH_ROOT}/pgdev/bin/pg_isready" ] && [ -f "${TH_ROOT}/pgdev/lib/p02-pg-shim.php" ]; then
        say "PostgreSQL client tools: OK (psql/createdb/pg_isready)"
        return 0
    fi
    mkdir -p "${TH_ROOT}/pgdev/bin" "${TH_ROOT}/pgdev/lib"
    cat > "${TH_ROOT}/pgdev/lib/p02-pg-shim.php" <<'P02SHIM'
<?php
/**
 * P02 environment — PostgreSQL client tool shims (psql / createdb / pg_isready).
 * Implements the exact invocation modes used by P02-environment-recovery.sh:
 *   psql       -h H -p P -U U -l -q -t | -c "SQL" [dbname]
 *   createdb   -h H -p P -U U dbname
 *   pg_isready -h H -p P -q
 */

$mode = $_SERVER['argv'][1] ?? '';
$args = array_slice($_SERVER['argv'], 2);

$host   = getenv('PGHOST') ?: '127.0.0.1';
$port   = getenv('PGPORT') ?: '5432';
$user   = getenv('PGUSER') ?: 'postgres';
$pass   = getenv('PGPASSWORD') ?: '';
$dbname = null;
$list = false; $tuples = false; $quiet = false; $cmd = null;

$valueFlags = ['h' => 'host', 'p' => 'port', 'U' => 'user', 'd' => 'dbname'];
for ($i = 0; $i < count($args); $i++) {
    $a = $args[$i];
    if ($a === '--list') { $list = true; continue; }
    if ($a === '--tuples-only') { $tuples = true; continue; }
    if ($a === '--quiet') { $quiet = true; continue; }
    if ($a === '--command') { $cmd = $args[++$i] ?? null; continue; }
    if ($a === '-w' || $a === '--no-password') { continue; }
    if ($a !== '' && $a[0] === '-' && $a !== '-' && $a[1] !== '-') {
        $rest = substr($a, 1);
        while ($rest !== '') {
            $c = $rest[0];
            $rest = substr($rest, 1);
            if (isset($valueFlags[$c])) {
                $val = ($rest !== '') ? $rest : ($args[++$i] ?? '');
                ${$valueFlags[$c]} = $val;
                $rest = '';
            } elseif ($c === 'l') { $list = true; }
            elseif ($c === 't') { $tuples = true; }
            elseif ($c === 'q') { $quiet = true; }
            /* other flags ignored */
        }
        continue;
    }
    $dbname = $a; // positional database name
}

function pg_connect_pdo(string $db, string $host, string $port, string $user, string $pass): PDO {
    $dsn = "pgsql:host={$host};port={$port};dbname={$db};user={$user}";
    if ($pass !== '') {
        $dsn .= ";password={$pass}";
    }
    $dsn .= ';connect_timeout=5';
    return new PDO($dsn, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

try {
    if ($mode === 'pg_isready') {
        $sock = @fsockopen($host, (int) $port, $errno, $errstr, 3);
        if ($sock !== false) {
            fclose($sock);
            if (!$quiet) {
                echo "{$host}:{$port} - accepting connections", PHP_EOL;
            }
            exit(0);
        }
        if (!$quiet) {
            echo "no response", PHP_EOL;
        }
        exit(2);
    }

    if ($mode === 'createdb') {
        if ($dbname === null) {
            fwrite(STDERR, "createdb: database name required\n");
            exit(1);
        }
        $pdo = pg_connect_pdo('postgres', $host, $port, $user, $pass);
        $safe = '"' . str_replace('"', '""', $dbname) . '"';
        $pdo->exec("CREATE DATABASE {$safe}");
        echo "CREATE DATABASE", PHP_EOL;
        exit(0);
    }

    if ($mode === 'psql') {
        if ($list) {
            $pdo = pg_connect_pdo('postgres', $host, $port, $user, $pass);
            $rows = $pdo
                ->query("SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datallowconn ORDER BY 1")
                ->fetchAll(PDO::FETCH_NUM);
            if (!$tuples) {
                echo "       List of databases", PHP_EOL;
                echo "   Name    |  Owner   | Encoding", PHP_EOL;
            }
            foreach ($rows as $r) {
                // Field layout matches psql -l closely enough for `cut -d'|' -f1`.
                echo " {$r[0]} | {$r[1]} | UTF8 | C | C | ", PHP_EOL;
            }
            exit(0);
        }
        if ($cmd !== null) {
            $pdo = pg_connect_pdo($dbname ?? $user, $host, $port, $user, $pass);
            $st = $pdo->query($cmd);
            if ($st && $st->columnCount() > 0) {
                while ($row = $st->fetch(PDO::FETCH_NUM)) {
                    echo implode("\t", $row), PHP_EOL;
                }
            }
            exit(0);
        }
        fwrite(STDERR, "psql-shim: only -l/-t/-q/-c modes are supported\n");
        exit(1);
    }

    fwrite(STDERR, "p02-pg-shim: unknown mode '{$mode}'\n");
    exit(1);
} catch (Throwable $e) {
    fwrite(STDERR, $mode . ': ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
P02SHIM
    local tool
    for tool in psql createdb pg_isready; do
        cat > "${TH_ROOT}/pgdev/bin/${tool}" <<P02WRAP
#!/usr/bin/env bash
# P02 client-tool shim: dispatches to p02-pg-shim.php (PHP 8.2.27 + pdo_pgsql).
TH=${TH_ROOT}
export LD_LIBRARY_PATH="\$TH/lib:\$TH/pgsql/lib:\$TH/pg-npm/node_modules/@embedded-postgres/linux-x64/native/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "\$TH/php/bin/php" "\$TH/pgdev/lib/p02-pg-shim.php" ${tool} "\$@"
P02WRAP
        chmod +x "${TH_ROOT}/pgdev/bin/${tool}"
    done
    say "PostgreSQL client tools: installed (psql/createdb/pg_isready over pdo_pgsql)"
    return 0
}

install_postgres() {
    local native="${TH_ROOT}/pg-npm/node_modules/@embedded-postgres/linux-x64/native"
    if [ -x "$native/bin/postgres" ]; then
        say "PostgreSQL binaries: already present"
    else
        say "Installing ${PG_NPM_PACKAGE} from npm registry"
        mkdir -p "${TH_ROOT}/pg-npm"
        ( cd "${TH_ROOT}/pg-npm" && npm install --no-audit --no-fund --silent "${PG_NPM_PACKAGE}" ) || { note_failed "pg-npm"; return 1; }
    fi
    local v
    v="$("$native/bin/postgres" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)"
    if [ "$v" != "$PG_VERSION_EXPECTED" ]; then
        warn "PostgreSQL binary version ${v:-unknown} != expected ${PG_VERSION_EXPECTED}"
        note_failed "postgres-version"
        return 1
    fi
    mkdir -p "${TH_ROOT}/pgdev/bin"
    ln -sf "$native/bin/initdb" "$native/bin/pg_ctl" "$native/bin/postgres" "${TH_ROOT}/pgdev/bin/" 2>/dev/null || {
        cp "$native/bin/initdb" "$native/bin/pg_ctl" "$native/bin/postgres" "${TH_ROOT}/pgdev/bin/"
    }
    install_pg_clients || { note_failed "pg-clients"; return 1; }
    if ! PGOPTIONS= psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c "select 1" >/dev/null 2>&1; then
        if [ ! -d "${PGSQL_DATA}" ]; then
            say "initdb at ${PGSQL_DATA}"
            "$native/bin/initdb" -D "${PGSQL_DATA}" -U "$PGUSER" --auth=trust --no-locale >/dev/null || { note_failed "initdb"; return 1; }
        fi
        say "Starting PostgreSQL (port ${PGPORT})"
        "$native/bin/pg_ctl" -D "${PGSQL_DATA}" -l "${TH_ROOT}/pg.log" -o "-p ${PGPORT} -k /tmp -h ${PGHOST}" start >/dev/null || { note_failed "pg-start"; return 1; }
        sleep 2
    fi
    say "PostgreSQL ${PG_VERSION_EXPECTED}: server OK"
    return 0
}

install_databases() {
    local db
    for db in toefl_house toefl_house_test; do
        if ! PGOPTIONS= PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -lqt 2>/dev/null | cut -d '|' -f1 | grep -qw "$db"; then
            say "Creating database ${db}"
            PGOPTIONS= PGPASSWORD="$PGPASSWORD" createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$db" || { note_failed "createdb-${db}"; return 1; }
        fi
    done
    say "Databases: OK"
    return 0
}

# -----------------------------------------------------------------------------
# Artifact-first recovery (rev 3)
# -----------------------------------------------------------------------------
p02_json() { # p02_json <json-file> <python-expr over d>  — manifest reader
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$1" "$2"
}

artifact_manifest_path() { # echo local manifest path or empty
    printf '%s\n' "${P02_ARTIFACT_DIR}/${P02_MANIFEST_NAME}"
}

ensure_th_root() { # one-time host prep (baseline §17); idempotent
    [ -d "${TH_ROOT}" ] && return 0
    if [ "${TH_ROOT}" = "/opt/th" ]; then
        mkdir -p /home/user/toolchain
        if [ ! -e /opt/th ]; then
            sudo ln -sfn /home/user/toolchain /opt/th 2>/dev/null \
                || die "cannot create /opt/th — run: sudo ln -sfn /home/user/toolchain /opt/th"
        fi
        return 0
    fi
    mkdir -p "${TH_ROOT}"
}

artifact_fetch_bundle() { # $1=file-name $2=sha256 -> echo local path on success, else return 1
    local name="$1"
    local sha="$2"
    local dest="${P02_ARTIFACT_DIR}/${name}"
    if [ -s "$dest" ] && echo "${sha}  ${dest}" | sha256sum -c - >/dev/null 2>&1; then
        printf '%s\n' "$dest"; return 0
    fi
    # remote fetch 1: plain https (release download URL) — works wherever
    # release-assets.githubusercontent.com is not firewalled
    mkdir -p "${P02_ARTIFACT_DIR}"
    if curl -fL --retry 3 --connect-timeout 20 -o "${dest}.download" \
            "${P02_ARTIFACT_BASE_URL}/${name}" 2>/dev/null \
       && echo "${sha}  ${dest}.download" | sha256sum -c - >/dev/null 2>&1; then
        mv "${dest}.download" "$dest"; printf '%s\n' "$dest"; return 0
    fi
    rm -f "${dest}.download"
    # remote fetch 2: authenticated gh release download (same bytes; some
    # egress paths allow the authenticated route where anonymous is blocked)
    if command -v gh >/dev/null 2>&1 \
       && gh release download "${P02_ARTIFACT_TAG}" -R "${P02_ARTIFACT_REPO}" \
              -p "${name}" -O "${dest}.download" --clobber >/dev/null 2>&1 \
       && echo "${sha}  ${dest}.download" | sha256sum -c - >/dev/null 2>&1; then
        mv "${dest}.download" "$dest"; printf '%s\n' "$dest"; return 0
    fi
    rm -f "${dest}.download"
    return 1
}

restore_from_artifacts() {
    # Non-fatal by design: any failure returns 1 and --recover continues with
    # the source-build chain (fallback) for whatever is still missing.
    local manifest tc_sha v_sha lock_sha mver
    manifest="${P02_ARTIFACT_MANIFEST:-}"
    if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then
        manifest="$(artifact_manifest_path)"
        # not cached locally? try the remote release: anonymous https first,
        # then authenticated gh release download
        if [ ! -f "$manifest" ] && [ -n "${P02_ARTIFACT_BASE_URL}" ]; then
            mkdir -p "${P02_ARTIFACT_DIR}"
            if curl -fsL --retry 2 --connect-timeout 20 -o "${manifest}.download" \
                "${P02_ARTIFACT_BASE_URL}/${P02_MANIFEST_NAME}" 2>/dev/null; then
                mv "${manifest}.download" "$manifest"
            else
                rm -f "${manifest}.download"
                command -v gh >/dev/null 2>&1 \
                    && gh release download "${P02_ARTIFACT_TAG}" -R "${P02_ARTIFACT_REPO}" \
                           -p "${P02_MANIFEST_NAME}" -O "${manifest}" --clobber >/dev/null 2>&1 || true
            fi
        fi
    fi
    [ -f "$manifest" ] || { say "Artifacts: no manifest found (cache: ${P02_ARTIFACT_DIR}; remote tag: ${P02_ARTIFACT_TAG})"; return 1; }
    say "Artifacts: manifest found ($(p02_json "$manifest" 'd["id"]'))"

    # Manifest must describe exactly the pinned environment.
    mver="$(p02_json "$manifest" 'd.get("versions",{}).get("php","")')"
    [ "$mver" = "${PHP_VERSION}" ] || { warn "Artifacts: php ${mver:-?} != pinned ${PHP_VERSION}; ignoring artifacts"; return 1; }
    mver="$(p02_json "$manifest" 'd.get("versions",{}).get("composer","")')"
    [ "$mver" = "${COMPOSER_VERSION}" ] || { warn "Artifacts: composer ${mver:-?} != pinned ${COMPOSER_VERSION}; ignoring artifacts"; return 1; }
    mver="$(p02_json "$manifest" 'd.get("versions",{}).get("postgres","")')"
    [ "$mver" = "${PG_VERSION_EXPECTED}" ] || { warn "Artifacts: postgres ${mver:-?} != pinned ${PG_VERSION_EXPECTED}; ignoring artifacts"; return 1; }

    tc_sha="$(p02_json "$manifest" 'd["bundles"]["toolchain"]["sha256"]')"
    v_sha="$(p02_json "$manifest" 'd["bundles"]["vendor"]["sha256"]')"
    lock_sha="$(p02_json "$manifest" 'd.get("composer_lock_sha256","")')"

    # Toolchain bundle -> ${TH_ROOT}
    local tc
    tc="$(artifact_fetch_bundle "${P02_TOOLCHAIN_BUNDLE}" "$tc_sha")" || { warn "Artifacts: toolchain bundle unavailable"; return 1; }
    if [ ! -d "${TH_ROOT}" ] && [ "${TH_ROOT}" = "/opt/th" ]; then
        # one-time host prep (baseline §17)
        mkdir -p /home/user/toolchain && sudo ln -sfn /home/user/toolchain /opt/th 2>/dev/null \
            || { warn "Artifacts: create /opt/th symlink manually (baseline §17)"; return 1; }
    fi
    mkdir -p "${TH_ROOT}"
    say "Extracting ${P02_TOOLCHAIN_BUNDLE} -> ${TH_ROOT}"
    tar -xzf "$tc" -C "${TH_ROOT}" || { warn "Artifacts: toolchain extraction failed"; return 1; }
    [ -x "${PHP_BIN}" ] || { warn "Artifacts: ${PHP_BIN} missing after extraction"; return 1; }
    say "Artifacts: toolchain restored (PHP ${PHP_VERSION}, Composer ${COMPOSER_VERSION}, PG ${PG_VERSION_EXPECTED})"

    # Vendor bundle -> only when the repo composer.lock is the one bundled
    local actual_lock
    actual_lock="$(sha256sum "${REPO_ROOT}/composer.lock" 2>/dev/null | awk '{print $1}')"
    if [ -n "$lock_sha" ] && [ "$actual_lock" = "$lock_sha" ]; then
        local v
        v="$(artifact_fetch_bundle "${P02_VENDOR_BUNDLE}" "$v_sha")" || { warn "Artifacts: vendor bundle unavailable (composer install will run instead)"; return 0; }
        say "Extracting ${P02_VENDOR_BUNDLE} -> ${REPO_ROOT}/vendor"
        tar -xzf "$v" -C "${REPO_ROOT}" || { warn "Artifacts: vendor extraction failed (composer install will run instead)"; rm -rf "${REPO_ROOT}/vendor"; return 0; }
    else
        say "Artifacts: composer.lock differs from manifest — skipping vendor bundle (composer install from lock will run)"
    fi
    return 0
}

bundle_create() { # $1=output dir
    local outdir="${1:-${P02_ARTIFACT_DIR}}"
    mkdir -p "$outdir"
    [ -x "${PHP_BIN}" ] || die "--bundle requires the built environment (PHP at ${PHP_BIN} missing)."
    [ -d "${REPO_ROOT}/vendor" ] || die "--bundle requires vendor/ present at ${REPO_ROOT}."

    say "Bundling toolchain -> ${outdir}/${P02_TOOLCHAIN_BUNDLE} (excludes: src build trees, pgdata, composer-home, .git)"
    tar -C "${TH_ROOT}" --exclude-vcs \
        -czf "${outdir}/${P02_TOOLCHAIN_BUNDLE}" \
        php lib lib64 include share bin tools pgdev pgsql dev pg-npm \
        src/composer-2.10.2 || die "toolchain bundling failed"
    say "Bundling vendor -> ${outdir}/${P02_VENDOR_BUNDLE}"
    tar -C "${REPO_ROOT}" -czf "${outdir}/${P02_VENDOR_BUNDLE}" vendor || die "vendor bundling failed"

    local tc_sha v_sha lock_sha tc_bytes v_bytes
    tc_sha="$(sha256sum "${outdir}/${P02_TOOLCHAIN_BUNDLE}" | awk '{print $1}')"
    v_sha="$(sha256sum "${outdir}/${P02_VENDOR_BUNDLE}" | awk '{print $1}')"
    lock_sha="$(sha256sum "${REPO_ROOT}/composer.lock" | awk '{print $1}')"
    tc_bytes="$(stat -c%s "${outdir}/${P02_TOOLCHAIN_BUNDLE}")"
    v_bytes="$(stat -c%s "${outdir}/${P02_VENDOR_BUNDLE}")"

    python3 - "$outdir" "$tc_sha" "$v_sha" "$lock_sha" "$tc_bytes" "$v_bytes" <<'PYEOF' || die "manifest generation failed"
import json, sys, datetime
outdir, tc_sha, v_sha, lock_sha, tc_bytes, v_bytes = sys.argv[1:7]
manifest = {
    "id": "p02-artifacts-1",
    "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "generator": "P02-environment-recovery.sh rev 3 --bundle",
    "versions": {
        "php": "8.2.27", "composer": "2.10.2", "postgres": "18.4",
        "pg_npm": "@embedded-postgres/linux-x64@18.4.0-beta.17", "libpq": "5.18",
    },
    "composer_lock_sha256": lock_sha,
    "bundles": {
        "toolchain": {
            "file": "p02-toolchain-1.tar.gz", "sha256": tc_sha, "bytes": int(tc_bytes),
            "contents": "php/ lib/ lib64/ include/ share/ bin/ tools/ pgdev/ pgsql/ dev/ pg-npm/ src/composer-2.10.2 (no build trees, no pgdata, no caches, no .git)",
        },
        "vendor": {
            "file": "p02-vendor-1.tar.gz", "sha256": v_sha, "bytes": int(v_bytes),
            "contents": "repo vendor/ tree matching composer_lock_sha256",
        },
    },
}
with open(f"{outdir}/p02-manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(json.dumps({k: manifest[k] for k in ("id", "created")}))
PYEOF
    say "Manifest: ${outdir}/${P02_MANIFEST_NAME}"
    say "Bundles complete — restore with: $0 --recover   (artifacts at ${outdir})"
    say "Publish when ready:  $0 --publish ${outdir}"
    return 0
}

bundle_publish() { # $1=bundle dir
    local outdir="${1:-${P02_ARTIFACT_DIR}}"
    [ -f "${outdir}/${P02_MANIFEST_NAME}" ] || die "--publish: ${outdir}/${P02_MANIFEST_NAME} not found (run --bundle first)."
    command -v gh >/dev/null 2>&1 || die "--publish requires the gh CLI (authenticated)."
    say "Publishing artifacts to release ${P02_ARTIFACT_TAG} of ${P02_ARTIFACT_REPO}"
    if ! gh release view "${P02_ARTIFACT_TAG}" -R "${P02_ARTIFACT_REPO}" >/dev/null 2>&1; then
        # anchor the tag to the exact script commit that produced the artifacts
        local target
        target="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo)"
        gh release create "${P02_ARTIFACT_TAG}" -R "${P02_ARTIFACT_REPO}" \
            ${target:+--target "$target"} \
            --title "P02 environment artifacts (${P02_ARTIFACT_ID})" \
            --notes "Checksummed prebuilt toolchain + vendor bundles for docs/environment/P02-environment-recovery.sh. See p02-manifest.json." \
            || die "gh release create failed"
    fi
    gh release upload "${P02_ARTIFACT_TAG}" -R "${P02_ARTIFACT_REPO}" --clobber \
        "${outdir}/${P02_MANIFEST_NAME}" \
        "${outdir}/${P02_TOOLCHAIN_BUNDLE}" \
        "${outdir}/${P02_VENDOR_BUNDLE}" \
        || die "gh release upload failed"
    say "Published: ${P02_ARTIFACT_BASE_URL}/${P02_MANIFEST_NAME}"
    return 0
}

# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
mode="${1:---verify}"
case "$mode" in
    --verify|"")
        verify_all
        rc=$?
        exit "$rc"
        ;;
    --recover)
        say "=== P02 environment recovery (artifacts first, source build as fallback) ==="
        # 1. Verify first — reuse whatever is present.
        set +e
        verify_all
        local_rc=$?
        set -e
        if [ "$local_rc" -eq 0 ]; then
            say "Environment already valid — nothing to recover."
            exit 0
        fi
        # 2. One-time host prep (creates the /opt/th symlink if missing), then
        #    artifact-first restore of prebuilt bundles when available (rev 3).
        #    Non-fatal — on any failure the source-build chain below remains
        #    the fallback and only repairs what is actually missing.
        ensure_th_root
        if restore_from_artifacts; then
            say "=== artifacts restored; continuing with component checks ==="
        else
            say "=== no usable artifacts; falling back to source build ==="
        fi
        # 3. Repair missing components in dependency order (source build only
        #    for components the artifact restore could not provide).
        check_php >/dev/null 2>&1 || install_php || die "PHP recovery failed."
        check_composer >/dev/null 2>&1 || bootstrap_composer || die "Composer recovery failed."
        check_vendor >/dev/null 2>&1 || install_vendor || die "vendor/ recovery failed."
        check_postgres >/dev/null 2>&1 || install_postgres || die "PostgreSQL recovery failed."
        check_databases >/dev/null 2>&1 || install_databases || die "Database recovery failed."
        # 4. Re-verify everything.
        say "=== re-verification after recovery ==="
        verify_all
        rc=$?
        if [ "$rc" -eq 0 ]; then
            say "RECOVERY COMPLETE — environment valid."
            exit 0
        fi
        die "Recovery incomplete — see missing components above. Do NOT rediscover; consult docs/environment/P02-environment-baseline.md."
        ;;
    --bundle)
        bundle_create "${2:-}"
        exit $?
        ;;
    --publish)
        bundle_publish "${2:-}"
        exit $?
        ;;
    --help|-h)
        sed -n '2,31p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown option: $mode (use --verify, --recover, --bundle, --publish, or --help)" >&2
        exit 2
        ;;
esac
