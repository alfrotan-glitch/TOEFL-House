# WP-2 F4-B — Calendar Authority Implementation Design (design/spec, no code)

**Status:** `F4-B DESIGN COMPLETE` (design/spec only).
**Overall WP-2 status line:** `WP-2 PARTIAL — F1/F2/F3/S1 COMPLETE, F4-A VERIFIED, F4-B DESIGN COMPLETE, F4 IMPLEMENTATION PENDING`.
**Basis:** WP2-DEC-04 / G2 (approved); F4-A record; F4-A.3 reference-series spec;
F4-A.4 owner ratification D1–D4 (commit `9bc8cec`); S1 governed_configs (commit
`2c92857`); existing date-bearing domains.
**Branch:** `arena/01a062e3-toefl-house`
**Date:** 2026-09-03

This artifact is a **design/specification only**. It makes **no** code, migration,
model, service, config, seeder, or schema change. It does **not** start F4
implementation. Any reference to "the implementation" below describes a future,
later, separately-gated phase that must still be authorized.

---

## 1. Governing inputs (re-read summary)

- **WP2-DEC-04 (G2):** Shamsi-first business semantics; single canonical
  Gregorian/ISO stored date; authoritative, immutable, versioned Shamsi
  derivation; conversion is a pure function of `(canonical date, calendar-algorithm
  version)`; no dual stored date truths; DB range arithmetic and proration run on
  the canonical date; snapshots store canonical date + version for reproducibility;
  calendar scheme is org-wide (not branch-scoped).
- **F4-A / F4-A.2 / F4-A.3 / F4-A.4:** the calendar is the Afghan civil Solar
  Hijri (Hejrah-e Shamsi), Dari month names, equinox-observed, fixed
  31/30/30/29-30 structure, epoch the Hijra; noon-cutoff civil-day rule; version-1
  reference series (F4-A.3 §4) with vectors T01–T17 (F4-A.3 §7); ratified by
  **D1–D4** (Kabul AFT UTC+04:30 civil clock; supported range SH 1336–1425;
  active window SH 1399–1415; version-1 series authority; arithmetic only a
  validated implementation mechanism, never sole authority).
- **S1 / governed_configs:** an existing typed, versioned, audited, append-only,
  effective-window governed registry (Governance module, `governed_configs` +
  `governed_config_definitions`). This is the natural mechanism on which the
  calendar version pointer and the ratified-series ratification should rest —
  consistent with G2 ("calendar scheme" is a hard-coded invariant; the ratified
  algorithm/table *version* is a governed config record).
- **Existing date-bearing domains:** audited in §6 (canonical Gregorian date and
  `*_at` timestamp columns only; no Shamsi column exists).

### Non-negotiables carried into the design
1. Kabul AFT (UTC+04:30) is the **reference civil clock for the noon-cutoff rule
   only** — it is a ratified TOEFL House product decision (D2), **not** an
   external Afghan legal/astronomical authority, and **not** the server local
   timezone.
2. The **astronomical equinox instant** (a UTC point in time) is distinct from the
   **civil first day of Hamal** (a Kabul-clock calendar day). Only the latter
   drives calendar math. Equinox instants are preserved as informational pinned
   data for audit, never used as the civil-day source.
3. The **1408 divergence** is the documented reason D2 matters; the version-1
   series encodes the Kabul branch (1 Hamal 1408 = 2029-03-21).

---

## 2. Calendar Authority contract

### 2.1 Canonical (stored) representation
- **Civil business date:** a **Gregorian civil date** (`DATE`, proleptic
  Gregorian: year–month–day, no time, no zone). This is the **single stored
  representation** for every business date in the ERP. No Shamsi column is ever
  added (G2). All DB range predicates and proration run on this column.
