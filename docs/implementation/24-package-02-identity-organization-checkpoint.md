# Package 02 Checkpoint — Identity and Organization

**Package:** 02 — Identity and Organization
**Status:** CERTIFIED — PASS
**Date:** 2026-08-25
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack (PHP 8.2.27 + Laravel 12.67.0 + PostgreSQL 18.4)

## Discover

- Environment restored through the committed P02 recovery mechanism (`docs/environment/P02-environment-recovery.sh --recover`; artifacts published on release `p02-artifacts`, verified by GitHub asset digests against the generated manifest).
- Implementation evidence search (authoritative, recorded in session): no Laravel implementation existed in this checkout, any pushed branch (16 heads inspected), any tag, pull request, release, or Actions artifact. The previously recorded "52 tests / 229 assertions" R3-closure state was sandbox-local to a prior session and was destroyed by platform snapshot resets before it was ever committed. Per the standing instruction, Package 02 was therefore implemented from the governance records, not recovered.
- Governance inputs consumed: `docs/implementation/02,03,04,06,07,12,13,14`; `docs/foundation/19,29,30,31,32,33,39,43`; `docs/implementation/17` sequence; baseline `docs/environment/P02-environment-baseline.md`.

## Map (implemented scope)

- **Organization module** (`app/Modules/Organization`): `Organization`, `Campus`, `Branch`, `Department` units with the registry-32 lifecycle (`draft→active`, `active↔suspended`, `active→closed`, `closed→reopened→active`), effective-dated campus attribution (`CampusAssignment`), and commands create/activate/suspend/reactivate/close/reopen/rename/transfer under the two-Owner authority chain of registry 33. Read model `EffectiveStructureQuery` resolves effective structure as of a day, scope-filtered, read-only.
- **Identity module** (`app/Modules/Identity`): `Person` (verification writes the canonical identity key exactly once) and `UserAccount` (one active account per verified person; deactivate, never erase) with the registry-03 command family verify/link/deactivate and the read model `PersonDirectoryQuery`.
- **Audit module** (`app/Modules/Audit`): append-only `AuditEvent` written in the owning transaction (`AuditRecorder`); material denials committed after rollback (`AttemptedOperation`); database trigger `audit_events_append_only` gives structural protection.
- **Shared kernel** (`app/Support`): error taxonomy (categories/codes/correlation id/retryability per contract 13), `AccessDecision` port with default-deny `AuthorizationGate` (the authorization package replaces the adapter; no role/permission tables are created here), idempotency store keyed by operation+key with payload-hash conflict rejection (contract 12), effective-period value object, UUID v4 identifier source.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-25) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse` — level 6, 39 files, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint --test` — `PASS … 71 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (78 tests, 371 assertions)** |
| integration tests | PASS | feature suites exercise commands → PostgreSQL schema → audit evidence atomically |
| invariant tests | PASS | lifecycle matrix, one-open-campus-attribution (partial unique index), single verified identity, one active account, audit append-only (model + DB trigger) |
| authorization tests | PASS | default-deny, scope coverage/leakage, two distinct Owners, single-actor exclusion, initiator capability, out-of-scope approval, denial audit |
| lifecycle tests | PASS | full registry chain incl. `closed→reopened→active` double transition, forbidden transitions fail closed, failed transition leaves state and audit unchanged |
| financial tests | NOT APPLICABLE | no financial module in Package 02 scope |
| concurrency/idempotency tests | PASS | structural impossibility of two open attributions; repeat command returns original outcome (single audit/fact); same key + different payload rejected |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` (partial unique indexes, lifecycle/account CHECK constraints); migrations exercised per test via `DatabaseMigrations`; dev database `toefl_house` migrated (`php artisan migrate --force`) |
| contract verification | PASS | command contract fields, module ownership, boundary contract 43 (unverified identity rejected with audit), queries never mutate |
| adversarial review | PASS | see below |
| regression verification | PASS | full suite re-run after every repair; final run green |

## Attack (adversarial verification)

Vectors executed against the implementation, all failing closed:

1. Duplicate verified identity (second person, same identity key) — business rejection `identity.duplicate_verified_person`, backed by partial unique index.
2. Re-verification of a verified person — rejected.
3. Second active account for one person / username collision across persons — rejected by domain + persistence boundary.
4. Structure decision with one Owner, or Owners overlapping initiator/reviewer, or a single actor holding every role — denied (`organization.structure.single_actor` / `owner_count`).
5. Out-of-scope Owner approval (branch leakage) — denied.
6. Unprivileged identity verifier — denied, denial committed as audit evidence.
7. Audit rewrite attempts through the model and through raw SQL `UPDATE`/`DELETE` — blocked by model guard and database trigger.
8. Forbidden lifecycle paths (`draft→suspended`, `suspended→closed`, double close, direct `closed→active`) — fail closed; state and audit unchanged.
9. Transfer to the same campus, transfer date overlapping history — rejected.
10. Idempotency-key reuse with a different payload — rejected.

Defects found by verification and repaired during this package (quality directive §29 stop-and-repair, then full re-run): `array_unique` boolean flag TypeError in the authority chain, UUID version/variant bits not masked in the identifier source, and two namespace/type errors in test wiring. All repairs were followed by full-suite regression.

## Independent review

Reviewed against the contracts as a separate pass: universal command contract satisfied per command (actor, operation, target, scope, effective time where material, correlation id, idempotency key, reason on deactivation; one owning transaction per fact+audit). Source-of-truth registry: no module writes another module's persistence; Organization owns structure, Identity owns account facts, Audit append-only. No UI, routes, or generic CRUD were introduced (API surface is deferred with the packages that need it). Recorded reviewed decisions (not silent, per directive §22):

1. **Authority evidence**: Package 02 validates capability evidence through the `AccessDecision` port with default deny; position/assignment/permission resolution belongs to the Authorization package (sequence row 2). No parallel access system was created.
2. **Suspend/reactivate** are treated as material structure decisions requiring the full two-Owner chain (registry 33 lists create/rename/transfer/close/reopen; suspension is the same family — fail-closed interpretation).
3. **Person record intake** (creating the unverified person row) is not a Package 02 command (registry 03 lists verify/link/deactivate); tests create fixture rows directly. Intake belongs to the People/Admissions boundary.
4. **Person merge** (source-of-truth "merge only by verified decision") is deferred: no merge command exists in the registry; duplicate-verified-identity is prevented, so no merge is currently reachable.
5. **Financial gates** marked NOT APPLICABLE with reason (no financial scope).

## Clean

- Working tree clean after the package commit; no dead code, placeholders, TODO markers, commented-out code, or temporary files in package scope (`pint --test` clean, phpstan clean).
- `.gitignore` extended with the test-runner cache entry only; existing entries preserved.

## Certification

All REQUIRED gates pass; NOT APPLICABLE gates are recorded with reasons above. Verification commands (reproducible from the committed environment):

```sh
bash docs/environment/P02-environment-recovery.sh --verify
php vendor/bin/phpunit          # OK (78 tests, 371 assertions)
php vendor/bin/phpstan analyse  # [OK] No errors (level 6)
php vendor/bin/pint --test      # PASS
```

**Package 02 — Identity and Organization: CERTIFIED.** Package 03 (Authorization and Scope) may begin through the package protocol when authorized.
