# WP-13 — Audit & Platform

Status: **CERTIFIED**
Date: 2026-08-23
Package key: `audit`

## 1. Scope authority

Per `docs/MASTER_ENGINEERING_PROTOCOL.md` §W, the next package after certified
WP-12 is **WP-13 | Audit | audit**.

### Included surfaces

- `server/src/routes/audit.routes.ts`
- `server/src/middleware/audit.ts`
- `server/src/core/rbac/permission-catalog.ts`
- `server/src/db/schema.sql` (`audit_logs`, `audit_failures`, notifications read-state tables)
- `src/components/audit/AuditLogView.tsx`
- `src/apiStore.ts`
- `src/components/dashboard/DashboardView.tsx`
- `src/types.ts`
- `src/api/client.ts`
- `server/scripts/verify-deployment.mjs`
- `scripts/release-validate.mjs`
- `scripts/verify-product-integrity.mjs`
- `scripts/high-assurance-static-audit.mjs`
- `scripts/verify-bundle-weight.mjs`
- `server/src/tests/work-packages/wp13/*`
- Mixed regression/platform suites retained outside the package-local directory:
  `deep-audit-regression.test.ts`, `deployment-verifier.test.ts`,
  `erp-forensic.test.ts`, `final-hardening.test.ts`, `governance-audit.test.ts`,
  `release-gate-forensic.test.ts`, `script-path-portability.test.ts`,
  `system-closure-authorities.test.ts`, `system-integrity-guards.test.ts`, and
  `notifications-authority.test.ts`

### Explicitly not reopened

- WP-12 workflow/automation/event certification (`8574578`) remains closed.
- Notification policy itself is not an open checkpoint in this pass; D-58 and
  D-59 already decide read-state storage and Owner default scope.

## 2. Baseline discovery and challenge

### Verified baseline before implementation

Executed from clean commit `8574578`:

```bash
npm --prefix server run test -- \
  server/src/tests/deep-audit-regression.test.ts \
  server/src/tests/deployment-verifier.test.ts \
  server/src/tests/erp-forensic.test.ts \
  server/src/tests/final-hardening.test.ts \
  server/src/tests/governance-audit.test.ts \
  server/src/tests/release-gate-forensic.test.ts \
  server/src/tests/script-path-portability.test.ts \
  server/src/tests/system-closure-authorities.test.ts \
  server/src/tests/system-integrity-guards.test.ts \
  server/src/tests/notifications-authority.test.ts
```

Result: **10 files / 109 tests passed**.

### Discovered tensions

1. `server/src/routes/audit.routes.ts` still used role-label authorization
   (`authorize('general_manager')`) even though canonical permission
   `Audit.View` already existed in the RBAC catalog.
2. Audit consumers were split:
   - `src/components/audit/AuditLogView.tsx` fetched raw snake_case rows directly.
   - `src/apiStore.ts` separately loaded `/audit-logs` for dashboard activity.
   - `src/api/client.ts` camelized responses globally, which masked the contract
     mismatch instead of resolving it.
3. `server/src/middleware/audit.ts` already persisted failed audit writes into
   `audit_failures`, but there was no canonical read surface for operators to
   inspect that failure channel.
4. Platform-grade scripts and their tests belonged in scope because the release
   and deployment audits are part of the package's "Audit & Platform" surface,
   even where no code change turned out to be required.

## 3. Package decision

### D-180

Recorded in `docs/registries/decisions.md`:

> Audit visibility and failure inspection are one permissioned, paginated
> projection. `Audit.View` governs both `GET /api/audit-logs` and
> `GET /api/audit-logs/failures`; branch reach comes only from
> `resolveBranchScope`; browser consumers share the paginated envelope and
> camelCase contract; and a failed audit write remains inspectable through
> `audit_failures` rather than vanishing into logs.

No Owner checkpoint was required: this is an implementation/authority repair,
not a new business-policy choice.

## 4. Implementation

### Backend

- Replaced the legacy role-label audit gate with `requirePermission('Audit.View')`.
- Switched audit pagination to the shared hardened `parsePagination()` helper.
- Standardized `/api/audit-logs` onto a paginated envelope:
  `{ rows, total, page, limit, offset, hasMore }` while preserving count headers.
