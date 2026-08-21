# Certification — WP-02 Identity & Access

**Work Package:** WP-02 Identity & Access
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`
**Date:** 2026-08-21
**Recoverable baseline:** `b91b30d697b59912e3d35c27cfce70226758758d`
**Status:** READY — scope-limited certification complete

> This artifact certifies only WP-02. It does not certify the full system or any
> later Work Package.

## SCOPE

Included:

- staff and student authentication, password change/reset, logout, session revocation,
  password quarantine, and login-rate-limit isolation;
- accounts, account-to-business-identity links, roles/positions, assignments,
  permissions, overrides, permission scopes, privilege ceilings, and branch reach;
- student-portal provisioning and self-service identity separation;
- canonical identity/RBAC/session schema and the direct server/UI consumers required to
  prevent an identity or permission decision from being bypassed;
- direct narrow-scope consumers for students, classes, sessions, attendance, exams,
  offerings, journey data, and global search;
- replacement or explicit retirement of every mapped WP-02 legacy-test behavior.

Excluded except as consumed dependencies:

- student/admissions lifecycle policy, placement policy, academic-delivery business rules,
  finance calculations, payroll, reporting definitions, and workflow policy owned by later
  Work Packages;
- new role grants, new financial policy, or a new exam-ownership model. Where no canonical
  ownership relation exists, narrow access fails closed.

Risk: **CRITICAL/HIGH** — account takeover, organization-wide authority, cross-branch
access, credential handling, linked identities, and student financial confidentiality are
all affected.

## DISCOVER

### Runtime and storage surface

| Area | Authority / files | Observed contract |
|---|---|---|
| Authentication and sessions | `server/src/routes/auth.routes.ts`, `server/src/middleware/auth.ts`, `server/src/utils/auth.ts` | HttpOnly cookie or explicitly enabled bearer token; identity/session version in token; live user and RBAC rebuilt per request |
| Accounts and identity links | `server/src/routes/users.routes.ts`, `users.linked_*_id` | account administration, provisioning, reset/revocation, one account-side link to each student/teacher/employee/partner |
| RBAC resolution | `server/src/core/rbac/rbac-service.ts`, `permission-catalog.ts` | live assignments and overrides, deterministic deny, global-Owner resolution, action scope plus assignment boundary |
| Position/security administration | `server/src/routes/security.routes.ts` | assignment, role, role-permission, override, and privilege-ceiling mutations |
| Object-scope consumers | `server/src/core/rbac/abac.ts`, student/class/session/attendance/exam/offering/journey/search routes | branch collections require branch-capable scope; own/class grants require a linked object relationship |
| Student portal | auth/users routes and three package portal suites | one linked student, student role, zero staff permissions, own profile only |
| UI authority consumers | `src/contexts/AuthProvider.tsx`, `src/App.tsx`, settings and direct feature views | effective permission codes and server-resolved `isGlobalOwner`; no mutable role-label authorization |
| Canonical schema | `server/src/db/schema.sql` | `user_roles`, `role_permissions`, `permission_overrides`, unique account-side linked identities, `users.session_version`; no `users.role`, delegation table, or entity-side staff account pointer |

### Legacy-test knowledge

The mapped historical inventory was **16 files / 155 declared cases**. Fourteen focused
suites were rebased under `server/src/tests/work-packages/wp02/`; WP-02 sections were
removed from the two mixed suites while six downstream finance/audit/identifier cases and
five WP-03 search cases remained with their owning packages. The replacement authority is
**16 files / 187 executed tests**.

### Reproduced defects

1. Permission possession and branch reach could come from unrelated assignments, allowing
   one position to lend authority to another position's branch.
2. Explicit deny behavior depended on row order; a later grant could resurrect a denied
   permission.
3. A branch/campus-scoped Owner was treated as the organization superuser by role-label
   checks in server and UI consumers.
4. Account administration and role/override mutation lacked correlated privilege ceilings;
   stronger target authority could be hidden by a temporary deny.
5. Role permission-set mutation checked the caller once rather than at every live
   assignment boundary of the role being edited.
6. Student-portal accounts could be provisioned or mutated through paths that did not
   consistently preserve their role/link/permission separation.
7. Teacher and employee identity links existed on both the account and entity sides and
   could disagree; linked records could also cross the account branch.
8. Authentication success, password changes, resets, and logout had session-version race
   windows; a stale logout could revoke a newer session.
9. A broad auth-router limiter allowed abuse of one login flow/account to affect unrelated
   auth operations.
10. UI controls inferred global authority from an Owner label or mutable settings rather
    than the server's effective authorization result.
11. Assignment correlation alone did not enforce permission action scope. A teacher's
    `Student.View:class`, `Class.View:own`, or `Session.View:own` could be used against
    same-branch collections and unrelated colleague objects.
12. Role-only teacher reads exposed branch-wide sessions, exams, offerings, and journey
    data; day-level attendance writes accepted unrelated targets.
13. `Student.View` responses included tuition, discounts, installments, balances, and
    financial journey events even when the caller lacked `Payment.View`.

## MODEL

### Canonical identity and authority graph

- `users` owns login identity, home-branch identity attribute, linked business identities,
  active/quarantine state, password hash, and `session_version`.
- `user_roles` is the only role-assignment authority. Each live assignment has a boundary
  (`organization`, `campus`, or branch/resource scope) and optional expiry.
- `role_permissions` supplies the permission action scope; `permission_overrides` supplies
  explicit grants or deterministic code-level denies.
- A permission decision is valid only when the effective grant, its assignment/override
  boundary, and the requested resource all correlate.
- `organization`-scoped Owner is the only global superuser. Other Owner-labelled
  assignments remain scoped.
- Tokens carry identity and session version, never roles or permissions. Every request
  resolves current user state and current RBAC.
- Account links are unique foreign keys on `users`; teacher/employee entities carry no
  account pointer.

### Scope model

- Organization/campus/branch grants may authorize branch collections when their supplying
  boundary reaches the branch.
- The current HOD domain has no department identifier on protected resources; its
  department action grants remain bounded by the live branch posting.
- `Dashboard.View:own` retains the established assigned-branch summary contract.
- `own`/`class` academic grants require a canonical linked teacher/student/class/session
  relationship and return filtered collections or a single authorized object.
- No exam-to-teacher ownership relation exists; `Exam.View:own` therefore fails closed.
- `Student.View` governs academic identity data. `Payment.View` is additionally required
  for tuition, discounts, installments, balances, and financial journey events.

## CHALLENGE

| Subsystem | Decision | Reason |
|---|---|---|
| Password hashing and token crypto | KEEP | established bcrypt/JWT primitives remain sound when authority claims are excluded |
| `users.role`, token role claims, role delegation | REMOVE | duplicate or portable authority contradicted the sole live-assignment model |
| RBAC resolution and branch middleware | REFACTOR | retain catalog/assignment model while making deny, assignment, boundary, and action scope deterministic |
| Account/security administration | REBUILD at authorization boundary | mutation logic was usable, but takeover/grant ceilings required one correlated authority model |
| Entity-side teacher/employee account links | REMOVE | duplicate business fact with no canonical writer |
| Auth/session concurrency | REFACTOR | preserve endpoints while making state transitions conditional on the submitted/current version |
| Student portal | REFACTOR | preserve owner-approved initial-name credential and self-service flow while closing staff-authority paths |
| UI role-label checks | REMOVE | display labels and mutable settings are not authorization inputs |
| Narrow academic consumers | REFACTOR | preserve legitimate linked-teacher workflows with object predicates; deny unsupported ownership models |
| Mapped legacy tests | REPLACE / partially retire | preserve requirement knowledge without retaining obsolete authorities or mixed-package narratives |

## DECIDE

The implementation plan was bounded to:

1. remove duplicate role/link/session authorities from schema and runtime;
2. centralize global Owner, effective permissions, assignment-correlated branch reach, and
   action-scope evaluation in RBAC services/middleware;
3. enforce caller and target ceilings on every account, assignment, role-permission, and
   override mutation;
4. make login/change/reset/logout transitions concurrency-safe and revocation-aware;
5. preserve student portal separation and owner-approved credential behavior;
6. convert direct UI consumers to effective permissions and server-resolved global Owner;
7. filter own/class student, class, session, attendance, offering, journey, and search
   consumers; fail closed for exams without a domain ownership relation;
8. replace/retire all mapped WP-02 test behavior and add adversarial/architecture authority;
9. update canonical-authority, invariant, decision, conflict, and test-inventory records;
10. run focused, package, full-suite, schema, lint, audit, build, bundle, and release gates.

No dependency or owner policy was added.

## CHECKPOINT

**Checkpoint classification:** schema change · RBAC/security architecture change ·
destructive authority removal · test replacement.

The recoverable pre-package state is commit
`b91b30d697b59912e3d35c27cfce70226758758d` on the fixed Arena branch. The approved
transformation removed `users.role`, role delegation, token-carried authority, and
teacher/employee entity-side account pointers; retained historical Git recovery; and
changed the canonical schema only through `server/src/db/schema.sql`.

Registered governing decisions are D-14, D-18, D-20/D-21, D-33–D-36, D-55–D-60, and
D-67–D-73. C-2 records test replacement and C-13 records duplicate-link removal. No
production-data backup requirement applied, but the recoverable Git baseline was preserved
before destructive work.

## IMPLEMENT

### Authentication and session integrity

- Tokens now carry identity and `session_version` only; request middleware rebuilds live
  authority and rejects inactive, stale, or quarantined sessions.
- Login records success conditionally after password verification; reset/deactivation
  races fail closed.
- Password changes use optimistic session-version concurrency. Reset revokes existing
  sessions. Logout increments only the version represented by the submitted token.
- Staff and student login limiters are isolated at the credential endpoints rather than
  wrapped around the entire auth router.

### RBAC and account administration

- Denies dominate deterministically; expired assignments/overrides grant nothing.
- Permission and branch reach are correlated to the same effective grant boundary.
- Action scope is evaluated separately from assignment reach.
- Global Owner is resolved only from an organization-scoped assignment and serialized as
  `isGlobalOwner`.
- Account lists, edits, role changes, resets, assignments, overrides, and role permission
  sets enforce operation reach and live underlying target/grant ceilings.
- A target's temporarily denied permission remains visible to takeover-ceiling analysis.
- Student portal role/link invariants and staff/student separation are enforced on all
  provisioning and mutation paths.

### Identity links and schema

- Unique partial indexes and foreign keys enforce one account per linked student,
  teacher, employee, or partner.
- Teacher and employee entity-side account columns and runtime fallbacks were removed.
- Link creation and account branch changes preserve account/business-record branch
  consistency.

### Direct scope consumers

- Branch permission checks accept only branch-capable action scopes (plus the documented
  HOD and Dashboard contracts).
- Teacher student/class/session/attendance/search/offering collections are filtered by the
  canonical linked teacher and live class membership; colleague objects are refused.
- Session detail, roster, homework, quiz, and attendance analytics enforce object scope.
- Attendance mutations validate target branch, class ownership, and student membership.
- Exam reads use `Exam.View` and fail closed for own scope because no ownership relation is
  established.
- Student details and journey reads use class membership, and financial fields/events are
  omitted without `Payment.View`.

### UI and C-2 replacement

- Frontend authority reads effective permission codes or `isGlobalOwner`; Owner labels and
  `settings.currentRoleId` no longer confer authority. Logout is awaited before clearing
  the local principal.
- Fourteen requirement suites were rebased into `work-packages/wp02`; WP-02 blocks were
  removed from the two mixed suites without deleting downstream-package cases.
- `identity-access.attack.test.ts` and `identity-access.architecture.test.ts` provide the
  new adversarial and structural authority.

## VERIFY

| Evidence | Final executed result |
|---|---|
| WP-02 replacement authority | **16 files / 187 tests passed** |
| Full server suite | **160 files / 2580 tests passed; 0 failed** |
| Canonical schema | **110 tables / 231 indexes / 66 triggers**; standalone, sound, idempotent, sole authority |
| Frontend lint | **0 errors / 12 warnings** |
| Server lint/typecheck | **0 errors / 93 warnings**; production and test TypeScript checks passed |
| Frontend TypeScript | direct `tsc --noEmit` and production build passed |
| Audits | protocol, registries, product integrity, high-assurance static, dependency isolation, design system, logging, and source cleanliness passed |
| Dependency isolation | **280 server import-graph files / 32 declared packages** |
| Bundle | **494 KB first paint / 560 KB budget**, 19 lazy route chunks |
| Release gate | **22 passed / 0 failed / 0 skipped** |
| Release database checks | fresh canonical install at 110 tables; idempotent re-init, integrity and financial reconciliation passed |

The handled `SqliteError: account failed` on full-suite stderr is the expected forced
branch-provisioning rollback regression; the suite exits successfully and proves rollback.
The lint warnings are repository baseline warnings under the existing configuration; both
commands exit zero. They are not represented as full-system cleanliness.

## ATTACK

The final package actively exercises:

- cross-position permission/branch laundering and permission action-scope laundering;
- scoped-Owner attempts to mint or act as an organization Owner;
- permission, role, assignment, override, deny-removal, and role-definition escalation;
- account takeover assembled across branches, positions, or temporarily hidden grants;
- stale/expired assignment, override, token, password-change, reset, and logout races;
- permissionless student access to staff APIs and staff authority on student accounts;
- duplicate/cross-branch student, teacher, and employee identity links;
- own/class teacher access to colleague students, classes, sessions, attendance, journey,
  and financial fields;
- own-scoped exam access where no ownership relation exists;
- per-entity search permission and narrow student/class search filtering;
- arbitrary initial student secret, invalid portal role composition, and account-link
  uniqueness attacks.

## REPAIR AND REVERIFY

The first post-review scope guard correctly stopped `Student.View:class` from becoming
branch-wide but exposed two additional design facts: assignment reach alone was not action
scope, and role-only teacher routes had no permission action scope at all. The initial
repair also caused four established HOD/Dashboard regressions because department scope and
`Dashboard.View:own` have documented branch contracts in the current domain.

The repair pass therefore:

- added a central action-scope-plus-boundary predicate;
- preserved HOD branch posting and Dashboard summary semantics without widening academic
  own/class grants;
- implemented filtered teacher collections/object checks for established ownership
  relationships and failed closed where none exists;
- separated student academic identity from financial fields;
- added four new attack cases and positive controls;
- reran focused regressions, package/typechecks, the full suite, schema preflight, all
  audits/builds, bundle verification, and release validation.

## INDEPENDENT REVIEW

A structurally separate cold review re-read the final diff and direct RBAC consumers rather
than following the implementation narrative. It checked:

- effective grant construction, deny order, expiry, assignment correlation, action scope,
  and all-branch behavior;
- global/scoped Owner short circuits and frontend Owner consumers;
- account-administration target and grant ceilings, including denied underlying grants;
- every account-side identity link writer and schema uniqueness/FK boundary;
- auth races, session-version updates, cookie/bearer handling, and portal separation;
- teacher-facing student, class, session, attendance, exam, offering, journey, search, and
  finance-field outputs;
- C-2 mappings, registry references, schema authority, lint/audit output, generated files,
  and final Git diff/status.

This review produced the narrow-scope, HOD/Dashboard compatibility, prepared-statement,
and financial-field repairs described above. No unresolved Critical or High WP-02 defect,
contradictory authority, or unmapped WP-02 legacy behavior remains.

## CLEAN

- Removed obsolete role/link/delegation compatibility paths and stale mixed-test WP-02
  blocks without removing downstream-package evidence.
- No debug logging, temporary files, generated build output, dependency changes, or
  abandoned experiment remains tracked.
- Source cleanliness passed over **211 files / 8647 comment lines / 10 banned phrases**;
  logging passed over **112 runtime modules**; design-system audit passed over **106
  files**.
- `git diff --check`, schema preflight, registry audit, dependency audit, and release
  hygiene pass.

## LEGACY-TEST RESET (C-2)

Historical WP-02 inventory: **16 files / 155 declared cases**.

Final replacement authority: **16 package files / 187 executed cases**:

- 14 rebased requirement suites — 162 cases;
- `identity-access.attack.test.ts` — 17 cases;
- `identity-access.architecture.test.ts` — 8 cases.

The exact disposition of each historical file and both mixed-suite residuals is recorded in
`docs/legacy-test-inventory.md`.

## QUALITY GATE

| Dimension | Verdict | Evidence / limit |
|---|---|---|
| Correctness | PASS | 187 package tests and 2580-test full suite pass |
| Architecture | PASS | one role authority, one account-link direction, identity-only sessions, registered action-scope authority |
| Data integrity | PASS | unique/FK identity links, correlated assignments, deterministic deny, transactional/concurrent session transitions |
| Security / RBAC | PASS | branch, action, object, takeover, stale-session, portal, and Owner attacks pass |
| Privacy | PASS (scope) | colleague objects and student financial fields are withheld without the required authority |
| UX / UI | PASS (scope) | legitimate own student/class/session/attendance collections remain usable; effective server authority drives controls |
| Reliability | PASS | live authority per request, revocation/version races closed, idempotent schema/release probes pass |
| Performance | SUPPORTED | module prepared statements retained/added, bounded collections preserved, bundle budget passes |
| Maintainability | PASS | centralized RBAC/ABAC predicates, explicit registries, package-owned tests |
| Repository cleanliness | PASS | lint has zero errors; protocol/registry/static/dependency/design/logging/cleanliness gates pass |
| Testing | PASS | C-2 complete for WP-02; package, attack, architecture, focused, full, schema, build, and release evidence |
| Operational readiness | PASS (package) | production builds and 22-step release validation pass |

## CERTIFY

**WP-02 Identity & Access: READY.**

This is a bounded package certification under §§54–76. It certifies only the authentication,
account, role/permission/scope, session, linked-identity, student-portal, and direct
consumer surfaces listed in SCOPE. Later Work Packages remain uncertified; this artifact
does **not** claim full-system or production release readiness.
