# Architecture Invariant Registry

| Foundation invariant/control | Architectural enforcement | Future test category |
|---|---|---|
| one source of truth | owner context and no cross-context writes | ownership/contract |
| derived balances | one `FinancialBalanceQuery` over immutable Finance facts and recorded compensations | financial invariant |
| Finance monetary authority | Finance owns obligations, payments, allocations, journals, corrections, recognized Payroll liabilities, and recorded employment settlements; Payroll supplies evidence only | ownership/financial |
| payroll recognition lineage | approved Payroll source, exact signed amount, distinct Payroll approver and Finance recognizer, unique source, immutable employee-branch provenance, Finance scope decision, append-only fact | payroll/financial/scope/SoD |
| settlement authority sequencing | Finance inserts the immutable settlement fact; Payroll closes only its own matching proposal through `SettlementProposalApproval` in the same transaction | ownership/lifecycle/transaction |
| allocation/refund limits | serialized source transaction and recheck | concurrency/financial |
| student coverage decisions | canonical `students` row lock acquired before competing uncovered-balance derivation and commit; `FinancialBalanceQuery` remains the only arithmetic authority | concurrency/financial/academic |
| immutable history | append-only correction/reversal/audit and one active lifecycle guard per staged Finance fact | history/financial |
| default deny and explicit scope | server policy decision point | authorization/scope |
| temporary authority expiry | effective-time policy evaluation | authorization |
| Owner two-person and SoD | approval template and conflict exclusion | approval |
| branch transfer history | effective-dated scope/attribution resolved as of the effective day; future transfers are not current topology | scope/history |
| academic evidence ≠ decision | separate commands/states | academic |
| entitlement ≠ calculation ≠ payment | HR/Payroll/Finance boundaries | payroll/contract |
| configuration ≠ fact | versioned effective configuration | configuration/history |
| privacy purpose/consent | disclosure gate and export policy | privacy |
| journals traceable/balanced | source link and posting invariant | accounting |
| reports cannot redefine metrics | registered metric/period definitions | reconciliation |
| idempotent external work | keys, dedupe, retry state | integration |
| workspace is not authority | composition over owner queries/commands; no workspace-owned business fact | workspace/ownership |
| workspace visibility is not authorization | current server-side authorization at every command | workspace/authorization |
| effective employee context | identity, employment, positions, assignments, capability, scope, lifecycle evaluation | workspace/lifecycle |
| workspace projections are rebuildable | committed events, authoritative queries, freshness/failure state | workspace/integration |
| audited branch events carry explicit organization provenance | event envelope, active topology constraint, and fail-closed branch projection; no intent-based sibling fallback after provenance declaration | event/provenance/scope |
| workflow projections are source-closed | catalog definition, expected source type, existing canonical source row, explicit intent, and idempotent projection key | workflow/ownership/idempotency |
| work-first and exception-first operations | task, deadline, approval, context, and exception prioritization | workspace/usability |
| personalization cannot change authority | presentation preferences isolated from policy and domain truth | workspace/security |
| one connected enterprise graph | every major fact, context edge, command, event, projection, workflow, document, notification, search, report, and management path has an explicit owner and typed relationship | architecture/conformance |
| defined critical failure behavior | duplicate, concurrent, stale, unauthorized, wrong-branch, missing-provenance, downstream-failure, retry, replay, and duplicate-event outcomes are specified | resilience/concurrency |

No listed critical Foundation, Employee Workspace, or Integrated Enterprise Graph invariant lacks a stated architectural enforcement point; runtime and repository-conformance proof remains outstanding.
