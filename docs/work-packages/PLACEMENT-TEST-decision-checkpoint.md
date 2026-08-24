# Placement Test — Discovery, Model, Challenge, and Decision Checkpoint

Status: **OWNER DECISION REQUIRED — IMPLEMENTATION NOT STARTED**
Date: 2026-08-23
Authority: user-provided "TOEFL HOUSE — PLACEMENT TEST MASTER ENGINEERING SPECIFICATION" under `docs/MASTER_ENGINEERING_PROTOCOL.md`

## 1. Stop condition reached

Per the new specification's §50 command, this pass stops at the decision
checkpoint.

No implementation has been started.
No certified work package has been reopened.
No registry authority has been altered.

This document records:

- discovery of the existing Placement subsystem,
- the actual current architecture,
- comparison against the new specification,
- architectural conflicts and capability gaps,
- recommended decisions A–Q,
- the exact Owner approvals required before implementation may begin.

## 2. Discovery — existing Placement subsystem actually present in the repository

The repository already contains a substantial single Placement domain. It is not
an empty area and it is not currently split into physical and digital domains.

### 2.1 Route surface

Authoritative route boundary already exists at:

- `server/src/routes/placement.routes.ts`
- `server/src/routes/placement-attempt.routes.ts`
- `server/src/routes/placement-test-bank.routes.ts`
- profile/policy configuration in `server/src/routes/academic.routes.ts`
- dependent admission consumers in `server/src/routes/visitors.routes.ts`

### 2.2 Core domain services

Existing dedicated Placement core modules:

- `server/src/core/placement/store.ts`
- `server/src/core/placement/policy-engine.ts`
- `server/src/core/placement/timing-engine.ts`
- `server/src/core/placement/scoring-engine.ts`
- `server/src/core/placement/decision-engine.ts`
- `server/src/core/placement/placement-policy.ts`
- `server/src/core/placement/enrollment-gate.ts`
- `server/src/core/placement/reporting.ts`

### 2.3 Database structures already present

Canonical schema already contains all of these Placement tables:

- `placement_assessment_profiles`
- `placement_tests`
- `placement_test_sections`
- `placement_test_questions`
- `placement_rubrics`
- `placement_media`
- `placement_assessment_attempts`
- `placement_assessment_responses`
- `placement_assessment_results`
- `placement_rules`

with scope, snapshot, lifecycle, and correlation triggers in
`server/src/db/schema.sql`.

### 2.4 Existing frontend consumers

Existing UI surfaces already consume the Placement domain:

- `src/components/visitors/PlacementTestModal.tsx`
- `src/components/academic/TestBankAdminView.tsx`
- `src/components/academic/ProgramVersionsPanel.tsx`
- dependent consumer seams in
  `src/components/visitors/VisitorDeskPanel.tsx`,
  `src/components/visitors/ConvertToStudentModal.tsx`, and
  `src/components/visitors/VisitorsView.tsx`

### 2.5 Existing test authority

Current WP-04 package-local authority already exists:

- `server/src/tests/work-packages/wp04/profile-policy.integration.test.ts`
- `server/src/tests/work-packages/wp04/test-bank-security.integration.test.ts`
- `server/src/tests/work-packages/wp04/attempt-lifecycle.integration.test.ts`
- `server/src/tests/work-packages/wp04/scoring-decision-correction.integration.test.ts`
- `server/src/tests/work-packages/wp04/retake-billing.integration.test.ts`
- `server/src/tests/work-packages/wp04/enrollment-gates.integration.test.ts`
- `server/src/tests/work-packages/wp04/attack.test.ts`
- `server/src/tests/work-packages/wp04/architecture.test.ts`

Historical placement suites remain as explicit skipped knowledge records and are
already retired/replaced in the inventory.

### 2.6 Existing registry authority

Current registries already declare Placement authorities and invariants, for
example:

