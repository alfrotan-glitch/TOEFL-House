# Package 09 Checkpoint — Payroll

**Package:** 09 — Payroll (sequence row 8: periods, calculations, approvals, settlement)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 08 checkpoint (`30-package-07-hr-teachers-checkpoint.md`) at commit `5dc1111`

## Discover

- Governance inputs consumed: HR/payroll domain model (foundation 36 — Payroll Period "controlled closing", Payroll Calculation "recalculation audited", Payroll Result "correction/reversal, not overwrite", Payroll Adjustment "source-linked", HR/Finance Clearance "both clear before closure", Final Settlement "immutable approved result"), financial architecture contract (46 — no authoritative mutable balance; payroll view cannot post truth), financial/acquisition rules (BR-HR-002, G2-D-004 — contract-silent payroll treatment is HELD for HR and Finance review, nothing invented), authority registry (33 — payroll/compensation: reviewer HR+Finance, approver GM or Owners by risk; beneficiary self-approval forbidden), decision ledger (D-G3-003 — contractual entitlement, payroll calculation, payroll result, and actual payment remain distinct), concurrency contract (architecture 17 — payroll/period close: period lock and state check; closed-period immutability), HR/payroll architecture (implementation doc 11 — payroll snapshots effective contract/configuration and source work evidence; corrections append adjustment/reversal history).
- Actual payment posting is Finance's (later packages); this package stops at the approved payable result and the final settlement record.

## Map (implemented scope)

