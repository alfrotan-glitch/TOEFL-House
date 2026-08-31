# FINAL RELEASE CERTIFICATION — The TOEFL House

**Date:** 2026-08-31
**Base commit:** `8800c18` (PHASE_3 E.5 — last runtime-verified state)
**Branch:** `arena/01a056f4-toefl-house`

---

## STATUS: NO-GO — INSUFFICIENT RUNTIME EVIDENCE

This certification **cannot** be completed as a FINAL RELEASE because the runtime environment cannot be restored in this sandbox. The runtime gates are the authoritative verification — static analysis supplements but does not replace them.

### Runtime Verification (from commit 8800c18)

The previous session that created commit `8800c18` **actually executed the full runtime gate set**:

```
gates: phpunit OK (489, 3344); phpstan L6 0; pint PASS (483 files)
```

This is the last runtime-verified state. The current branch HEAD is this commit.

### Reconciliation of Test Counts

| Source | Tests | Assertions | Method |
|---|---|---|---|
| Commit 8800c18 message (runtime) | **489** | **3,344** | `phpunit` execution |
| Source-level grep | 476 | 1,337 (`$this->assert*`) | Static `grep "function test_"` |
| Delta | +13 tests | +2,007 assertions | PHPUnit internal counting |

**Explanation of delta:** PHPUnit's runtime count (489) exceeds the static grep count (476 `function test_` methods) because PHPUnit includes inherited test methods, trait-contributed tests, and parameterized test expansions. PHPUnit's assertion count (3,344) exceeds the `$this->assert*` grep (1,337) because PHPUnit counts all assertion types including `expectException`, internal framework assertions, and implicit assertions from matchers. **The runtime count (489/3344) is authoritative.**

### Source Code Has Not Changed

```
git diff 8800c18..HEAD -- app/ tests/ database/ → empty
```

The source code at HEAD is byte-identical to the runtime-verified commit. No test file, no command, no migration, no model has been modified since the last green gate.

---

## What This Session Attempted

1. ✅ Verified remote HEAD matches local HEAD (`8800c18`)
2. ✅ Performed comprehensive static analysis (all 10 gates)
3. ✅ Identified and fixed 2 branding defects:
   - `config/logging.php`: Slack fallback changed from `'Laravel'` → `'The TOEFL House'`
   - `docs/environment/P02-environment-baseline.md`: `APP_NAME` changed from `"TOEFL House"` → `"The TOEFL House"`
4. ❌ **Cannot execute runtime gates** — environment unrecoverable

---

## ENVIRONMENT BLOCKER — EXACT TECHNICAL ROOT CAUSE

### Network Connectivity Matrix (verified this session)

| Endpoint | Status | Required For |
|---|---|---|
| `api.github.com` | ✅ HTTP 200 | Git operations, release metadata |
| `github.com` | ✅ HTTP 200 | Git clone, web UI |
| `release-assets.githubusercontent.com` | ❌ BLOCKED | **Prebuilt toolchain download** |
| `objects.githubusercontent.com` | ❌ BLOCKED | Asset file download |
| `deb.debian.org` | ❌ BLOCKED | apt package installation |
| `packagist.org` | ❌ BLOCKED | Composer package resolution |
| `www.php.net` | ❌ BLOCKED | PHP source download |

### Recovery Attempt Log

| Method | Result | Detail |
|---|---|---|
| `apt-get install php8.2 postgresql` | ❌ BLOCKED | `deb.debian.org` unreachable |
| `gh release download p02-artifacts` | ❌ BLOCKED | `release-assets.githubusercontent.com` returns EOF — prebuilt toolchain (78MB) and vendor (38MB) bundles cannot be downloaded |
| `P02-environment-recovery.sh --recover` | ❌ TIMEOUT | Falls back to source build; OpenSSL compilation from source exceeds sandbox timeout |
| Direct `wget`/`curl` to release CDN | ❌ BLOCKED | Same CDN block |

### What's Missing

- PHP 8.2.27 (CLI + extensions: pdo_pgsql, pgsql, mbstring, bcmath, openssl, curl, xml, intl)
- PostgreSQL 18.4 (or any 13+)
- Composer 2.10.2
- `vendor/` directory (from `composer install`)
- `toefl_house` database

### Prebuilt Artifacts Exist But Are Unreachable

The previous session created checksummed prebuilt bundles and published them to GitHub Release `p02-artifacts`:
- `p02-toolchain-1.tar.gz` (78MB) — PHP, libs, tools, PostgreSQL
- `p02-vendor-1.tar.gz` (38MB) — composer vendor/
- `p02-manifest.json` — checksums + version pins

These are at `https://github.com/alfrotan-glitch/TOEFL-House/releases/tag/p02-artifacts` but the CDN serving release asset downloads (`release-assets.githubusercontent.com`) is **network-blocked** in this sandbox.

---

## STATIC ANALYSIS RESULTS (Supplementary — Not Authoritative)

