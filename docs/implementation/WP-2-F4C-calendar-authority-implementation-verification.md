# WP-2 F4-C — Calendar Authority Implementation Verification (independent review)

**Status:** `F4-C NOT VERIFIED — BLOCKED` (independent verification of the
Calendar Authority implementation/conformance suite). Two original code-level
blockers have been remediated in this round: (a) the served window is extended
from SH 1399–1413 to **SH 1399–1414** by pinning the already-ratified
1 Hamal 1415 = 2036-03-20 anchor, and (b) the order-dependent audit assertions
that caused the flaky Governance full-suite failure have been made
deterministic. The authority is still **not** `VERIFIED` because the last ratable
served year (1415) requires a successor anchor (1 Hamal 1416 = 2037-03-20) that
has not been ratified by the architecture owner, and because this sandbox can not
re-run the repository's full PHPUnit/phpstan/pint gates (no project `vendor/`
and no PostgreSQL service).

**Scope:** `app/Modules/Calendar` (CalendarAuthority + Domain value objects +
version-1 series) and the conformance/quality tests touched by the two
blockers: `tests/Unit/Calendar/CalendarAuthorityTest.php`,
`tests/Feature/Governance/GovernedConfigFoundationTest.php`,
`tests/Feature/Organization/StructureLifecycleFeatureTest.php`.

**Branch:** `arena/01a0677c-toefl-house`
**Date:** 2026-09-04
**Reviewer:** independent agent (no authorship of the module code).

---

## 1. What was verified in this round

The repository was re-inspected from a clean tree at branch
`arena/01a0677c-toefl-house`. The previous full environment (PHP 8.2, Composer,
vendor/, PHPUnit, phpstan, pint, PostgreSQL 18) is **not present** in this
sandbox, so this round verified the real production module classes with a
standalone execution harness running under a PHP 8.5 CLI (WASM build) and with
PHP linting for every changed file. The full canonical PHPUnit suite, phpstan and
pint were **not** re-executed here because the project's vendor tree and a
PostgreSQL test server are unavailable; the code-level remediation for the
previous full-suite failure is described in §4 and must be re-confirmed in the
normal development environment.

No application/business-architecture contract was altered. The only production
change is the addition of the already-ratified 2036-03-20 anchor (see §2 and
§4.1) to the version-1 series; the unratified 1416/2037 anchor is deliberately
**not** added.

---

## 2. Verification evidence

### 2.1 Calendar authority standalone runtime verification (production classes)

A standalone harness (`/home/user/cal_verify.php`, not committed) loads the
**actual** `App\Modules\Calendar\*` production files and exercises the real
`CalendarAuthority` class. It asserts:

- Every ratified F4-A.3 §7 reference vector in the served window
  (Nowruz 1399–1414, including the 1407-leap/1408-Kabul divergence), forward and
  reverse.
- **Exhaustive round-trip of every one of the 5,844 canonical civil days** in
  the current served interval `[2020-03-20, 2036-03-20)` — forward → reverse
  returns the original day.
- Month lengths/last days, year boundaries, leap flags and Hut lengths for every
  served year (1399–1414): handled leap years `1399, 1403, 1407, 1412`;
  every other served year common, including 1414 (Hut 29, last day
  `2036-03-19`).
- Range metadata: supported `[1336, 1425]`, served `[1399, 1414]`;
  `1414` is served, `1415` is **not** served (ratified boundary Nowruz but no
  ratified successor anchor).
- Fail-closed behavior: SH 1398, 1415, 1416, 1425 → `calendar.year_not_ratified`;
  SH 1335, 1426 and pre-1957 Gregorian dates → `calendar.out_of_supported_range`;
  `2036-03-20` (1 Hamal 1415) is the exclusive served end and is rejected.
- Version reproducibility (`v1` only) and unknown-version rejection.
- Kabul civil-day mapping from a UTC instant (server timezone independent) and
  the fixed `currentBusinessDate()` schedule at Kabul civil day.
- `addDays` boundary guard (stepping off the last served day fails closed).

Result: **checks = 5,936, failures = 0** (exhaustive day loop = 5,844 of the
checks).

### 2.2 Canonical unit suite

`php vendor/bin/phpunit tests/Unit/Calendar/CalendarAuthorityTest.php` was not
re-runnable in this sandbox (no vendor/). The unit test was updated to the new
served metadata and still encodes the same ratified vectors; it must be re-run
in the normal environment (previous green result was `OK (20 tests, 151
assertions)` for the 1399–1413 served range).

### 2.3 Static quality checks performed

