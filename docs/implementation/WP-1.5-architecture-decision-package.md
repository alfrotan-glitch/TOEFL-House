# WP-1.5 — Architecture Decision Package (for WP-2 Foundation)

**Status:** Decision package only — **no schema, migration, model, service, route, test, or production-code change is authorized or made by this document.**
**Basis:** `WP-1-capability-gap-matrix.md` (A–V) and the frozen architecture (`docs/architecture/*`, `docs/foundation/*` decision ledger & domain contracts).
**Authority rule:** the frozen architecture and decided invariants remain authoritative until a recorded owner approval. Extensions proposed below are decision requests, not accepted state.

Each decision states the exact problem, the current frozen rule, the gap, the minimum extension, entity/relationship shape, source of truth, historical behavior (esp. unknown provenance), cross-branch/scope semantics, DB/domain invariants, how existing modules consume it, migration/backfill risk, affected tables/modules, downstream dependencies, and ≥1 rejected alternative.

Decision IDs: `WP2-DEC-01` (F1) · `WP2-DEC-02` (F2) · `WP2-DEC-03` (F3) · `WP2-DEC-04` (F4) · `WP2-DEC-05` (S1).

---

## WP2-DEC-01 — F1: Multi-branch operational provenance / financial branch semantics

### 1. Exact problem
Operational records that define academic and financial reality (enrollments, obligations, payments/allocations/refunds, funding/allocation, contracts, certificates, periods) are **org-scoped and branch-agnostic**: only the *structure* tables carry `branch_id`/`campus_id`. When a branch or campus transfers (already modeled at structure level by `campus_assignments` with `transfer_correlation_id`, decided D-F-014/REQ-ORG-011), the *operational* records cannot honor "current operations resolve to the new campus, but every historical record keeps its original campus, branch, date, attribution" because no operational record knows its originating branch — and there is no **financial/operational branch** distinct from the student's **current home branch**.

### 2. Currently frozen architecture rule
- Organization → Campus → Branch (→ Department/Operational Unit); a branch's campus membership is temporal and history-preserving via `campus_assignments` (structure-level provenance only).
- D-F-014 / REQ-ORG-011: after a transfer, historical **campus, branch, date, and attribution** are immutable.
- Operational modules are single-organization authorities; **scope** is enforced through `Access` (position/role/permission/scope grants), not through branch columns on operational data.

### 3. Missing / insufficient
- No provenance attributes (originating `branch_id`, plus current `home_branch_id`) on operational rows.
- No explicit **financial/operational branch** distinct from the current home branch.
- `scope_grants.scope_type` + untyped `scope_id` is the only branch-awareness; there is no typed junction expressing "this operation affects campus X and branch Y" (violates the "relational junctions with real FKs" concern).

### 4. Proposed minimum architectural extension
Introduce **provenance + designation as attributes and typed junctions**, without moving any financial/academic truth into a second ledger:
- Every branch-originating operational aggregate gains an immutable **`originating_branch_id`** (set at creation) and a mutable **`current_home_branch_id`** (the branch a student/record currently belongs to operationally) — both FK to `branches`.
- A person/student's **home branch** is an identity-level designation; the **financial/operational branch** of a given financial fact is captured on that fact (originating) and, where a student's operational branch differs from the financial branch of a transaction, the transaction's own originating branch governs — **home branch is never promoted to financial truth**.
- **`branch_scope_links`** typed junction: `(campus_id?, branch_id?, effective window)` with **real FKs** for cross-branch "affected scope" propagation used by authorization/audit/reporting, never as a duplicate data store.

### 5. Entities/tables (conceptual)
- Add `originating_branch_id`, `current_home_branch_id` (nullable initially — see §7) to: `enrollments`, `obligations`, `payments`, `refunds`, `payment_allocations`, `fund_allocations`, `funding_sources` (at creation), `contracts`/`contract_versions`, `certificates`, `academic_periods` (as hosted-by), `classes`.
- New junction `branch_scope_links(id, campus_id FK, branch_id FK, scope_owner_type, scope_owner_id FK, effective_from, effective_to, lifecycle_state, created_by, created_at)`.
- Identity: `people.home_branch_id` FK nullable → a *designation*, not financial truth.

### 6. Authoritative source of truth
`branches` / `campus_assignments` remain the source of truth for the **structure tree**. Each operational row's `originating_branch_id` is its authoritative provenance and is **immutable after write**. `current_home_branch_id` is the authoritative *designation* maintained by an Identity/Students command; it never drives balances.

