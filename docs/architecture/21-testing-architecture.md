# Testing Architecture

Future tests are specified, not implemented here. Domain rule and invariant tests cover state transitions, financial amount/source rules, academic evidence/decision separation, payroll separation, privacy, and historical immutability. Authorization/scope tests cover default deny, hierarchy, cross-branch, expiry, delegation, Owner approval, SoD, and conflict.

Contract tests cover each module boundary, allowed direction, failure behavior, idempotency, and event schema. Transaction/concurrency tests cover payment, allocation, refund, close, enrollment capacity, approvals, authority changes, and corrections. Audit tests verify complete immutable evidence. Reporting reconciliation tests compare metrics to owner facts and periods. Migration tests cover mapping, rejection, reconciliation, rollback, and history preservation. End-to-end tests cover critical workflows. Technical migration and deployment tests remain future architecture/implementation work.
