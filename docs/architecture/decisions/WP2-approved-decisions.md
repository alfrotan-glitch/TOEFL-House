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

## Authorization statement

The five decisions above are APPROVED and **authorize WP-2 foundation implementation** (schema, migrations, models, domain invariants, authorization/scope behavior, focused tests, and architecture/implementation documentation) strictly within the WP-2 foundation scope and the WP-2 execution rules. Any implementation detail that would require changing an approved decision must STOP and request a new architecture decision.