- `docs/registries/canonical-authority.md`
  - Placement requirement and assessment blueprint
  - Placement test-bank content, rubric and media assets
  - Placement attempt, immutable snapshot, response and timing lifecycle
  - Placement scoring, recommendation, outcome, override and correction
  - Placement retake and sitting billing decision
  - Placement conversion and class-enrollment eligibility
  - Placement activity report
- `docs/registries/invariants.md`
  - single profile hierarchy
  - valid blueprint facts
  - one open attempt
  - immutable snapshot secrecy
  - asset scope/kind/media confinement
  - wall-clock expiry
  - server-derived scoring/outcome
  - correction atomicity
  - billing idempotency
  - admission placement gate
- `docs/registries/decisions.md`
  - D-79 through D-85 capture the current certified WP-04 decisions

### 2.7 Exact observed facts that drive the gap analysis

These are the concrete repository facts behind the recommendations in this
checkpoint:

- `server/src/core/placement/store.ts`
  defines `PlacementComponentType` as only:
  - `skill_scores`
  - `written_test`
  - `interview`
  - `level_assessment`
  - `custom_score`
  - `content_test`
- `server/src/core/configuration/policy-catalog.ts`
  defines `PLACEMENT_DEFAULTS.method = 'skill_scores'` and default sections /
  skills as:
  - `grammar`
  - `vocabulary`
  - `reading`
  - `listening`
  - `writing`
  - `speaking`
- `src/components/academic/ProgramVersionsPanel.tsx`
  still presents that same legacy component vocabulary and the six-skill default,
  including `vocabulary`.
- `server/src/db/schema.sql`
  constrains `placement_tests.test_type` to only:
  - `listening`
  - `reading`
  - `writing`
  - `speaking`
- `server/src/db/schema.sql`
  constrains `placement_test_questions.qtype` to only:
  - `mcq`
  - `short_answer`
  - `essay`
  - `speaking`
- `server/src/db/schema.sql`
  stores questions under `placement_test_questions.test_id`, which means
  question rows belong to one test rather than existing as standalone reusable
  bank assets.
- `server/src/routes/placement-attempt.routes.ts`
  currently requires an `audioMediaId` for speaking responses, so the live
  digital speaking path is recording-based.
- `server/src/routes/placement-attempt.routes.ts`
  currently protects attempt operations with role-label middleware such as:
  - `authorize('owner', 'receptionist', 'general_manager', 'counselor')`
  while `placement-test-bank.routes.ts` and placement-profile mutation already
  use `requirePermission(...)` from the centralized permission catalog.

## 3. Model — the actual current architecture

## 3.1 What already aligns with the new specification

The current implementation already satisfies several of the new specification's
core architectural demands.

### Already aligned

1. **One Placement domain already exists**
   - There is one route namespace and one core module family.
   - There is no separate `digital_placement_*` and `physical_placement_*`
     schema or route duplication.

2. **Single scoring/decision pipeline already exists**
   - `scoring-engine.ts`, `decision-engine.ts`, and `placement-policy.ts` are
     the current authorities.

3. **Immutable historical attempts already exist**
   - `placement_assessment_attempts.snapshot_json` captures policy/content facts
     at start, and result/response triggers enforce snapshot membership.

4. **Human scoring is already supported**
   - manual and hybrid scoring exist;
   - writing/speaking rubrics exist;
   - corrections and overrides are audited.

5. **Auditability already exists**
   - `writeAudit(...)` is used on consequential placement actions.

6. **Branch/program hierarchy already exists**
   - profile lookup and admission gates already follow branch/program/version
     ownership rules.

7. **Versioning and CAS already exist**
   - profile/test/rubric versions are already modeled.

8. **Media and passage structures already exist**
   - sections, passages, transcripts, audio, and rubric-linked tests are already
     part of the canonical design.

## 3.2 The current canonical model in code today

### Current profile / blueprint model

Placement policy currently stores:

- requirement mode (`required` / `optional` / `not_required`)
- components JSON
- scoring model (`weighted_average` / `average`)
- pass score
- expiry
- decision rules JSON
- retake and billing controls

The component model is currently generic, not the new required five-part model.

Current component types in code:

