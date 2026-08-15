# TOEFL House ERP — High-Assurance Remediation Record

Date: 2026-08-14

## Baseline

This release was hardened against the complete `FINAL_RUNTIME_VERIFICATION(1).txt` runtime report supplied by the operator.

The report demonstrated real Windows execution with Node 22.23.1 / npm 10.9.8, successful backend dependency installation, but backend typecheck failures and a large test failure set. The previous release gate could also report PASS after failures, which was corrected to fail-closed.

## Remediation applied

### Authentication / Session
- Browser authentication remains cookie-based (`erp_session`, HttpOnly/SameSite).
- Startup/session refresh no longer checks for a local bearer token before calling `/auth/me`. The frontend now asks the server for the current cookie session on every initial load.
- Session version enforcement remains active server-side.

### Test lifecycle reliability
- Removed individual `db.close()` calls from test suites that share the singleton SQLite connection. The Vitest process owns the database lifecycle.
- Vitest explicitly runs only `src/tests/**/*.test.ts` and excludes generated `dist` artifacts.
- Release gates remove `server/dist` and root `dist` before validation so stale JavaScript cannot be executed as tests.

### TypeScript / source correctness
- Fixed previously reported missing constants/imports and type mismatches across academic, placement, security, BOS, finance, exams, students, visitors, frontend API/state, classes, teachers, navigation and auth context.
- Placement snapshot/result parsing was refactored to avoid misleading initial assignments.
- Payroll date parsing regex no longer contains unnecessary escapes.
- Remaining empty catch blocks now contain explicit comments or deterministic fallback behaviour.

### Academic UI / workflow
- `NavButton` is now a top-level React component rather than being recreated during `AcademicSetupView` render.
- Course Offering remains upstream of Class Generation.
- Fee and capacity remain derived/read-only where they are not an authoritative input.

### Release validation
- `PRODUCTION_RELEASE_GATE.ps1` and `RELEASE_GATE.ps1` are fail-closed and verify every command exit code.
- No final release is considered certified unless backend typecheck, backend tests, backend build, frontend typecheck, frontend lint and frontend build all return exit code 0.

## Validation performed in the current build environment

- Backend TypeScript source syntax check: 102 files passed using Node's TypeScript strip/check support.
- Archive will exclude node_modules and generated runtime/database artifacts.
- Full dependency-complete npm test/build could not be rerun in this isolated build environment because the available node_modules tree is incomplete and registry access is unavailable.

Therefore this package is a **remediated release candidate**, not falsely labelled as runtime-certified.
