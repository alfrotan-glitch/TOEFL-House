# Dashboard Subsystem — Independent Production Audit (2026-08-17)

**Subject:** Dashboard subsystem at commit `5519726`.
**Posture:** the Dashboard was treated as untrusted. Correct-looking numbers were
reconciled against the database, not accepted.
**Method:** source trace of the full chain (DB → services → API → scope →
frontend state → rendered metric), then a live server with controlled fixture
data whose exact totals were known in advance, adversarial RBAC probes,
concurrency probes, high-volume performance runs (60,882 ledger rows), and
mutation testing of the existing Dashboard tests.

**No code was modified** (`git status` clean throughout).

---

## Headline answer

> **"Can management safely make financial, operational, staffing, enrollment,
> and performance decisions using this Dashboard?"**

**Financial decisions: YES** — every money figure reconciled exactly against the
ledger, including under concurrency and at volume.

**Enrollment, marketing and staffing decisions: NO.** Three visitor-derived
metrics are silently wrong because the Dashboard computes them from a
**paginated page** instead of the full population. The most damaging is the
**conversion rate, which reported 50% when the truth was 20%** — a 2.5×
overstatement of sales performance, presented with no indication it is partial.

---

## Architecture as built

There is **no `/dashboard` endpoint**. The Dashboard is a frontend composition:

```
DB ──► finance.routes.ts  GET /api/finance/dashboard   (SQL SUM over full period)  ──► money tiles      ✅ authoritative
DB ──► students.routes.ts GET /api/students?limit=2000 (paginated)                 ──► counts           ⚠️ page-derived
DB ──► visitors.routes.ts GET /api/visitors?limit=100  (paginated, MAX 100)        ──► counts + rate    ❌ page-derived
DB ──► finance.routes.ts  GET /api/finance/transactions (paginated, 500 default)   ──► 7-day chart      ❌ page-derived
```

The money tiles were previously fixed to read the server aggregate — that fix is
real and holds. **The same lesson was never applied to the non-financial
tiles**, which still reduce over client arrays. That is the single root cause
behind D-1, D-2, D-3 and D-5.

Every paginated endpoint returns `X-Total-Count`. **The frontend never reads that
header anywhere** (`grep -rn "X-Total-Count" src/` → no matches), so it cannot
detect that it holds a partial population.

---

## 1. CRITICAL findings

### D-1 — Conversion rate is computed from a 100-row page — reported 50% vs true 20%
**CRITICAL · CONFIRMED**

- **Location:** `src/components/dashboard/DashboardView.tsx:127-128`; data from `src/apiStore.ts:289` (`limit: '100'`); server cap `server/src/routes/visitors.routes.ts:85-86` (`DEFAULT_PAGE_SIZE=50`, `MAX_PAGE_SIZE=100`).
- **Evidence (live, fixture of 250 branch-1 visitors, 50 registered):**
  ```
  X-Total-Count: 250        ← server tells the truth
  rows returned: 100        ← frontend keeps only the page
  registered in page: 50
  DASHBOARD conversionRate = round(50/100*100) = 50%
  TRUE conversion rate      = round(50/250*100) = 20%
  ```
- **Reproduction:** create >100 visitors in one branch, open the Dashboard, compare the "Conversion" tile with `SELECT COUNT(*) FILTER (WHERE status='registered') / COUNT(*) FROM visitors WHERE branch_id=?`.
- **Business impact:** the headline sales/marketing KPI is inflated by a factor that grows with lead volume. Because the numerator saturates while the denominator is frozen at 100, **the rate rises as the branch performs worse**. Marketing spend, staffing and campaign decisions made on this number are unsound.
- **Root cause:** `MAX_PAGE_SIZE=100` is a hard server ceiling, so the client can never load the full population; the rate divides by `visitors.length` (the page) rather than `X-Total-Count`.

### D-2 — "Cash Flow Analytics — Last 7 days" understates income by 45%
**CRITICAL · CONFIRMED**

