# Forensic Audit — Wave 12 Verdict
## The Three Authorized Capabilities: Income Taxonomy · Restricted-Fund Exposure · Employee Bonus → Payroll

**Verdict: PASS** (with the historical-impact and policy boundaries stated precisely below)

Wave 12 took complete ownership of the three capabilities authorized at the Wave 9 gate, implemented them from economic semantics first, and attacked every new invariant adversarially. The full suite is green — **220 test files, 2,958 passed, 2 skipped** (pre-existing UI-layout skips, `wp05/program-versions-panel-layout.test.ts`) — and `tsc --noEmit` is clean. Four adversarial suites were written against the implemented world, run, and iterated until honest; they found and forced the repair of **three real defects in the Wave-12 implementation itself** (§7), which is exactly what they are for. A green suite is evidence, not proof; the sections below state what is proven, what is derived independently, and what remains policy-gated.

---

## 1. Scope discipline (held)

Implemented and verified — the three authorized capabilities plus the seams between them. **Not** touched, per the standing scope rules: payables/loans/write-offs, P16 cross-period recovery, P11 restricted-spending *enforcement*, P13 finance income, retroactive bonus policy. Where a decision was not authorized, the code refuses conservatively and this report says **POLICY REQUIRED** rather than choosing.

## 2. Capability 1 — Income taxonomy (no more "everything else is operating income")

### 2.1 Economic classes (from writers, not for completeness)

`CANONICAL_INCOME_CATEGORIES` (server/src/core/finance/category-taxonomy.ts) is the single authority. Each class carries an explicit accounting treatment (`classification` + `inOperatingResult`):

| class | treatment | in operating result | writers |
|---|---|---|---|
| `fee` | operating_revenue | yes | tuition (enroll-semester, payments, invoices) |
| `installment` | operating_revenue | yes | installment-plan settlements |
| `chapter` / `exam` / `diploma` / `card` / `placement` | operating_revenue | yes | desk/auxiliary charges |
| `other` | operating_revenue | yes | reason-REQUIRED ad-hoc educational charge |
| `book` | operating_revenue | yes | book sales |
| `donation` | funding_income | yes, own funding line | registerDonation (restricted-ness is a *fact* in `donation_restrictions`, never re-encoded in the string) |
| `refund` | contra_revenue | yes (negative) | students refund route |
| `capital_injection` | equity_contribution | **no** | treasury deposit |
| `non_operating_other` | non_operating_inflow | **no** | **no writer today** (declared so the residual direction stays conservative; P13 holds finance income) |

### 2.2 The boundary

- **Write boundary**: `assertCanonicalIncomeCategory()` runs inside `recordIncome()`'s caller transaction; `POST /finance/treasury/deposit` (the one writer that bypasses `recordIncome`) asserts the same canonical class. An undeclared inflow **cannot be written**.
- **Report boundary**: `operatingIncomeSql` = `type='income' AND category IN (<declared operating classes>)` — **generated from the taxonomy**, never hand-maintained; unknown categories match NOTHING, so a rogue row (legacy, hand-rolled SQL, future bug) can never become revenue by accident.
- **Drift detection**: **I20** (`invariant-checker`) flags any income row whose category is not canonical, by branch and category. Verified live: a rogue insert is excluded from the P&L, named by I20, and the checker clears after cleanup.
- **Conservation**: **I21** verifies restricted-fund conservation (see §3).
- **One authority, four surfaces**: `/finance/dashboard`, `/finance/pnl`, the report catalog, and the in-memory helpers all derive from the same generated predicates; the suite proves route == SQL == in-memory triple agreement.
- **Cash ≠ trading**: reconciliation now uses a *separate* `branchCashIncomeSql` predicate (every non-equity income row credits branch cash, canonical or not) — see defect D3 in §7. Without it, narrowing the operating boundary would have blinded phantom-cash detection.

### 2.3 Attacks performed (suite: `wave12-income-taxonomy.test.ts`, 14 tests)

