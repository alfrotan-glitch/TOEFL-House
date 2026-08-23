# TOEFL House ERP — Server (Backend API)

The real backend for TOEFL House ERP v2.0. It replaces the original
browser-only `localStorage` mechanism with a genuine server: data lives in a
real SQLite database, users log in with real credentials, and access is
enforced by role on the server — not by a client-side dropdown.

## Why This Exists

The original (AI Studio) build had three problems unacceptable for a real ERP
handling financial data:

1. **No real backend** — all data lived in `localStorage`. Clearing the cache
   wiped everything, and there was no concurrency across devices or branches.
2. **No real authentication** — the user role was chosen in a client-side
   dropdown, with no password.
3. **Everything ran in the browser** — anyone with DevTools access could read
   or modify salaries, partner profit shares, and taxes.

This backend fixes all three.

---

## Architecture

- **Express + TypeScript (ESM)** — REST API on Node.js
- **better-sqlite3** — file-based SQLite (backup = copy one file), WAL mode
- **JWT + bcrypt** — real token auth with hashed passwords
- **15 Bounded Contexts · 12 Business Pipelines** — Domain-Driven Design
- **Rule Engine** — declarative, versioned business rules (fees, discounts,
  promotions, payroll) stored in the DB and editable without code changes
- **Event Bus** — transactional outbox; every mutation publishes a domain
  event that drives notifications, workflows, and analytics
- **Workflow Engine** — multi-step approval chains with SLA tracking

Business logic (saving engine, budget charging, salary payment) follows the
same rules as the original frontend — now executed on the server inside atomic
database transactions.

---

## Local Setup (Development)

```bash
cd server
npm install
cp .env.example .env        # then replace JWT_SECRET with a long random value
npm run seed                # first time only — builds the DB with demo data + accounts
npm run dev                 # → http://localhost:4000 (with auto-reload)
```

For production (no auto-reload):

```bash
npm start
```

---

## Environment Variables (`.env`)

| Variable      | Description                                              |
|---------------|----------------------------------------------------------|
| `JWT_SECRET`  | **Required.** Change before production. Long random string. The server refuses to start without it. |
| `DB_PATH`     | Path to the SQLite file (default `./data/erp.sqlite`)    |
| `CORS_ORIGIN` | Comma-separated frontend origin(s) allowed to call the API |
| `PORT`        | Server port (default `4000`)                             |

---

## Database

`src/db/schema.sql` is the **single source of truth** for all DDL. Inline
`CREATE TABLE` blocks are not permitted in application code.

There is no migration chain. The schema is idempotently applied to an empty
database and to a database already at this exact canonical shape. It does **not**
transform an incompatible historical shape. Under the project’s greenfield/no-production-data
operating mode, a canonical schema reconstruction requires stopping the server,
removing the old local database and WAL sidecars, then seeding a fresh database.

Verify a schema change before deploying it:

```bash
npm run preflight:fresh-schema
```

To reseed from scratch:

```bash
rm -f ./data/erp.sqlite ./data/erp.sqlite-wal ./data/erp.sqlite-shm
npm run seed
```

---

## Default Login Accounts

| Username        | Role               | Temp Password    |
|-----------------|--------------------|------------------|
| `ahmad.frotan`  | owner              | `Owner@2026`     |
| `samiullah`     | manager            | `Manager@2026`   |
| `kamran`        | finance            | `Finance@2026`   |
| `lina`          | registrar          | `Registrar@2026` |
| `farid.ahmadi`  | teacher            | `Teacher@2026`   |
| `arash.rahimi`  | head_of_department | `HeadDept@2026`  |
| `nadia.karimi`  | counselor          | `Counselor@2026` |
| `fatima.ahmadi` | donor_manager      | `DonorMgr@2026`  |

> All are temporary and must be changed on first login
> (`must_change_password` is set). Use `POST /api/auth/change-password`.
> Only the owner can create new accounts via `POST /api/users`.

---

## API Overview