- `skill_scores`
- `written_test`
- `interview`
- `level_assessment`
- `custom_score`
- `content_test`

### Current content model

Placement content today is **test-centric**, not **question-bank-centric**.

- `placement_tests` owns a test artifact
- `placement_test_sections` owns passages/audio/prompt blocks
- `placement_test_questions` are children of one test

This means the system currently supports authoring reusable tests, but **not a
reusable standalone question bank from which a blueprint-controlled engine assembles
an attempt**.

### Current scoring model

Scoring today is:

- auto scoring for `mcq` and `short_answer`
- manual scoring for essay/speaking or non-content generic components
- hybrid scoring for mixed content tests
- recommendation via conditional decision rules and score-band rules
- final placement directly to TOEFL House level ids

### Current delivery/workflow model

The current subsystem does **not** have canonical `DIGITAL` and `PHYSICAL`
delivery modes.

Instead, it infers behavior from component/test types such as:

- `content_test`
- `written_test`
- `interview`
- `skill_scores`
- overall derived `method`

### Current level/proficiency model

The current subsystem maps directly to TOEFL House `levels` and placement rules.

It does **not** have:

- explicit CEFR entities,
- explicit CEFR evidence rows,
- explicit CEFR mapping versions,
- explicit overall CEFR result separate from TOEFL House recommended level.

## 4. Challenge — comparison against the new specification

The current subsystem is strong, but it does **not** yet meet the new Placement
Test specification as written.

## 4.1 Primary architectural gaps

### Gap 1 — no canonical `DIGITAL` / `PHYSICAL` delivery mode

The new specification requires one Placement domain with exactly two delivery
modes:

- `DIGITAL`
- `PHYSICAL`

Current code has no explicit delivery-mode fact in schema, API, or UI.

### Gap 2 — no canonical five-component model

The new specification requires exactly these canonical components:

- Grammar
- Reading
- Listening
- Writing
- Speaking

Current default and UI still center a generic `skill_scores` component and even
include `vocabulary` as a first-class skill in defaults and UI.

### Gap 3 — no CEFR model

The new specification requires CEFR as the canonical proficiency framework.

Current code has:

- no CEFR columns in test/question/task metadata,
- no CEFR evidence model,
- no CEFR mapping/version authority,
- no overall CEFR output distinct from TOEFL House level recommendation.

### Gap 4 — no blueprint-controlled randomization engine

The new specification requires blueprint-controlled question selection.

Current code snapshots a preauthored test referenced by `component.testId`.
There is currently **no** runtime blueprint assembly and **no** question
selection algorithm enforcing CEFR/difficulty/type distributions.

### Gap 5 — no standalone reusable question bank

The specification requires reusable questions/tasks as first-class assessment
assets.

Current schema attaches questions directly to `placement_tests`. This supports
reusable tests, but not a reusable question asset pool independent of a single
test artifact.

### Gap 6 — speaking workflow conflicts with the new spec

The new specification defines digital speaking as:

- face-to-face interview,
- human scoring,
- score entered into the system,
- no ASR or AI dependency.

Current `content_test` speaking flow requires a recorded audio media reference
for speaking questions. That is a different operational model.

### Gap 7 — physical workflow is absent as a first-class concept

Current code supports generic manual scoring and could be extended, but there is
no canonical physical assessment record/workflow with section-by-section entry
under a declared `PHYSICAL` delivery mode.

### Gap 8 — question lifecycle is test-level, not question-level

The new specification requires question lifecycle such as:

- DRAFT
- REVIEWED
- APPROVED
- ACTIVE
- RETIRED

Current lifecycle is on `placement_tests.status` (`draft`, `active`,
`archived`), not on individual question/task assets.

### Gap 9 — current authorization is partly role-label based

The new specification requires use of the existing authorization architecture.

Current placement attempt routes still use role-label middleware such as
`authorize('owner', 'receptionist', 'general_manager', 'counselor')` rather
than canonical permission gates. Test-bank and profile configuration already use
permissions; attempt/scoring/finalization/override do not yet fully conform.

