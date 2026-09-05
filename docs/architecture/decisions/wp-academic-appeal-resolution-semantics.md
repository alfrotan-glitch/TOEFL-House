# WP-ACAD-APPEAL-RESOLVE — Appeal resolution semantics

**Status:** approved for implementation · **Date:** 2026-09-05
**Trigger:** independent red-team finding — appeal `resolve()` was terminal theater
(appeal row flipped to `resolved` with zero defined effect on, or linkage to,
the contested subject), and `file()` accepted nonexistent subjects and
wrong-student bindings.

## Context

The appeal registry (`academic_appeals`, `AppealLifecycle`) tracks a grievance:
`open → assigned → investigating → resolved / rejected / escalated → closed`.
Remediation primitives already exist under their OWNING authorities and are
console-wired:

- assessment results: `released → appealed → corrected` and
  `released → corrected` (`AssessmentResultLifecycle`); `proposeCorrection` +
  `approveCorrection` (moderator + approver, distinct actors) exist, but NO verb
  performs `released → appealed` — the state is unreachable;
- progression decisions: `approved|rejected → appealed → superseded`
  (`ProgressionLifecycle`); `markAppealed` (conscious act) and `supersede`
  (reviewer + approver, independence-enforced, new decision row, original kept
  in history) exist and are console-wired;
- placement profiles: `released → superseded` (`DecidePlacement::supersede`);
  a retake requires the old profile to leave the open set first
  (`placement.profile_open_exists`), so the retake path also passes through
  `superseded`/`retired`.

What never existed: the LINK between the registry verdict and the subject, and
any verification of the subject at filing time.

## Decision

**`resolved` MEANS: the grievance was upheld AND redress is recorded on the
contested subject. `rejected` MEANS: no merit; the subject stands untouched.**

Concretely:

1. `resolve()` (→ `resolved`) is REFUSED unless the locked subject already
   carries its remediation marking:
   - `assessment_result` ∈ {`appealed`, `corrected`},
   - `progression_decision` ∈ {`appealed`, `superseded`},
   - `placement_profile` ∈ {`superseded`, `retired`}.
   `appealed` = remediation ordered and pending (an honest, visible state);
   `corrected`/`superseded`/`retired` = remediation completed. Resolving an
   untouched subject is rejected with `academic.appeal_subject_untouched`.
2. `reject()` (→ `rejected`) needs no subject effect — the subject standing IS
   the outcome. `escalate()`/`close()` are unchanged bookkeeping.
3. The missing result verb is added: `ManageAssessmentResult::markAppealed`
   (`academic.moderate`, released → appealed, audited) — the conscious,
   attributable act that orders remediation, mirroring progression's
   `markAppealed`. It is the SOLE writer of `appealed` on results.
4. `file()` verifies before creating: subject row EXISTS, is in an appealable
   state (`released` result; `approved|rejected` progression; `released`
   placement profile), and belongs to the appeal's student (for placement the
   student is derived from the profile, as today). Violations are
   `BusinessRejection` (`academic.appeal_subject_unknown`,
   `academic.appeal_subject_not_appealable`,
   `academic.appeal_subject_student_mismatch`).
5. `assign()` fails fast when the reviewer cannot act: the reviewer must hold
   `academic.appeal_manage` in the SUBJECT's branch scope (this also implies
   person existence — a nonexistent person holds no grants). The original
   decision-maker exclusion is unchanged.
6. Separation of duties is PRESERVED, not flattened: the reviewer decides
   (appeal verbs); record owners remediate (result/progression/placement
   verbs with their existing capabilities and independence rules). `resolve()`
   VERIFIES redress; it never performs it. No second authority over any
   subject row is created.

## Why not resolve-performs-remediation

Performing remediation inside `resolve()` would require stuffing two actors
(supersede needs reviewer + approver), remediation vocabularies (advance /
repeat, new scores), and three owning commands into one call — collapsing the
review/approve separation the lifecycle machines were built to enforce. The
precondition design keeps one code path per subject mutation and makes
"resolved but untouched" unrepresentable.

## Consequences

- Console flow becomes investigate → remediate (Mark appealed / Supersede /
  Propose+Approve correction, by authorized owners) → resolve → close. The
  denial message on premature resolve names the required prior step.
- Existing tests that resolve appeals against untouched subjects encode the
  old theater behavior and must be updated to remediate first (intended
  behavior change).
- Branch scope for every appeal verb is the SUBJECT's branch (separate
  branch-isolation decision); `file()` derives it from the verified subject,
  later verbs from the locked appeal's subject.