### 7. Historical-data behavior (esp. unknown provenance)
- **No backfill of ambiguous legacy records to one branch** (explicit constraint). Records created before provenance exists stay `originating_branch_id = NULL` and are treated as **org-scope/unknown-provenance** in reporting and access, with an audited, per-record (never bulk-guessed) correction path if a human later assigns provenance with evidence.
- NULL provenance is a first-class, reportable state (`provenance = 'unassigned'`), not an error to hide.
- Cross-branch/org-scope authority still operates on these records (org-level access), so unknown provenance does not strand them.

### 8. Cross-branch behavior & scope semantics
- Authorization continues to be scope-grant based; provenance attributes and `branch_scope_links` feed **affected-scope determination** so a branch-restricted user only mutates/reads records whose originating/current branch is within the granted scope.
- A cross-branch action (e.g., an obligation paid at branch B against a student whose enrollment is at branch A) records its own originating branch and is visible under both affected scopes via the junction; balances remain in one authoritative place.

### 9. Invariants (DB/domain)
- `originating_branch_id` immutable once set (UPDATE trigger).
- `originating_branch_id`/`current_home_branch_id`/`people.home_branch_id` must reference an existing, non-archived branch (real FK).
- A record cannot be transferred to a new *originating* branch (only a new enrollment can) — provenance immutability.
- Financial totals are derived from fact rows regardless of branch attributes; provenance never changes an amount (no second financial truth).

### 10. Consumption by existing modules
Identity/Students maintains home-branch designation; Academic writes provenance at enrollment/class/period creation; Finance writes provenance at obligation/payment/funding creation; Reporting and authorization filter/aggregate by originating & current branch via the junction.

### 11. Migration / backfill risk
High but controlled: adding NOT NULL provenance is **not** done to legacy rows; a nullable `originating_branch_id` is added first, new writes populate it, and only after a governed, evidence-based assignment process would it be backfilled per record. Rollback requires dropping added columns/junction (no data loss to existing ledgers).

### 12. Affected existing tables/modules
Enrollment (Academic), obligations/payments/refunds/funding (Finance), contracts (HR), certificates (Academic), periods; Identity/Students, Access (junction), Reporting.

### 13. Downstream dependencies
F3 (offerings must know their branch), F4 (periods hosted by branch/term), financial branch reporting (WP-4), enrollment financial gates (WP-3/4).

### 14. Rejected alternatives
- **Rejected: one `branch_id` "home" column on every financial row used as both provenance and financial truth.** It would let current-home changes rewrite financial history and create two truths. Rejected per the "current home branch is not automatically the financial/operational branch" and "must not become a second independent source of truth" constraints.
- **Rejected: bulk-backfill ambiguous records to a single branch.** Directly forbidden.
- **Rejected: model branch only via untyped `scope_grants.scope_id`.** No real FK; cannot express cross-branch affected scopes reliably.

---

## WP2-DEC-02 — F2: ProgramVersionLevel / CEFR model

### 1. Exact problem
Programs and immutable program versions exist, but there is **no level entity**: a class binds to `program_version_id` directly, with no notion of a level within a version or CEFR banding. Level is the unit that progression, placement, fee packaging, and class enrollment actually operate on, so the missing level breaks G (placement→level), J (level-based progression per G2-D-003), F (offerings by level), and K/L (fee packaging by level).

### 2. Currently frozen architecture rule
`Program` → `ProgramVersion` (immutable, unique per program+version_no) → `Class`. No level authority exists; nothing defines level semantics or CEFR.

### 3. Missing / insufficient
- No `ProgramVersionLevel` entity or table; classes have no `program_version_level_id`.
- No CEFR banding or proficiency authority.
- No level-based progression rule target (G2-D-003 requires per-program *rule*; level is the natural granularity).

### 4. Proposed minimum extension
Introduce **`program_version_levels`** as a child of `program_version` with an ordered ordinal and optional CEFR mapping, and re-point `classes` (and future offerings/enrollments) at a level within a version. `program_version_level` becomes **the authority for academic level/version semantics**.

