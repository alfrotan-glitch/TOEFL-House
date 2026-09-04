# Level Progression, Prerequisites, Academic History & Offering-Linked Fee Packaging — Architecture Decision (AC4)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-04
**Applies to:** Academic progression/prerequisites/history + the finance-facing Academic packaging link.
**Supersedes:** nothing. Composes with ADR-016 (eligibility snapshot) and ADR-017 (enrollment financial gate).
**Related decisions:** G2-D-003 (no automatic progression without a program rule), WP2-DEC-02 (level is the target for progression/placement/fee packaging), WP2-DEC-03 (offering is the packaging unit finance consumes).

## Problem

ProgramVersionLevel and Offering exist, but levels are not yet consumed by progression, prerequisites, academic history, or finance-facing packaging. `ProgressionDecision` is class-scoped with only `advance`/`repeat`; there is no record of which level a student advanced from/to, no prerequisite or repeat/advance policy, no immutable per-level history fact, and no academic link on the financial obligation that would make a charge level-aware.

## Decision

1. **Academic owns level prerequisites and level progression rules** as configuration under the existing `academic.structure` capability. They are active/retired, audited, and never a derived projection.
2. **No automatic progression remains (G2-D-003 persisted).** The student never moves because of a score or report. Rules are preconditions that an Academic decision-maker must still consciously propose, review, and approve; violations fail closed and the decision records the basis/evidence.
3. **Progression becomes level-aware when its class/offering targets a level.** `progression_decisions` records `from_level_id`, `to_level_id`, `repeat_count`, `basis`, and an optional `assessment_result_id`. `advance` moves to the next level ordinal in the same program version; `repeat` stays at the same level. A level-aware `advance` past the last level is not legal here — completion/graduation is a separate decision.
4. **Immutable academic history.** An approved level-aware decision produces one immutable `level_progress_facts` row (student, program version, from/to level, class, offering, period, decision, optional result, outcome, repeat_count, achieved_at). Corrections to progression are existing appeal/supersede flow; the superseded original remains.
5. **Prerequisites are enforced at enrollment request and rechecked at level-aware progression.** A level's active prerequisites are satisfied when the student has an approved `level_progress_fact` with `outcome = advance` for each required level, or a released placement snapshot recommends that level/offering (placement-based placement override). Academic refuses the request when prerequisites are unsatisfied.
6. **Repeat/advance rules.** A per-level `level_progression_rule` may define a `minimum_passing_score` (required passed result for an advance) and `max_repeats` (a repeat beyond the cap is refused). Absence of a rule is not permission to invent a boundary — it means the Academic decision-maker decides without that numeric gate, still fully audited.
7. **Finance remains the sole financial authority; Academic stores no monetary truth.** The only financial-facing extension is the *Academic packaging link*: `obligations.offering_id` (nullable, Finance-owned, immutable after posting) references the Academic `Offering` (branch × level × term) that the charge belongs to. `PostObligation` validates the offering exists, is not cancelled, and belongs to an active enrollment of that student. Fee definitions/categories/amounts stay in Finance; Academic never produces an amount.
8. **Read-only consumers.** `AcademicHistoryQuery` and a level-aware packaging read model expose approved academic history and the current/latest level to Student, Placement, Enrollment, Documents, Reporting, and Finance for validation — they never become financial truth and never decide status.

## Consequences

- Existing pre-level classes keep NULL levels and the legacy class-scoped progression path (no level facts, no prerequisite gate).
- Prerequisite configuration is additive and fail-closed when it exists; no fabricated backfill for pre-existing students.
- Level-aware decisions are auditable, appealable, and historically reconstructable; supersession preserves the original fact.
- Finance obligation posting gains a validated academic packaging reference without a second accounting engine.
- Reporting/Documents consume verified history facts; a report cannot redefine progression.

## Rejected alternatives

- Auto-advance from a released score or rule alone — rejected; violates G2-D-003 and the frozen Academic control model.
- Storing fee amounts/categories/payment state in Academic — rejected; Finance owns fee definitions and all monetary truth.
- Free-text prerequisite strings — rejected; relational, version-scoped level prerequisites are required.
- Rewriting progression decisions on correction — rejected; append/supersede/history pattern is preserved.
