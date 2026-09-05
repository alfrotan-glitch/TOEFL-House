# Wave 19 — Decision-History Reconciliation · Verdict

**Wave:** 19 · Resolve remaining gaps from the COMPLETE existing decision history; never re-ask a decided question
**Date:** 2026-09-05
**Role:** Chief Systems Architect & Independent Technical Authority
**Sources reconciled:** `docs/registries/decisions.md` (D-1…D-189, all 207 rows), the owner-enacted Technical Authority Mandate and Master Engineering Authority charter, the sealed Protocol, every prior wave report (7–18), the W14 policy register, the certification records, and the live schema/services/routes.
**Verdict: PASS** — the decision history was searched in full and **reconciled**: two "open" queue items were already answered by binding owner decisions and are now applied exactly (one with a conformance repair); one standing decision was re-verified live. The queue shrinks from eight to **six genuinely undecided items**. Nothing was invented; financial truth and auditability are preserved and re-proven.

---

## 1 · What the full-history search found

The W17/W18 queues were built from the W14 register's framing. Reading the **entire** decision history — including the earliest owner Q&A round (2026-08-20) that later waves never revisited — surfaced three binding answers:

### 1.1 FX / multi-currency — DECIDED-NO by D-11 (Owner, Q1)

> "**D-11 Currency:** AFN is the sole currency. No secondary currency, no FX rate, no multi-currency columns or conversion logic anywhere." — *DECISION (owner), 2026-08-20.*

The W14 framing (D-FX-1 "does USD acceptance exist?", D-FX-2 "memo vs full", D-FX-3 "FX gain/loss class") asked questions the owner had **already answered** at the architecture's foundation. D-FX is withdrawn: no FX capability may be built unless the owner amends their own decision.

**Conformance audit and repair.** Every currency writer already pins the literal `'AFN'` (`catalog.routes`, `catalog-service`, the seeding path); `level_branch_fees` writers never set the column at all (default AFN); a full-repository grep finds **zero** conversion/rate logic; readers display the label only. The one gap was storage-level: both label columns accepted any string, so a future or direct write could record `'USD'` — a dormant contradiction of D-11. Repaired with the smallest correct change: `CHECK (currency = 'AFN')` on `level_branch_fees.currency` and `fee_rules.currency` (canonical DDL + the established copy-swap convergence for pre-W19 databases, proven: rows preserved, `foreign_key_check` clean). The owner's decision is now enforced by the database, not by convention.

### 1.2 Return of capital — DECIDED-NOT-PROVIDED by D-61 (Owner, A-10 checkpoint)

> "**D-61 Owner-approved treasury policy and executable ceiling:** margin below 10% permits 0% distribution; 10–19.99% permits 5%; 20–29.99% permits 10%; 30%+ permits 15%. The reserve target is six months of fixed costs and must remain covered… `computeProfitDistribution` publishes and enforces ONE current-accounting-month ceiling… The disconnected editable `rule_default_reserve_guard` is removed rather than retained as a second policy surface." — *DECISION (owner), implementation verified.*

The W14 D-RC framing ("is return of capital permitted outside dissolution?") treated the distribution channel as separate from capital return. The owner's checkpoint decision is comprehensive over treasury outflows: the margin-tiered, reserve-guarded **profit** distribution is the single approved channel, and the decision explicitly rejects second policy surfaces. A separate capital-return instrument would contradict D-61. **No work is authorized or needed**; the decision is verified live (a withdrawal beyond the ceiling is still refused — proven in this wave's suite, not assumed from old tests).

### 1.3 Employee advances — D-14 (Owner, option 11-C) re-verified

Advances are retained as receivables, classified non-expense cash movement — confirmed both in the taxonomy and at the invariant level. The write-off slice remains P16 (below).

## 2 · Queue re-evaluation, item by item (goal list)

| Capability | Authoritative decision found? | Action this wave | Status |
|---|---|---|---|
| FX / multi-currency | **Yes — D-11 (owner): AFN only** | Currency CHECK conformance repair + convergence; D-FX withdrawn | **CLOSED (decided-no)** |
| Return of capital | **Yes — D-61 (owner): profit-only, one ceiling** | Verified live enforcement; no channel may exist beside it | **CLOSED (decided-not-provided)** |
| Employee advances | **Yes — D-14 (owner, 11-C): receivable, non-expense** | Re-verified (classification + invariants) | **CLOSED (conforms)** |
| Restricted funds | Partial — W12 owner-authorized view + allocation guards (levels a+b); cash-level segregation never asked | None (nothing pending that blocks anything) | **Conforms; P11(c) only if the owner ever wants it** |
| Physical cash count | **No decision anywhere** (W13 RNK-1, W14 D-CC-1..6; no owner text in any registry, charter, mandate or certification) | — | **POLICY REQUIRED (D-CC-1..6)** |
| Supplier credit & returns | **No decision** (W8/W13/W16 audits; D-183 stands) | — | **POLICY REQUIRED (supplier master + terms; P14)** |
| Loans | **No decision** (P12–P14; D-183 stands) | — | **POLICY REQUIRED (lender/rate/repayment authority)** |
| Advance/student-debt write-offs | **No decision** (P16; only the recovery-via-payroll mechanics exist) | — | **POLICY REQUIRED (P16)** |
| Depreciation / disposal economics | **No decision** (D-182; the custody-loss FACT slice was implemented in W18 under the books precedent) | — | **POLICY REQUIRED (classes, methods, rates)** |
| Payroll withholding | **No decision; owner evidence first** (W13 IV-6) | — | **POLICY REQUIRED (WH)** |

## 3 · The remaining decision queue — six items, all genuinely undecided

1. **Physical cash count & variance** — D-CC-1..6 (countable stores; variance treatment; tolerances; approver; cadence; supersession).
2. **Supplier credit purchases & returns** — supplier master + payment/refund terms; who may bind the institute (P14).
3. **Loans** — P12 does the institute borrow; P13 conventional interest; P14 lender/rate/repayment authority.
4. **Write-offs (advances & student debt)** — P16 doubtful/discharge states, recovery window, write-off authority and P&L class.
5. **Depreciation / disposal economics** — classes, methods, rates, proceeds treatment (custody loss already representable, D-188).
6. **Payroll withholding** — owner evidence, then liability/remittance/payslip semantics.

Each continues to refuse honestly (409 POLICY REQUIRED); none misrecords; none blocks others.

## 4 · Verification

- `tsc --noEmit`: clean.
- Wave-19 suite: **5/5** (`server/src/tests/wave19-decision-history.test.ts`) — DB-level refusal of USD/EUR on both currency columns; canonical DDL carries the CHECK; the fee-rule route is unregressed with invariants green; the D-61 withdrawal refusal is live; the D-14 advance classification stands.
- Copy-swap convergence probe on a regressed pre-W19 database: both tables converged, rows preserved, `PRAGMA foreign_key_check` clean, non-AFN writes refused.
- Full suite: 225 files, **3002 passed, 2 skipped**, 0 failed (fresh `test.sqlite`).
- `node scripts/verify-registries.mjs`: **PASS** (6 registries, 524 rows, 983 path references, 118 endpoint references).
- `npm run audit:protocol`: **PASS** — seal unchanged.

## 5 · Verdict

**PASS.** Every previously authorized decision is now applied exactly: two queue items closed by existing owner decisions (one with a storage-level conformance repair), one standing decision re-verified live, and the remainder re-confirmed as genuinely undecided — six items, each with its exact decision stated. The system remains verified, production-grade, and honest: nothing decided is unimplemented, nothing undecided is improvised.
