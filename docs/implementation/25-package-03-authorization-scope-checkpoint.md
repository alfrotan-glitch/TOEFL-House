# Package 03 Checkpoint — Authorization and Scope

**Package:** 03 — Authorization and Scope
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack (PHP 8.2.27 + Laravel 12.67.0 + PostgreSQL 18.4)
**Baseline:** Package 02 checkpoint (`24-package-02-identity-organization-checkpoint.md`) at commit `1ea387a` — reused, not restarted

## Discover

- Environment reused exactly as certified in Package 02: `P02-environment-recovery.sh --verify` → **ENVIRONMENT VALID** (databases, Laravel boot, toolchain). No rebuild, no toolchain change, no dependency change (`composer.lock` untouched, content-hash `d6eab7208db9f0891547ef361ee7478b`).
- Governance inputs consumed: authorization/scope registries and contracts in `docs/implementation` (state 00, quality directive 21, sequence 17, checkpoints 22–24), foundation registries (03 command family, 32 lifecycle, 33 authority chain, 43 boundaries), architecture decision records (23, ADR-013).
- Package 02 recorded decision #1 executed as specified: the interim capability-map adapter inside `app/Support/Authorization/AuthorizationGate` was **replaced** by the canonical Access module; the `AccessDecision` port and default-deny semantics are unchanged. No parallel access system exists; Package 02 deliberately created no role/permission tables and this package created them exactly once.

## Map (implemented scope)

