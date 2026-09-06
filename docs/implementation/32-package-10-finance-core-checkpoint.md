# Package 10 Checkpoint — Finance Core

**Package:** 10 — Finance core (sequence row 9: periods, accounts, obligations, journals — financial invariants/reconciliation; no reports yet)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 09 checkpoint (`31-package-09-payroll-checkpoint.md`) at commit `2230e77`

## Discover

- Governance inputs consumed: canonical financial domain model (foundation 34 — Account "code, type, effective definition"; Financial Period "controlled reporting/posting window"; Obligation/Obligation Line "source, original amount, debtor, period" / "source, amount, category"; Journal/Journal Line "balanced accounting record, period, source, debit/credit, posting"; Reconciliation "source set, observation, variance, explanation"; mandatory rules — journals balance, closed periods reject mutation, balances are derived from posted facts, no authoritative mutable balance), financial architecture contract (46 — Finance alone owns posted financial truth; reconciliation owns comparison and variance evidence, not an alternate cash truth), HR/payroll architecture (11 — payroll/finance period closure coordinates through explicit status checks; disagreement creates an exception, not silent overwrite), concurrency contract (17 — reconciliation: one period/source observation, unique run + approval lock), authority registry (33 — payment family approvers; beneficiary restrictions noted for the payments package), sequence row 9 scope.
- Payments, refunds, discounts, funding, cash drawers, expenses and scholarships are sequence row 10 — **out of scope here**.

## Map (implemented scope)

- **Chart of accounts** (`Account`): unique code, name, type ∈ {asset, liability, equity, revenue, expense} (CHECK); entries **immutable once defined** (DB trigger — a changed definition is a new account).
- **Financial period** (`FinancialPeriod`): one window per unique key; `open→closed`, **closed is terminal and immutable** (DB trigger; reopening impossible). **Closing coordinates with payroll periods through an explicit status check**: any payroll period overlapping the window that is not closed blocks the closure with an exception (`finance.period_payroll_open`) — never a silent overwrite.
- **Obligation** (`Obligation` + `ObligationLine`): approved charge for a liable student in an open period — posted with its atomic lines in one transaction; **lines must be positive and sum exactly to the obligation amount** (computed, not declared twice); both are **immutable posted source facts** (DB triggers); balances/receivables are derived from these facts, never stored.
- **Journal** (`Journal` + `JournalLine`): balanced accounting record — posts only to an **open period**, source-linked (`obligation|payroll_result|journal|other`), every line references an existing account with direction ∈ {debit, credit} and positive amount, and **debits must equal credits exactly** (bcmath) or the posting is rejected. Posted journals and lines are **immutable** (DB triggers). **Reversal appends a new journal** with every leg's direction swapped, linked to the original (`source_type='journal'`).
- **Reconciliation** (`Reconciliation`): comparison evidence — expected vs observed with **variance computed and schema-enforced** (`variance = observed − expected` CHECK); a non-zero variance **requires an explanation**; **one observation per period and subject** (unique index); approval by a **different actor** (`finance.reconcile_approve` ≠ observer); **approved reconciliations lock** (DB trigger). It is evidence, never an alternate cash truth.
- Capabilities: `finance.chart`, `finance.period`, `finance.obligation`, `finance.journal`, `finance.reconcile`, `finance.reconcile_approve` — all separate.
- Persistence: 6 migrations (`2026_08_26_000057`–`000062`) owned solely by the Finance module; CHECK constraints (account types, journal sources/directions/amounts, obligation amounts, period windows, reconciliation variance identity); unique indexes (account code, period key, one reconciliation per period+subject); immutability triggers on `accounts`, `obligations`, `obligation_lines`, `journals`, `journal_lines`, closed `financial_periods`, approved `reconciliations`.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 266 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (245 tests, 943 assertions)** |
| integration tests | PASS | chart/period/obligation/journal/reversal/reconciliation chains against PostgreSQL atomically (7 feature tests + finance lifecycle unit suite) |
| financial invariant tests | PASS | journals balance exactly or posting rejected; obligation lines sum to the obligation; accounts/obligations/journals/journal-lines immutable (raw SQL vs triggers); closed period rejects obligations and journals and never reopens (raw SQL vs trigger); reversal negates the original legs; variance identity enforced by schema |
| reconciliation tests | PASS | variance requires explanation; one observation per period+subject; independent approval; locked once approved |
| authorization tests | PASS | unprivileged obligation posting denied with audit and no row |
| lifecycle tests | PASS | period open→closed terminal; reconciliation draft→approved locked; unit matrix asserts absent edges |
| financial period/payroll coordination | PASS | closing with an overlapping open payroll period rejected; closes after the payroll period closes |
| contract tests (boundary) | PASS | Payroll periods consumed read-only; Students consumed read-only (liable party reference); no payment/balance entities exist by design |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (finance indexes; account-type, journal-direction, variance-identity CHECK vectors; catalog assertions for the finance triggers); database migrated to all 62 migrations |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Duplicate account code — rejected; unknown account type — rejected; raw SQL rename of an account — rejected by the trigger.
2. Duplicate financial period key — rejected; inverted window — rejected.
3. Zero/negative obligation line — rejected; obligation without lines/reason — rejected; raw SQL amount tampering of a posted obligation — rejected by the trigger.
4. Unbalanced journal (debit 8500 vs credit 8000) — rejected with the exact figures in the error.
5. Journal line with unknown account or invalid direction — rejected.
6. Posting obligations or journals to a closed period — rejected; raw SQL reopen of a closed period — rejected by the trigger.
7. Reversal that would mutate the original — impossible: reversals append a negating journal linked to the original.
8. Raw SQL tampering of posted journal lines — rejected by the trigger.
9. Reconciliation variance without explanation — rejected; second observation for the same period+subject — rejected; observer approving their own reconciliation — denied; raw SQL edit of an approved reconciliation — rejected by the trigger.
10. Closing a financial period while an overlapping payroll period is open — rejected (`finance.period_payroll_open`).
11. Unprivileged obligation posting — denied with audit evidence (`finance.obligation.post.denied`) and no row.

## Repair log (defects found by verification, fixed, reverified)

None — the package passed every gate on the first full run; the adversarial vectors above were all designed in from the registries and verified green.

## Decide

- Obligation amounts are **computed from the posted lines** (single source of truth) rather than declared alongside them — the sum cannot disagree with the lines.
- The journal account mapping (which accounts a charge hits) is the accountant's explicit input — the system enforces balance, openness, source links, and immutability but **invents no mapping policy**.
- Payroll-period coordination is the promised explicit status check from the P09 checkpoint: overlap check at finance close time; disagreement fails closed.
- Payments, refunds, discounts, funding, cash drawers, and expenses belong to the next package; no balance columns exist anywhere by design (derived-only).
- Reconciliation approval is two-actor (observer ≠ approver); the reconciliation itself records variance evidence and locks — it cannot mutate anything.

## Certified

Package 10 — Finance core: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (245 tests, 943 assertions)**, phpstan level 6 clean, pint clean (266 files), database at 62 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–09 untouched.
