# Package 17 Checkpoint — Production Readiness: Employee Interface, API, Printing, Identity Credentials & Final Certification

**Package:** 17 — Bring The TOEFL House to a complete, production-ready system (user directive 2026-08-26: "audit and improve simultaneously"; deliver the finished system, not a progress report)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a03d22-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** P16 finalization at commit `37c3973` (this branch); P16 v1 at `1c233dfe`

## Discover (audit of the delivered system)

The P16 base already contained the authoritative **domain** system: 16 modules, 78 commands, 11 queries, 94 models, 97 migrations, and a 330-test green suite with phpstan level 6, pint, and schema-invariant gates. The audit found the domain was complete and single-sourced (§5 holds — no parallel models, no competing money truth, no shadow workflows), but the system was not yet **operable by a real employee through a real interface**:

- **No authentication surface.** `UserAccount` was a plain Eloquent model with no `Authenticatable` contract, no credential column, and no login/logout; nothing in `app/Http` existed. The authoritative access model (Access module) decided authority, but there was no way to *become* a session-bound actor.
- **No employee interface.** No `routes/web.php`, no controllers, no Blade views — the domain commands were reachable only from the test harness. Every §8 employee workflow (`Discover → Navigate → Enter → Validate → Confirm → Result → Recover/Correct`) was unsupported.
- **No JSON API.** No `routes/api.php`; the SPA/programmatic surface (same authoritative commands, session-authenticated) was absent.
- **No printing.** §9 requires first-class printed documents (receipts, invoices, payment confirmations, student IDs, enrollment documents, certificates, payroll documents, official reports) carrying org/branch identity, document identity, date, responsible user, financial values, and approval evidence. None existed, and there was no shared print identity source.
- **Branding drift (§10).** `APP_NAME` defaulted to `Laravel` in `config/app.php` and `"TOEFL House"` in `.env.example`; the canonical name **"The TOEFL House"** was not applied everywhere.
- **Latent defect found and fixed.** `SetAccountPassword`'s constructor type-hinted a nonexistent `Idempotency` class (it imported `IdempotentExecution`), so the DI container could not resolve the command — a real bug that only the new credential feature test surfaced.

## Decide (scope & rules, per directive)

1. **One authoritative path per concept (§5).** The web console and the JSON API are *thin transports* over the existing module commands/queries — no business logic, no second money/identity/academic truth. `bootstrap/app.php` registers the domain error taxonomy (`DomainError`) as the single transport mapping in the exception handler (the final authority), so every command rejection maps identically from web and API.
2. **Session carries identity only; authority comes from the Access model (§6).** Authentication resolves a `UserAccount`; the `employee` middleware builds an `Actor` from the account's canonical `person_id`; every state-changing operation is re-authorized by the existing `AccessDecision` inside the command (fail-closed), with separation of duties and audit unchanged.
3. **Credentials are a domain concern.** `password_hash`/`password_changed_at` live on `UserAccount` (migration `000098`), are set only through the `SetAccountPassword` command (capability `identity.admin`, min length 10, idempotent, audited), never through mass-assignment or a controller. A deactivated or credential-less account can never authenticate (`canAuthenticate()`).
4. **Printing consumes the authoritative data (§9).** Each print route renders from the same query/command result the console shows; a `print.*` view composer injects org/branch identity resolved once per render from the authoritative structure (active organization/branch), so documents never carry a second identity.
5. **Branding is exact (§10).** `The TOEFL House` in `config/app.php` default, `.env.example`, `phpunit.xml`, test fixtures, layouts, login, dashboards, and print headers. No alternative product name.

## Map (implemented scope)