- **Instant/timestamp:** events that need a time-of-day store a **timestamp**
  carried in **UTC** (a `timestamptz` stored and normalized to UTC), never a
  timezone-less "local" timestamp and never the server local timezone. The
  Calendar Authority uses instants only to derive a Kabul civil day when
  required (e.g., an event's civil day under the Kabul clock), and only via the
  explicit Kabul AFT mapping — never the process timezone.
- **Internal solar Hijri date:** an immutable value object `SHDate{year, month,
  day}` used transiently for computation/validation, never persisted as a second
  truth.

### 2.2 Solar Hijri business representation
- `SHDate(y, m, d)`: `y` ∈ **1336–1425** (supported deterministic range);
  `m` ∈ 1..12 in Dari order (1 Hamal … 12 Hut); `d` ∈ 1..`daysIn(Hut? month)`.
  Month lengths fixed: 1–6 = 31, 7–11 = 30, 12 (Hut) = 29/30 (leap-dependent).
- Period identity: a SH **year** and **month** (and the financial/payroll/academic
  period keyed on them) derive only from the civil Nowruz day of the ratified
  series.

### 2.3 Range & window (D1)
- **Supported deterministic range:** SH **1336–1425** (Gregorian ~1957–~2047).
  Any date mapping outside this range returns an explicit **out-of-range** result
  (fail-closed).
- **Active operational window:** SH **1399–1415** — the window fully covered by
  the ratified F4-A.3 series/vectors; must be 100% vector-and-round-trip covered.
- Pre-1957 / pre-1336 civil dates (variable-length months) are **out of the
  automated range**: fail-closed, require manual human-verified treatment; never
  auto-derived.

### 2.4 Reference civil clock, noon-cutoff rule, and Nowruz
- **Reference civil clock:** Kabul AFT = UTC+04:30 (ratified D2; product
  decision, not an external mandate).
- **Noon-cutoff rule:** for the Gregorian day containing the vernal equinox, if
  the equinox instant is **before Kabul civil noon (12:00 AFT)** that day is
  **1 Hamal**; if **at/after Kabul noon**, that day is the last day of the prior
  SH year (Hut) and **the following day is 1 Hamal**.
- **1 Hamal per year is pinned by the ratified version-1 series** (§2.5). The
  noon rule is the *semantics*; the series is the *governing data* (so no year is
  computed from a bare equinox UTC table at runtime without going through the
  ratified series).

### 2.5 Version-1 reference series (D3/D4)
- The **version-1 dataset** = the F4-A.3 §4.1 equinox UTC instants transformed by
  the Kabul noon-cutoff rule (D2) into the §4.2 Kabul-reference Nowruz days, plus
  the derived year lengths / leap flags / Hut lengths and the §5.7 month-boundary
  structure. Vectors **T01–T17** (F4-A.3 §7) are the initial acceptance set;
  REQ-D2 rows resolve to the Kabul branch (T12 = 1 Hamal 1408 = **2029-03-21**).
- The series is authoritative **for supported dates**. For the 1336–1398 and
  1415–1425 tail not fully tabulated in F4-A.3, the implementation phase must pin
  equinox instants from an authoritative ephemeris at build time, transform them
  by the same Kabul rule, extend the vector set accordingly, and ratify that
  extension as part of version-1 before the authority may serve those years.

### 2.6 Forward conversion (canonical Gregorian → SHDate)
- Input: a Gregorian civil date `G` (year/month/day) within supported Gregorian
  range corresponding to SH 1336–1425.
- Rule: locate the SH year `Y` whose civil Nowruz day `N(Y) ≤ G < N(Y+1)`;
  `Y` = year whose `N(Y)` is the greatest pinned Nowruz ≤ `G`. Then compute
  `(m,d)` by stepping month first-days from `N(Y)` using fixed month lengths.
- Edge: a Gregorian day `G` that equals a Nowruz day belongs to that SH year's
  1 Hamal. `G` strictly before the earliest pinned Nowruz in the supported range
  or at/after the last → out-of-range/fail-closed.

### 2.7 Reverse conversion (SHDate → canonical Gregorian)
- Input: valid `SHDate(y,m,d)`.
- Rule: take pinned `N(y)`; add month lengths of months `< m` to get the first
  day of month `m`; add `d−1`. Output the resulting Gregorian civil date.
- Bijective with forward within the supported range (guaranteed by the no-gap,
  no-overlap series).

### 2.8 Month/day validation and leap determination
- `validateDate(SHDate)`: month in 1..12; day in 1..daysIn(year,month); year in
  1336..1425. Reject (explicit invalid) otherwise.
- **Leap determination:** `leap(Y) ⟺ N(Y+1) − N(Y) = 366` days (from the series).
  `hutDays(Y) = 30` iff leap else 29. **No arithmetic formula** is ever the
  source of truth; an arithmetic algorithm may be used only after it is shown to
  reproduce the series for every year it serves (validated mechanism, §3/§4).

### 2.9 Year/month boundary semantics
- Year `Y` = interval `[N(Y), N(Y+1))` in canonical days.
- Month `m` of year `Y` = from its first day up to but not including the first
  day of month `m+1`; month 12 runs from its first day up to `N(Y+1)`.
- A financial/payroll/academic **period keyed on a SH month** therefore maps to an
  exact canonical `[start, end)` interval, never an approximate Gregorian month.

### 2.10 Date arithmetic semantics
- All arithmetic is done **on canonical Gregorian dates** (G2) — e.g., add N days,
  month/year boundaries, proration day counts. The result is then re-labelled to
  SH via the authority. SH is never used as an arithmetic base; only as an
  identity/period label and for validation.
- Business-day / proration semantics that a consumer needs are defined once here
  (calendar days unless a consumer explicitly defines working-days on top), so no
  module re-invents "a month" or "a day."

### 2.11 Historical reproducibility
- A conversion result is reproducible iff both inputs are retained:
  `(canonical date, calendar version id)`. Every record/snapshot that displays a
  Shamsi label stores (or can recover) the canonical date **and** the calendar
  version id in force. Re-running `forward(G, version)` always yields the same
  SHDate because each version pins its series immutably.
- No stored second date; no in-place series edits (a revision is a new version).

### 2.12 Fail-closed and invalid/ambiguous input behavior
- Outside supported range (SH < 1336, > 1425; Gregorian outside the
  corresponding civil span): explicit **out-of-range** outcome — no silent
  fallback/approximation.
- Invalid SH (month 0/13, day 0/too-large, non-integer): explicit **invalid**
  outcome.
- Ambiguous/non-applicable (e.g., a time-of-day question outside civil-date
  semantics): explicit domain error; no default assumption.
- Any consumer that cannot resolve a governed value/date **must fail closed**, not
  guess (consistent with S1 fail-closed-on-absence).

---

## 3. Authority precedence (explicit)

```
1. RATIFIED REFERENCE SERIES (authoritative)  — the governing truth for civil
   year start (1 Hamal), Nowruz day, leap, Hut length, and hence all civil dates
   within SH 1336–1425. Versioned; each version immutable.
   ↓ (validates / bounds)
2. VALIDATED DETERMINISTIC ALGORITHM  — an implementation mechanism that may
   compute dates, but ONLY within the range in which it has been shown to
   reproduce the ratified series for every year (per-year and every boundary),
   and is re-validated whenever a new series version is ratified. It never
   overrides the series.
   ↓ (never authoritative by itself)
3. CONVENIENCE / LIBRARY CONVERSION  — ICU/Intl "persian", generic Jalali
   (33-year / 2820-year / jalaali-js-style), online converters, etc. Never the
   business authority. If used at all, it must be gated behind the validated
   mechanism (2) and must reproduce the ratified series (1) within the served
   range; otherwise it is disallowed for authoritative civil math.
```

No generic Jalali/Persian library may silently become the business authority.

---

## 4. Implementation-strategy decision (analyzed, not assumed)

Three candidate strategies for the production implementation:

**A. Explicit versioned annual reference-series dataset only (table-driven).**
Every civil year boundary is stored and consulted directly (e.g., ~90 Nowruz rows
for 1336–1425), with forward/reverse by table lookup + month stepping.
- Pros: maximum fidelity to the ratified series; trivially auditable; no risk of
  an arithmetic drift; simplest to prove correctness (vector = row).
- Cons: ~90–180 pinned rows/vectors to maintain per version (though small and
  stable); range math still needs month-length logic; a pure table is slightly
  more code surface for the day arithmetic; future long-horizon extensions are
  manual table additions.

**B. Deterministic algorithm validated against the dataset.**
An arithmetic/astronomical algorithm computes dates; the series is used as the
validation oracle only.
- Pros: compact; covers any in-range year without new rows; conventional.
- Cons: the ratified leap rule is equinox-observed and **not** captured exactly by
  any closed arithmetic formula; a generic algorithm (33-year, 2820-year, ICU
  Persian) disagrees with the **Kabul** reference at 1407/1408 (F4-A.3 §6) and can
  drift in other decades. To be correct it would have to be an equinox ephemeris
  routine pinned to the same source as the series — effectively reproducing (A)
  plus an ephemeris dependency, i.e. complexity without a fidelity gain over the
  series itself.

**C. Hybrid (recommended):** deterministic conversion computed **for the ratified
supported range** by month-boundary arithmetic anchored on the **versioned annual
reference series** (i.e., the series supplies every Nowruz/leap anchor; a simple,
deterministic month/day stepper computes within-year dates), with the series kept
as the **governing validation authority** and the whole conversion **versioned**
for historical reproducibility.
- Effectively: the civil *anchors* come straight from the ratified series (A's
  fidelity), while the *within-year* arithmetic is a tiny, provably-correct
  stepper (B's compactness) — but there is **no closed-form year formula**; leap
  and Nowruz always come from the series row. Arithmetic/ICU (3) are admitted
  only as cross-checked, non-authoritative implementations.

**Justification for C (not assumed — argued):**
1. **Correctness:** the series is the only thing ratified (D3). Making every year
   start (1 Hamal) and leap status resolve to a series row, rather than to any
   formula, eliminates the exact class of error (arithmetic drift; the
   1407/1408 Kabul/Tehran divergence) that F4-A found blocking. The month/day
   stepper between two pinned anchors is trivial to prove and test.
2. **Authority clarity:** precedence (1) > (2) > (3) is structurally enforced
   because civil anchors can only come from (1).
3. **Reproducibility:** versioning the series (and only recomputing anchors on a
   governed revision) keeps history byte-stable; past reports resolve identically.
4. **Cost/scale:** ~90–180 immutable rows per version is trivial to store and
   audit and removes an ephemeris/astronomy runtime dependency for the supported
   range.
5. **Rejected pure forms:** (A) alone over-weights storage and makes the 
   within-year stepper less obviously centralized; (B) alone reintroduces the
   unratified-formula risk the whole F4-A process rejected.

**Decision recorded for the implementation phase (design-level; still gated):**
**option C — hybrid**, implemented as a versioned anchor series (authoritative)
+ deterministic within-range conversion stepper (validated), with arithmetic/ICU
only as non-authoritative cross-checks. This does **not** authorize code; it
fixes the design the future F4 implementation must follow.

---

## 5. Data model (design level only)

### 5.1 Calendar version/config record — required
Yes. G2 requires conversion to be a pure function of `(date, calendar version)`,
and S1 provides the governed, versioned, audited mechanism. Design:
- The **calendar scheme** (`shamsi_kabul_aft`) remains a **hard-coded invariant**
  (not configurable), per S1 (calendar scheme is hard-coded).
- The **active/ratified calendar series version** is represented as a governed
  value (via the existing `governed_configs` mechanism or an equivalent
  `calendar_scheme_versions` append-only record), so activation is an audited,
  authorized, effective-dated event and past behavior pins to the version in
  force on the date.

### 5.2 Where annual reference data lives
Design recommendation: the annual reference anchors live in **immutable,
versioned application data committed with the module** (a small versioned dataset
of `{year, nowruz_gregorian, equinox_utc_instant, leap}` rows for 1336–1425),
**not** as mutable per-day DB rows and **not** as a mutable free-form table:
- The dataset is small (~90–180 rows), deterministic, and changes only by
  governed ratification as a **new version**.
- A governed pointer record references which version is active/ratified and when;
  Audit records every ratification (consistent with S1 append-only + audit).
- Rationale: DB-per-day rows for 90 years would duplicate the immutable dataset,
  invite drift, and add index/consistency cost for no fidelity gain; mutable DB
  data would weaken immutability. Committed immutable data + governed version
  pointer is the single-source-of-truth, auditable option.

### 5.3 Future calendar revisions versioned
Each governed revision is a **new version**: the new immutable anchor dataset +
vectors are ratified (effective-dated), the pointer is moved, and the prior
version remains intact for historical reproduction. No in-place edits ever.

### 5.4 Historical-record reproducibility
Because conversion = pure `(canonical date, version)`, an existing record needs no
second date. Records/snapshots that render Shamsi labels must capture the
**calendar version id in force** alongside the canonical date (added only in the
implementation/migration phase, per G2 snapshot rule). This is the only
data-shape change foreseen and is deferred to implementation (not made here).

### 5.5 No schema change now
None of the above is created in this step. It is the target design.

---

## 6. Existing date-bearing domain audit (migration impact; no change made)

Classification legend — treatment: **N** = no schema change;
**CA** = Calendar Authority integration (single conversion point);
**D** = derived Shamsi display; **PA** = period abstraction (business period →
authoritative SH period → exact Gregorian bounds); **M/B** = migration/backfill
(future); **HV** = explicit historical calendar version (reproducibility).

| Domain / structure | Field(s) | Type | Classification | Treatment |
|---|---|---|---|---|
| `people` | `date_of_birth` | date | DOB/identity date | **CA**, **D**, **N**. Birth dates before SH 1336 (pre-1957) → out-of-range/manual (HV). |
| `academic_periods` | `starts_on`, `ends_on` | date | academic period | **PA**, **D**, **N** (term keys map to SH terms via CA). |
| `class_sessions` | `scheduled_on` (+ `starts_at`,`ends_at` time) | date + time | canonical civil date (session day) + time-of-day | **CA**, **D**, **N** (`scheduled_on` is the civil day; times are zone-less clock times within that Kabul day). |
| `financial_periods` | `date_from`,`date_to` | date | business-period (financial) | **PA**, **D**, **N**. |
| `payroll_periods` | `date_from`,`date_to` | date | payroll period | **PA**, **D**, **N**. Proration stays on canonical dates. |
| `obligations` | `due_on` | date | deadline/due date | **CA**, **D**, **N** (Shamsi due label derived; store stays Gregorian). |
| `payments` | `received_on` | date | canonical civil date (receipt) | **CA**, **D**, **N**. |
| `contracts` | `effective_from`,`effective_to` | date | business-period / effective window | **CA**, **D**, **N**. |
| `contract_versions` | `effective_from`,`effective_to`, `submitted_at`,`approved_at` | date / datetime | effective window + timestamps | windows → **CA**,**D**; timestamps → **N** (UTC). |
| `leaves` | `date_from`,`date_to` | date | business window (leave) | **CA**, **D**, **N**. |
| `certificates` | `issued_on` | date | certificate date | **CA**, **D**, **HV** (certificate Shamsi label reproducibility needs version id at issuance). |
| `attendance_facts` | `attended_on`-style day (if present) | date | canonical civil date | **CA**, **D**, **N**. |
| `audit_events` | `occurred_at`,`created_at` | timestamp | audit/event timestamp | **N** (UTC only; no calendar). |
| `*_at` columns (verified/approved/computed/etc.) | datetime | audit/event timestamp | **N** (UTC). |
| `*_on` columns generally (assigned/issued/due/etc.) | date | canonical civil date | **CA**, **D**, **N**. |
| governed configs / grants / statuses / enrollments effective windows | `effective_from`,`effective_to` | date | governed/effective window | **N** (window math on canonical Gregorian). |

Cross-cutting findings:
- **No stored Shamsi column exists** and none should be added (G2); all calendar
  integration is via the single authority (CA).
- **No module currently performs Shamsi conversion**, so there is no
  module-specific conversion logic to migrate; the risk is future modules doing ad
  hoc conversion, which the single-authority boundary (§7) prevents.
- Financial/academic/payroll **period proration and open/close logic already run
  on canonical dates** (G2), so amounts/proration are unaffected; only labels and
  period keys acquire SH semantics via CA.
- **Not made now:** any M/B or HV column additions are deferred to the F4
  implementation/migration phase.

---

## 7. API / service boundary (authoritative operations)

Proposed as a single bounded authority module (design-level names; a future
implementation may adjust if a better shape exists). All operations are pure
functions of `(input, calendar-version)` and fail closed as in §2.12.

| Operation | Contract (signature semantics) | Notes |
|---|---|---|
| `forward(gregorianDate, version) → SHDate` | canonical Gregorian civil date → Solar Hijri date | §2.6 |
| `reverse(shDate, version) → gregorianDate` | valid SH date → canonical Gregorian civil date | §2.7 (bijective in range) |
| `getYearInfo(year, version)` | leap?, Nowruz (1 Hamal) Gregorian day, hutDays, equinox UTC instant (informational), period spans | leap/Nowruz from series only |
| `getMonthInfo(year, month, version)` | first day (SH + Gregorian), length, last day | §2.9 |
| `periodBoundaries(shYear) / (shYear, shMonth)` | exact canonical `[start, end)` of a SH business period | for finance/payroll/academic |
| `compare(a, b)` | SH or Gregorian date ordering / equality | canonical-day based |
| `addDays(date, n)` / `businessArithmetic` | canonical-day arithmetic; results re-labelled | §2.10; must not cross supported range without explicit failure |
| `currentBusinessDate(version)` | "today" as the authoritative SH date | resolves an instant to the Kabul civil day (§2.1) — never server-local; requires an explicit clock policy |
| `validateDate(shDate)` / `validate(gregorianDate)` | validity + in-range check | §2.8 |
| `supportedRange(version)` | returns the SH + Gregorian supported bounds | for consumers/fail-closed |

**Boundary rules:**
- The authority is the **only** place a Gregorian→SH or SH→Gregorian conversion
  exists; no module implements its own stepper.
- Storage stays canonical Gregorian; SH is produced/consumed only through the
  authority (labels, period identity, validation).
- `currentBusinessDate` is explicit about the Kabul AFT civil-clock policy and
  must not read the server timezone.
- Consumers needing SH display or period mapping call the authority; DB range
  queries remain on the canonical date column.

---

## 8. Test architecture (design only; not executed)

A future F4 conformance suite (mirroring existing Feature/Unit layout), grouped so
the exact §2 semantics and precedence are enforced:

1. **Ratified-vector conformance (T01–T17)** — each F4-A.3 §7 vector asserted via
   the authority (forward and reverse where applicable), preserving provenance
   tags; T12 = 1 Hamal 1408 = 2029-03-21 (Kabul branch).
2. **Round-trip** — `forward(reverse(s))==s` and `reverse(forward(g))==g` across
   ordinary dates, month boundaries, year boundaries, leap boundaries, Nowruz.
3. **Month-boundary** — first/last day of every month (T14) for 1403–1408 and the
   extended ratified years; last day of Hut vs first day of Hamal adjacency.
4. **Leap-year** — leap set from the series (1399,1403,1407,1412 under Kabul);
   Hut=30 vs 29; no arithmetic assumption.
5. **20/21 March transitions** — 1404 (Nowruz 2025-03-21), 1405 (2026-03-21), and
   each near-noon year.
6. **1408 Kabul-specific divergence test** — asserts 1 Hamal 1408 = 2029-03-21 and
   that a hypothetical Tehran-noon value (2029-03-20) is NOT produced; guards
   against regression to an arithmetic/Tehran library.
7. **Supported-range boundaries** — SH 1336 and 1425 edges; the 1336 anchor and
   the 1425 tail.
8. **Out-of-range fail-closed** — SH 1335 and 1426, and pre-1957 Gregorian civil
   dates, return explicit out-of-range (no fallback).
9. **Invalid-date** — month 0/13, day 0/too-large, non-integer → explicit invalid.
10. **Timezone/DST invariants** — conversion is invariant to the server/process
    timezone; `currentBusinessDate` uses the Kabul AFT civil clock only; no
    implicit Tehran timezone; instants → Kabul civil day mapping tested.
11. **Historical reproducibility** — same `(canonical date, version)` always
    yields the same SH date; a later version does not change an earlier record's
    pinned result (old version retained).
12. **Authority-precedence guard** — a deliberately-wrong arithmetic/ICU-style
    computation (e.g., the 1407/1408 Tehran pattern) must be rejected/mismatched;
    arithmetic may never override a series row.

(Not executed now — this is the required shape for the F4 implementation test
phase.)

---

## 9. Explicit prevention list

- **No dual stored calendar truths** — SH is never persisted as a second column
  (G2); conversion is derived via the authority.
- **No approximate Gregorian-month mapping** — a SH period never maps to an
  approximate Gregorian month; only exact `[start, end)` intervals via the series.
- **No server local timezone as business authority** — the noon-cutoff and civil
  day use the Kabul AFT reference clock; the process timezone is irrelevant and
  never read for calendar math.
- **No silent fallback to system/library Jalali** — no ICU/Intl "persian",
  33-year, 2820-year, or generic Jalali is used as an authoritative fallback; §3
  precedence enforced.
- **No implicit Tehran timezone** — the Iranian civil-clock convention is never
  assumed; the Kabul branch is explicit (1408 test guards this).
- **No unversioned calendar behavior** — every conversion is versioned; no
  anonymous/global conversion exists.
- **No silent range crossing** — date arithmetic that would step outside the
  supported range fails explicitly rather than approximating.

---

## 10. Scope / git discipline confirmation

- **Files changed (design/specification only):** this record
  (`WP-2-F4B-calendar-authority-implementation-design.md`).
- No migration, model, service, production PHP code, config change, seeder, or
  schema change was made. WP2-DEC-04 / G2, S1, and the ratified F4-A series are
  untouched.
- Read-only checks performed: review of G2 decision, F4-A/F4-A.3/F4-A.4 records,
  date-bearing schema columns, period models/casts, Governance (governed_configs)
  mechanism, and the academic/financial/payroll structures (§1, §6). No data or
  config was written.
- Working tree was clean before this commit; only this file is committed.

## 11. Final status

`WP-2 PARTIAL — F1/F2/F3/S1 COMPLETE, F4-A VERIFIED, F4-B DESIGN COMPLETE, F4 IMPLEMENTATION PENDING`

F4 implementation has **not** started and remains pending a separate, later,
authorized phase that must follow this design (option C hybrid), the ratified
version-1 series, and the F4-A.3 vector set.