Vocabulary freeze (exact writer inventory + treatments); unknown/empty/case-variant/cross-side categories rejected with zero rows written; rogue direct-insert row excluded from P&L + flagged by I20 + checker clean after cleanup; capital injection credits treasury but never trading results; `non_operating_other` reportable but non-operating and not drift-flagged; every production writer lands in its declared class; **refund preserves the original classification as contra-revenue** (original row untouched, negative `refund` row reduces operating income exactly once); ad-hoc `other` keeps reason and class; donation restricted vs unrestricted both on the `donation` line; P&L == SQL == in-memory; duplicate payment refused without double-count; full checker green.

**Independent derivation**: the P&L is cross-checked against an in-memory walk that classifies raw `financial_transactions` rows through the taxonomy map — never the same SQL that generated the report.

## 3. Capability 2 — Restricted-fund exposure report (view of the subledger, no shadow system)

`server/src/core/funding/restricted-exposure.ts` — `getRestrictedExposure(db, branchId | null)`; HTTP: `GET /api/funding/restricted-exposure` (`Funding.View`). Every figure's authority is documented in the module header and derived from existing tables only:

- `restrictedReceived` = Σ donations ⋈ donation_restrictions (the restriction FACT)
- `restrictedSettled` = Σ `obligation_allocations` `status='active'`, source_kind ∈ {scholarship, sponsorship}
- `restrictedRemaining` = received − settled
- `storesHeld` = the same store-conservation authority as I16 (finance_accounts main+saving + budget_lines.current; branch-scoped or organization-wide)
- `unrestrictedHeld` = max(0, held − remaining); `restrictedExposure` = max(0, remaining − held)
- Memos (never cash): `activeAwardCommitments` (committed, unconsumed scholarship awards), `sponsorshipPromisedMonthly` (Σ monthly_amount of active agreements — duration deliberately NOT invented), `sponsorshipReturnedToCampaign` (shown, deliberately NOT netted out of received)

Semantics proven by attack (suite: `wave12-restricted-exposure.test.ts`, 13 tests):

1. **Internal transfers ≠ consumption**: treasury deposits and budget charges move `storesHeld` 1:1 and never move the pool.
2. **Reversals restore exposure without rewriting history**: reversing an allocation decrements settled, restores remaining; the row keeps `status='reversed'`, `reversed_at`, `reversal_reason`.
3. **Status ≠ economics**: closing an award, terminalizing a sponsorship (returned remainders stay INSIDE the restricted pool, visible as returns-to-campaign) change no number.
4. **Operating spending shows as exposure** when it consumes donor cash (teacher salary from an envelope drops `storesHeld`; exposure = remaining − held when stores under-cover).
5. **Duplicates idempotent**: donation replay (`Idempotency-Key`) returns the original receipt and changes nothing.
6. **Independent derivation**: a per-donation provenance walk (different algorithm — follows every chain donation → campaign entries → fundings/receipts → returns, counts only active allocations) reproduces received/settled/remaining exactly.
7. **I21 tamper probe**: erasing a restriction row (fabricated leakage) fires I21; the immutable-delete trigger blocks the honest path, and restoring the row clears the checker. I21's SQL is thereby schema-verified by execution.
8. HTTP surface == core derivation; full checker green.

**NO enforcement**: the report never blocks spending (P11). It makes the donors' money position *visible*; whether consumption beyond remaining is allowed is policy.

## 4. Capability 3 — Employee bonus → payroll (competing-path repair)

**The defect (W9 §10.7)**: rules could compute a bonus into an employee's due, but `POST /employees/:id/pay-salary` capped payments at the base salary — the bonus was computable but unpayable, and the known workaround was falsifying base-salary raises.

**Determination (policy vs artifact)**: the base-salary cap was an **implementation artifact**. Nothing in the rules architecture, the catalog, or the payroll ledger authorizes a base-only cap; the rule engine's `employeeBonus` output key is read exactly as the teacher path reads `performanceMultiplier`. The repair composes the cap; it invents no eligibility, percentage, approval, maximum, category or retro policy — those remain rule-configuration questions (POLICY REQUIRED to set values; the mechanism honors whatever an authorized `payroll` rule computes).

