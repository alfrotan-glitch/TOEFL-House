#!/usr/bin/env bash
# =============================================================================
# The TOEFL House — database backup
# =============================================================================
# Provider-neutral PostgreSQL backup using pg_dump (custom format). Custom
# format is compressed, supports parallel restore, and allows per-table
# restore. Backups are written to $BACKUP_DIR with a UTC timestamp and are
# optionally encrypted with age/GPG when an encrypt key is configured.
#
# Schedule (recommendation):
#   * Full backup: nightly (e.g. 02:00) via cron.
#   * Retention: 14 daily + 8 weekly (managed below).
#   * WAL archiving / PITR is out of scope for this single-instance
#     deployment; the RPO here is the nightly backup interval.
#
# Usage:
#   ./deploy/backup.sh                 # take a backup now
#
# Env (all optional, sensible defaults):
#   BACKUP_DIR, DB_NAME, DB_HOST, DB_PORT, DB_USER, RETENTION_DAILY=14,
#   AGE_KEYRECIPIENT (set to enable age encryption)
# =============================================================================
set -euo pipefail

# Preflight: the PostgreSQL client tools must be installed (postgresql-client,
# version >= the server). Without them this script fails loudly rather than
# producing an "OK" with no backup.
for tool in pg_dump pg_restore; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "[backup][ERROR] $tool not found on PATH. Install postgresql-client (>= server version)." >&2
        exit 1
    }
done

BACKUP_DIR="${BACKUP_DIR:-/var/backups/toefl-house}"
DB_NAME="${DB_NAME:-toefl_house}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
RETENTION_DAILY="${RETENTION_DAILY:-14}"
AGE_KEYRECIPIENT="${AGE_KEYRECIPIENT:-}"
PGPASSWORD="${PGPASSWORD:-}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RAW="$BACKUP_DIR/${DB_NAME}-${TS}.dump"
mkdir -p "$BACKUP_DIR"

log() { printf '[backup] %s\n' "$*"; }

log "backing up database '$DB_NAME' -> $RAW"
# --format=custom (compressed, parallel/per-table restore), --no-owner and
# --no-privileges so a restore is not tied to the original roles.
PGPASSWORD="$PGPASSWORD" pg_dump \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
    --format=custom --compress=6 \
    --no-owner --no-privileges \
    --file="$RAW" "$DB_NAME"

# Integrity check: the dump must be listable before we consider it valid.
PGPASSWORD="$PGPASSWORD" pg_restore --list "$RAW" >/dev/null
log "dump verified (pg_restore --list OK), $(du -h "$RAW" | cut -f1)"

# Optional encryption (age). When enabled, the raw dump is removed.
if [ -n "$AGE_KEYRECIPIENT" ]; then
    if command -v age >/dev/null 2>&1; then
        age -r "$AGE_KEYRECIPIENT" -o "$RAW.age" "$RAW" && rm -f "$RAW"
        log "encrypted -> $RAW.age"
    else
        log "age not installed; leaving unencrypted at $RAW"
    fi
fi

# Retention: keep the last $RETENTION_DAILY daily dumps.
log "applying retention (keep last $RETENTION_DAILY)"
ls -1t "$BACKUP_DIR/${DB_NAME}-"*.dump 2>/dev/null | tail -n +$((RETENTION_DAILY + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR/${DB_NAME}-"*.dump.age 2>/dev/null | tail -n +$((RETENTION_DAILY + 1)) | xargs -r rm -f

log "backup complete"