## 4.2 Areas that should be reused, not replaced

These parts of the current subsystem are valuable and should be preserved unless
a later implementation proof disproves them:

- immutable attempt snapshot architecture
- timing engine
- correction/override transaction model
- admission eligibility gate architecture
- audit hooks and billing linkage
- media safety and branch/object scope protections
- rubric structure and scoring provenance foundations
- profile CAS/versioning and rule validation

## 5. Scope discipline recommendation

This new specification is **not** a reason to reopen certified WP-04 as if it
never existed.

Recommended framing:

- treat WP-04 certification as the verified baseline,
- authorize a **new Placement Test extension/remediation scope** built on top of
  the certified placement domain,
- preserve all valid certified authorities unless an explicit approved behavior
  change replaces them.

Recommended implementation decomposition after approval:

1. **PT-01 Canonical model realignment**
   - delivery mode
   - five canonical components
   - CEFR authority model
2. **PT-02 Asset model and blueprint engine**
   - reusable question/task assets
   - blueprint storage
   - randomization/assembly
3. **PT-03 Digital and Physical workflows**
   - digital grammar/reading/listening/writing
   - face-to-face speaking
   - physical section result entry
4. **PT-04 Decision/mapping/finalization**
   - CEFR evidence
   - overall CEFR
   - TOEFL House level recommendation
   - result/report projections
5. **PT-05 Security/audit/registry/certification**
   - permission migration
   - audit evidence
   - registry repair
   - full attack/review/certification

## 6. Decision checkpoint A–Q

The decisions below are the required pre-implementation approvals. Each item
states the current evidence and the recommended decision.

---

## Decision A — current Placement architecture and what will be reused

### Evidence

Existing certified architecture already includes:

- one route namespace
- one core placement module family
- one canonical attempt/result snapshot pipeline
- one scoring engine and one decision engine
- one audit pattern
- one admission eligibility gate

### Recommendation

**APPROVE** this as the architectural base. Reuse and extend:

- `placement_assessment_profiles`
- `placement_tests` / sections / questions / rubrics / media
- attempts / responses / results
- timing, scoring, decision, policy, reporting, enrollment gate modules

Do **not** create a second placement subsystem.

---

## Decision B — canonical CEFR levels

### Evidence

The current code has no CEFR model, so this is a true new canonical decision.
The specification recommends A1, A2, B1, B2, C1 and explicitly excludes C2
unless justified.

### Recommendation

**APPROVE** canonical CEFR levels as:

- A1
- A2
- B1
- B2
- C1

**Do not include C2** in the first implementation scope.

---

## Decision C — canonical five-component model

### Evidence

Current code uses generic components and default `skill_scores`, including
`vocabulary`.

### Recommendation

**APPROVE** exactly five canonical components:

- Grammar
- Reading
- Listening
- Writing
- Speaking

`vocabulary` must cease to be a peer component. It may survive only as a
subskill/competency or question metadata, not as a sixth canonical component.

---

## Decision D — delivery mode terminology

### Evidence

Current code has no `DIGITAL` / `PHYSICAL` canonical value model.

### Recommendation

**APPROVE** exactly these canonical delivery-mode values:

- `DIGITAL`
- `PHYSICAL`

No `SYSTEM` domain value.

---

## Decision E — digital writing workflow

### Evidence

Current system can already store typed responses and rubric/manual scoring, but
it does so through generic content-test mechanics rather than an explicit
writing workflow.

### Recommendation

**APPROVE** digital writing as:

- system-delivered task
- typed student response
- stored start/submission/timing evidence
- human scoring queue
- rubric-driven score entry
- no AI scoring

---

## Decision F — digital speaking workflow

### Evidence

Current system's speaking content path expects recorded audio media. The new
specification instead requires face-to-face interviewing with score entry.

### Recommendation

**APPROVE** digital speaking as:

- face-to-face interview
- human examiner rubric scoring
- score entered into system
- notes/timestamp/examiner identity captured
- **no required audio recording** in the canonical workflow