### 5. Entities/tables (conceptual)
- `program_version_levels(id, program_version_id FK, level_key, ordinal, title, cefr_ref nullable, summary, lifecycle_state, timestamps, unique(program_version_id, level_key), unique(program_version_id, ordinal))`.
- Optional small reference `cefr_levels(code PK, label)` only if a ratified CEFR authority is required; otherwise `cefr_ref` stays a plain attribute (decision needed separately).
- `classes.program_version_level_id FK` (additive; retains `program_version_id` derived).

### 6. Authoritative source of truth
`program_version_levels` is the single authority for the set and ordering of levels under an immutable program version. A level belongs to exactly one program version; it is never shared across versions (a new version declares its own levels).

### 7. Historical-data behavior
Existing `classes` without a level are migrated with a **nullable** level (unchanged semantics = "version-level unspecified") rather than inventing a level; new classes require a level once F3 offerings exist. Levels added to a published/immutable program version are not retro-edited onto closed history (provenance immutability preserved); they apply to new offerings/enrollments.

### 8. Cross-branch / scope
Levels are academic-structure data (org-scope authority via `academic.structure`), not branch-scoped; their *offerings* (F3) carry branch. No per-branch level.

### 9. Invariants (DB/domain)
- Ordinal unique per program version; `level_key` unique per program version.
- A class's level must belong to the class's program version (cross-FK CHECK).
- Levels immutable once referenced by a class/enrollment/offering/placement snapshot (additive append for correction, mirroring version immutability).

### 10. Consumption
MaintainAcademicStructure gains level CRUD inside the existing immutable-version rule; MaintainClass references a level; DecideProgression/G2-D-003 rules key off level; placement recommendation (G) targets a level; Finance packages fees by level via the offering.

### 11. Migration/backfill risk
Low for the additive table; medium for re-pointing `classes` (nullable backfill only). No existing financial truth depends on levels yet.

### 12. Affected tables/modules
`classes`, `program_versions`, `programs` (Academic); future offerings (F3), progression (J), placement (G).

### 13. Downstream dependencies
F3 (offerings per level), G (placement→level), J (progression rules), K/L (fee packaging).

### 14. Rejected alternatives
- **Rejected: put a free-text `level` string on classes/program_versions.** No ordering, no authority, duplicates program/version semantics, and cannot be a FK target for offerings/placement.
- **Rejected: make levels global across program versions.** A level's meaning must be version-bound (version is immutable), so global levels would leak across versions.

---

## WP2-DEC-03 — F3: BranchAvailability + Term + Offering model

### 1. Exact problem
Enrollment currently targets a **class** directly; a class binds `program_version_id + period_id` with no notion of which **branch** runs it, in which **term**, and under what availability. The ERP's natural registration/financial/packaging unit is an **offering** (a program-version level a branch runs in a term), and branch availability is its precondition. These three concepts are **co-dependent**, not a linear chain.

### 2. Currently frozen architecture rule
`academic_periods` = term authority (Gregorian start/end, lifecycle). `classes` belong to a program version and a period. No branch/availability/offering.

### 3. Missing / insufficient
- No `Offering`; no `BranchAvailability × Term`; branch does not host academic periods/classes.
- Registration and financial obligations attach to class/enrollment with no branch term availability or offering reference, so per-branch scheduling and fee packaging cannot be correct.

### 4. Proposed minimum extension
Model three co-defined concepts as one extension:
- **BranchAvailability**: a branch declares, for a given period/term, which program-version levels it will run (or the level declares branch availability). Availability is the coupling precondition.
- **Offering**: the concrete "branch runs level X of program version V in term T", created from an available (branch × version-level × term) combination; a class (or multiple sections) then realizes an offering.
- Enrollment targets an **offering** (level+term+branch), with classes as the physical realization.

### 5. Entities/tables (conceptual)
- `offerings(id, branch_id FK, program_version_level_id FK, academic_period_id FK, status, capacity, timestamps, unique(branch_id, program_version_level_id, academic_period_id))`.
- `branch_availabilities(id, branch_id FK, academic_period_id FK, program_version_level_id FK nullable, lifecycle_state, timestamps, unique(...))` (null level = branch-level whole-program availability statement).
- `enrollments.offering_id FK` additive; `classes.offering_id FK nullable` additive.

### 6. Authoritative source of truth
`branch_availabilities` and `offerings` are owned by Academic (`academic.structure/schedule` authority). An **enrollment may exist only if a matching offering exists and is open**, and the offering's (branch, level, term) is the authoritative packaging that Finance consumes for fees. Branch (from F1), level (from F2), term (existing academic period) are each sourced from their owning module — no new calendar or branch authority is invented here (F4 owns term semantics).

