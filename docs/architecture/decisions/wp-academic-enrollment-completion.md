# Enrollment Completion Lifecycle — Architecture Decision (AC5)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-04
**Applies to:** Academic enrollment freeze / unfreeze / withdraw / complete.
**Supersedes:** nothing. Composes with ADR-016 (eligibility snapshot), ADR-017
(enrollment financial gate), ADR-018 (level progression / prerequisites /
history, AC4) and WP-AR (rooms / sections / timetable).
**Related decisions:** WP2-DEC-02 (level is the target for progression),
WP2-DEC-03 (offering is the packaging unit finance consumes), G2-D-003 (no
automatic progression without a program rule — extended here to no automatic
completion).

## Problem

`MaintainEnrollment` owns the seat lifecycle `requested → active ⇄ frozen`
plus terminal `transferred / withdrawn / completed`, but the exit half is
unfinished (WP-1 matrix row H, roadmap WP-3 AC3 remainder):

- `freeze` and `withdraw` take no reason: a seat can be frozen or withdrawn
  with no recorded human justification, and the row carries no trace of why.
- There is **no `unfreeze` command**: the lifecycle registry allows
  `frozen → active`, but no public command exposes it, so a frozen seat is a
  dead end — a frozen student can never return through the domain.
- `complete` takes no basis and no evidence: any approver can mark any active
  seat completed with no attestation and no assessed delivery behind it. On a
  level-aware class this bypasses the entire AC4 chain in spirit — a
  completion with zero released assessment or approved progression behind it
  is not world-class academic truth. `complete` additionally has no console
  route and no callers: the completion half of the lifecycle is unreachable
  end to end (the same dead-end class the PHASE_3 transport audit closed for
  seat request/activation).
- None of freeze / withdraw / complete records the Finance standing at exit:
  the roadmap's "freeze-with-financial-implications" remainder is unaddressed.
  Activation is financially gated (ADR-017), but a seat that freezes while
  unpaid and later returns would re-enter without any re-assessment — a gate
  bypass the moment an unfreeze path exists.

Transfer provenance (F1 command paths, Organization/Access owned) and the
FIN4 per-case aid model (Finance owned) are explicitly **out of scope** here;
they remain WP-2-F1 / WP-4 work.

## Decision

1. **Reasoned freeze / withdraw.** `freeze` and `withdraw` require a
   non-empty human reason (`academic.enrollment_reason_required` otherwise).
   The reason is stored on the row (`enrollments.state_reason`, current-state
   projection) and frozen into the audit event payload. History stays in the
   append-only audit trail; the row carries the current state's reason.
   Capabilities are unchanged: `academic.enroll_approve` for freeze,
   `academic.enroll` for withdraw.
2. **Unfreeze with financial re-gate.** New `unfreeze` command
   (`academic.enroll_approve`): `frozen → active` re-checks student active,
   class active, class capacity and offering capacity, then re-runs the
   Finance gate exactly like activation — fresh signed evidence is frozen on
   the row and an unsatisfied gate refuses the return with
   `academic.enrollment.financial_gate` plus the denied-gate audit. The frozen
   seat holds no capacity claim while frozen (capacity counts `active` seats
   only — unchanged), so a full class refuses the return (`academic.class_full`
   / `academic.offering_full`). `state_reason` is cleared on return.
3. **Finance-read exit snapshots.** Freeze, withdraw and complete embed a
   Finance-authoritative exit snapshot — `satisfied`, `remaining`, digest and
   signature from the existing `FinancialGateQuery::assess` — into their audit
   events. This is read-only consumption through the ADR-017 boundary:
   Academic writes no Finance facts, freezes no second balance ledger, and
   never overwrites the activation gate evidence on the row (that history is
   preserved; exit snapshots live in audit). Refunds/credits/installments
   remain exclusively Finance-owned workflows.
4. **Evidenced completion.** `complete` (`academic.enroll_approve`,
   `active → completed`, terminal) requires an explicit non-empty
   `completion_basis` (human attestation — G2-D-003 extended: no automatic
   completion) and verified evidence pinned on the row
   (`completion_evidence_kind/id`):
   - on a **level-aware class** evidence is mandatory
     (`academic.enrollment_completion_evidence_required`): either a
     `released` assessment result belonging to the enrollment, or an
     `approved` progression decision for the same student and class;
   - on a **legacy (non-level) class** the certified basis-only path is
     preserved: evidence is optional but, when supplied, is verified the same
     way;
   - unknown kinds (`academic.enrollment_completion_evidence_unknown`) and
     foreign evidence (`academic.enrollment_completion_evidence_mismatch`)
     fail closed.
   Completion ordering falls out of the existing invariants: progression
   requires an active/frozen enrollment and results attach to active
   enrollments, so assessed delivery necessarily precedes the terminal mark.
5. **End-to-end integration.** The four transitions are exposed on the
   employee web console (routes + controller + views) with the same
   session-bound actors, idempotency keys and error-code surfacing as the
   request/activate transport. No new JSON API surface: the enrollment
   lifecycle stays console-operated by the request/activate precedent.

## Consequences

- Migration `2026_09_04_000136_enrollment_completion_lifecycle.php` adds
  `state_reason`, `completion_basis`, `completion_evidence_kind` (CHECK) and
  `completion_evidence_id` (paired-null CHECK) to `enrollments`. No trigger:
  reasons are attested text, not monetary invariants; authority stays in the
  commands + audit.
- `ClassRosterQuery` seat rows carry `state_reason` so rosters show why a
  seat is frozen.
- Existing `freeze`/`withdraw` callers pass explicit reasons (2 test
  call sites); no production callers exist outside the commands.
- Tests cover reason/basis requirements, capability separation, unfreeze
  re-gate (deny-then-pay-then-return), capacity interplay, completion
  evidence rules (mandatory on level classes, optional on legacy, foreign
  evidence refused), exit-snapshot audit payloads, and HTTP transport.

## Rejected alternatives

- Silent (reason-free) state changes — rejected; unattributed lifecycle moves
  are not auditable academic history.
- Unfreeze without re-gate — rejected; re-entry without assessment re-opens
  the ADR-017 gate it took activation to satisfy.
- Academic-written refunds/credits on withdraw/freeze — rejected; Finance is
  the sole financial authority (06-financial-architecture, D-G3-001).
- Overwriting the activation gate evidence at exit — rejected; it would
  destroy the activation-time history the gate denial path relies on.
- Auto-completion from a released score or rule alone — rejected; violates
  the G2-D-003 control model extended to completion.