- **Location:** `DashboardView.tsx:135-144` (chart), `:44-58` (tooltip renders `formatAFN(item.value)`); data from `apiStore.ts:325` (no `limit` → server default 500).
- **Evidence:** on a 700-income-row day, `X-Total-Count: 820`, 500 rows returned. Chart shows **47,610 AFN** for today; ledger truth is **87,150 AFN** — understated by **39,540 AFN (45%)**, while the KPI tile directly above correctly shows 87,150.
- **Reproduction:** create >500 transactions in the period, compare the chart's today bar with `/api/finance/dashboard` `today.income`.
- **Business impact:** two contradictory revenue figures on the same screen. The chart is titled *"Cash Flow Analytics / Last 7 days performance"* and its tooltip renders exact AFN currency — it reads as authoritative, not indicative. A reader trusting the chart under-reports revenue by nearly half.
- **Root cause:** an in-code comment states the chart shows *"SHAPE, not authoritative totals… never presented as a figure anyone reconciles against."* That premise is false as implemented: the tooltip presents exact currency amounts. The mitigation was documented but not enforced.

---

## 2. HIGH findings

### D-3 — "Pending Leads" understated 4× (50 vs 200)
**HIGH · CONFIRMED** — `DashboardView.tsx:126,157`, same 100-row page.
Live: dashboard **50**, DB truth **200**. Drives the follow-up work queue and the
quick-registration dropdown (`:572`), so **150 real leads are invisible and
unworkable** from this screen. Same root cause as D-1.

### D-4 — Client uses UTC dates, server uses local dates (4.5-hour daily divergence)
**HIGH · CONFIRMED** — `DashboardView.tsx:95,138` use `toISOString()` (UTC);
server `server/src/utils/ids.ts:9-12` `today()` uses `toLocaleDateString('en-CA')`
(local). User timezone is Asia/Kabul (UTC+04:30). Executed proof:
```
Wall clock Kabul   : 2026-08-17 02:00
Server today()     : 2026-08-17
Dashboard todayStr : 2026-08-16   ← UTC
MISMATCH           : true
```
**Every day between 00:00 and 04:29 Kabul time, the money tile ("today" per
server) and the visitor/student tiles + chart ("today" per client) describe
different calendar days.** Night-shift and early-morning reporting is wrong, and
month/year boundaries inherit the same skew.

### D-5 — Same pagination defect latent on Active Students at >2,000 per branch
**HIGH · CONFIRMED (reproduced)** — `apiStore.ts:217` requests `limit: '2000'`;
`students.routes.ts:137-138` caps at 2,000. Reproduced by growing branch 1 to
2,250 students: dashboard tile showed **1,970 active**, DB truth **2,220** —
silently short by 250. Not yet triggered at current data volume, but it is the
identical defect class and will fire without warning as the institution grows.

---

## 3. MEDIUM / LOW findings

| ID | Sev | Status | Finding |
|---|---|---|---|
| D-6 | MEDIUM | CONFIRMED | **"This Month" is a Gregorian window with Jalali labels.** Server `monthStart = YYYY-MM-01` (`finance.routes.ts:176`) while the UI renders Jalali dates (`DashboardView.tsx:139,285`). For 2026-08-17 the Gregorian window is 08-01…08-17, but the Jalali month (Mordad) began ~2026-07-23. The period summed is not the month the user sees. |
| D-7 | MEDIUM | CONFIRMED | **No test coverage of any Dashboard metric.** `grep -rln "DashboardView\|conversionRate\|pendingLeads" server/src/tests/` → **zero matches**. All 9 existing dashboard tests target the backend endpoint only; the defective layer is untested. |
| D-8 | MEDIUM | CONFIRMED | **Month-boundary mutation survives.** Mutating `monthIncome` to use `todayStr` as the window start was **killed by 0 of 9** dashboard tests. The period-boundary invariant is unprotected. |
| D-9 | LOW | CONFIRMED | **Unguarded division in the revenue bar width** (`DashboardView.tsx:403`): `(c.revenue / revenueByClass[0].revenue) * 100` yields `NaN%` when top revenue is 0 → invalid CSS. Cosmetic; server-side denominators (`utilizationPercent`, `conversionRate`) are correctly guarded. |
| D-10 | LOW | CONFIRMED | **11 `db.prepare()` calls re-prepared per `/finance/dashboard` request** (`finance.routes.ts:170-260`) instead of module-level. No impact at measured volume (84 ms at 60,882 rows) but it is the one hot path that skips the file's own prepared-statement convention. |
| D-11 | LOW | CONFIRMED | **Query planner picks the low-selectivity index.** `EXPLAIN QUERY PLAN` on the dashboard's hot aggregate → `SEARCH USING INDEX idx_fin_tx_type (type=?)` rather than a date/branch composite. Adequate today; will degrade as the ledger grows. |
| D-12 | LOW | CONFIRMED | **Students payload includes PII beyond what the Dashboard renders** (`tazkiraNo`, `dob`, `fatherName`, emergency contacts). Role-gated and not a leak, but the Dashboard pulls 2,000 full records to display counts. |

