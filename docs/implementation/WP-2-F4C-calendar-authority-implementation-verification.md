# WP-2 F4-C — Calendar Authority Implementation Verification (independent review)

**Status:** `F4-C VERIFIED`

The version-1 Calendar Authority now covers the entire approved active
operational window **SH 1399–1415** (Gregorian `2020-03-20` → `2037-03-20`
exclusive), with the supported deterministic range **SH 1336–1425** unchanged.
The owner-ratified completion anchor `1 Hamal 1416 = 2037-03-20` is incorporated
as a version-1 anchor, and every available canonical quality/conformance gate is
green for the verified scope.

**Scope:** `app/Modules/Calendar` (CalendarAuthority + Domain value objects +
version-1 series) and the conformance/quality tests touched by the F4-C
verification: `tests/Unit/Calendar/CalendarAuthorityTest.php`,
`tests/Feature/Governance/GovernedConfigFoundationTest.php`,
`tests/Feature/Organization/StructureLifecycleFeatureTest.php`.

**Branch:** `arena/01a0677c-toefl-house`
**Date:** 2026-09-04
**Reviewer:** independent agent (no authorship of the module code).

---

## 1. Ratification incorporated

On 2026-09-04 the architecture owner ratified **`1 Hamal 1416 = 2037-03-20`**
as a version-1 Calendar Authority anchor, completing the D1 active operational
window SH 1399–1415. Formal reference:

- `docs/architecture/decisions/WP2-approved-decisions.md` — F4-C
  active-window completion ratification (2026-09-04).
- `docs/implementation/WP-2-F4A.3-solar-hijri-reference-series-ratification.md`
  — §13 ratification addendum (anchor, equinox input, Kabul transform, explicit
  non-extension of the 1416–1425 / 1336–1398 tails).

Astronomical input: 2037 vernal equinox `2037-03-20 06:50 UTC` (authoritative
equinox table, minute-level cross-check). Kabul transform under D2: 06:50 UTC =
11:20 AFT, before Kabul civil noon (12:00 AFT = 07:30 UTC), so `2037-03-20` is
the civil first day of Hamal 1416.

---

## 2. What was verified and how

The repository was verified independently (not by merely re-running the existing
unit test): a separate exhaustive harness loads the **actual**
`App\Modules\Calendar\*` production files and exercises the real
`CalendarAuthority` class. The canonical project environment was rebuilt via
`docs/environment/P02-environment-recovery.sh --recover`
(`ENVIRONMENT VALID`; PHP 8.2.27, Composer 2.10.2, Laravel 12.67.0,
PostgreSQL 18.4, vendor/, phpunit, phpstan, pint) before the gates below.

### 2.1 Canonical Calendar unit suite

```sh
php vendor/bin/phpunit tests/Unit/Calendar/CalendarAuthorityTest.php
```

Result: **OK (21 tests, 177 assertions)**.

### 2.2 Independent exhaustive runtime verification

A standalone harness (`/home/user/cal_verify.php`, not committed) exercised the
actual `App\Modules\Calendar\CalendarAuthority` class and asserted:

- Every ratified reference vector in the served window, forward and reverse
  (Nowruz 1399–1415, including the 1407/1408 Kabul divergence).
- **Exhaustive round-trip of every one of the 6,209 canonical civil days** in
  the served interval `[2020-03-20, 2037-03-20)` — forward → reverse returns
  the original day.
- Month lengths/last days, year boundaries, leap flags and Hut lengths for every
  served year (1399–1415): handled leap years `1399, 1403, 1407, 1412`; every
  other served year common, including 1414 and 1415 (Hut 29; last served day
  `2037-03-19`).
- Range metadata: supported `[1336, 1425]`, served `[1399, 1415]`.
- Fail-closed behavior: SH 1398, 1416, 1417, 1425 → `calendar.year_not_ratified`;
  SH 1335, 1426 and pre-1957 Gregorian dates → `calendar.out_of_supported_range`;
  `2037-03-20` (1 Hamal 1416) is the exclusive served end and is rejected.
