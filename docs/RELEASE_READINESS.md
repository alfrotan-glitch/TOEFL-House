# TOEFL House ERP — Release Readiness Report

**Commit:** `77006ed` · **Branch:** `arena/01a0062e-toefl-house` · **Date:** 2026-08-16

| Gate | Result |
|---|---|
| Server test suite | **845 passed / 845**, 86 files |
| Frontend typecheck · lint · build | exit 0 · exit 0 · exit 0 |
| Server typecheck (build + test configs) · lint · build | exit 0 · exit 0 · exit 0 |
| Static / product / bundle audits | exit 0 · exit 0 · exit 0 |
| Fresh-schema preflight | 65 migrations, **no drift** |
| `npm run release:validate` | **16 passed · 0 failed · 0 skipped** |
| GitHub Actions CI | **4/4 jobs SUCCESS** (run `31980207214`) |

---

## Findings this pass

Two BUGs, both found by systematic search rather than by report, both the same
**silent-substitution** class as the earlier capping defects.

### BUG-1 — invoice line quantity was coerced, not validated *(fixed)*

```
POST /invoices  items:[{ quantity: -3, unitPrice: 500 }]
  -> 201   invoice line quantity 1, total 500
```

`Number.isInteger(q) && q > 0 ? q : 1` silently replaced an invalid quantity
with 1, producing a real charge the operator never entered — on a financial
document, reported as success. Now rejected with 400 and no invoice row is
written. A valid multi-unit line (3 × 500 = 1500) still prices correctly.

### BUG-2 — the discount ceiling overrode configured policy *(fixed)*

`visitors.routes` ran the discount through the rule engine and then re-clamped
it with a hardcoded `Math.min(30, …)`. The institutional cap lives in
`rule_default_discount_cap`, editable at runtime. Proven by editing the rule:

```
rule engine returns  -> 50
route then applied   -> Math.min(30, 50) = 30
```

Raising the cap had no effect. The engine is now the single authority. *A
policy that cannot be changed where it is configured is not a policy.*

---

## Audited with evidence — no defect found

| Area | Evidence |
|---|---|
| Negative / zero money | rejected on 8 endpoints (payments ×4, treasury, budget charge, invoice unit price, invoice quantity) |
| Idempotency | 10 concurrent ad-hoc charges → **1×201 + 9×200 replays**; 8 concurrent refunds → **1×201 + 7×200**; 8 concurrent final tuition payments → **1×201, no overpayment** |
| Authorization / branch isolation | **11/11 blocked** — cross-branch payments, refunds, invoice read, invoice pay, invoice create, payroll, teacher edit; low-privilege teacher blocked on treasury, reconciliation, refund, users |
| Audit completeness | who + role, when, branch, amount, and reason captured for enrollment, initial payment, subsequent payment, ad-hoc charge, refund |
| Historical integrity | **zero** DELETEs against financial/historical tables; the only salary-ledger UPDATE sets void metadata and preserves `paid_amount`, guarded by `status='posted'` |
| Database integrity | 65 migrations, no drift, foreign keys **ON**, 0 violations, `integrity_check ok`, idempotency uniques present on `payments` and `teacher_salary_ledger` |
| Academic integrity | non-existent class / foreign-branch class / non-existent teacher / non-existent program / foreign semester id — all rejected |
| Documents | **15 print surfaces, 0 hardcoded literals**; all read `BRAND_NAME` / `brandPrintHeaderHtml` / `resolveDocumentIssuer` |
| Performance | 8 major endpoints all **< 10 ms** at current volume |

---

## Mutation verification

Every protection added across this work was proven to fail when removed.

