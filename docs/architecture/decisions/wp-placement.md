# Placement Decision System — Architecture Decision (WP-P)

Status: Accepted
Date: 2026-09-04
Scope: Placement Decision System (test bank → attempt → evidence → scoring → moderation → recommendation → release → appeal → retake)

## Context

The master engineering contract makes Placement a first-class academic
subsystem (contract §18. PLACEMENT CONTRACT) on the pipeline
`Visitor → Placement → Recommendation → Registration → Payment → Enrollment`.
The current Academic module only records a generic `assessment_attempt`
(`kind='placement'|'assessment'`) against an *active enrollment* and a
single `score` through a scored→moderated→approved→released chain. That
covers an in-program assessment, but not the placement decision lifecycle:
there is no authoritative test bank (tests, immutable versions, sections,
the five canonical V1 components Grammar/Reading/Listening/Writing/Speaking,
questions, media, rubrics), no server-authoritative digital/physical
delivery, no timing/answers, no component weighting, no CEFR mapping to
`ProgramVersionLevel`, no recommendation to `Class`/`Offering`, no
pre-enrollment placement profile, no retake/supersession, and no
anti-tamper evidence.

## Decision

Placement remains inside the **Academic** authority (Academic owns
placement attempts/results per `docs/implementation/08-academic-implementation-contract.md`).
It is implemented as `App\Modules\Academic\Placement\...` so the canonical
single-source-of-truth map is preserved:
`placement result → Placement authority`, and `placement recommendation →
Academic authority`, with the authoritative recommendation targeting
`ProgramVersionLevel` and an operational recommended `Class`/`Offering`
being an assignment that never replaces the academic recommendation.

Placement is **person-centric** (the subject may still be a visitor with a
linked Person; Applicant/Student not required yet), because the ratified
pipeline requires placement to happen before Registration and Enrollment.
An existing active enrollment is not a precondition for a placement
attempt. When the person already has a student record, it may be recorded
for traceability only.

### Domain boundaries

- Placement never creates Person, Applicant, Student, Enrollment, Payment,
  Obligation, Message, or Document. It consumes the authoritative
  Identity/Admissions/Student/Academic/Finance/Document facts and records
  evidence/traces only.
- Placement test catalog, sections, questions and rubrics are
  version-scoped, immutable once published, and never silently rewritten.
- Placement responses/answers and submitted attempts are immutable
  evidence; corrections are linked appends.
- A placement profile is the decision object: `draft → scored →
  recommended → reviewed → approved → released`, with `superseded` and
  `retired` closing a profile. At most one open/live profile per person.
- Retakes are explicit: the current live profile is superseded (history
  retained) and a new profile/attempt opens.
- Anti-tamper: submitted attempts carry a server-computed HMAC over the
  canonical evidence payload, duration envelope checks, unknown-question
  rejection, and checksummed media.
- Scoring is deterministic and explainable: section score → rubric band →
  CEFR; component weights → overall CEFR; overall CEFR → active
  `ProgramVersionLevel` of the target `ProgramVersion`; an open
  `Offering`/`Class` at that level is recommended as an operational
  assignment only.
- Finance/Admissions/Documents integration is via caller-authoritative
  downstream commands and trace recorders; Placement never delegates a
  downstream decision.

### Capabilities

- `placement.catalog` — maintain test bank, versions, sections, questions,
  media, rubrics.
- `placement.conduct` — open profile, start/submit digital or physical
  attempts (server-authoritative).
- `placement.score` — manual/professional scoring of non-auto-scored
  sections.
- `placement.moderate`, `placement.approve`, `placement.release` — staged
  decision chain with separation of duties.
- `placement.recommend` — generate CEFR/level/class recommendation.
- Retake and appeal reuse `placement.conduct` (retake) and the existing
  `academic.appeal_manage` (appeal), with `placement_profile` added as an
  appealable subject.

## Consequences

- New schema: `placement_*` tables with lifecycle CHECKs, provenance
  immutability, one-open-profile-per-person, immutable evidence, and
  append-only response/recommendation history.
- New command surface in `App\Modules\Academic\Placement\Commands`.
- Extension of `visitor_interactions` (migration 127) with a
  `placement_attempt_id` reference so the CRM/Finance/Communication trace
  recorder can follow placement evidence back to a lead.
- Reporting registry gains placement pipeline metrics.
- Tests cover the full placement decision journey and the guardrails.