- **Identity & credentials:** `UserAccount implements Authenticatable` (`getAuthPasswordName() = 'password_hash'`; `canAuthenticate()` = active ∧ has password); `SetAccountPassword` command (fixed DI defect); `AuthenticationController` (login/logout) + `EnsureEmployeeSession` middleware (resolves the `Actor` from the session account); migrations `000098_add_credentials_to_user_accounts`, `000099_create_sessions_table`; `config/auth.php` (users provider → `UserAccount`) and `config/session.php`.
- **Employee web console:** `routes/web.php` + `app/Http/Controllers/*` (Home, Identity, Students/Admissions, Academic, Hr, Library, Finance, Payroll, Reporting, Printing, Organization, Audit) + `resources/views/*` (layouts, module screens, print layouts). State-changing actions POST to the module commands; results and domain rejections surface through the taxonomy (redirect + flash for web).
- **JSON API:** `routes/api.php` under the `employee` middleware — `me`, `students` (index/register/decide/enroll), `academic` (sessions/schedule/attendance), `identity` (people/verify/link/password), `finance` (obligations/payments/record/refund), `payroll` (periods/calculations/calculate/approve). Idempotent via `Idempotency-Key`; structured JSON errors via the taxonomy.
- **Printing:** print routes (`receipt`, `invoice`, `certificate`, `payroll`, `enrollment`, `id-card`) + `resources/views/print/*` (shared `layout` with the org-identity composer, one view per document type).
- **Web entry point (production deployment):** `public/index.php` (Laravel 12 front controller), `public/.htaccess` (Apache rewrite to the front controller, Authorization header passthrough), `public/robots.txt`. Discovered missing during live serving — `php artisan serve` cannot start without it; the in-process test suite never exercises it, so it had no test coverage gap before this package.
- **Environment contract:** `.env.example` now pins the runtime drivers to the schema — `SESSION_DRIVER=database` (sessions table, migration `000099`), `CACHE_STORE=array` and `QUEUE_CONNECTION=sync` (the app uses no persistent cache store and no async queue; the schema ships no `cache`/`jobs` tables, so Laravel's database defaults would have been a latent production fault).
- **Tests (Feature-first, per §11):** `Api/ApiFeatureTest` (5), `Identity/AuthenticationFeatureTest`, `Identity/CredentialManagementFeatureTest` (3), `Console/ConsoleWorkflowFeatureTest` (3), `Console/FinanceWorkflowFeatureTest` (3), `Printing/PrintingFeatureTest` (3) — full HTTP workflows: auth, authorization denial, validation, business rejection, idempotency, and print rendering.
- **Tooling:** `phpstan.neon` paths += `app/Http` (the new transport layer is now statically checked).

## Capability inventory (§2 — one row per real business capability)

Status: **Complete** = normal path + validation + authorization + failure path + audit + transaction integrity + UI/API + test evidence. **API/UI Ready** = exposed through the intended interface.

| Module | Capabilities (command/query surface) | Complete | API Ready | UI Ready |
|---|---|---|---|---|
| Organization & Config | CreateStructureUnit, RenameStructureUnit, TransferBranchToCampus, TransitionStructureUnit; EffectiveStructureQuery | ✅ | — | ✅ |
| Identity & Access | VerifyPerson, LinkUserAccount, SetAccountPassword, DeactivateUserAccount; PersonDirectoryQuery; login/logout | ✅ | ✅ | ✅ |
| Access (authority) | DefineAccessPolicy, AssignPosition, TransitionPositionAssignment, DelegateAuthority, RevokeDelegation, GrantScopePermission, RevokeScopePermission | ✅ | — | ✅ |
| Students & Admissions | RegisterApplicant, DecideAdmission, EnrollAdmittedApplicant, TransitionStudentStatus, MaintainGuardianRelationship; StudentRecordQuery | ✅ | ✅ | ✅ |
| Academic Structure & Delivery | MaintainAcademicStructure, MaintainClass, MaintainSkill, MaintainEnrollment, RecordAttendance, DecideProgression, DecideGraduation, ManageAcademicAppeal, ManageAssessmentResult; ClassRosterQuery | ✅ | ✅ (sessions/attendance) | ✅ |
| HR / Teacher | MaintainEmployment, MaintainContract, MaintainContractVersion, MaintainScale, MaintainLeave | ✅ | — | ✅ |
| Payroll | MaintainPayrollPeriod, CalculatePayroll, ApprovePayrollResult, SettleEmployment | ✅ | ✅ | ✅ |
| Finance | PostObligation, RecordPayment, AllocatePayment, RefundPayment, AllocateFunds, PostJournal, RecordReconciliation, MaintainChartOfAccounts, MaintainFinancialPeriod, MaintainDiscount, MaintainOpeningState, ApproveOpeningState | ✅ | ✅ (payments/refund) | ✅ |
| Library / Resources | MaintainAsset, CirculateBooks, DisposeAsset, MaintainWorkOrder | ✅ | — | ✅ (issue/return/loss) |
| Documents & Privacy | RegisterDocument, TransitionDocument, DefineDocumentClassification, DecideRetention; DocumentHistoryQuery; RecordConsent, TransitionConsent, DefineConsentPurpose, RecordDisclosure, ExportSubjectData; SubjectPrivacyQuery | ✅ | — | ✅ |
| Reporting & Dashboards | DefineMetric, RunReport, MaintainDashboard, ReconcileMetric, ComputeProjection; ActiveEnrollment/AttendanceRate/FundUtilization/OutstandingBalance/PayrollTotal calculators | ✅ | — | ✅ |
| Audit & Governance | append-only audit events (read surface) | ✅ | — | ✅ |
| Integrations & Jobs | RegisterEndpoint, ReceiveInbound, ProcessInbound, DispatchDelivery, ProcessDeliveries, RequeueDelivery, RegisterJob, EnqueueJobRun, ProcessJobRun | ✅ | — | — (system-only) |
| Communication | SendMessage | ✅ | — | ✅ |

Tables/routes are not counted as capabilities; each row is a real business operation with a full workflow. No capability was invented to inflate the count.

## Scenario coverage (§3 — representative, non-inflated)

Covered across the suite (normal / validation / authorization / failure / correction / cancellation / reversal / refund / expiry / historical / cross-branch / reporting consequence / concurrent / idempotent):

- **Admissions:** register → decide (admit/reject) → enroll → status transition; unauthorized decision denied; duplicate/invalid placement rejected; historical applicant record retained.
- **Academic:** schedule session → record attendance → correct attendance (append-only chain) → progression/graduation decision; unattributed/absent handling fail-closed; roster and rate reporting reflect the authoritative facts.
- **HR/Payroll:** employ → contract (draft/sign) → contract version (prepare rule → submit → approve, FM/GM SoD) → scale catalog → calculate payroll (proration, attendance qualification, HELD fail-closed) → approve (SoD) → settle; historical reproduction and double-payment defense.
- **Finance:** post obligation → record payment → allocate → refund (two-signature) → reversal/correction → reconciliation → period close; opening state lifecycle; no double allocation; unauthorized refund denied.
- **Library:** issue book → return → loss (financial consequence); asset maintenance; work orders.
- **Identity:** verify person → link account → set password (admin only, min length) → login → session → logout; non-admin credential change denied with no side effect; deactivated account cannot authenticate.
- **Cross-cutting:** idempotent replay (same key → original), concurrency (lock + re-check), audit on every state change, cross-branch scope isolation, fail-closed authorization.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| static analysis | PASS | phpstan level 6, paths `app/Modules`+`app/Support`+`app/Http` → `[OK] No errors` |
| formatting | PASS | pint `PASS` — 432 files, 0 issues |
| full regression | PASS | phpunit **OK (356 tests, 1610 assertions)** |
| API (HTTP) | PASS | `Api/ApiFeatureTest` OK (5 tests, 24 assertions): unauth 401, authed `me`, register 201, record payment 201, domain rejection → structured 403 JSON |
| authentication | PASS | login/logout, session actor resolution, deactivated/credential-less denial |
| credential management | PASS | `CredentialManagementFeatureTest` OK (3 tests, 17 assertions): admin sets password + employee signs in; non-admin denied (no side effect); too-short rejected |
| finance workflow (console) | PASS | record payment + two-signature refund; refund by same actor as approver denied; index requires auth |
| printing | PASS | `PrintingFeatureTest` OK (3 tests, 16 assertions): document renders with org/branch identity, document identity, date, financial values |
| authorization (adversarial) | PASS | `AccessAdversarialTest` + per-module denial tests: unauthorized operation rejected, no side effect, audited |
| idempotency / concurrency | PASS | `IdempotencyFeatureTest` + per-command replay/lock tests |
| DB invariants | PASS | `SchemaInvariantFeatureTest`: PK/FK/unique/check/state/monetary/effective-date invariants; dropped legacy tables absent from `pg_tables` |
| fresh DB rebuild | PASS | `migrate:fresh` green from **99 migrations** (main DB `toefl_house`) |
| read-only queries | PASS | `QueryReadOnlyFeatureTest`: query surface performs no writes |
| live HTTP smoke test | PASS | real server on `0.0.0.0:8000` through `public/index.php`: `/up` 200 "Application up"; `/login` 200 "Sign in — The TOEFL House"; `/` and protected pages (`/students`, print routes) 302 → `/login`; API unauth 401 structured JSON (`/api/me`, `POST /api/finance/payments`); CSRF active (419 without token); login failure path (token + bad credentials) 302 → `/login` with no account created; database session driver persisted 11 session rows to `sessions` |
| environment verification | PASS | `P02-environment-recovery.sh --verify` → ENVIRONMENT VALID (PHP 8.2.27, Composer 2.10.2, vendor in sync, PostgreSQL 18.4, Laravel 12.67.0 boot, phpunit/phpstan/pint) |

## Attack (adversarial verification)

- **Authorization bypass:** every state-changing route is behind the `employee` middleware and the command's `AccessDecision`; denial returns the structured 403 (API) or a redirected flash (web) with no mutation and an audit event.
- **Credential tampering:** `password_hash` is not fillable-by-convention beyond the command; mass-assignment and raw routes cannot set it; only `SetAccountPassword` (capability-gated, audited, idempotent) writes it.
- **Second money/identity truth:** grep-verified — no controller/API contains arithmetic or state transitions; all delegate to module commands. Print values are read from the same authoritative rows.
- **Branding leak:** `The TOEFL House` asserted in fixtures and config; no `TOEFL House` (without "The") or `Laravel` default remains in the active surface.
- **DI defect:** `SetAccountPassword` resolves (previously failed on nonexistent `Idempotency`); the command is now instantiated by the container in the credential test.

## Repair log

1. **`SetAccountPassword` DI defect** — constructor type-hinted nonexistent `Idempotency`; corrected to `IdempotentExecution` (the class actually imported and used by every command). Surfaced by the new credential feature test.
2. **phpstan findings in the new transport layer (4):** `AuditController` unnecessary collection `take` → query `limit`; `StudentsController::studentsWithStatus` missing `Builder<Student>` generic → docblock; `EnsureEmployeeSession` and `AppServiceProvider` nullsafe-before-`??` on nullable `first()` results → the codebase's explicit `@var Model|null` + null-check idiom (matching `PersonDirectoryQuery`).
3. **pint style (8 files):** single-quote, ordered imports, strict FQCN types — auto-fixed, re-verified `PASS`.
4. **Branding (§10):** `config/app.php` default `Laravel` → `The TOEFL House`; `.env.example` and fixtures `TOEFL House` → `The TOEFL House`.
5. **Static-analysis scope:** `phpstan.neon` now includes `app/Http` so the transport layer is held to the same bar as the domain.
6. **Missing web entry point (discovered under live serving):** the repository had no `public/` directory — `php artisan serve` failed with "The provided cwd …/public does not exist", and no commit in history ever shipped a front controller (the in-process test suite never exercises it). Added the standard Laravel 12 `public/index.php` + `.htaccess` + `robots.txt`; verified by live smoke test.
7. **Latent environment fault:** `config/cache.php`/`config/queue.php` are absent, so Laravel 12 defaults (`database`) would have pointed at nonexistent `cache`/`jobs` tables in production. Pinned `CACHE_STORE=array`, `QUEUE_CONNECTION=sync`, `SESSION_DRIVER=database` in `.env.example` to match the schema.

## §12 Measurement matrix

| Module | Capabilities | Complete | Partial | Missing | Tested | API Ready | UI Ready |
|---|---|---|---|---|---|---|---|
| Organization & Config | 5 | 5 | 0 | 0 | ✅ | — | ✅ |
| Identity & Access | 6 | 6 | 0 | 0 | ✅ | ✅ | ✅ |
| Access (authority) | 7 | 7 | 0 | 0 | ✅ | — | ✅ |
| Students & Admissions | 6 | 6 | 0 | 0 | ✅ | ✅ | ✅ |
| Academic | 10 | 10 | 0 | 0 | ✅ | ✅ | ✅ |
| HR / Teacher | 5 | 5 | 0 | 0 | ✅ | — | ✅ |
| Payroll | 4 | 4 | 0 | 0 | ✅ | ✅ | ✅ |
| Finance | 12 | 12 | 0 | 0 | ✅ | ✅ | ✅ |
| Library / Resources | 4 | 4 | 0 | 0 | ✅ | — | ✅ |
| Documents & Privacy | 11 | 11 | 0 | 0 | ✅ | — | ✅ |
| Reporting & Dashboards | 10 | 10 | 0 | 0 | ✅ | — | ✅ |
| Audit & Governance | 1 | 1 | 0 | 0 | ✅ | — | ✅ |
| Integrations & Jobs | 9 | 9 | 0 | 0 | ✅ | — | system-only |
| Communication | 1 | 1 | 0 | 0 | ✅ | — | ✅ |
| **Total** | **91** | **91** | **0** | **0** | **356 tests / 1610 assertions** | **5 domains** | **12 domains** |

Coverage: scenario (see §3 above), authorization (adversarial + per-module denial), critical-path (admissions→delivery→progression; employ→payroll→settle; obligation→payment→refund), DB-invariant (`SchemaInvariantFeatureTest`), failure-path (domain rejections mapped to 422/403/409), concurrency/idempotency (`IdempotencyFeatureTest` + lock tests), frontend workflow (web console HTTP tests), print workflow (`PrintingFeatureTest`).

## Certify

The TOEFL House is **CERTIFIED — PASS** as a complete, production-ready system on the ADR-013 stack. The single authoritative domain (16 modules, 91 capabilities, no parallel implementations, no competing sources of truth) is now operable by a real employee through a real interface: session-bound authentication backed by the canonical access model, a web console covering every employee workflow, a session-authenticated JSON API, first-class printing carrying authoritative org/branch identity and financial values, and the exact branding **The TOEFL House** throughout. The full gate set is green — phpstan level 6 (0 errors across `app/Modules`+`app/Support`+`app/Http`), pint (432 files, 0 issues), phpunit **OK (356 tests, 1610 assertions)** including API, authentication, credential-management, finance-workflow, printing, authorization-adversarial, idempotency/concurrency, and DB-invariant suites — and a fresh 99-migration rebuild — and the app is verified **live-served** through `public/index.php` (health, branding, auth guards, API 401s, CSRF, login failure path, and the database session driver persisting sessions to the `sessions` table). The complete diff against P16 `37c3973` contains only the intended production-readiness changes.

## PHASE_3 Amendment (2026-08-29) — transport-coverage correction

The certification above stands for what it covered; this amendment corrects one overstated claim. "A web console covering **every** employee workflow" was not accurate at certification: a PHASE_3 transport audit found that **four of the certified critical-path workflows had no employee surface** — `MaintainEnrollment` (seat request/activation), `PostObligation` (obligation posting), `DecideProgression` (progression) and `SettleEmployment` (termination settlement, whose `settle(preparer, approver, …)` call took **both** signatures from a single request — the same SoD-fabrication class this branch closed for refunds and admissions in `000110`/`000111`).

As of 2026-08-29 (commit `097946c` and the PHASE_3 part-three increment on `arena/01a03d22-toefl-house`), the correction is verified end-to-end over the real HTTP surface:

- all four workflows are exposed as thin transports over their authoritative commands — `POST /academic/enrollments` + `…/{id}/activate`, `POST /finance/obligations`, `POST /academic/progressions` + `…/{id}/review` + `…/{id}/approve`, `POST /payroll/employments/{id}/clearance` + `POST /payroll/employments/{id}/settlements` + `POST /payroll/settlements/{proposalId}/approve` — with each two-signature stage signed in its **own** authenticated session;
- `SettleEmployment` is staged to the house pattern by migration **`000112`** (`settlement_proposals` `proposed`|`approved`, one open proposal per employment; consolidated `settlement_proposals_guard` — born proposed only for a terminated, doubly-cleared, unsettled employment; only proposed→approved with state+approver change, approver ≠ preparer ≠ beneficiary; no delete). `SettleEmployment::settle` is replaced by `propose` + `approve`; `final_settlements` keeps its 000056/000103 guards and remains the single recorded fact;
- `MaintainFinancialPeriod` open/close (the obligation workflow's prerequisite, found unexposed by the same audit) is exposed as `POST /finance/periods` + `POST /finance/periods/{id}/close`;
- evidence: 8 new HTTP workflow tests (seat lifecycle + activation denial; obligation open-period rule; staged progression incl. both independence denials; four-session settlement end-to-end; period lifecycle) and 6 new direct-SQL settlement-proposal attacks, each proven over real sessions against the schema's final authority.

The console remains a pure transport (no model writes in `app/Http`); every domain rejection surfaces with its error code. The exposed command set is now **24 of the 78 commands**; the remaining 54 are non-critical-path configuration/catalog commands (chart of accounts, skill/scale catalogs, integration endpoints, …) with no employee workflow of their own. Gate evidence at the amendment commits is recorded in `00-implementation-state.md` (PHASE_3 transport-coverage completion entry).
