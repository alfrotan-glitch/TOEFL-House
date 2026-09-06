# PHASE_5 — E2E Business Journey (real HTTP, fresh isolated DB)

**Method.** The complete prospective-student journey was executed against a live
HTTP server (`php -S`, `APP_ENV=local`, CSRF enforced, database sessions, a fresh
`toefl_house_e2e` database created empty, migrated, and first-run bootstrapped),
driving `e2e-journey.php` — a same-origin browser-like client with cookie jar and
CSRF token. **No mocks**: every state change is a real HTTP request against the
authoritative routes/controllers/commands; final truth is read back over HTTP and
directly from PostgreSQL.

Journey: fresh DB → first-owner bootstrap → owner sign-in → staff provisioning
(person intake → verify → account → password → position assignment → activation) →
student person intake/verify → applicant registration → **three-signature
admission** (initiate → review → approve, distinct sessions) → admitted-applicant
conversion to an active student → open financial period → placement-fee
obligation (invoice) → payment record → payment allocation → academic
program/version/period → class define → teacher assignment → publish → activate →
enrollment seat request → enrollment approval (active seat) → placement assessment
attempt → score → **moderate → approve → release** (independent actors) → final
financial + student-state verification.

Every Separation-of-Duties signature was made in its own authenticated session;
the boundary was attacked at each stage (initiator self-review, reviewer
self-approval, scorer self-moderation, clerk activation, teacherless class
activation, default-deny for an account with no authority).

## Findings (DISCOVER → PROVE → FIX → ATTACK → VERIFY)

### F-A — Org-wide grant requestor could self-approve the first signature (SoD defect)

- **DISCOVER.** `GrantScopePermission::approve()` (the staged organization-wide
  grant chain) rejected only when approver one == approver two; it never checked
  that an approver differs from the **requestor**. Every other staged workflow
  binds the requester/initiator off the signing slots (refund
  `finance.refund_not_independent`, admission `admissions.single_actor`,
  correction `academic.correction_single_actor`). The DB guard in `000116` likewise
  only compared the two approvers.
- **PROVE (real HTTP).** On a fresh system the owner requested an org-wide grant
  then POSTed approval in the same session: `approver_one_id == requested_by`,
  state stayed `requested` — the self-signature was accepted.
- **FIX.** `GrantScopePermission::approve()` now denies with
  `access.org_wide_single_actor` when `requested_by == approver` before either slot
  is filled. Migration `000119_org_wide_grant_requestor_independence` recreates the
  `org_wide_grant_requests_guard` trigger to reject, at the SQL level, any requestor
  value in either approver slot (application rule backstopped in the database,
  matching the architecture's trigger-guard pattern).
- **ATTACK.** Direct-SQL attack against the fresh-schema trigger: setting
  `approver_one = requested_by` and (with a distinct approver one)
  `approver_two = requested_by` are both **rejected** (`check_violation`); a
  legitimate chain of two distinct non-requestor approvers is **accepted** through
  to `approved`.
- **VERIFY.** New permanent regression test
  `GrantCommandFeatureTest::test_the_org_wide_grant_requestor_may_not_approve_their_own_request`
  (self-approval denied, request untouched, distinct approver still succeeds).
  Re-probed over real HTTP after the fix: self-approval leaves `approver_one` NULL.
  Full Access suite green (38 tests).

### F-B — Domain rejection on a Referer-less POST ejected authenticated users to /login

- **DISCOVER.** The console exception handler maps a `DomainError`
  (`AuthorizationDenied` 403 / `BusinessRejection` 409) for a non-JSON request to
  `redirect()->back()`. With no `Referer` header (a programmatic / same-origin
  API-style client — the console explicitly documents same-origin programmatic
  use), `UrlGenerator::previous()` falls back to the "previous URL" stored in the
  session, which for a freshly signed-in employee is the **login** route. The
  governed rejection (and its flash `error_code`) was lost and an authenticated
  user was bounced to the login screen.
- **PROVE (real HTTP).** An authenticated but unauthorized session POSTing a
  finance obligation with no Referer was redirected to `…/login`; with a Referer
  it correctly returned to `…/finance`. The JSON/API path was unaffected and
  already returned the structured 403 payload.
- **FIX.** `bootstrap/app.php` domain-error render for the web console: when no
  Referer is present, redirect an authenticated user to the console home (`/`) and
  an anonymous request to login, preserving `withInput()`, the `error_code` and the
  message; when a Referer is present the in-place `back()` behaviour is unchanged.
- **ATTACK/VERIFY.** New permanent regression tests
  `DomainRejectionTransportFeatureTest` (no-Referer authorization denial →
  redirect `/`, flash `finance.payment_denied`, still authenticated; with-Referer →
  redirect back to `/finance`). Re-probed over real HTTP: no-Referer denial now
  returns to `/`, never `/login`.

### Carried from the prior session (transport surfaces), re-verified over real HTTP here

- **API session stack.** The `api` middleware group now runs the same stateful
  cookies+session+CSRF stack as the web group; previously the token-only default
  meant every `/api` call 401'd after a valid console login. Proven: console login
  then `GET /api/me` → 200 `username=owner`. Regression: `ApiSessionStackFeatureTest`.
- **Person intake.** `RegisterPerson` command + `POST /identity/people` (+ API)
  open the unverified person record every boundary starts from. Regression:
  `ClassAndIntakeTransportFeatureTest` and journey STAGE 2/3.
- **Class delivery transport.** `defineClass` / class `transition` /
  `assignTeacher` HTTP surfaces; a class cannot activate without an open teacher
  assignment (`academic.class_needs_teacher`). Regression:
  `ClassAndIntakeTransportFeatureTest`; journey STAGE 7 + teacherless-class attack.

### Observed, deliberately NOT changed (certified architecture)

- **No automatic cross-module payment gate.** Finance and Academic are separate
  authorities; no code, test, or domain contract couples enrollment activation or
  placement assessment to obligation coverage (balances are derived and reconciled
  by Finance). The journey therefore exercises both authoritative surfaces and
  demonstrates the business control ordering (placement-fee obligation posted,
  paid, and fully allocated to uncovered = 0.00 before seat activation); adding an
  automatic cross-domain gate would change the certified boundary model and was not
  done.
- **Least-privilege role/structure granularity.** Roles/positions and organization
  structure units (campus/branch/department) are created only by first-run
  bootstrap / the organization commands, which have no console HTTP surface; the
  existing all-capability Owner position CAN be assigned to provision a working
  employee over HTTP (proven — the journey staff are provisioned this way), so this
  is a granularity/console-completeness observation, not a journey blocker, and
  introducing new role/structure transport is a product change outside the
  "do not change certified architecture" constraint.

## Gate evidence (this run)

- **Unit:** 70 tests / 499 assertions — OK.
- **Feature:** 453 tests / 3128 assertions — OK (incl. all PHASE_3/PHASE_4,
  deployment/one-click-Windows contract tests, and the new regression tests).
- **PHPStan:** level 6, no errors.
- **E2E journey (fresh DB, real HTTP):** 61/61 checks pass, 0 findings at the end
  state; student active, enrollment active, placement result released (87.50),
  placement-fee invoice 100.00 paid and fully allocated (uncovered 0.00).
