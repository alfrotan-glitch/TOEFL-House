# WP-2 F4-C — Calendar Authority Implementation Verification (independent review)

**Status:** `F4-C NOT VERIFIED — BLOCKED` (independent verification of the
Calendar Authority implementation/conformance suite; the implementation is
functionally correct for the range it serves, but it does not satisfy the
ratified D1/F4-B active-operational-window coverage requirement and the
repository full-suite quality gate is not green).
**Scope:** `app/Modules/Calendar` (CalendarAuthority + Domain value objects +
version-1 series) and `tests/Unit/Calendar/CalendarAuthorityTest.php` — the
production Calendar Authority implementation described by F4-B (WP-2 F4-B,
option C hybrid) and the conformance suite implied by F4-B §8.
**Branch:** `arena/01a0677c-toefl-house`
**Date:** 2026-09-03
**Reviewer:** independent agent (no authorship of the module code).

---

## 1. What was verified

The environment was rebuilt from the repository-backed recovery procedure.
`docs/environment/P02-environment-recovery.sh --recover` reached
`ENVIRONMENT VALID`, restoring PHP 8.2.27, Composer 2.10.2, Laravel 12.67.0,
PostgreSQL 18.4, vendor/, phpunit, phpstan and pint. The active databases
`toefl_house` / `toefl_house_test` were created and validated.

The Calendar Authority module was then verified independently (not by merely
re-running the existing unit test): a separate, exhaustive verification harness
was written against the real `CalendarAuthority` class and run.

---

## 2. Verification evidence (all execution-backed)

### 2.1 Canonical Calendar unit suite

```sh
php vendor/bin/phpunit tests/Unit/Calendar/CalendarAuthorityTest.php
```

Result: **OK (20 tests, 151 assertions)**.

### 2.2 Independent exhaustive runtime verification

A standalone harness (`/home/user/cal_verify.php`, not committed) exercised the
actual `App\Modules\Calendar\CalendarAuthority` class and asserted:

- Every ratified/derived reference vector in the F4-A.3 §7 acceptance set over
  the implemented served window (T01–T13, the corrected T03 =
  `30 Hut 1399 = 2021-03-20`, plus the 1407/1408 Kabul branch and the derived
  ordinary-date vectors).
- **Round-trip of every one of the 5,479 canonical days** in the served civil
  interval `[2020-03-20, 2035-03-21)` — forward → reverse and
  reverse → forward both return the original date.
- Month lengths/last days, year boundaries, leap flags and Hut lengths for every
  served year (1399–1413), comparing against the ratified Kabul series:
  `1399 L, 1403 L, 1407 L, 1412 L`, all other served years common.
- Fail-closed behavior: SH 1335/1426 (out-of-supported-range), SH 1398/1425
  (within supported range but not ratified), pre-1957 Gregorian dates,
  SH 1414 reverse/forward (see blocker 1), each raised the expected rejection
  code (`calendar.out_of_supported_range` / `calendar.year_not_ratified`).
- Version reproducibility and unknown-version rejection.
- Kabul civil-day mapping from a UTC instant (server timezone independent).

Result: **checks = 5913, failures = 0** (the 2 initial failures reported by the
harness were reviewer-expectation errors in the harness itself, not module
errors; they were corrected, then re-run clean).

### 2.3 Static quality gates

```sh
php vendor/bin/phpstan analyse --memory-limit=1G          # [OK] No errors (284 files)
php vendor/bin/pint --test app/Modules/Calendar app/Modules/Calendar/Domain tests/Unit/Calendar
# PASS (8 files)
php -l app/Modules/Calendar/*.php app/Modules/Calendar/Domain/*.php
# No syntax errors detected (7 files)
```

### 2.4 Architecture-boundary checks

