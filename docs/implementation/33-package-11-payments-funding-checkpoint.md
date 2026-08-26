# Package 11 Checkpoint — Payments and Funding

**Package:** 11 — Payments and funding (sequence row 10: payments, allocations, refunds, discounts, funds — idempotency/concurrency/restricted-fund tests)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 10 checkpoint (`32-package-10-finance-core-checkpoint.md`) at commit `87e189d`

## Discover

- Governance inputs consumed: canonical financial domain model (foundation 34 — Payment "source, amount, method, received time, payer"; Payment Allocation "payment, obligation, amount"; Refund "source payment, amount, reason"; Discount "eligibility, amount/rate, reason, effective dates"; Funding Source/Fund/Restriction "agreement, restriction, dates"; Scholarship Award/Allocation; mandatory rules — a payment posts only once, allocations cannot exceed payment or obligation, refunds cannot exceed refundable source, discounts preserve original obligation, restricted funds cannot be reclassified without authorized evidence, closed periods reject mutation, balances derived from posted facts), financial architecture contract (46 — every allocation references one payment and obligation; a payment cannot be allocated twice; reconciliation is not an alternate truth), business rules (11 — BR-FIN-002 refunds need documented conditions, immutable source payment, approval, Finance recording; BR-FIN-003 discounts need published or separately approved eligibility, dates, audit, reversal as controlled correction; BR-FUND-002 contract-silent restricted funds remain restricted and on hold), authority registry (33 — payment family: operator/Finance/configured approver, direct balance edit forbidden; scholarship/funding: restricted use without authority forbidden), Gate-2 flow (27 — Fee policy → Obligation → Payment → Allocation → Refund/Discount → Journal/Ledger → Reconciliation), concurrency contract (17 — payment/allocation/refund: idempotency + per-source serialized commit).
- Cash drawers, expenses, and full scholarship-award rules are later scope; journals already exist (P10) and postings source-link through `other` — no P10 surface touched.

## Map (implemented scope)

