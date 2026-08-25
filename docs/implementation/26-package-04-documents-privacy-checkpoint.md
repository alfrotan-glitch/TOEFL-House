# Package 04 Checkpoint — Documents and Privacy

**Package:** 04 — Documents/Privacy (audit delivered in Package 02)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack (PHP 8.2.27 + Laravel 12.67.0 + PostgreSQL 18.4)
**Baseline:** Package 03 checkpoint (`25-package-03-authorization-scope-checkpoint.md`) at commit `7be1272` — reused, not restarted

## Discover

- Environment reused exactly as certified: `P02-environment-recovery.sh --verify` → **ENVIRONMENT VALID**; no rebuild, no dependency change (`composer.lock` untouched).
- Governance inputs consumed: privacy/consent/disclosure model (foundation 37), privacy-audit-resilience architecture contract (foundation 49), data/privacy/resilience model (foundation 24), lifecycle registries (foundation 22 document lifecycle, 32 document/consent states), command registry (implementation 03 family `verify/disclose/consent/revoke/export`), source-of-truth registry (foundation 30: Document Version/Consent/Disclosure owned by Documents/Privacy, arbitrary URL never authority), module contracts (implementation 04 Communication/Documents/Privacy row), entity registry (foundation 29).
- The audit half of the sequence row was already delivered and certified in Package 02 (append-only `AuditEvent` + DB trigger); this package delivers the remaining documents/privacy scope without touching it.

## Map (implemented scope)

- **Privacy module** (`app/Modules/Privacy`):
  - `ConsentPurpose` — purpose registry with channel and category; **communication and marketing consent are separate rows** (unique per name+channel).
  - `Consent` — subject authorization, effective-dated, with mandatory evidence reference; subject must be a **verified person**; the subject may record/submit/revoke their own consent without any capability (identity-based right), staff need `privacy.consent`.
  - `ConsentLifecycle` registry: `draft→submitted→verified→active→expired|revoked→archived`; terminal states never reactivate; expiry is by effective window **without rewriting the record**.
  - `ConsentRevocation` — who withdrew, when, scope, effect; append-only (DB trigger). **Revocation stops future use without erasing historical consent or disclosure evidence.**
  - `Disclosure` — recipient, purpose, authority, scope, time, disclosed category; minimum fields enforced; append-only (DB trigger).
  - `ExportSubjectData` — purpose-based authorization, minimum disclosure, immutable disclosure evidence, read-only derived dataset; **organization-wide (bulk) exports require two distinct eligible approvers** (`privacy.approve_bulk_export`).
  - `SubjectPrivacyQuery` — as-of consent view (revoked/expired never count as current authority) + disclosure history; read-only.
- **Documents module** (`app/Modules/Documents`):
  - `DocumentClassification` — sensitivity registry (category, owner module, access class from the four-class model) and `RetentionRule` (category, positive period, legal/operational basis).
  - `Document` + `DocumentVersion` — evidence with immutable versions (hash + storage reference; **a URL/storage reference is never authority**); corrections append versions.
  - `DocumentLifecycle` registry per foundation 22/32: `draft→submitted→verified|rejected`, `rejected→submitted` (new version), `verified→active`, `active→expired|archived`, `expired→archived`.
  - `DocumentVerification` — verifier, result, reason; append-only (DB trigger); **verifier may not be the uploader** of the version under review; failed verification rejects without erasing the evidence.
  - `DecideRetention` — retain before due date, archive after; missing rule fails closed; decisions append-only; deletion is replaced by archive.
  - `DocumentHistoryQuery` — versions with their verifications, read-only.