- No reference to `CalendarAuthority` / `Calendar\` exists outside the Calendar
  module and its test (grep over `app`, `config`, `routes`, `bootstrap`,
  `resources` returned nothing). The single-authority boundary holds.
- No Shamsi/Hijri column or calendar schema change exists: grep over
  `database/migrations` returns only the governed-config registry migration's
  comment that it introduces no calendar conversion. No generic Jalali/Persian
  library is present in `composer.json`/`composer.lock`.
- Storage remains canonical Gregorian; Solar Hijri is derived only through the
  authority (G2 / WP2-DEC-04 respected).

---

## 3. Result for the served range

The implementation is **correct and well-tested for what it actually serves**:
- Version-1 series data matches the ratified Kabul branch.
- The 1407-leap / 1408-common divergence is encoded correctly
  (`2029-03-20 = 30 Hut 1407`, `2029-03-21 = 1 Hamal 1408`), and the test
  guards against the Tehran/arithmetic pattern.
- Forward/reverse are bijective over the served interval.
- Fail-closed on unratified/out-of-range input is deterministic.
- Static analysis, formatting and syntax are clean.
- No diverging second authority, no stored second date truth, no imported
  arithmetic calendar libraries.

---

## 4. Remaining blockers (why the gate cannot be marked VERIFIED)

### Blocker 1 — Ratified active operational window (SH 1399–1415) is not fully covered

- D1 (recorded in `WP2-approved-decisions.md` and F4-A.3 §12) and F4-B §2.3
  declare the active operational window **SH 1399–1415** and state it must be
  **100% vector-and-round-trip covered**.
- The implementation **serves only SH 1399–1413**. `Version1Series` pins anchors
  **1399–1414**; because a year is servable only when both its own and its
  successor's Nowruz are pinned (F4-B §2.8), the presence of an anchor for 1414
  without an anchor for 1415 means 1414 and 1415 both fail closed.
  Concretely:
  - `forward('2035-03-21')` → `calendar.year_not_ratified` (1 Hamal 1414).
  - `reverse(new SolarHijriDate(1414, 1, 1))` → `calendar.year_not_ratified`.
- F4-B §2.5 requires the implementation phase to **pin the 1336–1398 and
  1415–1425 tails from an authoritative ephemeris at build time, transform them
  by the Kabul rule, extend the vector set and ratify that extension as part of
  version-1 before serving those years**. That work is not present: the 1415
  anchor (1 Hamal 1415 = `2036-03-20` per the ratified F4-A.3 §4.2 row for
  1414) is not in `Version1Series`, and neither are the outer-range anchors.
- Consequence per the spec: the authority does not cover the institution's
  ratified active scheduling/reporting window (through 2037 ≈ SH 1415). The
  module's own comment acknowledges this range gap but the F4-B requirement it
  cites (`1415–1425`) does not read as optional; F4-B §2.3 explicitly requires
  100% active-window coverage.
- **Needed to unblock:** pin the 2036 (and beyond) equinox instants from an
  authorized ephemeris, ratify the resulting 1414/1415 (and 1336–1398,
  1415–1425) extension as part of version-1, add the anchors and extend the
  conformance vectors, and re-run the full conformance/round-trip suite. This is
  an owner-ratification + authoritative-data step, not a self-fix.

### Blocker 2 — Repository full-suite quality gate is not green

- `php vendor/bin/phpunit` (full suite): **Tests: 628, Assertions: 4326,
  Failures: 1, PHPUnit Deprecations: 1, Skipped: 2.**
- The single failure is
  `Tests\Feature\Governance\GovernedConfigFoundationTest::test_ratify_and_activate_valid_typed_values_versioning_audit_and_effective_resolution`
  (line 110: `assertSame($first['version_id'], $activateEvents[0]->target_id)`).
- This is **not** a Calendar/F4-C defect. It passes in isolation
  (`OK (1 test, 22 assertions)`) and when its full feature file is run
  (`OK (5 tests, 57 assertions)`). The failure is order/timing-dependent: the
  test orders audit rows only by `occurred_at` (`timestamp` column, second
  precision from `audit_events`), so two activations performed inside one test
  can share the same timestamp and the PostgreSQL row order becomes
  non-deterministic under full-suite load.
- Because the repository's standing quality standard treats a green full suite
  as a gate, this pre-existing S1 test flakiness prevents a clean full-suite
  verdict and must be remediated (e.g. order audit events by a deterministic
  secondary key such as id, or assert by target collection rather than `[0]`).

---

## 5. Honest verdict

- **Within the served range**, the F4-C Calendar Authority implementation is
  architecturally sound and functionally correct (verified independently at
  5,913 checks, 0 failures).
- **It cannot be marked `VERIFIED`** because the ratified active operational
  window is not covered (1414/1415 fail closed), and the repository's full-suite
  quality gate is not reliably green due to an unrelated flaky Governance test.

No commit was made to mark F4-C VERIFIED. This record is the honest verification
result and blockers; the unblocking actions are specified above.