---

## 4. False positives (investigated, NOT defects)

| Item | Why it is not a defect |
|---|---|
| "Concurrent payments lost — 20 sent, 1 persisted" | Correct documented **business-event idempotency**: 19 responses carried `idempotentReplay: true`. Identical concurrent charges are intentionally collapsed. |
| "`password` found in audit-log payload" | Only the action label *"Changed personal password"*. No credential material; `old_value`/`new_value` were null. |
| "Timeframe selector doesn't change money tiles" | The selector is scoped inside the *"Registrations and visitors tracking"* card and only governs that card's two tiles. Correctly bounded. |
| "Money tiles computed client-side" | They are **not**. They read `financeDashboard.*` from the server aggregate and reconciled exactly (104,950 / 12,990 AFN). The prior remediation holds. |
| "Cross-branch data via `?branchId=`" | `resolveBranchScope` silently re-scopes. A branch-2 manager requesting `?branchId=1` or `?branchId=all` received only branch-2 data. |

---

## 5. Verified sound (independently re-proven)

- **Financial reconciliation:** dashboard `today.income` 104,950 == ledger 104,950; `today.expense` 12,990 == ledger 12,990; owner `?branchId=all` = 147,150 == 87,150 + 60,000 exactly. Zero orphan payments.
- **RBAC (server-enforced):** owner/manager full; `finance` gets finance + students + teachers, **denied** visitors and audit; `registrar`/`counselor` denied finance; `teacher` denied finance, visitors, teachers, audit. Unauthenticated → 401 everywhere.
- **Parameter manipulation:** `?branchId=1`, `?branchId=all`, `?limit=99999` all failed to escalate for every non-privileged role.
- **Concurrency:** across 10 concurrent dashboard reads during 20 concurrent payment writes, **0 internally inconsistent snapshots** (`net == income − expense` held in every payload) and the final figure matched the ledger exactly.
- **Performance:** at 60,882 ledger rows — `/finance/dashboard` 84 ms, `?branchId=all` 50 ms, `/finance/transactions` 20 ms. No N+1 across requests, no unbounded query (all list endpoints capped).
- **Zero/empty state:** server denominators guarded; `conversionRate` guards `visitors.length > 0`.

---

## 6. Exact source-of-truth map

| Displayed metric | DB source | Query / service | API | Frontend consumer | Verdict |
|---|---|---|---|---|---|
| Today Income / Expense / Net | `financial_transactions` | `ledgerTotals()` SQL SUM, `finance.routes.ts:182-191` | `GET /api/finance/dashboard` | `DashboardView.tsx:117-118` | ✅ exact |
| Month Income / Expense / Net | `financial_transactions` | same, `monthStart` = `YYYY-MM-01` | `GET /api/finance/dashboard` | `:119-120` | ⚠️ D-6 Gregorian vs Jalali |
| Balances, receivables, approvals, budget | `finance_accounts`, `invoices`, `budget_lines` | SQL in handler | `GET /api/finance/dashboard` | `FinanceDashboardPanel.tsx` | ✅ server-computed |
| Active Students | `students` | client `filter(status==='active')` | `GET /api/students?limit=2000` | `:122` | ⚠️ **D-5** latent >2,000 |
| Active Classes / Teachers | `classes`, `teachers` | client filter | `GET /api/classes`, `/api/teachers` | `:123-124` | ⚠️ unbounded-by-page risk |
| New Visitors (period) | `visitors` | client filter on page | `GET /api/visitors?limit=100` | `:106` | ❌ **capped at 100** |
| New Students (period) | `students` | client filter on page | `GET /api/students?limit=2000` | `:107` | ⚠️ D-5 |
| Pending Leads | `visitors` | client filter on page | `GET /api/visitors?limit=100` | `:126,157` | ❌ **D-3** |
| **Conversion Rate** | `visitors` | client `registered / page.length` | `GET /api/visitors?limit=100` | `:127-128` | ❌ **D-1 CRITICAL** |
| 7-day Cash Flow chart | `financial_transactions` | client reduce over page | `GET /api/finance/transactions` (500) | `:135-144` | ❌ **D-2 CRITICAL** |
| Budget radial | `budget_lines` | server totals | `GET /api/finance/dashboard` | `:147-151` | ✅ |
| Revenue by class / time slot | `payments`/`enrollments` | server | store `apiStore.ts:129-130` | `:403` | ⚠️ D-9 NaN width |