### 7. Historical-data behavior
Existing enrollments/classes without an offering stay referencing their class and are treated as "pre-offering / org-term" with nullable `offering_id`; no retro-creation of offerings for old records. New enrollments require an offering.

### 8. Cross-branch / scope
An offering is explicitly branch-bound (real FK to `branches`). A student enrolling at a branch consumes that branch's offering; cross-branch transfer becomes ending one enrollment and opening a new one at the target offering (F1/H semantics). Availability is per-branch so a level may be unavailable at one branch and available at another.

### 9. Invariants (DB/domain)
- Offering must reference an open academic period that overlaps the availability window.
- An offering requires a `branch_availability` matching (branch × level × term) — FK/composite check.
- `enrollments.offering_id` consistency: offering's level must equal the class's level when a class is linked (cross-FK).
- Offering unique per (branch, level, term); capacity not exceeded (mirror class seat rules).

### 10. Consumption
Admissions/Enrollment target offerings; Finance posts obligations against the offering's fee packaging; Reporting aggregates enrollment by offering/branch/term; Placement (G) and progression (J) consume the offering's level.

### 11. Migration/backfill risk
Low for additive tables; the risk is conceptual (re-pointing enrollment→offering). New-enrollment-only gate avoids touching history.

### 12. Affected tables/modules
`enrollments`, `classes`, `academic_periods` usage (Academic); Admission conversion (Admissions); obligations (Finance) later; Reporting.

### 13. Downstream dependencies
H (registration/enrollment), K/L (fee packaging), G (placement→offering/level), R (reporting by branch/term).

### 14. Rejected alternatives
- **Rejected: linear chain "availability → then offering → then class" as independent tables with no mutual constraint.** The three are co-dependent; an offering without a matching availability or an availability that no offering realizes is a contradiction. Enforced as one coherent extension with cross-FKs.
- **Rejected: fold availability into a simple enum/flag on offerings.** Cannot express "which terms/levels a branch will run in the future" before an offering exists (planning), which availability must support.

---

## WP2-DEC-04 — F4: Calendar authority / Shamsi–Gregorian semantics

### 1. Exact problem
The system stores Gregorian/ISO dates only; there is no business-calendar authority. Academic terms, financial/payroll periods, reporting periods, invoices/receipts, attendance, and dashboards therefore have no consistent Shamsi–Gregorian business-date semantics, and period alignment across modules (academic vs financial vs payroll) cannot be guaranteed. The legacy system carried a `jalali.ts` utility (reference-only).

### 2. Currently frozen architecture rule
Each period authority is Gregorian and owned by its module (Academic `academic_periods`, Finance `financial_periods`, Payroll `payroll_periods`); there is no calendar decision and no cross-period alignment authority. Legacy calendar code is explicitly reference-only.

### 3. Missing / insufficient
- No single calendar authority; date handling is ad-hoc Gregorian.
- No defined behavior for how a Shamsi business date is stored, derived, or displayed, or how periods/reporting periods map.

### 4. Proposed minimum extension
Pick one of three calendar policies (below); the chosen policy is implemented as a **calendar service** owned by a calendar/configuration authority that exposes conversions and defines the canonical "business date," while **storage stays a single canonical date representation** (no dual-date columns that can disagree).

### 5. Three-way comparison

| Option | Storage | Business truth | Cost / risk | Fit |
|---|---|---|---|---|
| **G1 Gregorian-only** | Gregorian everywhere (today) | Gregorian is the only business date; Shamsi only as a display conversion if ever needed | Zero new risk; lowest cost | Least fit for an Afghan institution whose operational business dates are Solar Hijri |
| **G2 Shamsi-first with Gregorian storage/derivation** | Gregorian (canonical, computed-safe) | **Shamsi is the business date**; every business period keyed/documented in Shamsi, stored as the exact Gregorian instant/date and *derived* to Shamsi on demand from a ratified conversion (fixed algorithm, tables of leap rules) | Medium: needs a ratified fixed algorithm; no ambiguous dual storage; all range math done on the canonical Gregorian, displayed/perioded in Shamsi | **Recommended** |
| **G3 Dual-calendar authority (both stored/authoritative)** | Two canonical date columns per event | Both Gregorian and Shamsi authoritative | High: two independent truths can disagree; every invariant doubled; migration/backfill heavy | Over-engineered; rejected |

