# The TOEFL House — Production Deployment

This is the single authoritative document for deploying and operating **The
TOEFL House** in production. It reflects the actual repository — no
infrastructure is documented that the application does not use, and no
environment is invented. Where a target-server detail is provider-specific,
the exact value to supply is called out as a `TODO`.

## 1. Runtime requirements

| Component | Requirement | Verified with |
|---|---|---|
| PHP | 8.2.x (CLI + FPM) with `pdo_pgsql`/`pgsql`, `mbstring`, `openssl`, `bcmath`, `intl`, `xml` | 8.2.27 |
| PostgreSQL | 13 or newer (standard SQL; no extension dependencies) | 18.4 |
| Web server | nginx (TLS termination) + PHP-FPM | nginx 1.x / php8.2-fpm |
| OS | Any Linux that ships the above (Debian/Ubuntu reference) | — |

There is **no** Node.js/frontend build (the interface is server-rendered
Blade), **no** Redis, **no** message broker, and **no** separate worker or
scheduler process — see §9/§10.

## 2. Required environment variables

The live `.env` is created from `.env.example` and stored persistently at
`$DEPLOY_ROOT/.env` (never in the repository). `deploy/deploy.sh` copies it
into each release and **aborts** unless both hold:

```
APP_ENV=production
APP_DEBUG=false
```

Required values (from `.env.example`): `APP_NAME`, `APP_KEY`
(`php artisan key:generate`), `APP_URL`, `LOG_CHANNEL`/`LOG_LEVEL`,
`SESSION_DRIVER=database`, `SESSION_SECURE_COOKIE=true`, `SESSION_SAME_SITE`,
`CACHE_STORE=database` (the login rate limiter must be durable across FPM
workers), `QUEUE_CONNECTION=sync`, and the `DB_*` PostgreSQL connection.
Secrets (`APP_KEY`, `DB_PASSWORD`) are set only in the live `.env`, never
committed.

## 3. PostgreSQL configuration

Create one database for the application (and one for the test suite, if you
run tests on the server):

```sql
CREATE DATABASE toefl_house;
```

Point `DB_*` in the `.env` at it. The app issues only standard DDL/DML; no
extensions, no special `postgresql.conf` settings are required. Keep the
database on the same host (or a trusted private network); set
`DB_SSLMODE=require` or `verify-full` if it is remote. Timezone: the app uses
UTC storage and renders per the `APP_LOCALE`/browser; no server tz change is
needed.

## 4. Installing the application

The deployment is file-based (releases + a `current` symlink):

```
/var/www/toefl-house/
├── .env                  # persistent, created from .env.example (NOT in git)
├── releases/<timestamp>/ # one immutable checkout per deployment
└── current -> releases/<live-timestamp>
```

nginx serves **only** `current/public` (see §11). The project root —
`app/`, `config/`, `.env`, `database/`, `storage/`, `.git` — is never
reachable over HTTP.

## 5. Installing dependencies

`deploy/deploy.sh` runs, per release:

```
composer install --no-dev --no-interaction --prefer-dist \
    --no-progress --optimize-autoloader
```

