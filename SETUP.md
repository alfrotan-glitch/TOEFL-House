# The TOEFL House — Windows One-Click Deployment (SETUP.md)

This folder turns a Windows desktop into a private TOEFL House server.
After a fresh clone, the entire setup is:

> **Clone the repository → double-click `START-TOEFL-HOUSE.bat` → the
> application is ready.**

No PowerShell, no Git commands, no Composer, no PHP, no PostgreSQL and no
manual database commands are needed at any point. The launcher does
everything itself and, if anything is ever missing, it **stops and tells
you exactly what** — it never fails silently.

```
Windows PC ──► PostgreSQL ──► Laravel ──► localhost ──► Tailscale Serve ──► your Tailnet
```

The application is **private to your Tailnet**. Tailscale **Serve** is the
mechanism; Tailscale **Funnel is never used** and nothing is exposed to the
public internet.

---

## Requirements (one-time)

| Requirement | Notes |
|---|---|
| Windows 10 (1803+) or Windows 11, 64-bit | The launcher verifies this and fails loudly otherwise |
| Internet connection for the **first** run | Downloads PHP 8.2.27, Composer and PostgreSQL 18.3 (about 400 MB once) into `.runtime\`, plus the Composer packages. Later runs need no downloads |
| A Tailscale account with the TOEFL House tailnet | Tailscale itself is installed by the launcher if missing; **signing in is the only manual step ever** (see below) |
| The database port 5432 and app port 8080 free | The launcher tells you if something else owns them |

Everything the launcher downloads is pinned to exact official URLs
(see the top of `START-TOEFL-HOUSE.bat`), verified by executing it
(`php -v`, `composer --version`, `initdb --version`) before use, and cached
in `.runtime\` — re-runs are instant and deterministic.

## Startup — the whole procedure

1. **Clone the repository** (once) — e.g. with GitHub Desktop:
   *Clone → repository `alfrotan-glitch/TOEFL-House` → folder `TOEFL-House`.*
2. **Double-click `START-TOEFL-HOUSE.bat`.**
3. **First run only:** when asked, enter the owner's full name, date of
   birth (`YYYY-MM-DD`), a login username and a password of at least 12
   characters (twice). This creates the owner account — the one person who
   signs in first. Every later account is created inside the application,
   through the normal access workflow; you are never prompted again.
4. **First run only (Tailscale):** if Tailscale was not already signed in on
   this machine, the launcher installs it (a Windows security prompt may
   ask for approval — click **Yes**), then asks you to open
   `https://login.tailscale.com`, sign in, and approve this machine on your
   phone. Then **double-click `START-TOEFL-HOUSE.bat` once more** — the app
   is already running; that run finishes the Tailscale configuration.
5. Done. The window prints the addresses:
   * **This computer:** `http://127.0.0.1:8080`
   * **Other TOEFL House devices:** the printed `https://…ts.net` Tailnet
     address (same address on every run).

Sign in with the owner account. You now have the complete certified
application: every module, every workflow, printing, backups and reports.

Re-running `START-TOEFL-HOUSE.bat` at any later time is safe and idempotent:
it re-verifies everything, starts whatever is stopped, and re-prints the
addresses.

## Recovery (interruptions, reboots, failures)

* **Reboot / closing the window at any point:** everything (web server,
  database) starts again the next time you double-click
  `START-TOEFL-HOUSE.bat`. Tailscale keeps running after a reboot and,
  for Serve configured with `--bg`, resumes the mapping automatically
  (documented Tailscale behavior); re-running the launcher is still the
  normal start and is safe either way.
* **Interrupted first run (any step):** re-run the launcher. Each step is
  guarded (already-downloaded runtimes are reused, an existing cluster is
  started, existing migrations are skipped). If the interruption happened
  mid-migration, the launcher repairs the partial state automatically on a
  fresh deployment (see the step list above); it never touches a database
  that already contains accounts.
