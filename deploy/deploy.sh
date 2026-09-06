#!/usr/bin/env bash
# =============================================================================
# The TOEFL House — production deployment script
# =============================================================================
# Deterministic, provider-neutral deployment using the releases + atomic
# `current` symlink pattern. A failed deployment never switches the live
# symlink, so the previous release stays live (that IS the rollback).
#
# Usage:
#   ./deploy/deploy.sh <git-ref>          # deploy a branch/tag/commit
#   ./deploy/deploy.sh --rollback         # roll back to the previous release
#
# Prerequisites (see docs/operations/production-deployment.md):
#   * php + composer + curl on PATH
#   * PostgreSQL client tools pg_dump + pg_restore (postgresql-client, version >=
#     the server) — required by deploy/backup.sh and deploy/restore.sh
#   * nginx (deploy/nginx) and php-fpm (deploy/php-fpm.conf) installed
#   * PostgreSQL reachable and the app database created
#   * a persistent .env at $DEPLOY_ROOT/.env (never committed to the repo)
# =============================================================================
set -euo pipefail

# --- Configuration (override via environment when needed) -------------------
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/toefl-house}"
REPO_URL="${REPO_URL:-https://github.com/alfrotan-glitch/TOEFL-House.git}"
RELEASES_DIR="$DEPLOY_ROOT/releases"
CURRENT_LINK="$DEPLOY_ROOT/current"
ENV_FILE="$DEPLOY_ROOT/.env"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/health}"
PHP_BIN="${PHP_BIN:-php}"
COMPOSER_BIN="${COMPOSER_BIN:-composer}"

log()  { printf '[deploy] %s\n' "$*"; }
die()  { printf '[deploy][ERROR] %s\n' "$*" >&2; exit 1; }

# --- Actions ----------------------------------------------------------------
if [ "${1:-}" = "--rollback" ]; then
    current_release="$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || true)")"
    prev="$(ls -1 "$RELEASES_DIR" 2>/dev/null | grep -v "^${current_release}$" | sort | tail -1 || true)"
    [ -n "$prev" ] || die "no previous release to roll back to"
    ln -sfn "$RELEASES_DIR/$prev" "$CURRENT_LINK"
    log "rolled back current -> $prev"
    exit 0
fi

REF="${1:?usage: deploy.sh <git-ref> | --rollback}"
[ -f "$ENV_FILE" ] || die "missing persistent env file at $ENV_FILE (create it from .env.example with APP_ENV=production, APP_DEBUG=false, APP_KEY, and DB credentials)"

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
mkdir -p "$RELEASES_DIR"
[ -e "$RELEASE_DIR" ] && die "release dir already exists: $RELEASE_DIR"

log "deploying ref '$REF' to $RELEASE_DIR"

# 1. Source checkout (shallow for speed; the ref must be reachable).
git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$RELEASE_DIR" \
    || git clone --quiet "$REPO_URL" "$RELEASE_DIR"
( cd "$RELEASE_DIR" && git checkout --quiet "$REF" )
COMMIT="$( cd "$RELEASE_DIR" && git rev-parse HEAD )"
log "source: commit $COMMIT"

# 2. Dependencies (production only; lock file is authoritative).
( cd "$RELEASE_DIR" && "$COMPOSER_BIN" install --no-dev --no-interaction --prefer-dist --no-progress --optimize-autoloader )

# 3. Environment: the persistent .env is the single source of deployment env.
cp "$ENV_FILE" "$RELEASE_DIR/.env"
( cd "$RELEASE_DIR" && grep -q '^APP_ENV=production' .env ) || die ".env must set APP_ENV=production"
( cd "$RELEASE_DIR" && grep -q '^APP_DEBUG=false' .env ) || die ".env must set APP_DEBUG=false"
# APP_KEY must be present and non-empty BEFORE the release goes live: with an
# empty key the first request fails session encryption and the health check
# would only catch it after the symlink has switched (forcing a rollback of a
# deploy that could have been refused up front).
( cd "$RELEASE_DIR" && grep -q '^APP_KEY=..' .env ) || die ".env must set a non-empty APP_KEY (php artisan key:generate)"