Every route (except `/api/auth/login` and `/api/health`) requires an
`Authorization: Bearer <token>` header.

| Route | Description |
|-------|-------------|
| `POST /api/auth/login` | Login, returns JWT (rate-limited) |
| `GET /api/auth/me` | Current user info |
| `POST /api/auth/change-password` | Change own password |
| `GET/POST /api/users` | Manage user accounts (owner only) |
| `GET/POST /api/branches` | Branches |
| `GET/POST/PUT/DELETE /api/partners` | Partners |
| `GET/POST/PUT/DELETE /api/teachers` | Teachers, `POST /:id/pay-salary` |
| `GET/POST/PUT/DELETE /api/employees` | Employees, `POST /:id/pay-salary` |
| `GET/POST/PUT /api/classes` | Classes |
| `GET/POST/PATCH /api/sessions` | Sessions, roster, homework, analytics |
| `POST /api/attendance` | Legacy attendance (deprecated) |
| `GET/POST/PATCH /api/visitors` | Visitors, `POST /:id/followups`, `POST /:id/convert`, `GET /pipeline` |
| `GET/POST/PATCH /api/students` | Students, `POST /:id/enroll-semester`, `POST /:id/payments` |
| `GET /api/finance/overview` | Main account + savings balances |
| `GET /api/finance/budget-lines`, `POST /:id/charge`, `POST /:id/month-end` | Budget |
| `GET/POST /api/finance/expense-requests`, `POST /:id/decide` | Expense requests |
| `POST /api/finance/saving-engine/run`, `PUT /saving-engine/settings` | Saving engine |
| `GET /api/finance/transactions` | General ledger |
| `GET /api/books/workspace`, `POST /catalog`, `PATCH /catalog/:id`, stock-receipt, sale, sale-return, loan and loan-return commands | Books: catalog, immutable inventory, cash-linked sales and student lending |
| `GET/POST /api/exams`, `GET/POST /:id/results` | Exams |
| `GET/POST /api/funding/...` | Donors, campaigns, donations, scholarships, sponsorships |
| `GET/POST /api/impact/...` | Metrics, reports, success stories |
| `GET /api/pipelines/...` | Cross-context pipeline analytics |
| `GET/POST /api/rules` | Business rules (CRUD, versioning, rollback, dry-run) |
| `GET /api/events` | Domain event stream |
| `GET /api/audit-logs` | Audit report (owner/manager) |
| `GET/PATCH /api/notifications` | Notifications |

---

## Security Notes

- Passwords are hashed with bcrypt (never stored in plaintext).
- Every request must carry a valid JWT in `Authorization: Bearer <token>`.
- Access to each route is controlled by the user's **real** role (signed into
  the token), not by anything the client claims.
- Branch-scoped authorization (`resolveBranchScope`) is enforced on every
  data endpoint — registrar/teacher are locked to their own branch.
- Login is rate-limited (10 attempts per 15 minutes per IP).
- `helmet` sets security headers on every response.
- The JWT secret is validated at startup — the server will not boot without it.
- Every significant operation is written to `audit_logs` with the real IP and
  User-Agent.

Before deploying to a public server:

1. Change `JWT_SECRET`.
2. Put it behind HTTPS (e.g. Nginx + Let's Encrypt, or Railway/Render).
3. Restrict `CORS_ORIGIN` to the exact frontend address.
4. Back up `data/erp.sqlite` regularly (a simple file copy is enough).

---

## Testing

```bash
npx tsc --noEmit        # type check
npx vitest run          # 22 integration tests across 7 files
```

Test coverage includes: payment recording, discount-cap enforcement,
branch-scoping, the safe formula parser, student batch queries, semantic
payroll budget lookup, and event-bus dispatch.

Tests use a throwaway SQLite file (`src/tests/test.sqlite`) and never touch
the real database.

---

## Production Deployment

```bash
npm install
npm run seed            # first time only
npm start               # no auto-reload
```

Recommended: run under a process manager (PM2/systemd) behind an HTTPS
reverse proxy, with scheduled SQLite backups.