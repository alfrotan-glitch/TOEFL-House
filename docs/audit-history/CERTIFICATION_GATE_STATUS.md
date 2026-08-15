# Final Certification Gate — Evidence Report

Date: 2026-08-13

## Migration 042
- FACT: `server/src/db/migrations/` contains 001–041 and 043–048. 042 is absent.
- FACT: No `.git` directory/history is present in the supplied repository artifact.
- FACT: Static search found no source reference to `042` or `migration 42` outside the previous forensic report.
- FACT: Migration 043 only creates indexes on structures created by 041 and does not reference an unseen 042 dependency.
- UNKNOWN: What migration 042 was, why it was omitted, or whether it existed in the original repository history.
- RESULT: No migration 042 was invented or fabricated.

## Authorization
- FACT: All 31 route modules are behind router-level `authenticate` directly or via an equivalent router mounting pattern.
- FACT: Current source contains both `authorize(...)` and `requirePermission(...)` guards; this is a real mixed model.
- FACT: 61 route handlers use `requirePermission`, 43 use `authorize`, and 17 have no decorator-level permission/role guard but rely on controller-level checks or public-authenticated functionality.
- FIXED: Enrollment GET `/:id` now requires `Student.View`.
- FIXED: Enrollment lifecycle transition endpoints now use the existing student lifecycle role policy: registrar/manager/head_of_department/owner.
- FIXED: Workflow definition reads now require `Workflow.View`.
- RISK REMAINING: Some authenticated-only routes (notably waitlist request/cancel, freeze/transfer request flows, workflow instance action flows) still rely on in-handler authorization/state checks. Their intended actor model is not explicit enough in current evidence to safely redesign without inventing requirements.
- RESULT: No unverified claim of zero IDOR/privilege escalation is made.

## Deterministic Installation
- FACT: Backend has `server/package-lock.json`.
- FACT: Root/frontend has no `package-lock.json`.
- COMMAND: `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000` on writable copy.
- RESULT: FAILED. npm terminated with `Exit handler never called!`.
- COMMAND: `npm ci --offline --no-audit --no-fund` on writable copy.
- RESULT: FAILED with `ENOTCACHED` for `wrappy@1.0.2`.
- COMMAND: root `npm install --package-lock-only --offline`.
- RESULT: FAILED with `ENOTCACHED` for `@eslint/js`.
- CONSEQUENCE: Dependency installation is NOT certified reproducibly in this environment, and root lockfile is still missing.

## TypeScript / Tests / Builds
- FACT: TypeScript parser check across 182 TS/TSX files: 0 parse diagnostics.
- COMMAND: global `tsc --noEmit -p server/tsconfig.json`.
- RESULT: BLOCKED by missing installed `@types/node`.
- COMMAND: global `tsc --noEmit -p ./tsconfig.json`.
- RESULT: BLOCKED by missing installed `vite/client` types.
- Backend Vitest: NOT RUN because dependency installation did not complete.
- Frontend test suite: NOT RUN; root package has no test script.
- Backend build: NOT RUN because dependency-complete install was not achieved.
- Frontend build: NOT RUN because dependency-complete install was not achieved.
- RESULT: Full runtime certification is BLOCKED and no test/build PASS is claimed.

## Database / Migration Validation
- FACT: Fresh schema replayed with SQLite foreign keys ON.
- FACT: All 47 present migrations (001–041, 043–048) were replayed statement-by-statement with the project's documented benign duplicate-error policy.
- RESULT: No fatal migration SQL error.
- `PRAGMA integrity_check`: `ok`
- `PRAGMA foreign_key_check`: 0 violations
- NOTE: This is SQL-level replay, not an execution of the project's Node migration runner, because Node dependencies were not installable.

## Final Status
- P0: None proven by the available evidence.
- P1: Deterministic installation not certified; authorization model remains mixed with several authenticated-only controller-guarded routes; migration 042 history is unknown.
- P2: Root lockfile absent; full automated test/build certification unavailable; frontend test command is absent.
- PRODUCTION READINESS VERDICT: NOT PRODUCTION-CERTIFIED.
- Certification blocker is evidence/tooling/reproducibility, not a fabricated test failure.
