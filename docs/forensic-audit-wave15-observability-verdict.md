# Forensic Audit — Wave 15 Verdict
## Financial Observability & Reporting (the two Wave-14-authorized capabilities)

**Verdict: PASS** — both capabilities implemented as truthful derived views of existing authorities, adversarially verified (14/14 in the new suite; full-suite and gate results below), with zero policy invented, zero financial-semantics change, and zero schema change. No Wave-14 policy-gated capability was touched.

## 1. Scope executed (exactly the Wave-14 §11 authorization)

1. **Receivables aging** — `GET /api/reports/receivables-aging` (`Report.View`/`Finance.Report`/`Ledger.View`).
2. **Daily cash-activity statement** — `GET /api/reports/cash-activity/daily` (same gate), **digital expected cash only** — the response itself carries `basis: 'digital-expected'` and a note stating it is NOT a physical count (the D-CC boundary is respected in the artifact, not just in intent).

**Explicitly excluded, and absent**: any count/adjustment surface, any aging→status automation, any schema change (none needed — `idx_fin_tx_branch_date_type` already covers the daily queries), any policy-gated capability.

## 2. Architecture (composed authorities, not a second truth)

Single authority module `server/src/core/reporting/financial-observability.ts` (the impact-reporting precedent for row-level views), registered in `docs/registries/metrics.md` (registry audit green: 509 rows, 114 endpoint refs, all live).

- **Aging** composes the *exported* WP07-F18b primitives: `TUITION_NET_SQL` (now also exporting `TUITION_PAYMENT_SQL` — a one-line export widening, no behavior), `AID_SOURCE_KINDS_SQL`, `getBranchOutstanding`, `getBranchNonTuitionOutstanding`. Tuition rows: per term, settled by completed payments attributed via the `payments.semester` column (charges **and** refunds of charges — the authority's own rule) plus active aid via the term's obligation. Non-tuition rows: per open invoice, identical grain to `getBranchNonTuitionOutstanding` — cross-foot **exactly**. Buckets: Jalali month age from `enroll_date`/`issue_date` (current/1–3/4–6/7–12/12+), computed with the server's `utils/jalali` converters.
- **Grain honesty**: aging floors per debt item; `/reports/overview` nets per student. Both figures are returned in `crossFoot` and neither is silently preferred — the netting test constructs the divergence (overpaid sibling term) and asserts both values. Unattributed tuition payments (semester NULL) are **disclosed**, never allocated by guesswork.
- **Daily statement** reconstructs one branch-day from the I16/I17 identities (the same identities the checker certifies): `opening = live store − Σ movements since date`; `closing = opening + income(non-equity, by class) − savings movement − owner drawings`. Equity injections stamped to the branch are **memo-only** (they credit the organization treasury) — the exclusion is visible in every response, not silent. `closing(today)` must equal the live `finance_accounts` balance — asserted in tests.

## 3. Adversarial verification (`wave15-financial-observability.test.ts`, 14 tests)

World built through production surfaces (enrollment, desk payments, refund, treasury deposit, full funding chain for aid); fixture INSERTS only where no production writer can set a past date or an abnormal state — **and every fixture payment carries its ledger twin written through the real `recordIncome` boundary**, because the state layer caught exactly that bypass during development (see §4).

Coverage: route == independent in-test derivation (rows, buckets, totals — different algorithm, same economics, including refund attribution); every bucket boundary age (0,1,3,4,6,7,12,13); settlement truth (payment + aid + refund reopening, floored at zero); invoice status filtering (draft/cancelled/paid excluded — an *open overpaid* invoice is unrepresentable because I5 forces it closed, noted in the test); non-tuition exact cross-foot; netting-grain divergence disclosed; branch scoping + unattributed disclosure (other branch); `asOf`/`date` validation (garbage 400, **future 400** — a statement of a future date is not a fact; pre-dating clamps ages); daily algebra + live-balance equality; movements vs raw ledger row-for-row; empty day; historical continuity `closing(D) == opening(D+1)`; organization scope (`branchId=all`, global owner) with every branch reconciling to its live balance; authorization (permissionless principal → 403 on both surfaces); **read-only proof** (report calls write zero financial rows); full invariant checker green on the final world.

## 4. What the adversarial process caught during development (all fixed; evidence the defenses bite)

- `sem.COALESCE(...)` — qualifying the shared net-fee primitive by table alias produced invalid SQL; fixed by deriving a qualified form from the same primitive (no semantic restatement).
- `invoices.number` vs `invoice_number` — caught by the live registry/schema.
- **I14** flagged fixture payments lacking ledger rows → fixtures now pay through `recordIncome` (the invariant did its job against its own author).
- **I5** flagged fixture invoice statuses inconsistent with collected money → world corrected; the test now *documents* that open-overpaid invoices are unrepresentable.
- A payments trigger (idempotency-key required; book payments must reference their sale) enforced fixture honesty; the aid-allocation scope trigger forced the full production funding chain instead of a bare allocation row.
- Scope truth: `?scope=all` was a no-op param; the real switch is `branchId=all` — and only an organization-scoped owner passes it. (Noted honestly: some earlier suites' org-scope aspirations were numerically indistinguishable from branch scope in single-branch worlds; this suite finally exercises the real switch.)

## 5. Governance & environment

- Registry audit: **PASS** (2 new metric rows; endpoints + authority paths live). Protocol audit: **PASS**, seal unchanged (`f41f0c87eb8c507f…`).
- Environment incident, resolved: the earlier workspace re-clone had left `server/node_modules` absent (excluded from snapshots). The sandbox blocks github/nodejs.org downloads, so `better-sqlite3` was **built from source** against local Node headers (`node-gyp --nodedir=/usr/local`); `npm ci --ignore-scripts` for the rest. W12 suite re-run green afterward — toolchain restored, no shortcuts taken.

## 6. Historical impact & policy discipline

Read-only views: no historical data touched, no migration, no behavior change (full-suite diff below). Wave-14 policy register unchanged: D-CC-1..6 (cash count), P16, D-DC, D-WH, D-XB, P11–P15 all still owner decisions — this wave implemented exactly the ungated remainder and nothing more.

## 7. Verification summary

`tsc --noEmit` clean · new suite 14/14 · registry + protocol audits PASS · full suite: **221 files / 2,972 passed / 2 skipped** (the two pre-existing UI skips) · diff = 1 new module, 1 new suite, 2 routes + 3 imports in `reports.routes.ts`, 1 export widening in `studentBalance.ts`, 2 registry rows, this report.

## 8. Wave 16 boundary (defined, not started)

Wave 14 said the ungated work was aging + daily statement. That work is now done. **No ungated engineering capability remains on the Wave-14 register.** Wave 16 is therefore a **decision-gated** wave: its first act must be the owner decision session (D-CC-1..6 cash-count semantics first, then P16, D-DC, D-WH, D-XB, P11–P15). Engineering may proceed in Wave 16 only on capabilities whose gates are recorded in the decision log; absent that, the honest state is: the ERP is observability-complete for its authorized model, and the next materially new capability (physical cash control) is one owner conversation away.
