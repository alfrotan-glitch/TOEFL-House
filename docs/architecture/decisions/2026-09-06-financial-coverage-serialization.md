# ADR: Serialize student-level Finance coverage decisions

**Date:** 2026-09-06  
**Status:** Accepted for static implementation  
**Scope:** Finance coverage-affecting approvals, allocations, corrections, obligation posting, and Academic enrollment activation

## Decision

Finance coverage decisions use one canonical database lock: the authoritative `students` row for the affected student. A coverage-affecting command acquires this row with `FOR UPDATE` inside its transaction before it derives an uncovered balance or records the decision. `FinancialCoverageLock` is the shared application boundary; it is not a second balance authority and it does not replace command authorization, lifecycle, provenance, or idempotency checks.

The boundary covers obligation posting, payment and fund allocations, discount approval, correction approval, credit approval, installment-plan approval, gate-exception approval, and Academic enrollment activation. Financial corrections resolve the student through their obligation, payment-allocation, or fund-allocation source. Paths that also lock command or source rows acquire the student lock first where the student can be resolved before those row locks, reducing cross-command deadlock risk.

## Why

The uncovered-balance decision is a student-level derived fact, while its inputs are spread across immutable obligations and compensating or coverage facts. Locking only the individual approval or source row permits two concurrent commands for the same student to each observe the same uncovered remainder and both pass an amount check. A single student-row lock provides one serialization point without introducing a Finance-owned cached balance or shadow aggregate.

## Invariants

1. `FinancialBalanceQuery` remains the only derived-balance authority.
2. Coverage commands must acquire the canonical student lock before deriving and committing a competing decision.
3. The lock is held only inside the existing transaction; a caller outside a transaction does not receive an implicit durability guarantee.
4. Authorization, branch/organization provenance, lifecycle, separation of duties, and idempotency are still rechecked by the owning command.
5. Runtime lock behavior, transaction scope, deadlock detection/retry policy, query plans, migration compatibility, and concurrent test evidence remain deferred.

## Implementation evidence

- `app/Modules/Finance/Domain/FinancialCoverageLock.php`
- Coverage-affecting Finance commands under `app/Modules/Finance/Commands/`
- `app/Modules/Academic/Commands/MaintainEnrollment.php`
- `docs/architecture/review/2026-09-05-fourth-architecture-convergence.md`