**Duplicated / shadow logic:** the Dashboard maintains a *second* implementation
of period filtering (`filterByDate`, `DashboardView.tsx:98-103`) that duplicates
the server's period logic with **different timezone semantics** (D-4) and
different month boundaries (D-6). This is the shadow calculation to eliminate.

---

## 7. Unverified areas (declared)

- **Real browser rendering** — all findings derive from API payloads plus source reading; no visual confirmation (**GL-1** remains open and unobtainable here).
- `BusinessOperatingSystemView`, `OperationsWorkQueue`, and the analytics tab (`getExecutiveDashboard`, `getMarketingFunnel`, `getStudentAnalytics`, `getDecisionWarnings`, `getProfitDistribution`) were **not** audited — separate surfaces, each with its own endpoints.
- `FinanceDashboardPanel.tsx` (318 lines) was traced for sourcing but not adversarially probed metric-by-metric.
- Multi-process concurrency (single Node process, serialised better-sqlite3 writer).
- Jalali conversion correctness itself (`utils/jalali.ts`) was not verified; D-6 concerns the window boundary, not the formatter.

---

## 8. Production-readiness verdict

**NOT PRODUCTION-READY as a decision-support surface** — with an important split:

- The **financial core is trustworthy.** Money tiles reconcile exactly, survive concurrency, respect branch scope and perform well. Management can rely on the revenue/expense/balance figures.
- The **operational and marketing metrics are not.** Three tiles are confirmed wrong today (D-1, D-2, D-3), one is wrong for 4.5 hours every day (D-4), and one fails silently at scale (D-5).

What makes this dangerous rather than merely inaccurate: **the wrong numbers sit
beside correct ones with identical visual authority**, and the errors are
directionally flattering — conversion inflates, pending work shrinks. Nothing on
screen signals that a figure is partial. The server already returns
`X-Total-Count` on every affected endpoint; the frontend simply never reads it.

---

## 9. Recommended remediation order

1. **D-1** — conversion rate must come from a server aggregate (or `X-Total-Count`), never a page. Highest damage, trivially wrong today.
2. **D-3** — pending leads from a server count; the work queue needs the full set, not the first 100.
3. **D-2** — feed the 7-day chart from a server-side daily aggregate; until then it must not render exact currency in its tooltip.
4. **D-4** — one date authority. The client should stop deriving `todayStr` via UTC and adopt the server's local-date semantics.
5. **D-5** — remove the client-side count pattern generally, before branches exceed 2,000 students.
6. **D-6** — decide explicitly whether "This Month" means the Gregorian or Jalali month, and make label and arithmetic agree.
7. **D-7 / D-8** — add tests that would fail against today's build: a >100-visitor conversion-rate fixture, a >500-transaction chart fixture, and a month-boundary case (which currently survives mutation).
8. **D-9 … D-12** — cosmetic and performance hygiene.

**Structural recommendation:** the recurring root cause is *counting records the
client happens to have loaded*. The durable fix is a single server-computed
dashboard-summary endpoint for non-financial KPIs, mirroring what
`/api/finance/dashboard` already does correctly for money — not a larger page
size, which only moves the ceiling.

---

## §9 — REMEDIATION RECORD (pass 23, same day)

