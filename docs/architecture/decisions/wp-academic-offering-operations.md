# Offering & Availability Console Operations — Architecture Decision (AC8)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-04
**Applies to:** employee-console transport for branch availability and
offering lifecycle; seat requests targeting an offering.
**Supersedes:** nothing. Completes the F3 remainder ("availability/offering
lifecycle is not modeled [in operations]; no branch×term availability
query/UI surface") without touching the already-certified domain.
**Related decisions:** WP2-DEC-03 (offering is the packaging unit finance
consumes), WP-3 AC3 (enrollment→offering re-point, domain-certified).

## Problem

The branch-availability + offering domain is complete and certified
(`MaintainAcademicStructure::declareBranchAvailability/openOffering`,
`ManageAcademicOffering` close/reopen/cancel/complete/resize with guards,
`OfferingCatalogQuery::catalogue`), but it has **zero operational surface**:
no controller, route, view, or API endpoint references it. In production no
availability can be declared and no offering opened — and the console seat
request does not even accept the domain-supported `offering_id`, so the
enrollment→offering→Finance-obligation packaging link is dormant
end to end despite being domain-certified.

## Decision

1. **Console transport only; no domain change.** Ten POST actions on the
   existing `AcademicController` + routes + an "Availability & offerings"
   console card: declare availability, open offering, close/reopen
   availability, close/reopen/cancel/complete offering, resize offering
   capacity. All authorization, guards, idempotency, and audit stay in the
   commands; the capability is the existing `academic.structure` (already in
   the owner bootstrap — no seeder change).
2. **Seat requests may target an offering.** `requestEnrollment` accepts an
   optional `offering_id` (empty = none) and passes it to the certified
   domain path, which already validates open/matching offering + capacity.
   The Seats card request form gains an offering selector.
3. **Read surface from existing queries.** The index passes branches,
   levels, availabilities, and offerings for selects and tables; no new
   query surface (the certified `catalogue()` stays the programmatic read
   path).

Out of scope: any domain/lifecycle change, new capabilities, gradesheets
(queued next capability slice), per-branch finance/reporting consumers
(WP-2 F1 / WP-4).

## Consequences

- Tests prove the full operational arc over HTTP: declare → open →
  request-with-offering → activate → close refuses new seats → resize floor
  on active seats → cancel/availability-close guards with open seats →
  terminalize seats → cancel → close → reopen, plus capability denial and
  the offering-less request path.
- No migration, no seeder change, no API change.

## Rejected alternatives

- New `offering.*` capabilities — rejected; structure authority already
  governs these operations and is bootstrapped.
- Auto-opening offerings from class activation — rejected; availability is
  a conscious branch×level×term declaration (F3 co-dependency), never
  inferred.
