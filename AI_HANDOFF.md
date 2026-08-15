# AI Handoff — TOEFL House ERP

Last updated: 2026-08-15 (pass 10 — student subsystem deep audit & hardening)

## How to pick up where this session left off

1. Read `AI_EXECUTION_STATE.md` and `docs/RELEASE_GATE.md` first.
2. Check `git status` and `git log` for the latest checkpoint.
3. Verify the baseline (all should pass):
   ```bash
   npm run typecheck && npm run lint && npm run build        # frontend
   cd server && npm run typecheck && npm test && npm run build # backend
   cd .. && npm run audit:product && npm run audit:static     # audits
   cd server && npm run preflight:fresh-schema
   ```
4. Runtime smoke (includes the password-quarantine flow):
   ```bash
   cd server && npm run bootstrap && npm start                # backend :4000
   # login as owner → GET /api/auth/me shows mustChangePassword:true
   # → POST /api/auth/change-password → re-login → full API works
   # in another shell: npm run dev                             # frontend :3000
   ```

## Architecture map (for orientation)

- Frontend: `src/` — React 19 + Vite 8 + Tailwind 4; API client
  `src/api/client.ts`, store `src/apiStore.ts` (`bq` is memoized — keep it
  stable; reloader callbacks depend on `[bq]`), roles
  `src/config/roles.ts`, permissions `src/config/permissions.ts`, navigation
  `src/config/navigation.ts`. Workspace views are lazy chunks in `App.tsx`
  under a `Suspense` boundary.
- Backend: `server/src/` — Express + better-sqlite3. Boot:
  `index.ts` → `db/connection.ts` (schema.sql → migrations → hierarchy seed →
  RBAC bootstrap). Core engines in `core/` (rbac, academic — incl.
  `class-capacity.ts`, configuration, payroll, journey, events). Routes in
  `routes/` (thin, guarded by `authenticate` + `authorize`/`requirePermission`).
- DB: `server/src/db/schema.sql` is the full current shape; `migrations/`
  (001–051) bring legacy DBs forward. `migrate.ts` supports
  `PRAGMA foreign_keys = OFF` markers and FK-safe table rebuilds.

## Key invariants to protect

- **Class capacity** is read ONLY from `enrollments` (active/confirmed/pending)
  via `countActiveStudentsInClass` — never from `student_semesters`.
- **student_semesters is a derived projection**: written by
  `EnrollmentService.enroll()` (same transaction) unless the caller passes
  `writeSemester:false` because it owns a richer row. Never add a third
  writer.
- **Password quarantine**: while `users.must_change_password=1`, only
  `/api/auth/{change-password,logout,me}` are reachable. Changing the password
  bumps `session_version` (revokes all old tokens). Keep the allowlist in
  `src/middleware/auth.ts` in sync with any new pre-change auth endpoint.
- `visitors.placement_status` CHECK allows
  `('not_started','scheduled','in_progress','completed','waived')` — do not
  regress migration 051's rebuild.
- `authorize()` intentionally grants the owner role; business-rule 409 gates
  are separate from role gates — never remove a 409 guard to "fix" a test.
- Financial authority stays on the backend (`recordIncome` must run inside a
  `db.transaction()`; savings skim is automatic).

## Pass 5 — finance command center + cleanup (what changed)

- **`GET /api/finance/dashboard`** (server-computed, branch-scoped): balances,
  today/month income-expense-net, budget utilization + exhausted/at-risk lines,
  receivables (open/overdue/drafts/collected-this-month), pending approvals,
  reconciliation health, 14-day trend, settings. Backend-only financials —
  the UI renders, never computes.
- **Frontend command center** (`src/components/finance/FinanceDashboardPanel.tsx`)
  replaces the sparse Overview tab: KPI row, "needs attention" action center
  (quick approve/reject for managers), cash-flow bar chart, receivables +
  recent ledger, role-aware quick actions and a "how to work" playbook
  (finance desk vs budget controller).
- **Latent RangeError fixed**: `GET /api/finance/reconciliation?branchId=all`
  crashed with "Too many parameter values" (bound `undefined` to
  zero-placeholder statements). Extracted `server/src/utils/reconciliation.ts`
  — shared by `/reconciliation` and `/dashboard`; regression test added.
