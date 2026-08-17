# System Audit & Remediation — Pass 4

**Date:** 2026-08-17 · **Base:** `5afb70e` · **Head:** `0592181`
**Method:** whole-system sweep, not a continuation of the prior finding list. Every candidate defect was re-derived from source, schema, git history and live behaviour before any change.

---

## 1. Approach

The previous passes had converged on the Visitor subsystem. Rather than continue there, I surveyed the whole system for the *defect classes* the earlier work had proven to exist:

- one business question answered differently by different surfaces
- a guard testing the wrong column's vocabulary
- tests that reconcile against a query carrying the same bug they should catch

That framing found two genuine, previously-unknown defects — one financial, one functional — and let me reject four suspected problem areas with evidence.

---

## 2. Defects found and fixed

### 2.1 Dashboard reported owner capital as revenue — **Critical, financial integrity**

`financial_transactions` holds two categories that are not trading activity:

| type | category | meaning |
|---|---|---|
| income | `capital_injection` | owner capital paid **into** the treasury |
| expense | `profit_distribution` | owner drawings paid **out** |

`/reports/overview`, `/finance/pnl` and `utils/reconciliation` all excluded them. `core/dashboard/dashboard-summary.ts` did not — its cash-flow series summed every `income`/`expense` row.

**Live proof, same day and branch, before the fix:**

```
dashboard cashFlow : income 100000  expense 50000
finance/pnl        : income      0  expense     0
reports/overview   : income      0  expense     0   (transfers correctly segregated)
```

A 100,000 AFN owner deposit rendered as a revenue spike on the most-viewed screen in the product. Business impact: a manager reading the Dashboard sees revenue that no student paid, on the exact chart used to judge daily trading.

**Why the tests missed it.** `dashboard-summary.test.ts` reconciles the chart against `SUM(amount) WHERE type='income'` — a query with the identical defect — and no fixture ever seeded a transfer category. Reconciling against a query that shares the bug is not verification. Mutation testing proves the blindness: reverting the income fix and the expense fix both **SURVIVE** the old suite and are **KILLED** by the new one.

**Fix.** `core/finance/ledger-classification.ts` is now the single authority. `dashboard-summary`, `reports.routes`, `finance.routes` and `utils/reconciliation` all consume it, so a fourth private copy cannot appear. Equity movements remain fully visible — `/reports` surfaces them under `transfers`, `/finance/pnl` as their own lines. They are material; they are simply not revenue or cost.

### 2.2 Visitor exam enrolment refused 100% of the time — **High, functional**

`POST /exams/:id/enroll` guarded eligibility with:

```ts
!['new','lead','inquiry','follow_up','placement','placement_completed','enrollment']
  .includes(visitor.status)
```

That tests the **status** column against **stage** vocabulary. `visitors.status` only ever holds `visited` or `registered` — conversion is its sole production writer — and neither appears in the list, so the condition was true for every visitor. Live: both a `visited` and a `registered` visitor received 409. Present since the initial import (`1b275cb`); the feature has never worked.

**Why the tests missed it.** `exam-enrollment-uniqueness.test.ts` exercises the UNIQUE indexes by `INSERT`ing into `exam_results` directly, never calling the route, and its fixture seeds `status='new'` — a value production never writes that happens to sit inside the broken allow-list. A test that bypasses the handler cannot test the handler.

**Fix.** The intent is plainly "do not enrol a dead lead", which is the closed-lost bucket already defined in `core/visitors/lead-lifecycle.ts`. The route now calls that authority.

> **My own near-miss.** The first attempt was incomplete: the prepared statement did not `SELECT stage`, so `isLeadClosed` always saw `undefined` and every lead — including lost ones — passed. The new test caught it immediately. Recorded as mutation M6, which is killed.

### 2.3 Two frontend surfaces carried the stale allow-list

- `DashboardView.tsx` — the quick-registration picker filtered `status === 'visited' || 'follow_up'`, so it offered closed-lost leads that the tile above it had already excluded from the count.
- `ExamsView.tsx` — the candidate list used the same test, offering candidates the backend refused.

Both now use the shared `isLeadOpen` / `isLeadClosed` vocabulary. `closedLeads` was also added to the frontend `DashboardSummary` type so the three-bucket contract is complete client-side.

---

## 3. Explicitly rejected — investigated, not defects

**Outstanding balance computed two ways.** `utils/studentBalance` (semester-fee based, used by `/bos` and `/students`) and `reports.routes` (invoice based). These measure genuinely different things — enrolled fees owed vs issued invoices outstanding — and both are legitimate. Verified live: both report **6000** on the same data. **No change.**

**Object-level authorization gaps.** Suspected from the earlier backlog (F-7). Swept every `:id` route file for branch-scoping helpers, then verified empirically with a purpose-built branch-B registrar against six branch-A objects:

