# Wave 16 — Standard Accounting Semantics · Architecture Verdict

**Wave:** 16 · Standard financial semantics for the remaining unresolved capabilities
**Date:** 2026-09-05
**Role:** Chief Systems Architect & Independent Technical Authority
**Authority basis:** Owner authorization of the *semantic layer* (2026-09-05). Numeric business policy was **not** delegated and has **not** been invented.
**Verdict: PASS** — four capabilities implemented to industry-standard semantics with adversarial proof; three capabilities **rejected as policy-gated** with the standard semantics documented for the day the Owner supplies policy. No invariity, authority, permission, auditability, idempotency, concurrency or historical-truth guarantee was weakened. Every refusal is a 409 **POLICY REQUIRED**, never a fabricated default.

---

## 1 · Scope disposition (audit first, then implementation)

The wave opened with a full architecture audit of the `./goal` capability list against the live schema, services and routes. Disposition:

| Capability | Audit finding | Disposition |
|---|---|---|
| Employee advances | `SALARY_ADVANCE_CATEGORY_ID='sub_salary_advances'` — "a receivable, not a cost"; non-expense cash movement classification | **Already conforms** — no change; documented |
| Restricted funds | `restricted-exposure.ts` already derived exposure without inventing prohibitions | **Already conforms**; extended for clawbacks |
| Donation clawbacks | No representation | **Implemented** (§3.1) |
| Fixed-asset register | No representation | **Implemented** (§3.2) |
| Bank reconciliation | No representation | **Implemented** (§3.3) |
| Student branch transfers | No representation | **Implemented** (§3.4) |
| Supplier credit purchases | No schema/service/route, no recorded decision | **Rejected — policy-gated** (§4, D-183) |
| Supplier purchase returns | No schema/service/route, no recorded decision | **Rejected — policy-gated** (§4, D-183) |
| Loans | No schema/service/route, no recorded decision | **Rejected — policy-gated** (§4, D-183) |
| Physical cash count (D-CC-1..6) | Wave-14 decision gates | **Untouched, out of scope** by explicit instruction |

## 2 · What "standard semantics" means here (and what it never means)

The Owner authorized the **semantic layer only**: the *shape of truth* — what a thing IS in the books. The architect holds no authority over *numbers*: thresholds, approval rules, write-off authority, interest rates, depreciation policies remain Owner policy (**D-182**). Every surface that would need such a number refuses with **409 POLICY REQUIRED** rather than inventing one.

## 3 · Implemented capabilities and their proof

### 3.1 Donation clawbacks — liability and repayment, never negative revenue

- **Declaration** (`POST /funding/donations/:id/clawback`, `Funding.Edit`): restricted donations only; reason ≥ 8 chars; bound to the donation's **unconsumed remainder** (consumed = active allocations reachable from the donation's own fundings/receipts/campaign-funded instruments). The DB trigger `trg_donation_clawbacks_bound` enforces the cumulative bound independently.
- **Attribution (D-184):** a restricted donation delivers its whole amount to exactly ONE instrument at registration; if the money has moved onward (`sponsorship_return`), attribution is ambiguous → **409 POLICY REQUIRED (D-DC-3)**. No averaging or guessing.
- **Capacity:** every funding-source position (`getFundPosition`, `getCampaignFundingEntryPosition`, `getSponsorshipPosition`, `getScholarshipFundingPosition`, `getSponsorshipReceiptPosition`) now carries `clawedBack`, subtracted from `available` — returned money cannot be promised again. Proven: a new award beyond reduced capacity is refused; one within it is accepted.
- **Repayment** (`POST /funding/donation-clawbacks/:id/repay`): conditional store debit (`ensure`-then-`decrementMainBalanceIfSufficient`), a **signed-negative** ledger row of new P&L-neutral type `restricted_reclaim`, status flip guarded `WHERE status='open'` (replay → 409). Income totals are byte-identical before and after both declare and repay.
- **Conservation taught the new fact:** I11 (branch main), I16 (explained), I21 (application bound to received − reclaimed) and the **new I22** (repaid_without_cash / cash_without_clawback; `ft.amount = −c.amount`), `reconciliation.expectedMain`, and the W15 daily statement (`movements.restrictedReclaims`, opening reconstruction, `dayMainDelta`) — all green after repayment, with `cashVariance = 0` and the daily closing equal to the live store.

### 3.2 Fixed-asset custody register — the asset side of capex

- Registration (`POST /finance/assets`, `Expense.Approve`): triggers require a **capital-expenditure** category node; a source transaction, when given, must be an expense row of the **same branch** whose amount **covers the cost**; a sourceless registration is a cost-basis fact (gifts) — never cash flow. `custody_status` knows only `in_service` (depreciation/disposal unrepresentable until policy — D-182).
- Custody (`POST /finance/assets/:id/transfer`): append-only `fixed_asset_transfers` trail (from ≠ to, current-branch match enforced, reason ≥ 8 chars); the asset row and trail commit together. Adversary proof built a **real capex cash flow** through treasury → budget line → charge → expense-request approval, then attacked it: non-capex node (400), cost above source (409), teacher registration (403). A production bug found and fixed during the attacks: the route mapped the source-tx trigger violation to the classification 400 (both messages contain "capital-expenditure") — order corrected.

