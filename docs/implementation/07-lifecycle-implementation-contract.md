# Lifecycle Implementation Contract

Each owner implements its own explicit state/transition table from artifact 32. Transition command validates current state, actor/scope, preconditions, effective date, policy version, and idempotency, then atomically writes state plus transition audit. Invalid, prohibited, expired, or unknown transitions fail closed. Cancellation, rejection, expiry, reversal, appeal, and correction have explicit transitions. Historical transitions are append-only; current state never rewrites prior attribution. Derived balances/metrics have no business lifecycle. Tests enumerate allowed and forbidden transitions, replay, concurrency, and history.

Workspace work queues and action affordances consume the authoritative current lifecycle state. Suspension, termination, assignment expiry, position or branch-scope change, and delegation expiry must alter workspace composition and cannot leave stale mutation power in a cache or browser session.