* **Corrupted or missing runtimes:** delete the affected folder under
  `.runtime\` (the launcher's failure messages name the exact folder) and
  re-run.
* **Data disaster:** `RESTORE-TOEFL-HOUSE.bat` with your latest backup —
  it verifies the dump before changing anything and requires you to type
  `RESTORE`.
* **Everything fails:** every failure message names the exact step, the
  exact cause, and the exact next action. If a message still does not get
  you moving, the message itself is the thing to report to the TOEFL House
  maintainer — it contains the diagnostic.

## Stop

Double-click **`STOP-TOEFL-HOUSE.bat`**. It stops the web server, stops
PostgreSQL, and removes the Tailscale Serve mapping (so the app is no
longer reachable on the Tailnet while stopped). No data is deleted.

## Backup

Double-click **`BACKUP-TOEFL-HOUSE.bat`** (at least once a day, and after
anything important). It creates a verified backup in `backup\` using the
same protocol as the production tooling (`deploy/backup.sh`): PostgreSQL
custom format, compressed, `--no-owner --no-privileges`, integrity-verified
with `pg_restore --list`, keeping the 14 most recent dumps. The `.dump`
files are portable: they can be restored on any platform, including the
Linux production tooling (`deploy/restore.sh`).

## Restore

Double-click **`RESTORE-TOEFL-HOUSE.bat`** (restores the most recent backup).
It verifies the dump **before** touching anything, then asks you to type
`RESTORE` — anything else refuses with no change. The live database is
overwritten. After restoring, double-click `START-TOEFL-HOUSE.bat` again.
(`RESTORE-TOEFL-HOUSE.bat "path\to\specific.dump"` restores a specific file
when run from a folder window.)

## How the launcher works (for the curious)

`START-TOEFL-HOUSE.bat`, in order, failing loudly at any step:

1. Verify Windows + built-in `curl.exe`.
2. Prepare `.runtime\php` (official PHP 8.2.27 zip + a minimal controlled
   `php.ini`), `.runtime\composer.phar` (official Composer),
   `.runtime\pgsql` (official PostgreSQL 18.3 zip) — each verified by
   execution.
3. `composer install` (production, `--no-dev`, lock file authoritative).
4. Create `.env` from the production template `.env.example`
   (`APP_ENV=production`, `APP_DEBUG=false`) with desktop overrides
   (local database, `SESSION_SECURE_COOKIE=false` because the local console
   is plain HTTP while the Tailnet side is HTTPS), then `php artisan
   key:generate`.
5. `initdb` a local-only cluster (trust auth, bound to `127.0.0.1`) and
   start PostgreSQL.
6. Create `toefl_house` and run `php artisan migrate --force` (118
   migrations, from zero). If a previous run was interrupted mid-migration,
   the launcher detects the partial state and recovers automatically: a
   fresh deployment with no accounts is rebuilt from scratch (provably safe
   — `user_accounts` is the root of every record in this system); a
   deployment that already has accounts is left untouched and pointed at
   `RESTORE-TOEFL-HOUSE.bat`.
7. **First run only:** `db:seed --class=FirstRunBootstrapSeeder` — a
   guard-protected bootstrap that runs *only while zero accounts exist*:
   it writes the authoritative organization, the Owner role with the
   complete 90-capability set, the position/assignment and the owner
   account. On any live system it is a no-op.
8. Start `php artisan serve` on `127.0.0.1:8080` in a minimized window.
9. Poll `/health` until it answers 200.
10. Install Tailscale if missing, `tailscale serve --bg 8080` (Serve, never
    Funnel), and print the private `https://…ts.net` address. If the
    background configuration fails once — which on a fresh tailnet means
    the one-time HTTPS-certificates setup is still pending — the launcher
    opens a Tailscale window that completes it (follow the link there if
    one appears), you press any key, and it retries automatically.

## Security model

* **PostgreSQL** listens on `127.0.0.1` only (local trust auth) — it is not
  reachable from the network at all.
* **Laravel** listens on `127.0.0.1:8080` only. The only path to it from
  other devices is the Tailscale Serve proxy, i.e. only for authorized
  Tailnet members, over HTTPS, with the Tailnet's per-device ACLs.
* **Funnel is never configured.** The launcher does not invoke it and there
  is no route to it.
* **No secrets in the repository.** `.env` (with the generated `APP_KEY`
  and local database settings), `.runtime\` (runtimes + database cluster)
  and `backup\` are all git-ignored. The owner password exists only as a
  bcrypt hash in the local database.
* The application itself runs with the same production hardening as the
  certified deployment: `APP_ENV=production`, `APP_DEBUG=false`, login
  rate limiting, CSRF protection, capability-based authorization, and the
  append-only, schema-enforced audit trail.

## Files

| File | Purpose |
|---|---|
| `START-TOEFL-HOUSE.bat` | One-click setup + start |
| `STOP-TOEFL-HOUSE.bat` | Clean shutdown |
| `BACKUP-TOEFL-HOUSE.bat` | Verified daily backup into `backup\` |
| `RESTORE-TOEFL-HOUSE.bat` | Confirmed disaster-recovery restore |
| `SETUP.md` | This document |
| `database/seeders/FirstRunBootstrapSeeder.php` | First-run owner bootstrap (guarded no-op afterwards) |
| `tests/Feature/Deployment/WindowsOneClickDeploymentContractTest.php` | Permanent guard that this deployment contract (files, no secrets, no Funnel, protocol parity, complete capability set, working bootstrap) is never broken |

## What is verified here, and what is not (honest status)

**Verified in the development environment (this repository's gate set):**
the complete existing gate set (full test suite, static analysis, code
style) is green with the deployment files in place; the first-run bootstrap
seeder is exercised by permanent tests (fresh database → owner account
created → real login succeeds → re-run is a no-op); the deployment files are
guarded by the permanent contract test above (presence, no secrets, Serve
not Funnel, backup/restore protocol parity with the production tooling, and
the owner capability list equal to every capability defined in the source).

**UNVERIFIED — marked, not claimed:**
* **End-to-end execution of the `.bat` files on an actual Windows
  machine** (the development environment for this repository is Linux; the
  batch files follow documented Windows behavior — built-in `curl.exe`,
  `tar`, `netstat`, `taskkill`, `msiexec` — and are pinned to URLs whose
  existence was checked against the official archives, but they have not
  been executed on Windows).
* **The Tailscale Serve mapping and access from a second authorized
  device** (no Tailnet exists in the development environment). The
  command used, `tailscale serve --bg 8080`, and its behavior — tailnet-only
  exposure, proxying `http://127.0.0.1:8080`, automatic resumption after a
  reboot, and the one-time HTTPS-certificates setup on a fresh tailnet —
  were verified against the official Tailscale documentation, but actual
  access from a second device was not exercised here.
* **The runtime download URLs over time** (pinned now; if a pinned archive
  is ever removed from the official site, the launcher fails loudly with
  the exact URL and a manual-download fallback).

On first use on the real Windows machine: run the launcher, and if any step
reports a failure, the message names the exact step, the exact cause, and
the exact remedy.