The committed `composer.lock` is authoritative (no `composer update`). PHP
and Composer are installed once on the host (standard package manager or the
repository's `docs/environment` recovery procedure for a from-scratch build).

## 6. Frontend build

**None.** The employee console is server-rendered Blade; there is no
`package.json`, no Vite, and no build step. `artisan view:cache` compiles the
Blade templates (see §8) — that is the entire "frontend build".

## 7. Deploying migrations

`deploy/deploy.sh` runs `php artisan migrate --force` **before** the release
go live, so a failing migration aborts the deployment and the previous release
stays live. Migrations are **forward-only and never destructive** as part of
normal deployment — the app never drops or rewrites business tables in a
deploy (see `database/migrations`, 100 migrations).

## 8. Generating caches

After migrating, `deploy/deploy.sh` runs the Laravel production optimization:

```
php artisan config:cache
php artisan route:cache
php artisan view:cache
```

(These are equivalent to `php artisan optimize` for this app, which has no
event cache. Re-run them — or simply redeploy — after any code/config change;
a cached config is a snapshot and must not be stale.)

## 9. Workers

**Not required.** `QUEUE_CONNECTION=sync`; the application dispatches no
queued jobs. There is no `queue:work` process to start or supervise. The
Integrations module (self-contained, not exposed on the production HTTP
surface) has its own command-driven job model; if an operator later enables
integrations they would add an explicit trigger — that is out of scope for the
current deployment and is intentionally not invented here.

## 10. Scheduler

**Not required.** `routes/console.php` registers no scheduled tasks. The core
business workflows are request-driven. There is no `schedule:work`/cron to
configure for the current system.

## 11. HTTPS / web server

TLS is terminated at nginx (`deploy/nginx/toefl-house.conf`):

- HTTP → HTTPS 301 redirect.
- `ssl_protocols TLSv1.2 TLSv1.3`; replace the certificate paths with your
  CA-issued (e.g. Let's Encrypt) files — a `TODO` in the file.
- `root …/current/public` — **only** `public/` is served.
- Security headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`) set at the edge; the app sets the
  same headers (`app/Http/Middleware/SecurityHeaders.php`).
- `SESSION_SECURE_COOKIE=true` makes the session cookie HTTPS-only.

PHP-FPM pool: `deploy/php-fpm.conf` (dynamic `pm`, opcache, slowlog).

## 12. Health checks

Two public probes:

- `GET /up` — framework **liveness** (app boots).
- `GET /health` — **readiness**: verifies the database is reachable and the
  application key is set; returns `200 {"status":"ok",...}` when healthy,
  `503` when a critical dependency is down. The body never leaks secrets or
  connection details.

Point your orchestrator (systemd `ExecStartPost`, a load balancer, or a
deploy script) at `/health`. `deploy/deploy.sh` itself polls `/health` after
switching the live release.

## 13. Backup

`deploy/backup.sh` takes a compressed `pg_dump` (custom format) of the
application database, verifies it (`pg_restore --list`), and applies a
retention window. Recommendation: run **nightly** via cron:

```
0 2 * * * /path/to/deploy/backup.sh
```

Backups land in `BACKUP_DIR` (default `/var/backups/toefl-house`), optionally
encrypted with `age` when `AGE_KEYRECIPIENT` is set. **Recovery point
objective (RPO): the last nightly backup.** Ship the dumps off-host
(object storage) for durability beyond the server's disk.

## 14. Restore

`deploy/restore.sh <backup-file> --confirm` (or `--latest --confirm`) restores
the database from a backup. It refuses to run without the explicit `--confirm`,
verifies the dump's integrity **before** touching the live database, restores
with `pg_restore --clean --if-exists --create`, and reports post-restore
verification. **A backup is only considered verified once this procedure has
been exercised successfully in a recovery drill.**

## 15. Rollback

Because the deployment uses releases + an atomic `current` symlink, rollback
is a pointer change, not a rebuild:

```
./deploy/deploy.sh --rollback
```

restores the previous release and reloads the services. Schema note: roll back
to a release whose migrations are a subset of the live schema; if the failed
release introduced a migration, coordinate the data rollback with the schema
(never run destructive `migrate:rollback` as part of a normal recovery).

## 16. Deploying a new release

```
./deploy/deploy.sh <git-ref>      # branch, tag, or commit SHA
```

Steps (all-or-nothing per release; the live symlink only switches after a
green health check):

1. Fresh checkout of `<git-ref>` into `releases/<timestamp>`.
2. `composer install --no-dev --optimize-autoloader`.
3. Copy the persistent `.env`; enforce `APP_ENV=production`, `APP_DEBUG=false`.
4. `php artisan migrate --force` (forward-only).
5. Ensure runtime dirs exist and are owned by the web user.
6. `config:cache` + `route:cache` + `view:cache`.
7. Switch `current` → new release; reload FPM + nginx.
8. Poll `GET /health` until 200 (or auto-rollback).

Older releases are pruned to the last three.

## 17. Recovering a failed deployment

- **Health check fails during deploy:** `deploy.sh` automatically rolls the
  `current` symlink back to the previous release, reloads services, and exits
  non-zero. The failed release is preserved on disk for forensics. The previous
  (known-good) release is live — the system is never left in an unknown state.
- **A release that is live but misbehaves:** `./deploy/deploy.sh --rollback`,
  or redeploy the last known-good ref.
- **Data corruption / bad migration:** take a fresh backup of the bad state
  (for forensics), then `deploy/restore.sh <good-backup> --confirm`, verify,
  and re-run `php artisan migrate --force` if the live schema is newer.
- **Crash / host failure:** provision a new host, restore the latest backup
  (§14), redeploy the last known-good ref (§16), and repoint DNS.

## Verification gate (run after any change)

Before declaring a deployment healthy, the full gate must be green:

```
php artisan migrate:fresh --seed:off   # clean 100-migration build
vendor/bin/phpunit                     # full feature suite
vendor/bin/phpstan analyse             # static analysis
vendor/bin/pint --test                 # formatting
# then, on the live host:
curl -fsS https://<host>/health        # expect 200 {"status":"ok",...}
```

A deployment is production-ready only when these pass against the exact
commit being released.