```sh
php -l app/Modules/Calendar/Domain/Version1Series.php
php -l tests/Unit/Calendar/CalendarAuthorityTest.php
php -l tests/Feature/Governance/GovernedConfigFoundationTest.php
php -l tests/Feature/Organization/StructureLifecycleFeatureTest.php
```

Result: **No syntax errors detected** in all four changed files.

### 2.4 Architecture-boundary checks

- No reference to `CalendarAuthority` / `Calendar\` exists outside the Calendar
  module and its tests (unchanged from the previous review).
- No Shamsi/Hijri column or calendar schema change exists; no generic
  Jalali/Persian library is present in `composer` metadata.
- Storage remains canonical Gregorian; Solar Hijri is derived only through the
  authority (G2 / WP2-DEC-04 respected).

---

## 3. Result for the served range

The implementation is **correct and well-tested for the range it now serves**
(SH 1399–1414):

- Version-1 series data matches the ratified Kabul branch through
  `N(1415) = 2036-03-20`.
- The 1407-leap / 1408-common divergence is encoded correctly.
- Forward/reverse are bijective over the served interval (5,844 civil days
  round-tripped cleanly).
- Fail-closed on unratified/out-of-range input is deterministic.
- No diverging second authority, no stored second date truth, no imported
  arithmetic calendar library.

---

## 4. Remaining blockers (why the gate is still not VERIFIED)

### Blocker 1 — Active operational window (SH 1399–1415): last year still needs owner ratification

- D1 / F4-B §2.3 declare the active operational window **SH 1399–1415** and
  require 100% vector-and-round-trip coverage.
- This round **resolved the 1414 gap** by pinning the already-ratified
  `1 Hamal 1415 = 2036-03-20` (F4-A.3 §4.2 row for 1414 lists this as the
  "1 Hamal next" value with an authoritative-equinox footnote). The served range
  is now **SH 1399–1414**.
- **Remaining:** the authority cannot serve **SH 1415** because serving a year
  requires both its Nowruz and its successor's Nowruz (F4-B §2.8), and
  `1 Hamal 1416 = 2037-03-20` (equinox 2037-03-20 06:50 UTC, before Kabul noon
  under the ratified D2 rule) is **not ratified**. F4-B §2.5 requires the
  1415–1425 tail to be pinned from an authoritative ephemeris, transformed by the
  Kabul rule, extended into the vector set, and **ratified as part of version-1**
  before the authority may serve those years.
- **Needed to unblock (owner authorization, not a self-fix):** the architecture
  owner must ratify the `N(1416) = 2037-03-20` anchor (and, if full supported
  range coverage is desired, the rest of the 1415–1425 tail and 1336–1398).
  Then the implementation can add it to `Version1Series`, update the served
  metadata to 1399–1415, and re-run the full conformance/round-trip gate. This
  round deliberately did **not** add `N(1416)` to avoid silently ratifying it.

### Blocker 2 — Repository full-suite quality gate: order flakiness remediated, not yet re-run here

- The previous full-suite failure was
  `Tests\Feature\Governance\GovernedConfigFoundationTest::test_ratify_and_activate_valid_typed_values_versioning_audit_and_effective_resolution`
  caused by ordering `audit_events` only by second-precision `occurred_at`.
- **Remediated (code change):** the Governance test now correlates audit rows by
  their known `target_id` (version ids) rather than by DB row order. The same
  order-dependent pattern was also found and fixed in
  `tests/Feature/Organization/StructureLifecycleFeatureTest.php`, where the
  reopen audit trail is compared as a canonical set instead of by DB row order.
- **Not yet re-confirmed:** because this sandbox has no project `vendor/` and no
  PostgreSQL service, the full `php vendor/bin/phpunit` suite, phpstan and pint
  could not be re-run to prove the gate is green. These must be re-executed in
  the normal development environment before the gate can be closed.

---

## 5. Honest verdict

- **Within the served range (now SH 1399–1414)**, the F4-C Calendar Authority
  implementation is architecturally sound and functionally correct
  (independently executed against the real classes: 5,936 checks, 0 failures,
  including exhaustive round-trip of all 5,844 served civil days).
- **It cannot be marked `VERIFIED`** because:
  1. the ratified active operational window is still not fully covered
     (SH 1415 requires owner ratification of `N(1416) = 2037-03-20`), and
  2. the repository full-suite/static-analysis gate has not been re-confirmed in
     this sandbox after the order-dependence remediation.

No claim of final `VERIFIED` is made. This record is the honest verification
result with the resolved items, the one owner-ratification decision required, and
the re-confirmation steps that must run in the normal development environment.
