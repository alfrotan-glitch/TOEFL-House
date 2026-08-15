# TOEFL House ERP — High-Assurance Remediation

Date: 2026-08-14
Scope: latest supplied repository snapshot
Standard: adversarial / high-assurance ERP review

## What was changed

### Identity, authentication and session security
- Added server-side `session_version` enforcement to JWT authentication.
- Password changes, password resets, role changes, branch changes and deactivation revoke old sessions.
- Migrated browser authentication away from persistent `localStorage` bearer tokens to an HttpOnly/SameSite session cookie.
- Production can reject bearer authentication unless explicitly enabled with `ALLOW_BEARER_AUTH=true`.
- Added explicit `/auth/logout` cookie invalidation.
- Password change renews the secure session after revoking the old session.
- Frontend UserRole model now exposes only canonical roles; legacy `staff`/`partner` remain backend compatibility concepts only.

### RBAC / privilege lifecycle
- User creation and user role changes synchronize `users.role` with exactly one primary RBAC assignment.
- Primary identity roles cannot expire or use incompatible scope types.
- Primary role deletion is blocked.
- Database triggers prevent multiple primary roles for one user.
- Workflow, waitlist, enrollment freeze and enrollment transfer operations now have explicit permission gates.
- Workflow history requires `Workflow.View`.
- Existing secondary RBAC assignments remain supported.

### Workflow integrity
- Workflow trigger verifies the referenced business entity actually belongs to the workflow branch.
- Approval, rejection and cancellation use compare-and-swap state transitions to prevent double-processing and TOCTOU races.
- Domain events are emitted inside the workflow transaction.
- Step authorization remains bounded by the existing workflow role definitions plus the new permission gate.

### Waitlist integrity
- Join/offer/cancel mutations now use permissions.
- Offer/cancel transitions use conditional state updates and reject concurrent stale operations.
- Conversion claims the waitlist entry inside the transaction before creating the enrollment.
- A user without operational staff privileges may cancel only their own waitlist entry.

### Finance / monetary integrity
- Added a strict monetary boundary utility with finite-value, non-negative and two-decimal validation.
- Finance-account adjustments now pass through the monetary boundary.
- Income recording now normalizes monetary values before ledger/account mutations.
- Invoice line items, invoice totals, discounts, net totals and invoice payments use the monetary boundary.
- Profit-distribution withdrawal re-evaluates monthly profit, reserve requirements, withdrawal cap and available cash inside one write transaction before decrementing cash.
- High-impact monetary tables have DB-level two-decimal-place guards.
- Existing inventory non-negative stock triggers/constraints remain active.

### Database / branch isolation
- Preserved and extended cross-branch integrity triggers.
- Added additional high-assurance guards for enrollment, invoices, payments, waitlist, workflow branch immutability and related integrity.
- DB-level tests intentionally attempting cross-branch inserts are rejected.
- Added primary-role uniqueness triggers.

### Migration safety
- Migration runner no longer swallows broad `already exists` / duplicate-object errors.
- Only a verified `ALTER TABLE ... ADD COLUMN` duplicate where the requested column genuinely exists is treated as idempotently satisfied.
- Fresh-schema + migration replay was re-tested after this change.

### Release verification tooling
- Updated the forensic release audit to enforce canonical frontend roles and reject legacy frontend role leakage.
- Added/retained high-assurance verification coverage and release-audit checks.

## Verification actually performed

### Static / syntax
- 180 TypeScript/TSX source files passed syntax transpilation with 0 syntax errors.
- Forensic release audit: PASS.

### Database replay
- 49 migration files replayed against the current schema using a transaction-aware SQL splitter.
- `PRAGMA integrity_check` = `ok`.
- `PRAGMA foreign_key_check` = 0 violations.
- 44 triggers installed in the replayed database.
- Cross-branch enrollment/invoice/payment direct DB attempts were rejected.
- Negative book stock update was rejected.
- Monetary precision violation was rejected.

### Security surface review
- Mutating routes were reviewed for explicit `requirePermission()` / `authorize()` protection or intentional self-service/auth exceptions.
- Workflow, waitlist and enrollment-request mutation surfaces were hardened.
- Persistent browser storage is no longer used for authentication tokens.

## What was NOT falsely claimed

A clean dependency-complete TypeScript build and full Vitest/E2E execution could not be completed in the supplied archive/runtime because the repository does not contain installed dependency trees and the audit environment could not resolve/install the missing packages.

The global TypeScript binary therefore reports missing dependency type definitions (for example `@types/node` / `vite/client`) rather than proving application source errors.

The project root also does not contain a root `package-lock.json`, so a root-level deterministic `npm ci` cannot currently be claimed. The server has its own package-lock.

These limitations are intentionally left visible. They are release verification requirements, not disguised as passes.

## Remaining release-gate items

1. Execute `npm ci` in an internet-enabled clean environment using the repository's exact dependency manifests.
2. Execute frontend and backend typecheck/build with zero errors.
3. Execute the complete Vitest suite.
4. Execute browser/API E2E tests for concurrent finance, role lifecycle, workflow races and cross-branch penetration.
5. Establish production backup/restore drills and an off-host encrypted backup policy.
6. For multi-instance deployments, move rate limiting and any required event coordination to shared infrastructure.
7. For accounting at extreme assurance level, plan migration from SQLite `REAL` to integer minor-units or a true decimal accounting type with explicit currency/rounding policy.

## Final status

The supplied repository has been materially hardened and several previous release-blocking defects have been fixed at the source and database levels.

This package should be treated as:

**HIGH-ASSURANCE HARDENED / RELEASE CANDIDATE — NOT YET CERTIFIED FOR ZERO-DEFECT PRODUCTION DEPLOYMENT**

The remaining certification items above require a dependency-complete execution environment and operational infrastructure that are not present in the source archive.