**Recommendation: G2 — Shamsi-first business semantics with a single canonical Gregorian/ISO storage and an authoritative, immutable, versioned Shamsi conversion/algorithm.** Rationale: it honors Solar-Hijri as the operational business calendar while keeping one stored truth (no date disagreement, range arithmetic and DB invariants stay on the canonical Gregorian date), and it keeps migration risk bounded.

### Consequences of G2 per domain
- **Academic terms:** period keys/starts/ends expressed in Shamsi; stored as exact Gregorian bounds; no gap in cross-term continuity.
- **Payroll:** period-day proration (today uses Gregorian day counts) computed on canonical dates; Shamsi is labeling/business-identity only — **amounts and proration math are unchanged** because they derive from canonical dates.
- **Finance:** financial periods keyed by Shamsi period; posting dates validated on canonical dates; period-open/closed logic unchanged (already on dates).
- **Reporting:** reporting periods and range queries resolve on canonical dates, labelled in Shamsi.
- **Invoices/receipts:** business date printed in Shamsi (from canonical), immutable on the snapshot.
- **Attendance:** attendance facts keyed to canonical date; displayed per Shamsi term.
- **Dashboards:** period buckets in Shamsi; range queries on canonical date — no bucketing drift.
- **Date-range queries:** all DB `BETWEEN`/range predicates execute on the canonical date column (index-safe); Shamsi filtering never hits SQL directly.
- **Immutable snapshots:** a snapshot stores the canonical date + the ratified calendar algorithm version, so the Shamsi label is always reproducible — never a stored second date that can drift.

### 6–9. Entities/source-of-truth/historical/cross-branch/invariants
- **Source of truth:** a calendar-config record capturing the chosen scheme (`scheme = 'shamsi_gregorian'`), the ratified algorithm/table version (`calendar_scheme_versions`), and the display default. Conversion is a pure function of (canonical date, algorithm version) — no stored dual dates.
- **Historical:** canonical dates already stored remain correct; they gain Shamsi derivation retroactively by the fixed algorithm (deterministic, auditable, not a data guess). No backfill of a second column.
- **Cross-branch/scope:** calendar is org-wide (a single institution calendar authority); not branch-scoped. (If the institution ever needs per-branch calendars, that is out of the current decision.)
- **Invariants:** a stored date is always canonical; any displayed Shamsi value is derived and tagged with the algorithm version; period-open/closed and proration always use canonical arithmetic.

### 10–14. Consumption, risk, affected, downstream, rejected
Consumed by every period authority and every snapshot. Risk: medium for first adoption of a ratified algorithm (must match statutory rules); affected: `academic_periods`, `financial_periods`, `payroll_periods`, reporting periods, print snapshots, attendance. Downstream: F1 term hosting, R reporting periods, S. **Rejected G3 (dual authority)** and **Rejected G1 (Gregorian-only)** per the comparison — G1 rejected because it cannot represent the operational Solar-Hijri calendar faithfully; G3 rejected because two authoritative dates violate single-source-of-truth and double every invariant. *Decision requires explicit owner approval (introduces a calendar authority not present in the frozen architecture).*

---

## WP2-DEC-05 — S1: Governance configuration & audit

### 1. Exact problem
Multiple decided governance items are recorded as **OPEN thresholds/limits** (D-F-007 risk/value thresholds; D-F-020/022 branch operating & financial limits; D-F-036 department scopes; REQ-ORG-007/013/015; REQ-FIN-001/002 branch expense limits; D-F-083 annual access review), but there is no configuration registry for them and no rule for what is configurable vs hard-coded or how changes are versioned/audited.

### 2. Frozen rule
Fail-closed by default (no threshold ⇒ deny); sensitive actions already require two-Owner/Finance/GM flows in code (the *process* is frozen); the numeric/class thresholds themselves were never ratified.

### 3. Missing / insufficient
A single place to declare, version, and audit governed numeric/class configuration without weakening the fail-closed or two-Owner code paths.

### 4. Proposed minimum extension
A **configuration registry** (`governed_configs`) whose rows are typed, versioned, and audited — **not** a free-form key/value blob. Structure-change & money actions read it; absence ⇒ fail closed.

### 5. Entities (conceptual)
- `governed_configs(id, config_key, config_type, value JSONB, effective_from, effective_to nullable, supersedes_id, lifecycle_state, approved_by, review_cycle, timestamps, unique(config_key, effective_from))`.
- Audit via the existing `Audit`/`audit_events` module (each activation/revision is a governed, authorized event).