- **Dead code removed**: `server/src/db/bootstrapEnvironment.ts`,
  `server/scripts/domain-audit.mjs`, `scripts/forensic-release-audit.mjs`,
  `scripts/install-frontend-clean.ps1`, `ERP.zip` (was git-tracked), unused
  `incrementNumberSetting` imports, duplicate saving-engine prepared
  statements, dead `designer` role label.
- **Tests**: `server/src/tests/finance-dashboard.test.ts` (5 tests) — totals,
  branch isolation, owner org aggregation, auth guard, reconciliation org
  scope. Suite is now 400/400.

## Pass 6 — final hardening (what changed, with evidence)

- **Student-role isolation closed**: a student principal is now denied
  (403) on `/api/search`, `/api/attendance`, `/api/notifications`,
  `/api/academic/programs|levels`, `/api/skills`, `/api/branches`,
  `/api/campuses`, `/api/organization` (runtime-verified; unit-tested).
  New `denyPermissionless` middleware rejects principals whose positions
  grant no permission; the student portal still reaches `/api/students/me`.
- **Owner equivalent access**: `requirePermission` now grants the owner
  (matching `authorize`), so the owner can refund and reach every
  permission-gated route.
- **Refund repaired**: route uses the real `Refund.Approve` permission
  (granted to finance_manager + general_manager); fixed a latent
  `RangeError` (11 args vs 10 placeholders) in the refund INSERT that the
  previous 403 masked. Verified end-to-end: payment → refund →
  contra-revenue ledger entry → refundable-balance cap.
- **P&L single source of truth**: `/api/finance/pnl` now excludes capital
  injections, profit distributions, budget charges and saving transfers
  from operating income/expense and reports them as `transfers`; the PnL
  tab renders this server payload instead of recomputing client-side.
- **Ledger navigable at scale**: `/api/finance/transactions` paginates
  (limit/offset + `includeTotal=1` → `{rows,total}`); LedgerPanel
  self-fetches pages with Load-more.
- **Audit log searchable**: `/api/audit-logs` supports operatorName /
  action / dateFrom / dateTo filters + pagination; AuditLogView is
  server-driven with filter UI and correct totals.
- **Reporting**: new `GET /api/reports/overview` (server-computed,
  period today/month/year/range, gender splits, branch/organization scope,
  printable Report ID header). OperationsReportView is now a real report.
- **Session revocation**: logout bumps `session_version` — captured JWTs
  die immediately (verified).
- **Rate limiting**: `student-login` gets its own 60/15-min limiter so an
  office NAT with many students is not locked out by the 10/15-min staff
  limiter (30 parallel student logins verified 200).
- **Misc**: dynamic fiscal years; `Owner` label everywhere; dead
  `domainEvents` state removed; `designer` role removed (migration 053);
  invoice create now snapshots `student_name`/`student_code`; receptionist
  collected payments verified to enter income without any finance
  management capability.
- **Tests**: `final-hardening.test.ts` (18 tests) — suite now 418/418.

## Pass 7 — gap closure (what changed, with evidence)

- **Position lifecycle UI (spec: dynamic positions)**: new owner-only
  `Positions & access control` section in System Administration —
  `PositionsPanel.tsx` (list/create/rename/describe/activate/deactivate +
  per-permission scope editor) and `UserPositionsPanel.tsx` (assign/remove
  positions per user with campus/branch/organization scope + live effective
  permissions view). Backend additions: `POST /security/roles`,
  `PATCH /security/roles/:id`; deactivated positions stop contributing
  permissions immediately (rbac resolution filters `roles.is_active`), and
  the boot catalog re-sync preserves manual deactivation.
- **Fixed latent bug**: removing a user position crashed (500) because
  `stmtGetUserRoles.get()` was treated as an array — now `.all()`.
- **Reception ≠ Finance strengthened**: all financial-truth reads
  (`/finance/transactions|overview|budget-lines|expense-requests|pnl|
  dashboard|expense-report`) now require a finance-role permission;
  `Payment.View` (a reception capability) no longer unlocks the ledger,
  treasury or budgets. Reception payment collection still records income.
