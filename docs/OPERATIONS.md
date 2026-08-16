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
JWT_SECRET=<at least 32 random characters>
CORS_ORIGIN=https://your-frontend-origin      # REQUIRED in production
NODE_ENV=production
```

Both `JWT_SECRET` (<32 chars) and a missing `CORS_ORIGIN` abort startup in
production **by design** — a deployment cannot silently come up insecure.

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

## 2. Migrations

Migrations run automatically at startup, each in its own transaction, and a
`VACUUM INTO` snapshot is written first whenever migrations are pending.

Verify convergence — a migrated database must be identical to a fresh install:

```bash
cd server && npm run preflight:fresh-schema
```

## 3. Backup

A pre-migration snapshot is automatic. For scheduled backups, take a
`VACUUM INTO` snapshot — **do not** `cp` a live SQLite file, which can copy a
torn page or miss the WAL:

```bash
cd server
node -e "require('better-sqlite3')(process.env.DB_PATH||'./data/erp.sqlite') \
  .prepare('VACUUM INTO ?').run('/backups/erp-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite')"
```

`VACUUM INTO` produces a consistent, self-contained database and **cannot run
inside a transaction** — which is precisely what guarantees a snapshot never
captures a half-finished write.

Automatic snapshots live in `server/data/backups/` and are pruned to the most
recent few. **They sit on the same disk as the database**, so they protect
against a bad migration, not against disk loss. Copy them off-host.

## 4. Restore

1. Stop the server.
2. Copy the snapshot over the live database path:
   ```bash
   cp /backups/erp-<timestamp>.sqlite server/data/erp.sqlite
   rm -f server/data/erp.sqlite-wal server/data/erp.sqlite-shm
   ```
3. Verify before starting:
   ```bash
   cd server && node -e "
     const db=require('better-sqlite3')('./data/erp.sqlite');
     console.log(db.pragma('integrity_check')[0].integrity_check);
     console.log('fk violations:', db.pragma('foreign_key_check').length);"
   ```
   Expect `ok` and `0`.
4. Start the server. Any migrations newer than the snapshot re-apply
   automatically.

Covered by `server/src/tests/backup-restore.test.ts`, which performs a real
snapshot → destroy → restore → verify cycle.

## 5. Health verification

After any deploy, restore, or migration:

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
- **Backups are local by default.** Ship `server/data/backups/` off-host.
- **CI is not active.** `ci/github-actions-ci.yml` must be copied to
  `.github/workflows/ci.yml` by someone with the `workflows` permission. Until
  then every gate is manual — see `ci/README.md`.