Implementation: `computeEmployeeDueAmount()` (server/src/core/payroll/employee-payroll.ts) — `evaluateRules({category:'payroll', dryRun:true})`, output key `employeeBonus`; negative → `PayrollRuleConfigurationError` (W9 block F: deductions unauthorized); fractional → refuse (whole-AFN payroll); non-numeric → refuse. Called **inside the pay-salary write lock**, so a concurrent rule change cannot make the cap and the ledger row disagree. `employee_salary_ledger.due_amount` (new column, default 0, migration wired in `initSchema`) stores the composed due at payment time; the fact trigger guards `paid ≤ due` (non-advance) and `paid = due` (full); the immutable-update trigger pins it. `GET /employees/:id/salary-status` previews due/base/bonus/paid/remaining/canPayFull from the same function — the two surfaces cannot disagree. Payment response and notification name the bonus explicitly.

Semantics proven by attack (suite: `wave12-employee-bonus.test.ts`, 11 tests): preview == enforced cap == the rule engine's own dry-run output; role-keyed identity (another role earns nothing); partial → remainder → over-cap refused → "nothing remains" refused; **no mix of advance + salary extracts more than the composed due** (advance consumes the month's capacity); void restores payable AND budget, bonus payable again, double-void refused, exactly one live posted payment; budget exhaustion refuses the whole payment (no ledger row, no partial spend); month boundary independent; idempotent replay pays once; malformed rules (fractional/negative) refuse the whole calculation with 409, deactivation returns to base-only; **salary payments write no rule_evaluation_logs** (dry-run parity with the teacher path — verified: `class-payroll.ts:287` also uses `dryRun:true`, closing the open cross-check); full checker green.

**I7 re-aligned** (see D2 below): the "posted ≤ base" invariant contradicted the authorized composed cap; it now follows the ledger's own `due_amount` authority with the current base as the legacy backstop.

## 5. Cross-domain attacks (suite: `wave12-cross-domain.test.ts`, 7 tests)

