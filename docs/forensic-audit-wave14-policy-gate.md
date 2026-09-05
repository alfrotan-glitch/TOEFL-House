# Forensic Audit — Wave 14 Verdict
## Financial Gap Prioritization & Policy Gate

**Verdict: CONDITIONAL PASS** — architecture is safe and no in-scope behavior is corrupting, but specific named owner decisions must be resolved before the corresponding capabilities may be implemented. The decisions, their exact questions, and the dependency graph are below. Nothing was implemented this wave; the repository carries **no product/financial behavior change** (the only artifact is this report).

Verification state establishing that: `tsc --noEmit` exit 0; full suite exit 0 (**220 files / 2,958 passed / 2 skipped**, identical to the Wave-12/13 close); the Wave-13 commit `0650dc4` re-audited as **exactly one product line** (the I7 `detail` label) with its SQL and tests coherent (§2); all probes run against **copies** of live-shape data in `/tmp` — the live database untouched.

---

## 1. Method

Every Wave-13 finding was independently re-verified against the tree (not against the Wave-13 report): schema grep for each resource, route/service reads of every claimed writer, the full `finance_accounts` writer enumeration, the refund drain path, and a fresh execution of the complete invariant checker (I1–I21) against a copy of live-shape `data/erp.sqlite`. Each finding was then attacked **both ways**: an attempt to falsify materiality (is there a truthful representation or workaround I missed?) and to falsify harmlessness (can the absence silently corrupt something?). Findings below state which attack survived.

## 2. Audit of the Wave-13 repair

`git diff e1603e8..0650dc4` = 1 line in `invariant-checker.ts` (I7 `detail`) + the report file. The label now matches the W12-aligned SQL directly beneath it (composed due with legacy base backstop). Checker suite, employee-payroll suite, and Wave-12 bonus suite re-run green at Wave-13 close and the full suite is green now — **no regression**. The invariant *behavior* was already correct in Wave 12; only the human label had lagged.

## 3. Priority investigation: physical cash count (first principles)

**The economic reality.** A drawer is counted; the count either matches the digital record or it does not; a signed variance is an economic event (value disappeared or appeared without any other event); someone is responsible; someone verifies; the record must then reflect physical truth without destroying the history of what was believed.

**What the model holds today.** Branch cash (`finance_accounts.main_balance`) is moved by exactly four writer families, re-verified by enumeration: income via `recordIncome` (+), refunds via `recordIncome` negative (−, draining main then swept savings), the savings sweep (main→saving), owner drawings via `bos` (−, margin-capped). Savings is a **derived partition** — built only by the sweep, drained only by refunding swept income (verified: `decrementSavingBalanceIfSufficient` has exactly one caller path), fully reconstructable from `saving_transfer` rows and checked by I17. Reconciliation (`/finance/reconciliation`) is digital-vs-digital: payments ↔ ledger rows ↔ accounts. **No surface can represent "the drawer counted X, the record says Y."**

**Falsification of materiality (attempted).** Is there a truthful workaround? A shortage recorded as an owner drawing misattributes the loss to the owner and misstates distribution headroom (margin allowance consumed by theft). A shortage recorded as `refund` requires a real student payment to refund. An overage recorded as `other` operating income fabricates revenue (it is not a desk charge). An expense-request cannot reach branch cash at all (expenses draw from envelopes). **No truthful path exists — materiality confirmed.**

**Falsification of harmlessness (attempted).** Without a count surface, a physical shortage leaves `main_balance` permanently overstated; every derived figure that trusts the account (cash position, reconciliation health, exposure coverage via `storesHeld`) inherits the phantom money, and I16/I17 will happily certify it because the *digital* books agree with each other. Meanwhile the honest operators who try to true-up via drawings/`other` actively corrupt classification. **Harmlessness falsified — this is the one finding where reality can diverge from the record with no witness and the natural workarounds are economically false.**

**Minimum economic semantics that MUST exist if declared in-scope** (design deferred; this is the requirement boundary):

