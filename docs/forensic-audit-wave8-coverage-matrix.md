# Wave 8 — Economic Reality Coverage Matrix (2026-09-05)

**Method:** reconstructed one full accounting period of a real TOEFL House
branch in Kabul WITHOUT reference to the ERP's surfaces, event classes, or
invariants — from the standpoint of a forensic accountant observing the
institution: students paying in AFN cash, sponsors remitting through hawala,
a publisher delivering books on credit, teachers earning Eid bonuses, rent
prepaid six months, a projector bought, an owner's friend lending money.
Every event below was then tested against the software, and every
absence-of-surface claim was PROVEN against source (not assumed).

**Classes:** A correctly represented · B represented but economically
incomplete · C represented but economically misclassified · D representable
only through a workaround · E intentionally unsupported, immaterial ·
F unsupported, potentially material · G impossible under documented policy.

---

## 1. Students & families

| Real-world event | Verdict | Evidence / consequence |
|---|---|---|
| Placement test fee paid before any enrollment | A | placement invoice + `income/placement` |
| Registration fee | A | charge_kind invoice |
| Tuition billed with negotiated discount | A | `net_fee_amount` at origin, immutable |
| Installment agreement + payments | A | obligations + `installment` category + `markInstallmentPaid` |
| Partial tuition payments | A | allocation layer, keyed by obligation id |
| Mid-term refund / full refund | A | negative payment + contra-income + savings reclaim |
| Drop / withdrawal mid-term | A | debt preserved (lifecycle-inclusive authority), still payable |
| Transfer to another class mid-term | A | 0-fee destination term, obligation preserved (D-88) |
| Repeat / retake a term | A | new term at class fee + retake invoice (6,500+2,000 proven) |
| Completion / graduation | A | status only; economics already settled |
| **Student disappears owing tuition** | **F** | no write-off surface (W7-2): receivable metric grows forever, overstating assets; policy decision required |
| **Overpayment kept as credit for next term** | **D→C** | surfaces refuse overpay (correct); "keep credit" only via `other` payment = revenue with no obligation (fabrication) |
| **Institute-funded scholarship granted MID-term** (earned waiver) | **D→C** | discount immutable post-creation; only fake refund or `other` payment — a donor-free price forgiveness event has no surface |
| Prepayment for a future term | A | enroll-then-pay; revenue at payment = declared cash basis |

## 2. Third-party payers (parents, sponsors abroad, NGOs, employers)

| Event | Verdict | Notes |
|---|---|---|
| Parent pays on student's behalf | A | receivable is the student's; payer identity on receipt |
| **Hawala / bank remittance from abroad pays tuition** | A | `bank_transfer` method; **hawala fee** = expense via workflow (Bank & Payment Processing Fees) |
| **NGO / company contract: one payer, 20 seats, one invoice** | **B** | only per-student payments exist; organizational billing unrepresentable — 20 split payments or an `other` payment that settles nothing |
| Employer reimburses employee (outside ERP) | E | outside both systems; cash arrives as ordinary payment |

## 3. Teachers & employees

| Event | Verdict | Notes |
|---|---|---|
| Monthly salary (Shamsi period) | A | due-capped, idempotent, envelope-guarded |
| Salary advance + recovery | A | receivable classification + due-cap counts advances |
| Payroll void (wrong amount) | A | BEGIN IMMEDIATE + contra row + envelope credit |
| Retroactive raise → backpay | A | raising base re-opens remainingDue of the period |
| **Teacher performance bonus** | A | computed INTO due by the rule engine (class-payroll) |
| **Employee bonus (Eid, performance)** | **D→B** | employee due-cap = base salary only; a bonus is only payable as a detached Staff-Benefits expense — economically correct cost, but the employee's compensation record is severed; raising base temporarily instead falsifies contract history |
| **Permanent salary deduction** (disciplinary fine) | **F** | no surface reduces an employee's due; the debt stays "payable" forever |
| **Termination with uncollectible advance** | **F** | advance > final salary leaves a phantom staff receivable with no write-off (same family as W7-2) |
| Wage/tax withholding | E | gross pay + tax paid later as Tax Clearance expense — declared cash basis |

## 4. Suppliers & publishers

| Event | Verdict | Notes |
|---|---|---|
| Order placed (commitment) | E | no PO concept; cash basis defers until money/goods move — acceptable |
| Goods received + paid now | A | W6-1 atomic purchase (guarded debit + `book_purchase`) |
| Goods received FREE (donation/internal) | A | `not-applicable` declaration |
| **Goods received on supplier credit, paid later** | **F** | `separate` declaration is an UNRECONCILED PROMISE: no supplier entity, no payable, no aging; inventory exists while the liability is invisible until (unless) an operator remembers a manual expense. Live population today: 0 rows — forward-looking |
| **Prepay supplier, goods arrive later** | B | expense now (cash basis), receipt later with `not-applicable`; no link between the two facts |
| **Supplier refund / rebate / defective return** | **D→C** | receipts are immutable, operational payments are positive-only → money back can only enter as `other` INCOME — fabricated revenue |
| Supplier fails to deliver after prepay | F | the prepayment is already an expense; the claim against the supplier is unrepresentable |

