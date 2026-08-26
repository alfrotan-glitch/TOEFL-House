# Package 12 Checkpoint — Assets/Operations/Communication

**Package:** 12 — Assets/Operations/Communication (sequence row 11: custody, work, delivery — contract/integration tests)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 11 checkpoint (`33-package-11-payments-funding-checkpoint.md`) at commit `39f06eb`

## Discover

- Governance inputs consumed: entity registry (29 — "Book/Issuance/Return/Loss/Damage/Asset/Custody | Resources | resource ownership and custody | custody and movement history"; "Facility/Maintenance Request/Work Order | Facilities | operational work | request, approval, completion"; "Incident/Complaint/Report/Export/Notification | Security/Reporting/Communication"), relationship registry (31 — Book↔Issuance 1:N movement dates, custody history retained; Asset↔Custody 1:N custodian/location, disposal closes custody), lifecycle registry (32 — Issuance/Asset/Work Order: Requested, Approved, Issued/In Progress, Returned/Completed, Lost/Disposed/Cancelled; custody and work evidence required; disposal requires approval), source-of-truth registry (30 — stock derived, movement history retained), authority registry (33 — asset disposal/export: custodian/manager initiates, Finance/privacy review, **two Owners when material**; bulk or material action without approval forbidden), module contracts (04 — Resources: catalog/custody/stock/assets/work, journal/balance forbidden, custody/history required; Communication: post-commit delivery, source facts, privacy/access), privacy architecture (14 + foundation 37 — communication and marketing consent are separate; revocation blocks future use without erasing history; minimum disclosure and audit).
- Cash drawers (finance scope), expenses, and integrations/jobs are later packages; the Privacy module (P04) is consumed read-only.

## Map (implemented scope)

