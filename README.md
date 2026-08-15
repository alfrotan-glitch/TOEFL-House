# TOEFL House ERP

Production-oriented TOEFL House ERP with a React/Vite frontend and Express/SQLite backend.

## One-click first installation on Windows

Double-click `run-all.bat`. For database-only first install, run `bootstrap.bat`.

The launcher will:

1. Install backend dependencies.
2. Generate `server/.env` automatically when it does not exist or still contains placeholders.
3. Generate a secure first-install JWT secret and owner password.
4. Bootstrap the database and owner account.
5. Start the backend.
6. Start the frontend.

The generated owner username and password are printed by the bootstrap window. Change the owner password after first login.

## Manual commands

Frontend:

```powershell
npm install
npm run typecheck
npm run lint
npm run build
```

Backend:

```powershell
cd server
npm ci
npm run lint
npm test
npm run build
```

First install:

```powershell
cd server
npm run bootstrap
```

## Runtime URLs

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000
- Health: http://localhost:4000/api/health

## LAN deployment (one server PC + other computers)

The target model is one Windows PC running the ERP; reception, finance and
manager PCs connect over the same LAN/Wi-Fi.

- The backend listens on `0.0.0.0:4000` (set `HOST=127.0.0.1` in `server/.env`
  to restrict to the server machine only).
- The frontend (Vite) listens on `0.0.0.0:3000` and proxies `/api` to the
  backend, so client PCs only ever reach the frontend — the SQLite database
  is never exposed directly to clients.
- Other computers browse to `http://SERVER_IP:3000` (find the server IP with
  `ipconfig`). No per-client configuration is required.
- Add the server IP to `CORS_ORIGIN` in `server/.env` if you call the API
  directly (e.g. `http://localhost:3000,http://192.168.1.10:3000`).
- Windows Firewall: allow inbound TCP 3000 (and 4000 only if the API must be
  reachable directly).

Production deployments should provide secrets through the environment or a secret manager. Never commit `.env`, database files, or runtime credentials.

## Configuration ownership

Academic curriculum, branch fees, level defaults, rooms, time slots and terms are managed only through the Academic Control Center. Configurable business behavior belongs to the Rule Engine. System Administration contains organization, user, security and operational settings only; it does not duplicate academic policy controls.

Backend policy defaults are centralized in `server/src/core/configuration/policy-catalog.ts` and persisted runtime values are stored in the database.

## First install

Run `bootstrap.bat` once, then start the application with `run-all.bat`. The bootstrap creates `server/.env` automatically when needed, generates secure first-install credentials when the template is used, runs the database bootstrap, and prints the Owner credentials once they are generated. `.env.example` is the only environment template shipped with the project.

## Global workspace search
Authenticated users can press `Ctrl+K` (or `Cmd+K`) to search Students, Visitors, Teachers, Classes, Invoices and Books within their permitted scope. Results route back to the relevant operational module.

## Release gate

The authoritative, evidence-based release status is `docs/RELEASE_GATE.md`
(verified 2026-08-15: 433/433 backend tests across 40 files, frontend
typecheck/build PASS with 0/0 lint, fresh-schema preflight PASS, production
boot and critical workflows smoke-tested, 10k-student scale, concurrent
multi-user runs and LAN bind verified). Historical audit notes are preserved under
`docs/audit-history/`.

## Reporting

The Operations & Financial Report tab renders a server-computed report
(`GET /api/reports/overview`) covering operating income/expense by category
with gender splits, capital/transfer movements, balances and operational
metrics (new students, registrations, visitors, placement, certificates,
exams, book sales) for today / month / year / custom ranges, filterable by
gender and branch scope. Every report is printable with a stable Report ID,
period, filters, generated-by, position and timestamp.

## Positions & access

Authorization is resolved server-side from data-driven positions
(`user_roles` + scope): a user can hold several positions at once, each with
campus/branch/organization scope and a permission set. The Owner position is
displayed uniformly as "Owner"; owner accounts administer each other through
the user-management API. Reception payment collection feeds the financial
ledger as income, while Reception never receives budgeting, expense
approval or refund authority.
