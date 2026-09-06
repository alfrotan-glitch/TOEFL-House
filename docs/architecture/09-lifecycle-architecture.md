# Lifecycle Architecture

Each context owns a transition table/state machine, not a universal status service. A command names current state, requested transition, actor, effective date, preconditions, and reason. The owner validates and atomically records the new state, audit, and history. Unknown or unauthorized transitions fail closed. Cancellation, expiry, reversal, and appeal are explicit transitions; correction appends linked history.

Critical state machines use the Gate 3 registry: admission/student/enrollment; class/session/attendance/assessment; progression/graduation/appeal; employment/leave/termination; payroll and financial period; obligation/payment/refund/discount/adjustment; funding; document/consent/disclosure; asset/work order/incident. Derived states (balances, metrics, percentages) are never transitioned as facts. Effective-dated configuration and relationships are evaluated as-of the relevant period.