- **Traceability**: migration 054 adds `financial_transactions.operator_role`;
  `recordIncome` and all 13 call sites persist the operator's position.
- **LAN readiness**: backend now binds `0.0.0.0` by default (`HOST` env to
  restrict); verified reachable via a non-loopback address. README documents
  firewall/CORS/client-URL requirements.
- **Tests**: `position-lifecycle.test.ts` (15) — create/duplicate/deactivate/
  reactivate/boot-persistence, multi-position union + scope + removal,
  three-owner equality + mutual administration, female-reception separation +
  URL-escalation attempts, report↔ledger reconciliation, audit append-only,
  concurrent receipt/invoice/student-code uniqueness, concurrent refund
  atomicity. Suite now 433/433.

## Pass 8 — Placement Exam deep audit (evidence-based, what changed)

**Actual architecture discovered**: the placement exam is a **staff-scored
component assessment** (components: skill_scores / written_test / interview /
level_assessment / custom_score), configured per program-version+branch via
`placement_assessment_profiles` (weights must total 100%), with attempts that
snapshot the profile and `placement_rules` mapping percentage → level. There
is **no question bank and no candidate-facing exam session** — this is the
actual design, not a missing feature. Scoring is **server-authoritative**
(component scores and the final percentage are computed in
`placement.routes.ts`; the frontend only sends raw inputs).

**Verified working (evidence in placement-deep-audit.test.ts, 11 tests)**:
permission matrix (owner/registrar/manager/counselor can; finance/teacher/
student denied), attempt isolation (cross-visitor 404/409, completed
immutable, duplicate submit 409), cross-branch isolation (branch-scoped
registrar 403; owner org-scoped), score boundaries (0..max), retake policy
(allow_retake flag), conversion gate (required+enabled profile blocks
conversion without completed placement), gap behavior (score in an unmapped
range → explicit recommendation_text, level null).

**Fixes implemented (evidence-justified)**:
1. **HIGH — placement fee was booked as income with NO payment row or
   receipt** (payment_id NULL, zero 'placement' payments existed). Now the
   completion transaction creates a receipted `payments` row (category
   'placement', idempotency key `placement:<attemptId>`) and links the income
   to it — the fee is payment-backed and reconciles.
2. **MEDIUM — completion UPDATE had no status guard**; a duplicate submit
   could re-run scoring logic. Now `WHERE id=? AND status='in_progress'` with
   a row-count check (409 on zero changes) — double-booking of the fee is
   structurally prevented.
3. **MEDIUM — reports lacked placement depth**. `/api/reports/overview`
   now returns `operational.placement`: attempts / completed / inProgress /
   cancelled / avgScore / convertedToStudent / levelDistribution, all derived
   from authoritative `placement_assessment_attempts` + `visitors`.
4. **LOW-MEDIUM — schema inconsistency**: `placement_assessment_attempts` and
   `placement_assessment_results` existed only in migration 038, not in the
   canonical `schema.sql`. Both tables + indexes are now in schema.sql (no-op
   for existing DBs; fresh-schema preflight passes).

**Documented, not changed**: level-rule gaps are allowed by config (an
unmapped score yields a null recommendation with explicit text — visible, not
silent); the student 'placement' payment category is API-only (not in the
student payment UI) and can double-book a fee for a converted candidate — a
conscious operator action, documented as residual risk; `durationMinutes` is
config metadata only (no timer enforcement) — there is no candidate-facing
session in this design.

## Pass 9 — Placement final hardening audit (evidence-based)

Re-verified the entire placement lifecycle against the running system. New
evidence suite `placement-hardening.test.ts` (11 tests) plus live E2E.

**Defect found and FIXED (HIGH — financial integrity)**: a converted student
paying the API-only `placement` payment category could duplicate the
already-auto-booked placement fee (income 300 → 600 for one candidate).
`students.routes.ts` now rejects a `placement` payment with 409 when the
student's originating visitor already booked the fee at assessment completion
(idempotency key `placement:<attemptId>`). Exactly one payment + one income
per candidate is now enforced (unit + live verified).

