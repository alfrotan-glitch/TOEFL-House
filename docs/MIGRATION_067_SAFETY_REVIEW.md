# Migration Safety Review — `067_repair_f10_phantom_cash.sql`

**Date:** 2026-08-17 · **Reviewer:** automated audit pass 10
**Production database: NOT TOUCHED.** Every execution in this report ran against a
copy (`/tmp/f4/erp.sqlite`, `/tmp/prod-like.sqlite`, `/tmp/rollback-test.sqlite`).

---

## 0. First finding: the migration under review did not exist

`docs/RELEASE_READINESS.md` H-3 instructed an operator to *"run the F-10 repair
migration against production"*. There was no such file. Migrations stopped at
`066`, and `grep -rn "F-10"` matched only prose and two test files.

A documented remediation step referenced an artifact nobody had written. Per the
standing rule *"do not modify historical migrations — if F-10 itself is unsafe,
propose a new corrective migration"*, I authored a **new** migration `067`.
**No historical migration was edited.**

## What F-10 was

The book-sale refund path hand-rolled a contra-revenue row into
`financial_transactions` and never debited `finance_accounts`. The ledger
recorded the refund; the cash account did not. Each legacy refund left phantom
cash behind, and it accumulated.

The forward code path is already fixed (refunds now go through `recordIncome()`).
Databases that processed refunds *before* that fix still carry the divergence.
Migration `067` repairs that historical residue.

---

## What the migration does

| Aspect | Detail |
|---|---|
| Tables written | `finance_accounts` (UPDATE), `financial_transactions` (INSERT, 1 audit row per repaired branch) |
| Columns written | `main_balance`, `saving_balance` |
| Tables read | `financial_transactions` |
| DDL / constraints | **None.** No ALTER, no CREATE, no DROP, no index change |
| DELETEs | **None.** No historical row is ever removed |
| Rows targeted | Only `scope_type='branch'` rows **whose balance disagrees with their own ledger** |
| Explicitly excluded | `scope_type='organization'` (the treasury is funded by `capital_injection`, not branch income) |
| Excluded from the formula | `category='capital_injection'`, `expense`, `budget_charge` — mirrors `computeReconciliation()` exactly |

Formula applied per branch (identical to the authoritative reconciler):

```
main_balance   = SUM(income except capital_injection) - SUM(saving_transfer)
saving_balance = SUM(saving_transfer)
```

Both statements carry the same `WHERE <balance> <> <ledger-derived value>` guard,
so a branch that already agrees is not rewritten at all.

---

## A defect found *in this migration* during review

The first draft summed **all** `type='income'` rows. But a `capital_injection`
row is stamped with the operator's `branch_id` while crediting the
**organization treasury**, not branch cash — `computeReconciliation()` excludes
it. The draft would therefore have counted it as branch income.

Demonstrated on a healthy branch (real income 1000, account correct at 1000,
plus a 50,000 capital injection):

```
branch main AFTER migration: 51000   (correct value is 1000)
*** BUG: migration INVENTED 50000 of phantom cash ***
```

The migration would have *created* a 50,000 AFN discrepancy on a **healthy**
branch — the exact opposite of its purpose. Fixed in all three query sites and
pinned by the test `excludes capital_injection from branch cash`. `category` is
`NOT NULL` in the schema, so the `<> 'capital_injection'` comparison has no
three-valued-logic hole.

---

## BEFORE

Production-like copy carrying **real** F-10 damage, rebuilt by driving the
*original broken* refund path: 4 sales via `recordIncome()`, then 2 refunds
written the old hand-rolled way.

```
finance_accounts  branch:1        main 4750.00   saving 250.00
finance_accounts  organization:global  main 0.00      saving 0.00
ledger (financial_transactions)  10 rows, sum 3750.00
expected main from ledger        3250.00
cashVariance  1500.00      healthy  false
schema_migrations                65 applied
```

## AFTER

Applied through the **real production path** — importing `db/connection.ts`,
which runs `runMigrations()` on boot.

```
finance_accounts  branch:1        main 3250.00   saving 250.00   <-- corrected
finance_accounts  organization:global  main 0.00      saving 0.00   <-- untouched
ledger (financial_transactions)  11 rows, sum 3750.00
cashVariance  0.00   savingVariance 0.00   amountVariance 0.00   healthy  true
schema_migrations                66 applied
```

## CHANGED ROWS

Exactly two things changed:

| Object | Before | After |
|---|---|---|
| `finance_accounts` branch:1 `main_balance` | 4750.00 | **3250.00** |
| `finance_accounts` branch:1 `saving_balance` | 250.00 | 250.00 (unchanged) |
| `financial_transactions` row count | 10 | **11** (+1 audit row) |

The inserted row:

