# WP-2 F4-A.3 — Solar Hijri Reference-Series Ratification (verification/spec record)

**Status:** `F4-A VERIFIED` (calendar-authority gate flipped from BLOCKED by the
owner's recorded ratification D1–D4 in F4-A.4 — see
`WP-2-F4A-calendar-authority-verification.md` §F4-A.4 and §12 below). This phase
originally **established a fully ratifiable specification** — a reproducible
equinox-based annual series for the ERP operational range, a precise
reference-meridian/cutoff analysis, the 1403–1408 boundary verification, a
candidate-implementation comparison, a reference-vector specification, and the
future Calendar Authority contract — and the owner has now ratified that
specification as version 1. The single residual authority gap identified in §9
(the reference civil clock) is resolved by owner decision **D2 (Kabul AFT
UTC+04:30)** recorded in F4-A.4.
**Basis:** F4-A (commit `4d0ab36`) and F4-A.2 (commit `6beb9b0`) findings, which
are accepted. WP2-DEC-04 (G2 — Shamsi-first business semantics over a single
canonical Gregorian stored date with authoritative, versioned Shamsi derivation)
is UNCHANGED. No production code was written.
**Branch:** `arena/01a062e3-toefl-house`
**Date:** 2026-09-03

This is **documentation / test-data / specification only**. No calendar service,
conversion code, library dependency, migration, financial/payroll/academic date
change, or dashboard change was made. F4 production implementation remains
**pending** and may not proceed until the F4-A gate flips to `VERIFIED`.

---

## 0. Read this first — the single decisive new result

The equinox *instant* for every year 1399–1414 is authoritatively known (from an
astronomical UTC table, §4). Translating that instant into a **civil Nowruz day**
requires a stated "noon-cutoff reference" (the local clock by which the
before/after-noon test is applied). Comparing the two natural candidate
references for an Afghan institution — **Kabul (AFT, UTC+04:30)** vs **Tehran
(UTC+03:30)** — shows:

> **Within SH 1399–1414 the two references produce an identical civil calendar
> in every year EXCEPT SH 1408 (year beginning Nowruz 2029), where they differ
> by one day.** Under the Kabul reference, 1 Hamal 1408 = **2029-03-21** and 1408
> is a common year (1407 is leap). Under the Tehran reference, 1 Hamal 1408 =
> **2029-03-20** and 1408 is a leap year (1407 is common).

Because 2029 is in the future relative to today (2026), **no published almanac
can settle this yet**, and Afghanistan's current (2022-reverted lunar-Hijri)
official administration does not issue an authoritative Solar-Hijri civil
series. Therefore the reference must be **ratified as an owner decision** (§9),
and the phase remains BLOCKED rather than silently choosing Kabul or Tehran.
Everything required for a one-line ratification is provided below.

The already-operative years (SH 1399–1407 civil days, i.e. through Nowruz 2028,
and the whole of 1404/1405 which were the earlier focus) are **unambiguous**:
both references agree, so current operational data is not at risk.

---

## 1. Required ERP operational range

### 1.1 Evidence from the existing system (facts, not assumptions)

The system is a Laravel/PHP ERP. All date-bearing columns are **Gregorian/ISO
only**; there is no existing Shamsi/Hijri column and no calendar scheme config
(verified by code inspection — grep for `shamsi|hijri|hamal|calendar_scheme`
returns nothing in `app`, `config`, and seeders; the legacy TypeScript
`core/calendar/periods.ts` / `jalali.ts` are **reference-only** and are not in
this tree). Date-bearing structures observed:

| Structure | Date field(s) | Semantic (documented from the approved G2/F4 design) |
|---|---|---|
| `academic_periods` | `starts_on`, `ends_on` | term bounds (Gregorian storage; term keys Shamsi) |
| `financial_periods` | `date_from`, `date_to` | financial period window |
| `payroll_periods` | `date_from`, `date_to` | payroll period window |
| `class_sessions` | `scheduled_on` | session day |
| `people` | `date_of_birth` | person birth date |
| `certificates` | `issued_on` | certificate issue date |
| `contracts`, `contract_versions` | `effective_from`, `effective_to`, `submitted_at`, `approved_at` | HR contract window |
| `obligations` / payments | `due_on`, `received_on` | fee/installment due & receipt |
| `leaves` | `date_from`, `date_to` | leave window |
| (configs, grants, statuses, …) | `effective_from`, `effective_to` | governed windows |

No data-bearing migration seeds historical rows: `FirstRunBootstrapSeeder`
bootstraps only identity/roles/grants and carries no hard-coded operational
dates. The automated test inventory uses **synthetic** dates concentrated in
2026–2027 (academic terms like 2026-09-01→2026-12-18, 2027-01-05→2027-04-30),
with person `date_of_birth` values from ~1980–2005 as stand-ins for real records.

### 1.2 Conclusion: existing data does not pin the historical lower bound

