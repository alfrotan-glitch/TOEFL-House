# Transaction Boundary Model

Every command has: authenticate, authorize, validate current state/configuration, enforce invariant, commit owner facts and audit atomically, then publish an outbox/post-commit notification. Rejected commands write no business state; material denied attempts are audited.

| Operation | Atomic owner writes | Post-commit |
|---|---|---|
| enrollment/conversion | admission/student/enrollment facts and audit | notify Academic/Finance |
| class assignment | membership and capacity reservation | schedule/report refresh |
| attendance correction | corrected record plus linked history | notify Academic/reporting |
| result approval/appeal | decision and audit | release notification |
| payroll calculation/approval | calculation/result for period | finance posting input |
| payment/allocation | payment and allocation with invariant lock | receipt/report refresh |
| refund/discount/adjustment | approved source-linked transaction | statement/report refresh |
| journal/reconciliation | balanced journal or reconciliation evidence | close/alert |
| approval/authority change | immutable approval or effective assignment | authorization cache refresh |

Cross-context operations use a coordinator with explicit outcomes, never a distributed hidden transaction. Partial outcomes are held, retried, or reversed using domain rules.
