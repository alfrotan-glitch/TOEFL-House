# Official Transcript Issuance — Architecture Decision (AC7)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-04
**Applies to:** Academic transcript composition, issuance, printing, document governance.
**Supersedes:** nothing. Composes with ADR-016 (eligibility snapshot), ADR-017
(enrollment financial gate), ADR-018 (level progression / history, AC4), AC5
(enrollment completion lifecycle) and AC6 (graduation integrity / certification).
**Related decisions:** WP2-DEC-02 (level is the target for progression),
WP2-DEC-03 (offering is the packaging unit), G2-D-003 (no automatic academic
outcomes), 06-financial-architecture + D-G3-001 (Finance sole authority),
MD-022 (permanent academic outputs + document verification).

## Problem

AC1–AC6 built the complete Academic evidence→decision chain (placement with
signed snapshots, attendance, assessed results with corrections, level-aware
progression with immutable history, evidenced completion, governed graduation
with certificate issuance) — but the school still cannot produce the one
certified record every student, parent, and receiving institution asks for:
the **official transcript**. Matrix rows J ("official transcripts/gradesheets
as reporting output"), U (verification lifecycle) and the facet "immutable
reporting / print snapshots: Missing" all point here, and AC6 explicitly
deferred it as a separate slice. Today the only outputs are the certificate
(a terminal award, not a record of study) and live-derived prints.

A transcript differs from the certificate in one structurally decisive way:
its source facts keep accumulating. A live re-derivation at print time would
show post-issuance achievements — historically false. The issuance must
therefore **freeze its content** at issuance time.

## Decision

1. **Academic-owned issuance, like certificates.** The transcript is a
   certified extract of immutable Academic truth, not a derived Reporting
   metric: it is issued by the Academic `IssueTranscript` command
   (`academic.transcript_issue`, single-step — the underlying facts are
   already governed), stored as an immutable `transcripts` row, and governed
   as a managed document. Reporting's closed metric catalog is untouched.
2. **Frozen payload, hashed and pinned.** Issuance composes the canonical
   payload (schema `transcript/v1`), stores it as JSONB on the row, and pins
   `content_hash = SHA-256(canonical(payload))`. Prints render the STORED
   payload, never a re-derivation. Re-issuance after new achievements
   produces a NEW record; the old one keeps evidencing history as of its
   issue date. `transcripts` gets the same BEFORE UPDATE OR DELETE
   immutability trigger as `certificates`.
3. **Content is pinned text over immutable facts, per student + program
   version:** student code + legal name; program/version names; entry
   placement (snapshot id, recommended level title/CEFR, digest) when present;
   level progress facts in order (level titles/ordinals/CEFR, class, period
   name, outcome, repeat count, decision, linked released score, achieved
   date); current released (non-superseded) result per attempt with score;
   terminal seats with state (+ completion basis/evidence kind when
   completed); in-progress seats in a clearly marked separate section;
   attendance totals per seat over latest-per-session facts
   (present/absent/late/excused); graduation decision + certificate serial
   when present; issuer + issued-at. Display names are pinned as text so
   later renames cannot rewrite issued history. No Finance content:
   financial standing is not academic truth (MD-022 clearance was
   graduation-scoped; the transcript records study, not accounts).
4. **Document governance mirrors certificates.** Issuance resolves the
   registrar-defined `academic.transcript` classification (fail closed
   `academic.transcript_classification_missing`), registers + submits the
   managed document (title carries student code, program, issue date;
   locator `transcripts:{id}`), and pins `transcripts.document_id` at
   INSERT. The issuer needs `documents.register`; verification/activation
   stay registrar acts through the existing Documents transport.
5. **Transport on existing patterns.** Console issue action + route
   (`academic.transcript.issue`), a Transcripts section in the Academic
   console, and a print route/view rendering the stored payload. No new JSON
   API surface (certified outputs stay console-operated by precedent).

Out of scope: class gradesheets (teacher-side output, separate slice),
transfer-provenance F1 paths (Organization owned), FIN4 aid cases (Finance
owned), QR codes (WP-5 U), transcript delivery/notification (WP-5 Q/P).

## Consequences

- Migration creates `transcripts` (+ immutability trigger): locator
  `document_id` nullable unique, no FK (same rationale as certificates).
- New `Transcript` model, `TranscriptComposer` (Domain, pure read over
  immutable facts), `IssueTranscript` command, `TranscriptQuery`
  (issued-record reads for print/verification).
- Tests cover content assembly across all sections, corrected-result
  exclusion, attendance correction supersede, payload frozenness across
  re-issue, hash recomputation from stored payload, classification-missing
  fail-closed, capability separation (issue vs documents.register vs
  verify), idempotent replay, and HTTP issue + print.

## Rejected alternatives

- Reporting-owned transcript metric — rejected; a certified extract of
  Academic facts is Academic authority, and the metric catalog is
  deliberately closed.
- Live-derived transcript print — rejected; post-issuance facts would leak
  into earlier records (historically false).
- Finance standing on the transcript — rejected; accounts are not academic
  truth and no ratified rule puts them on the study record.
- Multi-step staged issuance — rejected; nothing is decided at issuance
  time (all inputs are already governed), so staging adds ceremony without
  control. The single capability + idempotency + audit matches document
  registration precedent.