## 5. Facilities, assets & overhead

| Event | Verdict | Notes |
|---|---|---|
| Rent (Kabul: 6–12 months prepaid) | B | expense at payment (declared basis); no amortization → later months understate operating cost; period volatility is a reporting note, not a lost event |
| Utilities, internet, fuel, cleaning, security salary | A | expense workflow, canonical categories |
| **Capital purchase (projector, AC, computers)** | A | `capital_expenditure` classification — excluded from trading result, reported separately |
| **Asset register (what does the institute own?)** | **B** | capex is CLASSIFIED but not REGISTERED: no enumerable property list; disposal proceeds |
| **Selling/disposing an asset** | **D→C** | proceeds as `other` income = operating revenue fabrication |
| Depreciation | E | intentionally unmodelled; consistent with declared basis |

## 6. Money itself (bank, hawala, FX, cash management)

| Event | Verdict | Notes |
|---|---|---|
| Cash ↔ bank movement (same position) | E | one cash store per scope; payment methods per transaction permit bank reconciliation derivations |
| Bank/hawala fees | A | expense workflow |
| **Bank interest earned** | **C** | `other` income = OPERATING revenue by residual rule — non-operating income class does not exist |
| **Foreign-currency payment (USD-paying sponsor)** | E | AFN-only policy; desk converts — FX gain/loss invisible (policy, recorded) |
| **Daily cash count vs system** | **F-lite** | no cash-count surface to anchor the procedural control; sequential receipt numbers make gaps VISIBLE but nothing records the count |

## 7. Ownership & financing

| Event | Verdict | Notes |
|---|---|---|
| Owner capital injection | A | `capital_injection`, excluded from revenue |
| Owner profit drawing | A | `owner_drawing`, liquidity floor enforced |
| **Loan / external financing (borrow 500k for renovation)** | **D→C (material)** | only representable as capital_injection (in) + owner_drawing (repayment): DEBT BOOKED AS EQUITY — solvency invisible, equity overstated by the loan. No liability entity exists anywhere in the schema (proven). Whether any production capital_injection was actually a loan is owner knowledge — unverifiable from inside |
| **Repayment of principal + interest** | **D→C** | repayment = drawing (equity out), interest = `other` expense |
| Multi-partner capital accounts | E | single-owner model; would be F if partners exist |

## 8. Multi-branch / multi-campus

| Event | Verdict | Notes |
|---|---|---|
| Treasury funds branch B's envelope | A | charge = guarded org debit for ANY branch's line |
| **Branch A sends value to branch B** | **A (by design)** | return A→org + charge org→B: both primitives proven (W5 drills), conservation holds, fully traced — the hub IS the architecture, not a workaround |
| Direct cross-branch envelope transfer | G | policy: same-branch only — deliberately forces the audited hub path |
| Teacher working at two branches (cost split) | B | one branch bears the whole salary; cost attribution across branches unrepresentable |

## 9. Funds & restrictions

| Event | Verdict | Notes |
|---|---|---|
| Restricted donation (scholarship/sponsorship/campaign) | A | real subledger, triple-guarded allocations, award-return reversal |
| **Spending restricted cash on unrestricted purposes** | **F (conditional)** | restrictions are TRACKING-ONLY: no expense path consults them (proven); restricted cash pools with operating cash in one store. Fund accounting absent. Material IF donation-funded (live world: 0 donations today) |
| Scholarship settles tuition | A | aid allocation, no cash, no double income |

## 10. Losses, disputes & irregular events

