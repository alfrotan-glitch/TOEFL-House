# WP-11 Reporting & Analytics — Reconstruction Plan

**Work Package:** WP-11 Reporting & Analytics (`reports`, `dashboard`, `bos`, `search`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§2, 7–10, 16–21,
24–42, 49–54, 58–76, 84, 89–101

**Owner authority:** D-13 requires every §30 report category end-to-end:
daily, weekly, monthly, quarterly, annual, financial, academic, student,
visitor, enrollment, attendance, teacher, payroll, management, operational and
audit reporting. Existing D-11/D-12/D-14/D-15/D-45–D-47/D-61 continue to govern
currency, whole-AFN precision, RBAC, bilingual/RTL, calendar authority and BOS
treasury policy.

**Risk class:** Critical — reporting is a financial/security decision surface;
changes can create contradictory metrics, incorrect period boundaries,
unauthorized disclosure or misleading operational action.

**Recovery baseline:** `8f84d8ba525c8fdf64826bac925e7ad803f0fd96`
(`certify: complete WP-10 books lending`), committed/pushed clean state.

---

## SCOPE

### Included

- Declared report catalog, metric definitions, report engine, period/key/range
  resolution, report API contracts, CSV export, printing and Reports UI.
- Reporting consumers in `reports.routes.ts`, dashboard summary, executive BOS
  analytics and global search where they expose a reportable metric or a
  server-side query contract.
- Metric/authority/invariant registry reconciliation and replacement of legacy
  WP-11 test authority under `server/src/tests/work-packages/wp11/`.
- Permission/branch-scope enforcement, period consistency, data-operation bounds,
  freshness, export/print reconciliation, performance/query-plan evidence and
  adversarial reporting attacks.

### Excluded

- Finance transaction, invoice, payroll, funding or Book-domain redesigns. WP-11
  consumes their already-defined authorities and must not create replacement
  money writers.
- New treasury thresholds, profit tiers, lending charges, finance policy or
  other business rules absent an owner decision. D-61 remains the only BOS
  threshold policy authority.
- Workflow/automation and audit-log architecture redesign, owned by WP-12 and
  WP-13, except direct consumer changes needed so their facts are reported
  correctly.

### Route / consumer boundary

| Surface | Current responsibility | WP-11 required result |
|---|---|---|
| `reports.routes.ts` | giant operational/financial overview plus a smaller declared report catalog | one report/metric execution boundary; overview becomes a documented consumer, never a parallel metric author |
| `report-catalog.ts` / `report-engine.ts` | catalog/engine supports current named periods | complete D-13 category set with historical canonical Shamsi key support and exact scoped execution |
| `ReportsView.tsx` | current-period catalog runner, CSV and print | server-authoritative historical period/range selection, permission-aware catalog, print/export reconciliation and intentional states |
| `dashboard-summary.ts` / Dashboard UI | server summary mixed with client-derived queue/chart lists | one server-owned KPI/work-queue model; no UI metric calculation or role-name gates |
| `bos.routes.ts` / BOS UI | direct analytic SQL alongside treasury policy | consume declared metric/window authorities where semantics coincide; preserve D-61 policy only in its policy authority |
| `search.routes.ts` / GlobalSearch | bounded multi-entity query | explicit server-side relevance, permission and branch scope; no reporting metric authority in the browser |

---

## DISCOVER — read-only evidence

| Finding | Evidence |
|---|---|
| The metric catalog contains all eleven report categories required by D-13, but `runReport()` accepts only a current named period and ignores a historical Shamsi key or explicit range. | `server/src/core/reporting/report-catalog.ts`, `report-engine.ts`, `ReportsView.tsx` |
| `GET /api/reports/overview` separately defines many financial, student, visitor, placement, Book and outstanding-balance SQL aggregates even though the report catalog/engine already defines overlapping metrics. | `server/src/routes/reports.routes.ts` lines 127–548; metric catalog/registry |
| The overview resolver handles historical Shamsi keys and a bounded range, while the generic report engine does not. Same report period can therefore mean different inputs by endpoint. | `resolvePeriod()` in `reports.routes.ts`; `runReport()` in `report-engine.ts` |
| `/reports/catalog` returns every declared report to any `Report.View` principal, while `/run/:reportId` applies the report’s own permission only after selection. The UI can offer a report it cannot run. | `reports.routes.ts` lines 555–607; `ReportsView.tsx` |
| Reports UI offers only current named periods and has no canonical historical-key/range control. | `ReportsView.tsx` lines 88–156 |
| Dashboard summary correctly uses server SQL for headline populations/cash flow, but the Dashboard UI still derives queue/chart lists from loaded `visitors`/`budgetLines` and gates BOS affordances with a role label. | `dashboard-summary.ts`; `DashboardView.tsx` `visitors.filter`, `budgetLines.filter`, `activeRole` checks |
| BOS exposes executive, marketing, student and warning analytics through direct SQL and has its own period parser. Some analytics duplicate reportable population/revenue definitions; malformed placement JSON is silently skipped. | `bos.routes.ts`; `dashboard-summary.ts`; `report-catalog.ts` |
| Global search is server-side, permission/branch scoped and bounded, but it has independently assembled result/ranking semantics and needs a declared query contract rather than frontend inference. | `search.routes.ts`, `GlobalSearch.tsx` |
| Existing WP-11 legacy authority is 11 files / 143 cases, all top-level rather than package-local. | `docs/legacy-test-inventory.md` WP-11; `server/src/tests/*report*`, `*dashboard*`, `*freshness*` |
| Baseline focused authority is executable. | 2026-08-23: `npx vitest run` over the 11 inventoried WP-11 files — **11 files / 143 tests passed** |

### Root cause

Reporting was partially reconstructed: a generic catalog/engine exists, but the
historic overview, dashboard and BOS surfaces still carry independent query,
period and presentation decisions. Passing tests prove many local repairs, not
one reporting authority. The architecture therefore permits metric or period
drift as new consumers are added, even where each individual endpoint currently
returns plausible numbers.

---

## MODEL

```text
Canonical operational / financial facts
  -> metric definitions (one formula, source, precision, period and scope)
  -> canonical reporting window resolver (current or historical Shamsi key;
     explicit range only where declared)
  -> report engine / dashboard projections / BOS consumers
  -> API run, CSV export and print from one result snapshot
  -> UI formatting, filters and interaction only
```

Every reportable number has one metric id and one authoritative formula. A
consumer may add a documented presentation transform only; it may not re-query
or recompute the same metric. A report request has:

- report id and required permission;
- concrete branch/organization scope resolved by canonical RBAC;
- calendar period kind plus optional historical key, or an explicit bounded
  date range where the report definition permits it;
- resolved `from`, `to`, `periodKey`, timezone/calendar metadata; and
- immutable execution result used equally by screen, CSV and print.

Dashboard/BOS values that are not ordinary report metrics remain named,
registered decision-support projections with a direct source and period owner;
D-61 policy remains separate from observed metrics.

---

## CHALLENGE

| Candidate | Verdict | Reason |
|---|---|---|
| Keep the giant `/overview` SQL and document it as a special report | REJECT | overlapping metric formulas remain independent and can drift silently |
| Let every dashboard/BOS component calculate its own convenient KPI | REJECT | violates LAW 1/2/18 and prevents reconciliation |
| Treat browser filters/reducers as a work queue or KPI authority | REJECT | loaded pages are incomplete and client role visibility is not authorization |
| Infer Gregorian historical windows from labels | REJECT | conflicts with the canonical Shamsi calendar authority |
| Grant catalog visibility as a proxy for every report permission | REJECT | exposes unavailable actions and weakens least privilege |
| Replace D-61 treasury policy with a reporting setting | REJECT | a policy constraint is not a report metric and owner policy is already explicit |
| Preserve top-level legacy tests as the active WP-11 suite | REJECT | conflicts with §14/C-2; behavioral knowledge must be re-homed or explicitly retired |

---

## DECIDE

### D-177 — canonical reporting execution (agent architectural decision under D-13)

1. A report request resolves one authoritative reporting window before any metric
   runs. Historical named periods use canonical Shamsi keys; range is explicit,
   bounded and definition-authorized.
2. A report catalog entry exposes only when its own permission is satisfied.
   Server authorization remains authoritative for every run/export/print.
3. Overview, dashboard and BOS consumers must consume registered metric/window
   authorities or declare a distinct decision-support projection in the metric
   registry. No frontend KPI/work-queue calculation becomes business truth.
4. CSV and print derive from the same server result used for display.
5. Search remains a server-side query surface, with explicit relevance, scope,
   bounds and permissions; it is not a reporting metric calculator.

### Exact implementation plan

| Layer | Planned change |
|---|---|
| Reporting core | Refactor metric/report definitions and engine around a typed canonical request/window resolver; add historical key/range capability only where declared; validate every result against one precision/scope contract. |
| API | Rebuild report catalog/run/export endpoints and reconcile `/overview` to consume the core rather than duplicate formulas. Ensure permission-filtered catalog, consistent errors, audit where required and bounded export. |
| Dashboard/BOS | Move shared KPI/work-queue calculations into server-owned projections; replace role-name-only UI gating with resolved permissions; reconcile BOS period inputs and metric sources with D-61 retained. |
| Search | Make result categories, relevance, cap and branch/permission behavior explicit and testable; preserve no client-side aggregate truth. |
| Frontend | Rebuild Reports/Dashboard/BOS consumers around typed server results, historical calendar controls, empty/loading/error/permission states, freshness and shared print/export contracts. |
| Tests | Re-home/rebuild WP-11 authority under `work-packages/wp11`; add report-window, metric reconciliation, RBAC/IDOR, export-print, dashboard/BOS/search attack, frontend contract, performance and cold-review suites. |
| Documentation | Update canonical authority, invariant and metric registries, decisions, legacy inventory, C-2 and a bounded certification only after final gates. |

### Acceptance criteria

1. Every D-13 report category has an executable, permission-scoped report at
   each declared daily/weekly/monthly/quarterly/annual period.
2. A current/historical Shamsi report, API result, CSV and print state the same
   resolved window and exact metrics.
3. A dashboard/BOS/overview number reconciles with its registered metric or has
   an explicitly registered distinct decision-support definition.
4. Unauthorized or cross-branch report/search/dashboard access is denied without
   disclosure; catalog visibility does not create hidden authority.
5. UI mutations refresh affected server projections without a hard refresh.
6. Bounded queries use appropriate indexes/plans and cannot escape page/range
   limits through hostile parameters.
7. A fresh schema/install, complete suite, mutation gate and release gate pass.

---

## CHECKPOINT

WP-11 changes reporting architecture, RBAC, security-sensitive disclosure,
metric authority, printing/export and potentially schema-supported query paths.
The committed/pushed baseline above is recoverable. Owner decision D-178 clears
the discovered BOS security-policy ambiguity: Owner, General Manager and Finance
Manager receive permission-based read-only Executive BOS analytics; only Global
Owner may withdraw profit. No material implementation may begin until this plan
and decision refinement are checkpointed; implementation must re-enter DECIDE
if it discovers another unresolved business metric or policy ambiguity.