One world, all three capabilities: refund of a tuition payment coexisting with scholarship aid (income nets by exactly the refund, aid and exposure untouched — aid is not the student's money to refund); reversal of aid restores exposure **without restating income** (donation line unchanged, P&L unchanged); one capital injection → three consistent views (not income on P&L, invisible to the restricted pool, 1:1 in organization stores, I13 green); bonus payroll → treasury → P&L (paying salaries creates no income; the bonus rides the salary expense line); **Jalali year boundary** 1405-12 → 1406-01 keeps periods independent under the composed cap, and `month`/`monthName` aliases agree or 400; the full checker green across every domain at once. Independent P&L derivation (raw-ledger walk) agrees with the route to the afghani.

## 6. Historical impact separation (no rewriting to look clean)

| bucket | content |
|---|---|
| **Corruption (repair authorized)** | None found in the income ledger writers; the F-10-era hand-rolled contra-row pattern remains *detectable* (reconciliation + I20) and is now unwritable through production surfaces. |
| **Valid-old** | Pre-W12 income rows categorized outside the new vocabulary: `book_refund`, `'book sale'`, `profit_distribution`-style misapplied strings. They remain readable; the operating boundary **excludes** them conservatively (never silently revenue) and I20 names them for triage. NOT rewritten — triage of live-data categories is an operator decision. |
| **Valid-old (payroll)** | `employee_salary_ledger.due_amount = 0` history: the then-current base bounded those payments and is not recoverable; the column stays 0 and I7 falls back to current base. No due is fabricated backwards. |
| **Policy needed** | (a) Actual `employeeBonus` values/eligibility — mechanism ready, values are rule configuration; (b) P11 restricted-spending enforcement; (c) P13 non-operating/finance income authorization; (d) P16 cross-period recovery. |
| **Theoretical** | Rogue non-canonical income row + reconciliation: cash-visible (correct) and I20-flagged (correct); a row that is BOTH canonical and phantom remains a reconciliation matter (unchanged). |
| **Clean** | All production writers post-boundary; treasury deposit; restricted donation machinery; composed-due payroll; every surface the four suites exercise. |

## 7. Defects found by the adversarial layer during Wave 12 (all repaired, all regression-tested)

- **D1 — employee routes leaked `PayrollRuleConfigurationError` as 500.** `salary-status` and `pay-salary` did not translate the error (the teacher path did, → 409). Found by the malformed-rule attack. Fixed with `computeEmployeePayroll()` wrapper (teachers.routes.ts), teacher-parity message.
- **D2 — I7 contradicted the authorized cap.** "Posted salary for a period never exceeds the period's *base*" fired on every legitimate bonus payment. The invariant now follows the composed-due authority (`MAX(due_amount)`, base as legacy backstop). A wrong invariant is as dangerous as a missing one — it would have forced operators to disable either the bonus or the checker.
- **D3 — narrowing the operating boundary blinded phantom-cash detection.** `computeReconciliation` used the operating-income predicate as its *cash* predicate; with the narrower taxonomy a rogue contra row no longer affected expected cash (the F-10 phantom became undetectable again — proven by the failing pre-existing test). Fixed with a dedicated `branchCashIncomeSql` (all income except equity contributions; unknown categories match IN, because an unrecognized inflow still moved — or failed to move — real money; I20 handles the classification side).
- Also fixed: a type-guard bug in `isEquityTransfer` (an *expense* row carrying `capital_injection` classified as equity in JS but not SQL — caught by the SQL/JS agreement test).

## 8. Files changed

**New**: `core/finance`→`core/funding/restricted-exposure.ts`; `core/payroll/employee-payroll.ts`; tests `wave12-income-taxonomy` (14), `wave12-restricted-exposure` (13), `wave12-employee-bonus` (11), `wave12-cross-domain` (7).
**Modified**: `category-taxonomy.ts` (income classes), `ledger-classification.ts` (generated predicates, `classifyIncomeRow`, type-guarded `isEquityTransfer`, `branchCashIncomeSql`), `income.ts` (canonical assert), `invariant-checker.ts` (I7 re-aligned, I20, I21), `finance.routes.ts` (deposit guard), `funding.routes.ts` (`GET /restricted-exposure`), `teachers.routes.ts` (composed-due cap in lock, salary-status, 409 parity), `schema.sql` + `connection.ts` (`due_amount` + triggers + migration), `reconciliation.ts` (cash predicate), and four pre-existing suites updated to the declared boundary with the change reason in comments (`book_sale`→`book`, `book_refund`→canonical-where-recordIncome, rogue-category probes kept deliberately).

## 9. Verification summary

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **220 files / 2,958 passed / 2 skipped** (pre-existing UI skips). Prior Wave-11 layers (state-layer repair, cash invariants, payroll idempotency) all green in the same run; migration smoke on live-shape `data/erp.sqlite` converged with the new column and triggers.

## 10. Limitations (honest)

- Adversarial suites build worlds through production surfaces, but concurrency is exercised via the DB's conditional-debit backstops and unique indexes, not true parallel clients.
- `sponsorshipPromisedMonthly` cannot become a total commitment figure until agreement duration semantics are policy; the report shows the monthly number and refuses to invent the horizon.
- Legacy category triage (bucket "valid-old") is reported, not executed — it needs live-data decisions.
- The exposure report answers "where the donors' money stands", not "may it be spent" (P11).

## 11. Next-wave gate

1. **POLICY REQUIRED** items to resolve: employeeBonus values/eligibility/approval; P11 restricted enforcement; P13 finance income; P16 cross-period recovery.
2. Live-data I20 triage: enumerate non-canonical income categories in production and decide reclassification (report-only; no rewriting).
3. Optional: operator-facing exposure UI on top of `GET /api/funding/restricted-exposure` (data contract is stable).
4. Keep the freeze tests as the tripwire: any new income class must land in `category-taxonomy.ts` with a treatment, or the suites fail by design.
