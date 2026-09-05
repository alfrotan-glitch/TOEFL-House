# Wave 17 — Post-W16 Completeness Audit · Definitive Verdict

**Wave:** 17 · Independent full-architecture completeness audit after Wave 16
**Date:** 2026-09-05
**Role:** Chief Systems Architect & Independent Technical Authority
**Method:** audit first — no gap was assumed; every candidate was verified against the live schema, services, routes, tests and registries before classification. No business policy was invented; existing authorities and invariants were reused throughout.
**Verdict: PASS** — the ERP is technically and economically complete for its **authorized scope**. Every remaining capability boundary is an **owner policy decision**, not engineering work; each is documented below with the exact decision required. Nothing is half-represented, and every policy-gated surface refuses honestly (409 POLICY REQUIRED) rather than fabricating.

---

## 1 · Audit method and evidence base

- **Code**: 125 tables, 43 mounted route groups, 0 TODO/FIXME/stub markers in production code (all grep hits were SQL placeholders).
- **Writers**: every `financial_transactions` writer enumerated (books-service, budget-movements, clawbacks, finance/invoices/teachers routes, income util, connection shims); `finance_accounts` is written through exactly one choke point (`utils/financeAccounts.ts`).
- **Integrity**: 22 invariants (I1–I22), runnable at any time via `GET /api/finance/invariants`; reconciliation, aging, and the daily cash statement are all derived, truthful views.
- **Governance**: decisions registry (D-1…D-186), metrics registry (validated), protocol audit (sealed), permission catalog covering every route permission; audit-log coverage spot-verified on all money routes including W16/W17.
- **Operations**: certified backup capability (A-11: startup + 24-hour schedule, dual-destination verification, GFS retention, readiness 503 on failure); `/api/health` and `/api/ready` live.
- **Suites**: 223 test files (W17 adds one), full green; per-wave adversarial suites for W15/W16/W17.

## 2 · What the audit found (and closed) — the last policy-free items

The Wave-14 gap register was re-verified item by item. Everything was either already implemented (W15: aging, daily statement; W16: clawbacks, asset custody, bank matching, student branch transfer) or policy-gated — **except four observations**, all closed this wave as policy-independent:

1. **Third-party payer attribution (W14 F9 — the register's only remaining "no gate" item).** A payment's economic owner is and remains the student; who physically handed over the money (guardian, sponsor, employer) is attribution *detail*. `payments` now carries optional `payer_name`/`payer_relation` on both principal collection paths, trimmed and length-bounded, NULL when absent (the exact pre-W17 meaning). **Proven economically inert**: total income moves by exactly the payment; checker green.
2. **Student branch-transfer history was write-only.** The W16 event row had no read surface. `GET /students/:id/transfer-history` now states the append-only facts (from/to, reason, operator, recorded-at), branch-scoped to the student's current branch; no mutation counterpart exists by design.
3. **Donation clawbacks had no per-obligation register.** The exposure view aggregates; `GET /funding/donation-clawbacks` lists the individual repayment obligations with status, cash-evidence transaction and donor attribution, and its aggregates are proven equal to the exposure view's figures.
4. **Bank reconciliation reported a count, not the pairs.** A control surface must show WHICH statement line was tied to WHICH ledger row, by whom and when; `GET /finance/bank-reconciliation` now returns the matched pairs (still read-only; matching still never writes financial truth).

Two smaller defects found and fixed *during* the wave's own test-driven attack: the transfer-history route initially selected a non-existent column (caught by the suite; corrected to the real schema), and the attribution-inertness test was tightened to prove the exact income delta.

## 3 · Considered and deliberately NOT done (with reasons)

- **Boot-time invariant gating** (refuse to serve on checker findings): would convert a legacy-data anomaly into an outage; the checker is already an on-demand operational audit surface. Rejected as a behavior change without operational necessity.
- **Frontend exposure of W15–W17 surfaces**: waves 9–16 are server-authority waves by established scope; the operator console is unchanged and its contract tests remain green. Surfacing the new read endpoints in the UI is ordinary product work for the next stage, not an architecture gap.
- **Treasury-deposit reversal**: a wrong capital injection is misstated capital, and what correction authority exists (and whose) is owner policy — same family as D-RC (return of capital). Left gated.
- **Anything numeric** (thresholds, tolerances, rates, approval matrices): never invented; every such surface says POLICY REQUIRED.

## 4 · The definitive owner-policy queue (everything that remains)

These are the ONLY boundaries between the current system and full economic coverage. Each is a decision, not code; the standard semantics are already documented in the decisions registry for the day the decision arrives.

| # | Capability blocked | Exact decision(s) required | Registered |
|---|---|---|---|
| 1 | Physical cash count & drawer variance | D-CC-1..6: which stores are countable; variance treatment (loss/expense vs employee receivable vs owner-absorbed; overage class); tolerances; SoD/approver; cadence & close; supersession semantics | W14 |
| 2 | Supplier credit purchases & purchase returns | Supplier master + payment/refund terms; who may bind the institute to a payable (P14) | D-183 |
| 3 | Loans (owner, hawala, bank facility) | Does the institute borrow (P12); conventional interest excluded? (P13); lender identity, rate, repayment authority (P14) | D-183 |
| 4 | Student-debt doubtful/discharge/write-off | P16: doubtful and discharge states, recovery window, who authorizes a write-off | W14 |
| 5 | Payroll withholding | WH: does the institute withhold wage tax/social contributions? liability class + remittance event + payslip semantics | W14 |
| 6 | FX / multi-currency | D-FX-1..3: does USD acceptance exist; memo-level vs full multi-currency; FX gain/loss class | W14 |
| 7 | Return of capital outside dissolution | D-RC-1/2: permitted? authorization + net-assets floor replacing the margin cap | W14 |
| 8 | Restricted-fund enforcement level | P11: report-only (today) vs cash-level segregation | W14 |
| 9 | Clawback partial attribution | D-DC-3: ordering after onward movement between instruments | W16 |
| 10 | Asset depreciation & disposal | Policy definitions (classes, methods, proceeds/loss classes); `custody_status` stays `in_service` until then | D-182 |

All ten refuse honestly today; none misrecords; none blocks any other capability.

## 5 · Verification (this wave)

- `tsc --noEmit`: clean.
- Wave-17 adversarial suite: **7/7** (`server/src/tests/wave17-completeness.test.ts`).
- Full suite: 223 files, **2991 passed, 2 skipped**, 0 failed (fresh `test.sqlite`).
- `node scripts/verify-registries.mjs`: **PASS** (6 registries, 521 rows, 981 path references, 117 endpoint references, all live).
- `npm run audit:protocol`: **PASS** — seal `f41f0c87eb8c507f…` unchanged.
- Schema convergence: `ensurePaymentsPayerColumns()` follows the established add-column pattern (legacy rows keep NULL = their original meaning); no rebuild required.

## 6 · Verdict

**PASS — engineering-complete for the authorized scope.**

- Within everything the owner has authorized (including the W16 semantic layer), no material financial or operational event is incorrectly represented, invisible, duplicated, or silently transformed; no unsafe shortcut, stub, orphan writer or unguarded money path was found.
- The system's honest posture is complete: every unrepresentable event is *refused with the decision named*, never improvised.
- The next engineering stage is **not blocked**: the platform (authorities, invariants, controls, observability, backup, RBAC, audit) is production-grade. What remains is a **decision queue** (§4) whose items each unlock a well-scoped, pre-designed capability. Engineering on those items should resume only as the owner answers each gate.

**Final state:** four closures implemented and proven; ten policy gates documented with exact decisions; nothing invented; nothing half-represented.