- Version reproducibility (`v1` only) and unknown-version rejection.
- Kabul civil-day mapping from a UTC instant (server timezone independent) and
  fixed `currentBusinessDate()` scheduling at Kabul civil day.
- `addDays` boundary guard (stepping off the last served day fails closed).

Result: **checks = 6,308, failures = 0** (the exhaustive 6,209-day loop is
6,209 of those checks).

### 2.3 Repository quality gates

```sh
php vendor/bin/phpunit
# OK, but there were issues!
# Tests: 629, Assertions: 4357, PHPUnit Deprecations: 1, Skipped: 2.  (exit 0)

php vendor/bin/phpstan analyse --memory-limit=1G
# [OK] No errors (284 files)

php vendor/bin/pint --test \
  app/Modules/Calendar/Domain/Version1Series.php \
  tests/Unit/Calendar/CalendarAuthorityTest.php \
  tests/Feature/Governance/GovernedConfigFoundationTest.php \
  tests/Feature/Organization/StructureLifecycleFeatureTest.php
# PASS (4 files)

php -l app/Modules/Calendar/Domain/Version1Series.php
php -l tests/Unit/Calendar/CalendarAuthorityTest.php
php -l tests/Feature/Governance/GovernedConfigFoundationTest.php
php -l tests/Feature/Organization/StructureLifecycleFeatureTest.php
# No syntax errors detected (4 files)
```

Repository-wide `pint --test` still reports **3 pre-existing, unrelated style
issues** in `deploy/windows/launcher_helper.php`, `e2e-journey.php`, and
`tests/Unit/Launcher/WindowsLauncherContractTest.php`. These are outside the
F4-C/Calendar scope and are not caused by or necessary for this verification;
the F4-C touched files are all Pint-clean.

### 2.4 Architecture-boundary checks

- No reference to `CalendarAuthority` / `Calendar\` exists outside the Calendar
  module and its tests.
- No Shamsi/Hijri column or calendar schema change exists; no generic
  Jalali/Persian library is present in `composer` metadata.
- Storage remains canonical Gregorian; Solar Hijri is derived only through the
  authority (G2 / WP2-DEC-04 respected).
- The supported deterministic range is unchanged at SH 1336–1425; no expansion
  beyond the approved active window 1399–1415 was introduced. The 1416–1425 and
  1336–1398 tails continue to fail closed (`calendar.year_not_ratified`).

---

## 3. Honest verdict

- **Within the ratified active operational window SH 1399–1415**, the F4-C
  Calendar Authority implementation is architecturally sound and functionally
  correct: independently executed against the real classes at 6,308 checks /
  0 failures, including exhaustive round-trip of all 6,209 served civil days,
  with the canonical Calendar unit suite green and the full repository suite
  green (629 tests / 4,357 assertions / exit 0).
- The previous blockers are resolved:
  - **Blocker 1 resolved:** the active operational window is now fully covered;
    the owner-ratified `N(1416) = 2037-03-20` anchor is in `Version1Series`, and
    the served range is SH 1399–1415.
  - **Blocker 2 resolved:** the order-dependent audit assertions are now
    deterministic (correlated by known `target_id` / compared as a canonical
    set), and the full repository suite is green.
- **Result: `F4-C VERIFIED`.** No F4-C blocker remains. The 3 unrelated
  repository-wide Pint issues are pre-existing, outside the verified F4-C scope,
  and are noted for the record rather than treated as F4-C blockers.
- **Post-verification addendum (2026-09-04):** the 3 repository-wide Pint issues
  were subsequently resolved (repo-wide Pint is now clean, 531 files), and the
  mission continues on the approved WP-2 F1/F2/F3 foundations. These do not
  change any F4-C conclusion.
