# Room, Section & Timetable Console Operations — Architecture Decision (AC10)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-06
**Applies to:** employee-console transport for academic rooms, class
sections, room/section-aware session scheduling, and the timetable read
surface.
**Supersedes:** nothing. Completes the WP-AR remainder ("rooms, sections
and timetable" — domain-certified, zero operational surface) without
touching the already-certified domain, mirroring the AC8 pattern.
**Related decisions:** WP-AR (rooms/sections/timetable domain:
`MaintainRoom`, `MaintainClass::defineSection/transitionSection`, room/
section-aware `scheduleSession`, `TimetableQuery`, migration `000132`
triggers); roadmap AC2; gap-matrix row I.

## Problem

The rooms/sections/timetable domain is complete and certified
(`AcademicRoomsAndSectionsFeatureTest`: room and section lifecycles,
room/section-aware scheduling, overlap rejection, timetable projection),
but it has **zero operational surface**: no controller, route, view, or
API endpoint references rooms, sections, or the timetable. In production
no room can be defined, no section opened, and no session can carry a
room or section — so the anti-double-booking invariant protects nothing
and there is no day view of who teaches where.

## Decision

1. **Console transport only; no domain change.** Five POST actions on the
   existing `AcademicController` + routes + cards on the session-calendar
   page: define room, transition room, resize room, define section,
   transition section. All authorization, guards, idempotency, and audit
   stay in the commands; capabilities are the existing
   `academic.structure` (rooms) and `academic.schedule` (sections,
   scheduling) — both already in the owner bootstrap, no seeder change.
2. **Scheduling gains the certified options.** The existing schedule form
   and `scheduleSession` action accept optional `room_id`/`section_id`
   (empty = none) and pass them to the certified domain path, which
   already validates open-section/available-room/class-match plus the
   trigger-level overlap guard. Session rows display room and section.
3. **Read surface from the existing query.** The sessions page passes
   rooms, sections, and branches, and renders a branch×day timetable via
   the certified `TimetableQuery::forBranch` (GET filter on the same
   page). Overlap rejection stays exactly where it is certified — the
   `000132` trigger raising `QueryException` — and is not re-implemented
   in transport.

Out of scope: any domain/lifecycle change, new capabilities, waitlist
operations (separate slice), progression rule/prerequisite management
(separate slice), API changes, print/export of timetables.

## Consequences

- Tests prove the full operational arc over HTTP: define → maintain →
   retire room; define → open section; schedule with room+section;
   branch×day timetable shows the booking; duplicate room code / section
   name, cross-class section, non-open section, unavailable room, and
   future-session close/retire blocks surface with governed error codes
   instead of state changes; capability denials redirect governed.
- No migration, no seeder change, no API change, no new capabilities.

## Rejected alternatives

- New `room.*` / `section.*` / `timetable.*` capabilities — rejected;
   structure and schedule authority already govern these operations and
   are bootstrapped.
- Pre-checking overlap in the controller for a friendly error —
   rejected; the trigger is the certified control and a transport
   pre-check would race it. Overlap stays domain-tested only.
- A separate timetable page — rejected; the day view belongs with the
   session calendar where scheduling happens.