- Persistence: 10 migrations (`2026_08_26_000016`–`000025`) owned solely by these two modules; CHECK constraints (consent/document lifecycle states, access classes, verification results, retention actions, disclosure scope types, consent periods, positive retention periods); partial unique index `consents_one_open_per_subject_purpose`; four append-only/immutability triggers (consent revocations, disclosures, document verifications, retention decisions) plus document-version immutability — each self-contained, mirroring the Package 02 audit pattern.
- All authorization flows through the canonical `AccessDecision` port (Package 03 resolver); capabilities: `privacy.define_purpose`, `privacy.consent`, `privacy.disclose`, `privacy.export`, `privacy.approve_bulk_export`, `documents.classify`, `documents.register`, `documents.verify`, `documents.retention`.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, 76 files, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 136 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (158 tests, 590 assertions)** |
| integration tests | PASS | feature suites exercise commands → PostgreSQL schema → audit evidence atomically (Privacy 16, Documents 9 tests) |
| invariant tests | PASS | consent/document lifecycle matrices; one open consent per subject+purpose (partial unique index); CHECK-constrained states, access classes, results, actions, periods |
| authorization tests | PASS | unprivileged recorder/discloser/exporter/registrar denied with audit; subject self-service without capability; verifier≠uploader separation of duties; two distinct approvers for organization-wide exports (count, same-actor, eligibility) |
| lifecycle tests | PASS | full consent chain and full document chain incl. rejection→resubmission; forbidden transitions fail closed; revoked/expired consent never reactivates |
| temporal tests | PASS | consent effective window: current within, absent after, record never rewritten |
| privacy/history tests | PASS | revocation evidence, disclosures, verifications, retention decisions append-only (model + raw SQL against DB triggers); document versions immutable; revoked consent and expiry excluded from the current-use view |
| financial tests | NOT APPLICABLE | no financial module in Package 04 scope |
| concurrency/idempotency tests | PASS | repeat commands return the original outcome; same key + different payload rejected (consent record, subject export) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (consent index; consent-state, access-class, retention-action CHECK vectors); dev database `toefl_house` migrated to all 25 migrations |
| contract verification | PASS | universal command contract per command; only Privacy/Documents write their persistence; queries read-only; no query result is authority to mutate |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite (Packages 02+03) green after every repair; final run green |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. URL/storage reference as authority — possessing the document location neither verifies nor activates evidence; `submitted→active` without verification rejected.
2. Revoked consent reactivated — `revoked→active` forbidden; the record and its revocation evidence remain queryable history.
3. Revocation erasure — raw SQL `UPDATE consent_revocations` rejected by the DB trigger.
4. Disclosure tampering — raw SQL `UPDATE disclosures` rejected by the DB trigger.
5. Version tampering — raw SQL `UPDATE document_versions` (content hash) rejected by the DB trigger.
6. Verification rewriting — raw SQL `UPDATE document_verifications` (flipping pass to fail or back) rejected by the DB trigger.
7. Retention decision rewriting — raw SQL `UPDATE retention_decisions` rejected; `shred` action rejected by the CHECK constraint.
8. Self-verifying uploader — verifier identical to the version uploader rejected (`documents.verifier_is_uploader`).
9. Disclosure of an unknown subject / missing recipient-purpose-category — rejected before any row is written.
10. Consent for an unverified subject / without evidence / inverted period / duplicate open consent for the same purpose — rejected (domain + schema).
11. Organization-wide export with one approver, the same actor twice, or an unprivileged approver — denied, audited, no disclosure row.
12. Idempotency-key reuse with a different payload (consent record, export) — rejected.

Defects found by verification and repaired (quality directive §29, each followed by full-suite regression): an over-broad purpose-conflation rule that rejected the sanctioned marketing/communication separation (replaced with the per-channel uniqueness the registry actually requires); a test revoking a `submitted` consent (registry allows revocation only from `active`); stacked PHPDoc blocks confusing phpstan; `char(36)` padding leaking into the export dataset (trimmed at the boundary); two test-side syntax/expectation defects.

## Independent review

Reviewed against the contracts as a separate pass: every command satisfies the universal contract (actor, operation, target, idempotency key; one owning transaction per fact+audit; material denials committed as audit evidence). Module boundaries hold — only Privacy writes consent/disclosure persistence, only Documents writes document/retention persistence; both consume the Package 03 authorization resolver; Audit stays generic and append-only. No UI, routes, or generic CRUD. Recorded reviewed decisions (not silent, per directive §22):

1. **Guardian relationship access is deferred to the Students/Admissions package** — foundation 29 assigns guardian relationship entities to Student/Privacy jointly; the relationship registry does not exist until admissions, so the "verified relationship + relationship-specific permission" gate cannot be truthfully evaluated yet. The consent/disclosure machinery delivered here is guardian-agnostic and ready to carry it.
2. **`send` (communication delivery) is deferred to the Integration package** — the command registry family `verify/disclose/consent/revoke/export/send` includes delivery, but foundation 24 marks SMS/email mechanics agent-decided at integration time; consent per communication channel is delivered now so delivery has an authority to check.
3. **Document "Versioned" state collapsed into version history** — foundation 22 shows `Verified → Versioned → Active`; versions are immutable appended rows owned by the document, so a separate lifecycle state would carry no additional fact. The transition `verified→active` with ordered version history satisfies the registry's intent; recorded rather than silently simplified.
4. **Consent states shared with documents** per registry 32 row "Document/Consent": consent uses Draft→Submitted→Verified→Active (verified = subject identity verified), documents use their own row of the same registry including Rejected.
5. **Retention action computes from the rule, not operator choice** — `DecideRetention` derives retain/archive from the rule's period against the document's age, so a retention decision cannot quietly shorten a legal hold; the operator only records it.
6. **Audit half of the sequence row already certified in Package 02** — nothing re-implemented, no parallel audit path.

## Clean handoff

- Working tree contains only this package's implementation, tests, migrations, and documentation; no scratch artifacts; `.gitignore` unchanged.
- Dev database `toefl_house` migrated to the full 25-migration schema; test database rebuilt per suite.
- Recovery script and baseline remain valid (`--verify` → ENVIRONMENT VALID); release artifacts untouched.

## Certification

All gates PASS (or NOT APPLICABLE with recorded reason). Package 04 — Documents/Privacy is **CERTIFIED** at this checkpoint. Certified cumulative suite: **OK (158 tests, 590 assertions)**; phpstan level 6 clean (76 files); pint clean (136 files).
