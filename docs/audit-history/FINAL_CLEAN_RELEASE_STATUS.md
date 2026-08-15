# TOEFL House ERP — Clean Final Release Status

## Construction baseline
This release was rebuilt from the clean high-assurance Release Candidate v2 tree, not from the contaminated v3 workspace.
No `work_rc2`, `work_final`, `dist`, `node_modules`, runtime database, or `.env` files are included.

## Integrated source corrections
- Canonical Visitor/Lead source typing across `types.ts`, `apiStore`, `VisitorsView`, and `AddVisitorForm`.
- `triggerToast` is passed from `App.tsx` to `TeachersView`.
- Owner access is explicit for Placement Assessment Workspace endpoints.
- Rule evaluation performs branch authorization before domain payload validation.
- Academic lifecycle fixtures schedule a teaching session before `startTeaching`.
- Placement workspace test context uses a single consistent app/owner setup.
- Promotion fallback test is aligned with the canonical 70/75 academic default.
- Vite/Rolldown-compatible `manualChunks` function.
- Frontend lint is scoped to the frontend tree; backend typecheck/lint is a separate gate.
- Backend launcher installs locked dev dependencies when missing and clears stale compiled output.
- `install-all.bat` installs backend deterministically and then creates/verifies the frontend lockfile on a clean machine.
- Production release gate is fail-closed and validates dependencies before compilation/tests.

## Local static validation performed here
- 181 TypeScript/TSX source files parsed.
- 0 TypeScript/TSX syntax errors.
- ZIP archive integrity: PASS.

## Important certification boundary
This environment does not contain the project's full npm dependency tree and cannot reproduce the Windows runtime release gate offline. Therefore this artifact is a clean consolidated release candidate, not a claim of zero-defect runtime certification.

On a clean Windows checkout, run `install-all.bat` once, then run `PRODUCTION_RELEASE_GATE.ps1`.
