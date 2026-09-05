# Forensic Audit · Wave 20 — Credit/Debt Subsystem Verdict

**Wave:** 20 · Close the financial gap register genuinely
**Date:** 2026-09-05
**Scope mandate:** implement every previously-decided financial item missing/incomplete; isolate only genuinely undecided business policy; strongest verification; release-blocking defects zero.
**Verdict: PASS** — the decided semantics of supplier credit, supplier returns and loans are fully implemented, evidence-linked and DB-enforced; the policy gate register is re-scoped to genuine residuals (D-191).

---

## 1 · The reconciliation that reframed the wave

D-183 (W16) refused the entire credit/debt subsystem as policy-gated. Re-reading
the decision history shows that refusal **over-blocked**: the W16 owner
directive (D-181) already decided the standard accounting semantics, and D-183
itself records them:

- a credit purchase is a **payable at receipt — never income**;
- a loan is a **liability**; principal repayment reduces it; interest is never income and never capital;
- a supplier return **reverses the payable/receivable — never income**.

What was genuinely missing was never the semantics — it was their surfaces
(tables, evidence links, cash paths, conservation wiring) plus the business
parameters (terms, rates, lender/write-off/withholding authority) that remain
the owner's alone. Wave 20 closed the first family and re-scoped the second
(D-190, D-191).

## 2 · What was implemented

### 2.1 Schema (`server/src/db/schema.sql`, W20 block)

| Surface | Shape | Enforcement |
| --- | --- | --- |
| `suppliers` | identity master (name/phone/notes) | audit-linked; no credit-term fields — terms are policy (D-191) |
| `supplier_invoices` | liability declaration, status `open/settled` | declaration writes **zero** ledger rows |
| `supplier_invoice_payments` | settlement↔expense evidence | `UNIQUE transaction_id`; bound trigger: settlements + payable-reducing returns ≤ invoice |
| `supplier_returns` | `payable_reduction` (no cash) or `refund_due` | CHECK kind↔status; refund_due ≤ refundable (settled − refundDue − refundReceived); bound trigger |
| `loans` | principal-only liability, status `open/repaid` | `UNIQUE proceeds_transaction_id` |
| `loan_repayments` | repayment evidence | `UNIQUE transaction_id`; bound trigger: repayments ≤ principal |

`financial_transactions.type` CHECK widened with three **P&L-neutral** types:
`loan_proceeds` (org treasury credit), `loan_repayment` (signed-negative
treasury debit), `supplier_refund` (branch main cash-in). These are
load-bearing: `BRANCH_CASH_INCOME_SQL` counts every non-equity row typed
`income` as branch cash, so none of the new money may ever be typed `income`
— and none is.

### 2.2 Convergence (`server/src/db/connection.ts`)

`ensureFinancialTransactionsCreditDebtTypes` — copy-swap of
`financial_transactions` for pre-W20 databases (dependent triggers dropped
first, canonical columns copied, full schema re-run, `PRAGMA foreign_key_check`
asserted). Wired **before** the W19 currency and W16 reclaim shims. Probe on a
regressed W16-era database (rows preserved verbatim, CHECK converged,
6 tables + 3 triggers present, FK clean, `usd_income` refused) — PASS.

### 2.3 Core service (`server/src/core/finance/credit-debt.ts`)

- `getPayablePosition` / `getLoanPosition` — canonical positions.
- `recordSupplierInvoicePayment` — links the equal-amount expense row paid through the budget authority; auto-settles.
- `recordSupplierReturn` — open debt ⇒ `payable_reduction` ≤ outstanding; settled ⇒ `refund_due` ≤ refundable; MIXED returns refuse (one row = one economic thing).
- `receiveSupplierRefund` — idempotent (status-guarded) `supplier_refund` cash-in at branch main.
- `recordLoan` / `recordLoanRepayment` — treasury credit/debit via `incrementMainBalance('organization','global')` / `decrementMainBalanceIfSufficient`; repayment branch inherited from the proceeds row.

### 2.4 Conservation, reconciliation, statements

- **I11** branch main += `supplier_refund`; **I13** treasury += `loan_proceeds`,`loan_repayment`; **I16** explained += all three types (signed).
- **I23** (new): every settlement links an equal `expense` row; every received refund links an equal `supplier_refund` row.
- **I24** (new): proceeds row = principal; repayment row = −amount.
- `src/utils/reconciliation.ts`: `expectedMain` += `supplier_refunds` (branch scope; loan types are org-scope).
- Daily statement (`financial-observability.ts`): `supplierRefunds` movement, opening/closing arithmetic extended; payload field added.

### 2.5 Routes (`/api/finance/*`, all writes behind `Expense.Approve` — the W16 convention)

