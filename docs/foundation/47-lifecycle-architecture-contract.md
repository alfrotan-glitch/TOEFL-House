# Lifecycle Architecture Contract

Every controlled entity uses the transition registry as its state machine. A transition requires current state, permitted next state, preconditions, authorized actor/scope, effective date, reason, and audit. Rejection leaves the prior state unchanged and records the denied attempt where material.

| Family | Architectural requirement |
|---|---|
| Student, enrollment, employment | status transition owned by Students or HR; no downstream status inference |
| Class, session, attendance, assessment | ordered publication/delivery/evidence/scoring/review states; cancellation and correction preserve history |
| Progression, graduation, appeal | official decision is separate from evidence; appeal supersedes outcome without erasing original |
| Payroll, financial period | ordered calculate/review/approve/pay/close states; correction/reversal is linked append-only history |
| Payment, refund, discount, adjustment | source reference and approval preconditions; no balance-only transition |
| Consent, disclosure, document | effective/revoked/expired states; revocation affects future use, not evidence |
| Asset, work order, incident | custody/work/outcome evidence and approval before terminal disposition |

Effective-dated configuration and relationships are evaluated as-of the business period. Transfer, deactivation, closure, cancellation, and reopening create explicit transitions; they do not delete or rewrite historical facts. Unknown transitions fail closed and are held for the owning authority.