- **Access persistence** (6 migrations, `2026_08_25_000010`–`000015`): `positions` (organization-scoped, unique name per organization), `position_assignments` (effective-dated, lifecycle CHECK `proposed|active|expired|revoked`, partial unique index one open assignment per person+position, period CHECK), `roles`, `access_policies` (versioned: `position→role` and `role→permission` bindings, binding-type CHECK, partial unique index one open role binding per position, period CHECK), `scope_grants` (named-scope permission grants, lifecycle CHECK, scope-type CHECK `organization|campus|branch|department`, partial unique index one open grant per person+permission+scope, period CHECK, emergency/review flags), `delegations` (dated, scoped, reasoned; lifecycle CHECK, period CHECK, not-self CHECK, partial unique index one open authority per delegator+delegate+permission+scope).
- **AccessLifecycle** (`app/Modules/Access/Domain`): the lifecycle registry `proposed→active`, `active→expired|revoked`, terminal states never continue; used by assignments, grants, and delegations alike.
- **AccessResolution** (`app/Modules/Access/AccessResolution.php`): the canonical server policy decision implementing the `AccessDecision` port. Resolves Position → Assignment → Role → Permission → Scope (role-derived organization scope) plus direct named-scope grants plus bounded delegations at the effective time; **default deny**; authority expires by date without any rewrite. Delegations resolve **one level deep** and never beyond the delegator's own authority; a scoped delegation narrows to the exact delegated scope key (fail-closed).
- **Commands** (`app/Modules/Access/Commands`, each under the universal command contract — actor, operation, target, idempotency key, one owning transaction per fact+audit, denial audit): `DefineAccessPolicy` (publishes a version, closing the overlapping open row), `AssignPosition` (proposed assignment, closes prior open assignment), `TransitionPositionAssignment` (activate/revoke through the lifecycle), `GrantScopePermission` (self-grant forbidden; organization-wide grants require **two distinct eligible approvers**; emergency grants are dated ≤ 30 days, flagged `review_required`, audited), `RevokeScopePermission` (revocation retains history), `DelegateAuthority` (delegator-or-administrator only; the delegator may not delegate authority they do not hold; to-self/empty-reason/inverted-period rejected), `RevokeDelegation`.
- **Shared kernel adjustments** (port-preserving, no parallel behavior): `Actor` is now pure identity (person id + display name; authority is resolved server-side, never carried); `AuthorizationGate` deleted; `StructureDecision` and the Identity commands call the injected `AccessDecision` (bound to `AccessResolution` as a singleton in `AppServiceProvider`); denial paths still commit audit evidence via `AttemptedOperation`.
- **Test infrastructure**: fixtures seed the canonical model itself (`SeedsAuthority`: bootstrap organization, per-capability-set roles, positions, active assignments, direct scope grants) — no test-side capability map remains.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, 53 files, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 97 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (118 tests, 477 assertions)** |
| integration tests | PASS | feature suites exercise commands → PostgreSQL schema → audit evidence atomically (Access: 39 tests) |
| invariant tests | PASS | access lifecycle matrix; one open assignment/grant/role-binding/delegation (partial unique indexes); CHECK-constrained states, scope types, delegation period and not-self |
| authorization tests | PASS | full-chain role-derived resolution; grant scope leakage across organizations; unknown/fabricated capabilities (incl. `*.*`, `identity.*`, empty) denied; unprivileged grantor/assigner/publisher/revoker/delegator denied with audit; two distinct approvers for organization-wide grants (count, same-actor, eligibility) |
| lifecycle tests | PASS | proposed→active→revoked; forbidden transitions (`proposed→revoked`, `active→active`, double revoke) fail closed; assignment re-issue closes the prior open row; policy versioning closes the prior open row |
| temporal tests | PASS | as-of resolution: expired grant/assignment window, future grant not yet effective, closed policy version, expired/revoked delegation all stop authority without rewrite |
| financial tests | NOT APPLICABLE | no financial module in Package 03 scope (carried from Package 02 decision #5) |
| concurrency/idempotency tests | PASS | repeat commands return the original outcome; same idempotency key with different payload rejected (grant, delegation) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended with the four access partial unique indexes and three CHECK vectors; dev database `toefl_house` migrated to all 15 migrations (`migrate:status` all Ran, 0 rows); test database `toefl_house_test` rebuilt per suite |
| contract verification | PASS | universal command contract per command; module boundary — only the Access module writes access persistence; `AccessDecision` port unchanged; structure/identity denial messages now carry the resolver's reason |
| adversarial review | PASS | see below |
| regression verification | PASS | the entire Package 02 suite (structure, lifecycle, authorization, identity, audit immutability, queries, idempotency) re-run green on the canonical resolver after every repair; final full run green |

## Attack (adversarial verification)

Vectors executed against the implementation, all failing closed:

1. Fabricated/wildcard capabilities (`*.*`, `identity.*`, `access`, empty string) — never resolve; exact-string permission matching only.
2. Delegation chains (delegator → middle → leaf) — the second hop resolves nothing; delegations are one level deep.
3. Delegate exceeding the delegator (delegation for `identity.verify`, attempt on `access.grant`) — denied; delegation for a permission the delegator does not hold — denied before creation (`access.delegate_beyond_authority`).
4. Position in one organization leaking into another — denied; an assignment without a permission-granting role authorizes nothing.
5. Grant into a scope that does not resolve (unknown campus) — business rejection `access.scope_unavailable`; no row written.
6. Self-grant — denied (`access.self_grant_forbidden`) and audited; delegation to self — rejected (`access.delegation_to_self`).
7. Organization-wide grant with one approver, the same actor twice, or an unprivileged approver — denied (count / distinct-actor / eligibility), audited, no row written.
8. Emergency grant without expiry, or beyond 30 days — rejected; within the limit it is flagged `review_required` and dated.
9. Expired/revoked authority still resolving (grant window, assignment window, closed policy version, expired or revoked delegation) — denied at and after the boundary, with no history rewrite.
10. Third-party revocation of another person's delegation or grant — denied and audited; the row stays active.
11. Tampering with grant rows against the period invariant (start after end) — rejected by the schema CHECK, not only by the command.
12. Idempotency-key reuse with a different payload (grant, delegation) — rejected.

Defects found by verification and repaired during this package (quality directive §29 stop-and-repair, then full re-run): `binding_type` CHECK initially missing the `role` binding; policy versioning closing the prior row by the wrong key (`grants_id` instead of permission-for-permission, all-role-for-position); Carbon 3 signed `diffInDays` weakening the emergency limit; `lessThanOrEqual` (nonexistent) → `lessThanOrEqualTo`; `char(36)` padding breaking a PHP-side delegator comparison in `RevokeDelegation`; redundant `instanceof` (phpstan); three fixture-ordering defects where test actors were materialized after the scope they had to be authoritative in. Every repair was followed by a full-suite regression.

## Independent review

Reviewed against the contracts as a separate pass: every access command satisfies the universal command contract (actor, operation, target, idempotency key; one owning transaction per fact+audit; material denials committed as audit evidence after rollback). Module boundaries hold — only Access writes access persistence; Organization/Identity consume the `AccessDecision` port unchanged; the Audit module stays append-only and generic. No UI, routes, or generic CRUD were introduced. Recorded reviewed decisions (not silent, per directive §22):

1. **`AccessDecision` port kept, adapter replaced** — Package 02 decision #1 executed literally: the port, the default-deny semantics, and every existing call site survive; only the implementation behind the port changed. No parallel access system exists anywhere.
2. **Delegations resolve one level deep** — chained delegation is not granted implicitly; a further delegation must be created and authorized by the delegate's own authority. Fail-closed reading of the registry.
3. **Scoped delegation narrows to the exact scope key** — no subtree expansion beyond the registry's scope keys (a delegation scoped to an organization covers the delegator's key for that organization only). Stricter than required, never looser.
4. **One open role binding per position** — a position holds at most one role at a time; publishing a new binding closes the previous one (versioned history). Enforced structurally by partial unique index, not only by the command.
5. **Organization-wide grant defined as a grant scoped to `organization`** — the two-distinct-approver chain applies there, mirroring the two-Owner material-decision rule of registry 33.
6. **Person intake and person merge remain out of command scope** (carried from Package 02 decisions #3/#4); financial gates NOT APPLICABLE with reason (carried from #5).

## Clean handoff

- Working tree contains only this package's implementation, tests, migrations, and documentation; no scratch or generated artifacts; `.gitignore` unchanged from the P02 baseline plus `/.phpunit.cache`.
- Dev database `toefl_house` migrated to the full 15-migration schema, 0 rows; the test database is rebuilt per suite; no data was required, created, or destroyed beyond schema.
- The P02 environment recovery script and baseline remain valid (`--verify` → ENVIRONMENT VALID); the release artifacts and digest verification are untouched.

## Certification

All gates PASS (or NOT APPLICABLE with recorded reason). Package 03 — Authorization and Scope is **CERTIFIED** at this checkpoint. The certified cumulative suite is **OK (118 tests, 477 assertions)**; phpstan level 6 clean (53 files); pint clean (97 files).