- **Payment** (`Payment`): money received from an external source — recorded with a **unique external receipt reference** (a payment posts only once), positive amount, method, received date, payer (student), into an **open financial period**; **immutable** from then on (DB trigger) — returns happen exclusively through refunds.
- **Payment allocation** (`PaymentAllocation`): links exactly **one payment to one obligation** — **unique pair** (a payment cannot be allocated twice to the same obligation), same-payer check, and two hard caps: **allocation ≤ unallocated payment remainder** and **≤ uncovered obligation remainder** (original − fund allocations − payment allocations − approved discounts). Committed under **row locks on both the payment and the obligation** (per-source serialized commit); immutable history (DB trigger).
- **Refund** (`Refund`): BR-FIN-002 — mandatory documented reason, the **immutable source payment**, **two distinct actors** (requester `finance.refund` ≠ approver `finance.refund_approve`), recorded into an open period, and **never more than the refundable remainder** (payment − allocated − already refunded); immutable (DB trigger).
- **Discount** (`Discount`): BR-FIN-003 — proposed with **mandatory eligibility basis**, effective dates, and reason; **approved by a distinct actor** (`finance.discount_approve` ≠ proposer); approval re-checks the cap against the **uncovered obligation remainder**; **the original charge is preserved** (obligation row untouched — verified); approved discounts are **immutable** (DB trigger).
- **Funding** (`FundingSource` + `FundAllocation`): a funding agreement establishes an immutable pool with its **restriction** (`restricted_category` + mandatory restriction note; a restriction is **never reclassified** — DB trigger — BR-FUND-002). Allocations apply fund money to **obligation lines of the permitted category only**, capped by the **unutilized pool remainder** (under a fund row lock), the **uncovered line remainder**, and the **uncovered obligation remainder**; utilization is **derived** from allocations, never stored.
- Capabilities: `finance.payment`, `finance.refund`, `finance.refund_approve`, `finance.discount`, `finance.discount_approve`, `finance.fund`, `finance.fund_allocate` — all separate.
- Persistence: 6 migrations (`2026_08_26_000063`–`000068`) owned solely by the Finance module; CHECK constraints (positive amounts everywhere, discount states and windows); unique indexes (payer receipt reference, allocation pair); immutability triggers on payments, payment allocations, refunds, approved discounts, funding sources, and fund allocations.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 286 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (255 tests, 989 assertions)** |
| integration tests | PASS | payment/allocation/refund/discount/fund chains against PostgreSQL atomically (7 feature tests + payment lifecycle unit suite) |
| financial invariant tests | PASS | payment posts once (unique receipt reference); allocation caps on both sources (7000.01 and 8500.01 rejected with remainders in the errors); unique payment↔obligation pair; refund capped at the refundable remainder (2000.01 rejected, second refund rejected); discount capped at the uncovered remainder (7500.01 rejected); fund utilization capped by pool (5001 rejected), line (3000.01 rejected), and obligation remainders; obligation original amount preserved under discount |
| restricted-fund tests | PASS | restricted category ≠ line category rejected (`finance.fund_restriction`); restriction note mandatory; raw SQL reclassification of the restriction rejected by the trigger |
| idempotency/concurrency tests | PASS | inherited idempotent harness on every command (replay returns the original outcome; same key + different payload rejected); allocation commit serialized under payment+obligation row locks; fund allocation under fund row lock |
| ledger/invariant protection | PASS | all six new tables immutable via DB triggers (raw SQL tampering rejected); closed periods reject payments, refunds, and discount proposals; no balance columns anywhere — remainders derived from posted facts |
| authorization tests | PASS | refund requester≠approver; discount proposer≠approver; unprivileged payment recording denied with audit (`finance.payment.record.denied`) and no row |
| lifecycle tests | PASS | discount proposed→approved terminal; unit matrix asserts absent edges |
| contract tests (boundary) | PASS | Finance core (periods, obligations, obligation lines) consumed read-only; Students consumed read-only; no other module touched |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (payer-ref and allocation-pair indexes; payment-amount and discount-state CHECK vectors; catalog assertions for all six payment/funding triggers); database migrated to all 68 migrations |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Same external receipt posted twice — rejected (`finance.payment_duplicate`, unique index).
2. Payment into a closed period — rejected; refund into a closed period — rejected; discount proposal into a closed period — rejected.
3. Allocation exceeding the unallocated payment remainder — rejected with the exact remainder in the error.
4. Allocation exceeding the uncovered obligation remainder — rejected with the exact remainder.
5. Second allocation of the same payment to the same obligation — rejected (domain + unique pair index).
6. Cross-student allocation — rejected (`finance.allocation_payer_mismatch`).
7. Refund by a single actor (requester = approver) — denied even while holding both capabilities (`finance.refund_not_independent`).
8. Refund exceeding the refundable remainder (allocated money is not refundable) — rejected; refund exhausting the remainder twice — rejected.
9. Discount without eligibility or reason — rejected; inverted effective window — rejected.
10. Proposer approving their own discount — denied (`finance.discount_not_independent`).
11. Discount exceeding the uncovered obligation remainder at approval time (re-checked under lock) — rejected; the obligation's original amount asserted unchanged.
12. Fund allocation to a line of a different category than the restriction — rejected (`finance.fund_restriction`).
13. Fund allocation exceeding the unutilized pool — rejected; exceeding the uncovered line — rejected; exceeding the uncovered obligation — rejected.
14. Restricted fund without a restriction note — rejected at establishment.
15. Raw SQL tampering: payment amount, allocation, refund amount, approved discount amount, fund restriction reclassification, fund allocation — all rejected by triggers.
16. Unprivileged payment recording — denied with audit evidence and no row.

## Repair log (defects found by verification, fixed, reverified)

1. Cross-payer test vector referenced an obligation that did not exist for the second student — the test now posts that obligation first.
2. `assertDatabaseHas` misused a message string as the third (connection) argument — removed (known standing rule).
3. Fund-cap vectors had the line cap binding before the pool cap and the "greedy discount" exactly equal to the remainder — vectors adjusted so each cap is the binding constraint (7500.01 / 5001 / 3000.01).

All repairs are test-side; no production defect was found in the package logic.

## Decide

- "A payment posts only once" is enforced structurally: the **external receipt reference is unique** — replay of the same receipt is impossible regardless of idempotency-key choice, while the idempotent harness still returns the original outcome for true replays.
- "Refundable source" is the **unallocated and unrefunded remainder** — allocated money must never leave as a refund (fail-closed; a future allocation-reversal correction can be added as a controlled adjustment if policy requires it).
- Discount reversal (BR-FIN-003 "reversal is a controlled correction") is deferred by decision: approved discounts are immutable and any correction would append a controlled reversal record when a concrete policy exists — nothing is silently rewritable meanwhile.
- Fund restriction is declared as a **category restriction** (e.g. tuition-only) with a mandatory note; richer restriction dimensions (program, period) are configuration the agreement records in its note until a policy exists — no reclassification path exists by design (BR-FUND-002).
- Scholarship awards are modeled as fund allocations with mandatory reason/eligibility evidence; a dedicated award-rule registry waits for academic scholarship policy (configuration, not invented here).
- Payment/discount/refund journal postings remain the accountant's explicit act through P10's `PostJournal` (`source_type='other'` with the source id) — the P10 CHECK constraint was not modified.

## Certified

Package 11 — Payments and funding: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (255 tests, 989 assertions)**, phpstan level 6 clean, pint clean (286 files), database at 68 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–10 untouched.