| Event | Verdict | Notes |
|---|---|---|
| Inventory loss / found / count correction | A | W7-1 surface (this wave's predecessor) |
| Book sale refund / loan return | A | contra-income + stock restoration |
| Disputed payment (claims paid, no record) | E | outside any software; sequential receipts + audit trail make the gap visible |
| **Cashier pockets a fee (unrecorded cash)** | **honest limit** | no software prevents unrecorded cash; the ERP makes it DETECTABLE (receipt gaps, I16 conservation on everything recorded). Procedural control required |
| Goods received, never paid, supplier vanishes | F | liability never existed in the model (see §4) — windfall revenue-side is actually fine under cash basis; the loss was never booking the payable |
| Money received, nobody owes it | A | donation (donor record) or `other` (with the §6 caveat) |

---

## 11. What "cash basis" legitimately covers here — and what it cannot

**Legitimate (recognition timing):** revenue at payment; expense at payment;
inventory cost at acquisition; capex excluded from trading result; no
depreciation; no accrued withholding; prepaid rent as one expense. These are
DECLARED simplifications, consistently applied, and every one is visible in
the reporting taxonomy.

**NOT legitimate (lost economic truth), found in this wave:**
- obligations the system creates but never discharges (supplier `separate`
  promises; uncollectible student debt; uncollectible staff advances;
  undischargable employee deductions) — the receivable/payable METRICS lie
  even though cash truth is intact;
- debt as equity (loan via capital_injection) — a balance-sheet fact the
  basis choice cannot excuse;
- restricted cash fungibility — donor intent is tracked then ignored at
  spend time;
- non-operating income forced into operating revenue by the residual
  `category <> 'capital_injection'` rule.

## 12. Semantic collisions found (same cash direction, different meanings)

1. `income/other` = extra class fee (true revenue) = bank interest (financial
   income) = asset disposal (capital) = supplier rebate (contra-expense).
   One bucket, four economics. **The income side of the taxonomy needs the
   same treatment the expense side already has** (explicit classes, no
   residual).
2. `capital_injection` = owner equity = loan proceeds (if used as
   workaround).
3. Single cash pool = operating cash = restricted cash.
4. Staff-Benefits expense = welfare = bonus (detached from the compensation
   record).

## 13. Historical impact (live world, verified today)

- `separate` purchase promises: **0** · donations/restrictions: **0** ·
  capex budget lines: **0** · `other` income rows: 4 (all genuine extra-class
  fees) · outstanding staff advances: 700 (recoverable in-period).
- **No existing row is economically damaged by any wave-8 finding.** All are
  forward-looking capability gaps. The single unverifiable-from-inside class:
  whether any FUTURE production capital injection is actually a loan —
  owner knowledge, flagged in §7.

## 14. The ten-point architectural judgment

1. **Economically complete?** No — four material gaps: supplier payables,
   write-offs (student debt + staff advances + employee deductions),
   restricted-fund segregation, external debt.
2. **Were the 31 wave-7 classes complete?** No — this reconstruction
   surfaced ≥8 families outside them (supplier credit/rebates, loans,
   employee bonus/deduction, asset register/disposal, non-operating income,
   overpayment credit, mid-term waivers, organizational contracts).
3. **Invisible events:** supplier payables & rebates; debt; uncollectible
   advances; restricted-fund misuse; non-operating income inside `other`.
4. **Incorrect abstractions:** the income residual rule (one bucket, four
   economics); equity surfaces doubling as debt; positive-only expense
   surface (no contra path for rebates).
5. **Bypass:** unrecorded physical cash is beyond any software — the ERP
   makes it detectable (sequential receipts, conservation over everything
   recorded) but there is no cash-count surface to anchor the daily
   reconciliation procedure.
6. **Collapsed concepts:** listed in §12.
7. **Missing entirely:** payables ledger; write-off surfaces; asset
   register; fund accounting; non-operating income classes; overpayment
   credit.
8. **Cash basis defensible?** Yes for timing, no as an excuse — §11 draws
   the line precisely.
9. **Fundamentally sound?** The spine is sound and extensible (single
   guarded ledger, immutable facts, identity-linked obligations, paired
   document/ledger writes). The gaps are missing subdomains plus ONE
   core-level correction: the income taxonomy.
10. **Redesign rather than patch:** (a) income taxonomy — explicit
    non-operating/non-revenue classes, kill the residual (structural, next);
    (b) payables subledger reconciling `separate` promises (needs supplier
    policy); (c) write-off surfaces (need owner policy: who may forgive,
    notification, metric effects); (d) liability/loan subdomain (needs owner
    policy: terms, authorization); (e) restricted-fund exposure reporting at
    minimum, fund accounting if donations grow; (f) asset register
    (operational). Per the repo's no-invented-policy discipline, (b)–(d)
    require owner decisions before implementation; each is documented here
    with its exact economic consequence.

**Ultimate test.** Tomorrow's realistic transactions: tuition in cash ✓;
hawala-sponsored tuition ✓; Eid bonus for the clerk — only by detaching it
from her payroll record; publisher delivers 200 books on 30-day credit —
inventory yes, liability no; owner's friend lends 500k — booked as the
owner's own capital; projector sold — "revenue"; student gives up owing
9,000 — still owed, forever, on every report. The ERP can represent the
cash of every one of these, explain and reverse the ones it represents, and
reconcile everything it records — but for five of them it cannot tell the
economic truth, and that is now written down.
