# Architecture Invariant Registry

| Foundation invariant/control | Architectural enforcement | Future test category |
|---|---|---|
| one source of truth | owner context and no cross-context writes | ownership/contract |
| derived balances | Finance projection from posted facts | financial invariant |
| allocation/refund limits | serialized source transaction and recheck | concurrency/financial |
| immutable history | append-only correction/reversal/audit | history |
| default deny and explicit scope | server policy decision point | authorization/scope |
| temporary authority expiry | effective-time policy evaluation | authorization |
| Owner two-person and SoD | approval template and conflict exclusion | approval |
| branch transfer history | effective-dated scope/attribution | scope/history |
| academic evidence ≠ decision | separate commands/states | academic |
| entitlement ≠ calculation ≠ payment | HR/Payroll/Finance boundaries | payroll/contract |
| configuration ≠ fact | versioned effective configuration | configuration/history |
| privacy purpose/consent | disclosure gate and export policy | privacy |
| journals traceable/balanced | source link and posting invariant | accounting |
| reports cannot redefine metrics | registered metric/period definitions | reconciliation |
| idempotent external work | keys, dedupe, retry state | integration |

No critical Foundation invariant lacks an architectural enforcement point.