The defects below were remediated after this audit was published. The fix was
**architectural**, not a pagination-limit increase: raising limits would only
move the threshold at which the numbers silently become wrong again.

### What changed

| Layer | Change |
|---|---|
| `server/src/core/dashboard/dashboard-summary.ts` | **New.** All KPIs computed as SQL `COUNT`/`SUM` over the whole scoped table. Pure `periodBoundaries()` helper. Cash flow is a `GROUP BY date` with a zero-filled continuous axis, `days` clamped 1..90. |
| `server/src/routes/dashboard.routes.ts` | **New.** `GET /api/dashboard/summary`, guarded by `authenticate` + `requirePermission('Dashboard.View')` + `resolveBranchScope(req)`. |
| `server/src/index.ts` | Router mounted at `/api/dashboard`. |
| `src/apiStore.ts`, `src/types.ts`, `src/App.tsx` | `dashboardSummary` state + loader; typed contract. |
| `src/components/dashboard/DashboardView.tsx` | **All authoritative derivation deleted.** The view now renders server values only. |

### The rule now enforced

> The Dashboard **displays** server-computed results. It does not re-derive any
> authoritative metric from a loaded entity array.

The one surviving client-side `filter` builds the quick-registration dropdown,
which needs visitor *records* rather than a count and is explicitly a
"recent leads" picker — it never presents itself as a population figure.

### Date policy (D-4)

A single authority: the **server's local date**, `toLocaleDateString('en-CA')`,
matching `utils/ids.ts today()`. The server returns `today` plus explicit
`boundaries` for each period, so the client cannot compute a different day.
Windows stay Gregorian to match `financial_transactions.date`; Jalali remains
display-only (D-6 unchanged).

### Before / after — reproduced live against the 60,882-transaction dataset

| ID | Metric | Before (client) | After (server) | DB truth | |
|---|---|---|---|---|---|
| D-1 | Conversion rate | 50% | **20%** | 20% | FIXED |
| D-2 | Cash flow, today income | 62,250 | **104,950** | 104,950 | FIXED |
| D-3 | Pending leads | 50 | **200** | 200 | FIXED |
| D-4 | Date authority | client UTC | **server local** | — | FIXED |
| D-5 | Active students | 1,970 | **2,220** | 2,220 | FIXED |
| D-1b | New visitors today | 100 (page cap) | **250** | 250 | FIXED |

Also folded into the API because they shared the defect class:
`activeClasses`, `activeTeachers`, and the "N total records" caption.

Opportunistically fixed: **D-9**, the `NaN%` bar width, now guarded against a
zero-revenue leader.

### Verification

- **28 new tests** in `server/src/tests/dashboard-summary.test.ts`, with
  fixtures deliberately exceeding every page ceiling (250 visitors > 100 cap,
  2,250 students > 2,000 cap, 700 transactions > 500 page).
- **Mutation testing: 14/14 mutants killed.** Two survivors found real gaps and
  were closed by adding coverage, not by weakening assertions:
  - `on_leave`/inactive teachers and class-status counting were untested;
  - the fixture contained no `follow_up` visitors, so dropping that state was
    invisible. Both now covered.
  - One candidate mutant (`COALESCE` default flip) is **equivalent/unreachable**:
    `teachers.status` is `NOT NULL DEFAULT 'active'` with a CHECK constraint.
- Adversarial: unauth 401, forged `?branchId=` silently re-scoped, `branchId=all`
  refused for a single-branch manager, hostile `?days=` clamped, SQL injection in
  `branchId` parameterized to a harmless empty scope, empty branch returns zeros
  with no divide-by-zero, 8 concurrent reads against 25 interleaved writes all
  returned reconcilable snapshots.

### Gates at this commit

1050/1050 tests (was 1022) · eslint 0 errors / 102 warnings (unchanged) · both
typechecks clean · frontend build OK · fresh-schema preflight SUCCESS
(69 migrations) · `release:validate` 16/16.

### Status

D-1, D-2, D-3, D-4, D-5 — **CLOSED**. D-9 closed. D-6, D-7, D-8, D-10, D-11,
D-12 remain open and are unaffected by this change.

