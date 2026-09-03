# WP-2 — Approved Architecture Decisions

**Status:** APPROVED — records the WP-1.5 decision package acceptance and authorizes WP-2 foundation implementation.
**Approval date:** 2026-09-03
**Authorizing input:** WP-1.5 Architecture Decision Package (`docs/implementation/WP-1.5-architecture-decision-package.md`), owner-approved.
**Branch:** `arena/01a062e3-toefl-house`

These decisions are formally approved architecture decisions. Their authority, consequences, and invariants are as described in the WP-1.5 package and summarized below. WP-2 implementation is authorized **only** to the foundation scope (F1–F4 + S1) described here and in the WP-2 execution rules. Downstream WP-3 (academic), WP-4 (financial), WP-5 (experience) capabilities are **not** authorized by this record.

---

## Decision ledger

### WP2-DEC-01 (F1) — Multi-branch operational provenance & financial branch semantics
- **Approved choice:** Immutable `originating_branch_id` + nullable designation `current_home_branch_id` on branch-originating operational records; a typed relational `branch_scope_links` junction with real foreign keys for cross-branch affected-scope propagation. **No fabricated historical backfill.** Home branch is a designation and **never becomes financial truth.**
- **Rejected alternatives:** (a) a single `branch_id` used as both provenance and financial truth; (b) bulk-backfilling ambiguous records to an arbitrary branch; (c) branch-awareness only through untyped scope grants.
- **Rationale / consequences:** Enables D-F-014 (post-transfer historical attribution immutable) and per-branch finance/reporting without a second ledger. Unknown/ambiguous provenance stays a first-class `NULL`/`unassigned` state; provenance is immutable after write.
- **Dependencies:** F3 (offerings per branch), F4 (term hosting), Access (scopes).

### WP2-DEC-02 (F2) — ProgramVersionLevel / CEFR
- **Approved choice:** `ProgramVersionLevel` is the authoritative academic level/version model — an ordered level child of an immutable `ProgramVersion`, optional CEFR reference. Classes re-point to a level (nullable backfill for pre-existing rows only).
- **Rejected alternatives:** free-text level strings; levels shared globally across versions.
- **Rationale / consequences:** Level becomes the target for progression (G2-D-003), placement, and fee packaging while preserving program-version immutability.
- **Dependencies:** F3, WP-3 G/J.

### WP2-DEC-03 (F3) — BranchAvailability + Term + Offering
- **Approved choice:** Co-dependent `Offering + BranchAvailability + Term` model with relational constraints; enrollment targets an **Offering**.
- **Rejected alternatives:** independent linear tables with no mutual constraint; availability folded into an enum flag.
- **Rationale / consequences:** An enrollment exists only when a matching open offering exists; availability is branch-scoped; the offering (branch × level × term) is the packaging unit finance consumes.
- **Dependencies:** F1 (branch), F2 (level).

### WP2-DEC-04 (F4) — Calendar authority / Shamsi–Gregorian
- **Approved choice:** **Shamsi-first business semantics with a single canonical Gregorian stored date and authoritative, versioned Shamsi derivation.** No dual stored date truths.
- **Rejected alternatives:** Gregorian-only business truth; dual-calendar authority storing two canonical dates.
- **Rationale / consequences:** Solar Hijri is the operational business calendar; storage and DB range arithmetic stay on one canonical Gregorian date; all Shamsi display/derivation is a pure function of the canonical date plus a ratified calendar-algorithm version, keeping snapshots reproducible.
- **Dependencies:** all period authorities and print/report snapshots.

### WP2-DEC-05 (S1) — Governed configuration
- **Approved choice:** Typed, versioned, audited `governed_configs`. Configurable: approval thresholds/limits, expense-approval routing, annual-review cycle. **Hard-coded invariants:** separation of duties, default-deny, financial immutability/cap rules, calendar scheme, provenance immutability.
- **Rejected alternatives:** a free-form `settings` key/value blob; hard-coding all thresholds.
- **Rationale / consequences:** Ratifies OPEN governance thresholds/limits with fail-closed-on-absence behavior and append-only effective versions; every change is an audited, authorized event.
- **Dependencies:** Audit; downstream WP-4 M.

