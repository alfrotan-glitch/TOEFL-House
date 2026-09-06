# ADR: Held Payroll calculations require explicit evidenced resolution

**Date:** 2026-09-06  
**Status:** Accepted for static implementation  
**Scope:** Payroll calculation exceptions and Work Management completion

## Decision

A `held` Payroll calculation is a source exception, not a silently supersedable live row. A later calculation may replace a prepared calculation automatically, but it must not close a held predecessor merely because recalculation occurred.

A held predecessor becomes terminal only through `ResolveHeldPayrollCalculation`, which must name:

- the same-period, same-employment prepared or resulted replacement calculation;
- a non-empty resolution/evidence reference; and
- the durable resolver actor, authorized by `payroll.resolve_held` at the employee's active home-branch organization scope and distinct from both the beneficiary and replacement preparer.

The transition is `held → superseded`; a held calculation can never become a payable result. The replacement remains the canonical current calculation, while the predecessor remains immutable history with explicit resolution provenance.

## Why

The previous partial unique index treated `held` as the same live state as `prepared` and caused recalculation to supersede the exception without recording whether HR/Finance had reviewed the source reason. That erased the distinction between a new calculation and an exception decision and left the Work Management exception without a governed completion contract.

## Invariants

1. Recalculation supersedes prepared rows only.
2. A held row remains visible and blocks Payroll period closure until explicitly resolved.
3. Resolution evidence is append-only provenance on the held predecessor; it cannot be supplied on calculation insertion or attached to another lifecycle transition.
4. The database guard requires a distinct same-period/employment replacement in `prepared` or `resulted` state.
5. Payroll remains the calculation/exception authority; Finance remains the monetary authority.
6. Work Management may close only the rebuildable coordination item after the Payroll resolution source event; it never mutates the calculation.
7. Runtime queue, relay, authorization, concurrency, and migration verification remain deferred under the repository runtime restriction.

## Implementation evidence

- `app/Modules/Payroll/Commands/ResolveHeldPayrollCalculation.php`
- `app/Modules/Payroll/Commands/CalculatePayroll.php`
- `app/Modules/Payroll/Domain/PayrollLifecycle.php`
- `app/Modules/Payroll/Models/PayrollCalculation.php`
- `app/Modules/WorkManagement/Domain/WorkflowCompletionCatalog.php`
- `database/migrations/2026_09_06_000157_resolve_held_payroll_calculations.php`
- `app/Http/Controllers/Api/PayrollApiController.php` and `routes/api.php`
- `docs/architecture/review/2026-09-05-fourth-architecture-convergence.md`
