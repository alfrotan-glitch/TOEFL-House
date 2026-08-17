# Deploying migrations 067–069

**Status: verified on fixtures and clones in a sandbox. NOT run against real
production data — see "External dependency" at the end.**

Migrations apply automatically on application boot (`src/db/connection.ts`
calls `runMigrations`). **Deploying this build IS the migration execution.**
There is no separate "run migrations" step to schedule, so treat the deploy
window itself as the maintenance window.

---

## What the three migrations do

| # | File | Effect | Touches data? |
|---|---|---|---|
| 067 | `067_repair_f10_phantom_cash.sql` | Realigns `finance_accounts` balances to the ledger for branches that diverged, and writes one zero-amount audit row per repaired branch | **Yes** — updates 2 balance columns |
| 068 | `068_restore_indexes_lost_in_table_rebuilds.sql` | Recreates `idx_users_role` and `idx_placement_profile_program_branch`, dropped by the 052/058 table rebuilds | No |
| 069 | `069_nonnegative_money_guards.sql` | Adds BEFORE INSERT/UPDATE triggers rejecting negative invoice, semester-fee and exam-fee amounts | No |

Only **067** changes stored values. 068 and 069 are structural and cannot lose
a row.

## Backup requirement

The runner writes its own snapshot before applying anything pending:

```
🛟 Pre-migration backup written (3 pending): <db-dir>/backups/pre-migration-<ts>.sqlite
```

Verified on an existing database upgrading 066 → 069: `integrity_check ok`,
106 tables, `schema_migrations` = 65 (the pre-upgrade count), branch cash
4750 — i.e. the **pre-repair** value. It is a genuine restore point.

**Still take your own backup.** The runner's snapshot is written with
`VACUUM INTO`, which fails if the disk is full, and in that case the code logs
loudly and continues rather than blocking the service from starting. Do not
rely on it as your only copy.

## Fresh install vs existing database

Both were exercised through the real boot path and converge to the same shape.

| | Fresh install | Existing DB (was at 066) |
|---|---|---|
| migrations recorded | 68 | 68 |
| 067 / 068 / 069 applied | yes | yes |
| triggers | 54 | 54 |
| indexes | 338 | 338 |
| FK violations | 0 | 0 |
| `integrity_check` | ok | ok |
| branch cash | n/a (no data) | **4750 → 3500** (realigned to the ledger) |
| `tx_f10_*` audit rows | 0 (nothing to repair) | 1 |

A fresh install gets 067 as a **no-op** — there is no divergence to correct, so
it writes no audit row. That is the intended behaviour and is covered by
`migration-067-f10-repair.test.ts`.

## Rollback

1. **Per-migration.** Each migration runs inside `BEGIN`/`COMMIT`. A failure
   mid-migration rolls back completely — proven by fault injection: injecting
   an error after 067's UPDATE left balances and row counts byte-identical.
2. **Whole upgrade.** Restore the pre-migration snapshot. Verified by booting
   the application directly on a restored copy; it came up and re-applied the
   migrations deterministically to the same result (cash 3500).
3. **Manual.** 067's change is two balance values plus one deletable marker row
   (`tx_f10_<branch>`), and the pre-repair figure is written verbatim into that
   row's description.

**Caveat, stated plainly:** rolling back 067 restores the *phantom cash*. The
pre-repair state is the corrupt one.

## Re-running / idempotency

Booting the already-upgraded database three more times changed nothing:
migrations 68, triggers 54, `tx_f10_*` rows 1, cash 3500. All three migrations
are safe to re-run — 067 is guarded by a divergence condition, 068 uses
`IF NOT EXISTS`, and 069 is `DROP TRIGGER IF EXISTS` followed by `CREATE`.

---

## Deployment checklist

1. **Take your own backup** of `erp.sqlite` (plus `-wal` / `-shm` if present).
2. **Audit the existing data first — this is the step that needs a human:**
   ```
   node server/scripts/audit-financial-data.mjs /path/to/erp.sqlite
   ```
   Exit codes: `0` clean · `1` corrupt values found · `2` could not read the
   database. On exit 1 the report lists table.column, record ids, the current
   value, the corruption type, the blast radius, and whether the row is safe to
   leave. **Decide on each row before deploying** — nothing is repaired
   automatically, by design.
3. **Stop the service**, deploy the build, **start it**. Migrations run on boot.
4. **Confirm the snapshot exists** in `<db-dir>/backups/`.
5. **Verify the repair:**
   ```
   GET /api/finance/reconciliation?branchId=<id>
   ```
   Expect `cashVariance: 0`, `healthy: true` for every branch.
6. **Re-run the data audit** — it should now exit 0.

## External dependency

Everything above was verified against fixtures, a fresh database, and a
production-shaped clone carrying reproduced F-10 damage — **never against real
production data, which is not reachable from the build environment** (the
system is file-based SQLite and no production `erp.sqlite` exists here).

Step 2 in particular can only be answered by running the audit on the real
database. Until someone does, whether production holds pre-existing corrupt
money values is **unknown, not clean**.
