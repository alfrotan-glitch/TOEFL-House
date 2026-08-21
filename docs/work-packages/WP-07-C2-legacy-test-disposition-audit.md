# WP-07 · C-2 legacy-test disposition — READ-ONLY AUDIT

**Protocol:** §65 CHECKPOINT · §14 / §70 (fixtures are re-expressed, never deleted) · §103 EVIDENCE · §104 · §106 SCOPE · LAW 1
**Date:** 2026-08-21 · **Baseline:** `5ade361` (release gate 22/22; server suite 2816 passed · 160 known skips)
**Status:** audit performed read-only; **disposition APPROVED by the owner 2026-08-21 and IMPLEMENTED** (D-147/D-148/D-149). §6 records the outcome, including the two reclassifications the approved deep read produced.

**Original status when written:** **AUDIT ONLY. Nothing was changed.** No test, source, schema or registry behaviour was modified to produce this document. Disposition is presented for owner approval.

---

## 0. Method, and its limits (stated first, because it bounds every claim below)

What was actually executed:

```
npx vitest run <all 35 inventoried files> --reporter=json     → 580 cases, 580 passed, 0 failed
git log --oneline d29554b..HEAD -- <each file>                → which files this session already touched
grep signals across all 35 for retired/renamed concepts       → payments.semester, installment_plan,
                                                                 allocated_amount, settledScholarship,
                                                                 total_budget, getSemesterTuitionPaid
```

Every one of the 35 files was **executed** and **signal-scanned**. A subset was
**read in depth** (`money-boundary-property`, `finance-money-writer-parity`,
`payment`, `discount-cap`, `invoice-subsystem-integrity`,
`payment-overpayment`, `journey-enrollment-discount-authority`).

**I did not read all 580 cases line by line.** Classification for the
un-inspected remainder rests on execution status, signal scan, and whether a
newer WP-07 package suite now owns the same concern. That is a real limit and it
is recorded as **AR-1** in §5.

---

## 1. Finding that changes the obligation itself: the inventory count is wrong

**FACT.** `docs/legacy-test-inventory.md` records **35 files · 409 cases**.
Executed, those same 35 files run **580 cases**.

The inventory counted `it.each(...)` blocks as one case each. The divergence is
concentrated in the table-driven suites:

| File | Inventory | Actual | Δ |
|---|---:|---:|---:|
| `invoice-subsystem-integrity.test.ts` | 32 | 71 | +39 |
| `finance-money-writer-parity.test.ts` | 19 | 52 | +33 |
| `discount-authorization-boundary.test.ts` | 19 | 40 | +21 |
| `money-boundary-property.test.ts` | 10 | 28 | +18 |
| `finance-expense-request-integrity.test.ts` | 15 | 27 | +12 |
| `bos-profit-withdrawal-integrity.test.ts` | 11 | 23 | +12 |
| `finance-operational-payment-integrity.test.ts` | 13 | 25 | +12 |
| others (28 files) | 290 | 314 | +24 |
| **total** | **409** | **580** | **+171** |

**Consequence.** Every prior statement of the C-2 obligation — including the one
in `docs/certification/WP-07-slices-A-B-finance-remediation.md` — understates it
by 42%. The inventory must be corrected before C-2 can be closed against it.

**FACT.** All 580 pass. **No inventoried file is currently red.**

---

## 2. Disposition — all 35 files classified

### Class 1 — STILL VALID, MUST REMAIN · 26 files · 355 cases

These assert a rule that is still canonical, and no newer suite duplicates
them. No action beyond keeping them.

