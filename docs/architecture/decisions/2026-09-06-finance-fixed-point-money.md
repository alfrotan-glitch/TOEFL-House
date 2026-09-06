# ADR: Finance accepts one fixed-point money representation

**Date:** 2026-09-06  
**Status:** Accepted for static implementation  
**Scope:** Finance monetary command boundaries and HTTP validation

## Decision

Ordinary Finance monetary inputs use the canonical two-decimal fixed-point representation accepted by `MoneyAmount`: unsigned digits with up to twelve integer digits and zero, one, or two decimal places. Signed values are limited to the explicit signed Payroll-adjustment boundary. Finance command validation and the HTTP `money`/`signed_money` rules use this same representation.

Commands must compare monetary values with BCMath at scale two. Binary floating-point conversion is not a valid authority for acceptance, positivity, non-negativity, or variance decisions.

## Why

The database stores `decimal(14,2)`, while several Finance commands previously used binary floating-point comparisons before insertion. That could accept scientific notation or third-decimal values that later round differently at the database boundary and could make variance decisions dependent on floating-point behavior. A shared boundary keeps transport, command, and storage semantics aligned without creating a second monetary authority.

## Invariants

1. Finance never accepts a value that cannot be represented by its ordinary two-decimal `decimal(14,2)` columns.
2. Positive, non-negative, and signed-money decisions use fixed-point comparison, never `(float)` conversion.
3. Reconciliation variance explanation requirements compare expected and observed values at the stored two-decimal scale.
4. Finance remains the sole monetary authority; this decision changes representation validation only, not ownership or lifecycle.
5. Runtime tests, database rounding behavior, and migration verification remain deferred under the repository runtime restriction.

## Implementation evidence

- `app/Support/MoneyAmount.php`
- `app/Support/Providers/AppServiceProvider.php`
- Finance monetary commands under `app/Modules/Finance/Commands/`
- `app/Modules/Finance/Domain/OpeningEntryContract.php`
- `docs/architecture/review/2026-09-05-fourth-architecture-convergence.md`