### 6. What must be configurable vs hard-coded
- **Configurable (typed, versioned):** monetary/risk approval **thresholds and limits** by action type and scope (branch expense, discount, refund, compensation, restricted-fund allocation, disposal value); department-scope definition references; **annual-review cycle**; expense approval routing (Finance approver / GM substitute) — the *identity* of the allowed approver per limit class.
- **Hard-coded (never config-driven):** fail-closed default-deny; two-Owner rules for org-wide/sensitive actions; the separation-of-duties invariants (one person never initiates+approves+records+reconciles); immutable-source/cap rules on money; calendar scheme; authority provenance immutability. These are domain invariants, not configuration.

### 7. Versioning & audit
Each change is a **new effective version** (append; never in-place edit). Activation requires the authority the config governs (a change to two-Owner thresholds must itself be a two-Owner decision). Every read is logged, and the audit module records who changed a threshold, from→to, effective window, and reason. Reporting/snapshots capture the config version in force at the time (so past approvals are reproducible).

### 8. Consumption
Approval workflows (StructureDecision, Finance, HR) read the current version for the action+scope and fail closed if none; annual-review jobs enumerate sensitive grants against the review cycle.

### 9. Migration/backfill risk
Low: seeded with current fail-closed defaults and *no* invented thresholds (explicit rule — thresholds must not be invented). Adoption is forward-only.

### 10–14. Affected / downstream / rejected
Affected: Finance (expense/refund/discount/disposal), HR (compensation), Access (review cycle), StructureDecision. Downstream: M (expenses/budgets) and B (annual review). **Rejected:** a free-form `settings` key/value table (no type safety, no versioning, no audit) and hard-coding all thresholds (defeats the decided configurable-limits governance). *Requires explicit owner approval to ratify the actual threshold numbers/classes.*

---

## Decision table

| Decision ID | Recommended choice | Alternatives rejected | Impact | Dependencies | Requires explicit owner approval? |
|---|---|---|---|---|---|
| **WP2-DEC-01 (F1)** | Provenance + designation attributes (`originating_branch_id`, `current_home_branch_id`, nullable) + typed `branch_scope_links` junction (real FKs); no bulk backfill | (a) single `branch_id` used as provenance+financial truth; (b) bulk-backfill ambiguous rows; (c) branch only via untyped scope grants | Adds provenance to academic/financial/HR records; enables D-F-014, per-branch finance & reporting | F3 (offerings per branch), F4 (term hosting); Access | **YES** (extends frozen data model) |
| **WP2-DEC-02 (F2)** | New `program_version_levels` (ordered, unique per immutable version) + optional CEFR; classes re-point to level (nullable backfill) | (a) free-text level strings; (b) levels global across versions | Enables level-based progression/placement/packaging | F3, G, J | **YES** (extends Academic structure authority) |
| **WP2-DEC-03 (F3)** | Co-defined `offerings` + `branch_availabilities` (branch × version-level × term) as one extension with cross-FKs; enrollment targets offering | (a) linear independent availability→offering→class tables without mutual constraints; (b) availability as enum flag on offerings | Correct per-branch registration & fee packaging | F1, F2 | **YES** |
| **WP2-DEC-04 (F4)** | **G2 Shamsi-first business semantics, single canonical Gregorian storage + authoritative versioned derivation** | G1 Gregorian-only; G3 dual-calendar authority (two stored truths) | Adds a calendar authority; terms/payroll/finance/reporting/invoices/attendance/dashboards/ranges/snapshots all calendar-correct | Affects all period authorities & snapshots | **YES** (new authority, not in frozen arch) |
| **WP2-DEC-05 (S1)** | Typed, versioned, audited `governed_configs` registry (append-only effective versions; fail-closed on absence); configurable = thresholds/limits/routing/review-cycle; hard-coded = SoD/default-deny/immutability invariants | (a) free-form settings key/value blob; (b) hard-coding all thresholds | Ratifies OPEN governance thresholds/limits & annual review | B, M; Audit | **YES** (ratifies actual threshold numbers/classes) |

No production code, migrations, schema, or test changes were made by this package. Working tree state below.

---

WP-1.5 ARCHITECTURE DECISION PACKAGE COMPLETE — AWAITING ARCHITECTURE APPROVAL
