# WP-1 — ERP Implementation Roadmap

**Status:** WP-1 audit deliverable (documentation only — no production code modified)
**Basis:** `WP-1-capability-gap-matrix.md`. Companion to the matrix; groups the audit findings into coherent work packages in dependency order. **No implementation is authorized by this document.**

## Guiding rules carried forward

- Work packages are coherent domain bundles — not dozens of micro-tasks.
- Security/authorization and financial invariants are never weakened to ship a feature.
- Each bundle follows the established house cycle: TRACE → FIX → TEST → ATTACK (direct-SQL / denial) → REGRESSION → VERIFY.
- Anything that *extends the frozen architecture or data model* (multi-branch provenance, program levels, offerings, calendar authority) requires an explicit architecture decision before implementation — the existing modules and invariants are authoritative until a recorded decision.

---

## Dependency order (graph)

```
[ D0 Decision gates ]
   ├─ Calendar authority (S) ────────────────┐
   ├─ Governance thresholds/limits (B,M) ────┤   [ D0a ] need ratification
   └─ Legacy source data availability (V) ───┘
                       │
[ WP-2  Foundation model ]  F1 multi-branch provenance · F2 program levels/CEFR · F3 offerings/BranchAvailability (+ F4 calendar after D0)
                       │
        ┌──────────────┼─────────────────────────────┐
        ▼              ▼                             ▼
[ WP-3 Academic ]  [ WP-4 Financial ]          (WP-2 unblocks)
  AC1 placement+eligibility   FIN1 expenses/budgets
  AC2 sections/rooms/timetable  FIN2 invoices/credits/taxonomy
  AC3 transfers+financial gates  FIN3 treasury/P&L
                                FIN4 scholarship/waiver/sponsorship case
                       │
        ┌──────────────┴───────────────────────┐
        ▼                                     ▼
[ WP-5 Experience ]                       [ WP-7 Migration ]  (blocked → needs V source)
  P portal · Q inbox/reminders                legacy ingestion & cutover
  R reports/print snapshots                   (after new model is stable)
  T search/observability
  U QR/student cards
  D CRM/leads/conversion
  N retail/inventory decision
        │
        ▼
[ WP-6 Hardening ]  (perf @ volume, runbooks, residual open items from phase-4 assurance)
```

Key ordering facts:
- **WP-2 first.** Financial (branch finance, obligations, funding, P&L), academic (offerings, enrollment-to-offering, transfer provenance) and reporting (branch/P&L/period) all depend on multi-branch provenance, program levels, and the offering/term model. Extending them later would require data-model churn.
- **WP-3 before WP-4's academic-facing gates** (enrollment financial gates need the enrollment/offering/transfer model of WP-2/3 and the aid model of WP-4-FIN4 — they are joint, so AC3 and FIN4 are sequenced adjacently and gated together).
- **WP-7 last / external.** Migration is externally blocked (no source legacy DB in the checkout, no ratified cutover) and must run only after the new data model is stable.

---

## WP-2 — Foundation: model extension & architecture decisions
**Category:** foundational blockers (incl. security/authorization-adjacent configuration)

Dependencies in/out: prerequisite for almost everything; gated by **D0 decisions**.

- **F1 — Multi-branch operational model.** **SCHEMA LAYER DONE** (approved WP2-DEC-01; `000121`+`000125`): immutable `originating_branch_id` on all branch-originating records (students/enrollments/obligations/certificates/payments/refunds/fund_allocations/contracts), `current_home_branch_id` designation on each of those + `people.home_branch_id`, `branch_scope_links` with lifecycle/window invariants, schema guards, focused tests (`BranchProvenanceFoundationTest`). **REMAINING:** domain command paths for provenance/home-branch/scope-link lifecycle; populate provenance from branch context inside the existing create commands; cross-branch scope consumption by Access; per-branch finance/reporting consumers. Satisfies D-F-014 / REQ-ORG-011 and unblocks per-branch finance/reporting.
- **F2 — Program-version levels & CEFR + authority.** **FOUNDATION DONE** (approved WP2-DEC-02): `ProgramVersionLevel` model, ordered/unique/CEFR levels, cross-version class-level schema guard, `defineLevel` command, focused tests (`000122`). **REMAINING:** level-aware progression/placement/fee-packaging consumers (WP-3 G/J, WP-4).
- **F3 — Offerings & branch availability.** **FOUNDATION DONE** (approved WP2-DEC-03): `BranchAvailability`/`Offering` + `declareBranchAvailability`/`openOffering` with schema co-dependency, focused tests (`000123`). **Enrollment→offering re-point DONE** (`MaintainEnrollment` accepts `offering_id`, requires an open matching offering, and checks offering capacity at activation; `AcademicOfferingAndWaitlistFeatureTest`). **Level-targeted enrollment-to-offering DONE** (AC5): a level-targeted class cannot be enrolled without the open Offering that packages its branch×level×term (command guard + DB trigger `enrollments_offering_required_for_level_class_trigger`), and the enrollment **financial gate is scoped to the offering context** (a charge on a different Offering cannot block activation; `FinancialGateQuery` filters obligations/installments by offering while preserving global NULL-offering facts and global credits). Availability/offering lifecycle (close/cancel/capacity) is implemented (`ManageAcademicOffering`). **REMAINING:** branch×term query/UI surface presentation.
- **F4 — Calendar authority.** **IMPLEMENTED and `F4-C VERIFIED`.** Ratified D1/D2/D3/D4 in `WP2-approved-decisions.md`, implemented by `App\Modules\Calendar` (Kabul civil reference AFT UTC+04:30; ratified version-1 series SH 1399–1416; active operational window SH 1399–1415 fully served; supported range SH 1336–1425 fail-closed; Gregorian storage, derived SH semantics), and independently verified in `docs/implementation/WP-2-F4C-calendar-authority-implementation-verification.md`.
- **S1 — Governance configuration & review.** Materialize the OPEN decided governance detail as configurable, fail-closed approval thresholds and limits (D-F-007/020/022, REQ-ORG-007/013/015, REQ-FIN-001/002) on top of the complete Access engine, plus automated annual sensitive-access review (D-F-083).

