# Forensic Audit — Wave 13 Verdict
## Outside-In Completeness Attack: Can the ERP Contain a Real Institute?

**Verdict: CONDITIONAL PASS** — bounded, explicitly identified policy/capability gaps remain (§12–§13). No material economic event **within the authorized operating scope** is incorrectly represented, invisible, duplicated, or silently transformed. Every gap discovered is an *absence of representation* whose treatment is policy-dependent, and each is named below with its exact boundary. One defect was found and fixed during the wave (D-W13-1, label-only).

Method discipline held: the event matrix in §2 was constructed from the business first (the goal's own inventory of a Kabul ESL institute + period reconstruction), then mapped against the tree; every coverage claim below was verified against current code (`HEAD e1603e8`), schema, routes, invariants, and read-only probes of live-shape data. Nothing was implemented except the label fix; no policy was invented.

---

## 1. What "authorized scope" means here (the yardstick)

The project's own authoritative decisions, not this wave's opinion:

- **Operating model**: cash-recognition (W9 §operating model) — money is income/expense when cash moves; no accrual, no inventory-as-asset, no payables/receivables ledgers beyond the student obligation subledger.
- **Policy register** (W9, carried through W10–W12): P11 restricted *enforcement* (report-only by design), P12–P15 borrowing/loans/employee-loans, P13 finance income, P16 staff-advance recovery window & write-off semantics.
- **Scope boundaries** (W11/W12 gates): no payables, no loans, no write-offs, no full restricted enforcement, no depreciation.

Everything below is judged against that yardstick, and every deviation from it is classified G (policy) or H (intentional scope), never silently as a defect.

## 2. Independent economic-event matrix

Built from the period life of a real institute: opening → setup → staff → student funnel → funding → operations → exceptions → close. Coverage codes: **A** fully represented · **B** partial · **C** operationally represented, financially invisible · **D** financially represented, misclassified · **E** memo only · **F** impossible · **G** policy-dependent · **H** intentional scope.

### I. Formation, capital, ownership

| # | Real-world event | Economic substance | ERP coverage | Evidence |
|---|---|---|---|---|
| I-1 | Owner injects capital | equity cash-in | **A** | `POST /finance/treasury/deposit`, `capital_injection` (equity class), I13 |
| I-2 | Owner withdraws profit | distribution, margin-capped | **A** | `bos` withdrawal: profit-margin allowance, `sub_owner_drawings`, own P&L line |
| I-3 | Owner withdraws **contributed capital** (return of capital, not profit) | equity cash-out | **G** | withdrawal allowance is profit-based; whether return-of-capital is permitted is owner policy — no path encodes it; not silently represented |
| I-4 | Loan proceeds / repayment / interest | non-equity liability cash flows | **F/G** | P12–P15 register; W9 already derived the semantics (`loan_proceeds` class, architecture path B) — **no policy decision to date**; nothing is masquerading as equity today (capital injections are labeled equity and historically clean) |
| I-5 | Grant/NGO funding received | restricted inflow | **A** | donations + `donation_restrictions`; exposure report (W12) |
| I-6 | Grant commitment reporting ("we promised X spend") | obligation to donor | **E** | campaign targets / `sponsorshipPromisedMonthly` memos — deliberately not enforceable (P11) |

### II. Premises, infrastructure, durable resources

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| II-1 | Pay rent | operating cash-out | **A** | `sub_rent`, expense-request → budget |
| II-2 | Refundable security deposit **to** landlord | asset (claim), not expense | **F** | no deposit resource; booking it as rent would be **D-risk**, but the system forces no such booking — it simply cannot represent the refundable nature; policy question whether it is material |
| II-3 | Prepaid rent (annual upfront) | cash-out now | **A** (cash model) | expensed when paid — *correct* under the declared cash-recognition model; the "prepaid asset" state does not exist by design (H if accrual ever authorized) |
| II-4 | Utilities / internet / cleaning / security / repairs | operating cash-out | **A** | taxonomy nodes; SoD approval flow |
| II-5 | Buy furniture / IT / office equipment / vehicle | capital expenditure | **A** for the purchase event (`cat_capital_expenditure`, own P&L line, excluded from operating expense); **F** for custody afterwards — no asset register: transfer between branches, disposal, sale, theft of an asset have **no** representation (see §6) |
| II-6 | Classroom build-out / renovation | capex or repair | **A/B** | `sub_repair_maintenance` vs capex nodes — boundary is operator judgment, both classes exist |

### III. Procurement & suppliers

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| III-1 | Buy books for cash | stock-in + expense | **A** | `book_stock_receipts` (qty, unit cost) + `book_purchase` expense on `sub_books_educational`; stock quantity tracked |
| III-2 | Buy supplies/services for cash | operating expense | **A** | expense-requests: requester≠approver SoD, branch+envelope match, auto-approve threshold setting |
| III-3 | Goods/services received **before** payment | supplier obligation | **F/H** | the Wave-8 payables gap; policy-gated (P12 family), deliberately not implemented — a GRN-less purchase on credit cannot be recorded *at all* (no false record is created) |
| III-4 | Supplier prepayment/deposit | claim on supplier | **F** | — |
| III-5 | Partial deliveries | stock over time | **B** | multiple receipts represent quantities; the unpaid-balance side is absent (III-3) |
| III-6 | Return goods **to** supplier / supplier credit note / supplier refund | reversal of purchase | **F** | stock can only go down via `loss`/`correction` adjustments (mislabels the event); money-back has no path |
| III-7 | Price difference / duplicate supplier payment | correction | **F/na** | no supplier payments exist to duplicate; expense requests are decide-once (pending→decided terminal), duplicate *requests* are an operational matter caught by SoD |
| III-8 | Supplier balance report | — | **F** | follows from III-3 |

### IV. People & payroll

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| IV-1 | Teacher monthly salary (skills/multipliers) | operating cash-out + due | **A** | `teacher_salary_ledger` (due_amount, paid), rules engine, W11-verified |
| IV-2 | Employee salary + earned bonus | composed due | **A** | W12: cap = base+bonus in write lock, `due_amount`, salary-status parity, I7 re-aligned |
| IV-3 | Salary advance | receivable vs future pay | **A** | `advance` type, `sub_salary_advances`, exempt from due cap, tracked per period |
| IV-4 | Advance recovery across months | receivable → settlement | **G** | within-period recovery works (payments count against composed due); cross-period recovery window is **P16 POLICY REQUIRED** (W11 verdict) |
| IV-5 | True staff loan (beyond earned pay) | distinct receivable family | **F/G** | P15 — deliberately absent |
| IV-6 | Payroll withholdings (tax/social) | liability + net pay | **F/G** | gross-pay model; Afghan withholding policy never supplied — flag POLICY REQUIRED if institute must withhold |
| IV-7 | Void salary payment | reversal | **A** | void restores payable + budget; double-void refused (W12-verified) |
| IV-8 | Bonus rule change | re-authorization | **A** | rules: owner/GM only, versioned, audited; computation in-lock prevents cap/ledger disagreement |

### V. Student revenue cycle

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| V-1 | Inquiry → visitor → follow-up | non-economic | **A** | `visitors`, `visitor_followups` |
| V-2 | Placement test + fee | service revenue | **A** | placement tables; `placement` income class |
| V-3 | Registration + fee | service revenue | **A** | fee_rules, invoices, `registrations` |
| V-4 | Tuition enrollment | obligation + invoice | **A** | obligations, invoices, aid repricing (I3/I4/I5/I14) |
| V-5 | Tuition payment / installment plan | receivable settlement | **A** | allocations (I1/I2/I18), installment plans (I15) |
| V-6 | Discount (capped, authorized) | revenue reduction | **A** | authorizations + rule cap |
| V-7 | Card/diploma/exam/chapter/other desk fees | auxiliary revenue | **A** | canonical classes; `other` reason-required |
| V-8 | Book sale (incl. loan/return program) | product revenue + stock-out | **A** | `book_sales`/`book_loans`; refund restores availability **by derivation** (sales-excluding-refunded), idempotent, one-refund-per-sale (verified §8) |
| V-9 | Tuition/book refund | contra-revenue cash-out | **A** | `refund` class, contra-revenue, exact-once (W12-verified) |
| V-10 | Dispute → partial refund | — | **A** | partial refunds with reason |
| V-11 | Overpayment / credit balance | prepayment | **F** | payments are capped at outstanding (400/409); a credit balance is unrepresentable — policy: Kabul institutes often *do* take next-term prepayments → **genuine candidate for policy decision** |
| V-12 | Bad debt (student never pays) | still-owed → doubtful → discharge | **F/G** | obligation stays honestly `open` forever; no doubtful/discharge states (P16/write-off policy); **no aging report exists** to even *see* the aging (reporting gap, §12 RNK-3) |
| V-13 | Bad-debt later recovered | — | **A** | since no discharge exists, recovery = ordinary payment against the still-open obligation — no state corruption possible |
| V-14 | Student moves **branch** with outstanding balance | receivable relocation | **F** | no student-branch transfer surface (only within-branch class transfer via `enrollment_transfer_requests`); a cross-branch move today requires out-of-band intervention — **new discovery, policy/ops decision needed** |
| V-15 | Guardian/sponsor pays on student's behalf | third-party payer | **B** | payment attaches to the student (economic owner) — correct; the *payer identity* is not recorded (attribution only via notes/sponsorship) |
| V-16 | Sponsored tuition | aid settlement | **A** | sponsorship receipts/allocations/reversals (W12) |

### VI. Funding & restricted money

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| VI-1 | Unrestricted / restricted donation | inflow (+restriction fact) | **A** | W12-verified |
| VI-2 | Allocate / consume / reverse / return-to-campaign | pool movements | **A** | exposure report; reversal restores; terminalization stays in pool |
| VI-3 | Enforcement of purpose | spending constraint | **G** | P11 — report-only **by design**; tracked↛enforced boundary held |
| VI-4 | Donation refund / grant clawback | restricted cash-out | **F** | no donation-refund path exists (refund surface is student-payment-scoped); grant clawbacks are a real Kabul-NGO occurrence → **POLICY REQUIRED** (new discovery) |
| VI-5 | Restricted money across periods | persistence | **A** | positions are period-independent; no fund close exists (correct — no policy for one) |

### VII. Treasury & cash management

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| VII-1 | Capital in / budget charge / month-end return | store movements | **A** | I13 conservation, verified W12 cross-domain |
| VII-2 | Month-end envelope transfer (within branch) | envelope-to-envelope | **A** | paired signed movements, sum-zero |
| VII-3 | **Direct** inter-branch cash/envelope transfer | relocation of value | **F** | budget transfers are same-branch-only; branch cash (main balance) is created only by branch income; consolidation across branches has **no** path (two-hop via org-treasury return+charge exists for envelopes only) — policy question whether branch cash is deliberately branch-sovereign (it appears deliberate: HQ spends via envelopes) → **G** |
| VII-4 | Savings sweep | internal move | **A** | realtime per-transaction, percent setting; manual bulk run disabled (double-transfer guard) |
| VII-5 | Payment methods incl. bank transfer | method attribution | **A** | cash/card/bank_transfer recorded; **bank statement reconciliation** has no surface (**E/G** — the saving store exists, statement matching does not; policy) |
| VII-6 | Petty cash as a distinct store | — | **F** | branch main = aggregate cash; no petty-cash sub-store (likely H — operational convenience) |
| VII-7 | Foreign-currency receipt/payment (USD) | FX | **F/G** | whole-AFN single-currency enforced by triggers; a USD receipt cannot be represented honestly — Kabul reality makes this a **real policy question** (new discovery) |
| VII-8 | Physical cash count / discovered shortage | physical↔digital divergence | **F** | **no count surface exists**; reconciliation is digital-vs-digital (ledger vs accounts vs payments) and by design cannot see a drawer shortfall — see §7, RNK-1 |

### VIII. Period close & time

| # | event | substance | coverage | evidence |
|---|---|---|---|---|
| VIII-1 | Month-end settlement | envelope hygiene | **A** | return/transfer decisions |
| VIII-2 | Jalali year boundary (1405-12→1406-01) | period independence | **A** | W12 cross-domain verified |
| VIII-3 | Event date ≠ cash date ≠ record date | timing truth | **A/B** | economic events carry explicit `date`; cash moves in the same row; **recorded-at** exists on payments/ledger (`paid_at`, created_at) — all three distinguishable; future-dated payments accepted (cash model tolerates), future payroll months payable (honest record; policy could constrain) — observation, not defect |
| VIII-4 | Refund after period close | contra in current period | **A** | cash model: no restatement; the refund is a new event referencing the original — model-consistent |
| VIII-5 | Correction of a past record | — | **A** | reversal/void/reference pattern everywhere; financial rows are append-only with status; immutability triggers (W11) |

## 3. Resource lifecycle map (the ten questions)

| resource | appear | increase | decrease | transfer | partial consume | reverse | become unrecoverable | duplicate | vanish silently | history reconstructable |
|---|---|---|---|---|---|---|---|---|---|---|
| branch cash (main) | ✔ income | ✔ | ✔ drawings/refunds | ✘ (no inter-branch) | n/a | ✔ (contra rows) | ✘ count-blind | prevented (idempotency, I16/I17) | detected (I16/I17) | ✔ (append-only ledger) |
| savings store | ✔ sweep | ✔ | ✔ | ✘ | n/a | ✔ | ✘ | prevented | detected | ✔ |
| org treasury | ✔ capital | ✔ | ✔ budget charge | (source of envelopes) | n/a | ✘ n/a | n/a | prevented (I13) | detected (I13) | ✔ |
| budget envelopes | ✔ charge | ✔ transfer_in | ✔ spend/return | ✔ same-branch only | ✔ | ✔ (void, reversal) | n/a | prevented (I10/I12) | detected | ✔ |
| student receivable | ✔ obligation | ✘ (fixed at term price) | ✔ payment/aid | ✘ cross-branch | ✔ partial | ✔ (allocation reversal; refund) | ✘ (no discharge — P16) | prevented (I1/I2/I18) | detected | ✔ |
| employee advance | ✔ | ✔ | ✔ later payments | ✘ | ✔ | ✔ void | ✘ (P16 window) | prevented (idempotency) | detected (ledger) | ✔ |
| teacher due | ✔ monthly | ✔ rules | ✔ payments | n/a | ✔ | ✔ void | n/a | prevented (I7/I19) | detected | ✔ |
| book stock (qty) | ✔ receipts | ✔ found | ✔ sales/loss | ✘ per-branch only | ✔ | ✔ refund-by-derivation | ✔ (loss kind) | prevented (floor trigger) | detected (adjustments + I-series n/a) | ✔ (append-only) |
| restricted funds | ✔ donation | — | ✔ allocation | ✘ (deliberate) | ✔ | ✔ | n/a | prevented (I21) | detected (I21) | ✔ |
| fixed assets | ✔ (capex expense) | — | ✘ (no disposal) | ✘ | n/a | ✘ | ✘ (theft invisible) | n/a | **silent after purchase** | ✘ (only the purchase row) |
| supplier obligation | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | n/a | n/a | ✘ |
| loans | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | n/a | n/a | ✘ |
| petty cash / FX / prepaid-asset / tenant deposit | ✘ each | — | — | — | — | — | — | — | — | ✘ |

Every ✘ is either **F/G/H per §2** — none is a silent corruption of a represented resource.

## 4. Money-flow attack (in → classification → custody → allocation → reporting; out → authorization → classification → budget → reporting)

- **In**: every inflow writer passes the canonical-income boundary (W12: `recordIncome` + treasury-deposit guard); unknown classes unwritable, unreportable-as-revenue, I20-flagged. Custody: `finance_accounts` credited via one money path (F-10 repair verified by tests). Allocation: student obligations/budget charge/restricted pool per class. Reporting: P&L/dashboard/report-catalog share one generated predicate — route==SQL==in-memory proven with independent in-memory walks.
- **Out**: authorization = SoD on expense requests, owner-only treasury/drawings, owner/GM rules, permission gates per route; classification = FK-joined taxonomy node (`finance_category_id`), NULL defaults to **operating** expense — costs can never silently vanish into a non-expense class (conservative fallback, mirror of the income rule); budget impact = conditional debit + I10/I12; reporting = salary/expense lines independently derivable.
- **Non-cash**: obligation → settlement (I1/I2/I18), reversal (allocation reverse, void), discharge (absent — P16), recovery (= ordinary payment, no corruption). Aid ↔ invoice repricing keeps promises consistent (I3/I4/I5/I14).

**No bypass found**: the only writers that bypass `recordIncome` are the treasury deposit (guarded) and internal store movements (budget/saving types — not income by construction). A hand-rolled ledger INSERT remains cash-visible (W12 `branchCashIncomeSql`) and drift-flagged.

## 5. Procurement verdict

Representable: cash purchase of goods/services with approval and stock-in. Unrepresentable: **the entire credit leg** — receive-now-pay-later, supplier balances, purchase returns, supplier credit/refunds, price corrections. This is the Wave-8 gap, unchanged and **policy-gated (H/G)**: the system never fabricates a false record for these (it refuses rather than misrecords), which is the correct posture for an unresolved policy decision. Partial deliveries are quantity-representable. Recommendation order in §13.

## 6. Debt & ownership verdict

Today's model distinguishes exactly: operating income ✔, capital/equity ✔, owner withdrawal ✔ (margin-capped), internal transfer ✔, — and **cannot** represent loan proceeds/repayment/interest (F per P12–P15). Crucially, **historical capital injections are NOT being silently re-read as loans** (live data: 40 injections, all `capital_injection`, none reclassified). Solvency truth within the authorized model is preserved: I16/I17 conserve every stored AFN; the treasury's meaning (capital − budget funding, I13) is exact. Finance **cost** has taxonomy nodes (bank fees, taxes) but loan interest has no class — consistent with P13 (also covering finance income).

## 7. Loss, write-off, recovery, and physical reality

- **Books**: full physical-fidelity surface EXISTS (unexpected — discovered this wave): `book_stock_adjustments` with `loss|found|correction` kinds, sign-validated deltas, ≥8-char reason, idempotency, availability floor trigger, audit + notification. Financially invisible **by design** (cash model: cash left at purchase; a loss has no P&L consequence) — coherent.
- **Cash**: the mirror surface does **not** exist. Reconciliation is digital-vs-digital; a counted drawer shortage has no representation, no adjustment surface, no variance report. This is the single most material **new** finding (RNK-1): not a misstatement of recorded reality, but the physical world's divergence from it is unrepresentable. Representation requires policy (who counts, tolerance, who authorizes adjustment) → G/F.
- **Student debt / advances**: `still owed` is permanent and honest; `doubtful/discharge` states are P16 policy. **No aging report** exists — the operator cannot even *see* age buckets (reporting-only gap, cheap to close without policy: an aging *view* states facts, makes no policy).
- **Equipment/asset loss**: invisible post-purchase (no register) — §2 II-5.

## 8. Reporting independence

| report | authority | independently reconstructable? |
|---|---|---|
| P&L / dashboard / cash-flow | generated predicates from taxonomy | ✔ proven (W12: route==SQL==in-memory + raw-row walk; re-verified green this wave) |
| reconciliation (payments↔ledger↔accounts) | three-way, distinct sources | ✔ by construction; cash predicate deliberately broader than operating predicate (W12 D3) |
| restricted exposure | funding subledger | ✔ per-donation provenance walk (W12) |
| receivables | single derived authority (obligations⋈payments⋈allocations) | ✔ (WP07-F18b); **aging: does not exist** |
| payroll due | `computeEmployeeDueAmount` + ledger | ✔ salary-status==cap==dry-run (W12) |
| budget consumption | I12 | ✔ ledger vs envelopes |
| treasury | I13 | ✔ |
| book stock | receipts−sales+refunds(by-derivation)±adjustments | ✔ raw-table walk matches service views (verified §2 V-8 this wave) |
| owner-distribution headroom | margin computation | ✔ from ledger (margin × period, distributed netted) |

No circular reconciliation found: every figure terminates in raw event rows, not in a summary that itself needs audit.

## 9. Concurrency & failure

Architecture fact: single-process, synchronous better-sqlite3 — mutations do not interleave; the remaining risk classes are retry/replay and logic races. Verified: idempotency keys (payments, donations, payroll, stock adjustments, book returns) with conflict-on-different-payload 409s; conditional budget debit in the same statement; decide-once expense requests; one-refund-per-sale; unique full-payment index; immutability triggers (W11). Network-fail-after-commit → replay returns the original receipt. **New event classes discovered this wave introduce no new races — they are absent, not racy.** Deployment caveat recorded: a multi-process future (or WAL with external writers) would reopen interleaving; DB-level backstops (conditional updates, unique indexes, triggers) are the load-bearing layer then.

## 10. Invariant & defense coverage vs the discovered event set

Covered: payment allocation (I1), over-settlement (I2, I18), pricing/invoice coherence (I3/I4/I5/I14), cancelled-obligation leakage (I6), payroll caps (I7 re-aligned W12, I19), income/payment sign (I8), receipt series (I9), envelopes (I10, I12), treasury (I13), cash conservation (I16, I17), income taxonomy (I20), restricted conservation (I21), installments (I15). Route-enforced (no invariant needed): SoD, withdrawal allowance, branch scoping, canonical write boundaries. DB-trigger-enforced: stock floor, whole-AFN money, ledger immutability. **No discovered represented event is defenseless**; the unrepresented ones (§2 F-rows) are outside invariant reach by definition.

## 11. Historical production impact (read-only probes, live-shape `data/erp.sqlite`)

| bucket | finding |
|---|---|
| confirmed corruption | **none** — no negative balances, no non-canonical income rows, no orphan audit failures |
| valid historical records | income: `book/fee/other/capital_injection` all canonical; expenses: `salary`, `salary_advance`, `book_purchase` (node-joined, valid) |
| exposed but clean | donation machinery historically unused (0 donations) → restricted-report correctness has no legacy exposure; obligations all `open` (no cancelled/odd states) |
| future-only capability gaps | everything in §2 F/G rows |
| policy-required / intentional | per P-register; unchanged |
| note | data is demo-scale (51 income rows) — production-scale effects (receipt-series volume, audit growth) untested here |

## 12. Findings inventory

**Confirmed defects found this wave** (1, fixed):
- **D-W13-1** — I7's human-readable `detail` still described the pre-W12 "never exceeds the period's base" while the SQL had been correctly re-aligned to the composed due. Label-only (no behavior); fixed this wave; checker/payroll/bonus suites green after.

**New capability/policy discoveries** (not previously on any register):
1. **Physical cash-count surface absent** (RNK-1) — cash shortage/overage unrepresentable.
2. **Donation refund / grant clawback absent** (RNK-5) — restricted money can enter but never exit except by allocation.
3. **Cross-branch student transfer absent** (RNK-4) — balance relocation impossible in-band.
4. **Aging report absent** (RNK-3) — receivables age invisible (reporting-only, policy-free to close).
5. **Return-of-capital withdrawal semantics undefined** (RNK-6) — allowance is profit-only.
6. **FX / multi-currency unrepresentable** (RNK-7) — whole-AFN single currency by design; USD reality needs a policy decision.
7. **Asset custody lifecycle absent** post-purchase (RNK-2) — with purchase correctly classified as capex.
8. **Bank statement reconciliation surface absent** — saving store exists, matching does not (policy).
9. **Third-party payer attribution** — payments attach to student; payer identity memo-only (minor).
10. **Purchase returns to supplier** — misrepresentable only by mislabeling a stock `correction`; no money path (subset of payables policy).

**Carried policy register (unchanged)**: P11 (enforcement), P12–P15 (borrowing/loans), P13 (finance income), P16 (advance recovery/write-off windows), plus payroll-withholding policy (IV-6) now added to the register.

**Intentional scope (H, correct posture)**: no accrual, no payables/loans/write-offs, no enforcement, no depreciation, gross payroll.

## 13. Priority ordering (recommendation — nothing implemented)

1. **Cash-count policy + surface** (RNK-1) — the only physical store with no divergence representation; blocks trustworthy daily close in cash-heavy Kabul operations.
2. **Aging view** (RNK-3) — pure reporting of facts, no policy needed to *see* the problem P16 will later govern.
3. **P16 decision** (write-off/doubtful/recovery windows) — the register's oldest open item; aging (2) feeds it.
4. **Donation-refund/clawback policy** (RNK-5) — restricted pool currently has no honest exit; NGO-funded institutes need this defined before it happens in reality.
5. **Cross-branch student transfer** (RNK-4) — ops procedure or in-band capability; today it silently forces out-of-band database surgery.
6. **P12–P15 borrowing decision** — unchanged priority from W9.
7. **FX policy** (RNK-7), **return-of-capital** (RNK-6), **asset register** (RNK-2), **bank reconciliation**, **payables** — in that order, each behind its policy decision.

## 14. Verdict

**CONDITIONAL PASS.**

Within the authorized operating model, the ERP can run a real institute's economically material business for a full period without losing, inventing, misclassifying, duplicating, or silently transforming economic reality — that claim is now backed by an independent event matrix (§2), a resource-lifecycle sweep (§3), full money-flow attack (§4), reporting-independence proofs (§8), and 2,958 green tests plus tsc on a clean tree. Every gap that remains is bounded, named, and policy-gated: nothing false is recorded in place of what cannot be represented, and the system's conservative fallbacks (unknown income → never revenue; unknown expense → always operating) fail safe in both directions. The conditions are exactly §12's list, prioritized in §13; the first of them (physical cash count) is where reality can currently diverge from the record with no witness — that is the boundary this verdict is conditional on, and it is a policy decision away from being closed.

*Verification state at close: full suite 220 files / 2,958 passed / 2 skipped (pre-existing UI skips); `tsc --noEmit` clean; HEAD `e1603e8` + this wave's label fix; probes read-only on a copy of live-shape data.*
