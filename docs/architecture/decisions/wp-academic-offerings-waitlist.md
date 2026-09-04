# Academic Offerings, Availability and Class Waitlist — Architecture Decision (WP-AO)

Status: Accepted
Date: 2026-09-04
Scope: Academic branch availability and offering lifecycle, offering-targeted
enrollment capacity, and ordered class/offering waitlists.

## Context

The Academic module already owned program versions, levels, periods, classes,
enrollment (Student-owned), attendance, assessments, progression and
appeals. `docs/implementation/WP-1-capability-gap-matrix.md` and the certified
Package 06/07 checkpoints identify delivery gaps:

- branch×level×term availability was a packaging fact with no lifecycle, so a
  branch/term could not be opened and closed through the term without losing
  the availability invariant.
- an `Offering` was an immutable packaging concept only; there was no
  open→closed/cancelled/completed lifecycle, no resize, and no relationship
  between an enrollment seat and the offering it was filled under.
- a class could be full while the same level/term had breathing space in a
  sibling offering, but there was no offering-scoped capacity accounting and
  no fair ordered queue of students waiting for a freed seat.

## Decision

Availability and Offering remain inside the **Academic** authority per
`docs/architecture/10-academic-architecture.md` and
`docs/implementation/08-academic-implementation-contract.md`. Enrollment stays
Student-owned; the offering is a controlled academic target attached to a
Student enrollment seat and is immutable on that row once created (a transfer
opens a new seat).

### Lifecycles

- `BranchAvailability`: `active ↔ closed`. Closing is refused while any
  related offering is still `open`; reopening re-checks the term is
  `published` and the level is `active`.
- `Offering`: `open ↔ closed`, `open → cancelled/completed`,
  `closed → open/cancelled/completed`; `cancelled`/`completed` terminal.
  Cancel/complete is refused while any non-terminal enrollment seat
  (`requested`/`active`/`frozen`) still references the offering. Capacity can
  only change while the new capacity is at least the current active seat
  count.
- `ClassWaitlistEntry`: `waiting → offered/withdrawn/expired/enrolled`,
  `offered → enrolled/expired`; `enrolled`/`withdrawn`/`expired` terminal.

### Rules

- A `request()`/`transfer()` enrollment may target an offering. The offering
  must be `open` and must exactly match the class period and level.
- Activation counts against both class capacity and offering capacity; the
  first exhausted cap rejects.
- A waitlist join is permitted only when the class or offering capacity is
  currently exhausted. A student holds at most one open entry per class;
  positions are unique among open entries and ordered.
- Promotion never creates a silent `active` seat: it produces a normal
  `requested` enrollment through `MaintainEnrollment::request`, then marks the
  entry `enrolled`. Activation still follows the normal approval path.
- Withdraw/expire are terminal state changes. Identity fields and positions
  are immutable; the DB guards enforce them together with the open-state
  partial uniqueness indexes.

### Capabilities

- `academic.structure` — availability/offering lifecycle and capacity resize.
- `academic.enroll` — waitlist join/withdraw (student-side queue action).
- `academic.enroll_approve` — waitlist offer/expire/promote (staff-side).

## Consequences

- Migration `2026_09_04_000131_extend_academic_offerings_and_waitlist.php`
  adds the lifecycle CHECKs, removes the term-open requirement from
  non-defining offering updates while keeping the branch×level×term
  immutability and packaging guard on the defining triple, and adds
  `enrollments_offering_guard` + `class_waitlist_entries_*` triggers.
- New command surface: `ManageAcademicOffering`, `ManageClassWaitlist`;
  `MaintainEnrollment` becomes offering-aware.
- New queries: `OfferingCatalogQuery`, `ClassWaitlistQuery`.
- New lifecycle domains: `OfferingLifecycle`, `BranchAvailabilityLifecycle`,
  `WaitlistLifecycle`.
- Tests cover the offering/availability lifecycle, offering-targeted
  enrollment capacity, and the full waitlist join/offer/promote/withdraw
  journey.
