# WP-2 F4-A — Calendar Authority & Algorithm Verification (research/spec record)

**Status:** `F4-A BLOCKED PENDING AUTHORITATIVE CALENDAR VERIFICATION` (see §11)
**WP2-DEC-04 (F4) architecture decision:** UNCHANGED (G2 — Shamsi-first business
semantics over a single canonical Gregorian stored date with authoritative,
versioned Shamsi derivation). No calendar conversion code was written.
**Branch:** `arena/01a062e3-toefl-house`
**Date:** 2026-09-03

This phase produced **research, specification, and reference-set analysis only**.
No calendar service, conversion code, library dependency, migration, or date
logic change was made. F4 production implementation remains **pending** and may
not proceed until the algorithm is verified against an authoritative reference.

---

## 1. Authoritative calendar definition selected (what "Shamsi" means here)

TOEFL House operates in Afghanistan. Its authoritative business calendar is the
**Afghan official civil Solar Hijri calendar** — Hejrah-e Shamsi (هجری شمسی),
also "Jalali" — the same equinox-based solar calendar as the Iranian Solar
Hijri (Persian) calendar, differing **only in month names**.

Authoritatively established definition:

| Attribute | Value | Source |
|---|---|---|
| Calendar type | Solar; year = interval between successive **vernal equinox** occurrences (observation-based, **not** a fixed arithmetic formula) | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [Calendars Wiki](https://calendars.fandom.com/wiki/Iranian_calendar) |
| Official in Afghanistan | Adopted as the official civil calendar; in standardised official use since ~1336 H.S. / **1957 CE** (legally recognised as the Jalali solar calendar from ~1922); defined in the Constitution | [US DOJ/EOIR Afghanistan calendar research](https://www.justice.gov/sites/default/files/eoir/legacy/2013/06/11/calendar.pdf); [Encyclopaedia Iranica "Calendars"](https://www.iranicaonline.org/articles/calendars/); [HandWiki](https://handwiki.org/wiki/History:Solar_Hijri_calendar) |
| Epoch | The Hijra, 622 CE; years counted from the solar year of the migration | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [timeanddate](https://www.timeanddate.com/calendar/persian-calendar.html) |
| New Year | **Nowruz = 1 Hamal** begins at the vernal equinox (~20–21 March Gregorian). Civil rule: if the equinox falls before local noon, that day is 1 Hamal; if after noon, that day is 29/30 Hut and the following day is 1 Hamal | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [1Rooz](https://1rooz.com/about_persian_calendar.php) |
| Months (Dari names) | 1 Hamal, 2 Sawr, 3 Jawza, 4 Saratan, 5 Asad, 6 Sunbula, 7 Mizan, 8 Aqrab, 9 Qaws, 10 Jadi, 11 Dalwa, 12 Hut | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [Transparent Dari](https://blogs.transparent.com/dari/2012/11/26/afghan-calendar-and-months-of-the-year-in-dari/) |
| Month lengths | Months 1–6 = 31 days; months 7–11 = 30 days; month 12 (Hut) = 29 days in common years, 30 in leap years | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [nongnu afghancalendar](https://www.nongnu.org/afghancalendar/); [timeanddate](https://www.timeanddate.com/calendar/persian-calendar.html) |
| Leap year | Year is 366 days (Hut = 30 days) when needed so the following Nowruz aligns with the equinox. **No single mathematical leap formula is official.** Common arithmetic "33-year" cycles and the proposed "2820-year" cycle are approximations, not the authoritative rule | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar) |
| Iran vs Afghanistan | Same structure, year numbering, day counts, and equinox base; Afghanistan uses Dari zodiac month names (Hamal…Hut), Iran uses Farvardin…Esfand | [Wikipedia](https://en.wikipedia.org/wiki/Solar_Hijri_calendar); [mtempmail](https://mtempmail.com/afghan-date-converter); [Encyclopaedia Iranica](https://www.iranicaonline.org/articles/calendars/) |

**Historical range caution (pre-1957):** Before ~1336 H.S. / 1957, official Afghan
month lengths were **variable (roughly 29–32 days)**, set by the sun's passage
through the zodiac, and only the 1957 reform standardised the fixed
31/30/30/29-30 structure ([Encyclopaedia Iranica](https://www.iranicaonline.org/articles/calendars/)). A fixed arithmetic conversion is therefore **not
valid for pre-1957 Afghan civil dates**. This matters because TOEFL House holds
historical data (birth dates, certificates, legacy records).

### Iran/Afghanistan relationship
The calendars are the same solar system; conversion of a day-count and the
month/year boundaries coincide, differing only in month labels. Reference dates
for the Iranian calendar are therefore usable as a technical proxy for the
Afghan calendar's structure and Nowruz, but the **exact civil day** is where a
reference-meridian/time-zone question arises (see §11).

---

## 2. Why this is appropriate for Afghanistan / TOEFL House

- Afghanistan's constitution and administrative practice use Hejrah-e Shamsi
  for official dates; government offices and official documents use it while
  Gregorian is used for passports/foreign correspondence
  ([US DOJ/EOIR](https://www.justice.gov/sites/default/files/eoir/legacy/2013/06/11/calendar.pdf);
  [Transparent Dari](https://blogs.transparent.com/dari/2012/11/26/afghan-calendar-and-months-of-the-year-in-dari/)).
- It is the calendar of Afghan public life (fiscal periods, academic terms,
  contracts, due dates, dashboards) — exactly the semantics TOEFL House must be
  Shamsi-first about.
- Being a solar calendar it stays aligned with seasons, so academic terms and
  fee/installment periods have stable seasonal meaning, which is why G2 (a
  single canonical representation + authoritative derivation) is the right model.

---

## 3. Calendar semantics specification for the ERP (proposed)

### Date
- Shamsi year (e.g. 1405), Shamsi month (1–12, Dari order), Shamsi day (1–31).
- Month lengths fixed: `[31,31,31,31,31,31,30,30,30,30,30,29-or-30]`.

### Period
- Start of Shamsi year = 1 Hamal = Nowruz day (equinox rule).
- Month n of year y runs from its first day to the day before the first day of
  month n+1 (year month 12 runs to the last day of Hut, the day before the next
  year's 1 Hamal).
- Financial/payroll/academic month = **one complete Shamsi month** (never a
  partial Gregorian interval).

### Leap year
- Hut has 30 days exactly in leap years (366-day year); otherwise 29.
- Leap-year set must come from the **authoritative published civil series** for
  the operating range, not from an unverified arithmetic formula (see §11).

### Business periods
Every business-period concept (financial month/year, payroll month, academic
term, fee due date, installment, expense/reporting period) must be derived from
the **authoritative Shamsi period**, and only then mapped to exact Gregorian
boundaries for storage/querying. Modules must not each define "a month".

---

## 4. Historical reference-date verification set

The table below is the verification set to which any candidate implementation
must conform. Rows marked **ATTESTED** are supported by multiple independent
sources above; rows marked **CONFLICT** are the points of genuine disagreement
that currently block verification.

| # | Gregorian | Shamsi | Type | Source / basis | Why important | Status |
|---|---|---|---|---|---|---|
| R1 | 2023-03-21 | 1 Hamal 1402 | Nowruz (common-year start) | equinox 00:54 Tehran; attested | year-start | ATTESTED |
| R2 | 2024-03-20 | 1 Hamal 1403 | Nowruz (equinox morning) | equinox 06:36 Tehran | year-start; near date | ATTESTED |
| R3 | 2025-03-20 **or** 2025-03-21 | 1 Hamal 1404 | Nowruz (near-noon equinox) | equinox 12:31 Tehran — sources differ on 20th vs 21st | **operational window** | **CONFLICT** |
| R4 | 2026-03-20 **or** 2026-03-21 | 1 Hamal 1405 | Nowruz (near-noon equinox) | equinox 15:46 Tehran — sources differ | **operational window** | **CONFLICT** |
| R5 | 2021-03-21 | 1 Hamal 1400 | Nowruz | attested | year-start | ATTESTED |
| R6 | 2026-09-02 | 11 Sunbula 1405 | ordinary (mid-year) | current date proxy (Wikipedia/converters) | drift check | ATTESTED (verify against civil almanac) |
| R7 | pre-1957 Afghan civil dates | variable-length months | historical | Encyclopaedia Iranica | legacy DOB/certificates | **NOT representable by fixed arithmetic** |

Why these matter: R1–R5 pin Nowruz boundaries; R6 is far from a boundary to
detect algorithmic drift; R7 exposes the historical-range limitation.

**I did not fabricate any expected value.** Values not independently and
consistently attested are marked CONFLICT or NOT-representable rather than given
a number.

---

## 5. Candidate algorithms / libraries examined (conceptual)

| Candidate | Basis | Leap methodology | Known limitation for TOEFL House |
|---|---|---|---|
| "Jalaali" arithmetic 33-year cycle (common in jalaali-js and many PHP/Python snippets) | Arithmetic approximation | Fixed leap pattern | Not the official equinox rule; can drift a day near boundaries; not authoritative |
| Proposed 2820-year cycle (Birashk) | Arithmetic | Long cycle | **Never officially adopted**; rejected by authorities |
| Astronomical/equinox method (Iranian official; Institute of Geophysics, Univ. of Tehran; and the Kabul-observed variant) | Observation of the vernal equinox | Equinox-based | Requires an ephemeris and a per-year leap series; no closed arithmetic formula |
| ICU / Intl "persian" calendar (PHP `fa_IR@calendar=persian`, jalaali libs built on arithmetic Persian) | Algorithmic approximation | Arithmetic | Not guaranteed to equal the Afghan civil series in every near-boundary year |

No candidate is, by itself, "the authoritative Afghan Solar Hijri civil
calendar." Selecting by popularity (e.g. "jalaali-js is common") is explicitly
rejected here.

---

## 6. Comparison results

- The **structure** (month lengths, Dari names, epoch) is authoritative and not
  in dispute.
- The **civil Nowruz/leap day for the current operating window (1404/1405,
  i.e. 2025–2026)** is in genuine dispute across the sources examined (§4 R3/R4,
  §11). The equinox falls after the noon cutoff in both years, so the noon-rule
  answer (21 March) and the "equinox-day" answer (20 March) differ, and
  individual converters and calendars disagree.
- No arithmetic algorithm can be proven to equal the Afghan civil series for the
  full required historical range (which itself includes the pre-1957
  variable-length period) without an authoritative per-year reference.

---

## 7. Round-trip verification

Round-trip is a **necessary, not sufficient**, invariant. Mandatory eventual
invariants for the implementation:

```
gregorian → shamsi → gregorian == original gregorian date
shamsi    → gregorian → shamsi    == original shamsi date
```

These must hold across ordinary dates, month boundaries, year boundaries, leap
boundaries, and dates around Nowruz, over the complete supported range. But a
self-consistent wrong table round-trips perfectly, so every candidate must also
pass the authoritative reference-vector validation (§4). **No round-trip run was
performed in F4-A** because no candidate was authorised/verified yet.

---

## 8. Financial / business-period implications

- **Financial invariant:** calendar correctness is money correctness. A Shamsi
  reporting/financial month must equal the exact Gregorian interval of that
  Shamsi month — not an "approximately March" partial interval.
- The correct semantic model is:
  `Business period → authoritative Shamsi period → exact Gregorian boundaries
  for technical querying/storage`
  and **never**
  `Gregorian month → approximate Shamsi label`.
- This directly prevents a recurrence of the prior dashboard defect where a
  Shamsi reporting month was represented by an incomplete Gregorian interval.

---

## 9. Proposed Calendar Authority boundary (design only — not implemented)

A future Calendar Authority should be the **single** consumer-facing authority
for Finance, Payroll, Academic terms, Reporting, Fees/installments, Due dates,
Dashboards, and future operational modules. Other modules must not implement
their own Shamsi conversion.

Proposed boundary:
- **Input/output:** accepts/returns a canonical Gregorian date and yields the
  authoritative Shamsi date (or a Shamsi period → its exact Gregorian
  boundaries). No module stores a second "Shamsi" date truth.
- **Versioning:** conversion is pinned to a ratified calendar-algorithm
  version; each version carries the leap/equinox series it encodes so historical
  reports stay reproducible.
- **Supported range:** defined (provisionally modern operational range; explicit
  handling required for pre-1957 dates).
- **Error behavior:** fail-closed on unsupported dates/range; no silent
  approximation.
- **Boundary behavior:** month/year/Nowruz edges resolved exactly by the pinned
  series.
- **Governance:** algorithm/leap-series revisions are ratified like governed
  configuration (consistent with WP-2 S1) and become a new version; past reports
  record the version in force.

---

## 10. Unresolved risks and ambiguities (the blocker)

1. **Reference meridian / time rule.** Sources state Nowruz is the vernal equinox
   as observed from Tehran (52.5°E) *and* Kabul
   ([Calendars Wiki](https://calendars.fandom.com/wiki/Iranian_calendar)), but no
   single authoritative Afghan civil rule specifies the exact meridian/time-zone
   cutoff for Afghanistan. Kabul (≈69°E, UTC+04:30) differs from Tehran, so the
   civil Nowruz day could differ from Iran's on near-midnight equinoxes.
2. **Noon-cutoff Nowruz years.** In the current operating years 1404/1405
   (Nowruz 2025 and 2026) the equinox occurs after the noon cutoff; sources
   genuinely disagree whether 1 Hamal 1404 = 20 or 21 March 2025 (§4 R3/R4).
3. **Leap-year series.** The official leap rule is equinox-observed; the
   per-year civil leap series for the required range is not available to me as an
   authoritative published table in this environment. An arithmetic formula is
   not authoritative.
4. **Pre-1957 dates.** Official Afghan months had variable lengths before 1957,
   so fixed arithmetic is invalid for legacy dates.

Because items 1–4 affect the exact dates in TOEFL House's operating window and
its financial/academic correctness, the evidence is **insufficient to verify an
algorithm**. Per the F4-A rules I STOP here rather than select arbitrarily or
commit an unverified converter.

---

## 11. What is required to unblock (STOP — do not implement F4 until ratified)

1. An **authoritative, per-day Afghan civil (or Iranian official) calendar /
   almanac** covering at least the operational + historical range, OR an explicit
   owner ratification of a **documented conversion spec**: chosen meridian/rule
   (e.g., official noon rule at a stated meridian) plus the ratified leap-year
   series for the supported range.
2. A ratifying decision on **historical range** and handling of **pre-1957**
   variable-length-month Afghan dates (e.g., out of automated range → explicit
   treatment).
3. A ratifying decision that Afghanistan's civil Solar Hijri is adopted as the
   ERP authority (with the chosen rule), and whether Iranian-calendar references
   may serve as the technical proxy.
4. Owner-verified reference vectors for the conflicting rows (R3/R4) so the
   reference set is unambiguous.

Until these are ratified, the expected status is **F4-A BLOCKED PENDING
AUTHORITATIVE CALENDAR VERIFICATION** and **F4 production implementation remains
pending**.

---

## 12. Scope / git discipline confirmation

- **Files changed (documentation only):** this record.
- No production code, calendar conversion, library dependency, migration, or
  date-logic change was made. F1/F2/F3/S1 and the approved G2 decision are
  untouched. Working tree otherwise clean.

## 13. Sources referenced

[Solar Hijri calendar (Wikipedia)](https://en.wikipedia.org/wiki/Solar_Hijri_calendar) ·
[Iranian calendar (Calendars Wiki)](https://calendars.fandom.com/wiki/Iranian_calendar) ·
[Encyclopaedia Iranica — Calendars](https://www.iranicaonline.org/articles/calendars/) ·
[US DOJ/EOIR — Afghanistan calendar research (2010)](https://www.justice.gov/sites/default/files/eoir/legacy/2013/06/11/calendar.pdf) ·
[nongnu — Afghan Calendar algorithm](https://www.nongnu.org/afghancalendar/) ·
[timeanddate — Persian Solar Hijri calendar](https://www.timeanddate.com/calendar/persian-calendar.html) ·
[Transparent Language — Dari months](https://blogs.transparent.com/dari/2012/11/26/afghan-calendar-and-months-of-the-year-in-dari/) ·
[mtempmail Afghan converter](https://mtempmail.com/afghan-date-converter) ·
[1Rooz Persian calendar notes](https://1rooz.com/about_persian_calendar.php) ·
[whatdatetoday Nowruz series](https://www.whatdatetoday.com/persian-date-today/) ·
[emrooz 1404 calendar](https://emrooz.app/en/calendar/1404) ·
[HandWiki — Solar Hijri history](https://handwiki.org/wiki/History:Solar_Hijri_calendar)