Acceptance: fresh-migrate green, schema invariants for provenance FKs, branch-scope HTTP + direct-SQL attack tests, per-branch financial invariants guarded.

---

## WP-3 — Academic workflow blockers
**Category:** academic workflow blockers

Depends on WP-2 (F2 levels, F3 offerings, F1 branch). Groups AC1–AC3.

- **AC1 — Placement examination → recommendation → class assignment.** Placement exam workflow producing a **signed `AcademicEligibilityResult` / academic-context snapshot** (immutable evidence) and a recommendation, distinct from the authority that assigns the class (G capability).
- **AC2 — Sections / rooms / timetable scheduling.** Sections within a class, a `Room` catalog, and a room×timeslot timetable engine; keep the existing attendance/session evidence chain intact.
- **AC3 — Transfers, freezes, withdrawals with financial gates.** Model **transfer as a historical new enrollment (never a mutation)** with provenance; freeze/withdrawal with financial implications; and **enrollment financial gates** applying scholarship/waiver/credit/sponsorship (joint with FIN4). **DONE:** transfer-as-new-enrollment and the server-authoritative enrollment financial gate (`FinancialGateQuery` + `FinancialGateEvidence`; payment/discount/funding/credit/installment/approved exception; signed evidence frozen on `enrollments`; `academic.enrollment.financial_gate` denial + `academic.enrollment.financial_gate.denied` audit). **Remaining:** cross-branch/class transfer provenance (F1 command), freeze-with-financial implications, and the FIN4 per-case aid model.

Acceptance: HTTP + command-level SoD/lifecycle tests, evidence-snapshot immutability guards, transfer provenance tests.

---

## WP-4 — Financial blockers
**Category:** financial blockers

Depends on WP-2 (F1 branch, F2 levels, F3 offerings) and sequences adjacent to AC3.

- **FIN1 — Expenses & budgets.** Branch expense workflow with the ratified approval matrix (REQ-FIN-001/002, D-F-021…D-F-028 — Finance approver, GM substitute), an expense ledger, and operational budgets vs actual; distinct expense kind (D-G3-001 completion).
- **FIN2 — Invoices, credits, fiscal taxonomy.** Invoice/billing-statement lifecycle (invoice is currently only a print projection of an obligation), student credits/advances, and the `FinancialEventType` vs `ChargePurpose` taxonomy.
- **FIN3 — Treasury, bank/cash, P&L.** Cash/bank-account treasury reconciliation and the revenue/expense **P&L** and management-reporting sources (R depends on it).
- **FIN4 — Scholarship/waiver/sponsorship/donor case model.** On top of the restricted-fund + discount engine: per-case aid decisions, donor attribution, agreement-specific rules (D-F-097), and the enrollment financial gate (joint with AC3; G2-D-005 hold preserved).

Acceptance: every new monetary invariant schema-guarded (direct-SQL attack suite), closed-period immutability preserved, branch-aware.

---

## WP-5 — Experience, reporting & remaining ERP breadth
**Category:** UX/portal/reporting + missing legacy capabilities

Depends on WP-3/WP-4 for accurate source data.