- **Assets** (`Asset`, Resources module): catalog entries with unique codes; `in_service` until an approved disposal flips them to `disposed` (terminal, immutable by DB trigger).
- **Custody** (`Custody`): one custodian period per asset — **one open custody per asset** (partial unique index); transfer **closes the prior row** (released date) and opens a new one, history retained; the trigger permits **only releasing** an open row (no rewrite of asset/custodian/assignment, no deletes). Disposal closes the open custody.
- **Disposal** (`AssetDisposal`): the authority registry's material-action rule applied fail-closed — a requester plus **two distinct approvers** (`resources.dispose_approve`), method ∈ {sale, scrap, donation}, mandatory reason; one disposal per asset; closes custody, flips the asset, immutable record (DB trigger). The financial journal effect of a disposal remains Finance's explicit act (P10 `PostJournal`, untouched).
- **Work orders** (`WorkOrder`, Facilities): `requested→approved→in_progress→completed|cancelled` — approval by a **different actor**; **completion requires work evidence**; terminal rows immutable (DB trigger).
- **Book circulation** (`BookCopy`, `BookIssuance`): immutable catalog copies (unique codes); issuance with due date ≥ issue date; **one open issuance per copy** (partial unique index); return and **loss with mandatory evidence** are terminal history; **a lost copy is permanently out of circulation**; stock/availability derived from issuances — no mutable stock column.
- **Communication** (`Message`, Communication module): messages queue **post-commit** only under an **active consent** for the subject and purpose (P04 consumed read-only) **on the purpose's registered channel** (communication/marketing separation); delivery results (`sent`/`failed`) require the provider reference; terminal messages immutable (DB trigger). **Revocation blocks future messages without erasing history** (verified).
- Capabilities: `resources.asset`, `resources.dispose_request`, `resources.dispose_approve`, `facilities.work`, `facilities.work_approve`, `resources.books`, `communication.send` — all separate.
- Persistence: 7 migrations (`2026_08_26_000069`–`000075`) owned by the new Resources and Communication modules; CHECK constraints (asset/disposal-method/work-order/issuance/message states, due-date windows); unique/partial-unique indexes (asset code, one open custody, one disposal per asset, copy code, one open issuance per copy); immutability triggers on disposed assets, disposals, terminal work orders, terminal issuances, delivered messages; release-only/no-delete triggers on custody.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 310 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (265 tests, 1043 assertions)** |
| integration tests | PASS | custody/disposal/work/book/communication chains against PostgreSQL atomically (6 feature tests + resource lifecycle unit suite) |
| contract tests (boundary) | PASS | Privacy (consents/purposes) consumed read-only; People consumed read-only; no Finance writes — disposal's financial effect stays an explicit journal posting |
| custody/history tests | PASS | transfer closes prior row (history count and dates asserted); one open custody; disposal closes custody; raw SQL rewrite/delete of custody rejected by triggers |
| invariant tests | PASS | unique asset/copy codes; one disposal per asset; one open issuance per copy; lost copy permanently out of circulation; terminal work orders/issuances/messages immutable (raw SQL) |
| authorization tests | PASS | disposal needs three distinct actors (requester + two approvers); work approval independent of request; unprivileged asset registration denied with audit and no row |
| lifecycle tests | PASS | full work-order chain incl. no-start-before-approval and terminal immutability; issuance issued→returned/lost; message queued→sent/failed; unit matrix asserts absent edges |
| privacy tests | PASS | channel must match the purpose's registered channel; no active consent → no message; revoked consent blocks future messages while delivered history is retained |
| financial tests | NOT APPLICABLE | no financial entities in this package (disposal journals are Finance's explicit act) |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (five new indexes; work-order/message state CHECK vectors; catalog assertions for seven new triggers); database migrated to all 75 migrations |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Duplicate asset/copy codes — rejected (unique indexes).
2. Custody transfer to the same custodian — rejected; transfer closes the prior row (asserted) instead of rewriting it.
3. Raw SQL rewrite of a released custody row or delete of custody history — rejected by triggers.
4. Disposal with a single approver (or any two identical actors among requester/approvers) — denied (`resources.disposal_not_independent`).
5. Disposal of an already-disposed asset / second disposal — rejected; custody assignment to a disposed asset — rejected; raw SQL tampering of a disposal record — rejected by the trigger.
6. Work started before approval — rejected; requester approving their own work order — denied; completion without evidence — rejected; raw SQL delete of a completed work order — rejected by the trigger.
7. Second open issuance of a copy — rejected (domain + partial index); loss report without evidence — rejected; issuance of a lost copy — rejected (`resources.copy_lost`); raw SQL resurrection of a terminal issuance — rejected by the trigger.
8. Inverted issuance due date — rejected (domain + CHECK).
9. Message on a channel different from the purpose's registered channel — rejected (`communication.channel_mismatch`).
10. Message to a subject without active consent — rejected (`communication.consent_missing`).
11. Message after consent revocation — rejected, while previously delivered messages remain in history (asserted).
12. Delivery result without a provider reference — rejected; raw SQL rewind of a sent message — rejected by the trigger.
13. Unprivileged asset registration — denied with audit evidence (`resources.asset.register.denied`) and no row.

## Repair log (defects found by verification, fixed, reverified)

1. Consent fixture effective date (2026-11-01) was in the future relative to the test clock — the active-consent window never opened; fixture moved to 2026-08-01.
2. **Production defect**: a lost copy could be re-issued because circulation only checked open issuances — `issue` now also rejects copies with a `lost` issuance (permanently out of circulation), error `resources.copy_lost`.
3. phpstan iterable return-type docblocks missing on three private transition helpers — added.

## Decide

- The authority registry's "two Owners **when material**" disposal rule is applied **unconditionally** (three distinct actors) — materiality thresholds are configuration; until they exist, fail closed.
- Disposal's financial consequence is not auto-journaled: Resources never posts; Finance records it explicitly (module contract "journal/balance" forbidden for Resources).
- Book circulation keeps copies immutable and derives availability from issuance history (source-of-truth registry) — no stock counters exist to drift.
- Loss is permanent for the copy (a replacement is a new copy) — simplest custody-honest model; damage-with-return can be added as evidence-typed returns if policy requires.
- Communication separation: the channel lives on the registered consent purpose (communication vs marketing), and the message must match it — a message can never claim a purpose on a channel it was not consented to.
- Delivery is recorded as evidence (provider reference), not assumed: queued → sent/failed with mandatory references.

## Certified

Package 12 — Assets/Operations/Communication: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (265 tests, 1043 assertions)**, phpstan level 6 clean, pint clean (310 files), database at 75 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–11 untouched.
