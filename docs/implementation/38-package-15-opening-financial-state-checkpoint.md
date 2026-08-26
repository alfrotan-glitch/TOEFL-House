# Package 15 Checkpoint — Opening Financial State

**Package:** 15 — Opening Financial State (user directive 2026-08-26; live-business initial financial position — NOT the conditional migration/cutover row, which remains untouched: there is no legacy database)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** final system review closure at commit `a68708e`

## Discover

- Governance inputs: financial architecture contract (46) and finance controls (23) — no mutable balances, corrections through normal instruments; transaction boundary model (05) — atomic owner writes + audit; authority registry (33) — Finance Manager prepares, General Manager approves, approver ≠ preparer; reporting contract (48) — opening position must stay distinguishable from subsequent activity; module map (03) — Finance owns obligations/journals (opening state is a Finance-owned instrument set).
- Existing code inspected: `PostObligation` (student-scoped, positive-amount CHECK, free category, `source` + line `source_ref`), `AllocatePayment` (allocations bind to obligations **only** — the decisive fact: a receivable is collectible only as an obligation), `RecordPayment` (student-only payer), `PostJournal` (balanced, `source_type ∈ {obligation, payroll_result, journal, other}`), `MaintainChartOfAccounts` (five canonical types, unique codes), `MaintainFinancialPeriod` (period_key unique, open→closed).

## Decide (key decisions)

1. **Explicit opening domain, no fake history**: `OpeningState` (organization, status, preparer/approver, digest) + `OpeningEntry` (category, amount, currency, party bindings, paper `source_ref`, effective date) + `OpeningMaterialization` (entry → instrument bridge). No rows are injected into payments/payroll/results.
2. **Materialization at approval into certified instruments** — the existing Finance model *requires* obligation-backed receivables for payment allocation, exactly the case the directive permits: student/book receivables become obligations (`source='opening-state'`, line `source_ref='opening/<entry-id>'`, category = opening category) in the FM-designated **opening financial period** (opened with the normal certified command); cash positions become balanced journals (debit named asset account, credit named equity account, `source_type='other'`, `source_id=entry`). **Payables (teacher salary, other) remain the authoritative opening liability** — settled later through normal journals (payments are student-only); no fake payroll history (asserted).
3. **Posting authority**: approval materializes under the **preparer's** posting capabilities (`finance.obligation`/`finance.journal`), released by the GM's approval decision — the GM never gains posting rights and the FM never gains approval rights.
4. **Exactly once**: `UNIQUE(organization_id)` on `opening_states` (draft or not) + command-level frozen checks — a second opening state is impossible at both levels.
5. **Reporting semantics**: opening period vs subsequent periods give opening/subsequent distinction; current balance = certified outstanding metric across the opening period (P13 calculator untouched); the digest reproduces the approved entry set forever.

## Map (implemented scope)