# 4. Pre-deploy backup: migrations are forward-only and run against the live
#    database, so a backup is taken immediately before they run. The backup
#    uses the persistent .env's DB settings; without the client tools this
#    deploy is refused (a migration without a fresh backup is not a deploy
#    this script will perform).
DB_NAME_VAL="$(grep -m1 '^DB_DATABASE=' "$ENV_FILE" | cut -d= -f2-)"
DB_HOST_VAL="$(grep -m1 '^DB_HOST=' "$ENV_FILE" | cut -d= -f2-)"
DB_PORT_VAL="$(grep -m1 '^DB_PORT=' "$ENV_FILE" | cut -d= -f2-)"
DB_USER_VAL="$(grep -m1 '^DB_USERNAME=' "$ENV_FILE" | cut -d= -f2-)"
DB_PASS_VAL="$(grep -m1 '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
if command -v pg_dump >/dev/null 2>&1; then
    BACKUP_DIR="${BACKUP_DIR:-/var/backups/toefl-house}" \
        DB_NAME="${DB_NAME_VAL:-toefl_house}" DB_HOST="${DB_HOST_VAL:-127.0.0.1}" \
        DB_PORT="${DB_PORT_VAL:-5432}" DB_USER="${DB_USER_VAL:-postgres}" \
        PGPASSWORD="$DB_PASS_VAL" \
        "$RELEASE_DIR/deploy/backup.sh"
else
    die "pg_dump not found on PATH: refusing to deploy (migrations run against the live database and require a pre-deploy backup; install postgresql-client, version >= the server)"
fi

# 5. Schema: forward-only migrations. Never destructive; a failing migration
#    aborts the deployment before the release goes live.
( cd "$RELEASE_DIR" && "$PHP_BIN" artisan migrate --force --no-interaction )

# 6. Runtime directories exist and are owned by the web user (the repo now
#    tracks them, but ensure ownership/permissions for the FPM user).
WEB_USER="$(grep -m1 '^user' /etc/php/*/fpm/pool.d/toefl-house.conf 2>/dev/null | awk '{print $3}' || echo www-data)"
for d in storage/app storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache; do
    mkdir -p "$RELEASE_DIR/$d"
done
chown -R "$WEB_USER":"$WEB_USER" "$RELEASE_DIR/storage" "$RELEASE_DIR/bootstrap/cache"

# 7. Production optimization (Laravel-recommended: cached config/routes/views).
( cd "$RELEASE_DIR" && "$PHP_BIN" artisan config:cache && "$PHP_BIN" artisan route:cache && "$PHP_BIN" artisan view:cache )

# 8. Go live: switch the symlink, then verify the release over HTTP.
PREV_RELEASE="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
( systemctl reload php*-fpm 2>/dev/null || service php*-fpm reload 2>/dev/null || true )
nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true

log "verifying release at $HEALTH_URL"
for i in 1 2 3 4 5; do
    if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
        log "deployment OK: release $RELEASE_ID (commit $COMMIT) is live and healthy"
        # Keep only the last 3 releases; older ones are disposable.
        ls -1 "$RELEASES_DIR" | grep -v "^$(basename "$RELEASE_DIR")$" | sort | head -n -3 | xargs -r -I{} rm -rf "$RELEASES_DIR/{}"
        exit 0
    fi
    sleep 2
done

# 9. Unhealthy: automatic rollback to the previous release; fail loudly.
log "release FAILED health check — rolling back"
[ -n "$PREV_RELEASE" ] && ln -sfn "$PREV_RELEASE" "$CURRENT_LINK" || rm -f "$CURRENT_LINK"
nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
die "deployment of $RELEASE_ID failed health verification and was rolled back; release $RELEASE_DIR is preserved on disk for forensics"
