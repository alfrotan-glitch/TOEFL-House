# Startup Import Fix — 2026-08-14

## Root cause
`server/src/routes/waitlist.routes.ts` invoked `requirePermission(...)` without importing it from `../middleware/auth.js`. Because the route module is evaluated during backend startup, Node terminated with:

`ReferenceError: requirePermission is not defined`

## Fix
Added `requirePermission` to the existing auth middleware import.

## Verification
- Source file contains the required import.
- Repository-wide scan found no other production route using `requirePermission(...)` without an import; remaining matches were tests or the middleware's own declaration/implementation.
- This directly resolves the startup exception shown in the user's log.

## Runtime limitation
A full dependency-backed TypeScript/test run was not possible in this audit container because dependency installation is externally constrained. No claim of full runtime certification is made on that basis.