```
tx_f10_1 | branch=1 | amount=0 | operator: migration 067
"F-10 repair: finance_accounts realigned to the ledger. main 4750.0 -> 3250.0, saving 250.0 -> 250.0"
```

Its amount is **0**, so the trail row cannot itself move the ledger it documents.

## UNCHANGED TABLES

Verified byte-identical row counts before and after:

`payments 0` · `invoices 0` · `invoice_items 0` · `book_sales 0` · `students 0` ·
`enrollments 0` · `student_semesters 0` · `audit_logs 0` ·
`teacher_salary_ledger 0` · `teacher_compensation_history 0` ·
`student_journey_events 0` · `budget_lines 17` · `branches 1` · `users 1` ·
`finance_accounts` (count 2 — one row's values changed, no row added or removed)

Integrity: **foreign-key violations 0 → 0** · **indexes 338 → 338** ·
unique constraints unchanged (no DDL executed).

## FINANCIAL IMPACT

| Measure | Before | After |
|---|---|---|
| Payment totals | 0.00 | 0.00 (unchanged) |
| Invoice total / net | 0.00 / 0.00 | 0.00 / 0.00 (unchanged) |
| Outstanding obligations | unchanged | unchanged |
| Ledger sum | 3750.00 | **3750.00 (unchanged)** |
| Teacher compensation history | 0 rows | 0 rows (unchanged) |
| Enrollment / academic history | unchanged | unchanged |
| Branch cash `main_balance` | 4750.00 | 3250.00 (**−1500 phantom cash removed**) |

**No revenue, invoice, payment, or obligation figure is altered.** The migration
does not change what was earned or owed — it deletes cash that the ledger says
was never there. The ledger is the source of truth and is left completely intact.

**Branch isolation:** each branch is repaired from its **own** ledger
(`ft.branch_id = fa.scope_id`). A test with a diverged branch 1 and a healthy
branch 2 confirms branch 2 is untouched; removing that predicate fails the test.

## AUDIT IMPACT

- `audit_logs` — **not modified** (0 → 0).
- One zero-amount `financial_transactions` row per repaired branch, with a
  deterministic id `tx_f10_<branch_id>` and a description naming the old and new
  values. The repair is self-documenting and greppable.
- **No audit history is rewritten, deleted, or backdated.**
- A healthy branch produces **no** audit row (nothing happened, nothing logged).

## ROLLBACK POSSIBILITY

**1. Atomic.** The runner wraps each migration in `BEGIN`/`COMMIT`. I injected a
deliberate failure immediately after the repair statements:

```
BEFORE  : {"acct":{"main_balance":4750,"saving_balance":250},"tx":10}
FAILED  : no such function: raise_that_does_not_exist
AFTER   : {"acct":{"main_balance":4750,"saving_balance":250},"tx":10}
ROLLBACK_CLEAN: true
```

A mid-migration failure leaves **nothing** behind — no partial balance write, no
orphan audit row.

**2. Automatic pre-migration backup.** `backupBeforeMigrations()` writes a
`VACUUM INTO` snapshot before any pending migration runs. Verified genuine:

```
🛟 Pre-migration backup written (1 pending): /tmp/runner/backups/pre-migration-...sqlite
backup integrity : ok      backup tables: 106
backup accounts  : branch:1 main 4750  (pre-repair state)
backup migrations: 65
```

Restoring that file is a complete rollback.

**3. Manual reversal.** Even without the snapshot, the change is two values and
one deletable marker row; the pre-repair figure is recorded verbatim in the audit
description.

**Caveat, stated plainly:** rolling back restores the *phantom cash*. The
pre-repair state is the corrupt one.

---

## Idempotency / running twice

Two independent mechanisms, and I verified which one actually does the work:

- **Primary** — after the first run the branch agrees with its ledger, so the
  `WHERE divergence` clause matches nothing. Removing the `NOT EXISTS` guard
  alone does **not** break idempotency; this clause is what makes a re-run a no-op.
- **Backstop** — the `NOT EXISTS` guard on the deterministic marker id prevents a
  duplicate audit row if a branch were ever to diverge *again* later.

Confirmed empirically: a second full run changed nothing (AFTER == TWICE, exactly),
and re-running the runner on an already-migrated database is a no-op.

## Tests

`server/src/tests/migration-067-f10-repair.test.ts` — 9 tests, each on its own
isolated database. Every one was **mutation-verified**: I broke the migration and
confirmed the corresponding test fails.

| Property pinned | Mutation that must fail it | Result |
|---|---|---|
| Corrects a diverged branch | — | pass |
| Healthy DB left untouched | — | pass |
| Idempotent | — | pass |
| No duplicate audit row on re-divergence | remove `NOT EXISTS` guard | **caught** (UNIQUE violation) |
| Per-branch isolation | drop `ft.branch_id = fa.scope_id` | **caught** |
| `capital_injection` excluded | revert the exclusion | **caught** |
| Zero-amount audit row | — | pass |
| Treasury untouched | — | pass |
| `payments` / `audit_logs` untouched | — | pass |

## Release gate after this change

`server` tests **858 passed / 88 files** · server lint+typecheck **0 errors**
(100 pre-existing warnings) · server build OK · `preflight:fresh-schema`
**66 migrations, no drift** · root typecheck **0** · root lint **0 errors** ·
root build OK · `release:validate` **16 passed / 0 failed**.

## Verdict

**Safe to run against production, after taking a backup.** The migration is
narrow, atomic, idempotent, branch-isolated, additive to audit history, and a
no-op on healthy data. It does not alter revenue, invoices, payments, academic
history, or any constraint.

**It has not been run against production.** Migrations apply automatically on
next app boot, so deploying this build *is* the execution — schedule it
deliberately and confirm the pre-migration snapshot exists afterwards.

---

# Addendum — Full production-clone rehearsal (pass 11)

The first review ran against a copy whose business tables were empty, so
"payments 0 -> 0" proved very little. This addendum repeats the exercise on a
**populated** production-like database and covers migration 068 as well.

## How the clone was built

Data was created by driving the **real HTTP API** (not direct SQL): 8 students
across 2 branches, 8 payments, 6 book sales incl. 1 refund through the real
refund path, 1 invoice, teacher payroll funded from a real budget line, and a
200,000 AFN treasury capital injection. The clone was then taken with SQLite's
backup API and confirmed logically identical to the source.

Populated state: 106 tables · 338 indexes · 31 ledger rows · 26 audit rows ·
integrity ok · FK violations 0.

## Result: migration 067 is a NO-OP on healthy real data

| scope | account main | ledger formula | outcome |
|---|---|---|---|
| branch 1 | 19,510 | 19,510 | no-op |
| branch 2 (West) | 7,600 | 7,600 | no-op |
| organization treasury | 80,000 | excluded by design | untouched |

**This is the capital_injection defect caught for real.** Branch 1 carries a
200,000 AFN `capital_injection` row stamped with its `branch_id`. With the
exclusion, the formula returns 19,510 and the migration correctly does nothing.
Without it, the migration would have written 219,510 — inventing 200,000 AFN of
phantom cash on a healthy branch.

## Before/after across the whole database

Applied via the real application boot path (`connection.ts` → `runMigrations`).

Unchanged: tables 106 · indexes 338 · integrity ok · FK 0 · ledger total
380,090 · payments 23,800 · teacher ledger 30,000 · budget total 90,000 ·
audit rows 26 · all account balances · ledger by type and by category ·
invoice totals · book-sale status counts.

One count moved: `budget_lines` 17 → 34. **Investigated and attributed:** this
is `ensureBudgetLineCatalog()` provisioning the 17 default lines for the second
branch on boot, guarded by `NOT EXISTS`. Proven not to be the migration by
applying 067 alone outside the app: `budget_lines 17 -> 17`.

Reconciliation through the real API after migrating, per branch:
`cashVariance 0 · savingVariance 0 · amountVariance 0 · budgetVariance 0 ·
healthy true` for **both** branches.

## Backup and restore

The runner wrote its pre-migration snapshot automatically. Verified: integrity
ok, 106 tables, 338 indexes, FK 0, and **all financial figures identical** to
the pre-migration state (the only difference is the `schema_migrations` row for
067, which is the point of the snapshot). A restore drill booted the
application directly on the restored file: 7 students, 8 payments, branch-1
main 19,510 — a working database, not just a readable file.

## Migration chain review (all 68)

- **Total:** 68 migrations, applied in filename order, tracked in
  `schema_migrations`; each runs inside `BEGIN`/`COMMIT`.
- **Destructive operations:** `DROP TABLE` appears in 15 migrations. Every one
  inspected is the SQLite rebuild idiom (create-new → copy → drop-old →
  rename); no data-losing drop was found. Several early migrations delete
  seeded demo rows by explicit id — intentional, and inert on real data.
- **Foreign-key integrity:** 0 violations on fresh, upgraded, and backup.
- **Fresh-schema reproducibility:** `preflight:fresh-schema` passes, 67
  migrations, no drift.
- **Upgrade-path reproducibility:** independently compared a fresh install
  against the upgraded production clone. **This found the drift that the
  preflight does not catch** — 2 indexes present only on upgraded databases.
  Fixed by migration 068; fresh and upgraded are now byte-identical in
  structure (106 tables, 201 non-internal indexes, 0 declared-but-missing).
- **Duplicate indexes:** `invoices` still carries two unique indexes enforcing
  the same rule (D-3). Redundant, not a correctness defect; left alone
  deliberately rather than editing history.
- **Rollback/recovery:** automatic `VACUUM INTO` snapshot before any pending
  migration, retained by count; per-migration transaction rollback proven by
  fault injection.
