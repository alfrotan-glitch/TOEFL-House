# Level Progression Rules & Prerequisites — Architecture Decision (AC12)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-05
**Applies to:** employee-console transport for level prerequisites
(define/retire) and level progression rules (define/retire), plus the
review surface over both.
**Supersedes:** nothing. Completes the level-governance remainder
(`definePrerequisite/retirePrerequisite/defineProgressionRule/
retireProgressionRule` — domain-certified, zero operational surface)
without touching the already-certified domain, mirroring the
AC8/AC10/AC11 pattern.
**Related decisions:** AC4 (level-aware progression: rules consumed by
`DecideProgression` — minimum passing score gate, repeat cap, completed
prerequisites); WP2-DEC-02 (program-version levels); G2-D-003.

## Problem

Level governance is complete and certified
(`LevelProgressionFeatureTest`: same-version constraint, self-require
refusal, active-cycle refusal, score 0–100 bound, repeat floor,
one-active-rule-per-level, active-only retire, rule consumption by
progression decisions), but it has **zero operational surface**: no
controller, route, or view references prerequisites or progression
rules. In production no officer can declare that Elementary requires
Starter, set a pass mark, or cap repeats — the progression engine runs
without configurable governance.

## Decision

1. **Console transport only; no domain change.** Four POST actions on the
   existing `AcademicController` + routes + a "Level progression rules
   & prerequisites" card on the academic index: define/retire
   prerequisite, define/retire progression rule. All authorization,
   validation, cycle detection, idempotency, and audit stay in
   `MaintainAcademicStructure`; the capability is the existing
   `academic.structure` — already in the owner bootstrap, no seeder
   change.
2. **Review from existing data.** The index passes levels with their
   active rules and prerequisites for display; no new query surface.
3. **Level lifecycle stays domain-only.** There is no level retire
   command in the certified domain, so the console offers none — rules
   require active levels and the domain refuses otherwise with a
   governed error.

Out of scope: any domain/lifecycle change, new capabilities, level
define/retire transport, progression-decision transport (already
operational), API changes.

## Consequences

- Tests prove the full operational arc over HTTP: define rule with
  score + repeat bounds → duplicate refused → out-of-range score /
  zero repeats refused → retire → re-define allowed; define prerequisite
  → self-require refused → cycle refused → cross-version refused →
  duplicate refused → retire → retired re-retire refused; capability
  denial redirects governed with an audited denial.
- No migration, no seeder change, no API change, no new capabilities.

## Rejected alternatives

- New `level.*` governance capabilities — rejected; structure authority
  already governs these operations and is bootstrapped.
- Client-side cycle pre-check — rejected; the recursive-CTE guard is the
  certified control and a transport check would race it.
- Hiding retire in favor of delete — rejected; history is append-only,
  retirement is the ratified terminal state.