These results are evidence from code review, NOT runtime verification. They supplement but do not replace the runtime gates.

### Code Quality

| Check | Finding |
|---|---|
| TODO/FIXME/HACK in production code | **0** |
| `$guarded = []` (mass-assignment risk) | **0** — all 99 models use explicit `$fillable` |
| `{!! !!}` with user data in views | **0** — all output uses auto-escaped `{{ }}` |
| Controllers with business logic | **0** — all delegate to commands |
| `declare(strict_types=1)` in production files | **All** |
| Models/Commands declared `final` | **All** |

### Branding Audit

| Location | Status |
|---|---|
| `config/app.php` | ✅ `'The TOEFL House'` |
| `.env.example` | ✅ `"The TOEFL House"` |
| `phpunit.xml` | ✅ `"The TOEFL House"` |
| Layout (title, header, footer) | ✅ `The TOEFL House` |
| Login page | ✅ `Sign in to The TOEFL House` |
| Health endpoint | ✅ `"service": "The TOEFL House"` |
| Print layout | ✅ Dynamic from Organization model |
| Session cookie | ✅ `toefl_house_session` |
| `config/logging.php` Slack fallback | ⚠️ **Was `'Laravel'`** — fix in working tree |
| `docs/environment/P02-environment-baseline.md` | ⚠️ **Was `"TOEFL House"`** — fix in working tree |

### Architecture Verification (Static)

| Criterion | Evidence |
|---|---|
| One source of truth per concept | 15 modules, each owning distinct entities |
| One command per state change | 78 commands, each with unique CAPABILITY constant |
| Authorization default-deny | `AccessResolution::decide()` returns `Decision::deny()` when no grant resolves |
| SoD enforced | Actor comparison in refund, admission (3-stage), payroll (triple), settlement, corrections |
| Idempotency | `IdempotentExecution` with SHA-256 payload hash + conflicting-payload rejection |
| Audit append-only | Model guard + PostgreSQL trigger `audit_events_append_only()` |
| Pessimistic locking | `lockForUpdate()` in every state-changing transaction |
| Schema invariants | 55+ partial unique indexes (tested by `SchemaInvariantFeatureTest`) |
| Financial period guards | Migrations 101-109 CHECK constraints + triggers |

### Pending Changes (Uncommitted)

```
 M config/logging.php                              # Slack fallback → 'The TOEFL House'
 M docs/environment/P02-environment-baseline.md    # APP_NAME → "The TOEFL House"
?? docs/certification/                              # This document
```

---

## RUNTIME GATES — STATUS

| Gate | Can Execute? | Status |
|---|---|---|
| `/runtime` (environment restore) | ❌ | BLOCKED — CDN unreachable |
| `/migrate:fresh` | ❌ | Requires PHP + PostgreSQL |
| `/phpunit` | ❌ | Requires vendor/ + PostgreSQL |
| `/phpstan` | ❌ | Requires vendor/ |
| `/pint` | ❌ | Requires vendor/ |
| `/schema-invariants` | ❌ | Requires PHPUnit |
| `/health` | ❌ | Requires running server |
| `/backup` | ❌ | Requires PostgreSQL |
| `/restore` | ❌ | Requires PostgreSQL |
| `/deployment` | ❌ | Requires full stack |
| `/rollback` | ❌ | Requires full stack |
| `/concurrency` | ❌ | Requires PHPUnit |
| `/idempotency` | ❌ | Requires PHPUnit |
| `/http-e2e` | ❌ | Requires running server |
| `/frontend-e2e` | ❌ | Requires running server |
| `/adversarial` | ❌ | Requires PHPUnit |

---

## VERDICT

**NO-GO — INSUFFICIENT RUNTIME EVIDENCE**

The repository code at `8800c18` was runtime-verified in a previous session with `phpunit OK (489, 3344); phpstan L6 0; pint PASS (483 files)`. No source code has changed since then. The branding fixes in the working tree are cosmetic (no behavioral impact) and do not require re-verification of the test suite.

However, this session **cannot independently re-execute the runtime gates** because the prebuilt environment artifacts are unreachable (CDN blocked) and the source-build fallback exceeds the sandbox timeout.

### What's Needed to Complete

In a session with network access to `release-assets.githubusercontent.com`:

```bash
# 1. Restore environment
./docs/environment/P02-environment-recovery.sh --recover

# 2. Verify environment
./docs/environment/P02-environment-recovery.sh --verify

# 3. Run full gate set
vendor/bin/phpunit
vendor/bin/phpstan analyse
vendor/bin/pint --test

# 4. Fresh migration
php artisan migrate:fresh

# 5. Health check
php artisan serve &
curl -fsS http://localhost:8000/health

# 6. Commit branding fixes
git add config/logging.php docs/environment/P02-environment-baseline.md
git commit -m "GATE 6: normalize branding to 'The TOEFL House'"
git push origin arena/01a056f4-toefl-house
```

If all pass: release certification is complete.
