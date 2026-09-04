# Academic Rooms, Class Sections and Timetable — Architecture Decision (WP-AR)

Status: Accepted
Date: 2026-09-04
Scope: Academic rooms, class-level sections and the room/timetable scheduling
surface.

## Context

The Academic Delivery checkpoint certified classes, one-off sessions, teacher
assignment and attendance, but the WP-1 gap matrix (row I) lists three
delivery gaps that the previously delivered offering/availability slice does
not close: no room resource, no named section within a class, and no
room/timetable scheduler beyond a single `ClassSession` on a `ClassModel`.

## Decision

Rooms and sections remain inside the **Academic** authority. A room is a
branch-owned physical/timetable resource. A section is a named operational
group within a class; it carries its own capacity and lifecycle so a class
can run parallel delivery groups without inventing a new enrollment authority
(class and offering remain the seat-accounting targets). A class session may
optionally target a room and a section.

### Lifecycles

- `AcademicRoom`: `available ↔ maintenance`, `available/maintenance → retired`;
  `retired` terminal.
- `ClassSection`: `planned → open/cancelled`, `open → closed/cancelled`,
  `closed → archived`, `cancelled → archived`; `archived` terminal.

### Scheduling invariants

- A session references a room only if the room is `available`.
- A session references a section only if the section is `open` and belongs to
  the session's class.
- A room cannot host overlapping sessions (same day, overlapping time).
- A class cannot run overlapping whole-class sessions (no section), and a
  section cannot run overlapping sessions with itself.
- `room_id`, `section_id`, scheduled date and times are immutable on an
  existing session after scheduling (a correction is a rebooking through a
  new session after cancelling/archiving the old one).

### Capabilities

- `academic.structure` — define and transition rooms/sections, resize room
  capacity.
- `academic.schedule` — schedule sessions with optional room/section.

## Consequences

- Migration `2026_09_04_000132_add_rooms_sections_and_timetable.php` adds
  `academic_rooms`, `class_sections`, room/section columns on
  `class_sessions`, and the timetable/immutability triggers.
- New command surface: `MaintainRoom`; `MaintainClass` gains
  `defineSection`/`transitionSection` and room/section-aware `scheduleSession`.
- New query: `TimetableQuery` (by room, by class/section, by branch/day).
- Tests cover room and section lifecycles, scheduling with room/section,
  double-book rejection, retired-room rejection, and timetable projection.
