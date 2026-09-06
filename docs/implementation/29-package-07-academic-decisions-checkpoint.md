# Package 07 Checkpoint — Academic Decisions

**Package:** 07 — Academic Decisions (assessment results and their review chain, appeals, progression and graduation decisions, certificates)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 06 checkpoint (`28-package-06-academic-delivery-checkpoint.md`) at commit `7bffc67`

## Discover

- Governance inputs consumed: authority/capability registry (foundation 35 — Test Officer records the attempt evidence immutably; Academic Management approves and releases results and decides graduation eligibility with the approved-exception basis; an assigned reviewer handles appeals and the original decision is retained; the Completion authority issues certificates), lifecycle registry (foundation 32 — Placement/Assessment row: Draft→Started→Submitted→Scored→Moderated→Approved→Released→Appealed→Corrected, "a score is never automatically a decision"; Progression/Graduation row: Proposed→Reviewed→Approved/Rejected, appealed→new decision with the original retained; Incident/Appeal row: Open→Assigned→Investigating→Resolved/Rejected/Escalated→Closed with outcome and evidence, no silent closure), business rules (BR-ACAD-002: no automatic advancement), entity registry (29), decision registry (32: a score is not a decision), relationship registry (31), command registry (implementation 03), module contracts (implementation 04).
- Scope split recorded at the Package 06 checkpoint honored: P06 delivered delivery (structure/class/enrollment/attendance); P07 delivers decisions on top of it.

## Map (implemented scope)

- **Assessment attempt** (`AssessmentAttempt`): `draft|started|submitted` states, kind ∈ {placement, assessment}; a `submitted` attempt is **frozen by a DB trigger** (state + evidence immutable). The attempt requires an **active enrollment**.
- **Assessment result** (`AssessmentResult`): `scored→moderated→approved→released` — **release is reachable only through approval**; `released→appealed|corrected`, `appealed→corrected`, `corrected` terminal. Score ≥ 0 (CHECK). **One live result per attempt** (partial unique index; `corrected` rows are excluded as history). Each stage records its own actor (`scored_by`/`moderated_by`/`approved_by`/`released_by`); the **moderator and the approver must differ from the scorer** and the approver from the moderator — moderation/review is independent by construction.
- **Correction**: appends a **new released row** referencing the original via `corrects_id` with a **mandatory reason**, requires two distinct actors (moderator + approver), and closes the original as `corrected`. The original score stays visible.
- **Appeal** (`AcademicAppeal`): `open→assigned→investigating→{resolved,rejected,escalated}`, `escalated→assigned`, `{resolved,rejected}→closed`, `closed` terminal. `resolved`/`rejected` require **outcome + outcome_evidence** (no silent closure) and only the **assigned reviewer** may investigate or decide; the assigned reviewer may never be the **original decision-maker** (scorer of the appealed result / approver of the appealed progression decision).
- **Progression decision** (`ProgressionDecision`): `proposed→reviewed→{approved,rejected}`; `approved|rejected→appealed`; `appealed→superseded` — a resolved appeal **supersedes**: a new approved decision is appended and the original row is retained pointing at its successor (`superseded_by_id`). Three distinct roles (proposer ≠ reviewer ≠ approver) and outcome ∈ {advance, repeat}. **One open decision per student+class** (partial unique index over proposed/reviewed/approved/appealed). **BR-ACAD-002**: nothing advances automatically — a released score creates no progression decision (asserted).
- **Graduation decision** (`GraduationDecision`): `proposed→reviewed→{approved,rejected}` with outcome ∈ {eligible, not_eligible} and a **mandatory requirements basis**; independent review, Academic-Management approval (approver ≠ proposer/reviewer); one open decision per student+program version.
- **Certificate** (`Certificate`): issued **only from an approved, eligible graduation decision**, once per decision, unique serial; issuance records are **immutable (DB trigger blocks UPDATE/DELETE)**.
- Capabilities through the canonical resolver, all separate: `academic.assess`, `academic.moderate`, `academic.approve_result`, `academic.release`, `academic.appeal_manage`, `academic.progression_propose`, `academic.progression_review`, `academic.progression_approve`, `academic.completion`, `academic.completion_approve`, `academic.certify`.
- Persistence: 6 migrations (`2026_08_26_000039`–`000044`) owned solely by the Academic module; CHECK constraints (attempt kinds/states, result states and score, appeal subjects/states, progression and graduation outcomes/states); partial unique indexes (one live result per attempt, one open progression per student+class, one open graduation per student+version, unique certificate serial); immutability triggers on `assessment_attempts` (submitted) and `certificates`.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 205 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (209 tests, 792 assertions)** |
| integration tests | PASS | result chain, correction, appeal, progression, graduation/certificate chains against PostgreSQL atomically (6 feature tests + lifecycle unit suite) |
| invariant tests | PASS | release only after approval (state machine + unit vector matrix); one live result per attempt (domain + partial index); one open progression/graduation decision; submitted-attempt and certificate immutability (raw SQL vs triggers); CHECK-constrained states/outcomes/subjects |
| authorization tests | PASS | scorer≠moderator≠approver enforced (independence guards fire even when the actor holds the capability); release capability separate from approval; unprivileged scoring denied with audit and no row |
| lifecycle tests | PASS | full chains incl. appeal escalation loop and supersession retaining the original; terminal states fail closed (unit matrix) |
| evidence tests | PASS | appeal resolution without evidence rejected; correction without reason rejected; correction chain recorded with reason |
| financial tests | NOT APPLICABLE | no financial module in Package 07 scope |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes (incl. certificate re-issue replay); same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (result/progression/graduation/certificate indexes; attempt-kind, result-state/score, appeal-subject, progression/graduation-outcome CHECK vectors; append-only trigger catalog assertions); database migrated to all 44 migrations |
| contract verification | PASS | universal command contract; only Academic writes academic decision persistence; Admissions/Academic-delivery boundaries consumed read-only, never mutated |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Scorer moderating or approving their own result — denied (`academic.review_not_independent`) even though the actor holds the capability.
2. Approver who moderated the same result — denied (`academic.approval_not_independent`).
3. Release without the release capability (approval alone) — denied.
4. Score→release shortcut (skipping moderation/approval) — impossible in the state machine; unit matrix asserts the absent edges.
5. Negative / non-numeric score — rejected (`academic.result_score_invalid` + schema CHECK).
6. Second live result for the same attempt — rejected (domain guard + partial unique index).
7. Correction by a single actor holding both roles — denied (`academic.correction_single_actor`); correction without reason — rejected.
8. Raw SQL mutation of a submitted attempt — rejected by the trigger; raw SQL mutation of a certificate (UPDATE and DELETE) — rejected by the trigger.
9. Original decision-maker assigned to the appeal — denied (`academic.appeal_not_independent`).
10. Appeal resolution without outcome/evidence — rejected (`academic.appeal_outcome_required`); silent closure from open/investigating — impossible (state machine, unit-asserted).
11. Proposer reviewing, or reviewer approving, a progression/graduation decision — denied (independence guards).
12. Duplicate open progression decision for the same student+class — rejected (domain + partial index).
13. Certificate from a non-approved or not-eligible decision — rejected; second certificate for one decision — rejected; serial tampering — rejected by the trigger.
14. Unprivileged scoring — denied with audit evidence (`academic.result.score.denied`) and no result row.
15. Released score automatically creating a progression decision — asserted absent (BR-ACAD-002).

