# ADR: class provenance is the canonical scope for sessions

- **Status:** Accepted
- **Date:** 2026-09-05
- **Supersedes:** implicit class scope derived from an optional room, optional offering, or an organization-wide null scope

## Context

`offerings` and `academic_rooms` had direct branch ownership. Enrollments carried originating/current-home snapshots. `classes` had no branch column, so a room-less class/session could not be assigned a canonical branch. A read path that filtered only roomed sessions therefore exposed room-less operational records across branches, while some class commands passed null to branch authorization and failed to distinguish unknown provenance from global governance.

## Decision

Add `classes.branch_id` as immutable operational provenance. New class inserts require it through a database trigger and `MaintainClass`; historical nulls remain explicitly unknown and are not fabricated. A session inherits its class branch. A room used by a session must belong to the same branch. Timetable branch queries and Academic API/web session reads scope through the class, not through room presence.

Classes can still be created without an offering where the delivery design requires it; the class branch is the canonical scope in that case. Offering, enrollment, student, and room provenance remain useful related facts but do not compete with class operational scope.

## Consequences

- Room-less sessions can be safely filtered.
- Class transition, section, teacher assignment, and session commands can authorize against one target branch.
- Historical rows need remediation or deliberate quarantine; they cannot be guessed from a current room.
- The UI and transport contract must supply `branch_id` for new class definitions.

## Rejected alternatives

1. **Derive every class from room:** room is optional and can change; it is not class ownership.
2. **Derive every class from offering:** the existing class path does not require an offering, and an offering is a registration/delivery opportunity rather than the complete class identity.
3. **Treat null as organization-wide:** this would turn missing provenance into a privilege escalation and contradict fail-closed access semantics.

## Validation required later

Test direct SQL inserts, concurrent branch/room scheduling, historical null behavior, class IDOR, web/API parity, and migration upgrade behavior.