- **P — Portals.** Student self-service (results, obligations/pay, certificates, attendance, requests) and parent/guardian view, on the Access scope model; teacher workflows already console-covered.
- **Q — Inbox / reminders / preferences.** Extend the consent-gated `Communication` engine with inbox semantics, scheduled reminders, and per-user channel preferences.
- **R — Reports & immutable print/report snapshots.** Broaden the closed catalog deliberately (P&L, roster/attendance, obligation aging) and implement **immutable snapshots** captured at run time (resolves the live-derived print concern).
- **T — Search & observability.** Cross-entity free-text search over people/students/documents/obligations/messages; richer operational dashboards.
- **U — QR / student cards / diplomas.** QR codes, card/certificate issuance & verification, diploma sealing.
- **D — Visitor / Lead / CRM / conversion pipeline**, converting into the existing Admissions intake.
- **N — Book inventory/stock & retail decision.** Decide retail scope (D-F-097 inventory UNKNOWN) then add stock/acquisition + sales routing through Finance, or formally out-of-scope.

Acceptance: each addition keeps domain authority, authz, audit; self-service is read/request only over the authoritative commands.

---

## WP-7 — Migration & legacy compatibility
**Category:** migration/data work — **externally blocked**

Depends on the entire new model being stable and on **a source legacy database and a ratified cutover** (neither exists in this checkout; the conditional cutover row is untouched). When unblocked: mapping registry from the legacy schema, idempotent importers, reconciliation, cutover with rollback, DR re-verified.

---

## WP-6 — Production hardening
**Category:** final production-hardening work

Runs last / continuously: performance under realistic data volumes (the current suite is green but small; per-branch and reporting indexes), operational runbooks for the new bundles, monitoring for the added modules, and closure of residual open items carried out of `43-phase-4-production-assurance`.

---

## Top 10 blockers (ranked)

| # | Blocker | Area | Effect | Unblocked by |
|---|---|---|---|---|
| 1 | Multi-branch operational provenance & financial-home-branch absent | A | Blocks per-branch finance/reporting; D-F-014 unrealizable | WP-2 F1 (architecture decision) |
| 2 | Program-version levels / CEFR absent | E | Blocks level-based progression/packaging/placement | WP-2 F2 |
| 3 | Offerings / BranchAvailability absent | F | Blocks registration-to-offering & branch availability | WP-2 F3 |
| 4 | Placement + signed eligibility snapshot absent | G | No evidence-based placement/class assignment | WP-3 AC1 |
| 5 | Transfer provenance / per-case aid model / freeze-financial implications | H/L | Transfer & the financial gate are implemented; aid case model, branch provenance, freeze implications remain | WP-3 AC3 + WP-4 FIN4 |
| 6 | Expenses & budgets absent | M | Branch expense approval & P&L blocked | WP-4 FIN1 |
| 7 | Invoicing/credits & fiscal-type taxonomy absent | K | No billing statements/credits | WP-4 FIN2 |
| 8 | Treasury/bank & P&L reporting absent | M/R | No management accounting | WP-4 FIN3 |
| 9 | Calendar authority (Shamsi) undecided/absent | S | Business-date & period correctness; affects F/J/K/M/R | **RESOLVED** — WP-2 F4 implemented & `F4-C VERIFIED` |
| 10 | Legacy data migration externally blocked | V | No data migration/cutover | source DB + decision (WP-7) |

---

## Recommended next WP

**WP-2 — Foundation: model extension & architecture decisions** (multi-branch provenance F1, program-version levels/CEFR F2, offerings/branch availability F3, calendar authority F4) plus the governance-configuration bundle S1.

Rationale: nearly every financial (WP-4), academic (WP-3) and reporting (R) gap is downstream of these model extensions, and F1/F2/F3/F4 modify the **frozen data model**, so they must be the first thing ratified and sequenced — they are the foundation everything else stands on. WP-2 **cannot start** until the architecture decisions it implies are authorized (WP-1 rule 6: do not modify frozen architecture without a recorded decision). The recommended next action is therefore an **architecture-decision request for F1/F2/F3/F4**, not code.

## Final state summary

- Files created: `docs/implementation/WP-1-capability-gap-matrix.md`, `docs/implementation/WP-1-roadmap.md`.
- No production code modified; working tree contains only these two new documentation files.
- Status counts (A–V primary): COMPLETE 4 · PARTIAL 14 · MISSING 3 · CONTRADICTORY 0 · BLOCKED 1 · NEEDS VERIFICATION 0. Facet view: MISSING 11 · PARTIAL 2 · NEEDS VERIFICATION 1 · CONTRADICTORY 0.
- No genuine architectural *contradiction* requiring a change to the frozen architecture was discovered; extensions requiring decisions are flagged, not self-authorized.
- The ERP is **not** claimed complete despite a green suite: green proves the certified employee surface, not ERP breadth.
