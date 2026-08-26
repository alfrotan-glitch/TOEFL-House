# Package 13 Checkpoint — Reporting (Metrics, Projections, Reconciliation, Dashboards)

**Package:** 13 — Reporting (sequence row 12: reports, metrics, dashboards — contract/integration tests)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 12 checkpoint (`34-package-12-assets-operations-communication-checkpoint.md`) at commit `169438a`

## Discover

- Governance inputs consumed: reporting architecture (12 — metrics read canonical outputs and **never write sources**; rebuildable projections carry source/version/as-of; stale/incomplete data labeled or withheld), derived-data lineage registry (38 — per-family source facts + rule authority + as-of semantics; **no manual override**), reporting/derived-data contract (48 — metric families table; **dashboards cannot write sources or define competing balances**; no silent period/scope mixing; **configuration versions retained**), foundation 23 (centralized Solar Hijri periods; reports may not redefine balance/revenue/attendance/payroll), entity/relationship/authority registries (29/31/33 — Reporting entity, export/notification authority).
- Reporting consumes Finance, Payroll, Academic (delivery) and Funding **read-only**; periods are always resolved from the owning module's registry — Reporting never defines a period.

## Map (implemented scope)

- **Metric catalog** (`MetricDefinition`, `MetricVersion`): only the five canonical catalog metrics are definable (`MetricCatalog::entry` rejects anything else — `reporting.metric_unknown`): `student_outstanding_balance` (finance, financial_period, global|student), `payroll_total` (payroll, payroll_period, global), `active_enrollment_count` (academic_delivery, academic_period, global|class), `attendance_rate` (academic, academic_period, global|class), `fund_utilization` (funding, financial_period, fund). Definitions carry `source_owner` and `period_authority` (CHECK-constrained). **Calculation specs are versioned**: definition creates version 1; revision appends `version_no + 1` with its own `effective_from`; versions are **immutable** (DB trigger) so historical reports keep their original definition; revising marks projections of superseded versions **stale**.
- **Period authority** (`MetricCatalog::resolvePeriod`): financial/payroll periods resolve by `period_key`, academic periods by `id` — the same human key resolves per its own authority and **never leaks across authorities** (unit-proven: `2026-12` resolves to different rows under financial vs payroll; an academic id is not a financial key, …). Unknown key → `reporting.period_unknown`; unknown authority → `reporting.period_authority_unknown`.
- **Calculators** (Queries — the only value source; no manual metric entry anywhere): outstanding balance = obligation lines − payment allocations − approved discounts − fund allocations; payroll total = approved payroll results + adjustments; active enrollment count = enrollments `active` in classes of the period; attendance rate = present ÷ recorded facts (late/absent/excused counted as recorded); fund utilization = fund allocations as-of period end ÷ committed (timestamptz `created_at` vs `date_to` compared date-wise, binding verified).
- **Projections** (`MetricProjection`): rebuildable slices keyed by (metric version, period key, scope type, scope id) with **one slice** per key (COALESCE partial-unique index); identity columns are **rebuild-locked** (trigger rejects re-keying) while value/completeness/meta rebuild in place; `completeness ∈ {complete, stale}`; a revision flips prior-version slices to `stale` — **labeled, never silently trusted**.
- **Report runs** (`ReportRun`): each run pins metric version + period key + scope + filters, stores the computed result and a **reproducibility hash** over (metric, version, spec, period, scope, filters, value); rows are **immutable** (DB trigger) — a report can be re-executed and compared, never edited.
- **Reconciliation** (`MetricReconciliation`): recomputes the metric straight from the authoritative source and compares with the latest reported projection for the slice; records reported/authoritative/variance with the **variance identity enforced by CHECK** (`variance = reported − authoritative`); status ∈ {matched, diverged}; **divergence is immutable evidence for the source owner — never an alternate truth and never overwritten**; reconciling without a reported projection → `reporting.nothing_reported`.
- **Dashboards** (`Dashboard`, `DashboardPin`): named dashboard (unique) + immutable pins referencing a registered metric with explicit period and scope; **one pin per slice** (COALESCE partial-unique index); pinning requires a **complete, current-version** projection — never-computed (`reporting.pin_no_projection`) and stale (`reporting.pin_stale`) slices are **withheld**. Dashboards write nothing to any source module.
- Capabilities: `reporting.catalog` (define/revise), `reporting.compute` (projections), `reporting.run` (report runs), `reporting.reconcile`, `reporting.dashboard` — all separate; capability check precedes validation (denied operations audited as `reporting.*.denied` with no row).
- Error codes: `reporting.metric_unknown`, `reporting.metric_spec`, `reporting.metric_exists`, `reporting.period_authority_unknown`, `reporting.period_unknown`, `reporting.scope_not_allowed`, `reporting.scope_shape`, `reporting.nothing_reported`, `reporting.pin_no_projection`, `reporting.pin_stale`, `reporting.pin_exists`, `reporting.dashboard_exists`, `reporting.fund_scope_required`, `reporting.fund_unknown`, and `reporting.{catalog,compute,run,reconcile,dashboard}_denied`.
- Persistence: 6 migrations (`2026_08_26_000076`–`000081`); CHECK constraints (source_owner, period_authority, scope types, completeness, reconciliation statuses, **variance identity**); unique indexes (metric key, one version per (metric, version_no), one projection slice, dashboard name, one pin per slice); immutability triggers on versions/runs/reconciliations/pins; rebuild-only trigger on projections.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 337 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (278 tests, 1118 assertions)** |
| integration tests | PASS | finance/payroll/academic/funding metric chains against PostgreSQL with full authoritative fixtures (5 feature tests + catalog unit suite) |
| contract tests (boundary) | PASS | Finance/Payroll/Academic/Funding consumed **read-only** (calculators query; commands never write them); Reporting owns only its 6 tables |
| metric accuracy tests | PASS | each metric verified against an independently computed authoritative value (3500.00 outstanding = 8500−4000−1000; 0.5000 attendance = 1/2; 2 active seats; 0.2500 utilization = 2500/10000; payroll 0.00 on an empty period) |
| as-of / period semantics | PASS | unknown/future period rejected; payroll metric cannot resolve a financial-period key and vice versa (unit + feature); fund utilization as-of period end |
| scope enforcement tests | PASS | scope outside the metric declaration (`reporting.scope_not_allowed`); global-with-id / scoped-without-id (`reporting.scope_shape`); fund scope required |
| source-of-truth tests | PASS | tampered projection → reconciliation records `diverged` with variance 6499.0000 while sources stay untouched; divergence preserved, never overwritten |
| stale-labeling tests | PASS | revision marks prior projections stale (asserted); stale/never-computed slices withheld from dashboards |
| invariant tests | PASS | `SchemaInvariantFeatureTest` extended: 5 new unique indexes, 4 CHECK vectors (source_owner, period_authority, completeness, variance identity), 5 trigger catalog assertions; raw SQL UPDATE/DELETE of report runs and metric versions rejected by triggers |
| authorization tests | PASS | unprivileged projection denied, audited (`reporting.projection.compute.denied`), no row |
| idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | database migrated to all **81 migrations** (testing + dev) |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Defining a metric outside the canonical catalog (`invented_kpi`) — rejected (`reporting.metric_unknown`); the catalog is closed.
2. Computing against a period that does not exist under the metric's authority (unknown and future `2099-01`) — rejected (`reporting.period_unknown`).
3. Cross-authority period confusion — payroll metric handed a financial-period key (and the mirrored unit matrix) — rejected; the same key `2026-12` resolves independently per authority, never cross-wired.
4. Scope not declared for the metric (fund scope on a student metric) — rejected (`reporting.scope_not_allowed`); global-with-scope-id and fund-without-id — rejected (`reporting.scope_shape`).
5. Manual value entry / editing evidence — raw SQL `UPDATE report_runs` and `DELETE metric_versions` — rejected by triggers; projections can only rebuild value/completeness, never re-key (trigger).
6. Silent divergence — a tampered projection value (9999 vs authoritative 3500) — reconciliation records `diverged` with the exact variance (6499.0000) as immutable evidence; the authoritative source is untouched; the CHECK variance identity blocks forged variance rows.
7. Stale data presented fresh — after a spec revision the prior-version projection is `stale` (asserted) and pinning it (or a never-computed slice) is withheld (`reporting.pin_stale` / `reporting.pin_no_projection`).
8. Double definition / double pin / duplicate dashboard name — rejected (unique indexes + `reporting.metric_exists` / `reporting.pin_exists` / `reporting.dashboard_exists`).
9. Reconciling a slice with no reported projection — rejected (`reporting.nothing_reported`); reconciliation cannot fabricate a baseline.
10. Unprivileged metric definition/compute — denied before validation, audited as denied operations, no rows.

