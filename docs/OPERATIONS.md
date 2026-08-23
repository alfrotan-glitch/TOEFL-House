# Operations runbook

Everything an operator needs to install, back up, restore, and verify a TOEFL
House ERP deployment. Each procedure here is exercised by an automated test or
was run by hand during the release-candidate audit — nothing in this file is
aspirational.

---

## 1. Fresh installation

```bash
# frontend
npm ci --no-audit --no-fund
npm run build                       # -> dist/

# backend
cd server
npm ci --no-audit --no-fund
```

`server/.env` (required — the server refuses to boot without a valid secret):

```ini
PORT=4000
DB_PATH=./data/erp.sqlite
BACKUP_LOCAL_DIR=./data/backups
BACKUP_EXTERNAL_DIR=E:\TOEFL-House-Backups   # REQUIRED: another drive or UNC share
JWT_SECRET=<at least 32 random characters>
CORS_ORIGIN=https://your-frontend-origin      # REQUIRED in production
NODE_ENV=production
```

A short `JWT_SECRET`, missing production `CORS_ORIGIN`, or missing/invalid
`BACKUP_EXTERNAL_DIR` aborts startup **by design** — a deployment cannot
silently come up insecure or without its required recoverability path.

Create the owner account. The seed refuses to invent credentials:

```bash
cd server
SEED_OWNER_USERNAME=owner \
SEED_OWNER_PASSWORD='<strong password>' \
SEED_OWNER_NAME='Owner Name' \
SEED_OWNER_EMAIL='owner@example.org' \
npm run seed
```

The seed creates **only** the organization hierarchy, one branch and the owner.
It creates no demo students, teachers, payments or donors, and never modifies
existing operational data. The owner must change the password on first login.

Run the server from the compiled output, not `tsx`:

```bash
cd server && npm run build && NODE_ENV=production node dist/index.js
```

## 2. Database schema

There is no migration chain. `server/src/db/schema.sql` is the single
canonical representation of the database, and it is applied idempotently only
to an empty database or one already at that exact canonical shape. It does not
transform an incompatible historical shape. The governing greenfield mode has
no production dataset to preserve: after a canonical schema reconstruction,
stop the server, remove the old database/WAL sidecars and seed a fresh database.

Schema changes are made by editing that file. Verify before deploying:

```bash
cd server && npm run preflight:fresh-schema
```

That proves the schema stands alone, is structurally sound, is idempotent, and
that no second mechanism capable of altering the shape has been introduced.

After deploying, verify the database an operator actually has:

```bash
cd server && node scripts/verify-deployment.mjs ./data/erp.sqlite
```

This diffs the live database against the canonical schema — every table,
index, trigger and column — and reports anything missing or unexpected. It is
read-only.

## 3. Automated backup

Automated backups are a startup requirement. Configure both destinations in
`server/.env`:

```ini
BACKUP_LOCAL_DIR=./data/backups
# Use another physical Windows drive:
BACKUP_EXTERNAL_DIR=E:\TOEFL-House-Backups
# Or use a UNC network share instead:
# BACKUP_EXTERNAL_DIR=\\backup-pc\TOEFL-House-Backups
```

The external destination is mandatory. On Windows it must be a UNC path or a
different drive from the local snapshots. A folder elsewhere on the database's
own drive does not protect against drive loss and is rejected. The backend also
refuses to start when the destination is missing, is still the template
placeholder, resolves to the local directory, or is not writable.

At startup the backup service verifies the newest matching local/external daily
pair. If no verified pair is less than 24 hours old, startup creates one before
the HTTP listener opens. The next attempt is due 24 hours from the last backup,
then every 24 hours while the process runs.

Each run uses SQLite's online backup API; it never copies the live `.sqlite`,
`-wal`, or `-shm` files. Before publishing a snapshot name, the service opens
both destination copies and requires:

- `PRAGMA integrity_check = ok`;
- zero `PRAGMA foreign_key_check` rows;
- a non-empty regular file; and
- identical SHA-256 and byte length for local and external copies.