`POST/GET /suppliers` · `POST /supplier-invoices` · `POST /supplier-invoices/:id/settle`
(pays via the budget line path, links evidence) · `POST /supplier-invoices/:id/return`
· `POST /supplier-returns/:id/receive-refund` · `GET /payables` (branch/organization
register with outstanding/refund-due totals) · `POST/GET /loans` · `POST /loans/:id/repay`.

## 3 · Adversarial verification — `server/src/tests/wave20-credit-debt.test.ts` (7/7)

1. Payable declaration: zero ledger rows, income unchanged, register shows outstanding; teacher 403.
2. Settlement through the budget authority: expense evidence linked (I23); **over-settle 409**; income unchanged.
3. Return on open debt: `payable_reduction`, outstanding drops; **over-outstanding/mixed return 409**.
4. Return after settlement ⇒ `refund_due`; refund received: branch main +8 000, `supplier_refund` row +8 000, income unchanged, reconciliation variance 0; **refund replay 409**.
5. Loan proceeds: treasury +150 000, `loan_proceeds`/`loan_principal` row, income unchanged, register outstanding; teacher 403.
6. Repayment: treasury −50 000, signed-negative `loan_repayment` row; **over-repay 409**; final repayment closes; **replay 409**.
7. Daily statement: `supplierRefunds` = 8 000, closing equals the live account; checker green throughout (I11/I13/I16/I23/I24 after every operation).

Regression: W16 (12) + W19 (5) + W20 (7) suites green together (24/24); full-suite
result below. tsc clean.

## 4 · Decision registry

- **D-190** — credit/debt subsystem implemented under the D-181 owner-directed semantics (evidence-linked, DB-enforced, conservation-wired).
- **D-191** — gate register re-scoped to genuine residuals: supplier terms/master governance; loan lender/rate/schedule policy (hence **no interest surface** — a rate cannot be defaulted); refund settlement terms; write-off authority (P16); withholding (WH); depreciation/disposal proceeds (D-182); cash counting (deferred by owner, untouched).

Nothing decided-but-unimplemented remains in the financial domain; nothing
undecided is represented.

## 5 · Release gates

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` (prod + test configs) | clean |
| W16+W19+W20 suites | 24/24 |
| Full suite (`npx vitest run`) | **3010 passed / 2 skipped / 0 failed** (226 files, incl. wave20) |
| Convergence probe (regressed pre-W20 DB) | rows preserved, CHECK converged, FK clean, bad types refused |
| **`release-validate` (all 22 gates)** | **PASS** — frontend typecheck/lint/build, server lint+tsc, product/static/protocol/registry/design/logging/cleanliness/deps audits, both production builds, bundle weight, full suite, schema preflight, fresh install (132 tables, idempotent), money-lifecycle reconciliation, integrity checks |

## 5a · Defects uncovered by the release gate and repaired (pre-existing debt)

The release gate had drifted red outside the wave's own surfaces. All were
repaired to make "releasable" literal:

1. **Latent regex defect** — `TUITION_NET_QUALIFIED_SQL`'s qualify-replaces
   contained literal backspace control characters (U+0008) instead of `\b`
   word boundaries, so the `.replace()` calls never fired (eslint
   `no-control-regex` flagged it). Rewritten with real `\b`; the sem.-qualified
   SQL now actually qualifies; wave15 suite re-verified 14/14.
2. **Server lint** — 16 errors, all unused vars/imports (incl. one in new W20
   code), an unnecessary escape, `prefer-const`, plus 5 type errors surfaced by
   `tsconfig.test.json`. All fixed; `npm run lint` fully green.
3. **Source cleanliness (§4)** — 9 historical-narrative comments
   ("used to", "legacy", "previously") rewritten to current intent; audit PASS.
4. **Environment** — root/frontend dependencies were uninstalled, so the
   frontend and static-analysis gates could not run at all; installed, all pass
   (`high-assurance-static-audit` needed root `typescript`).

## 6 · Evidence paths

- Suite: `server/src/tests/wave20-credit-debt.test.ts`
- Schema: `server/src/db/schema.sql` (W20 block), `server/src/db/connection.ts`
- Core: `server/src/core/finance/credit-debt.ts`, `invariant-checker.ts` (I23/I24)
- Reporting: `src/utils/reconciliation.ts`, `src/core/reporting/financial-observability.ts`
- Routes: `server/src/routes/finance.routes.ts` (W20 section)
- Registries: `docs/registries/decisions.md` D-190/D-191

## 7 · Residual policy gates (owner's alone)

Supplier payment terms/due dates & master governance; loan lender/rate/repayment
schedule (no interest surface until a rate exists); refund settlement terms
beyond cash; write-off authority (P16); payroll withholding (WH);
depreciation/disposal proceeds economics (D-182); physical cash counting
(deferred by owner decision — untouched, per mandate).
