# Graduation Integrity & Certification Outputs — Architecture Decision (AC6)

**Status:** APPROVED (implementation authorized for the scope described below)
**Date:** 2026-09-04
**Applies to:** graduation decisions, certificate issuance, student alumni
transition, Finance clearance visibility, certificate document governance.
**Supersedes:** nothing. Composes with ADR-016 (eligibility snapshot), ADR-017
(enrollment financial gate), ADR-018 (level progression / prerequisites /
history, AC4) and AC5 (enrollment completion lifecycle).
**Related decisions:** MD-022 (graduation eligibility recommendation),
foundation 30-source-of-truth-registry (Graduation Eligibility Decision +
Certificate; issued record immutable), G2-D-003 (no automatic academic
outcomes), 06-financial-architecture + D-G3-001 (Finance sole authority).

## Problem

AC5 closed the seat-terminal half of the Academic lifecycle. The
student-terminal half is decoupled from it (WP-1 matrix rows H-remainder, J,
U; roadmap WP-3 AC3 remainder):

- `TransitionStudentStatus::graduate()` mints **alumni** with only
  `students.manage` plus free text. The governed `DecideGraduation` chain
  (propose → independent review → independent approval, SoD-enforced) and the
  issued certificate are never consulted: a student can become alumni while
  still seated, with no decision and no certificate behind the mark.
- An `eligible` graduation approval does not check whether the student still
  holds open seats in the program version — approval can certify completion
  while delivery is still in flight.
- Certificates are permanent academic outputs (MD-022: "Certificates and
  diplomas are permanent academic outputs") yet live only as rows plus
  live-derived prints: they never enter the managed-Documents lifecycle, so
  there is no submission → verification → activation governance and no
  independent verification path (MD-022 recommends document verification).
- Graduation and issuance record no Finance standing. MD-022 recommends
  "financial clearance where policy requires it" — but no ratified rule
  refuses graduation on debt, so any clearance input must stay read-only and
  human-consumed, never an invented refusal.

Transfer provenance (F1 command paths, Organization/Access owned), the FIN4
per-case aid model (Finance owned), and official transcripts as a certified
record output remain **out of scope**; they are separate slices.

## Decision

1. **Eligible approval requires closed seats.** `DecideGraduation::approve`
   with outcome `eligible` refuses (`academic.graduation_open_seats`) while
   the student holds a non-terminal (`requested` / `active` / `frozen`)
   enrollment in the decision's program version. `not_eligible` is unaffected:
   recording ineligibility while seated is coherent. `propose` stays
   draft-friendly; the gate bites at the decision point.
2. **Issuance re-checks at the point of no return.** `issueCertificate`
   re-runs the open-seat check: an approval that went stale (a seat opened
   afterwards) cannot produce a certificate.
3. **Finance clearance is read-only visibility, not a refusal.**
   `issueCertificate` embeds a Finance-authoritative student-clearance
   snapshot — `satisfied`, `remaining`, digest, signature — in the issuance
   audit through a new Finance-owned read method
   (`FinancialGateQuery::assessStudent`, same derivation as the enrollment
   gate; seat-scoped exceptions excluded without a seat context). Academic
   never re-derives a balance and never refuses on debt: no ratified rule
   authorizes that, and MD-022 leaves clearance to policy. The signed truth
   is put in front of the human issuer instead.
4. **Every certificate becomes a governed document.** In the same issuance
   transaction, `issueCertificate` registers a managed Document (subject =
   the student person, classification `academic.certificate` resolved by
   category, title = certificate serial, content hash = SHA-256 of the
   canonical certificate payload, storage locator `certificates:{id}`) and
   submits it for verification. The issuer therefore also needs
   `documents.register`; missing Documents capability or a missing
   classification fails closed (`documents.register_denied` /
   `documents.submit_denied` propagate; `academic.certificate_classification_missing`
   when the registrar has not defined the classification). Verification and
   activation stay registrar acts through the existing Documents transport,
   and the uploader≠verifier rule keeps the issuer from self-verifying.
   `certificates.document_id` (nullable, unique) pins the linkage at INSERT,
   which complies with the certificates immutability trigger.
5. **Alumni only through the governed chain.** `TransitionStudentStatus::graduate`
   requires, via the new Academic-owned `GraduationCertificationQuery`, an
   approved eligible graduation decision for the student
   (`students.graduation_decision_required` otherwise) and its issued
   certificate (`students.graduation_certificate_required` otherwise). Status
   history mechanics are unchanged; only the entry guard is added. Students
   owns the transition, Academic owns the graduation truth — the same
   cross-module read direction as the Finance gate.
6. **End-to-end integration on existing transport.** No new routes: the
   graduation, certificate, Documents (register/submit/verify/activate),
   student-status, and certificate-print routes already exist. The registrar
   verifies and activates the submitted certificate document through the
   existing Documents console; the certificate print stays live-derived from
   the immutable issuance row.

## Consequences

- Migration adds `certificates.document_id` (nullable, unique, no FK: the
  document has its own lifecycle; the column is a locator pin like the
  storage reference, set once at INSERT).
- `FinancialGateQuery::assessStudent` is Finance-owned read API; Academic
  consumes it exactly like the enrollment gate assessment.
- Existing `graduate()` callers must now travel the governed chain (test
  call sites updated); the registrar defines the `academic.certificate`
  classification once via the existing Documents console.
- Tests cover the open-seat gate (approve + issuance re-check, `not_eligible`
  exempt), classification-missing fail-closed, document register+submit with
  SoD on verify, clearance snapshot content with and without debt (issuance
  still succeeds), capability separation, alumni gating (decision-then-
  certificate), and HTTP transport of issuance and graduation.

## Rejected alternatives

- Alumni requiring only the approved decision without the certificate —
  rejected; per the source-of-truth registry the certificate is part of the
  graduation truth, and a graduate without the permanent output is
  half-recorded.
- Refusing issuance on unpaid obligations — rejected; no ratified rule
  authorizes it (invented business policy). Read-only signed visibility is
  the MD-022-faithful maximum.
- Academic-written document rows bypassing `RegisterDocument` — rejected;
  that would bypass Documents governance, versioning, audit, and the
  uploader≠verifier SoD.
- Academic-computed clearance from Finance models — rejected; Academic never
  re-derives a balance (ADR-017 boundary).