- Escaped `%`, `_` and `\` in LIKE filters so operator-entered literals remain
  searchable and cannot change the query's meaning.
- Added `GET /api/audit-logs/failures`, backed by `audit_failures`, under the
  same permission and branch-scope authority.
- Repaired the shared `assertPerformanceScore()` boundary (`server/src/utils/money.ts`)
  so certification gates stay honest: the helper again rejects scores above 100
  with the route-level domain error instead of leaking the decision to a later
  generic failure path.

### Frontend

- Replaced the audit workspace's local snake_case row contract with shared
  camelCase types from `src/types.ts`.
- Added shared `AuditFailure` and `PaginatedRows<T>` types.
- Updated `src/apiStore.ts` so dashboard recent-activity reads the same
  paginated audit contract and requests a bounded recent slice (`limit=50`).
- Expanded `AuditLogView` to expose both audit events and durable audit-write
  failures, including before/after payload inspection.

### Package-local authority tests

Added:

- `server/src/tests/work-packages/wp13/audit-platform.authority.test.ts`
- `server/src/tests/work-packages/wp13/audit-platform.contract.test.ts`
- `server/src/tests/work-packages/wp13/audit-platform.frontend-contract.test.ts`

## 5. Attack / mutation-oriented evidence

### Direct attack evidence added in WP-13

- A custom branch-scoped role holding only `Audit.View` now proves the route is
  permission-based rather than role-label based.
- Literal `%` filtering is tested so search terms cannot degrade into SQL LIKE
  wildcard semantics.
- `audit_failures` is now exercised as an operator-visible forensic channel,
  not merely a write-only sink.

### Global mutation evidence rerun

`npm --prefix server run audit:mutation` passes after the repair: **18 harnesses,
0 failed, 10 documented equivalent survivors reported by their harnesses, 1
INVALID anchor surfaced as measurement drift, 5 documented obsolete mutants**.
No validation was weakened to obtain the green result.

## 6. Registry and inventory repair

Updated:

- `docs/registries/canonical-authority.md`
- `docs/registries/invariants.md`
- `docs/registries/decisions.md`
- `docs/legacy-test-inventory.md`

WP-13 now has a package-local authority directory while mixed top-level suites
remain recorded as broader system/platform guards.

## 7. Verification, repair, re-verification and review

### Package-local verification

```bash
npm --prefix server run test -- \
  server/src/tests/work-packages/wp13/audit-platform.authority.test.ts \
  server/src/tests/work-packages/wp13/audit-platform.contract.test.ts \
  server/src/tests/work-packages/wp13/audit-platform.frontend-contract.test.ts
```

Result: **3 files / 8 tests passed**.

### Regression repair caught during re-verification

Two certification-blocking regressions surfaced and were repaired without
weakening any contract:

1. `server/src/tests/final-hardening.test.ts` still assumed
   `/api/audit-logs` returned a bare array. The test was repaired to assert the
   new paginated `rows` envelope.
2. The mutation gate exposed a real shared-boundary defect and one measurement
   drift:
   - `assertPerformanceScore()` no longer enforced the upper bound, so teacher
     validation suites failed on their unmutated baseline.
   - `server/scripts/teacher-update-mutation-test.mjs` needed an anchor re-base
     after the restored upper-bound line changed the surrounding snippet.

### Independent review

Cold review against the final diff checked four risks:

1. no remaining role-label audit authorization,
2. no frontend snake_case consumer path in the audit workspace,
3. no hidden second contract for dashboard recent activity,
4. no audit-failure writer left unreadable.

Outcome: no further defect remained after the `final-hardening` repair.

## 8. Final certification evidence

Executed on the repaired tree:

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run test -- \
  server/src/tests/deep-audit-regression.test.ts \
  server/src/tests/deployment-verifier.test.ts \
  server/src/tests/erp-forensic.test.ts \
  server/src/tests/final-hardening.test.ts \
  server/src/tests/governance-audit.test.ts \
  server/src/tests/release-gate-forensic.test.ts \
  server/src/tests/script-path-portability.test.ts \
  server/src/tests/system-closure-authorities.test.ts \
  server/src/tests/system-integrity-guards.test.ts \
  server/src/tests/notifications-authority.test.ts \
  server/src/tests/work-packages/wp13/audit-platform.authority.test.ts \
  server/src/tests/work-packages/wp13/audit-platform.contract.test.ts \
  server/src/tests/work-packages/wp13/audit-platform.frontend-contract.test.ts \
  server/src/tests/teacher-input-error-contract.test.ts \
  server/src/tests/work-packages/wp05/teacher-update-validation.test.ts
npm run build:all
npm run audit:registries
npm --prefix server run audit:mutation
npm run release:validate:quick
git diff --check
```

Results recorded during certification:

- `npm --prefix server run typecheck` → PASS
- `npm run typecheck` → PASS
- mixed WP-13 regression + blocking shared-boundary suites → **15 files / 220 tests passed**
- package-local WP-13 authorities alone → **3 files / 8 tests passed**
- `npm run build:all` → PASS
- `npm run audit:registries` → PASS
- `npm --prefix server run audit:mutation` → PASS (`18 passed · 0 failed`)
- `npm run release:validate:quick` → PASS (`17 passed · 0 failed · 5 skipped`)
- `git diff --check` → PASS

## 9. Certification verdict

WP-13 Audit & Platform is **complete and certified** when the associated commit
and push recorded below are present on `arena/01a02d63-toefl-house` together
with a clean working tree.
