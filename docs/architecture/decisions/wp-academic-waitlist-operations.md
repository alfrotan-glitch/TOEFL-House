# Class Waitlist Operations — Architecture Decision (AC11)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-05
**Applies to:** employee-console transport for the ordered class waitlist:
join, offer, promote (accept), withdraw / expire (decline paths), and the
open-entries read surface.
**Supersedes:** nothing. Completes the WP-AO remainder ("ordered
class/offering waitlists" — domain-certified, zero operational surface)
without touching the already-certified domain, mirroring the AC8/AC10
pattern.
**Related decisions:** WP-AO (waitlist domain: `ManageClassWaitlist`,
`WaitlistLifecycle`, `ClassWaitlistQuery`, migration `000131` guards);
roadmap waitlist item; Finance as sole financial authority (promotion
creates a normal `requested` enrollment — activation still passes the
existing financial gate; no Finance touch here).

## Problem

The waitlist domain is complete and certified
(`AcademicOfferingAndWaitlistFeatureTest`: join only when full, one open
entry per student, ordered positions, offer requires a free seat,
promote-into-`requested`, withdraw/expire terminal), but it has **zero
operational surface**: no controller, route, view, or API endpoint
references waitlist entries. In production a full class simply refuses
seats — students cannot queue, freed seats cannot be offered to the next
in line, and offers cannot be accepted or declined.

## Decision

1. **Console transport only; no domain change.** Five POST actions on the
   existing `AcademicController` + routes + a "Class waitlist" card on
   the academic index: join, offer, promote, withdraw, expire. All
   authorization, guards, idempotency, ordering, and audit stay in
   `ManageClassWaitlist`; capabilities are the existing
   `academic.enroll` (join/withdraw — student-side queue action) and
   `academic.enroll_approve` (offer/promote/expire — staff-side) — both
   already in the owner bootstrap, no seeder change.
2. **Accept/decline run the certified edges.** Accept is promote
   (`offered → enrolled`, creating a normal `requested` enrollment that
   activates through the existing approval path and financial gate —
   never a silent active seat). Decline is withdraw from `waiting` or
   expire from `waiting`/`offered`; every legal lifecycle edge is
   exposed, no new transition is invented.
3. **Read surface from existing data.** The index passes open entries in
   class × position order (fairness is displayed, positions stay
   domain-assigned and immutable); no new query surface (the certified
   `ClassWaitlistQuery::forClass` stays the programmatic read path).

Out of scope: any domain/lifecycle change, new capabilities, automatic
promotion on seat freeing (offers stay a conscious staff act),
head-of-line enforcement beyond displayed positions, API changes.

## Consequences

- Tests prove the full operational arc over HTTP: fill → join with
  ordered positions → duplicate/seat-holder joins refused → join refused
  while not full → offer refused while full → free seat → offer →
  decline-by-expire → promote-into-requested → activate through the
  normal gate → join/withdraw the next entry, plus capability denials
  with governed errors and audited denials.
- One corrective migration (`000139`): the `000131` trigger forbade
  `offered → expired`, contradicting both this decision's ratified
  lifecycle and the certified `WaitlistLifecycle`. The guard now allows
  `offered → enrolled/expired`; all other edges are unchanged. No
  seeder change, no API change, no new capabilities.

## Rejected alternatives

- New `waitlist.*` capabilities — rejected; enroll / enroll_approve
  already govern the queue and staff sides and are bootstrapped.
- Auto-promoting the head entry when a seat frees — rejected; an offer
  is a conscious staff decision (the student may have left), and
  promotion stays capacity-checked at action time.
- Hiding the promote-from-`waiting` shortcut — rejected; it is a
  certified legal edge (`waiting → enrolled`, capacity-checked), so the
  console exposes the lifecycle exactly as ratified.
