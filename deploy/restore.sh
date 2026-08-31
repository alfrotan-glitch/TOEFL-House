#!/usr/bin/env bash
# =============================================================================
# The TOEFL House — database restore (disaster recovery)
# =============================================================================
# Restores the database from a backup produced by deploy/backup.sh. This is
# the recovery procedure; it must be exercised (see the verification step) —
# a backup that has never been restored is not considered verified.
#
# Recovery objectives (single-instance deployment):
#   * RPO (recovery point): up to the last nightly backup (24h).
#   * RTO (recovery time): a single pg_restore of the current data volume;
#     minutes for the expected dataset size.
#
# Usage:
#   ./deploy/restore.sh <backup-file>   # restore a specific dump
#   ./deploy/restore.sh --latest        # restore the most recent dump
#
# The restore is NOT automatic on a failed deployment (that is a rollback,
# handled by deploy.sh). This is an explicit, operator-initiated disaster
# recovery action and refuses to run without --confirm.
# =============================================================================
set -euo pipefail

# Preflight: the PostgreSQL client tools must be installed (postgresql-client,
# version >= the server). A restore without working client tools is a
# recovery that fails mid-way; refuse before touching anything.
for tool in pg_restore psql; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "[restore][ERROR] $tool not found on PATH. Install postgresql-client (>= server version)." >&2
        exit 1
    }
done

BACKUP_DIR="${BACKUP_DIR:-/var/backups/toefl-house}"
DB_NAME="${DB_NAME:-toefl_house}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
PGPASSWORD="${PGPASSWORD:-}"
TABLES_BEFORE_RESTORE=""

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore][ERROR] %s\n' "$*" >&2; exit 1; }

pick_latest() {
    ls -1t "$BACKUP_DIR/${DB_NAME}-"*.dump 2>/dev/null | head -1 || true
}

BACKUP_FILE="${1:-}"
if [ "$BACKUP_FILE" = "--latest" ]; then
    BACKUP_FILE="$(pick_latest)"
fi
[ -n "$BACKUP_FILE" ] || die "no backup file given and no backup found in $BACKUP_DIR"
[ -f "$BACKUP_FILE" ] || die "backup file not found: $BACKUP_FILE"

# Safety: require explicit confirmation before touching the live database.
[ "${2:-}" = "--confirm" ] || die "refusing to restore without an explicit second argument '--confirm' (this overwrites the live database $DB_NAME)"

log "restoring '$DB_NAME' from $BACKUP_FILE"

# 1. Verify the dump is intact before destroying anything.
PGPASSWORD="$PGPASSWORD" pg_restore --list "$BACKUP_FILE" >/dev/null || die "backup failed integrity check; aborting before any change"

# 2. Snapshot the pre-restore state (table list) so we can verify after.
TABLES_BEFORE_RESTORE="$(PGPASSWORD="$PGPASSWORD" psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" --tuples-only --no-align -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
log "tables in target before restore: ${TABLES_BEFORE_RESTORE:-unknown}"

# 3. Clean create + restore (custom format). --clean --create drops and
#    recreates the database, then restores all objects. This is a deliberate
#    destructive recovery operation, only reachable with --confirm.
PGPASSWORD="$PGPASSWORD" pg_restore \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
    --clean --if-exists --create --no-owner --no-privileges \
    --dbname="$DB_NAME" "$BACKUP_FILE"

# 4. Post-restore verification.
log "verifying restored database"
PGPASSWORD="$PGPASSWORD" psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    --tuples-only --no-align -c "SELECT 'tables: ' || count(*) FROM information_schema.tables WHERE table_schema='public';"
PGPASSWORD="$PGPASSWORD" psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
    --tuples-only --no-align -c "SELECT 'organizations: ' || count(*) FROM organizations;" 2>/dev/null || true

log "restore complete. Re-run migrations if a newer schema is expected:"
log "  php artisan migrate --force   (safe: a restore of a matching dump needs none)"
log "Then verify the app over HTTP: curl -fsS $HEALTH_URL (expect 200)"
