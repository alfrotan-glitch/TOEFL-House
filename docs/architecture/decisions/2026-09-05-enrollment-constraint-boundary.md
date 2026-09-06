# ADR: Enrollment constraint boundary

- Status: accepted for convergence
- Date: 2026-09-05

## Context

Academic still owns the current `Enrollment` lifecycle writer and the canonical `enrollments` representation. The enrollment command nevertheless contained reusable checks for active students and classes, prerequisites, offering compatibility, branch provenance, and class/offering seat capacity. Leaving those checks embedded makes a future Enrollment boundary harder to extract and encourages Academic to absorb planning policy.

## Decision

Create an `EnrollmentConstraints` domain service under the target Enrollment module boundary. It owns reusable admission-to-seat planning constraints and reads Academic/Students canonical facts. Academic remains the sole current writer for `Enrollment`, financial gates remain Finance-owned, and this change does not create a second enrollment table or transfer lifecycle authority prematurely.

The service is fail-closed for inactive students/classes, unsatisfied prerequisites, closed or mismatched offerings, missing offering provenance fallback, and exhausted class/offering capacity. Capacity checks retain row locks for the existing transaction-level invariant.

## Consequences

- Enrollment constraint policy has one extraction seam before lifecycle writes move.
- Academic orchestrates the command and remains the only `Enrollment` writer in this phase.
- Runtime concurrency, container wiring, authorization seeds, and migration behavior remain unverified because runtime execution is intentionally deferred.
- Availability reservations, teacher conflicts, waitlist orchestration, and a fully materialized Enrollment module remain future work.
