# Placement Test V1 — Implementation Plan

Status: **ACTIVE — OWNER CHECKPOINT CLOSED**
Date: 2026-08-23
Scope key: `placement-test-v1`

## 1. Scope authority

This plan implements the Owner-approved Placement Test V1 decisions recorded in:

- `docs/work-packages/PLACEMENT-TEST-decision-checkpoint.md`
- Owner decision message dated 2026-08-23

This is a post-§W owner-authorized scope extension. It does **not** reopen or
invalidate certified WP-04. It extends the existing certified Placement domain.

## 2. Architectural commitments

The implementation is constrained to these owner-approved invariants:

- **ONE Placement domain**
- **TWO delivery modes**: `DIGITAL`, `PHYSICAL`
- **FIVE canonical components**:
  - `GRAMMAR`
  - `READING`
  - `LISTENING`
  - `WRITING`
  - `SPEAKING`
- **ONE scoring model**
- **ONE CEFR authority**
- **ONE placement decision engine**
- **NO parallel placement system**
- **NO AI dependency** for core Writing/Speaking workflows

## 3. Included surfaces

### Backend

- `server/src/db/schema.sql`
- `server/src/core/placement/*`
- `server/src/routes/placement-attempt.routes.ts`
- `server/src/routes/placement-test-bank.routes.ts`
- `server/src/routes/academic.routes.ts`
- `server/src/core/rbac/permission-catalog.ts`
- dependent placement gate consumers in:
  - `server/src/core/placement/placement-policy.ts`
  - `server/src/core/placement/enrollment-gate.ts`
  - `server/src/routes/visitors.routes.ts`
  - `server/src/core/academic/enrollment-service.ts`

### Frontend

- `src/types.ts`
- `src/components/academic/ProgramVersionsPanel.tsx`
- `src/components/academic/TestBankAdminView.tsx`
- `src/components/visitors/PlacementTestModal.tsx`
- dependent visitor projections where needed

### Tests / authority repair

- package-local V1 placement authority suites
- impacted WP-04 placement authority suites
- registry/certification artifacts after implementation

## 4. Implementation model

### PTV1-01 — Canonical profile / blueprint realignment

Rebuild placement profile validation around one fixed V1 model:

- canonical delivery modes `DIGITAL` / `PHYSICAL`
- fixed five-component blueprint
- grammar 30 objective items
- reading 20 objective items
- listening 20 objective items
- writing 1 human-scored task / 25 points
- speaking 1 face-to-face human-scored interview / 25 points
- no `vocabulary` peer component
- no generic `skill_scores` / `interview` / `custom_score` / `level_assessment`
  placement profile model

### PTV1-02 — Question-bank and taxonomy extension

Extend the existing test-bank, do not create a second one:

- add `grammar` as a first-class bank type
- add question lifecycle and metadata needed for blueprint-controlled selection
- keep one canonical bank surface under `/api/placement`
- support approved/active asset selection only

### PTV1-03 — Blueprint-controlled attempt assembly

At attempt start:

- choose `DIGITAL` or `PHYSICAL`
- assemble immutable component content from approved active bank assets
- use deterministic seeded randomization
- fail closed when the bank cannot satisfy the blueprint
- preserve immutable snapshot history

### PTV1-04 — Digital / Physical delivery convergence

Implement both delivery modes through the same attempt/result pipeline:

- `DIGITAL`
  - objective sections answered in the system
  - digital writing typed in the system, human-scored
  - digital speaking managed by the system, scored face-to-face by a human
- `PHYSICAL`
  - same blueprint assembled and snapshotted
  - objective sections entered by staff as authoritative scored results
  - writing/speaking rubric scores entered by staff

### PTV1-05 — CEFR evidence and placement decision engine

Implement one explicit versioned CEFR rule-set model that:

- yields component-level CEFR evidence
- yields overall CEFR via weakest-skill protection
- requires productive-skill evidence for higher placement
- produces explainable recommended TOEFL House level mapping
- preserves historical immutability in the attempt snapshot

### PTV1-06 — Authorization, audit, and runtime contracts

- replace role-label placement runtime gates with centralized permissions
- keep branch/program/object scope and transaction boundaries
- audit all consequential mutations
- preserve existing admission-gate integration

## 5. Verification / attack expectations

The implementation is not certifiable until it passes:

- typecheck
- build
- package-local placement authority suites
- targeted attack suites
- dependent admission / conversion regression
- registry validation
- clean rebuild / schema validation where relevant
- independent review and certification artifact generation

## 6. Stop conditions during implementation

If implementation reveals a repository constraint that makes an approved Owner
decision technically impossible or internally contradictory, work stops and
returns to the Owner with direct evidence.