A run is successful only after both copies pass. A copy failure removes the
incomplete run, records an error, and returns health/readiness as HTTP 503. The
backend never reports a local-only copy as backup success. Inspect
`server/logs/backend-startup.log` for the detailed failure.

Snapshots are stored under `daily`, `weekly`, and `monthly` subdirectories at
both destinations. Grandfather-father-son retention keeps one verified pair per
calendar bucket:

| Tier | Retained |
|---|---:|
| Daily | 7 |
| Weekly (ISO week) | 4 |
| Monthly | 12 |

The current week's and month's files are refreshed by the daily run; after the
bucket closes, the latest verified snapshot in that bucket remains. Unknown
operator-created files are not deleted by retention.

Check backup health without authentication:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/health |
  Select-Object -ExpandProperty backup
```

Expect `healthy: true`, `state: healthy`, a `lastSuccessAt` timestamp, and a
`nextAttemptAt` timestamp.

## 4. Restore

1. Stop the backend and confirm no `node.exe` process still has the database open.
2. Choose a snapshot from either configured destination. Copy it over the live
   database and remove stale WAL sidecars:
   ```powershell
   Copy-Item -LiteralPath 'E:\TOEFL-House-Backups\daily\daily__<snapshot>.sqlite' `
     -Destination '.\server\data\erp.sqlite' -Force
   Remove-Item '.\server\data\erp.sqlite-wal','./server/data/erp.sqlite-shm' `
     -Force -ErrorAction SilentlyContinue
   ```
3. Verify before starting:
   ```powershell
   Set-Location server
   node -e "const D=require('better-sqlite3');const d=new D('./data/erp.sqlite',{readonly:true});console.log(d.pragma('integrity_check',{simple:true}));console.log('fk violations:',d.pragma('foreign_key_check').length);d.close()"
   ```
   Expect `ok` and `0`.
4. Start the matching application revision. A snapshot may be re-applied only
   when it already has that revision’s canonical shape; startup never performs
   an undocumented schema migration. For the current greenfield reconstruction,
   use a clean rebuild rather than restoring a predecessor shape.

## 5. Health verification

After any deploy or restore:

```bash
# schema + referential integrity
cd server && node -e "
  const db=require('better-sqlite3')('./data/erp.sqlite');
  console.log('integrity:', db.pragma('integrity_check')[0].integrity_check);
  console.log('fk:', db.pragma('foreign_key_check').length);"
```

Then, authenticated as an owner:

```
GET /api/finance/reconciliation
```

Expect `healthy: true`. The response reports two independent dimensions:

| Field | Meaning | Non-zero means |
|---|---|---|
| `amountVariance` | payments vs their ledger rows | a payment and its ledger row disagree |
| `cashVariance` | `finance_accounts.main_balance` vs `income − expense − saving_transfer` | a money path moved the ledger but not cash (or vice versa) |
| `savingVariance` | `saving_balance` vs the `saving_transfer` ledger | the savings sweep drifted |
| `budgetVariance` | `budget_lines.current_amount` vs `budget_charge − expense` | an expense was paid without decrementing its line (or vice versa) |
| `unmatchedPayments` / `orphanLedgerRows` | rows with no counterpart | a write path is only half-complete |

`cashVariance` exists because the payment↔ledger check compares two views of
the same table family and cannot see a path that updates one and not the
other — the blind spot that hid a phantom-cash defect (F-10) during the audit.

`budgetVariance` covers the third store of money. Branch cash, the organization
treasury and budget lines each hold value independently; payroll and
operational expenses are paid from a LINE, not from branch cash, so neither of
the other two checks can see a line that drifts from its ledger.

## 6. Known operational limits

- **Single-process SQLite.** One writer. Fine for one institute; there is no
  horizontal scaling story. Do not run two server processes against one file.
- **Backup availability depends on the configured external device/share.** A
  scheduled external failure makes readiness unhealthy until a later verified
  pair succeeds; it is never downgraded to local-only success.
- **CI is active.** `.github/workflows/ci.yml` runs the project release
  validation authority.
