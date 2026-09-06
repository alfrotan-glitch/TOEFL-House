# WP-2 S1 — Governed Configuration Registry (implementation record)

**WP2-DEC-05 (S1)** · Status: IMPLEMENTED (foundation) · Branch: `arena/01a062e3-toefl-house`

This record documents how the approved S1 architecture decision is implemented
so the code, schema, and tests match the architecture. It is a foundation: the
typed/versioned/audited registry and its fail-closed read path. Actual business
threshold numbers are **not** invented here — ratifying real values remains an
explicit governance decision.

## 1. Schema / model / domain design

Two tables plus DB triggers (migration `2026_09_03_000124`).

### `governed_config_definitions` — the governance boundary
`id (uuid PK) · config_key (unique) · config_type · title · ratified_by (FK
people) · timestamps`.
A governed configuration key exists only after it is **explicitly ratified**
with a fixed `config_type`. This is the anti-drift rule: a value becomes
governed only when an approved definition says so, so arbitrary keys/types are
never accepted and arbitrary existing constants are never auto-converted.
Definitions are append-only and immutable (DB trigger).

### `governed_configs` — typed, versioned, effective values
`id (uuid PK) · config_key (FK definitions) · config_type · version_no ·
value (jsonb) · effective_from · effective_to (nullable) · supersedes_id (self
FK) · lifecycle_state ('active'|'ended') · review_cycle · approved_by (FK
people) · timestamps`.

- **Typed, not free-form.** Each value is a typed envelope `{"v": <scalar>}`.
  `config_type` (one of `nonnegative_money`, `positive_money`,
  `nonnegative_integer`, `positive_integer`, `percent`, `approver_reference`)
  determines the scalar's shape and constraints, validated both in the domain
  (`App\Modules\Governance\Domain\GovernedConfigType`) and again in a DB
  trigger. Money is whole minor units; percent is 0..100; approver_reference is
  a non-empty person identifier (used by approval-routing configuration).
- **Versioning / effective dating.** Version rows are appended, never
  rewritten. A row covers the half-open window `[effective_from, effective_to)`;
  a NULL `effective_to` is the single OPEN (active) version running to the
  present/future. `version_no` is strictly monotonic per key. Exactly one OPEN
  version exists per key at a time; retiring the OPEN version into a finite
  window is the only permitted mutation and yields an immutable historical
  version.
- **Read resolution.** `GovernedConfigRegistry::effective(key, day)` returns the
  single authoritative version governing that day.

## 2. Governance & authorization design

- Writes require the `governance.config` capability resolved through the
  existing `AccessDecision`/`AccessResolution` authority model — no independent
  authorization model is introduced, and other authorities (e.g. access admin)
  cannot broaden into governed writes.
- Reads are broader: `GovernedConfigRegistry` is a pure, deterministic resolver
  used inside authorized operations.
- Every write is a governed, **audited** event recorded through the existing
  `AuditRecorder` into `audit_events` (actor, operation, target, before/after
  state, correlation id), and unauthorized attempts are recorded as
  `*.denied`.
- Writes are idempotent (`IdempotentExecution`), matching every other command.

## 3. Database invariants

Enforced at the Postgres boundary (behind the domain commands):
- `unique(config_key, version_no)` — no duplicate version numbers.
- `unique(config_key, effective_from)` — no duplicate effective starts.
- Partial unique index `governed_configs_one_open_per_key`
  (`WHERE lifecycle_state='active'`) — one OPEN version per key (single current
  authority), concurrency-safe.
- GiST exclusion `governed_configs_no_overlap` over
  `daterange(effective_from, COALESCE(effective_to,'infinity'), '[)')` for the
  same `config_key` — no two effective windows may overlap (requires `btree_gist`).
- Checks: `version_no >= 1`; lifecycle in `{active,ended}`; lifecycle/window
  consistency (`active` ⇔ `effective_to IS NULL`); window not inverted.
- `governed_configs_write_guard` trigger (BEFORE INSERT/UPDATE): the `config_key`
  must have a ratified definition whose `config_type` matches; the value envelope
  and its typed scalar satisfy the declared type's constraints; `version_no` is
  strictly monotonic.
- `governed_configs_immutability_guard` trigger (BEFORE UPDATE): only the exact
  active→ended retire of an OPEN version is permitted; value, type, window
  start, key, version, approver, and lineage can never be changed after write.
- `governed_configs_delete_guard` trigger (BEFORE DELETE): history is never
  deleted.
- `governed_config_definitions_append_only` trigger: definitions are immutable.
- FKs: `config_key → definitions`, `approved_by → people`,
  `supersedes_id → governed_configs(id)` (added after the table so the PK exists).

## 4. Fail-closed behavior

`GovernedConfigRegistry::effective()` never falls back to defaults, stale
values, environment variables, or unrelated constants. It throws
`BusinessRejection` with:
- `governance.config_undefined` — the key has no ratified definition;
- `governance.no_effective_version` — no version is effective on the requested day;
- `governance.ambiguous_authority` — defensive: more than one version would
  govern the day (DB constraints make this unreachable);
- `governance.invalid_stored_value` — defensive re-check of the stored typed value.

Write-side invalid input is rejected up front by `GovernedConfigType`
(`governance.invalid_value`, `governance.config_type_unknown`), and any attempt
to bypass it (invalid envelope, wrong type, out-of-range value, non-monotonic
version, overlapping window, mutation/deletion of history) is rejected by the
database triggers/constraints.

## 5. Governance boundary (what is never configurable)

`governed_configs` ratifies only thresholds/limits, routing, and review-cycle
values. It is **not** a mechanism for, and cannot hold, the hard-coded security
and financial invariants (separation of duties, default-deny, two-Owner rules,
financial immutability/cap rules, provenance immutability, calendar scheme) —
those remain hard-coded domain invariants and cannot be expressed through this
registry.

## 6. Focused tests

- `tests/Unit/Governance/GovernedConfigTypeTest.php` — pure typed/type validation.
- `tests/Feature/Governance/GovernedConfigFoundationTest.php` — behavior proofs:
  valid typed values; versioning; effective-date resolution; audit metadata;
  fail-closed missing/undefined/out-of-window; invalid typed & constraint
  values; DB invariants (one OPEN per key, non-overlapping windows, monotonic
  versioning, typed value guard, config_type match, immutability + no-delete);
  authorization (denied writes audited, access authority cannot broaden into
  governed writes).

## 7. Verification

- Focused S1: **9 tests / 70 assertions**, green.
- Full suite (see run record).
- PHPStan level 6: no errors. Pint: clean on S1 files.
- Migrations: applied on a fresh DB (`migrate:fresh` in the test suite) and as an
  upgrade on the established dev baseline.
