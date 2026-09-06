# PHASE_3 Certification — Employee Coverage & Workflow Verification

**Base:** matrix closed at `8800c18` (E.5). This certification commit adds the frontend smoke regression test, one fix it found (below), and this evidence record. All numbers are machine-derived at the certified commit.

## 1. Coverage matrix result (the PHASE_3 target)

- **0 MISSING / 0 PARTIAL / 0 BLOCKED / 0 duplicate implementations** — target met.
- **46 COMPLETE** capability rows over the 90-capability set (machine-derived: every `CAPABILITY*` constant across `app/Modules`), 14 NOT-APPLICABLE items with per-row justification (one-time opening state, system-internal outbox/job machinery, closed canonical metric catalog).
- Matrix of record: `docs/implementation/41-phase-3-employee-coverage-matrix-checkpoint.md` (module × capability × command × transport × test evidence × migration).
- Structural rule held throughout: one authoritative command per workflow; transports are thin (validation + capability gate + idempotency + error transport only); staged SoD (session-per-signature + schema guard) for every two-actor command (000110–000116); no frontend business logic, no parallel workflows, no silent fallback.

## 2. Fresh-install evidence

- Dropped `toefl_house` and recreated it, then `php artisan migrate:fresh --force`:
  - **116 migrations applied from zero** (000001–000116), no failures.
  - Resulting schema: **104 tables**, **91 functions**, **161 triggers** in `public`.
  - Staged-chain guards present on the re-staged request tables: `refund_requests`, `progression_requests`, `payroll_settlement_requests`, `privacy_export_requests` (000114), `asset_disposal_requests` (000115), `org_wide_grant_requests` (000116) — 3 triggers each (state-transition, written-once slots, terminal-state); `scales` catalog guard: 2.
- Migrations are the single source of schema truth; the test suite re-migrates a scratch DB on every run, so the suite result below re-proves the chain on every regression.

## 3. Gate results (at the certified commit)

| Gate | Result |
|---|---|
| PHPUnit (full suite, fresh scratch DB) | **OK — 491 tests, 3373 assertions** |
| PHPStan level 6 | **0 errors** |
| Pint (Laravel preset) | **PASS — 484 files** |
| Fresh migration from empty DB | **116/116 applied** (section 2) |
| Frontend smoke (all console pages) | **26/26 pages 200** for a fully-authorized operator (section 4) |

## 4. Frontend workflow verification

- **196 web routes** (38 GET, 158 POST) under the employee session guard; the 16 module consoles + home + audit are reachable.
- `tests/Feature/Console/ConsoleSmokeTest.php` (this commit): logs in a fully-authorized operator — the entire machine-derived 90-capability set — and asserts every parameter-less console page renders 200 (floor: 18), plus that unauthenticated visitors bounce to login. **26 pages verified.**
- The smoke test did its job on the first run: it found a latent 500 — `AcademicController` ordered the skill catalog by `rank_order`, a column the `skills` table never had (a copy from the scale pattern; skills have no rank concept in domain or view). Fixed by ordering on the unique catalog `key` (no schema change, no speculative column). The academic index and sessions pages render 200.
- Page-level workflow proof (authorization, validation, state transitions, errors, idempotency, audit, branch scope, authoritative delegation) lives in the 17 `tests/Feature/Console` workflow classes (admissions, structure/contracts, increment B, assessments, graduations, appeals, finance back office, refunds, settlements, documents, privacy, resources, access, scales, communication, transport) plus the module-level suites — every business capability is proven over HTTP end-to-end, not just reachable.

## 5. Adversarial, authorization, concurrency, idempotency

- **Security hardening:** `tests/Feature/Security/SecurityHardeningFeatureTest.php` (auth/session/CSRF/input/file/error-leakage surface).
- **Cross-module boundary attacks:** `tests/Feature/CrossModuleBoundaryAttackTest.php` — 24 tests (cross-branch, cross-module state manipulation, direct-SQL attempts against guarded invariants).
- **Module adversarial suites:** `Access/AccessAdversarialTest` (self-grant, scope boundaries, staged-SoD distinctness even under direct SQL), `Identity/DuplicateIdentityAdversarialTest`, `Privacy/PrivacyAdversarialTest` (consent immutability, export boundary re-checks).
- **Denial + audit:** every workflow class asserts the unprivileged path returns the `*_denied` transport error AND writes the matching denied audit row (e.g. `communication.message.queue.denied`, `access.*.denied`).
- **Concurrency/idempotency:** commands take `lockForUpdate` on the subject row and wrap every state change in a transaction; idempotency is keyed per (operation, key) with payload binding — replay returns the original result, mismatched replay is refused. Proven per-workflow by replay assertions with fresh and repeated keys (e.g. staged approvals survive replay; one-time approver slots cannot be re-signed).

## 6. Out of scope for PHASE_3 (PHASE_4)

- Production assurance: backup/restore drill, deployment runbook + atomic release/rollback, performance profiling (query plans, N+1, pagination under load), secret/config hardening for the target host, document/printing branding pass.
- These are deliberately NOT certified here: PHASE_3 certifies the *system* (schema, capabilities, workflows, invariants, security behavior). Infrastructure claims wait on PHASE_4 evidence.

## 7. Certification statement

PHASE_3 is certified **from evidence only**: 0 missing / 0 partial / 0 blocked / 0 duplicate implementations across the 90-capability set (46 complete rows + justified exclusions); 116 migrations apply from an empty database with 161 schema guards; 491 tests / 3373 assertions green; PHPStan L6 clean; Pint clean; every console page renders for an authorized operator and denies the unauthenticated; every workflow is proven over HTTP with authorization, validation, state transitions, error taxonomy, idempotency, and audit; adversarial and boundary-attack suites pass. The working tree at the certified commit is clean and the remote branch equals local HEAD.
