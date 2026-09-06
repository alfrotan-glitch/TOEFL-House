# Academic Classes API and authority convergence — 2026-09-06

## Scope

This is a static implementation review for the canonical Academic authority. It does not claim runtime, PostgreSQL, migration, build, browser, or production readiness. The interactive Academic Classes workspace remains the React projection at `/academic`; the versioned transport is `/api/v1/academic`.

## Canonical command matrix

| Fact/workflow | Canonical command | Versioned API boundary | Read projection |
|---|---|---|---|
| Program, version, level, period | `MaintainAcademicStructure` | `/programs`, `/programs/{id}/versions`, `/levels`, `/periods` | `program_versions`, `levels`, `periods` |
| Branch availability and offering | `MaintainAcademicStructure`, `ManageAcademicOffering` | `/availabilities`, `/offerings`, offering/availability transitions and resize | `availabilities`, `offerings` |
| Class, section, teacher, room, session | `MaintainClass`, `MaintainRoom` | `/classes`, `/sections`, `/teacher-assignments`, `/rooms`, `/sessions` | `classes`, `sessions`, `teachers`, `rooms` |
| Enrollment, capacity, waitlist | `MaintainEnrollment`, `ManageClassWaitlist` | `/enrollments`, enrollment transitions, `/waitlist`, waitlist transitions | `enrollments`, `waitlist`, server-derived seat counts |
| Attendance | `RecordAttendance` | `/sessions/{id}/attendance`, `/attendance/{id}/correct` | append-only `attendance` facts |
| Assessment and correction | `ManageAssessmentResult` | `/attempts`, `/results`, `/corrections` | `attempts`, `results` |
| Progression | `DecideProgression` | `/progressions` and progression transitions | `progressions` |
| Graduation and certificate | `DecideGraduation` | `/graduations`, graduation transitions, certificate issuance | `graduations` |
| Official transcript | `IssueTranscript` | `/transcripts` | immutable `transcripts` metadata and hash |
| Academic appeal | `ManageAcademicAppeal` | `/appeals`, assignment, appeal transitions | `appeals` |
| Placement catalog/profile and report | `MaintainPlacementCatalog`, `ManagePlacementProfile`, `RegisterDocument` | `/api/v1/placement` catalog, attempt, profile, report, and appeal routes | placement tests, profiles, Documents versions |

Every mutation endpoint is a transport adapter. It validates shape, resolves the requested aggregate, supplies the actor and idempotency key, and delegates policy, lifecycle, scope, provenance, audit, and outbox behavior to the command. No API or React code calculates capacity, financial standing, eligibility, progression, grading, or appeal redress.

## Static authority corrections

- Legacy Academic operations for setup, rooms, dated teacher assignment history, enrollment exit/transfer, waitlist expiry, graduation, transcript, offering/availability, and appeals now have equivalent versioned API routes. They do not create a parallel write path.
- The workspace exposes server-provided branch capability maps and lifecycle state. Class rows may be visible to any relevant Academic read scope, but sessions, seats, students, outcomes, offerings, and records are independently filtered by their owning capability scope. The Records tab only renders graduation/certificate/transcript/appeal controls when the projection says the actor can perform that action; required appeal remediation remains on the contested subject authority.
- Enrollment activation and transfer now lock class capacity rows before enrollment rows. Waitlist offer/promotion also lock class rows before waitlist rows and the nested enrollment command. Assessment correction approval locks the original result before the correction row. These orders align class-capacity and aggregate lifecycle operations and reduce lock-cycle risk.
- The consolidated database authority migration now guards graduation signer/lifecycle identity, appeal lifecycle/decision evidence, nullable pre-Student placement appeals, one open appeal per subject, class/offering/period references, live-seat capacity, waitlist references, session identity/scope, attendance identity, assessment evidence and signer transitions, progression transitions, and teacher assignment temporal overlap.
- Transcript rows remain immutable and are rendered from their frozen payload/hash; Finance remains the only monetary authority for enrollment gates and certificate visibility.
- Placement catalog/profile/report operations now have equivalent JSON adapters; placement remains owned by its dedicated commands and its pre-Student appeal subject is projected by placement-profile provenance rather than a fabricated student scope.
- Progression appeal resolution is a staged two-actor flow: the independent reviewer is recorded in `appeal_reviewed_by` when a decision enters `appealed`, and only a distinct authenticated approver can supersede it. Client input cannot nominate or impersonate the prior reviewer.

## Remaining static limit

PostgreSQL trigger ordering and syntax, pre-existing historical rows, migration rollback behavior, dependency injection, route execution, capability fixtures, concurrent transactions, queue delivery, projection freshness, TypeScript compilation, accessibility behavior, and browser behavior remain unexecuted by instruction. No production-readiness conclusion follows from this static review.