1. A **count session**: id, branch, store(s) in scope, counted-at (date/time), responsible operator, expected figure (derived from the accounting authority, never hand-entered), counted figure, signed variance.
2. A **variance event** with canonical classification (see gate D-CC-2), reason, and evidence reference — posted through the money path so the account moves with the event, not beside it.
3. **Idempotency** and one-live-session-per-store-per-period semantics.
4. **Recount/correction as supersession** — a new session that references and supersedes, never a rewrite (matches the system's append-only reversal philosophy).
5. **Authorization + SoD**: counter and approver distinct where policy requires (precedent: expense-request requester≠approver guard).
6. **Audit trail** (who counted, who approved, what changed) and **period effect** under the cash model (the variance is an event of the count period).
7. **Detection**: reconciliation must learn the count as a first-class input, or I16/I17 must be extended so an *approved* variance explains a main-balance delta and an *unapproved* divergence is flagged.

**Exact owner gates (POLICY REQUIRED — engineering must not guess):**

- **D-CC-1** — Which stores are countable physical cash? (Branch main only? Organization treasury main? Is "savings" a physical safe or a bookkeeping partition — its drain-on-refund semantics suggest a partition, but only the owner knows where the swept money physically sits.)
- **D-CC-2** — Variance treatment. A shortage is (a) an operating loss/expense, (b) a receivable against the responsible employee (recovery — interacts with the advance/loan receivable family, P15/P16), or (c) owner-absorbed. An overage is (a) operating revenue, (b) non-operating income (P13 adjacency), (c) a held liability until claimed, or (d) equity. Each answer changes the taxonomy and the P&L — this is the single decision the whole capability hangs on.
- **D-CC-3** — Tolerance thresholds: auto-accept vs mandatory recount/escalation.
- **D-CC-4** — SoD and who may approve a variance (role vocabulary exists; the assignment is policy).
- **D-CC-5** — Cadence and whether a period close requires a clean count.
- **D-CC-6** — Supersession semantics confirmation (recount replaces the variance explanation; history retained).

**Classification: B + D** (missing-but-necessary capability *behind* an explicit policy gate). Severity: **highest** of all findings — but the *absence* is honest (nothing false is recorded), so it does not fail the architecture; it gates the next capability wave.

## 4. The other nine findings (both-ways falsified)

**F2 · Asset custody lifecycle.** Re-verified: zero asset tables; capex purchase correctly classified (`cat_capital_expenditure`). Materiality attack: disposal proceeds or theft of an asset cannot be represented truthfully (proceeds would have to masquerade as `other` revenue; a theft has no event at all — but it also has no *recorded asset* to contradict, so nothing internally inconsistent is created). Workaround: purchase-time capex row + out-of-band register (paper). Truth preserved digitally, custody invisible. **Classification D** (policy: is an asset register in scope? what class do disposal proceeds/losses take?). Severity low-medium. Depends on: nothing; blocks nothing.

**F3 · Receivables aging.** Re-verified: no aging surface; the receivable authority exists and is derived (obligations⋈payments⋈allocations, I2/I18). Harmlessness attack: without aging the operator cannot *see* decay, but the books stay truthful (an uncollected obligation remains honestly open). Materiality attack: no policy is needed to report facts; this is pure observability. **Classification C** — the only finding implementable **today with zero owner decisions**. Severity medium (it is the decision support P16 needs). Reporting-only: yes.

**F4 · Cross-branch student transfer.** Re-verified: no `students.branch_id` mutation surface, while **staff** transfer exists with an append-only history table (`teacher_branch_history`) and no ledger rewrite — the precedent pattern. Materiality attack: unknown operational frequency (F→owner evidence); the workaround (keep the student at the old branch until obligations close) is ugly but financially truthful. Harmlessness attack: the temptation under pressure is out-of-band DB surgery, which breaks auditability — so the gap is real but the decision (does this happen? do balances follow the student while historical cash stays put?) is the owner's. **Classification F→B**. Severity medium. Depends on: D-XB (branch-sovereignty semantics — same question as inter-branch transfers below).

**F5 · Donation refund / grant clawback.** Re-verified: donation rows immutable in practice (no UPDATE/DELETE writer; triggers guard integrity); refund route is student-payment-scoped; the restricted pool has no exit except allocation. Materiality: **historically zero exposure** (0 donations in live data) but NGO-funded Kabul institutes face clawbacks. Harmlessness attack: if it ever happens today, restricted remaining AND cash both overstate, and I21 (conservation) would *block* a naive partial fix — the semantics must be designed, not improvised. **Classification D**. Gates: **D-DC-1** are clawbacks authorized at all; **D-DC-2** reduction of `received` vs a `returned` bucket (precedent: sponsorship returns stay in-campaign — a clawback leaves entirely); **D-DC-3** unallocated-first ordering; **D-DC-4** authorization level. Severity medium-high (conditional on D-DC-1).

**F6 · Return of capital.** Re-verified: `bos` withdrawal is margin-allowance-capped (profit only); no capital-return path. The block is **conservative** — it prevents over-distribution, it cannot corrupt. **Classification D/E**. Gate: **D-RC-1** is return of capital permitted outside dissolution; **D-RC-2** what authorization and floor (net-assets) would replace the margin cap. Severity low.

**F7 · FX / multi-currency.** Re-verified: whole-AFN triggers; `currency` exists only on fee tables; `financial_transactions` has no currency; live data shows zero USD hints and 100% cash payments. Materiality is entirely an **owner-evidence** question (do they take USD?). If yes at any volume, today's truthful option is "AFN equivalent + rate in the description" — rate unauditable, acceptable only as an interim convention. Full multi-currency would touch every money column: **architecture-gating**, must be decided *before* any FX work, not during. **Classification F→D**. Gates: **D-FX-1** does USD (or other) acceptance exist; **D-FX-2** memo-level vs full multi-currency; **D-FX-3** FX gain/loss class (P13 adjacency). Severity: unknown until D-FX-1.

**F8 · Bank statement matching.** Re-verified: saving store + `bank_transfer` method exist; no statement import/matching; bank-fee expense node exists but fee recording does not touch the saving store. Harmlessness attack: digital saving balance can drift from the real bank (fees, direct deposits) with no witness — same *class* of risk as cash count but against a bank statement rather than a drawer, and materially smaller in a cash-dominant operation. **Classification C+D** (matching surface is observability; fee/interest treatments touch policy/P13). Severity low-medium. Depends on: D-CC-1 answer (is saving physical or banked?) and P13.

**F9 · Third-party payer attribution.** Re-verified: `payments` carries `student_id` only; economic ownership is the student (correct); guardians are attribution detail. **Classification C (minor)/E**. Severity low. No gate — schema nicety whenever convenient.

**F10 · Purchase returns to suppliers.** Re-verified: zero supplier surfaces; stock-down via `correction` mislabels the event (quantity truth approximate, money-back absent). Entirely a subset of the payables policy. **Classification D via payables gate**. Severity: low until payables exist at all.

## 5. Carried register re-evaluation (P11–P16 + withholding)

| id | question (neutral, for the owner) | status | blocks |
|---|---|---|---|
| **P11** | Restricted-fund enforcement level: (a) report-only forever (today), (b) allocation guards only (already exist), (c) cash-level segregation of restricted money? | OPEN | exposure alerts/thresholds; nothing else |
| **P12** | Does the institute borrow (owner loans, hawala credit, bank facility)? | OPEN | liability classes, solvency reporting |
| **P13** | If borrowing: forms; is conventional interest excluded (Islamic practice)? Also: are finance income/expense classes authorized at all? | OPEN | non_operating_other writers; F8 fee/interest; F7 FX gain/loss |
| **P14** | Who may bind the institute to a liability? | OPEN | any payables/loans capability |
| **P15** | Employee loans beyond earned-pay advances? | OPEN | receivable family; interacts with D-CC-2(b) shortage recovery |
| **P16** | Staff-advance recovery window; doubtful/discharge states for student debt; who authorizes a write-off? | OPEN | write-off capability; **fed by F3 aging** |
| **WH** (new to register) | Does the institute withhold wage tax/social contributions from pay? If yes: liability class, remittance event, payslip semantics. | OPEN (**owner evidence first**) | payroll liability representation |
| **D-XB** (new) | Are branches sovereign accounting entities or one treasury? Do students physically relocate between branches? | OPEN | F4 cross-branch transfer; any inter-branch cash movement |

## 6. Priority matrix

| # | Finding | Real event/state | Current repr. | Economic risk | Detectable today? | Hist. impact | Workaround (truthful?) | Class | Severity | Depends on | Policy? | Arch.? | Report-only? | Wave priority | Exact gate before implementation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Cash count / drawer variance | physical↔digital cash divergence | none | phantom/missing cash certified healthy; workarounds corrupt classification | **no** | none found (all-cash org, checker green) | none truthful | **B+D** | **critical** | D-CC-1..6 | **YES** | moderate (new event class + taxonomy + reconciliation extension) | no | W15+ | D-CC-1, D-CC-2, D-CC-4 minimum |
| 2 | Receivables aging | time decay of open obligations | facts exist, no view | none (observability) | n/a | none | manual SQL | **C** | medium | nothing | no | no | **yes** | **W15** | none — safe now |
| 3 | P16 write-off/doubtful | owed→doubtful→discharged→recovered | owed forever (honest) | overstatement of collectables | no | none | keep-open (truthful) | **D** | medium-high | aging (F3) | **YES** | no | no | W16+ | P16 decision |
| 4 | Donation clawback | restricted money exits | none | received+cash overstate; I21 blocks naive fix | no | **zero** (0 donations live) | none | **D** | medium-high (conditional) | D-DC-1..4 | **YES** | moderate | no | W16+ | D-DC-1 first |
| 5 | Payroll withholding | statutory net pay | gross only | legal-compliance misstatement | no | none found | none | **F→D** | unknown→(if yes) high | owner evidence D-WH | **YES** | moderate (liability classes) | no | W16+ | D-WH-1 evidence, then policy |
| 6 | Cross-branch student transfer | student+balance relocate | staff yes, students no | out-of-band surgery temptation | n/a | none (0 teacher moves too) | keep-at-old-branch (truthful) | **F→B** | medium | D-XB | **YES** | no | no | W16+ | D-XB evidence + semantics |
| 7 | FX / multi-currency | USD receipts/payments | AFN only | rate unauditable; full FX touches everything | no | none found (0 hints) | AFN-equivalent + description note (weak) | **F→D** | unknown | D-FX-1 | **YES** | **YES (if full)** | no | HOLD | D-FX-1 evidence; D-FX-2 before any build |
| 8 | Bank statement matching | banked money vs statement | store yes, matching no | silent drift (fees) | no | none found | manual statement review (truthful) | **C+D** | low-medium | D-CC-1, P13 | partial | no | partly | W17+ | D-CC-1; P13 for fee/interest |
| 9 | Payer attribution | guardian/third-party pays | student-scoped | attribution only | n/a | n/a | notes | **C/E** | low | nothing | no | no | mostly | opportunistic | none |
| 10 | Asset custody | disposal/theft/transfer of durables | purchase-time capex only | proceeds/losses unrepresentable | no | none | paper register | **D** | low-medium | policy on register scope | **YES** | moderate if register | no | W17+ | owner declares register scope + disposal/loss classes |
| 11 | Return of capital | owner withdraws contributions | blocked (margin cap) | none (conservative) | n/a | none | wait (truthful) | **D/E** | low | D-RC | **YES** | no | no | HOLD | D-RC-1/2 |
| 12 | Purchase returns / payables | credit purchasing lifecycle | none | out-of-band obligations | no | none | cash-only purchasing (truthful) | **D** | low until payables decided | P14 + payables policy | **YES** | significant | no | HOLD | payables policy (Wave-8 register) |
| 13 | P11 enforcement | restricted spending constraint | report-only | donor-trust, not data | yes (report) | n/a | report | **E/G** | low | P11 | **YES** | no | n/a | HOLD | P11 level choice |

## 7. Classification ledger (strict separation)

- **A. Confirmed defect**: none open. (D-W13-1, the I7 label, was found and fixed in Wave 13; re-audited clean.)
- **B. Missing but necessary capability**: physical cash count (pending its policy); cross-branch student transfer (pending evidence).
- **C. Reporting/observability enhancement**: receivables aging (W15); bank-activity statement view (W15, optional); payer attribution (opportunistic).
- **D. Policy-required capability**: write-off states (P16); donation clawback; withholding (pending evidence); asset register/disposal; FX (pending evidence); return of capital; purchase returns/payables.
- **E. Intentional scope limitation**: no accrual; no depreciation; gross payroll (until WH); P11 report-only (until chosen otherwise); savings as derived partition.
- **F. Open question requiring owner evidence**: does USD acceptance occur (D-FX-1); do cross-branch relocations occur (D-XB); does withholding apply (D-WH-1).

## 8. Dependency graph

```
D-CC-1 (count scope) ──┬─> cash-count capability (B) ──> reconciliation/count invariant
D-CC-2 (variance class)┘        │
        │                       └─(if shortage=receivable)─> P15/P16 receivable family
P13 ──> D-CC-2 option (b/c) overage class; bank fees/interest (F8); FX gain/loss (F7)
F3 aging (no gate) ──> P16 decision ──> write-off capability ──> re-enrollment (P10, already derived)
D-DC-1 ──> D-DC-2/3/4 ──> donation clawback capability ──> exposure report extension
D-FX-1 ──> D-FX-2 ──┬─> memo-level FX (small)
                    └─> full multi-currency (architecture wave; touches every money column)
D-XB (branch sovereignty) ──┬─> cross-branch student transfer (F4)
                            └─> any inter-branch cash transfer capability
P14 + payables policy ──> supplier obligations ──> purchase returns (F10)
D-WH-1 ──> withholding policy ──> payroll liability classes
(owner evidence, no build) : D-FX-1, D-XB, D-WH-1  ← can be answered in one owner conversation
```

**Blocked work, named**: cash-count build ← D-CC-1/2/4; write-off build ← P16 ← (informed by) aging; clawback build ← D-DC-1; any liability build ← P12/P14; withholding build ← D-WH-1; FX build ← D-FX-1/2 (and full FX is itself architecture-gating); cross-branch builds ← D-XB; payables/returns ← payables policy. **Nothing else is blocked.**

## 9. Historical truth

Checked (read-only, on a copy): full I1–I21 checker → **zero failures**; income/expense categories all canonical; no negative balances; no orphan audit failures; the single book adjustment is a labeled Wave-7 verification artifact; zero donation history (clawback exposure zero); zero teacher moves; zero FX hints; zero future-dated transactions. **Quantified historical impact of every open finding: none found.** Unknowable from data alone: whether USD cash was ever accepted off-book (no digital trace can prove a negative), and whether physical drawers have historically matched `main_balance` (no count records exist to compare — the gap itself).

## 10. The four questions, answered unambiguously

1. **What is genuinely dangerous right now?** One thing: physical cash divergence is unrepresentable and unwitnessed (F1). It cannot corrupt the books by itself, but it lets phantom (or missing) cash sit inside certified-healthy figures, and its natural workarounds (drawing/`other`-income true-ups) are economically false. Everything else is an honest absence.
2. **What must the owner decide before engineering can proceed?** D-CC-1..6 (cash count), D-DC-1..4 (clawback), P16 (write-off), D-WH-1 (withholding evidence), D-FX-1/2 (FX), D-XB (branch sovereignty/relocation), P11 level, P12–P15 (unchanged), D-RC (return of capital). Three of these (D-FX-1, D-XB, D-WH-1) are *evidence* questions answerable in one owner conversation.
3. **What can safely wait?** Bank statement matching, payer attribution, asset register, return of capital, payables/purchase returns, P11 enforcement — all behind their gates, all with truthful interim postures (cash-only purchasing, keep-open obligations, conservative withdrawal cap).
4. **Exact Wave 15 scope** — see §11.

## 11. Wave 15 goal (defined, not started)

**Wave 15 — "Observability for owner decisions" (reporting-only, zero policy, zero behavior change):**
1. **Receivables aging report** (route + derivation): per open obligation — amount, outstanding, branch, student, Jalali period age buckets (current / 1–3 / 4–6 / 7–12 / 12+ months), source facts from the existing obligation/payment/allocation authorities only; independent-derivation tests; no new writes, no new policy.
2. **Daily cash-activity statement** per branch (read-only): opening main+saving, income by class, refunds, drawings, sweep — the exact figures a count session would be compared against, exposing what D-CC-1 needs to discuss.
3. Explicitly **excluded**: any count/adjustment surface, any aging→status automation, any schema change beyond indexes.

This is the only scope that needs no gate, directly feeds the two highest-value decisions (D-CC and P16), and cannot alter financial behavior.

## 12. Verdict

**CONDITIONAL PASS.** Evidence-based: the architecture is internally safe (all invariants hold on live-shape data; full suite and tsc green; every represented event remains truthful, lifecycle-complete and defense-covered), so nothing demands redesign and no FAIL condition exists. But the capability frontier — starting with physical cash control — is gated by named, unresolved owner decisions (§10.2), and implementing any of them before those decisions would mean inventing business policy, which this project's protocol forbids. The conditions are exactly the D-CC/D-DC/D-FX/D-XB/D-WH/P-register items; Wave 15 executes the ungated remainder.
