# TOEFL House ERP — Production Readiness Final

Date: 2026-08-13

## Verified in audit environment

- 181 TypeScript / TSX source files parsed successfully with TypeScript 5.8.3.
- No packaged `.env`, database, logs, coverage, build output, or `node_modules`.
- Backend has a committed `server/package-lock.json`.
- Finance invoice numbering is centralized and branch/year scoped.
- Runtime finance balances use `finance_accounts`; legacy `saving_accounts` is compatibility-only.
- Invoice GET has no database mutation for overdue status.
- Payment/invoice retry controls use idempotency keys where supported.
- Finance reconciliation and approval segregation controls are present.

## Release blocker still requiring the user's build environment

The frontend repository does **not** currently contain a root `package-lock.json`. Because of that, a clean `npm ci` at repository root is not reproducible yet.

This cannot be honestly certified from this environment because registry access required to generate the lockfile is unavailable here.

Therefore this package is source-audited and hardened, but it is **not claimed as fully production-certified** until the root lockfile is generated and the full release gate passes on Windows.

## Final Windows gate

Run from repository root:

```powershell
npm install
npm run typecheck
npm run lint
npm run build

cd server
npm ci
npm run lint
npm test
npm run build
```

After the first successful root install, commit the generated root `package-lock.json` and future CI should use `npm ci`.

## Additional hardening in final pass

- Invoice numbering is centralized across invoice routes, visitor conversion, enrollment auto-invoices, and extra-class invoices.
- Donation receipt numbering is branch/year scoped and atomic.
- Certificate numbering is branch/year scoped and atomic; wall-clock/random identifiers are not used for official certificate numbers.
- Static TypeScript/TSX parse audit: 182 files, 0 parse diagnostics.
