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

