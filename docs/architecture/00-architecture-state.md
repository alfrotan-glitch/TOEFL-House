# Architecture State

**Governing contract:** `docs/MASTER_ENGINEERING_CONTRACT.md` (TOEFL HOUSE ERP — WORLD-CLASS MASTER ENGINEERING CONTRACT, v3.0, Canonical Project Engineering Constitution) is the highest-authority project engineering directive; the architecture artifacts below it must remain consistent with it.

**Current gate:** Gate 5 — PASS WITH NON-BLOCKING OPEN ITEMS
**Current implementation-readiness gate:** Gate 6 — PASS WITH NON-BLOCKING OPEN ITEMS
**Updated:** 2026-08-25

The approved architecture is a strict modular monolith with owner-bound contexts, server-side authorization, transaction-based Finance, append-only audit, rebuildable reporting projections, and explicit integration/background boundaries. Gate 6 converted it into implementation contracts under `docs/implementation/`.

Production implementation is not authorized. Existing application code remains untrusted legacy evidence. Gate 6 has no Critical or High implementation-contract blockers; detailed operational values, metric examples, and the conditional migration decision remain explicitly deferred.