Because the system is greenfield for operational *data* (no migrated production
ledger is present in this tree), the date-bearing schemas alone do **not**
establish a historical lower bound for automated Shamsi derivation. The binding
constraints are:
1. **Fixed month structure is authoritative only from ~1957 (SH 1336)** onward
   (Encyclopaedia Iranica; see F4-A.2 §A.2). Dates before 1 Hamal 1336 (~21 Mar
   1957) used variable-length months and are **not** representable by a fixed
   arithmetic structure.
2. **Forward operation** must cover current + planned academic/financial/payroll
   periods and the ratified reporting horizon.
3. **Historical backfill** of DOB / legacy certificates / Islamic-Republic-era
   records (2001–2021) is a real but unbounded-by-data requirement.

### 1.3 Proposed range (owner decision — not self-ratified)

Following the F4-A rule that the range must be evidence-based and any
proposal be flagged as an owner decision:

| Range | SH years | Gregorian (approx) | Basis / purpose |
|---|---|---|---|
| **Active operational window** (the series that must be ratified and fully verified now) | **1399–1415** | **2020-03-20 → 2037** | recent history (2020 founding-era → today 2026) plus ~11 years forward academic/financial/payroll scheduling and reporting |
| **Full supported automated range** | **1336–1425** | **1957 → ~2047** | all fixed-structure dates that the Calendar Authority may ever be asked to derive automatically (legacy DOB, contracts, certificates, forward horizon). Equinox series to be pinned from an authoritative ephemeris at ratification time for the portion beyond the fully-tabulated §4 window |
| **Explicitly out-of-automated-range** | < 1336 (pre-1957) | before 1957 | variable-length-month era → **fail-closed** / manual, human-verified treatment (never auto-derived) |

**Owner decision D1 (required):** accept these bounds (or set others). The
active window 1399–1415 is the recommended ratification scope; the full
supported range is the recommended capability scope with a strict
fail-closed rule below 1336.

---

## 2. Authoritative calendar definition (recap — established in F4-A/F4-A.2)

- **Calendar:** Afghan civil Solar Hijri (Hejrah-e Shamsi / Jalali), Dari month
  names (Hamal … Hut); equinox-observed, **no closed arithmetic leap formula is
  authoritative** (Wikipedia Solar Hijri; Iranica).
- **Epoch:** the Hijra; SH year ≈ Gregorian − 621 for post-Nowruz dates.
- **Months / structure (standardised ~1957):** months 1–6 = 31 days, 7–11 = 30
  days, month 12 (Hut/Hoot) = 29 (common) or 30 (leap). Leap year = 366 days.
- **New Year:** Nowruz = 1 Hamal, at the vernal equinox.
- **Civil-day rule (the governing rule being ratified):** if the equinox occurs
  **before local noon** (at the chosen reference clock) that Gregorian day is
  1 Hamal; if **after local noon**, that day is the last of the old year (Hut)
  and the following day is 1 Hamal. (Documented for the Persian/Solar-Hijri
  rule by Wikipedia/timeanddate; see F4-A.2 §C and §3 below.)
- **Equivalence Afghanistan⇄Iran:** same solar system; identical Nowruz, leap,
  and day-count structure; differ only in month labels (Iranica; F4-A.2 §B).
  This equivalence holds for **civil-day purposes only when the two countries'
  reference clocks place the equinox on the same civil day**, which §4 shows to
  be true for 1399–1407 & 1409–1414 and false for 1408 — the crux.

---

## 3. Reference-meridian / time-zone / noon-cutoff resolution

### 3.1 What the evidence does and does not establish

**Established (authoritative):**
- The Solar-Hijri civil-day rule is the noon cutoff (equinox before/after local
  noon determines whether the equinox day or the next day is Nowruz)
  (Wikipedia Solar Hijri; timeanddate; Iranian official practice; the classical
  Tusi rule). The rule is expressed in the Iranian case as "before/after noon,
  **Tehran time**" (Wikipedia).
- Equivalence between the Afghan and Iranian solar systems is documented
  (Iranica), and for the currently operative years the Afghan civil calendar
  coincides with the Iranian one.
- No **Afghan-government** primary source was found that **decrees a specific
  reference meridian/time-zone/noon clock** for applying the cutoff to the
  Afghan civil Solar Hijri calendar (the Islamic-Republic-era official Afghan
  calendar and the 2022-reverted lunar-Hijri administration both lack an
  accessible published civil-Solar-Hijri cutoff decree). Afghan-specific
  algorithm references (nongnu afghancalendar) state the year begins at the
  equinox / "1 Hammal = 21 March (20 in leap years)" but do not publish a
  Kabul-noon cutoff decree.

**Consequence:** the equivalence argument is strong enough to show the two
candidate references agree for the operative past, but **not** strong enough to
say "always equal," because §4 exhibits a genuine divergence year (1408).
Per the phase rule ("do not silently choose one"), neither Kabul nor Tehran is
selected here; both are presented and the exact owner ratification stated (§9,
decision D2).

### 3.2 The candidate references and why they can differ

