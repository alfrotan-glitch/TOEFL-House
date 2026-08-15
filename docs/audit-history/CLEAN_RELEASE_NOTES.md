# TOEFL House ERP — Clean Release Construction

This release is constructed from the high-assurance Release Candidate v2 baseline, then reconciled in one clean tree.
No prior `work_rc2`, `work_final`, `dist`, `node_modules`, database runtime, or environment files are included.

Key convergence points:
- Canonical visitor source typing across UI/API state.
- Owner access to placement workspace is explicit.
- Rule evaluation checks branch authorization before domain payload validation.
- Academic lifecycle tests create the required scheduled teaching session before `startTeaching`.
- Placement workspace tests use one consistent application/auth context.
- Promotion fallback tests use the canonical academic default.
- Vite 8/Rolldown-compatible chunking.
- Frontend lint is scoped to the frontend tree; backend typecheck is a separate gate.
- Backend launcher installs locked development dependencies when missing and clears stale compiled output.


## Release Gate correction (2026-08-15)
The certification gate validates the source/release policy without rejecting runtime folders created by dependency installation or first startup. The clean archive itself excludes node_modules, dist, server/data, and .env; the gate verifies .gitignore and clean-release preparation instead. Dependency installation occurs before static audit so local TypeScript/Vitest tooling is available.
