# Progression Decision Lifecycle — Architecture Decision (AC13)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-05
**Applies to:** employee-console transport completing the progression
decision lifecycle: evidence-carrying proposals, reject, appeal marking,
and appeal-resolution supersession with lineage.
**Supersedes:** nothing. Completes the `DecideProgression` remainder
(propose/review/approve are already operational via
`TransportWorkflowFeatureTest`) without touching the certified domain.
**Related decisions:** AC4 (level-aware progression + facts),
AC12 (rules/prerequisites governance), G2-D-003, BR-ACAD-002 (no
automatic advance); Finance authority untouched (completion evidence
already validates approved decisions).

## Problem

The progression lifecycle is certified end to end
(`AcademicDecisionFeatureTest`: staged SoD, level gates, facts,
appeal → supersede lineage), but the console exposes only
propose/review/approve — and proposals carry no evidence fields. In
production a reviewer cannot refuse a bad proposal, an approved decision
cannot be marked appealed, an appeal outcome cannot supersede the
original, and level-aware proposals cannot cite their basis or result —
so the appeal/supersede lineage and the completion-evidence close-out
are unreachable.

## Decision

1. **Console transport only; no domain change.** Three POST actions +
   routes: reject a reviewed decision, mark an approved/rejected
   decision appealed, supersede an appealable decision. All
   authorization, independence checks, gate revalidation, fact writing,
   idempotency, and audit stay in `DecideProgression`; capabilities are
   the existing `academic.progression_review` (mark appealed,
   supersede-as-reviewer) and `academic.progression_approve` (reject,
   supersede-as-approver) — both already in the owner bootstrap, no
   seeder change. The certified `reject` and `markAppealed` calls take
   no reason/context parameter, so transport adds none: the signer and
   the audit event are the record. The certified `supersede` call
   returns an array (`decision_id`, `superseded_id`), not a model.
2. **Proposals carry evidence.** The existing propose form and action
   accept optional `assessment_result_id`, `basis`, and `repeat_count`
   (empty = none) and pass them to the certified path, which resolves
   levels, requires the basis on level classes, and refuses level-aware
   fields on legacy non-level classes with governed errors.
3. **Supersession signs in one session, governed by the domain.** The
   certified call takes reviewer + approver; the console passes the
   session employee for both (no colleague-id fields anywhere in
   transport, per the ratified transport rule). The domain still bars
   the original proposer (`academic.appeal_not_independent`), requires
   both capabilities, writes the successor approved with its fact, and
   links `superseded_by_id` lineage. Distinct reviewer/approver pairs
   stay covered at command level.
4. **Read surface from existing data.** The index additionally passes
   decided rows (approved/rejected/appealed/superseded) with per-state
   actions and successor linkage; the certified `AcademicHistoryQuery`
   stays the programmatic read path.

Out of scope: any domain/lifecycle change, new capabilities, appeal
commands themselves (already operational), staged two-session
supersession (no domain primitive), API changes.

## Consequences

- Tests prove the full arc over HTTP: evidence proposal (incl.
  basis-required and open-decision refusals) → review (incl.
  self-review refusal) → approve with fact → appeal filed → marked
  appealed → superseded with lineage + successor fact → seat completed
  on the successor evidence (and refused on the superseded original) →
  reject path → proposer-supersede SoD refusal → capability denials
  governed and audited.
- No migration, no seeder change, no API change, no new capabilities.

## Rejected alternatives

- New `progression.*` appeal/supersede capabilities — rejected; review
  and approve authority already govern these operations.
- Two-employee console supersession via a colleague-id field — rejected;
  transport never types a colleague's id; the domain's
  proposer-exclusion is the certified SoD control.
- Auto-marking decisions appealed on appeal filing — rejected; marking
  is a conscious reviewer act on the certified call.
