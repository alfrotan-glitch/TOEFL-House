# Package 14 Checkpoint — Integrations / Jobs

**Package:** 14 — Integrations/Jobs (sequence row 13: adapters, retries, scheduled work — failure/recovery/duplicate tests)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 13 checkpoint (`35-package-13-reporting-checkpoint.md`) at commit `cad73b7`

## Discover

- Governance inputs consumed: integration architecture (15 — anti-corruption adapters with **versioned business contracts**; credentials held **outside domain data**; correlation + idempotency key; timeout, retry/backoff policy, **dead-letter/manual-review state**, audit; external ambiguity reconciled by inquiry, never blindly retried; **webhooks authenticated, deduplicated, source-linked**; integration failure leaves the owned internal fact **pending/failed and visible — never fabricated success**), background processing architecture (16 — async limited to post-commit notifications/communication delivery/projection refresh/scheduled reconciliation/payroll preparation/document processing/backup verification/**integration retries**; each job has trigger, **durable status, idempotency key, retry limit/backoff, failure/dead-letter state, correlation ID**, audit where material; **repeated delivery is safe**; a failed notification cannot roll back a committed fact), transaction boundary model (05 — outbox/post-commit notification after atomic owner commit), concurrency architecture (17 — conflict returns retryable business conflict), observability (19 — job backlog/failure metrics), invariant registry (24 — "idempotent external work: keys, dedupe, retry state"), module boundary map (03 — no external system is a business module; orchestration coordinates).
- MD-011/MD-012 (master decision questionnaire) closed as read: their recommendations (verified relationships, adult-student explicit consent) are already the implemented P04/P12 behavior — no Integration impact.
- Integrations/Jobs consumes **no business module** for writes; it is shared infrastructure with its own durable tables. Communication messages (P12) remain Communication's owned facts, untouched.

## Map (implemented scope)

- **Endpoints** (`IntegrationEndpoint`): registered external boundaries — unique key, channel ∈ {sms, email, payment, storage, identity, messaging, export} (CHECK), versioned contract (`v1`, `v2`, …), **credential reference only** (`vault://…`; the secret itself never enters domain data — secrets/transports live in `config/integrations.php`), approval by the registering authority, one-way `retired` state; retired rows immutable and undeletable (DB trigger).
- **Outbound outbox** (`IntegrationDelivery`): one row per (endpoint, idempotency key) — **duplicate dispatch answers the original row**; source-linked (`source_type`/`source_id`), contract action + payload (jsonb) with **digest for tamper evidence**; identity columns trigger-locked (**only progress may change**; delivered rows final; dead-letter leaves review only via an audited requeue; deletes rejected). Status ∈ {queued, failed, delivered, dead_letter} (CHECK); `max_attempts` bounded 1–10 (CHECK); **delivered requires evidence** — CHECK `(status='delivered') = (delivered_ref AND delivered_at present)`.
- **Delivery core** (`Domain/DeliveryProcessor`) — **the single transactional core** used by both the worker command and the scheduled sweep (no parallel behavior): claim under `FOR UPDATE` (a concurrent worker finds the row terminal or not-yet-due and skips), attempt via the endpoint's adapter, then delivered (with provider reference) / retryable failure (bounded **exponential backoff** 2^n minutes, capped 60, stored as `next_run_at`) / dead-letter on exhaustion or permanent failure. Audited at delivered and dead-letter.
- **Adapters** (`Domain/Transport` + `Adapters/ConfiguredTransportDispatcher`): anti-corruption boundary; per-endpoint transport resolved from configuration; an **unconfigured endpoint fails permanently and visibly** (`integrations.transport_unconfigured` → dead-letter) — success is never fabricated. `TransportResult` carries delivered/reference/retryable/error.
- **Inbound webhooks** (`InboundEvent` + `ReceiveInbound`/`ProcessInbound`): endpoint must be active; payload well-formed; **HMAC-SHA256 signature verified** against the endpoint secret in configuration (`Domain/SignatureVerifier`, constant-time compare). Accepted events **deduplicated per (endpoint, external id)** (partial unique index — rejection evidence does not block a corrected retry; rejected rows retained with reason). Processing is **exactly-once**: received → processed under lock; replayed or concurrent processing answers the original (`already_processed`), never re-executes. Event identity (endpoint, external id, payload, signature) trigger-locked; processed events final; history undeletable.
- **Scheduled jobs** (`JobSchedule`, `JobRun`, `RegisterJob`, `EnqueueJobRun`, `ProcessJobRun`): only **catalog jobs** schedulable (`Domain/JobCatalog` — closed registry, currently `integrations.retry_sweep`); one schedule per job key (unique), enable/disable reversible, history retained. One durable row per (job, occurrence) — **racing schedulers collapse onto the existing run** (unique + lock). Execution claims under lock; bounded attempts (max 3) with exponential backoff (`next_retry_at`); exhaustion → **dead-letter** with audit; terminal outcomes immutable and replay-safe. Job handler: `Jobs/IntegrationRetrySweepJob` — sweeps due deliveries through the shared delivery core, each delivery in its own transaction (partial failure leaves siblings intact).
- **Capabilities**: `integrations.endpoint` (register/retire), `integrations.dispatch`, `integrations.process` (worker sweep), `integrations.review` (dead-letter requeue — an audited human decision), `integrations.inbound` (receive/process), `integrations.jobs` (register/toggle/enqueue/run) — capability before validation; denied operations audited (`integrations.*.denied`) with no rows.
- Error codes: `integrations.endpoint_{exists,terms,contract,credential,retired,inactive,denied}`, `integrations.dispatch_denied`, `integrations.delivery_contract`, `integrations.transport_unconfigured`, `integrations.requeue_not_dead`, `integrations.review_denied`, `integrations.process_denied`, `integrations.payload`, `integrations.signature`, `integrations.inbound_{rejected,denied}`, `integrations.job_{unknown,terms,exists,unscheduled,disabled,occurrence}`, `integrations.jobs_denied`.
- Persistence: 5 migrations (`2026_08_26_000082`–`000086`); CHECK constraints (channel, endpoint state, delivery status + retry bounds + delivered-evidence identity, inbound status, job-run status + attempt bounds); unique indexes (endpoint key, delivery per (endpoint, idempotency key), accepted inbound per (endpoint, external id) partial, schedule per job key, run per (job, occurrence)); triggers (retired-endpoint immutability, delivery identity/progress lock, inbound identity lock + finality, schedule retention, job-run identity + terminal finality). DB at **86 migrations**.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 369 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (295 tests, 1229 assertions)** |
| integration tests | PASS | full outbound/inbound/job chains against PostgreSQL (7 feature tests + 4 domain unit tests) |
| contract tests (boundary) | PASS | no business module written by Integrations; Communication/Finance/etc. untouched; credentials and transports outside domain data (config) |
| duplicate-delivery tests | PASS | duplicate dispatch answers the original row (count stays 1); duplicate webhook answers the accepted original; replayed processing never re-executes (transport send count asserted) |
| replay-safety tests | PASS | terminal deliveries/job runs answer their outcome without executing; backoff windows gate premature retries (skipped_not_due / waiting_retry asserted) |
| concurrency tests | PASS | row-claim under `FOR UPDATE` (second worker skips); racing schedulers collapse onto one run row (unique + lock) |
| partial-failure tests | PASS | an aborted attempt rolls back only its own delivery — siblings delivered; a throwing sweep leaves its delivery untouched (queued, attempts 0) — nothing fabricated |
| retry-exhaustion tests | PASS | 5 transient failures → dead_letter at attempts=5 with audit; job handler failing 3 attempts → dead_letter; **audited manual requeue** reopens a fresh bounded window (requeues counted, identity retained) |
| malformed-payload tests | PASS | webhook null/empty payload → rejected evidence; unconfigured endpoint → permanent failure dead-letter (delivered_ref stays null) |
| signature tests | PASS | HMAC verify/tamper/wrong-secret/missing-secret/empty-signature unit matrix; forged intake rejected and retained |
| authorization tests | PASS | unprivileged dispatch/register/intake/enqueue denied before validation, audited, no rows |
| idempotency tests | PASS | every command idempotent-keyed; same key + different payload rejected (inherited harness) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended: 5 unique indexes, 5 CHECK vectors, 5 trigger catalog assertions; testing + dev DBs at **86 migrations** |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Duplicate dispatch of the same (endpoint, idempotency key) — answers the original row; no second outbox row.
2. Replayed processing of a delivered delivery — skipped, transport called exactly once (send count asserted); raw SQL delete of a delivered row — rejected by trigger.
3. Premature retry inside the backoff window — skipped (`skipped_not_due`); premature job re-run — `waiting_retry`, handler not executed.
4. Retry exhaustion — 5/5 transient failures dead-letter with audit; a manual requeue is the only exit from dead-letter, resets the bounded window, counts the intervention, keeps identity; raw requeue of a non-dead-letter row — rejected (`integrations.requeue_not_dead`).
5. Unconfigured endpoint — permanent failure, dead-lettered visibly, `delivered_ref` null; the CHECK `(status='delivered') = evidence` blocks a fabricated delivered row.
6. Retired endpoint — dispatch and inbound rejected (`integrations.endpoint_inactive`); raw SQL resurrection of a retired endpoint — rejected by trigger.
7. Forged webhook signature / tampered payload / unknown endpoint secret / empty signature — rejected (unit matrix + feature); malformed payload — rejected evidence retained; rejected external id retried correctly — accepted (dedupe applies to accepted events only).
8. Duplicate webhook delivery — answers the accepted original, never reprocesses; exactly one `processed` audit per event; raw SQL rewrite of inbound identity — rejected by trigger.
9. Racing schedulers for the same occurrence — one durable run (unique + lock); replayed execution of a succeeded/dead-lettered run — answers the terminal outcome, attempts unchanged.
10. Unexpected adapter blowup mid-sweep — only the failing delivery's transaction rolls back; siblings deliver; the aborted delivery remains retryable with attempts 0.
11. Unprivileged registration/dispatch/intake/enqueue — denied, audited, zero rows.
12. Out-of-catalog job scheduling — rejected (`integrations.job_unknown`); disabled schedule enqueue — rejected (`integrations.job_disabled`).
13. Identity rewrites by raw SQL (delivery re-key, payload swap, job-run re-key) — rejected by triggers; deletes on all five new tables — rejected.

## Repair log (attacks that found real defects)

1. **`ProcessDeliveries` had no per-delivery failure isolation** — a transport blowup aborted the whole sweep (sibling deliveries never processed). Repaired: per-delivery try/catch with `attempt_aborted` outcome; the aborted delivery's own transaction rolls back cleanly. Partial-failure test added.
2. **Job-run retry semantics** — first cut threw `BusinessRejection` after saving, rolling back the attempt evidence, and had no due-time column. Repaired: `next_retry_at` column + `waiting_retry` short-circuit; failures recorded as normal command outcomes (attempt/backoff evidence retained).
3. **Sweep dead-letter fixture** — a single scripted blowup was consumed by attempt 1, so attempt 2 succeeded and the job never dead-lettered. Repaired: three scripted blowups matching max_attempts=3; added the untouched-delivery assertion.
4. **`whereKey` on the query builder** resolved to a `key` column that does not exist (`job_runs`) — replaced with explicit `where('id', …)` (same class of bug as P13's fund-utilization lookup).
5. **phpstan** — five iterable-value docblocks (Transport payload, JobHandler outcome, sweep summary, dispatcher, rejection helper) — added.
6. **Stray constructor parameter** in `ReceiveInbound` (wrong `Idempotency` import) — removed at lint stage.

## Decide

- **Shared core, no parallel infrastructure**: `DeliveryProcessor` is the only delivery engine; the interactive worker command and the scheduled sweep are two entry points to it. Communication messages (P12) stay Communication's facts; Integrations is transport infrastructure for registered endpoints.
- **Credentials and adapter bindings live outside domain data** (`config/integrations.php`): the domain stores references only — architecture 15 applied literally.
- **Failure is visible, success is never fabricated**: unconfigured endpoints and exhausted retries dead-letter with evidence; delivered status requires the provider reference (CHECK-enforced).
- **Deduplication is per accepted event**: rejected evidence is retained for forensics but never blocks a corrected retry.
- **Requeue is a reviewed human act**: bounded automation plus an audited, counted manual exit — not an infinite retry loop.
- **Job authorization is at the boundary**: the operating actor's `integrations.jobs` capability authorizes the run; the handler works within Integrations' own domain (no foreign owner commands are issued by the sweep).

## Certify

All gates PASS on 2026-08-26: phpunit **295 tests / 1229 assertions** (cumulative Package 02–14), phpstan level 6 clean, pint 369 files, testing + dev databases at **86 migrations**, `P02-environment-recovery.sh --verify` → ENVIRONMENT VALID, adversarial vectors all fail closed, repairs reverified by the full suite. Independent review: adapter/outbox/webhook/job semantics verified against architecture 15/16, transaction boundary model 05, and invariant registry 24 — credentials outside domain data, dedupe/retry/dead-letter/audit present, replay and concurrent delivery safe. Package 14 is **CERTIFIED**.
