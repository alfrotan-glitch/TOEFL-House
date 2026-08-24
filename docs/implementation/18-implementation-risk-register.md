# Implementation Risk Register

| Risk | Severity | Control/status |
|---|---|---|
| financial duplicate/over-refund | Critical if uncontrolled | source serialization/idempotency; contract complete |
| authority/scope leakage | High if uncontrolled | server PDP, default deny, expiry tests |
| history rewrite | High if uncontrolled | append-only corrections and audit |
| undefined metric/period | Medium | metric registry; resolve before reporting package |
| RPO/RTO unknown | Medium | operational decision before resilience rollout |
| legacy migration corruption | High if migration chosen | conditional migration, quarantine/reconciliation |
| external payment uncertainty | High if uncontrolled | inquiry/reconciliation, no duplicate retry |
| overly broad module dependencies | Medium | acyclic contract graph and no shared writes |

No Critical or High readiness blocker remains; controls are implementation acceptance gates.