**Defect found and FIXED (MEDIUM — audit traceability)**: the placement
completion audit did not record the financial reference. The completion audit
`new_value` now embeds `{ fee: { amount, receipt, paymentId, attemptId } }`.
Also migration 055 adds `audit_logs.operator_role` (position frozen at the
time of every audit action; mirrors financial_transactions.operator_role from
054). Live-verified: audit row carries operator_role='owner' and the receipt.

**Defect found and FIXED (MEDIUM — schema consistency)**: `payments.idempotency_key`
column + `uq_payments_idempotency` unique index existed only in migration 047,
not in canonical schema.sql. Now in schema.sql (no-op for upgraded DBs;
fresh-schema preflight passes).

**Improved (MEDIUM — reporting)**: placement income now resolves gender through
the candidate visitor (placement fee payments have student_id NULL), so
gender-filtered reports and the income gender split correctly attribute
placement income to male/female instead of 'unclassified'. Live-verified:
placement income 300 shows female=300.

**Verified already-correct (no change)**: RBAC matrix (owner/manager/registrar/
counselor allowed; finance/teacher/student denied for view/start/score/complete/
cancel); branch isolation (branch registrar 403, owner org-scoped); attempt
isolation + immutability; profile snapshot (historical attempts unchanged when
rules edited later); level boundaries (exact 49→A1, 51→B1, 0→A1, 100→B1, gap 50
→ null level with explicit text); conversion gate (required blocks, optional
converts, duplicate 409, cross-branch 400); report↔ledger exact reconciliation;
concurrent completion (10 parallel → exactly 1 success + 9 conflicts, 1 payment
+ 1 income row).

Suite: 42 files / 455 tests; frontend typecheck/lint(0/0)/build green;
fresh-schema preflight green; live E2E green.

## Pass 10 — Student subsystem deep audit (evidence-based)

Reproduction suite `student-deep-audit.test.ts` proved two defects, then the
fixes were locked in:

**FIXED (HIGH — financial integrity)**: `enroll-semester` had NO duplicate
guard — a double-click / retry created multiple ACTIVE `student_semesters`
rows with the same name and charged the tuition once per row (reproduced:
4 concurrent submits → 4 semester rows + 4 income rows; even 2 sequential
submits duplicated). Fix: friendly in-transaction 409
("Student is already enrolled in <semester>") + partial unique index
`uq_student_semester_active (student_id, semester_name) WHERE status='active'`
(migration 056, canonical in schema.sql). Legitimate repeats of a COMPLETED
semester remain allowed. Verified: 4 submits → exactly 1×201 + 3×409, 1
semester row, 1 income row; repeat-after-completion works.

**FIXED (MEDIUM — audit traceability)**: 8 Student operations wrote NO
`audit_logs` entry (student creation, payments, refunds, semester enrollment,
extra-class enrollment, ID-card issuance, profile PATCH, transfer) — identity
/ gender / discount / placement-result edits were completely untraceable.
Added `writeAudit` to all 8 with operator, action, and a JSON payload
(receipt/paymentId for financial ops; before/after identity snapshot for
profile edits). Verified live + in tests.

**NOT defects (evidence):** concurrent issue-card charges the card fee once
(single-process synchronous — no race); concurrent same-key payments replay
200/201 without 500 or duplication; `enroll-class` already guards duplicate
active enrollment; student list/search/detail are branch-scoped and
`requireStudent` blocks cross-branch reads (403); phone/email/tazkira unique
indexes prevent identity collisions; PATCH cannot change branch; student-role
cannot list/read other students (verified in prior passes and re-run here).

Suite: 43 files / 462 tests; typecheck/lint(0/0)/build green; fresh-schema
preflight green; live E2E green (enroll-semester 409, audited profile edit
with before/after, audited payment with receipt, branch isolation 403).

## Pass 12 — Complete ERP forensic audit (cross-system)

New suite `erp-forensic.test.ts` traced the full cross-system lifecycle
(visitor → placement → conversion → student → payment → exam → certificate →
report → audit) and attacked the seams between subsystems.