If optional recording is later desired, it should be auxiliary evidence only,
not a required domain boundary.

---

## Decision G — physical assessment workflow

### Evidence

Current system has generic manual scoring but no explicit `PHYSICAL` assessment
workflow.

### Recommendation

**APPROVE** physical assessment as:

- one physical placement assessment record
- same five canonical components
- staff section-by-section controlled result entry
- same scoring/mapping/final decision pipeline as digital

---

## Decision H — question taxonomy

### Evidence

Current schema lacks CEFR, subskill, topic, approval-state, reviewer and other
required metadata. Questions are tied to tests rather than existing as
standalone reusable assets.

### Recommendation

**APPROVE** a first implementation taxonomy that minimally includes:

- asset id
- canonical component
- subskill / competency
- CEFR level
- difficulty
- question/task type
- topic
- prompt/content payload
- options/correct answer where applicable
- explanation
- passage/audio linkage
- lifecycle status
- version
- author/reviewer metadata

Recommend primary operational types:

- Grammar: MCQ, fill-in-the-blank, sentence completion, error identification
- Reading: passage + question set
- Listening: audio + question set
- Writing: prompt/task asset
- Speaking: interview prompt block / stage asset

---

## Decision I — assessment blueprint

### Evidence

Current system has component configuration, but no canonical blueprint model for
question distribution/randomized assembly.

### Recommendation

**OWNER APPROVAL REQUIRED** on the canonical blueprint concept.

Recommended approval now:

- blueprint is a first-class authority,
- blueprint governs composition for digital generation,
- blueprint governs validation requirements for physical entry,
- blueprint stores CEFR distribution, difficulty distribution, question-type
  distribution, timing, and required evidence.

Recommended deferral:

- exact counts, durations, and distribution numbers should **not** be invented
  by engineering alone.
- those exact numeric blueprint values should be owner/curriculum-approved from
  assessment evidence before implementation of generation rules.

---

## Decision J — randomization rules

### Evidence

Current attempt start snapshots fixed tests; there is no runtime assembly from a
question bank.

### Recommendation

**APPROVE** blueprint-controlled randomization with these invariants:

- active/approved assets only
- exact blueprint distribution compliance
- valid passage/audio relationships
- no prohibited duplicates
- deterministic auditable attempt assembly snapshot
- explicit failure when the bank cannot satisfy the blueprint

---

## Decision K — writing rubric

### Evidence

Current rubric engine exists and can be reused, but no canonical TOEFL House
writing rubric is defined in code.

### Recommendation

**OWNER APPROVAL REQUIRED** on rubric dimensions.

Recommended first rubric dimensions:

- Task Achievement
- Organization & Cohesion
- Grammar
- Vocabulary
- Mechanics

Engineering can implement the rubric framework now, but exact descriptors and
score bands need approval.

---

## Decision L — speaking rubric

### Evidence

Current rubric engine exists and can be reused, but no canonical TOEFL House
speaking rubric is defined in code.

### Recommendation

**OWNER APPROVAL REQUIRED** on rubric dimensions.

Recommended first rubric dimensions:

- Fluency
- Pronunciation
- Grammar Accuracy
- Vocabulary
- Interaction / Comprehensibility

Again, exact descriptors and scales need approval.

---

## Decision M — CEFR mapping

### Evidence

No explicit CEFR mapping model currently exists.

### Recommendation

**OWNER APPROVAL REQUIRED**.

Recommended approval now:

- CEFR mapping is explicit, versioned, and deterministic,
- mapping is not a naive percentage shortcut by default,
- section performance produces CEFR evidence first,
- overall CEFR is decided from component evidence and approved rules.

Exact thresholds/descriptors should be approved from curriculum/assessment
source material before implementation.

---

## Decision N — overall placement rules

### Evidence

Current engine recommends TOEFL House levels directly using score bands and
conditional component thresholds. The new spec forbids silent arithmetic
averaging and requires productive-skill-aware explainable placement.

### Recommendation

**OWNER APPROVAL REQUIRED**.

