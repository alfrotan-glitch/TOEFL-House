# Wave 18 — Decision-Gate Reduction · Verdict

**Wave:** 18 · Review of every remaining POLICY REQUIRED item; implement only what established accounting principles and existing system semantics resolve without inventing business policy
**Date:** 2026-09-05
**Role:** Chief Systems Architect & Independent Technical Authority
**Verdict: PASS** — the decision queue is now at its **irreducible minimum**: every gate that engineering can legitimately close from principles and existing semantics has been closed this wave; the eight that remain are genuine owner decisions, each stated below with the exact decision required. Nothing was defaulted, nothing half-represented; all authorities, invariants, auditability, permissions, idempotency, concurrency guarantees, historical truth and governance are preserved (proven, not asserted).

---

## 1 · Method

Each of the ten W17-registered gates was re-examined against one question: **can the semantics be derived from established accounting principles and the system's own certified precedents, with no number, threshold, authority or ordering invented?** Only two gates contained a derivable core. The other eight were re-verified as genuinely policy-bound and are restated precisely (§4).

## 2 · Gates narrowed this wave (implemented + proven)

### 2.1 D-DC-3 · Clawback partial attribution → genuine ambiguity only (D-187)

W16 refused any clawback after onward movement because "which instrument loses capacity first" looked like policy. The correct analysis: **attribution is ambiguous only when unconsumed money sits in TWO OR MORE instruments of the donation's provenance chain.** When exactly ONE instrument still holds unconsumed capacity, the facts force the attribution — no ordering choice exists.

- Declaration now enumerates the chain (root fundings/receipts, direct and return campaign entries, downstream campaign-funded fundings/receipts), computes each instrument's unconsumed capacity **through the canonical position functions**, and:
  - **one holder** → declaration succeeds; `attributed_kind`/`attributed_id` are **fixed at declaration** on the clawback row (later consumption cannot re-write history);
  - **two or more holders** → 409 POLICY REQUIRED, naming each holder and amount. FIFO/LIFO-style ordering between holders is a real owner choice and is not made.
- Per-instrument positions (`getScholarshipFundingPosition`, `getSponsorshipReceiptPosition`, `getCampaignFundingEntryPosition`) subtract **only their own attribution** — the W16 latent double-reduction (a drained root clamping at 0 while the holder also reduces) is structurally impossible now. Aggregate positions (fund/scholarship, sponsorship agreement) remain chain-wide.
- The clawback register (W17) exposes the attribution; its aggregates remain provably equal to the exposure view.
- **Convergence:** pre-W18 rows are backfilled to their single root instrument (the only shape the old guard allowed) in a one-time pass behind the dropped-and-recreated immutability trigger; rows that cannot be backfilled keep NULL and the positions retain the exact chain-wide behaviour they always had.
- **Proof:** direct attribution; the previously-refused onward case (return into a campaign, root drained) now claws back with precise attribution and **no double reduction**; a chain with money in an entry AND a downstream funding still refuses with the holder count and amounts; legacy NULL fallback; register↔exposure agreement; invariants green throughout.

### 2.2 Asset depreciation & disposal → custody-loss slice resolved, economics stay gated (D-188)

The gate contained one non-policy core: **the fact that an asset is no longer held** (lost/stolen/destroyed). In this cash model the cost left at purchase, so a physical loss moves no money and implies no P&L class — exactly the certified WP-10 books-adjustment semantics ("financially invisible by design — coherent").

- `POST /finance/assets/:id/declare-loss` (`Expense.Approve`): append-only `fixed_asset_losses` event (reason ≥ 8 chars, optional evidence reference) + `custody_status` in_service → lost in **one transaction**; UNIQUE asset_id = one loss per asset; a lost asset cannot be custody-transferred; **zero ledger writes, proven**.
- `custody_status` knows only `in_service | lost`. **Proceeds-bearing disposal, retirement and depreciation remain POLICY REQUIRED and unrepresentable** — those need loss/proceeds classes, methods and rates the owner has not supplied (D-182).
- The in-service cost-basis metric excludes lost assets automatically.
- **Convergence:** pre-W18 databases are rebuilt via the certified copy-swap pattern (rows preserved, FK check clean, dependent triggers recreated) — proven on a regressed database.

## 3 · Considered and rejected (with reasons)