---

## F4-A Calendar Authority ratification (D1–D4) — recorded 2026-09-03

The architecture owner ratified the following decisions that operationalize
**WP2-DEC-04 (F4 / G2)** by fixing the authoritative Solar Hijri reference
series and civil-clock rule, and that flip the F4-A verification gate from
`BLOCKED` to `VERIFIED`. These ratifications **do not alter** WP2-DEC-04 (G2) —
Shamsi-first business semantics over a single canonical Gregorian stored date
with authoritative, versioned Shamsi derivation remains the approved decision.
Recorded here for auditability; the full series data, vectors, and provenance
live in `docs/implementation/WP-2-F4A.3-solar-hijri-reference-series-ratification.md`
and the F4-A record (`WP-2-F4A-calendar-authority-verification.md`, §F4-A.4).

- **D1 — Operational range.** Active operational window SH 1399–1415
  (~2020–2037); full supported deterministic range SH 1336–1425 (1957
  fixed-structure → ~2047); pre-1336 dates fail closed / require manual
  handling; no fabrication of historical calendar or branch/date provenance
  outside verified evidence.
- **D2 — Reference civil clock.** Kabul local civil time, **AFT = UTC+04:30**,
  is the TOEFL House Calendar Authority reference clock, with the documented
  noon-cutoff rule applied against Kabul civil time. **This is a TOEFL House
  product/architecture decision, not a claim that a currently published Afghan
  government source mandates this exact computational rule.** The 1408
  divergence (Nowruz 2029: Kabul noon ⇒ 1 Hamal 1408 = 2029-03-21, where a
  Tehran-noon rule would give 2029-03-20) is preserved as the documented reason
  D2 matters.
- **D3 — Reference-series authority.** The annual equinox/reference series in
  the F4-A.3 spec is ratified as the **version-1 reference dataset** and is
  authoritative for supported dates. Any arithmetic algorithm (33-year,
  2820-year, ICU/Persian, generic Jalali) is only an implementation mechanism
  that **must** be validated against the ratified reference series — never the
  sole authority.
- **D4 — Acceptance vectors.** F4-A.3 vectors **T01–T17** are the initial
  acceptance/test-vector set with provenance tags (EQUINOX / DERIVED /
  ATTESTED / REQ-D2); under D2 the REQ-D2 rows resolve to the Kabul branch
  (T12 = 1 Hamal 1408 = 2029-03-21). Implementation must satisfy the vectors
  plus the round-trip invariants.

**F4-A status:** `F4-A VERIFIED` (F4 production implementation remains a
separate, later phase and remains **pending**; this record authorizes no code or
schema change and does not implement the Calendar Authority).

---

## F4-C active-window completion ratification (2026-09-04)

The architecture owner ratified **`1 Hamal 1416 = 2037-03-20`** as a version-1
Calendar Authority anchor (2037 vernal equinox `2037-03-20 06:50 UTC`; 11:20 AFT,
before Kabul noon under D2). This completes the D1 active operational window
**SH 1399–1415** without expanding the supported deterministic range
**SH 1336–1425**. The 1416–1425 and 1336–1398 tails remain **not ratified** and
must continue to fail closed until separately pinned and ratified under F4-B
§2.5. No other F4 decision or Calendar Authority boundary is changed.

---

## Authorization statement

The five decisions above are APPROVED and **authorize WP-2 foundation implementation** (schema, migrations, models, domain invariants, authorization/scope behavior, focused tests, and architecture/implementation documentation) strictly within the WP-2 foundation scope and the WP-2 execution rules. Any implementation detail that would require changing an approved decision must STOP and request a new architecture decision.