**GL-1 (browser visual inspection at 1920×1080) and GL-2 (a printed fee bill)
remain OPEN.** They require a human and have not been performed.

---

## §10 — REMEDIATION RECORD, PART 2 (pass 24): D-6 … D-12

Closes the remaining findings. As in §9 the fixes are at the server/domain
layer; no frontend workarounds.

### D-6 — "This Month" was a Gregorian window under a Jalali label — **FIXED**

**Source of truth traced.** Two independent definitions of a month existed:
`finance.routes.ts` used `${today.slice(0,7)}-01`, while
`core/payroll/class-payroll.ts` already resolved periods with
`jalaliMonthToGregorianRange()` and **pays staff for Shamsi months**. The
Dashboard therefore disagreed with the payroll sitting beside it.

**Reproduced.** On 2026-08-17 (26 Asad 1405):

| | window | branch-1 income |
|---|---|---|
| Gregorian (before) | 2026-08-01 … 08-17 | 389,974 |
| Shamsi (after) | 2026-07-23 … 08-17 | **550,921** |

**160,947 AFN** — 29% of the month — fell outside the window while the tile was
labelled اسد ۱۴۰۵. The gap is **9–10 days every month, all year**, not an edge
case.

**Fixed** by introducing `server/src/core/calendar/periods.ts` as the single
calendar authority. Dashboard and Finance both consume it; there is no second
month definition left. Storage stays Gregorian — only the boundary resolution
is Shamsi. `collectedThisMonth` moved from a `LIKE 'YYYY-MM%'` prefix (which
*cannot* express a Shamsi period) to a range compare over the same window. The
API now returns `periodKey`/`from`/`to`, and the UI labels the period it
actually summed (اسد ۱۴۰۵) instead of the ambiguous "This month".

### D-7 — no Dashboard metric coverage — **FIXED**

63 tests added this pass (28 in pass 23, 35 now), all at the API/domain layer:
`reporting-periods` (23), `finance-dashboard-period` (21), `dashboard-timezone`
(10). Per the agreed scope no frontend test framework was introduced — the
frontend is now a thin rendering layer with no authoritative logic to test.

### D-8 — month-boundary mutant survived all tests — **FIXED**

That mutant (`P1`, month reverts to the Gregorian slice) and 15 others are now
killed. See the mutation table below.

### D-10 — 11 statements re-prepared per request — **FIXED**

All 11 hoisted to module level, matching the convention the rest of
`finance.routes.ts` already followed. Each has an all-branch and a
branch-scoped variant so isolation stays in SQL, not in string interpolation.
Verified no scope leakage between interleaved callers, including concurrently.
`/api/finance/dashboard`: **84 ms → 41 ms**.

### D-11 — planner chose a 2-value index — **FIXED**

Migration **071** (forward-only, index-only, no historical migration touched)
adds `financial_transactions(branch_id, date, type)` and
`payments(branch_id, date)`.

```
before: SEARCH USING INDEX idx_fin_tx_type (type=?)   + USE TEMP B-TREE FOR GROUP BY
after:  SEARCH USING INDEX idx_fin_tx_branch_date_type (branch_id=? AND date>? AND date<?)
```

7-day cash flow **6.31 ms → 0.50 ms (12.6×)**; month-to-date **9.12 → 0.84 ms**.
Temp B-tree eliminated. Applied to a live 60,882-row database with an automatic
pre-migration backup; schema-drift preflight passes at 70 migrations.

### D-12 — PII over-fetch — **ALREADY RESOLVED; audit claim corrected**

Verified live: the Dashboard loads `/students?view=lite`, which returns
`id, studentCode, fullName, status, registrationDate, gender, branchId` and
**no PII** (the full projection's `phone, email, fatherName, tazkiraNo, dob`
are absent). The original finding described a state that the lite projection
had already superseded. Since pass 23 the Dashboard no longer needs student
records for counts at all, so the now-dead `teachers` and `transactions` props
were removed from `DashboardView`.

### Re-audit of the whole Dashboard for the same defect classes

- **Client-derived authoritative metrics: none.** The four surviving
  `filter`/`reduce` calls are record pickers (quick-registration dropdown,
  budget chart rows, gender-eligible classes) and a bounded work queue whose
  badge counts the items it renders.
