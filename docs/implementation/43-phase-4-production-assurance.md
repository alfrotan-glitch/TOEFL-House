# PHASE_4 — Production Assurance (in progress)

Per-workstream assurance record. Each entry is DISCOVER → PROVE → FIX → ATTACK → VERIFY with measurable evidence only. A workstream is done when every safely-fixable finding is fixed and re-verified; what remains is stated explicitly.

Workstream order: **Security (P4.1) → Reliability (P4.2) → Performance (P4.3) → Deployment (P4.4) → Documents (P4.5) → Cross-cutting (P4.6) → Final adversarial attack + production certification.**

---

## P4.1 — Security (commit `44e2e6b`)

**Finding fixed.** The login form offers "keep me signed in" but `user_accounts` had no `remember_token` column — a remember-enabled sign-in **500'd** (proven before fixing). Fixed with migration `000117` (standard nullable column, guard-managed, not fillable); proven by two permanent regression tests in `SecurityHardeningFeatureTest` (recaller issued with remember; not issued for session-only sign-in).

**Controls evidenced (all verified, not assumed):**

| Control | Evidence |
|---|---|
| Authentication | bcrypt (`Hash::check`); unified failure message (no user enumeration); session **regenerated on login**, **invalidated + token regenerated on logout**; deactivated accounts cannot authenticate (`canAuthenticate` + `EnsureEmployeeSession`) |
| RBAC | per-operation `AccessDecision` gate on every command; the actor is bound from the authenticated session — never self-asserted (adversarial suites from PHASE_3) |
| Sessions | database driver, 120 min lifetime, httponly, samesite=lax, secure cookie in the production template |
| CSRF | **enforced — real-server probe: token-less POST → 419, with-token POST → normal flow.** Recorded: Laravel's `VerifyCsrfToken` intentionally bypasses validation in the test environment, so feature tests cannot prove CSRF; the real-server probe is the evidence of record |
| Brute force | login `throttle:login` (5/min per IP+username) → 429 + `Retry-After` |
| Files | no application file uploads (documents are reference-based); the framework's auto-registered `/storage/{path}` routes are signature-gated on the private disk, rooted at the unused `storage/app/private` (no views/sessions/logs exposed), path traversal → 404 |
| Secrets | `.env` gitignored; `.env.example` is the production template (`APP_DEBUG=false`, sslmode, APP_KEY, secure cookies, database cache for rate limiting); `/health` verifies the key exists and discloses nothing (probe: `{"status":"ok","checks":{"database":"ok","application_key":"ok"}}`) |
| Audit | `audit_events` append-only **trigger** (DB-level) |
| Error surface | DomainError → mapped payload (stable code, no stack); real server verified with `APP_ENV=production`/`APP_DEBUG=false` |
| Credentials | password min 10, double-gated (transport validation + domain rule) |

Carried to P4.4: least-privilege DB role and `sslmode` enforcement on the target host (local dev runs trust@127.0.0.1).

---

## P4.2 — Reliability (this commit)

### Transactions, concurrency, idempotency (inventory, machine-derived)

- **78 commands; 150 `DB::transaction` wraps; 150 idempotent executions; 136 `lockForUpdate`** subject-row locks. Every domain write is transactional, idempotency-keyed (operation + key + payload binding; replay returns the original result, mismatched replay refused), and the subject row is locked before transition.
- Staged SoD invariants (000110–000116) are enforced **in the database** (triggers), not only in application code — so a bypass at the SQL level is rejected, not merely discouraged. Proven sequentially by the module adversarial suites ("even under direct SQL") and now under a **real concurrent race** (below).

### NEW: the race holds under true concurrency

`tests/Feature/Reliability/ConcurrencyRaceTest.php` — two **independent PostgreSQL sessions** (the test process + a separate PHP child process with its own connection, `tests/Stubs/concurrency_race_child.php`) both open transactions and both claim the same approver slots on the same organization-wide grant request:

