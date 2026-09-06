# ADR: Scheduling owns planning constraints; Academic owns delivery facts

**Date:** 2026-09-05  
**Status:** Accepted for static implementation

## Decision

Create a Scheduling constraint boundary inside the modular monolith. Scheduling validates:

- active class lifecycle;
- class branch provenance;
- valid session time window;
- active teaching skill;
- open section belonging to the class;
- available room belonging to the class branch.

Academic Delivery remains the only writer of `class_sessions` and remains responsible for delivery lifecycle, attendance, assessment, and academic evidence. Database uniqueness/exclusion/locking constraints remain the final concurrent race arbiter.

## Rejected alternatives

- Keeping every planning constraint embedded in `Academic\\Commands\\MaintainClass`: rejected because it makes Scheduling a hidden Academic responsibility.
- Adding a second session/schedule table: rejected because it duplicates the delivery fact.
- Letting the frontend resolve conflicts: rejected because UI checks are advisory only.

## Implementation

`App\\Modules\\Scheduling\\Domain\\SchedulingConstraints` is called from `MaintainClass::scheduleSession` before the existing Academic session write. The service reads canonical Academic/Organization facts but does not write them. Existing Academic section/skill management remains in Academic because those are their respective catalog/fact authorities.

Enrollment remains a separate unresolved boundary: the existing `enrollments` authority and command are still in Academic, and no duplicate enrollment table was added in this static slice.