| Guard | Mutation | Result |
|---|---|---|
| Tuition overpay rejection | restore `Math.min(requested, debt)` | 2 tests FAIL |
| Invoice discount cap | remove the check | 1 test FAIL |
| Enrolment discount cap | restore `Math.max(0, total-discount)` | 1 test FAIL |
| Invoice quantity validation | restore the `: 1` coercion | 2 tests FAIL |
| Discount cap is configuration | restore `Math.min(30, …)` | 1 test FAIL |
| Ad-hoc charge reason | delete the reason check | 2 tests FAIL |
| Timeline separation | remove `FINANCIAL_EVENT_TYPES` filter | 2 tests FAIL |
| Compensation append-only | make a raise DELETE prior rows | 2 tests FAIL |
| Fee-bill branding | restore literal `<h1>TOEFL HOUSE</h1>` | 2 tests FAIL |
| No hardcoded phone | reinstate `0788223344` | 1 test FAIL |
| Tests are typechecked | type error inside a test | lint exit 2 |
| Static audit invariant | set typecheck to `echo skipped` | audit FAIL |
| Budget reconciliation | drop from the healthy gate | 2 tests FAIL |

---

## Severity register

### CRITICAL — 0
### HIGH — 0

### MEDIUM

| # | Item | Status |
|---|---|---|
| M-1 | Ad-hoc categories (`other`/`exam`/`chapter`) accept any amount with no obligation | **Business decision, resolved** — audited as an intentional product feature ("Other Fee" is an operator-selectable option). Capability preserved; a reason is now mandatory and flows to the ledger, since with no obligation the reason is the only control. Reversible if you want obligation-backed charges instead. |
| M-2 | F-10 historical phantom-cash rows in existing production data | **Known limitation** — forward path fixed; pre-existing rows still need a one-off repair migration against real data. |
| M-3 | Employee pay-salary `LIKE` duplicate guard bypassable via `paymentType:'advance'` or a varied `monthName` | **Known limitation** — narrower than the teacher payroll path, which is protected by two unique indexes. |

### LOW

| # | Item | Status |
|---|---|---|
| L-1 | `invoices` carries two unique indexes enforcing the same rule | **Verified safe** — redundant, not a correctness defect. Left in place rather than churn valid migration history. |
| L-2 | 5 money writers use bespoke guards instead of `resolveIdempotency` | **Verified safe** — each proven correct under concurrency; unification is cosmetic. |
| L-3 | Books / funding list endpoints unbounded; Students tab ~1.7 MB at 8k students | **Known limitation** — no defect at current volume (all endpoints < 10 ms). |
| L-4 | ~100 unused-variable lint warnings in server source | **Known limitation** — surfaced when the dead lint gate was restored; kept at the project's own `warn` severity rather than raising the bar mid-release. |
| L-5 | 576 `any` in server source, 3 oversized modules | **Known limitation** — maintainability, not correctness. |
| L-6 | `impact.routes.ts` has no test coverage | **Known limitation** — reporting-only surface. |
| L-7 | Single-process SQLite; backups share the DB disk | **Known limitation** — restore is proven; survival of disk failure is not. |

### Requires human verification

| # | Item | Why |
|---|---|---|
| H-1 | Visual layout/readability of **Versions & Rules** at desktop resolution, and responsive reflow | jsdom computes no box geometry. Data correctness, request counts (revisit = 0 requests) and the removed `max-h-[600px]` clip are all verified; *how it looks* is not. |
| H-2 | Rasterised paper output of the fee bill | HTML, `@page` and `@media print` rules are asserted in a real DOM; only a physical print dialog proves the ink. |

---

## Verdict

**No CRITICAL or HIGH issues remain open.** Every one found across this work is
fixed, verified by live adversarial probe, and protected by a mutation-verified
regression test. Financial truth is server-side, obligations cannot be
overpaid, money values cannot be silently substituted, history is append-only,
and branch isolation holds against direct API attack.

This is **not a claim of a defect-free system**. It is a statement that the
enumerated risks above are either closed with evidence, recorded as an accepted
limitation, or isolated as a human visual check. Two items (H-1, H-2) cannot be
verified in a headless environment and should be signed off by a person before
go-live.