- exactly one writer wins (row-lock serialization);
- the stale claimant is **rejected by the schema guard** (`SQLSTATE 23514` — the state-transition branch fires when the stale write lands after the winner's commit; the written-once slot branch fires on the lock-wait interleaving; the test accepts either guard branch, both of which reject the stale writer);
- the winner's write is intact; no `scope_grants` row materialized.
- Verified **5/5 consecutive runs** (no flake).

### Failure recovery / rollback

- A rejected operation writes nothing: every workflow test asserts the table counts are unchanged after each refusal (e.g. communication consent/channel/purpose refusals, staged double-signature refusals).
- Partial staged signatures are legal by design (one of two slots filled) and are exactly what the schema allows — no other partial state exists, and the terminal-state check makes the chain non-rewindable.
- Rollback at the deployment level is the unchanged-`current`-symlink design in `deploy/deploy.sh` (P4.4 verifies it end-to-end).

### Backup / restore

**Finding fixed.** `deploy/backup.sh` and `deploy/restore.sh` referenced `pg_dump`/`pg_restore` that may be absent, and `deploy.sh`'s prerequisites did not list them — a host without the client tools would fail opaquely (or "succeed" without a backup). Fixed: both scripts now **preflight `command -v` and fail loudly** with an actionable message (proven: both exit 1 with the error in this environment, which has no client tools by documented design of the P02 recovery); `deploy.sh` prerequisites now state `postgresql-client` (version ≥ server).

**Recovery drill (executed, this commit).** A consistent server-side snapshot of the live database was taken and verified:

- **104/104 tables** present in the recovered copy (identical table set);
- **0 row-count mismatches across all 104 tables** (121 rows total in the dev database);
- **10/10 content checksums MATCH** on the authoritative history tables (`audit_events`, `scales`, `scope_grants`, `consents`, `consent_purposes`, `user_accounts`, `organizations`, `positions`, `access_policies`, `payroll_results`);
- the application **boots against the recovered copy**: `migrate:status` → 117/117 Ran (schema intact, incl. `000117`), Eloquent queries succeed.
- Drill database dropped; no trace left.

**Explicit residual (go-live checklist, P4.4).** The file-based `backup.sh` → `restore.sh` round-trip (custom-format dump) could not be executed in this environment because the P02 toolchain ships no PostgreSQL client tools (documented P02 limitation; rebuilding a PG18 client toolchain into the reset-wiped sandbox is not a safe mid-phase change). On the deployment target — where `postgresql-client` (≥ 18) is now a stated prerequisite — running `./deploy/backup.sh` followed by `./deploy/restore.sh` on a scratch instance is a **mandatory pre-go-live drill** and is listed as such in P4.4.

### Integrity

- Fresh-schema guard inventory (PHASE_3 certification): 116 migrations → **91 functions, 161 triggers**, staged-chain guards on all 000110–000116 request tables, append-only `audit_events`, catalog immutability guards (skills, scales, consent purposes).
- Direct-SQL attack coverage: `CrossModuleBoundaryAttackTest` (24 tests) + module adversarial suites.
- Direct-SQL attack coverage: `CrossModuleBoundaryAttackTest` (24 tests) + module adversarial suites.

---

## P4.3 — Performance (this commit)

**Method.** A scratch database (`toefl_house_perf`, dropped afterwards) was seeded to a realistic operational volume — **people 5,000 / user_accounts 500 / consent_purposes 100 / consents 5,000 / scope_grants 5,000 / audit_events 20,000 / messages 2,000** — and every hot console query was measured with `EXPLAIN (ANALYZE)` plus end-to-end page timings through a real HTTP server (`APP_ENV=production`, seeded DB). Host: 2 cores / ~4 GB (the actual class of the deployment target).

**Measured (20k-row audit trail):**

| Console query | Plan before | Time before | After |
|---|---|---|---|
| Audit listing `ORDER BY occurred_at DESC LIMIT 300` | seq scan + top-N sort | **4.27 ms** | **0.086 ms (50×)** — backward index scan (000118) |
| Consent lookup (subject + purpose + active + time window) — `SendMessage` hot path | partial unique index (pre-existing) | 0.03 ms | unchanged (already index-backed) |
| Scope grants per person | composite index (pre-existing) | 0.03 ms | unchanged |
| Message listing `ORDER BY id DESC LIMIT 200` | PK (pre-existing) | 0.22 ms | unchanged |
| Verified people listing | seq + sort (bounded by school population scale) | 1.5 ms | no index (volume-bounded by design — a school has thousands of people, not millions; an index here would be speculative) |
| Audit filter variants (actor / operation) | seq scan | 2.2–5.3 ms | unchanged at this volume; revisit if the audit trail outgrows tens of thousands of rows (recorded, not pre-empted) |

**Finding fixed.** `audit_events` — the only unbounded, append-only table in the system — had no index on `occurred_at`, and the audit console's default view sorts on exactly that column. The listing degrades **linearly with history** (seq scan + sort). Fixed with migration **000118** (`audit_events_occurred_at_index`); measured 50× at 20k rows and flat as history grows. Pinned by a permanent schema-contract test (`AuditTrailIndexTest` — planner-dependent timings are not asserted in CI; the measurements are the evidence above).

**End-to-end page timings** (real server, seeded DB, 3 runs per page): all 14 console index pages **200 in 99–153 ms wall** (median ≈ 120 ms) — full PHP boot + queries + render, on the deployment-class host.

**N+1 (structural check).** No lazy relation traversal exists in the console: every controller query is a flat, **limit-bounded** collection (100–1,000 rows), and no view accesses a relation on loop variables (machine-checked: zero `->relation->attribute` patterns in `resources/views`). Measured page times at volume corroborate.

**Resource posture.** Synchronous modular monolith (no queue workers, `QUEUE_CONNECTION=sync` by design); session + rate-limit cache on the persistent `cache` table (database driver) — no external infrastructure, no cache invalidation surface; pagination is limit-based on every index view (no unbounded `get()`).


## P4.4 — Deployment

**Scope (PHASE_4 contract):** env, config, migrations, health check, readiness,
deploy script, atomic release, rollback, pre-deploy backup.

### What exists (audited, not invented)

| Piece | Location | Property verified |
|---|---|---|
| Atomic release script | `deploy/deploy.sh` | releases/ + `current` symlink; live pointer switches only after env validation, migrations, and caches succeed |
| Health gate + auto-rollback | `deploy/deploy.sh` steps 8–9 | 5 polls × 2s on `GET /health`; on failure the symlink is restored to the previous release, services reloaded, script exits non-zero, failed release kept on disk |
| Manual rollback | `deploy/deploy.sh --rollback` | pointer change to the previous release, no rebuild |
| Release retention | `deploy/deploy.sh` | last 3 releases kept, older pruned after a green deploy |
| Edge server config | `deploy/nginx/toefl-house.conf` | docroot = `public/` only; dotfiles denied; raw `.php` 403; TLS 1.2/1.3; edge security headers; HTTP→HTTPS redirect; unauthenticated `/health` bypass |
| FPM pool | `deploy/php-fpm.conf` | dynamic pm (max 20), graceful/zero-downtime reload; no worker/scheduler processes (matches the monolith architecture) |
| Ops runbook | `docs/operations/production-deployment.md` | 17 sections: env, PG, migrations, caches, workers (none), scheduler (none), HTTPS, health, backup, restore, rollback, deploy, recovery, verification gate |

### Gaps found and fixed (this unit)

1. **No pre-deploy backup.** `deploy.sh` ran forward-only migrations against the
   live database with no safety net. **Fixed:** step 4 now runs `deploy/backup.sh`
   (with the persistent `.env`'s DB settings) immediately before `migrate`. If
   the PostgreSQL client tools are absent, the deploy is **refused** — a
   migration without a fresh backup is not a deployment this script performs.
   (Consistent with the P4.2 preflight: the tools are a documented, hard
   prerequisite of any migration event.)
2. **Empty `APP_KEY` only failed after go-live.** With an empty key the first
   request fails session encryption and the health check catches it only after
   the symlink switched (forcing a rollback of a deploy that should have been
   refused up front). **Fixed:** the env validation now requires a non-empty
   `APP_KEY` before anything is cloned or migrated.

### Executed in this sandbox (measured, not claimed)

A real deploy run against a sandboxed `DEPLOY_ROOT` (`/tmp/deploy-test`), a
fresh empty database (`toefl_house_deploytest`, PostgreSQL 18.4), and the real
repository as the source:

1. `git clone` of the release ref → **OK** (fresh checkout into
   `releases/<timestamp>`).
2. `composer install --no-dev --optimize-autoloader` from the lock file →
   **OK** (full production vendor tree built in the release).
3. Env validation → **OK** (`APP_ENV=production`, `APP_DEBUG=false`,
   non-empty `APP_KEY` enforced).
4. Pre-deploy backup gate → **proven fail-loud:** with no `pg_dump` on PATH
   the deploy stops with exit 1 *before* any migration, message:
   `refusing to deploy (migrations run against the live database and require a
   pre-deploy backup…)`.
5. Migrations on the fresh database from the production clone → **118/118 DONE**
   (the same migration path a first deploy executes).
6. `config:cache` + `route:cache` + `view:cache` → **OK**.
7. Atomic switch + health: `current` → release, then through the live front
   controller `GET /health` → **HTTP 200 in 101ms**
   `{"status":"ok","environment":"production","checks":{"database":"ok","application_key":"ok"}}`;
   `GET /login` → **HTTP 200**; `GET /.env` → **HTTP 404** (docroot is
   `public/` only — the env file is unreachable over HTTP).
8. `deploy.sh --rollback` with two releases present → **OK** (`current`
   restored to the previous release).
9. Refused deploy (step 4 gate) → the **live `current` pointer is untouched**;
   the failed release remains on disk, unlinked, for forensics.

### Environment constraint (explicit, inherited from P02/P4.2)

The sandbox ships **no PostgreSQL client tools** and the package mirrors here
cannot provide a PG ≥18 client (Debian bookworm caps at PG 15; the PGDG repo
and GNU/bison sources are unreachable; the PG 18.4 source build was attempted
and fails on the absent parser generators). Consequently the one path that
*requires* `pg_dump` — the file-based backup step inside a full `deploy.sh`
happy path — is **not executable in this sandbox**. It is proven by its
fail-loud behavior (items 4 and 9 above) and is carried as a **mandatory
pre-go-live host drill**:

1. On the target host (with `postgresql-client` ≥ server version): run a full
   `deploy/deploy.sh <good-ref>` and confirm the pre-deploy backup is produced
   in `BACKUP_DIR`, migrations run, the release goes live, and `/health` is 200.
2. Run `deploy/restore.sh <that-backup> --confirm` against a scratch database
   and verify (the P4.2 TEMPLATE drill already proved 104/104 tables +
   10/10 checksums at the engine level; this drill closes the file-based loop
   end to end on the production host).
3. Induce a failed release (e.g. a bad migration or an unhealthy build) and
   confirm the automatic rollback leaves the previous release live.

These three drills are the difference between "the script is correct" and
"the deployment was demonstrated on the production host." They are listed
here, not waived.

### Verdict

Deployment is ready subject to the host drills above. No speculative
infrastructure (no orchestrator, no container platform, no message broker) is
part of or assumed by the deployment; the release-symlink model is the entire
deployment system.

## P4.5 — Documents (this commit)

**Scope:** printing, branding, organization/branch identity, data authority.

**Finding fixed — document identity was resolved arbitrarily.** The `print.*` view composer (the single resolution point for document headers) picked `ORDER BY name LIMIT 1` over active organizations and active branches. Proven before fixing: with two active organizations, **every document — including The TOEFL House's own payment receipts — printed under "Alpha Institute" / an unrelated branch**. An official document carried an identity the structure does not determine.

**Fix (data authority, one source of truth).** Business records are institution-level (no record is branch-scoped in this schema), so the header states the institution:

- **organization** = the SINGLE active organization; with zero or multiple active candidates the document is branded with the institution name (`config('app.name')`) instead of picking a candidate — a header is only stated when the structure uniquely determines it;
- **branch** = the SINGLE active branch; with zero or multiple the branch line is omitted (never guessed).

Pinned by two permanent adversarial tests in `PrintingFeatureTest`: (1) two active orgs + two active branches → the receipt carries the institution brand and **neither** organization nor branch name; (2) one org + two branches → the org is stated, the branch line is omitted. (The zero-organization case is structurally unreachable — the access model always seeds an active bootstrap organization — so it is not tested as a business scenario.)

**Verified sound (no change needed):**

- **Branding/consistency:** all six document types (receipt, invoice, certificate, payroll slip, enrollment record, student ID) extend ONE print layout — A4 `@page` rules, `@media print` (screen chrome stripped), print/save-PDF button, institution header, document type + number, "Issued … by …" footer (the responsible user from the authenticated session), signature blocks. No per-document header forks.
- **Data authority:** documents render the SAME authoritative domain records the console reads (`Payment`, `Obligation`, `Certificate`, `PayrollResult`, `Enrollment`, `Student`) — printing computes nothing financial or academic itself; `docNo` is deterministic per source record (a reprint reproduces the same document number); the issue date is the print date.
- **No lazy relations in print views** (machine-checked: zero `->relation->` patterns; documents are single-entity, not looped collections).
**Second finding fixed (surfaced by this commit's full-suite gate) — a date-dependent test time bomb.** `ScaleContractVersionFeatureTest::test_amendment_supersedes_prior_version_and_backdating_is_rejected` used a fixed calendar date (a contract version effective `2026-09-01`); the domain correctly auto-activates an approved version whose effective date has arrived, so the test passed on 2026-08-31 and failed on 2026-09-01 — the assertion described a past date, not a rule. The **domain rule is correct and unchanged** (`effective_from <= today` → active on approval; future → approved); the test is now date-relative (effective dates computed from the run date) and holds on any date. The rest of the suite was scanned for the same pattern: other fixed-date tests assert on fixed *intervals* or in-window dates (no run-date boundary crossing) — no other time bombs. 

