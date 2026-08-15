# TOEFL House ERP — Product Hardening & UX Audit

## Product architecture
- Frontend and backend remain separated by responsibility.
- Academic defaults, financial defaults and seeded business rules are centralized in `server/src/core/configuration/policy-catalog.ts`.
- Runtime settings are persisted in the database; UI-level fee duplication was removed from System Administration.
- Academic Control Center is the single UI surface for curriculum, level, fee, room, time-slot and term configuration.
- Business Rules remains the single UI surface for configurable rule behavior.

## UI/UX improvements
- Added an executive Command Center to the Dashboard with direct actions for Admissions, Students, Finance and Academic Administration.
- Added page context to the application header so branch, role and current workspace are visible together.
- Removed simulated backup success states and synthetic timestamps.
- Removed hard-coded demo KPI values and streaming event feed from the login experience.
- Replaced demo login telemetry with real product capability messaging.
- Removed fake/mock assessment fallback copy from student profiles.
- Renamed navigation boundaries to `Academic Control Center` and `System Administration`.

## Cleanup
- Removed unused frontend fee settings state and mutation path from the global API store after moving configuration ownership to the backend academic/system APIs.
- Removed no-op store functions that had no call sites.
- Removed duplicated role-label mapping in Settings and application shell; both now use the canonical role catalog.
- Removed hard-coded director identity from printable payroll UI.
- Removed the bootstrap marker file model; `.env.example` is the only committed environment template and `.env` is runtime-only.

## Verification performed
- 170 TS/TSX source files transpile without syntax/transpile diagnostics using TypeScript 5.8.3.
- Only `server/.env.example` remains as an environment template in the source package.
- No `.env`, database, node_modules, coverage, build or runtime log artifacts are included in the delivery package.
- Full npm dependency installation and end-to-end test execution were not reproducible inside the isolated build environment; therefore this report does not claim runtime certification without the target Windows environment.