| Candidate | Clock | Noon cutoff applied at | Effect on civil Nowruz |
|---|---|---|---|
| **A. Kabul (AFT, UTC+04:30)** — recommended for an Afghan institution | Kabul local standard time | equinox civil day by Kabul clock | matches the institution's operating location and the "Afghan Solar Hijri" authority label |
| **B. Tehran (UTC+03:30)** — the codified Iranian rule | Tehran local standard time | equinox civil day by Tehran clock | strict day-for-day parity with Iranian official calendars / most arithmetic libraries |

Because Kabul is 60 minutes ahead of Tehran, any equinox instant whose UTC time
falls such that it is before 12:00 Tehran but after 12:00 Kabul (i.e. an equinox
between 08:00 and 08:30 UTC on 20 March) makes A and B land on different civil
Nowruz days. The next such case is the equinox of 2029-03-20 at 08:02 UTC
→ 11:32 Tehran (before noon → Nowruz 20 Mar) vs 12:32 Kabul (after noon → Nowruz
21 Mar). See §4/§5.

### 3.3 Owner ratification required (D2)

The owner must ratify **which civil rule the ERP's Calendar Authority encodes**:
(A) Kabul noon cutoff (recommended) or (B) Tehran noon cutoff, OR "ratify a
hybrid: use the equinox day shared by both references where they agree (always
in the operative window) and defer/flag any divergence year pending a further
decree." Until D2 is recorded, the civil-day series for the SH 1408 boundary is
indeterminate and the phase is BLOCKED.

---

## 4. Authoritative annual equinox + civil Nowruz series (1399–1414)

### 4.1 Source of the astronomical equinox instants