- **Gregorian month slices used as boundaries: none** (one comment only).
- **UTC date derivation on Dashboard paths: none.**
- **NEW FINDING, FIXED — D-13:** `OperationsWorkQueue` derived "today" via
  `toISOString()` to decide overdue follow-ups, a surviving instance of D-4. It
  now consumes the server's `today` with a local-time fallback.
- **NOT FIXED (out of scope, recorded):** ~20 `toISOString()` day derivations
  in non-Dashboard views (books, exams, sessions, funding, teachers payslips,
  visitors conversion). Same class as D-4 and worth a follow-up pass; untouched
  here because the brief was explicit not to modify unrelated functionality.

### Mutation testing — 16/16 killed, 1 proven equivalent

| Mutant | Result |
|---|---|
| P1 month reverts to Gregorian slice | KILLED |
| P2 month starts on the 2nd | KILLED |
| P3 month shifted to the previous Shamsi month | KILLED |
| P4a/P4b period end no longer clamped to today | KILLED |
| P5 year starts 1 January | KILLED |
| P6 leap-year Hut length wrong | KILLED after fix |
| P7 malformed input silently accepted | KILLED |
| A1 `addDays` off by one | KILLED |
| C1 cash-flow axis drifts from window | KILLED |
| C2 cash-flow window start wrong | KILLED |
| F1 finance reverts to Gregorian month | KILLED |
| F2 `collectedThisMonth` window widened | KILLED after fix |
| F2b `collectedThisMonth` ignores branch | KILLED after fix |
| F3 month total ignores branch scope | KILLED |
| F4 trend axis reverts to Date+local formatter | KILLED after fix |
| F5 trend window start off by one | KILLED |
| A2 `addDays` via local Date accessors | **equivalent mutant** |

Five mutants initially survived. Each exposed a genuine gap, closed by adding
coverage — never by weakening an assertion:

- **P6** — no leap Shamsi year was exercised (1405 is common). Added 1403/1408.
- **F2** — the fixture had **no payments at all**, so `collectedThisMonth` was 0
  either way. Added payments inside, before, and in the divergence gap.
- **F2b** — a **cross-branch financial leak** was invisible because no other
  branch had payments. Added a 333,000 AFN branch-B collection.
- **F4** — the runner executes in **UTC**, where the correct and broken date
  bases coincide. Added assertions that run under `America/New_York`,
  `Asia/Kabul` and `Pacific/Apia`.
- **A2** — investigated over 7,056 combinations across 7 timezones: byte
  identical everywhere, so it is **provably equivalent**, not a coverage gap.

**A defect I introduced and caught.** While hoisting statements I changed the
trend axis to `new Date(iso)` + `toLocaleDateString('en-CA')`. Because
`new Date('YYYY-MM-DD')` parses as **UTC midnight**, that returns the previous
day in any zone behind UTC — 4,032 divergent day-keys across the zones tested.
My own new timezone suite failed on it. Fixed properly with `addDays()`, pure
string calendar arithmetic that touches no timezone at all.

### Regression checks on the pass-23 Summary API

12/12 live reconciliations against DB truth: `activeStudents` 2220,
`conversionRate` 20%, `pendingLeads` 200, cash-flow today 104,950 — and the two
endpoints agree with each other on today's income. RBAC unchanged (401
unauth/bad token, forged `?branchId=` re-scoped, `branchId=all` organization-only,
SQL injection parameterized to an empty scope). Financial audit: 35 money
columns, 60,959 column-rows, **clean**.

### Gates

1105/1105 tests (was 1050) · eslint 0 errors (102 server / 5 frontend warnings,
unchanged) · all typechecks clean · frontend + backend builds OK · schema-drift
preflight SUCCESS at 70 migrations · `release:validate` 16/16 · financial
invariants reconcile to 0.

### Status after this pass

D-1 … D-13 **CLOSED**. No confirmed Dashboard defect remains open.

**GL-1 (real-browser visual inspection at 1920×1080) and GL-2 (one printed fee
bill) remain OPEN.** No browser automation exists in this environment; these
require a human and have not been performed.