| File | Cases | Why it stays |
|---|---:|---|
| `balance-single-source-of-truth.test.ts` | 7 | `studentBalance` is still THE balance authority; roster-vs-profile agreement is untouched by D-141 |
| `book-price-monetary-validation.test.ts` | 13 | book/salary money validation — outside the settlement authority |
| `bos-profit-withdrawal-integrity.test.ts` | 23 | cumulative withdrawal ceiling; unaffected by allocations |
| `cash-position-reconciliation.test.ts` | 8 | branch cash = income − savings − drawings; reconfirmed green by every slice A–K |
| `discount-authorization-boundary.test.ts` | 40 | the discount **authority** (20% ordinary ceiling, categories do not stack) — still canonical |
| `discount-authorization-routes.test.ts` | 16 | approval authority at the HTTP boundary |
| `discount-policy-authority.test.ts` | 3 | ceiling is configuration, not a literal |
| `fee-bill-render.test.ts` | 11 | printed bill content/format |
| `finance-accounting-classification.test.ts` | 12 | `ledger-classification` taxonomy authority |
| `finance-budget-line-api.test.ts` | 18 | budget-line API + branch scope |
| `finance-dashboard-period.test.ts` | 21 | period/timezone axis authority |
| `finance-dashboard.test.ts` | 5 | dashboard contract (re-expressed in slice F for `purpose`) |
| `finance-expense-request-integrity.test.ts` | 27 | expense request lifecycle + branch attribution |
| `finance-grand-audit.test.ts` | 2 | cross-cutting invariants |
| `finance-operational-payment-integrity.test.ts` | 25 | expense follows its budget line |
| `finance-overview-staleness.test.ts` | 8 | cash mutations refresh the overview |
| `finance-taxonomy.test.ts` | 23 | canonical taxonomy (re-expressed in slice F, D-130) |
| `finance-ui-hierarchy.test.ts` | 15 | browser holds no accounting knowledge (re-expressed in slice F, D-130) |
| `financial-data-audit-tool.test.ts` | 7 | audit tool behaviour |
| `financial-extended.test.ts` | 26 | recovery / concurrency / DB integrity (re-expressed in slice F) |
| `guarded-category-concurrency.test.ts` | 10 | guarded categories collapse duplicates |
| `ledger-classification-consistency.test.ts` | 11 | classification consistency across surfaces |
| `ledger-period-totals.test.ts` | 5 | authoritative period totals |
| `legacy-fee-resolution-safety.test.ts` | 7 | malformed stored fees cannot become money |
| `refund-reclaims-savings.test.ts` | 8 | refund reclaims the savings sweep; still true after D-142 |
| `treasury-chain.test.ts` | 4 | capital deposit → budget → salary chain |

### Class 2 — OBSOLETE, EXPLICITLY RETIRE · 1 file · 2 cases

| File | Cases | Evidence |
|---|---:|---|
| `payment.test.ts` | 2 | It calls **no application writer**. It hand-writes an `INSERT INTO payments` and an `INSERT INTO financial_transactions` in the test body and then asserts both rows exist. It therefore proves a property of the test's own SQL, not of the system. Every behaviour it gestures at is owned by live suites: `recordIncome` linkage by `cash-position-reconciliation` and `refund-reclaims-savings`, payment writing by `finance-money-writer-parity` and `cash-allocation-authority`. |

**Retirement means an explicit skipped knowledge record with a decision entry
(the D-85 precedent), not a deletion.**

### Class 3 — REQUIRES RE-EXPRESSION · 8 files · 223 cases

Each of these **passes**, and each has stopped discriminating the rule it claims
to protect. That is the dangerous state: green, and no longer load-bearing.

| File | Cases | What has drifted |
|---|---:|---|
| `money-boundary-property.test.ts` | 28 | **The inventory is one-directional and stale.** The assertion loops over a hand-maintained `INVENTORY` and, for each listed pair, checks the route file contains `assertMoney(` and the literal label. **A newly added money field can never fail it.** Concretely: `invoices.routes.ts` is absent from the inventory entirely while validating three money fields (`Payment amount`, `discount amount`, `unitPrice`); `students.routes.ts` lists 2 of its 5 labels; `funding.routes.ts` omits `donation amount`. It also scans only `routes/`, while D-120/D-131/D-140 moved real money boundaries into `core/finance/`. |
| `finance-money-writer-parity.test.ts` | 52 | Claims parity across the money writers, and covers four: invoice payment, ad-hoc payment, refund, donation desk. Since slice G/I the writer set includes sponsorship receipts, sponsorship allocations, scholarship fundings and scholarship allocations — **none in the parity sweep**. |
| `invoice-subsystem-integrity.test.ts` | 71 | Re-expressed in slice F to bill `purpose: 'other'` by default (D-130), which was correct for its subject — the invoice **document**. The effect is that the tuition-invoice lifecycle (purpose → obligation → capacity, D-127/D-128) is now exercised **nowhere in this file**. It should state that delegation explicitly rather than leave a reader believing it covers invoices generally. |
| `financial-integrity.test.ts` | 19 | §4 Invoice State Machine and §6 Discount & Fee Snapshot predate `invoices.purpose` and `obligation_id`. Passes because slice F added `purpose: 'other'` to its fixtures; the state machine is no longer asserted for a tuition invoice. |
| `journey-enrollment-discount-authority.test.ts` | 22 | D-138 changed the ceiling basis from the whole fee snapshot to **tuition only**. Its fixtures carry a tuition-only fee, so the old and new bases coincide and **the change is invisible to this suite**. It cannot fail if the basis regresses. |
| `payment-overpayment.test.ts` | 17 | Same class: the enrolment-discount cases use `ensurePaidLevel()` (a level fee, all tuition), so the tuition-only basis is not discriminated. Also the one file still asserting against `payments.semester` directly, now a display column rather than the settlement key (D-141). |
| `money-writer-idempotency.test.ts` | 11 | Covers invoice-payment and donation retries. The sponsorship receipt and allocation writers added in slice G have **no retry/duplicate coverage** in any suite. |
| `discount-cap.test.ts` | 3 | Tests `evaluateRules` — the rule **engine**, a layer subordinate to the discount authority — and asserts a 30% clamp, while the canonical ordinary ceiling proven by `discount-authorization-boundary` is 20%. Both are true of different layers, but the file's name and title read as though 30% were the operative ceiling. Needs scoping in name/title, not a behaviour change. |