- **Physical cash count, even evidence-only:** D-CC-1 gates what the *expected* figure even means (is "savings" a physical safe or a partition?); recording counts against operator-named stores without the owner defining countable scope would shadow the real decision. Stays fully gated.
- **FX memo fields:** D-FX-1 (does USD acceptance exist at all) is an owner-evidence question; building the surface before the evidence is speculative. Stays gated; cheap once answered.
- **Doubtful-debt observation flags, supplier masters, loan shells:** each embeds criteria/authority/terms that are policy; a term-less or criteria-less half-surface is exactly the half-representation W13 condemned. Stay gated.
- **Treasury-deposit reversal:** correction of misstated capital is the D-RC family (return of capital) — stays gated.
- **Boot-time invariant gating:** re-verified as a behavior change without operational necessity; the checker remains an on-demand audit surface.

## 4 · The remaining decision queue — smallest possible set (8)

| # | Capability | Exact owner decision required | Gate |
|---|---|---|---|
| 1 | Physical cash count & drawer variance | D-CC-1 which stores are countable (is savings physical?); D-CC-2 variance treatment (expense vs employee receivable vs owner-absorbed; overage class); D-CC-3 tolerances; D-CC-4 approver/SoD; D-CC-5 cadence/close; D-CC-6 supersession | W14 |
| 2 | Supplier credit purchases & returns | Supplier master + payment/refund terms; who may bind the institute to a payable (P14) | D-183 |
| 3 | Loans | Does the institute borrow (P12)? Conventional interest excluded (P13)? Lender identity, rate, repayment authority (P14) | D-183 |
| 4 | Student-debt doubtful/discharge/write-off | P16: doubtful/discharge states, recovery window, write-off authority and its P&L class | W14 |
| 5 | Payroll withholding | WH: does the institute withhold wage tax/social contributions? Liability class, remittance event, payslip semantics | W14 |
| 6 | FX / multi-currency | D-FX-1 does USD acceptance exist; D-FX-2 memo vs full; D-FX-3 FX gain/loss class | W14 |
| 7 | Return of capital outside dissolution | D-RC-1 permitted? D-RC-2 authorization + net-assets floor replacing the margin cap | W14 |
| 8 | Asset depreciation, retirement & disposal economics | Classes, methods, rates; proceeds/loss classes; retirement semantics (custody loss is now representable — D-188) | D-182 |

Two former queue items were **reduced, not removed**: D-DC-3 survives only as "ordering when ≥2 instruments hold unconsumed money" (the unique case is now fact-resolved), and the asset gate survives only as depreciation/disposal economics (the custody-loss fact is now representable). Restricted-fund enforcement level (P11) remains answered at levels (a)+(b) — report + allocation guards — with cash-level segregation still the owner's call if ever wanted; it is not a queue item blocking anything.

## 5 · Verification

- `tsc --noEmit`: clean.
- Wave-18 adversarial suite: **6/6** (`server/src/tests/wave18-decision-gates.test.ts`).
- W16 + W17 suites re-run: **19/19** (no regression from the attribution change).
- Full suite: 224 files, **2997 passed, 2 skipped**, 0 failed (fresh `test.sqlite`).
- Schema convergence: both copy-swap/backfill shims proven on regressed pre-W18 databases (rows preserved, `PRAGMA foreign_key_check` clean, new behaviors live, guards firing).
- `node scripts/verify-registries.mjs`: **PASS** (6 registries, 523 rows, 982 path references, 118 endpoint references).
- `npm run audit:protocol`: **PASS** — seal unchanged.

**Honest disclosure:** during this wave a probe script briefly wrote labeled, internally-consistent test rows into the local dev database (`server/data/erp.sqlite` — git-ignored, never shipped, verified to contain zero business data). The append-only integrity guards correctly refused surgical deletion; the file was archived as `data/erp.sqlite.probe-polluted.bak` and a clean canonical dev database is rebuilt on next boot. Production/test databases were never touched; the mistake is recorded here because the report states only proven facts.

## 6 · Verdict

**PASS.** The platform remains production-grade and verified; the decision queue is reduced to eight items that are irreducibly the owner's — each with the exact decision required, each refusing honestly (409 POLICY REQUIRED) rather than being improvised. Engineering on any queued item can begin the moment its decision arrives; nothing else waits on anything.