## Repair log (defects found by verification, fixed, reverified)

1. `IdempotentExecution` constructor hints mis-typed as `Idempotency` in two commands (container failure) — fixed.
2. `reviewed_by`/`approved_by` NOT NULL on the decision tables blocked the staged three-role chain — made nullable (a role column is null until that stage is performed); stage actors now also recorded on results (`moderated_by`/`approved_by`/`released_by`).
3. Correction/supersession inserted the successor before closing the original, violating the partial unique index — reordered (close original first, then append successor) inside one transaction.
4. Schema-test certificate row required the deep admissions FK chain — replaced by catalog assertions for the immutability triggers (row-level behavior proven end-to-end in the feature test with a real certified chain).
5. Test defects: negative-path actors accidentally granted the very capability under test; expectation-order issues — fixed; negative-path actors now hold the capability so the *independence* guard is what fires.

## Decide

- A released result stays `released` when its appeal closes without a correction; only an actual score change appends a corrected row (registry: "the appeal produces a new decision", not a mutation).
- Appeal subjects are exactly `assessment_result` and `progression_decision` (schema CHECK); graduation appeals flow through the same progression supersession path applied to progression decisions — a graduation decision can be re-decided only through a new decision after the open one is closed, preserving history.
- `superseded` is excluded from the open-decision partial index (a superseded decision is closed history, so a new open decision may follow).
- Capabilities for the decision chain are deliberately finer-grained than P06 (eleven separate academic capabilities) so independence rules are enforceable per stage.

## Certified

Package 07 — Academic Decisions: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (209 tests, 792 assertions)**, phpstan level 6 clean, pint clean (205 files), database at 44 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–06 untouched.
