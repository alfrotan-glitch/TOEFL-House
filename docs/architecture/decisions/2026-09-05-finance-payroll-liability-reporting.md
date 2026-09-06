# ADR: Finance recognition is required before Payroll amounts enter monetary reporting

- **Status:** Accepted
- **Date:** 2026-09-05
- **Supersedes:** `payroll_total` being calculated directly from Payroll results and adjustments as if Payroll were the monetary reporting authority

## Context

Payroll correctly owns deterministic calculation, approval, and source-linked adjustments. Finance is the sole monetary authority. The reporting calculator nevertheless summed approved Payroll results and adjustments directly. That made a derived report an implicit second monetary authority and did not define recognition, period close, evidence, correction, or downstream posting semantics.

## Decision

Payroll results and adjustments remain immutable calculation evidence. Finance recognizes each approved source through `RecognizePayrollLiability`, producing an append-only `payroll_liability_facts` row with source identity, exact amount (including a signed reversal), period, employment, immutable originating employee-branch provenance, Finance actor, evidence reference, and correlation. The Finance fact is unique per source and is the only source used by `payroll_total`. Recognition fails closed unless the source is approved, the amount matches exactly, the Finance actor is distinct from the Payroll source approver, employee branch provenance is known and active, and the Finance capability is allowed for that branch scope.

A later Finance posting/disbursement design may project recognized liabilities into journals or payment workflows; this ADR does not make Payroll a ledger and does not silently treat an unrecognized Payroll result as money.

## Consequences

- A report can intentionally be lower than approved Payroll source evidence while Finance recognition is pending.
- Finance owns monetary authorization, evidence, corrections, and recognition timing.
- Payroll remains usable as a calculation and review surface without acquiring posting authority.
- Operations need a Finance recognition workflow and reconciliation monitoring.
- The report's period key remains resolved by the Payroll period authority because that is the source period; ownership of the monetary fact is still Finance.

## Rejected alternatives

1. **Keep summing Payroll tables:** rejected because it violates the Finance-only monetary boundary.
2. **Make Reporting post or reconcile liabilities:** rejected because reporting is derived data, not a financial command surface.
3. **Reuse termination settlements for monthly payroll:** rejected because an employment settlement is a different aggregate and lifecycle.

## Validation required later

Validate exact decimal behavior, adjustment signs and the signed transport rule, source uniqueness, active branch provenance, Finance scope authorization, period closure, corrections after recognition, journal/disbursement lineage, report reproducibility, and reconciliation of source evidence to recognized facts. Migration ordering and direct-SQL trigger behavior remain unverified until runtime validation is explicitly permitted.
