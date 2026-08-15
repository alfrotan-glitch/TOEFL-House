# TOEFL House ERP — Final Integrated Release State

This artifact is based on the user-provided `TOEFL-House-ERP-ACADEMIC-UI-HARDENED` snapshot and integrates the later visitor authorization correction plus the startup/import fixes already present in that snapshot.

## Integrated fixes
- Visitor domain uses canonical `Lead.*` RBAC permissions instead of legacy role-only authorization.
- Workflow approval/rejection/pending routing resolves step roles through canonical RBAC role membership rather than the mutable `users.role` value alone.
- Backend bootstrap scripts verify the actual `tsx.cmd` executable before starting/seed operations.
- Startup health/readiness gating and diagnostics remain enabled.
- Academic UI ordering, fee/capacity derivation, offering-first class generation, and version-layout improvements remain preserved.
- Database/RBAC/high-assurance migrations remain preserved from the supplied baseline.

## Verification limits
A dependency-complete Node installation is not present in the audit environment and root `package-lock.json` is absent, so a full clean `npm ci` + frontend/backend build/test execution cannot be truthfully reported as passed here.