### Class 4 — EXPOSES A REAL REMAINING DEFECT · 0 files

**No inventoried file exposes an unrepaired production defect.** All 580 pass,
and the signal scan found no assertion that contradicts a canonical authority.

I want to be precise about what that does and does not mean. The Class 3 items
are **coverage gaps**, not live defects: I checked the specific money paths they
fail to cover and each is in fact validated —
`recordSponsorshipReceipt`/`allocateSponsorshipToObligation` parse through
`assertMoney` (proven by 8 adversarial cases in `sponsorship-money-authority`),
and every invoice money field is parsed (proven in `invoice-subsystem-integrity`
and `invoice-purpose-authority`). The gap is that **nothing would catch a
regression** in those paths from the legacy suites — which is exactly what
re-expression fixes.

---

## 3. Recommended disposition

1. **Correct the inventory** from 409 to 580 with the per-file table in §1, and record that `it.each` expansion was the cause. Without this, C-2 cannot be closed against a true number.
2. **Retire `payment.test.ts`** as an explicit skipped knowledge record with a decision entry (D-85 precedent). Never delete.
3. **Re-express the 8 Class-3 files**, each as a recorded decision (D-112/D-115/D-123/D-126/D-130 precedent). The re-expression is targeted, not a rewrite of 223 cases:
   * `money-boundary-property` — make the inventory **derived, not hand-maintained**: scan `routes/` *and* `core/finance/` for money-typed request fields and fail on any that does not reach `assertMoney`. This converts a decorative list into a real guard.
   * `finance-money-writer-parity` — extend the parity sweep to the four newer money writers.
   * `money-writer-idempotency` — add retry coverage for the sponsorship receipt and allocation writers.
   * `journey-enrollment-discount-authority` and `payment-overpayment` — add a registration fee to the fixtures so the tuition-only ceiling basis is actually discriminated.
   * `invoice-subsystem-integrity` and `financial-integrity` — state the delegation to `invoice-purpose-authority` explicitly and pin that these suites cover the non-tuition document.
   * `discount-cap` — scope its name and title to the rule engine.

**Estimated new/changed cases: 40–60**, concentrated in the two inventory-style
suites. No Class-1 file is touched.

---

## 4. Impact on WP-07 certification, quantified

| Certification blocker | Closed by this disposition? |
|---|---|
| C-2 legacy-test disposition (the stated blocker) | **Yes** — 26 remain, 1 retired, 8 re-expressed, inventory corrected |
| Inventory count materially wrong (409 vs 580) | **Yes** |
| Money-boundary guard cannot detect a new unvalidated field | **Yes** — the largest real risk this audit found |
| Newer money writers absent from parity/idempotency sweeps | **Yes** |
| **TR-4 — independent review by the same agent** | **No.** Structural; needs a second reviewer |
| **F-18b — two different "outstanding" figures** (`reports.routes.ts` open invoices vs the balance authority) | **No.** Separate defect, unclaimed |
| **Revenue reports INNER JOIN `classes`** — tuition for a class-less term appears in neither total (slice K residual) | **No** |
| **`payments.semester` retirement** | **No.** Agreed follow-on |
| **WP-05/08/10 duplicate schema authority** (C-18) | **No.** Outside WP-07 |

