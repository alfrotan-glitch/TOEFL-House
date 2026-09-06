# Class Gradesheets — Architecture Decision (AC-gradesheets)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-05
**Applies to:** per-class grade compilation reads; teacher-side access to
assigned classes; console presentation of the certified result chain.
**Supersedes:** nothing. Completes the row commanded by the gap matrix
("Class gradesheet: per-class result entry, teacher view, corrections" —
STATUS: GAP) and the transcript ADR's explicit deferral ("Class
gradesheets are transcript consumers, a separate slice").
**Related decisions:** WP-academic-results-accuracy (certified result
chain: submit → score → moderate → approve → release, staged corrections,
SoD exclusions, attestations); prior console slices
(`AcademicController` row-mutation transport); Finance as sole financial
authority (no Finance touch here: gradesheets are reads over academic
history).

## Problem

The result chain is domain-certified and console-operable, but only as
**global work queues** on the academic index: any employee sees every
submitted/scored/moderated/approved result and every open correction
regardless of class. There is **no per-class compilation** (roster ×
attempts × live result × correction lineage), **no teacher scoping** (row
mutations are keyed only on `academic.assess` — the employee flag is
per-row, not per-class), and correction lineage plus released-truth parity
with transcripts/progression is data-present but **unsurfaced per class**.
In production a teacher cannot open "my class's gradesheet", and an
academic officer has no compiler view to confirm a class is fully
entered, moderated, approved, and released.

## Decision

1. **No domain change.** The certified row-level chain
   (`submit/score/moderate/approve/release`, `propose/approveCorrection`,
   attestations, SoD, `corrects_id` supersede-by-reference) stays the only
   mutation path. The gradesheet is a **read compilation**, never a writer.
2. **New read surface: `GradesheetQuery`.** `forClass(Actor, classId)`
   compiles: class header (id, state, capacity, program version, period,
   level if any), open teachers, seats (all enrollment states except
   `requested` — a seat that never joined has no grades), per-seat attempts
   with live result (latest non-`corrected` row, exactly the transcript's
   resolution), full correction history per attempt (including `corrected`
   rows with `corrects_id` + reason), and open corrections. Official lines
   are the released subset — **parity with `TranscriptComposer::results` is
   a tested invariant**, not an aspiration.
3. **Viewer rule (the only new authorization).** A viewer may open a class
   gradesheet iff they hold an **open teacher assignment on that class**
   (identity match `teacher_person_id == actor.actorId`, `effective_to`
   null — in Legacy the teacher assignable IS the subject teacher) **or**
   academic oversight: any of `academic.assess|moderate|approve_result|
   release|structure`. Denials are thrown as `AuthorizationDenied` and
   recorded via the standard `AttemptedOperation::deniedByActor` audit
   (reads deny loudly, exactly like commands).
   `accessibleClasses(Actor)` scopes the index class selector by the same
   rule (assigned classes for teachers; all recent for oversight).
4. **One GET console route + view, mutating only through the certified
   chain.** `GET /academic/gradesheets/{classId}` reuses the existing
   controller redirect/flash/denial handler; the page embeds the existing
   score / propose-correction / release forms keyed by attempt/result id
   (no new commands, no new POST routes). Released truth stays
   visually distinct (official lines) from in-flight work (queues).
   Roster/queue tables already on the index are untouched.

Out of scope: any domain/lifecycle/capability/migration/seeder change;
print/export of gradesheets; derived or stored official marks (released
results remain the single source of truth); Finance consumers (gradesheets
carry no financial meaning).

## Consequences

- Tests prove over HTTP: teacher opens own class, denied elsewhere
  (redirect-home + governed error, audited denial); officer sees all;
  submitted→scored→moderated→approved→released flow reflected per seat;
  correction lineage shown and supersede-by-reference preserved;
  gradesheet official lines equal transcript official lines for the same
  students; released result after seats complete feeds progression.
- No migration, no seeder change, no API change, no new capabilities.

## Rejected alternatives

- Teacher-scoped mutation capabilities (`assess` per class) — rejected;
  row-level SoD + chain order is the certified control, class-scoped
  capabilities would fork the authority model.
- Storing compiled marks on the class/enrollment — rejected; append-only
  academic history forbids derived-state writes, the compilation is a read.
- Class selector reusing the global unscoped class list — rejected; the
  selector is scoped by the same viewer rule so teachers are never offered
  classes they cannot open.