Recommended approval now:

- overall decision is explainable,
- productive skills can cap or block higher placement,
- final result includes:
  - component scores,
  - CEFR evidence,
  - overall CEFR,
  - recommended TOEFL House level,
  - reason text / rule version.

Exact cross-skill placement rule thresholds need explicit approval.

---

## Decision O — question lifecycle

### Evidence

Current lifecycle is test-level `draft/active/archived`, not question-level
review/approval/retirement.

### Recommendation

**APPROVE** question/task lifecycle:

- DRAFT
- REVIEWED
- APPROVED
- ACTIVE
- RETIRED

Tests/blueprints may also retain their own lifecycle, but question/task assets
must gain this lifecycle to satisfy the new bank model.

---

## Decision P — versioning and historical immutability

### Evidence

Current subsystem is already strong here: profiles/tests/rubrics version, and
attempts snapshot immutable content and policy facts.

### Recommendation

**APPROVE** reuse of the current immutability architecture, extended to also
cover:

- question asset version
- blueprint version
- CEFR mapping version
- placement rule version
- delivery-mode-aware result provenance

Historical results must remain reproducible from snapshotted facts.

---

## Decision Q — authorization and audit

### Evidence

Current test-bank and placement-profile mutation already use the central
permission catalog, but attempt/score/finalization flows are still partly
role-label-gated.

### Recommendation

**APPROVE** the following architectural rule:

- continue to use the existing TOEFL House centralized RBAC/audit architecture,
- do **not** create a parallel placement RBAC system,
- migrate role-label attempt/scoring/finalization/override boundaries to
  canonical permission gates.

Recommended permission strategy:

- reuse existing central catalog where it already fits:
  - `Curriculum.PlacementPolicy`
  - `Curriculum.TestBank`
  - `Lead.View` / `Lead.Edit` / `Lead.Convert`
  - `Audit.View`
- add new **central catalog** permissions only if necessary for operational
  separation such as scoring/finalization/override. Do not add a second RBAC
  framework.

---

## 7. Recommended Owner approval set

To allow implementation without reopening routine choices, I recommend the Owner
approve the following now as a package:

1. **Reuse the certified WP-04 placement domain as the architectural base.**
2. **Adopt canonical delivery modes `DIGITAL` and `PHYSICAL`.**
3. **Adopt exactly five canonical components: Grammar, Reading, Listening,
   Writing, Speaking.**
4. **Adopt CEFR levels A1, A2, B1, B2, C1 only for the first implementation.**
5. **Adopt digital speaking as face-to-face human-scored, not recording-required.**
6. **Adopt physical placement as a first-class delivery mode converging into the
   same result pipeline.**
7. **Adopt blueprint-controlled randomization from reusable question/task assets.**
8. **Adopt question lifecycle DRAFT → REVIEWED → APPROVED → ACTIVE → RETIRED.**
9. **Adopt explicit, versioned CEFR evidence/mapping and explainable final
   placement rules.**
10. **Adopt centralized permission/audit reuse, with permission-based route
    boundaries replacing role-label placement operations.**
11. **Defer exact numeric blueprint counts, exact rubric descriptors, exact CEFR
    thresholds, and exact overall placement thresholds to explicit Owner
    approval.**

## 8. Explicit unresolved Owner decisions still required before implementation

Implementation should not begin until the Owner approves or amends these:

- exact blueprint composition values
- exact writing rubric descriptors and scale
- exact speaking rubric descriptors and scale
- exact CEFR evidence thresholds/mapping logic
- exact overall placement decision thresholds/capping rules

## 9. Recommended next step after approval

Once the Owner approves the decisions above, the next engineering pass should:

1. formalize the new scope as a post-§W Placement Test extension package,
2. write the implementation work-package artifact,
3. implement in bounded phases without reopening valid WP-04 authorities,
4. run full verify → attack → repair → reverify → independent review → clean → certify.

## 10. Stop

This pass stops here by specification.

**No implementation has been performed.**
**Owner approval is required before coding begins.**