**Defect reproduced and FIXED (HIGH — cross-system financial duplication)**:
the certificate path (exams.routes) books `diploma` income directly with NO
payments row, while the pass-11 once-per-student diploma guard checked only
the payments table. Result: a manual `diploma` payment after a certificate
was allowed → 1000 AFN diploma income for one student; and the reverse order
(manual payment then certificate) also double-charged. Fix: the fixed-fee
guard now checks BOTH the payments table AND the authoritative ledger
(financial_transactions income, reference_id = student), and the certificate
path skips the fee when the student already paid it via the desk. Verified
both directions live + concurrency (10 parallel → exactly 1×201 + 9×409, one
income row).

**Verified (no change)**: full lifecycle E2E preserves identity/branch/
placement/finance/audit; teacher cannot score exams or create students;
report income total exactly equals the ledger (reconciliation); notification
endpoint denies permissionless (student) principals; 10k-student search 8ms
and report 11ms; conversion income is invoice-referenced (test corrected —
not a defect).

Suite: 45 files / 476 tests; typecheck/lint(0/0)/build green; fresh-schema
preflight green; live E2E green.

## Pass 14 — Reporting / financial / operational forensic audit

Reproduction suite `reporting-forensic.test.ts` (8 tests) + live E2E.

**Defect reproduced and FIXED (CRITICAL — period correctness)**: the report
period resolver capped the `to` bound at TODAY for every month/year request,
so a historical report (?month=2026-06, ?year=2025) silently included
later-period transactions (June reported 1700 incl. July; 2025 reported 1700
incl. all 2026). Fix: calendar periods now span the FULL period
(month → last day of month; year → Dec 31; added quarter → Q1..Q4); invalid
months/years rejected. Verified: June = 1200 exactly, 2025 = 0, Q2 bounds
correct, live org-scope June = 1000.

**Metrics added (explicitly required, authoritative sources)**: discounts
(invoices.discount_amount + registrations.discount_applied), outstanding
balances (open-invoice net − paid), books sold by title (book_sales JOIN
books), and a server-computed previous-period comparison (income/expense/net
deltas) with an inclusive-day same-length window. Frontend renders all of
them (discounts, outstanding, books-by-title, %-change vs previous period).

**Verified (no change)**: income/expense reconciliation (report == SUM
fin_tx for the period); refunds reduce income; ledger endpoint honors
explicit from/to; branch isolation (finance(rfb2) sees 0 for other branch's
data even with branchId=all); gender splits (placement income via visitor);
expense categories aggregate from the authoritative ledger.

Suite: 47 files / 488 tests; typecheck/lint(0/0)/build green; fresh-schema
preflight green; live E2E green.

## Suggested next high-value tasks (in order)

1. **Frontend runtime verification of role workspaces** — log in as each role
   (esp. `finance` — the new command center) and verify navigation + key
   screens render (manual or browser automation); confirm the lazy chunks load
   and the Suspense fallback is unobtrusive.
2. **Frontend lint is now 0/0** (pass 4+). Keep it that way: new effects must
   follow the async-IIFE / adjust-during-render patterns used here; do not
   reintroduce eslint-disable comments.
3. **Converge the auth model onto permission codes** — replace `authorize()`
   role lists with `requirePermission()` across routes (large but mechanical;
   keep the owner-superuser grant).

   Auth modules now live in `src/contexts/`: `auth-context.ts` (context +
   types), `AuthProvider.tsx` (provider), `useAuth.ts` (hook). Update these
   three, not a monolithic AuthContext.tsx.
4. **Production deployment pass** — reverse-proxy, HTTPS, DB backup strategy,
   `NODE_ENV=production` smoke (bearer auth disabled by default).

## Environment notes

- Node v22.22.3 / npm 10.9.8. Registry reachable; nodejs.org and GitHub
  release assets are NOT reachable from this sandbox — native modules must be
  compiled from source (`npm_config_nodedir=/usr/local npm_config_build_from_source=true`).
- Use `npm ci` (root lockfile committed).
- The runtime DB and `server/.env` are git-ignored; a fresh bootstrap
  regenerates credentials.