**Honest conclusion.** Completing this disposition makes WP-07 **certifiable in
scope** — the behavioural record would be accurate, complete against the current
authorities, and load-bearing. It does **not** make WP-07 certified: F-18b is an
open financial-reporting defect inside WP-07's own boundary, and TR-4 is
unresolved. A certification claim after C-2 must be worded as *"certified except
F-18b, with TR-4 outstanding"* — not as unconditional.

---

## 5. Audit risks recorded

| # | Risk | Mitigation available |
|---|---|---|
| **AR-1** | Classification of the 27 files not read line by line rests on execution status, signal scan and ownership mapping. A case could assert a superseded rule while still passing on a non-discriminating fixture — the exact pattern found in 4 files that *were* read closely. | Read the Class-1 files in depth before certifying, or accept and record the residual. **Recommend: deep-read the 6 Class-1 files that touch settlement** (`balance-single-source-of-truth`, `cash-position-reconciliation`, `refund-reclaims-savings`, `guarded-category-concurrency`, `ledger-period-totals`, `financial-extended`). |
| **AR-2** | The 580 figure is this run's expansion of `it.each`; a data-driven table could change it again. | Record the count as derived, with the command that produces it. |


---

## 6. OUTCOME — deep read performed, disposition implemented

The owner approved the disposition in full and directed the **deep read of the
6 settlement-touching Class-1 files** (AR-1 mitigation). Both were done.

### 6.1 Deep read of the 6 — one reclassification

| File | Deep-read outcome |
|---|---|
| `cash-position-reconciliation.test.ts` | Class 1 **confirmed** — eight variance-detection classes, none affected by allocations |
| `refund-reclaims-savings.test.ts` | Class 1 **confirmed** — operates on `recordIncome` directly; the savings reclaim is unchanged by D-142 |
| `guarded-category-concurrency.test.ts` | Class 1 **confirmed** — "concurrent payments can never exceed the semester debt" is now backed by the allocation authority and still discriminates |
| `ledger-period-totals.test.ts` | Class 1 **confirmed** — period totals vs pages; not settlement-shaped |
| `financial-extended.test.ts` | Class 1 **confirmed** — D2 (`total − discount = net`) and D5 (`fee_amount ≥ net_fee_amount`) both still hold after D-136 |
| `balance-single-source-of-truth.test.ts` | **RECLASSIFIED 1 → 3.** It asserted the balance identity with `toBeCloseTo(due - paid, 6)`. Every stored money column is an INTEGER and D-104 removed tolerance from money comparisons, so the identity could drift and still pass. Re-expressed to exact equality. |

**Final disposition: 25 remain · 1 retired · 9 re-expressed.**

### 6.2 The audit's central claim, proven by mutation

Class 3 was defined as "passes, and no longer discriminates the rule it claims
to protect". That claim was tested rather than asserted:

| Mutation | Before re-expression | After |
|---|---|---|
| Add an unvalidated money field `surchargeFee` to `invoices.routes.ts` | **survived** — 27/27 green | **killed** — `invoices.routes.ts: surchargeFee` |
| Regress the discount ceiling from the tuition total to the snapshot total | **survived** — 22/22 green | **killed** — 2 cases fail |

A third defect was found while building the new guard and is worth recording:
the first version of the money-field detector used `\b(fee|amount|…)\b`, which
never matches inside a camelCase name like `surchargeFee`. It was green and
useless until the mutation exposed it. The detector now splits names at their
camel humps, and exempts any field ending in `Id`/`Ids` as an identifier rather
than a figure.

### 6.3 Certification impact — updated

| Blocker | State |
|---|---|
| C-2 legacy-test disposition | **CLOSED** (D-147/D-148/D-149) |
| Inventory count wrong (409 vs 580) | **CLOSED** — corrected, derived, reproducible |
| Money-boundary guard could not detect a new unvalidated field | **CLOSED** — mutation-proven |
| Newer money writers absent from parity/idempotency sweeps | **CLOSED** |
| **TR-4** — review by the same agent | **OPEN** (structural) |
| **F-18b** — two different "outstanding" figures | **OPEN** |
| Revenue reports INNER JOIN `classes` (slice K residual) | **OPEN** |
| `payments.semester` retirement | **OPEN** (agreed follow-on) |

**WP-07 is now certifiable except F-18b, with TR-4 outstanding.** It is not
certified, and no certification claim has been made.
