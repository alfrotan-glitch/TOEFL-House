# Concurrency and Consistency Architecture

Business invariants are protected at the owner boundary by atomic commit, current-state revalidation, unique/idempotency constraints, and serialized conflict domains—not by vague database reliance.

| Operation | Protected invariant | Mechanism |
|---|---|---|
| payment/allocation/refund | no duplicate/excess amounts | idempotency + per-source serialized commit |
| reconciliation | one period/source observation | unique run/version + approval lock |
| payroll/period close | stable calculation and closed-period immutability | period lock and state check |
| approvals/authority | counted once; no conflicted actor | compare-and-commit and policy recheck |
| enrollment/capacity | no duplicate active seat/over-capacity | membership uniqueness + capacity reservation |
| attendance correction | append-only correction | version/current-state check |
| scope assignment | no overlapping unauthorized effective assignment | dated conflict validation |

Conflict returns a retryable business conflict, never silently merges or overwrites history.