### 3.3 Bank statement matching — control layer only

- Import (`POST /finance/bank-statement-lines`): duplicate-import guard (409); amount ≠ 0.
- Matching (`POST /finance/bank-statement-matches`): same branch only (409), one match per line and per transaction (409); **proven zero financial writes** (row counts identical before/after); unmatch (`DELETE …/:id`) restores; the variance report (`GET /finance/bank-reconciliation`) counts matched/unmatched truthfully. Matching is never a second cash authority — it annotates; it cannot post, void or amend.

### 3.4 Student branch transfer — one explicit event

- `POST /students/:id/transfer-branch` (`Student.Transfer`): a single transaction writes the `student_branch_transfers` event, moves the student, then **open** obligations and issued/partial/overdue invoices. History rows (payments, ledger) **stay at the originating branch** — proven by row counts before/after. Every surface agrees afterwards: the aging report finds the debt at the new branch and not the old one. Same-branch transfer (400), teacher (403), invariant checker green.

### 3.5 Already conforming (documented, not disturbed)

Employee advances remain receivables (`sub_salary_advances`, non-expense cash movement); restricted funds remain derived exposure with no invented prohibitions.

## 4 · Rejected: the credit/debt subsystem (D-183)

**Supplier credit purchases, supplier purchase returns and loans are not implemented.** The audit found no schema, service or route — and no recorded decision. The ruling, as independent technical authority:

- A payable requires a **supplier master** and **payment terms**; a return requires the supplier relationship and **refund/settlement terms**; a loan requires **lender identity, an interest rate and repayment authority**. Every one of those is Owner business policy. The W16 mandate is explicit: never invent values, limits, approval rules, write-off authority, interest rates.
- Implementing term-less payables or rate-less loans would create **unenforceable records** — rows that cannot age, cannot be settled honestly, and would silently become fiction. That is unsound; it is rejected rather than forced.
- The standard semantics are recorded in **D-183** so the day policy arrives, implementation is a decision away: payable at receipt (never income); loan = liability, principal repayment reduces it, interest = finance expense (never income/capital); a return reverses inventory and the payable/receivable (never income).

## 5 · Defects the adversarial suite forced out (found → fixed → proven)

1. **`financial_transactions.type` CHECK rejected `restricted_reclaim`** — repayments failed as generic 400s. Fixed canonically: schema CHECK widened, plus `ensureFinancialTransactionsReclaimType()` in `connection.ts`, a copy-swap convergence for existing databases (FK-safe, dependent triggers dropped and recreated, `PRAGMA foreign_key_check` asserted clean). Proven on a regressed pre-W16 database: rows preserved, zero FK violations, new type writable.
2. **I11 did not know reclaims** — account 73,600 vs ledger 103,600 after repayment (exactly −30,000). I11's derivation now includes the signed reclaim term; comment updated.
3. **Clawback guard queried a non-existent column** (`e.source_receipt_id`) — found by the suite before any production path could; corrected to the real `source_sponsorship_receipt_id`.
4. **Clawback consumption SQL had a paren imbalance** (prepare-time syntax error); flattened into four provably-valid scalar subqueries.
5. **Asset route mislabeled source-tx violations as classification 400s** (substring-collision in the error mapping); ordering corrected — dishonest source is the 409 it always was.
6. **Repay used a raw conditional UPDATE** that crashed on branches whose store row was never materialized; now uses the canonical `ensure`-then-`decrement` utilities.

## 6 · Governance trail

- `docs/registries/decisions.md`: **D-181** (semantic layer, standard semantics adopted), **D-182** (numeric gates stay closed), **D-183** (credit/debt subsystem policy-gated), **D-184** (clawback V1 attribution scope).
- `docs/registries/metrics.md`: restricted-fund exposure; restricted reclaims (day); fixed-asset cost basis (in service); bank-reconciliation control counts.

## 7 · Verification

- `tsc --noEmit`: clean.
- Wave-16 adversarial suite: **12/12** (`server/src/tests/wave16-standard-semantics.test.ts`).
- Full suite: 222 files, **2984 passed, 2 skipped**, 0 failed (fresh `test.sqlite`).
- `node scripts/verify-registries.mjs`: **PASS** (6 registries, 517 rows, 978 path references, 114 endpoint references).
- `npm run audit:protocol`: **PASS** — seal `f41f0c87eb8c507f…` unchanged (the protocol body was not touched).

## 8 · Residual honest boundaries

- Everything numeric remains Owner policy: clawback approval thresholds beyond the consumption bound, depreciation, disposal, supplier terms, loan rates, D-CC-1..6. The system says POLICY REQUIRED, by design.
- Bank matching annotates imported lines; it does not import statements (no bank API exists) — import is manual and duplicate-guarded.
- Clawbacks V1 protect the unconsumed remainder with unique attribution; partial-attribution ordering after onward movement awaits D-DC-3.

**Final state:** production-grade for everything implemented; nothing half-represented; nothing invented.
