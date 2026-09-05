# Class & Period Terminal Guards — Architecture Decision (audit blocker 2)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-05
**Applies to:** `MaintainClass::transition` (class → cancelled/completed),
`MaintainAcademicStructure::transitionPeriod` (period → closed).
**Supersedes:** nothing.
**Related decisions:** wp-academic-offering-operations (offering
cancel/complete guards), wp-academic-graduation-integrity (graduation
open-seat gates), wp-academic-enrollment-completion (seat completion
evidence), wp-academic-operational-completion.

## Problem

The class and period terminal transitions were state-machine checks only:
a class with live (requested/active/frozen) seats could move to
cancelled/completed, and a period carrying live classes and seats could
close. The stranded seats keep no defined delivery semantics — scheduling
and attendance already require an active class, assessment attempts
require an active seat — so terminalizing the parent orphans the seats it
carries and breaks the evidenced completion chain (assessment →
progression → graduation → transcript) that downstream authorities read.

## Decision

1. **Fail-closed, no exceptional path.** Class → cancelled/completed is
   refused with `academic.class_open_seats` while any enrollment on the
   class is requested/active/frozen. Period → closed is refused with
   `academic.period_open_classes` while any class in the period is
   planned/published/active, and with `academic.period_open_seats` while
   any enrollment on the period's classes is requested/active/frozen. An
   audited override was considered and rejected: it would create a second
   authority contradicting the seat lifecycle, while every legitimate
   flow already has a legal path — withdraw (reasoned), transfer, or
   evidence-bound complete each seat, then transition the class; close
   the period once its classes are terminal.
2. **Same doctrine as the ratified precedents.** Offering cancel/complete
   refuses on open seats (`academic.offering_open_seats`); graduation
   approval/issuance refuses on open seats
   (`academic.graduation_open_seats`). The live-seat set
   (requested/active/frozen vs withdrawn/transferred/completed) is the
   same set the duplicate-seat, transfer, and waitlist guards already use.
3. **Guards run inside the transition transaction on locked rows.** The
   class row is already locked; the guard additionally locks the live
   seat rows (`FOR UPDATE`) so a concurrent seat mutation serializes
   against the guard instead of slipping past it. `transitionPeriod`
   additionally re-reads and locks the period row like every other
   transition command. Class-row reads in the period guard are safe
   without locks because class terminality is monotonic (cancelled /
   completed / archived have no outgoing transitions except
   cancelled/completed → archived, which stays terminal); a stale read
   can only refuse conservatively, never wrongly permit. Seat terminality
   is likewise monotonic.
4. **No guard on non-terminal or inheriting transitions.**
   planned/published/active, period published, and archived (reachable
   only from already-guarded cancelled/completed) are unchanged.
   Downstream readers (attendance, assessment scoring/release,
   progression, graduation, transcripts, audit history) are untouched:
   they keep working on terminal classes because they key off terminal
   seats and pinned evidence, not class liveness.

## Consequences

- Cancelling/completing a class or closing a period with live delivery
  outstanding is a governed 409 with a stable code, on every transport
  (command, console, API) since the check lives in the commands.
- The legal terminal arc is: terminalize seats → complete/cancel class →
  archive; close the period once its classes are terminal. Tests pin the
  refusals, the arc, irreversibility, delivery freeze after completion,
  and history preservation.
- Residual, accepted: a seat *insert* racing the guard commit (new
  request landing between the guard read and the state write) is not
  closed — the identical characteristic the ratified offering guard
  carries, and closing it would require rewiring seat creation, which is
  out of scope for this blocker.

## Rejected alternatives

- Audited exceptional path (override + audit event) — rejected; second
  authority contradicting the seat lifecycle, new bypass surface, no
  legitimate flow needs it.
- Guarding archived or non-terminal transitions — rejected; archived
  inherits cleanliness from the guarded states, and gating delivery
  states would break scheduling/activation.
- Cascading the transition onto seats (auto-withdraw) — rejected;
  terminal seat states carry required reasons/evidence that only the
  seat-level commands can attest; silent mass-withdrawal would fabricate
  history.