- **Lifecycle** `draft → submitted → approved` (DB trigger enforces path; same-status updates frozen except draft; deletes never). Approval CHECK-enforced to carry approver/time/digest evidence; `approved_by <> prepared_by` CHECK.
- **Commands**: `MaintainOpeningState` (`finance.opening.prepare`): create (once per organization; effective date + opening period key), addEntry (only in draft; shape matrix per category — student binding for receivables, person binding for teacher payable, asset+equity accounts for cash; positive fixed-point amount; unique paper `source_ref` per state; person/student/employment existence), submit (preparer only; non-empty). `ApproveOpeningState` (`finance.opening.approve`): one atomic transaction — capability → state submitted → approver ≠ preparer → no existing approved → entries valid → opening period open → digest → materialize (skip-if-present for idempotent replays) → freeze + immutable evidence + audit. All commands: capability before validation, idempotency envelope, success audit, denial audit (`finance.opening.*.denied`).
- **Error codes**: `finance.opening_{category_unknown,amount,student_required,person_required,cash_accounts,evidence,student_unknown,person_unknown,employment_unknown,duplicate,not_draft,not_preparer,empty,not_submitted,frozen,exists,second_approved,period}` + `finance.opening_{prepare,approve}_denied` / `finance.opening_not_independent`.
- **Persistence**: 3 migrations (`2026_08_26_000087`–`000089`); CHECKs (status set, approval-evidence identity, distinct approvers, category set, amount > 0, currency ∈ {AFN}, per-category shape matrices); uniques (one state per organization, one entry per (state, source_ref), one materialization per (entry, instrument_type)); triggers (controlled path, entry immutability + draft-only insert, materialization retention). DB at **89 migrations**.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | phpstan level 6 `[OK] No errors` |
| lint | PASS | pint `PASS 379 files` |
| unit/integration tests | PASS | **OK (308 tests, 1300 assertions)** cumulative |
| lifecycle tests | PASS | create/add/submit/approve happy path with materialization counts and evidence columns asserted |
| SoD tests | PASS | FM cannot approve (denied+audited); GM cannot add entries (denied+audited); self-approval denied even with both capabilities; unprivileged creation denied+audited |
| one-shot tests | PASS | second opening state rejected (command `finance.opening_frozen` + DB unique); double approval rejected; raw SQL unfreeze/delete/rewrite rejected by triggers |
| correction tests | PASS | post-approval 5000 stays 5000; approved discount adjusts outstanding 2500→2000 while opening entry/obligation originals remain; digest reproduces the approved set |
| integration tests | PASS | opening 3500 (3000 debt + 500 book) → real payment 1000 allocated → outstanding 2500 (P13 calculator, untouched); subsequent-period view 0.00; payables create zero payroll/payroll_result/payment rows |
| atomicity tests | PASS | approval with missing opening period fails whole — nothing materialized, state stays submitted |
| concurrency tests | PASS | concurrent creation collapses to one state; idempotent double approval returns identical digest with exactly one obligation materialized |
| invariant tests | PASS | `SchemaInvariantFeatureTest` extended: +3 uniques, +3 CHECK vectors, +4 trigger assertions (46 tests / 129 assertions) |
| migration/schema validation | PASS | fresh testing DB → 89/89; dev DB → 89/89 |
| P02 environment | PASS | ENVIRONMENT VALID |
| regression | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

1. Double approval → `finance.opening_frozen`. 2. Self-approval → denied (`finance.opening_not_independent`) + audited. 3. Post-approval entry/submit/approve → rejected. 4. Raw SQL: state unfreeze, entry delete, entry amount rewrite → all rejected by triggers; materialization rewrite/delete → rejected. 5. Second opening state → command + unique index. 6. Races: concurrent create collapses; double approve (same idempotency key) → one materialization (asserted count 1). 7. Scope leakage: forged organization → FK rejection. 8. Idempotency collision: inherited harness (same key + different payload → `idempotency.conflicting_payload`). 9. Forged approval actor: FM approving → denied + audited. 10. Negative/zero/non-numeric amounts, unknown category, wrong currency (USD), duplicate paper reference, student-receivable without student, teacher payable without person, cash without accounts → all rejected (command + DB CHECK vectors). 11. Empty state submit/approve → rejected. 12. Approval without an open opening period → atomic failure, zero partial effects.

## Repair log

1. **`whereKey` on the query builder** resolved to a nonexistent `key` column in three existence checks — explicit `where('id', …)` (same defect class as P13/P14; now a known trap).
2. **char(36) padding**: `prepared_by` read back padded — submit preparer check, approval independence check, and the preparer posting actor now `trim()` (known pitfall class).
3. Test-side repairs: forged organization ids (FK), account codes vs account ids, 3500−1000=2500 arithmetic, race-test entry category (payable does not materialize), a poisoned GM fixture grant.

## Certify

All gates PASS on 2026-08-26: phpunit **308 tests / 1300 assertions** (cumulative P02–P15), phpstan L6 clean, pint 379 files, fresh testing DB + dev DB at **89 migrations**, schema invariants green, P02 ENVIRONMENT VALID, adversarial vectors all fail closed. The conditional migration/cutover row remains untouched. Package 15 — Opening Financial State is **CERTIFIED**.
