# Placement V1 Certification Report

Date: 2026-08-23
Branch: `arena/01a02d63-toefl-house`
Scope: Final closure of Placement Test V1 as the single active placement authority.

## Verdict

**CERTIFIED FOR RELEASE**

Placement V1 now ships as one canonical placement system with:
- one placement domain
- one canonical five-component model: Grammar, Reading, Listening, Writing, Speaking
- one scoring model: `canonical`
- one CEFR decision authority
- one placement decision engine
- two delivery modes only: `DIGITAL`, `PHYSICAL`
- no active legacy `placement_rules` route/service/schema authority

## Closure Summary

Completed in this closure:
- removed active legacy `placement_rules` authority from fresh canonical schema
- removed legacy catalog placement-rule routes and service logic
- removed legacy version-tree `placementRules` exposure
- converted version-copy logic to copy canonical `placement_assessment_profiles` and remap `decisionRules[].recommendedLevelId`
- retired legacy catalog endpoints with explicit 404 coverage:
  - `POST /api/catalog/placement-rules`
  - `DELETE /api/catalog/placement-rules/:id`
  - `POST /api/catalog/placement/recommend`
- updated placement-related frontend and test contracts to canonical V1
- removed interview rubric kind as a parallel/legacy authority from schema, routes, and admin UI
- added runtime placement-schema reconciliation so existing SQLite files drop retired placement-only objects and refresh changed placement triggers on boot

## Verification Evidence

### Schema / authority verification
- `npm --prefix server run preflight:fresh-schema`
  - **PASS**
  - Result: `Canonical schema preflight passed (119 tables, 272 indexes, 191 triggers; stands alone, sound, idempotent, sole authority).`

### Typecheck
- `npm run typecheck`
  - **PASS**
- `npm --prefix server run typecheck`
  - **PASS**

### Build
- `npm run build`
  - **PASS**
- `npm --prefix server run build`
  - **PASS**

### Full backend verification
- `npm --prefix server test`
  - **PASS**
  - Result: **203 passed files, 1 skipped file; 2838 passed tests, 2 skipped tests**
  - Note: the skipped tests are in `server/src/tests/payment.test.ts` and are not part of the Placement domain.

### Placement / attack / integrity surfaces confirmed green
Included in the full passing backend suite:
- `server/src/tests/work-packages/wp04/attack.test.ts`
- `server/src/tests/work-packages/wp04/profile-policy.integration.test.ts`
- `server/src/tests/work-packages/wp04/attempt-lifecycle.integration.test.ts`
- `server/src/tests/work-packages/wp04/scoring-decision-correction.integration.test.ts`
- `server/src/tests/work-packages/wp04/retake-billing.integration.test.ts`
- `server/src/tests/work-packages/wp04/test-bank-security.integration.test.ts`
- `server/src/tests/work-packages/wp04/architecture.test.ts`
- `server/src/tests/work-packages/wp03/visitors.test.ts`
- `server/src/tests/work-packages/wp03/students-admissions.attack.test.ts`
- `server/src/tests/work-packages/wp03/visitor-subsystem-audit.test.ts`
- `server/src/tests/work-packages/wp03/visitor-ux-remediation.test.ts`
- `server/src/tests/work-packages/wp05/enrollment-subsystem-remediation.test.ts`
- `server/src/tests/placement-content-gap.test.ts`
- `server/src/tests/placement-certification-blockers.test.ts`
- `server/src/tests/system-integrity-guards.test.ts`
- `server/src/tests/erp-forensic.test.ts`

### Final release gate
- `npm run release:validate`
  - **PASS**
  - Result: **22 passed · 0 failed · 0 skipped**

## Independent Architecture Review

### 1. Parallel placement authorities
Status: **PASS**
- Fresh schema no longer defines `placement_rules`
- Catalog service and routes no longer expose legacy placement-rule creation, deletion, or recommendation
- Runtime startup now removes retired placement-only objects from already-created SQLite files and recreates canonical placement triggers

### 2. Digital / physical convergence
Status: **PASS**
- Active delivery modes remain exactly `DIGITAL` and `PHYSICAL`
- Attempt orchestration stays inside the single placement attempt router
- Objective components use captured responses for digital delivery and controlled manual entry for physical delivery

### 3. Five-component integrity
Status: **PASS**
- Canonical component set enforced as: `grammar`, `reading`, `listening`, `writing`, `speaking`
- Legacy component types such as `skill_scores`, `custom_score`, and `written_test` are no longer active authorities

### 4. Scoring / CEFR / decision authority
Status: **PASS**
- Scoring model is canonical only
- CEFR ladder is explicit and canonical
- Decision rules are versioned in the canonical profile
- No duplicate placement recommendation engine remains active

### 5. Question-bank / blueprint integrity
Status: **PASS**
- Active test-bank surface remains canonical
- Blueprint assembly, snapshotting, and branch/rubric scope protections are covered by passing tests

### 6. Writing / speaking human scoring
Status: **PASS**
- Writing and speaking remain rubric/manual scored inside the single placement engine
- Interview-specific rubric authority was removed

### 7. Physical result entry
Status: **PASS**
- Physical attempts support controlled manual scoring through the same canonical attempt flow

### 8. Immutable snapshots / historical integrity
Status: **PASS**
- Attempt snapshots remain immutable and replay-safe
- Response/result snapshot triggers are present and verified

### 9. RBAC / branch isolation / audit
Status: **PASS**
- Placement and academic authorization matrix tests pass
- Branch scope, fallback policy scope, and audit-sensitive attack surfaces pass

## Files of Highest Consequence

- `server/src/db/schema.sql`
- `server/src/db/connection.ts`
- `server/src/core/academic/catalog-service.ts`
- `server/src/routes/catalog.routes.ts`
- `server/src/routes/placement-attempt.routes.ts`
- `server/src/routes/placement-test-bank.routes.ts`
- `src/components/academic/ProgramVersionsPanel.tsx`
- `src/components/academic/TestBankAdminView.tsx`
- `src/components/visitors/PlacementTestModal.tsx`

## Residual Blockers

**None.**

## Certification Decision

Placement Test V1 satisfies the approved architecture and passes schema, typecheck, build, attack, verification, and release gates. No active duplicate placement authority remains.