- **Payroll period** (`PayrollPeriod`): one window per unique key; `open→calculating→closed` — **closed is terminal and immutable** (DB trigger blocks UPDATE/DELETE; reopening impossible). **Closing is rejected while held (contract-silent) calculations remain** — they must be resolved by review, never skipped.
- **Payroll calculation** (`PayrollCalculation`): for one employment in one period — **snapshots** the active contract's effective compensation components (ids, kinds, rates/amounts) and the consumed recorded work-basis rows (ids, units, quantities, sources) into an immutable jsonb snapshot. Amount math is exact (bcmath): fixed/allowance contribute their amount; hourly/class-based contribute rate × quantity summed from work evidence. **One live calculation per (period, employment)** (partial unique index); **recalculation supersedes** the prior row (both retained); a **resulted** calculation is fixed history (trigger + state machine).
- **Contract-silent holding (BR-HR-002/G2-D-004)**: work evidence whose unit has no active covering component — or no active contract over the period — produces a **held** calculation with a held reason; **no charge or payment is invented**; held calculations **cannot be approved** (must be recalculated after HR/Finance resolution) and **block period closure**.
- **Payroll result** (`PayrollResult`): approved from a prepared calculation; **approval is segregated from preparation and from the beneficiary** (approver ≠ preparer; the employed person never approves their own payroll — capability `payroll.approve`). One result per calculation (unique index); the calculation becomes `resulted`; **results are immutable** (DB trigger) — corrections and reversals **append adjustments**.
- **Payroll adjustment** (`PayrollAdjustment`): kind ∈ {adjustment, reversal}, mandatory reason, **append-only** (DB trigger); reversal negates the amount and is allowed **once** per result; **any mutation of a result in a closed period is rejected** (`payroll.period_closed`).
- **Clearance & final settlement** (`PayrollClearance`, `FinalSettlement`): termination clearance recorded separately by **HR** (`payroll.clear_hr`) and **Finance** (`payroll.clear_finance`) — one per domain (unique index); the **final settlement requires a terminated employment, both clearances, and two distinct non-beneficiary actors** (prepare `payroll.settle`, approve `payroll.settle_approve`); the amount is **declared evidence with a mandatory basis** (the system never invents it); one settlement per employment; **immutable once recorded** (DB trigger).
- Capabilities: `payroll.period`, `payroll.calculate`, `payroll.approve`, `payroll.adjust`, `payroll.clear_hr`, `payroll.clear_finance`, `payroll.settle`, `payroll.settle_approve` — all separate.
- Persistence: 6 migrations (`2026_08_26_000051`–`000056`) owned solely by the Payroll module; CHECK constraints (period/calculation states, adjustment kinds, non-negative result/settlement amounts, period windows); unique/partial-unique indexes (period key, one live calculation per period+employment, one result per calculation, one clearance per domain); immutability triggers on `payroll_periods` (closed), `payroll_results`, `final_settlements`, and append-only triggers on `payroll_adjustments` and consumed/superseded calculations.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 245 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (233 tests, 901 assertions)** |
| integration tests | PASS | period/calculation/approval/adjustment/settlement chains against PostgreSQL atomically (7 feature tests + payroll lifecycle unit suite) |
| invariant tests | PASS | one period per key; one live calculation per period+employment; one result per calculation; one clearance per domain; one settlement per employment; results, settlements, closed periods, and adjustments immutable (raw SQL vs triggers); snapshot math exact (40000 + 250×40 = 50000; addendum → 52500) |
| authorization tests (SoD) | PASS | approver ≠ preparer; beneficiary self-approval denied (result and settlement); settlement prepare/approve distinct actors; unprivileged calculation denied with audit and no row |
| lifecycle tests | PASS | period open→closed terminal; calculation prepared→resulted/superseded; held→superseded only; unit matrix asserts closed-never-reopens and held-never-approved edges |
| payroll SoD/concurrency tests | PASS | period lock (row lock on close under held-count check); closed-period mutation rejected for new calculations and late adjustments; recalculation under the partial unique index supersedes exactly one live row |
| contract tests (boundary) | PASS | HR entities consumed read-only (contract, components, employment, work bases); no Finance persistence exists to touch — payment posting deliberately absent |
| financial tests | NOT APPLICABLE | Finance core is the next package; no balances or postings exist by design |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (payroll indexes; calculation-state and adjustment-kind CHECK vectors; catalog assertions for the four payroll triggers); database migrated to all 56 migrations |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Duplicate payroll period key — rejected (unique index).
2. Closing a period with a held contract-silent calculation — rejected (`payroll.period_close_held`).
3. Approving a held calculation — rejected (`payroll.calculation_not_prepared`); held→resulted impossible in the state machine.
4. Work evidence with no covering component (class hours, class-based rate absent) — calculation **held with reason**, amount not invented.
5. No active contract over the period — calculation **held**, not paid.
6. Preparer approving their own calculation — denied while holding the approve capability (`payroll.approval_not_independent`).
7. Beneficiary approving their own payroll — denied (`payroll.beneficiary`).
8. Second result from a consumed calculation — rejected; raw SQL tampering of a result amount — rejected by the trigger.
9. Adjustment without a reason / unknown kind — rejected; double reversal — rejected (`payroll.reversal_exists`).
10. Late adjustment or new calculation after period closure — rejected (`payroll.period_closed` / `payroll.period_not_open`); raw SQL reopen of a closed period — rejected by the trigger.
11. Settlement before termination, before both clearances, or twice — rejected; single-actor prepare+approve — denied; beneficiary participating — denied; raw SQL amount tampering of a settlement — rejected by the trigger.
12. Unprivileged calculation — denied with audit evidence (`payroll.calculation.prepare.denied`) and no row.

## Repair log (defects found by verification, fixed, reverified)

1. Employment termination date read through a relation method that no longer exists — replaced with a direct latest-status query.
2. phpstan `array` property docblock on the snapshot column — typed as `array<string, mixed>`.
3. Negative-path preparer lacked the approve capability (capability denial masked the independence guard) — actor now holds it so the *independence* guard fires.

## Decide

- Entitlement, calculation, result, and payment stay distinct (D-G3-003): this package ends at the approved result and the settlement record; posting an actual payment belongs to Finance (sequence row 9+).
- Fixed/allowance components contribute their full amount when the component window overlaps the period — **no proration is invented** (proration policy is configuration, decided later); hourly/class-based multiply exactly by consumed evidence quantities.
- The Finance side of "HR + Finance review" and the Finance clearance are **capabilities** (`payroll.approve` review separation, `payroll.clear_finance`) — role grants are configuration; the Finance module itself arrives later without changing this contract.
- Payroll-period closure coordination with Finance period closure is deferred until Finance periods exist (explicit status checks will be added there, not here); disagreement handling is already fail-closed through the held-calculation gate.
- The settlement amount is declared input with mandatory basis evidence — the system computes payroll results, never settlement totals.

## Certified

Package 09 — Payroll: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (233 tests, 901 assertions)**, phpstan level 6 clean, pint clean (245 files), database at 56 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–08 untouched.
