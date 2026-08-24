# Financial Implementation Contract

Fee/configuration defines eligibility and amounts by effective version. Finance creates charge lines and obligations; discounts and scholarship/funding allocations are separate approved source-linked transactions. A payment records money received; allocation links payment to obligation; refund links original payment; adjustment corrects; reversal negates a posted source; cash movement records custody; journals record balanced accounting; receivables and balances are projections; reconciliation compares source/observation sets.

Every posting requires source, period, actor, authority, scope, reason, audit, and idempotency key. Source amounts are immutable. Allocation/refund commits serialize by source and re-check remaining amount. Duplicate keys return original outcome; duplicate allocation is rejected. Closed periods reject mutation; correction/reversal is the only path. Orphan/unbalanced journals and restricted-fund reclassification are rejected. No direct balance edit exists. Finance owns financial payment; Payroll only supplies approved result.

Mandatory tests: amount/source invariants, duplicate/concurrent operations, period close, journal balance/linkage, reconciliation, restricted funds, authorization/SoD, rollback/retry, audit completeness.