## Repair log (attacks that found real defects)

1. **`FundUtilizationCalculator` period lookup** — `whereKey($periodId)` compiled to `WHERE "key" = …` (wrong column; `financial_periods` is PK `id` + unique `period_key`) and blew up on compute. Repaired to an explicit `where('id', …)`; retested green.
2. **Payroll/financial period-key collision in fixtures** — both fixtures used `2026-12`, so the "cross-authority rejection" vector initially passed for the wrong reason (the key existed under payroll too). Repaired by distinct keys (`2026-12-P`) and a unit matrix proving same-key/per-authority resolution.
3. **Attendance fixture arithmetic** — 2 active enrollments seeded but 3 statuses offered (expected 0.6667, actual 1.0000). Test-side repair to 2 facts/1 present = 0.5000.
4. **Fund allocation exceeding the uncovered obligation remainder** (5000 > 3500) — the Finance guard correctly rejected it; funding fixture reduced to 2500 (utilization 0.2500).
5. **phpstan** — `RunReport::run` `$filters` iterable value type missing; docblock added.

## Decide

- **Closed catalog**: `MetricCatalog` (code) is the registry of definable metrics; the DB stores definitions/versions as evidence. A metric outside it cannot exist — governance-mandated.
- **Reporting never defines periods**: periods resolve exclusively from the owning module (financial/payroll by `period_key`, academic by `id`); no Reporting table stores a period row.
- **Immutable versions, rebuildable projections**: historical report runs stay reproducible against the exact spec version; projections rebuild in place but slice identity (version, period, scope) is trigger-locked.
- **Divergence is evidence, not correction**: reconciliation records variance and reports it to the source owner; it never edits sources or the reported value (immutability triggers).
- **Dashboards are pinboards**: they hold references to registered metric slices only; no computed values of their own, no writes to sources, stale slices withheld.

## Certify

All gates PASS on 2026-08-26: phpunit **278 tests / 1118 assertions** (cumulative Package 02–13), phpstan level 6 clean, pint 337 files, testing + dev databases at **81 migrations**, `P02-environment-recovery.sh --verify` → ENVIRONMENT VALID, adversarial vectors all fail closed, repairs reverified by the full suite. Independent review: contract boundaries (read-only consumption), closed metric catalog, period-authority isolation, immutability/staleness semantics, and reconciliation variance identity all verified against the governance registries. Package 13 is **CERTIFIED**.