Vernal-equinox UTC instants below are taken from the **timeanddate** equinox
tables (cross-checked against equinoxworld / Farmers' Almanac). timeanddate is
used as a single authoritative astronomical reference; the instants agree
across all consulted sources to the minute and are not in dispute.

| Equinox UTC | → SH year it begins | Equinox (UTC) | Local civil Nowruz — **Kabul (A)** | Local civil Nowruz — **Tehran (B)** | A = B ? |
|---|---|---|---|---|---|
| 2020-03-20 | 1399 | 03:49 | 2020-03-20 | 2020-03-20 | yes |
| 2021-03-20 | 1400 | 09:37 | 2021-03-21 | 2021-03-21 | yes |
| 2022-03-20 | 1401 | 15:33 | 2022-03-21 | 2022-03-21 | yes |
| 2023-03-20 | 1402 | 21:24 | 2023-03-21 | 2023-03-21 | yes |
| 2024-03-20 | 1403 | 03:06 | 2024-03-20 | 2024-03-20 | yes |
| 2025-03-20 | 1404 | 09:01 | 2025-03-21 | 2025-03-21 | yes |
| 2026-03-20 | 1405 | 14:46 | 2026-03-21 | 2026-03-21 | yes |
| 2027-03-20 | 1406 | 20:24 | 2027-03-21 | 2027-03-21 | yes |
| 2028-03-20 | 1407 | 02:17 | 2028-03-20 | 2028-03-20 | yes |
| **2029-03-20** | **1408** | **08:02** | **2029-03-21** (12:32 Kabul = after noon) | **2029-03-20** (11:32 Tehran = before noon) | **NO** |
| 2030-03-20 | 1409 | 13:51 | 2030-03-21 | 2030-03-21 | yes |
| 2031-03-20 | 1410 | 19:41 | 2031-03-21 | 2031-03-21 | yes |
| 2032-03-20 | 1411 | 01:21 | 2032-03-20 | 2032-03-20 | yes |
| 2033-03-20 | 1412 | 07:22 | 2033-03-20 | 2033-03-20 | yes |
| 2034-03-20 | 1413 | 13:17 | 2034-03-21 | 2034-03-21 | yes |
| 2035-03-20 | 1414 | 19:02 | 2035-03-21 | 2035-03-21 | yes |

Notes on the civil-day transform (do not confuse equinox instant with civil day):
- The "equinox UTC" column is the astronomical instant; the "civil Nowruz"
  columns apply the noon-cutoff rule at the stated reference clock.
- 1404 (Nowruz 2025): equinox 09:01 UTC → 12:31 Tehran / 13:31 Kabul, both
  **after noon** → civil Nowruz **21 Mar 2025** (the earlier "20 Mar" figures in
  some sites label the equinox day and are wrong for the civil calendar — see
  F4-A.2 §C).
- 1406 (Nowruz 2027): equinox 20:24 UTC → 23:54 Tehran (20th) / 00:54 Kabul
  (21st). Under both references Nowruz = **21 Mar 2027** (Tehran: equinox after
  noon on the 20th ⇒ the 21st; Kabul: equinox 00:54 on the 21st before noon ⇒
  the 21st).
- 1408 is the unique divergence within the window (see §4.2).

### 4.2 Resulting annual series under each candidate reference

Leap status follows the series (year length = 366 ⇒ leap; Hut = 30).
**Kabul reference (A) — recommended:**

| SH | 1 Hamal (Nowruz) | length | leap? | Hut days | 1 Hamal next (first day after Hut) |
|---|---|---|---|---|---|
| 1399 | 2020-03-20 | 366 | leap | 30 | 2021-03-21 |
| 1400 | 2021-03-21 | 365 | no | 29 | 2022-03-21 |
| 1401 | 2022-03-21 | 365 | no | 29 | 2023-03-21 |
| 1402 | 2023-03-21 | 365 | no | 29 | 2024-03-20 |
| 1403 | 2024-03-20 | 366 | leap | 30 | 2025-03-21 |
| 1404 | 2025-03-21 | 365 | no | 29 | 2026-03-21 |
| 1405 | 2026-03-21 | 365 | no | 29 | 2027-03-21 |
| 1406 | 2027-03-21 | 365 | no | 29 | 2028-03-20 |
| **1407** | **2028-03-20** | **366** | **leap** | **30** | **2029-03-21** |
| **1408** | **2029-03-21** | **365** | **no** | **29** | **2030-03-21** |
| 1409 | 2030-03-21 | 365 | no | 29 | 2031-03-21 |
| 1410 | 2031-03-21 | 365 | no | 29 | 2032-03-20 |
| 1411 | 2032-03-20 | 365 | no | 29 | 2033-03-20 |
| 1412 | 2033-03-20 | 366 | leap | 30 | 2034-03-21 |
| 1413 | 2034-03-21 | 365 | no | 29 | 2035-03-21 |
| 1414 | 2035-03-21 | 365 | no | 29 | 2036-03-20* |

*2036 equinox pinned from an authoritative ephemeris at ratification time (not
in the §4.1 table); used only to close 1414's length.

**Tehran reference (B):** identical to (A) above for every row **except** 1407
and 1408, which swap:

| SH | 1 Hamal (Nowruz) | length | leap? | Hut days | 1 Hamal next |
|---|---|---|---|---|---|
| 1407 | 2028-03-20 | 365 | no | 29 | 2029-03-20 |
| 1408 | 2029-03-20 | 366 | leap | 30 | 2030-03-21 |

**Independent cross-check:** the Tehran/arithmetic pattern (leaps 1399, 1403,
1408, 1412 …) matches the published 33-year-cycle leap markers in the reference
table used by F4-A.2 (kiddle Solar-Hijri year-span table marks `1399*`, `1403*`,
`1408*`, `1412*`). The Kabul reference (leaps 1399, 1403, **1407**, 1412) is
the astronomically consistent result of applying the same noon-cutoff rule at
Kabul AFT. Both are internally reproducible; they differ only at the 1408
boundary, which is the owner decision.

**Authority / verification status of this series:**
- Equinox instants: **authoritative** (multi-source astronomical agreement).
- Civil-day transform: **deterministic given a ratified reference** (D2).
- Series arithmetic (year lengths, Hut days, leap flags): **derived, fully
  reproducible** by the fixed structure once the civil Nowruz days are fixed;
  cross-checked against known anchors (R6: 2026-09-02 = 11 Sunbula 1405).
- **Not yet RATIFIED:** the civil Nowruz days are conditional on D2. Once D2 is
  recorded this table becomes the authoritative version-1 series.

---

## 5. 1403–1408 boundary verification (equinox instant vs civil Nowruz day)

For each required boundary, the astronomical instant, the civil-day
transformation, and the resulting calendar edge are given. Month first-days are
computed from the civil Nowruz day using the fixed structure
(months 1–6 = 31, 7–11 = 30, Hut = 29/30). This is arithmetic *derivation* from
a ratified reference — not fabrication, and not code in the ERP.

### 5.1 1403 → 1404 (year boundary 2025)
- Equinox 2025-03-20 09:01 UTC. Kabul local 13:31, Tehran local 12:31 → both
  after noon.
- Civil: **1 Hamal 1403 = 2024-03-20**, Hut 1403 has 30 days (leap), last day of
  Hut = **2025-03-20**, and **1 Hamal 1404 = 2025-03-21** (both references agree).
- 20/21-March transition correctly places Nowruz 1404 on the 21st (equinox-day
  listings that say the 20th are wrong for the civil calendar).

### 5.2 1404 → 1405 (year boundary 2026)
- Equinox 2026-03-20 14:46 UTC. Kabul 19:16, Tehran 18:16 → after noon both.
- Civil: **1 Hamal 1404 = 2025-03-21**, 1404 common (Hut 29), last Hut =
  2026-03-20, **1 Hamal 1405 = 2026-03-21** (both references agree).

### 5.3 1405 → 1406 (year boundary 2027)
- Equinox 2027-03-20 20:24 UTC. Tehran 23:54 (20th), Kabul 00:54 (21st).
- Civil: **1 Hamal 1405 = 2026-03-21**, last Hut = 2027-03-20,
  **1 Hamal 1406 = 2027-03-21** (both references agree — Tehran: equinox after
  noon on 20th; Kabul: equinox early on 21st, before noon).

### 5.4 1406 → 1407 (year boundary 2028)
- Equinox 2028-03-20 02:17 UTC. Kabul 06:47, Tehran 05:47 → before noon both.
- Civil: **1 Hamal 1406 = 2027-03-21**, last Hut = 2028-03-19 (Hut 29),
  **1 Hamal 1407 = 2028-03-20** (both references agree).

### 5.5 1407 → 1408 (year boundary 2029) — the divergence
- Equinox 2029-03-20 08:02 UTC. **Tehran 11:32 (before noon); Kabul 12:32
  (after noon).**
- Kabul reference: 1 Hamal 1407 = 2028-03-20, **1407 leap** (Hut 30, last Hut =
  2029-03-20), **1 Hamal 1408 = 2029-03-21**, 1408 common.
- Tehran reference: 1 Hamal 1407 = 2028-03-20, **1407 common** (Hut 29, last Hut
  = 2029-03-19), **1 Hamal 1408 = 2029-03-20**, 1408 leap.
- This is the **formal classification** of the earlier 20/21-March concern: it
  is a genuine **owner-ratification issue (D2)**, not a discoverable fact,
  because the boundary year 2029 is in the future and no current authority
  publishes an Afghan Solar-Hijri civil series for it.

### 5.6 1408 → 1409 (year boundary 2030) — reference-conditional
- Equinox 2030-03-20 13:51 UTC. Kabul 18:21, Tehran 17:21 → after noon both.
- Civil 1 Hamal 1409 = 2030-03-21 under both references. Whether Hut 1408 was
  29 (Kabul: 1408 common, last Hut 2030-03-20) or 30 (Tehran: 1408 leap, last
  Hut 2030-03-20) — note the *last day of Hut 1408 is 2030-03-20 in both* — and
  1 Hamal 1409 = 2030-03-21 in both.

### 5.7 Representative month first-days (derived, provisional on D2)

Computed from the civil Nowruz day under the **Kabul (A)** reference (identical
to Tehran (B) for all years 1403–1406; 1407/1408 differ only in Hut length and
the 1408 year-start as shown):

- **1403** (leap): 1 Hamal 2024-03-20, Sawr 04-20, Jawza 05-21, Saratan 06-21,
  Asad 07-22, Sunbula 08-22, Mizan 09-22, Aqrab 10-22, Qaws 11-21, Jadi 12-21,
  Dalwa 2025-01-20, Hut 02-19 (30 days, last 03-20).
- **1404** (common): 1 Hamal 2025-03-21, Sawr 04-21, Jawza 05-22, Saratan 06-22,
  Asad 07-23, Sunbula 08-23, Mizan 09-23, Aqrab 10-23, Qaws 11-22, Jadi 12-22,
  Dalwa 2026-01-21, Hut 02-20 (29 days, last 03-20).
- **1405** (common): 1 Hamal 2026-03-21, Sawr 04-21, Jawza 05-22, Saratan 06-22,
  Asad 07-23, Sunbula 08-23, Mizan 09-23, Aqrab 10-23, Qaws 11-22, Jadi 12-22,
  Dalwa 2027-01-21, Hut 02-20 (29, last 03-20).
- **1406** (common): 1 Hamal 2027-03-21, … Dalwa 2028-01-21, Hut 02-20 (29,
  last 03-19).
- **1407**: 1 Hamal 2028-03-20 … (Kabul: Hut 30, last 2029-03-20; Tehran: Hut
  29, last 2029-03-19) — **reference-dependent**, future from today.
- **1408**: 1 Hamal Kabul 2029-03-21 / Tehran 2029-03-20 — **reference-dependent**.

**Anchor cross-check:** 1 Sunbula 1405 = 2026-08-23; day 11 = 2026-09-02 and day
12 = 2026-09-03 (today). This reproduces F4-A R6 (2026-09-02 ≈ 11 Sunbula 1405),
confirming the structure arithmetic used here.

---

## 6. Candidate-implementation verification (conceptual; no code run)

Candidates are evaluated **only as implementations** of the ratified civil
series — none may become the source of truth by itself (option D from F4-A.2).

| Candidate | Basis | Agreement with ratifiable series | Disposition |
|---|---|---|---|
| Arithmetic 33-year cycle (common Jalali) | fixed leap pattern | Matches the **Tehran**-reference civil days & leap set (1399,1403,1408,1412…) within 1399–1414; **mismatches the Kabul** reference at 1407/1408 (it encodes 1408-leap / 1407-common, i.e. Tehran) | acceptable only if the owner ratifies reference B; **rejected** as sole authority regardless — it is an approximation of the equinox rule and can drift in other decades |
| Proposed 2820-year cycle (Birashk) | arithmetic long-cycle | **Never officially adopted** (F4-A); not guaranteed to match either reference | rejected as authority; at most an internal probe |
| ICU / Intl "persian" calendar; arithmetic Persian/Jalali libs | algorithmic Persian | Follow the **Tehran/arithmetic** civil-day convention; within 1399–1414 they match the Tehran reference rows | acceptable **only as an implementation** of reference B within its validated range; not authoritative |
| Astronomical / equinox-observed (the governing rule) | ephemeris + noon cutoff at a stated reference | Is the **source of the series itself** (§4) | the authoritative basis; a versioned per-year civil series derived from it governs (option D) |

**Conclusion:** no single library is authoritative. The governing element is the
ratified **annual equinox/leap series** (option D). Any arithmetic/ICU candidate
is usable only within a range where it reproduces that ratified series
everywhere, including boundary and round-trip tests; a candidate that disagrees
(the arithmetic set disagrees with the Kabul reference at 1407/1408) is rejected
for that purpose or restricted to a clearly documented non-authoritative /
reference-B role.

---

## 7. Authoritative test-vector specification (machine-readable, doc-only)

Format below is a stable key/JSON-able table to be carried into the future
Calendar Authority's conformance suite. Every vector carries **source/derivation**:
`EQUINOX` = from the §4.1 astronomical instant + ratified noon rule;
`DERIVED` = fixed-structure arithmetic from an EQUINOX vector; `ATTESTED` =
corroborated by an independent source; `K/T` = reference-conditional.

Because the vectors must be unambiguous **after** D2, and 1408 is
reference-dependent, vectors referencing 1408 are marked `REQ-D2` and are
completed only once the owner chooses A or B.

| id | Gregorian | SH | type | basis | source | status |
|---|---|---|---|---|---|---|
| T01 | 2020-03-20 | 1 Hamal 1399 | year-start / leap | EQUINOX | §4.1 | ATTESTED |
| T02 | 2021-03-21 | 1 Hamal 1400 | year-start | EQUINOX | §4.1 | ATTESTED |
| T03 | 2021-03-20 | 30 Hut 1399 | last day of leap | DERIVED | §4.2 | derived |
| T04 | 2024-03-20 | 1 Hamal 1403 | year-start / leap | EQUINOX | §4.1 | ATTESTED |
| T05 | 2024-03-20 → 2025-03-20 | Hut 1403 last = 2025-03-20 | leap Hut boundary | DERIVED | §5.7 | derived |
| T06 | 2025-03-21 | 1 Hamal 1404 | year-start | EQUINOX | §4.1 | ATTESTED (R3 resolved) |
| T07 | 2025-03-20 | 30 Hut 1403 | day before Nowruz | DERIVED | §5.1 | derived |
| T08 | 2026-03-21 | 1 Hamal 1405 | year-start | EQUINOX | §4.1 | ATTESTED (R4 resolved) |
| T09 | 2026-09-02 | 11 Sunbula 1405 | ordinary / drift | DERIVED/ATTESTED | §5.7, F4-A R6 | ATTESTED |
| T10 | 2027-03-21 | 1 Hamal 1406 | year-start | EQUINOX | §4.1 | derived |
| T11 | 2028-03-20 | 1 Hamal 1407 | year-start | EQUINOX | §4.1 | derived |
| T12 | 2029-03-20 / 2029-03-21 | 1 Hamal 1408 | year-start | EQUINOX + REQ-D2 | §4.2, §5.5 | REQ-D2 (A: 21 Mar; B: 20 Mar) |
| T13 | 2030-03-21 | 1 Hamal 1409 | year-start | EQUINOX | §4.1 | derived |
| T14 | month first/last for each of 12 months in 1404 & 1405 | (set) | monthly boundaries | DERIVED | §5.7 | derived |
| T15 | 2026-01-01 | 11 Jadi 1404 | cross-year ordinary | DERIVED | structure | derived |
| T16 | 2026-01-01 & 2026-12-31 | 1404/1405 membership | reporting-year edges | DERIVED | structure | derived |
| T17 | pre-1957 Afghan civil date (e.g. 1950) | n/a (variable months) | historical | NOT-representable | F4-A.2 | fail-closed, manual |

Round-trip invariants (mandatory for any candidate, **necessary not
sufficient**): `gregorian→shamsi→gregorian == original` and
`shamsi→gregorian→shamsi == original`, holding across ordinary, month/year/
leap boundaries and around Nowruz over the whole supported range — plus full
match on the authoritative vectors above (a self-consistent wrong table
round-trips, so vectors, not round-trip alone, certify a candidate). **No
round-trip run was performed in F4-A.3** because no reference is ratified and no
code is authorized.

> **Vector correction — T03 (2026-09-03, F4-C reconciliation).** T03's Solar
> Hijri cell is corrected from "29 Hut 1399" to **"30 Hut 1399"**. The ratified
> Kabul series (§4.2) fixes SH 1399 as a **leap** year with a **30-day Hut**; its
> final civil day is 2021-03-20, which is therefore **30 Hut 1399** (the day
> before 1 Hamal 1400 = 2021-03-21). The earlier "29 Hut" reading was
> self-inconsistent: a 29-day Hut would make 1399 a *common* year, contradicting
> the ratified leap series. Consequently 29 Hut 1399 = 2021-03-19 (penultimate
> day), and the F4-C Calendar Authority + conformance suite assert
> 30 Hut 1399 = 2021-03-20. The T03 `source` is also corrected from §5.7 to
> §4.2, because §5.7 tabulates only SH 1403–1408 and does not list SH 1399.

---

## 8. Future Calendar Authority contract (specified, NOT implemented)

Per WP2-DEC-04 (G2), the Calendar Authority is the single consumer-facing
conversion authority. Contract (design only; no code):

**Input:** one canonical Gregorian date/time.
**Output:** authoritative Solar Hijri date (year, month, day, Dari labels) and a
`business_period_id` (e.g. SH fiscal year/month or academic term) where
applicable.
**Reverse:** a Solar Hijri (year, month, day) resolves to the exact canonical
Gregorian date (or the exact canonical [start, end] interval of the period).
**Guarantees:**
- **Deterministic:** pure function of (canonical date, calendar-version).
- **Versioned:** every conversion is pinned to a ratified series version; past
  snapshots record the version in force (reproducible history).
- **Authoritative:** a version encodes the ratified annual equinox/leap series
  (§4, after D2), not an unverified arithmetic formula as source of truth.
- **Fail-closed:** any date outside the supported range (e.g. < 1336) returns an
  explicit unsupported result — **no silent fallback / approximation**.
- **No module-specific conversion logic:** Finance, Payroll, Academic terms,
  Reporting, Fees/installments, due dates, dashboards, and any future
  business-period consumer must call this one authority; no module stores a
  second date truth.
- **Range math on canonical Gregorian:** DB predicates/proration stay on the
  stored Gregorian date; Shamsi is derived labelling/business identity.

---

## 9. Owner decision gate — outcome and exact residual asks

> **Status note (2026-09-03, F4-A.4):** the classification and residual asks in
> this §9 reflect the **pre-ratification** state of F4-A.3 (what the spec needed
> from the owner). The owner has since ratified **D1–D4** (recorded in §12 and in
> `WP-2-F4A-calendar-authority-verification.md` §F4-A.4 / the approved-decisions
> record), so the F4-A gate is now **`VERIFIED`**. §9 is preserved verbatim for
> audit; treat §12 as the current state.

### Classification (at time of F4-A.3, pre-ratification): **BLOCKED** (`F4-A BLOCKED PENDING AUTHORITATIVE CALENDAR VERIFICATION`)

Per the F4-A.3 rule, VERIFIED requires, among others, that the
**reference meridian/cutoff is established** and the **annual series is
sufficiently authoritative**. Neither is self-ratifiable here: no
Afghan-government primary source was found that decrees the noon-cutoff
reference clock for the Afghan civil Solar Hijri calendar, and the current
(2022-reverted lunar-Hijri) administration publishes no Solar-Hijri civil
series; the divergence at SH 1408 (2029) is therefore unresolved by evidence.

**What remains unresolved:** the civil-Nowruz noon-cutoff reference (Kabul AFT
vs Tehran vs hybrid) for the Solar Hijri calendar the ERP encodes; consequently
the SH 1407/1408 leap-and-boundary detail (§5.5) and the exact ratified
version-1 annual series are not yet fixed.

**What source was sought (and its insufficiency):**
- Afghan Constitution Art. 18 (solar basis for state offices) — authoritative
  on *which* calendar, silent on the noon-cutoff reference clock.
- Encyclopaedia Iranica / US DOJ-EOIR / Transparent Dari — authoritative on
  Afghan⇄Iranian equivalence and month names; silent on a Kabul-vs-Tehran
  civil cutoff decree.
- Wikipedia/timeanddate (Persian/Solar-Hijri rule) — authoritative on the noon
  rule itself, but expressed for the Iranian case as "Tehran time"; no Afghan
  primary restatement found.
- Afghan-specific algorithm references (nongnu afghancalendar) — state the year
  begins at the equinox and give a simplified "21 March / 20 in leap years"
  mnemonic; do not publish an Afghan civil-noon cutoff decree or an official
  per-day almanac.
- No accessible **Afghan-government-published per-day** Solar-Hijri civil
  almanac exists for the operative/future window, and the 2029 divergence year
  is in the future, so no almanac can decide it.

**Why existing evidence is insufficient:** the equivalence evidence proves the
two candidate references agree across all operative past years but *demonstrably
diverges at 1408* (§4, §5.5). Equivalence alone cannot pick the civil rule for
that year; per the phase rule I do not silently choose Kabul or Tehran.

**Exact owner decisions / evidence needed to flip to `F4-A VERIFIED`:**
1. **D1 — operational range:** ratify the §1.3 range (active window 1399–1415;
   full supported 1336–1425; pre-1336 out-of-range/fail-closed), or set bounds.
2. **D2 — reference rule (the blocker):** ratify (A) Kabul AFT noon cutoff
   (recommended), or (B) Tehran noon cutoff, or a hybrid/other formally defined
   mechanism, **with the boundary rule stated** (equinox before/after local
   noon at the chosen clock ⇒ civil Nowruz).
3. **D3 — series adoption:** ratify the resulting version-1 annual series
   (the §4.2 table for the chosen reference) as the Calendar Authority's
   version-1 equinox/leap series, and the source/version of the astronomical
   equinox data used to pin it (timeanddate table + an authoritative ephemeris
   for the post-2035 tail and the 1336–1398 range).
4. **D4 — vector acceptance:** confirm the §7 vector spec (including R3/R4 as
   resolved to 21 Mar 2025 / 21 Mar 2026 under either reference) as the
   conformance baseline; accept reference-dependent rows T12 (1408) once D2 is
   fixed.

Once D1–D4 are recorded, F4-A.3's spec becomes the ratified version-1 series and
the F4-A gate can be re-run to `VERIFIED` (and candidate implementations
verified against §7 vectors). Until then: **F4-A BLOCKED … F4 IMPLEMENTATION
PENDING.** F4 production implementation must not proceed.

---

## 10. Scope / git discipline confirmation

- **Files changed (documentation/specification only):** this record
  (`WP-2-F4A.3-solar-hijri-reference-series-ratification.md`).
- No production code, calendar service, conversion code, library dependency,
  migration, financial/payroll/academic date logic, dashboard, or DB date-column
  change was made. F1/F2/F3/S1 and the approved G2 (WP2-DEC-04) decision are
  untouched. The pre-existing `core/calendar/periods.ts` legacy reference is
  **not** in this tree and was not modified or replaced.
- Working tree was verified clean of unintended changes before commit; only the
  F4-A.3 documentation file is committed.

## 11. Sources referenced

timeanddate — equinox UTC table & varying-March-equinox page (UTC instants
2020–2035) · equinoxworld / Farmers' Almanac (corroboration) · Wikipedia —
Solar Hijri calendar & Nowruz (noon-cutoff civil rule; "formerly in
Afghanistan") · Encyclopaedia Iranica — Calendars (Afghan⇄Iranian equivalence;
~1957 standardisation) · US DOJ/EOIR — Afghanistan calendar research (official
since 1957) · nongnu.org afghancalendar (Afghan months/holidays; simplified
Nowruz rule) · Afghan Constitution (2004) Art. 18 (solar basis; via U. Minnesota
HRL and nongnu) · mtempmail Afghan converter (year-span anchors) ·
F4-A `WP-2-F4A-calendar-authority-verification.md` and F4-A.2 addendum (accepted
prior findings R1–R7 and the ratification path).

---

## 12. Owner ratification — F4-A.4 (D1–D4 recorded)

**Date:** 2026-09-03 · Documentation only; no code.

The architecture owner formally ratified the four decisions this record framed,
thereby resolving the §9 residual authority gap and flipping the F4-A gate from
`BLOCKED` to `VERIFIED`. The ratified decisions are recorded authoritatively in
`docs/architecture/decisions/WP2-approved-decisions.md` (F4-A appendix) and
`docs/implementation/WP-2-F4A-calendar-authority-verification.md` (§F4-A.4);
this section records their effect on this specification.

- **D1 — Operational range (ratified).** Active operational window SH
  1399–1415 (~2020–2037); full supported deterministic range SH 1336–1425
  (1957 fixed-structure → ~2047); pre-1336 dates fail closed / require manual
  handling; no fabrication of historical calendar or branch/date provenance
  beyond verified evidence.
- **D2 — Reference civil clock (ratified).** Kabul local civil time,
  **AFT = UTC+04:30**, is the TOEFL House Calendar Authority reference clock;
  the documented noon-cutoff rule is applied against Kabul civil time. This is
  an explicit TOEFL House **product/architecture decision**, **not** a claim
  that a currently published Afghan government source mandates this exact
  computational rule. The distinction between the astronomical equinox instant
  and the resulting civil first day of Hamal is preserved. The **1408
  divergence** (§5.5) remains explicitly documented as the reason D2 matters.
- **D3 — Reference-series authority (ratified).** The annual
  equinox/reference series documented above is ratified as the **version-1
  reference dataset** and is authoritative for supported dates. Any arithmetic
  algorithm is only an implementation mechanism and **must** be validated
  against the ratified reference series. The 33-year, 2820-year, ICU/Persian
  arithmetic, or another generic Jalali implementation is **not** the sole
  authority.
- **D4 — Acceptance vectors (ratified).** Vectors **T01–T17** (§7) are the
  initial acceptance/test-vector set, with provenance tags preserved
  (EQUINOX / DERIVED / ATTESTED / REQ-D2). Implementation must satisfy the
  vectors **plus** the round-trip invariants (§7). Under ratified D2 the
  reference-dependent rows are fixed to the Kabul (A) branch: T12 = 1 Hamal
  1408 = **2029-03-21**; the 1407 leap / 1408-common detail (§4.2, §5.5, reference
  A) is the version-1 series. REQ-D2 vectors are thereby resolved (they remain
  provenance-tagged DERIVED/EQUINOX for audit but are no longer ambiguous).

**Series/version reproducibility:** the version-1 dataset = the §4.1
astronomical equinox UTC instants (timeanddate; cross-checked) transformed to
civil Nowruz by the noon-cutoff rule at Kabul AFT (D2), yielding the §4.2
Kabul-reference table and the §5.7 month-boundary structure. Future F4
implementations and historical audits must reproduce against this exact
dataset + Kabul-clock rule.

**Final F4-A classification (after D1–D4):** `F4-A VERIFIED`. F4 production
implementation remains **pending** and is a separate, later phase; this record
authorizes nothing beyond the calendar-authority verification. WP2-DEC-04 / G2
is unchanged.
