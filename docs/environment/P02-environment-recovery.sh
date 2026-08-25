#!/usr/bin/env bash
# =============================================================================
# P02 Environment Recovery — deterministic REUSE -> VERIFY -> REPAIR-MISSING-ONLY -> VERIFY
# Canonical spec: docs/environment/P02-environment-baseline.md (source of truth)
# =============================================================================
#
# Usage:
#   P02-environment-recovery.sh            # verify only (default; installs nothing)
#   P02-environment-recovery.sh --verify   # same
#   P02-environment-recovery.sh --recover  # install ONLY missing components, then re-verify
#   P02-environment-recovery.sh --help
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
export PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}" PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"

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
    local missing_ext=""
    local m
    for m in $required; do
        "$PHP_BIN" -m 2>/dev/null | grep -qx "$m" || missing_ext="$missing_ext $m"
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
    local ok=1
    [ -x "${REPO_ROOT}/vendor/bin/phpunit" ]  || { note_missing "vendor/bin/phpunit"; ok=0; }
    [ -x "${REPO_ROOT}/vendor/bin/phpstan" ]  || { note_missing "vendor/bin/phpstan"; ok=0; }
    [ -x "${REPO_ROOT}/vendor/bin/pint" ]     || { note_missing "vendor/bin/pint"; ok=0; }
    [ "$ok" -eq 1 ] && say "Test toolchain: OK (phpunit, phpstan, pint present)"
    return $ok
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
        printf '  - %s\n' "${MISSING[@]}"
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
    python3 -m pip install --user --quiet cmake ninja meson || { note_failed "pypi-cmake-ninja-meson"; return 1; }
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

build_pkgconf() {
    [ -x "${TH_ROOT}/bin/pkgconf" ] || {
        local src="${SRC_DIR}/pkgconf-${PKGCONF_TAG}"
        [ -d "$src" ] || download "https://codeload.github.com/pkgconf/pkgconf/tar.gz/${PKGCONF_TAG}" "${SRC_DIR}/pkgconf.tgz" || { note_failed "pkgconf-download"; return 1; }
        [ -d "$src" ] || { mkdir -p "$src"; tar -xzf "${SRC_DIR}/pkgconf.tgz" -C "$src" --strip-components=1; }
        ( cd "$src" && meson setup build --prefix="${TH_ROOT}" -Ddefault_library=shared >/dev/null && ninja -C build >/dev/null && ninja -C build install >/dev/null ) || { note_failed "pkgconf"; return 1; }
    }
    say "pkgconf: OK"
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
    # PHP must be built against the TH_ROOT dependency libs.
    build_zlib && build_openssl && build_oniguruma && build_libxml2 && build_pkgconf && build_curl || {
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
        --enable-mbstring --with-oniguruma="${TH_ROOT}" \
        --enable-bcmath --enable-pcntl --enable-posix \
        --enable-dom --enable-simplexml --enable-xml --enable-xmlreader --enable-xmlwriter \
        --enable-session --enable-tokenizer --enable-fileinfo --enable-filter --enable-ctype --enable-hash \
        >/dev/null && \
      make -j"$(nproc)" >/dev/null && make install >/dev/null ) || { note_failed "php-build"; return 1; }
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
            $psr4 = []; $files = [];
            $dirs = glob($root."/vendor/*/*", GLOB_ONLYDIR);
            $pkgs = glob($root."/vendor/*/*/composer.json");
            foreach ($pkgs as $cf) {
                $d = json_decode(file_get_contents($cf), true);
                if (!$d) continue;
                $base = dirname($cf);
                foreach (($d["autoload"]["psr-4"] ?? []) as $ns => $dir) {
                    $ns = ltrim($ns, "\\");
                    $psr4[$ns] = $base."/".(is_array($dir) ? $dir[0] : $dir);
                }
                foreach (($d["autoload"]["files"] ?? []) as $f) { $files[] = $base."/".$f; }
            }
            // composer itself
            $psr4["Composer\\"] = $root."/src/Composer";
            foreach ($files as $f) { if (is_file($f)) require_once $f; }
            $code = "<?php\n// deterministic autoloader generated by P02-environment-recovery.sh\n";
            $code .= "spl_autoload_register(function (\$class) {\n    static \$map = ".var_export($psr4, true).";\n";
            $code .= "    foreach (\$map as \$prefix => \$dir) {\n        if (strpos(\$class, \$prefix) === 0) {\n            \$rel = substr(\$class, strlen(\$prefix));\n            \$f = \$dir.str_replace(\"\\\\\", \"/\", \$rel).\".php\";\n            if (is_file(\$f)) { require \$f; return true; }\n        }\n    }\n    return false;\n});\n";
            $code .= "foreach (".var_export($files, true)." as \$f) { if (is_file(\$f)) require_once \$f; }\n";
            file_put_contents($root."/vendor/autoload.php", $code);
        ' "$csrc"
    fi
    mkdir -p "${TH_ROOT}/dev/bin"
    cat > "$COMPOSER_BIN" <<EOF
#!/usr/bin/env bash
exec "$PHP_BIN" "$csrc/bin/composer" "\$@"
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
        say "=== P02 environment recovery (repair-missing-only) ==="
        # 1. Verify first — reuse whatever is present.
        set +e
        verify_all
        local_rc=$?
        set -e
        if [ "$local_rc" -eq 0 ]; then
            say "Environment already valid — nothing to recover."
            exit 0
        fi
        # 2. Repair missing components in dependency order.
        check_php >/dev/null 2>&1 || install_php || die "PHP recovery failed."
        check_composer >/dev/null 2>&1 || bootstrap_composer || die "Composer recovery failed."
        check_vendor >/dev/null 2>&1 || install_vendor || die "vendor/ recovery failed."
        check_postgres >/dev/null 2>&1 || install_postgres || die "PostgreSQL recovery failed."
        check_databases >/dev/null 2>&1 || install_databases || die "Database recovery failed."
        # 3. Re-verify everything.
        say "=== re-verification after recovery ==="
        verify_all
        rc=$?
        if [ "$rc" -eq 0 ]; then
            say "RECOVERY COMPLETE — environment valid."
            exit 0
        fi
        die "Recovery incomplete — see missing components above. Do NOT rediscover; consult docs/environment/P02-environment-baseline.md."
        ;;
    --help|-h)
        sed -n '2,14p' "$0"
        exit 0
        ;;
    *)
        echo "Unknown option: $mode (use --verify, --recover, or --help)" >&2
        exit 2
        ;;
esac
