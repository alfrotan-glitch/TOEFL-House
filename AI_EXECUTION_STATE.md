# AI Execution State — TOEFL House ERP

Last updated: 2026-08-15 (pass 5: finance command center + dead-code sweep)

## Current Phase

**Production hardening — PASS 4 complete.** Pass 1 restored the repo from
`ERP.zip`, fixed the broken placement engine / RBAC / production start, and
brought all gates green (341/341). Pass 2 unified the class-capacity source of
truth, enforced the password-change quarantine server-side, hardened the
waitlist authorization path, and split the frontend bundle by route.

## Completed work — pass 2

1. **Capacity single source of truth**
   - New `core/academic/class-capacity.ts` (authoritative: enrollments
     active/confirmed/pending).
   - `EnrollmentService.enroll()` writes the `student_semesters` projection
     atomically (`writeSemester` opt-out for callers owning their row).
   - visitors/waitlist/students routes use the shared count; manual student
     registration enrolls inside its transaction (no orphan on race).
   - Regression: `src/tests/class-capacity.test.ts` (6 tests).
2. **Password-change quarantine (server-side)**
   - `authenticate()` blocks non-auth endpoints while
     `users.must_change_password=1`; change-password bumps session_version.
   - Regression: `src/tests/password-quarantine.test.ts` (2 tests).
   - Test harness: all seeded users now `must_change_password=0`.
3. **Waitlist cancel** resolves staff roles through RBAC (`hasAnyLegacyRole`).
4. **Frontend code splitting** — 17 workspace views lazy-loaded; index chunk
   790 kB → 87 kB; Suspense fallback added.
5. **apiStore** — `bq` memoized (stable identity) and added to reloader dep
   arrays; removed 6 dead deps from `loadTab`.
6. **Docs** — `docs/RELEASE_GATE.md`, `AI_EXECUTION_STATE.md`, `AI_HANDOFF.md`
   updated with pass-2 evidence.

## Verification results (pass 2)

- Server tests: **349/349 PASS** (30 files).
- Frontend typecheck/build: PASS; lint 0 errors / 38 warnings (down from 71).
- Audit scripts + fresh-schema preflight: PASS.
- Runtime: bootstrap → login → quarantine 403 → change password → unlock →
  class/visitor/convert (paid invoice) → restart persistence — all verified.
- Runtime single-writer check: 1 enrollment ⇒ exactly 1 semester row.

## Known issues / decisions pending

- 38 react-hooks lint warnings (set-state-in-effect / exhaustive-deps) —
  React 19 style recommendations, documented; no frontend test harness so
  they are not blindly changed.
- Mixed `authorize()` + `requirePermission()` model remains (both enforce;
  owner granted as superuser) — candidate for full permission-code
  convergence in a future pass.

## Next actions

See `AI_HANDOFF.md`.

## Blockers

None.

## Pass 4 — frontend lint reduced to zero (39 → 0 warnings)

- Fetch-on-mount effects: async-IIFE boundary for the sync loading flag.
- Form-init/reset effects: converted to adjust-state-during-render.
- exhaustive-deps: real missing deps added; redundant effect removed
  (TeachersView salary amount); sessionStorage restore made lazy.
- AuthContext split into auth-context.ts / AuthProvider.tsx / useAuth.ts
  (react-refresh); all importers updated; runtime-verified.
- Zero eslint-disable comments remain in src/.
- Forensic audit updated to the new auth module path.

Verification: lint 0/0, typecheck/build PASS, 357/357 server tests, all
audits PASS, full runtime smoke through the Vite proxy PASS.
