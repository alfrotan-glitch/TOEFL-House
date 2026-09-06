# Academic Operational Completion — Architecture Decision (AC14)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-06
**Applies to:** employee-console transport closing the four remaining
Academic operational gaps: level definition (R1), level targeting on
class creation (R2), seat transfer (R3), attendance correction (R4).
**Supersedes:** nothing. Lifts the AC12 deferral of "level define/retire
transport" for the define half; there is no retire-level command by
design (levels are append-only history, like program versions).
**Related decisions:** AC4 (level-aware progression), AC5 (enrollment
completion/transfer domain), AC10 (sessions/attendance transport),
AC12 (rules/prerequisites governance), G2-D-003, BR-ACAD-002; Finance
authority untouched (transfer re-enters the financial gate at
activation; corrections carry no financial meaning).

## Problem

Four certified domain behaviors have zero employee surface: levels can
only be created by command-line/tests, so no level-aware delivery can
be stood up in production; classes cannot target a level at creation
(the command accepts `programVersionLevelId`, the console drops it);
`MaintainEnrollment::transfer` closes history into a fresh requested
seat but no employee can invoke it; `RecordAttendance::correct` keeps
append-only correction lineage but attendance errors are unfixable in
production and feed payroll evidence permanently.

## Decision

1. **Console transport only; no domain change.** Four additions on the
   existing `AcademicController` + routes + views, all delegating to
   the certified commands with existing capabilities (no seeder
   change): `defineLevel` (`academic.structure`), level-targeted
   `defineClass` (optional `program_version_level_id`, same
   `academic.schedule` authority), `transferEnrollment`
   (`academic.enroll_approve`), `correctAttendance`
   (`academic.attendance`, reason mandatory).
2. **History stays append-only.** Transfer never mutates: the old seat
   closes as `transferred` (active seats only, per the lifecycle) and
   the new seat starts `requested`, re-entering approval and the
   financial gate at activation. Corrections append a new fact linked
   by `corrects_id`; the original row is never edited.
3. **No provenance fabrication.** Transfer populates only what the
   certified command already populates (snapshot id, offering); F1
   branch-designation wiring stays out of scope.
4. **Governed refusals surface, not new rules.** Duplicate level
   key/ordinal, archived-program levels, cross-version class levels,
   same-class transfer, transfer of non-active seats, full target
   classes, and reason-less corrections all surface as redirects with
   the certified error codes.

Out of scope: any domain/lifecycle change, new capabilities, level
retirement (no such command by design), placement catalog remainder
(R6), appeal-linkage enforcement (R7), calendar integration (R8),
API changes.

## Consequences

- Tests prove over HTTP: level define (incl. duplicate-key/ordinal
  and archived-program refusals) → level-targeted class define (incl.
  cross-version refusal) → seat transfer with lineage into a requested
  seat (incl. same-class and frozen-seat refusals) → activation of the
  transferred seat → attendance correction with lineage (incl.
  reason-required and cross-enrollment refusals) → capability denials
  governed and audited.
- No migration, no seeder change, no API change, no new capabilities.