```
GET  /visitors/:id/conversion-eligibility -> 403
PATCH /visitors/:id                       -> 403
POST /visitors/:id/advance-stage          -> 403
POST /visitors/:id/convert                -> 403
GET  /students/:id                        -> 403
GET  /invoices/:id                        -> 403
```

Body-level forgery (`branchId: "1"` in a create payload while confined to branch B) is refused with *"Target branch is outside your authorized scope."* **Branch isolation is sound. No change.**

**Conversion / payment concurrency.** Eight concurrent conversions of one lead → one `201`, seven `409`, and exactly one student + one invoice + one payment. Six concurrent payments sharing an idempotency key → one `201`, five `200` replays, one payment row. **Atomicity and idempotency hold. No change.**

**`exams.routes.ts:206` student guard** allows `['active','registered']`; `registered` is not a valid `students.status`. Dead value, but `active` is valid so the guard functions correctly. Cosmetic only — **rejected as not worth the churn**.

**Thin coverage on `impact` / `bos` / `automations`.** Flagged as a candidate, then checked: all are `authenticate`d and role-gated. Low coverage is a maintainability concern, not a live risk, and writing suites for three routers is not an 80/20 use of this pass. **Documented, not fixed.**

---

## 4. Remaining material risks

| Risk | Assessment |
|---|---|
| **N-7 accessibility** — zero `aria`/`htmlFor`/`role`/key handlers across five visitor components | Unchanged and still the highest-value remaining item. Likely a WCAG 2.1 AA procurement blocker. A discrete workstream; mixing it into correctness work would make both unreviewable. |
| **`impact`/`bos`/`automations` coverage** | Write endpoints with minimal tests. Authorization verified sound, so this is regression risk rather than a live defect. |
| **UX-14 phone-mandatory contract** | Client requires phone, server does not. **Requires a business decision**, not an engineering one: is a phone number mandatory to register a lead? Relaxing the form would weaken a real front-desk control; enforcing it server-side would reject API clients that work today. Left unchanged pending that ruling. |
| **UX-11 responsive kanban** (`min-w-[1200px]`, default view) | Needs design input on small-screen behaviour. |
| **GL-1 / GL-2** | Real browser inspection at 1920×1080 + a smaller viewport, and one actual printed fee bill. Human-only; **not claimed as verified**. |

---

## 5. Verification

**Tests: 1230 pass, 111 files** (was 1210 / 109). 20 added. No test weakened, skipped, deleted, or hidden; no test-discovery or config change.

**Mutation testing — 6 mutants this pass, all killed**, plus the decisive old-vs-new comparison:

| Mutant | New suite | Old suite |
|---|---|---|
| Cash flow counts every income row | **killed** | *survived (blind)* |
| Cash flow counts every expense row | **killed** | *survived (blind)* |
| Classification predicate loses its type guard | killed | killed |
| Exam guard reverts to the original allow-list | killed | — |
| Exam eligibility guard removed entirely | killed | — |
| Exam query stops selecting `stage` (my near-miss) | killed | — |

**Gates:** 1230/1230 tests · server lint **0 errors** (104 pre-existing warnings) · frontend lint **0 errors** (6 warnings, unchanged baseline) · both builds ✓ · `preflight:fresh-schema` SUCCESS (71 migrations, no drift) · `release-validate.mjs` **16/16 PASSED**. **No migration added or modified.**

**Live cross-surface reconciliation** — a mixed day of fee 9,000 / salary 3,000 / owner drawing 20,000 / capital injection 100,000:

```
dashboard cashFlow : income 16000  expense 3000
finance/pnl        : income 16000  expense 3000
reports/overview   : income 16000  expense 3000
reports transfers  : capital 100000, drawings 20000
```

**Visitor metrics** (unchanged by this pass, re-verified): `/visitors/summary`, `/dashboard/summary` and `/visitors/pipeline` all report total 256 / open 226 / converted 29 / lost 1 / 11%.

**Financial reconciliation:** `amountVariance`, `cashVariance`, `savingVariance`, `budgetVariance` — **all 0**.

**Exam enrolment, live after the fix:** open lead `201` · converted lead `201` · closed-lost lead `409 "This lead is closed (lost)"`. Before the fix all three were `409`.

---

## 6. Commits

| Commit | Change |
|---|---|
| `8ce9a8f` | `fix(finance)` — dashboard cash flow excludes owner-equity movements; single ledger-classification authority |
| `0592181` | `fix(exams)` — visitor exam enrolment was refused 100% of the time; frontend allow-lists aligned |

---

## 7. GO / NO-GO

**GO for the changes in this pass**, on the evidence above: every fix is backed by a live reproduction before and after, adversarial tests that are mutation-proven to detect the defect, and full green gates including release validation.

**NO-GO for declaring the product release-complete.** Two blockers remain outside this pass's scope and neither can be closed by me:

- **GL-1 / GL-2** are human verification steps and are explicitly not claimed.
- **N-7 accessibility** is a real, likely-contractual gap that needs its own workstream.

The **UX-14 phone contract** additionally needs a business ruling before it can be resolved either way.
