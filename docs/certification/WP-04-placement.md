# Certification — WP-04 Placement

**Work Package:** WP-04 Placement
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`
**Date:** 2026-08-21
**Recoverable baseline:** `df3dfb3d91af677f06b0f9bb60e1fabb9d011391`
**Status:** READY — scope-limited certification complete

> This artifact certifies only WP-04. It does not certify Academic Structure,
> Academic Delivery, Finance, Reporting, Audit, the full system, production
> operations, or final release readiness.

## SCOPE

Included:

- placement requirement resolution and profile configuration;
- test-bank questions, sections, rubrics, lifecycle, CAS, preview and media;
- candidate workspace, immutable snapshots, timers, pause/resume, expiry,
  cancellation, typed responses and speaking-media correlation;
- automatic, manual, hybrid and rubric scoring; score bands, conditional
  decisions, outcomes, overrides and post-completion corrections;
- retake eligibility, attempt caps, start-time billing facts, placement payment
  and linked income writes;
- optional waiver, failed-sitting handling, visitor projection and
  program-change invalidation;
- placement report filtering/aggregation;
- conversion and class-enrollment placement gates;
- canonical schema, exact UI consumers, direct dependent contracts, and the
  WP-04 legacy-test boundary required to make those capabilities coherent.

Operative route boundary:

- `server/src/routes/placement.routes.ts`
- `server/src/routes/placement-attempt.routes.ts`
- `server/src/routes/placement-test-bank.routes.ts`

Excluded except as consumed dependencies:

- generic Academic Delivery assessment/exam design;
- academic catalog/class lifecycle beyond placement profile, rule and enrollment
  correlations;
- finance taxonomy, treasury, refunds, general payment/report design;
- organization/RBAC redesign beyond enforcing existing placement permissions and
  object scope;
- new scoring thresholds, retake rules, waiver policy, prices, enrollment policy,
  or assessment methods.

Risk: **HIGH/CRITICAL** — assessment integrity, answer secrecy, cross-branch
access, admissions eligibility, auditable outcomes and money-adjacent completion
writes are affected.

## DISCOVER / MODEL

### Runtime and authority map

| Area | Authority | Model |
|---|---|---|
| Requirement/profile | `policy-engine.ts`, `academic.routes.ts` | candidate branch → program-owning branch → global; requirement mode and components are stored facts; enabled/required/method/sections are projections |
| Test bank | `placement-test-bank.routes.ts`, placement store | branch/global assets; draft → active → archived; CAS versions; stable question ids; rubric/test kind correlation |
| Attempt lifecycle | `placement-attempt.routes.ts`, `timing-engine.ts` | one open attempt; immutable start snapshot; wall-clock overall expiry; component timer state |
| Responses/scoring | `scoring-engine.ts`, `decision-engine.ts` | typed atomic response batches; server automatic points; bounded manual/hybrid scoring; percentage and weighted provenance |
| Decision/outcome | `decision-engine.ts`, `placement-policy.ts` | conditional policy rules, score-band fallback, explicit level, required minima and one pass/fail verdict |
| Retake/billing | `placement-policy.ts`, `income.ts` | permission, cap and billability are independent snapshot facts; one payment and linked income only when billable |
| Admission gates | `enrollment-gate.ts`, conversion/enrollment consumers | current governing program plus latest authoritative completed outcome; fail closed for unlinked/missing/failed state |
| Reporting | `reporting.ts` | actual attempts only; parameterized branch/date/program filters; exact weighted summary |
| Storage | `server/src/db/schema.sql` | profile/test/attempt/result constraints and branch/program/snapshot/rubric/level correlation triggers |

### State model

- Test: `draft → active → archived`; status cannot be changed through generic
  content update.
- Attempt: `in_progress ↔ paused → completed | expired | cancelled`.
- Result: `pending → in_progress → completed | waived | timed_out`.
- Outcome: only a completed attempt has the authoritative `passed | failed`
  decision used by admission gates.
- A failed sitting remains completed, auditable and billable under its captured
  terms, while the visitor returns to a schedulable placement state.
- Authoring changes never mutate an existing attempt snapshot.

### Legacy-test knowledge

The corrected historical scope is **13 files / 156 statically declared cases /
160 baseline runtime cases**. `assessment-engine.test.ts` is an untouched WP-06
Academic Delivery authority and is not claimed by WP-04.

Every top-level historical placement block is now an explicit `describe.skip`
knowledge record. Replacement authority is **7 files / 60 runtime cases** plus an
**8-case architecture suite**, for **8 files / 68 passing focused cases**. The
full server suite confirms exactly **160 historical placement cases skipped**.

### Reproduced defects

Discovery and attack work reproduced defects in these classes before repair:

1. duplicate profile facts and permissive stored-policy coercion;
2. profile/rule branch, program, level and overlap drift;
3. mutable content/rubric dependence after an attempt started;
4. test/rubric object authorization based on role/home branch rather than the
   object and requested scope;
5. missing CAS and generic status mutation paths;
6. malformed question/section/rubric content, stale question rows, MIME spoofing,
   lexical path escape and symlink escape;
7. answer keys reaching operational projections;
8. more than one open attempt, retake/cap drift and program-change invalidation
   gaps;
9. client timer/score aliases, late responses and non-atomic response batches;
10. speaking responses referencing missing, non-audio or foreign-branch media;
11. total score arithmetic that ignored component maxima or trusted aggregate
    client scores;
12. missing authoritative pass/fail persistence and inconsistent failed-sitting
    handling;
13. correction/override projection and provenance drift;
14. completion reading current billing configuration, duplicate charge risk and
    unlinked income;
15. conversion and alternate enrollment paths bypassing placement;
16. unscoped expiry maintenance and permissive/impossible report dates;
17. schema gaps for placement JSON, booleans, numeric ranges, scores and object
    correlations;
18. a cold-review weighted-score rounding defect that produced a value 100× too
    large and was exposed by the new database constraint before certification;
19. attempt start writing a removed stored `method` field instead of the derived
    canonical method projection;
20. test section replacement capable of orphaning retained question references,
    and rubric kind changes capable of invalidating linked tests.

## CHALLENGE / DECIDE

| Subsystem | Decision | Reason |
|---|---|---|
| Placement profile | REBUILD storage projection / REFACTOR API | duplicated compatibility facts could disagree; canonical input/output needed CAS and strict policy validation |
| Policy hierarchy | REFACTOR | preserve established hierarchy but fail closed on inapplicable or corrupted policy |
| Test-bank authoring | REFACTOR | retain content model; enforce object scope, CAS, explicit lifecycle and normalized content |
| Rubric/media boundary | REBUILD security boundary | kind/branch drift, MIME spoofing and resolved-path escape were high-risk |
| Attempt snapshot/lifecycle | REBUILD | mutable policy/content and split expiry ownership could not preserve sitting evidence |
| Timing | REFACTOR to one authority | server deadlines and atomic visitor reset must not be duplicated in routes |
| Scoring/decision/outcome | REBUILD authority boundary | server scoring, recommendation and outcome must be deterministic from immutable facts |
| Correction/override | REFACTOR transaction | preserve established management commands while recomputing every dependent projection |
| Retake/billing | REBUILD shared policy | permission, cap and price are independent; completion must use start-time facts and one transaction |
| Conversion/enrollment gates | REFACTOR shared consumer | every admission writer must consume one placement eligibility decision |
| Reporting | REFACTOR | branch/date/program scope and summary arithmetic must match database truth |
| Historical suites | REPLACE / explicitly retire | obsolete direct-schema and permissive contracts cannot remain competing runtime authorities |

The implementation plan was limited to established placement facts and their
necessary consumers. No assessment, threshold, retake, waiver, fee or enrollment
policy was invented.

## CHECKPOINT

**Classification:** canonical schema change · security/RBAC enforcement ·
financial-adjacent transaction change · core lifecycle/authority replacement ·
legacy-test replacement.

The recoverable pre-package state is commit
`df3dfb3d91af677f06b0f9bb60e1fabb9d011391` on the fixed Arena branch. The
canonical schema remains the sole initialization authority. WP-04 decisions are
registered as D-79–D-85; invariants and canonical authorities are recorded in
`docs/registries/`; protocol conflict C-14 records the corrected replacement
boundary.

## IMPLEMENT

### Profile, policy and schema

- Removed profile `enabled`, `required`, `method`, `sections_json` and overall
  `max_score` storage duplication. Projections are derived from requirement mode
  and validated components.
- Profile writes use CAS and reject contradictory/coerced booleans, malformed or
  overlong text, invalid scoring/timing/retake/money facts, noncanonical level
  decisions and content/scoring mismatch.
- Persisted policy is independently revalidated before attempt creation; corrupt
  but syntactically valid JSON returns 409 with no side effects.
- Placement rules correlate version, branch, level id/code and non-overlapping
  active ranges; retirement is soft.
- Canonical schema checks JSON shape, enums, booleans, integer/range/score facts,
  and uses triggers for attempt scope, snapshot membership, result level,
  test/rubric branch-kind and rule branch/level-code correlations.

### Assets and candidate workspace

- Test/rubric writes are object-correlated, CAS-protected and transactional.
  Retained question ids remain stable; stale rows are deleted; retained question
  section references are revalidated before section replacement.
- Rubric criteria are normalized and weighted; test/rubric type correlation is
  enforced on test and rubric changes and by database triggers.
- Media upload verifies size, allowed MIME and byte signature. File reads verify
  lexical and filesystem-resolved confinement and serve the validated real path.
- Attempt start captures immutable policy, levels/rules, answer-bearing content,
  rubrics, billing terms and prior completed-attempt count. API projections redact
  answer keys.
- Typed response batches are atomic. Automatic answers are server-scored;
  speaking requires branch-correlated audio media.
- Overall expiry is wall-clock authority. Pause/resume affects component
  deadlines only; lazy and maintenance expiry share the same attempt/visitor
  reset invariant.

### Scoring, outcomes, billing and gates

- Automatic, manual, hybrid and immutable rubric scoring produce raw,
  percentage and correctly rounded weighted provenance.
- Conditional rules use canonical level ids before score bands; waived components
  satisfy an authorized requirement but do not fabricate a score for conditions.
- Completion persists one authoritative outcome. Failed sittings remain completed
  and auditable while the visitor returns to scheduled placement.
- Corrections rewrite result, decision, outcome and visitor projection in one
  transaction and retain authorized override/provenance.
- Start eligibility and billing use one shared policy authority. Billable
  completion creates one idempotent payment and one linked placement income row;
  free completion creates neither.
- Conversion and both class-enrollment consumers fail closed for missing,
  unlinked, incomplete, failed or foreign-hierarchy state and accept the latest
  authoritative pass or established not-required/waiver state.
- Reporting validates real UTC calendar dates, uses parameterized scope, and
  derives the overall average from unrounded program aggregates.

### UI and dependent contracts

- Academic profile UI preserves percentage-based component maxima/weights,
  retake and billing controls, CAS versions and lossless derived methods.
- Selecting test-bank content derives the required auto/manual/hybrid method;
  disabling placement clears components and rules.
- Test-bank UI sends CAS versions, uses activate/archive commands and only offers
  compatible rubrics.
- Candidate content scoring uses `manualScore` only for the manual portion; the
  client cannot submit automatic aggregate points.
- Six dependent WP-03/admission fixtures were updated to the canonical profile
  schema rather than restoring removed compatibility columns; **6 files / 270
  dependent cases passed**.

## VERIFY / ATTACK / REVERIFY

| Gate | Result |
|---|---|
| Focused WP-04 package | **8 files / 68 tests passed** |
| Full server suite | **157 files / 2513 tests passed; 13 files / 160 tests explicitly skipped** |
| Canonical schema | **PASS — 112 tables / 235 indexes / 90 triggers; standalone, sound, idempotent, sole authority** |
| Server production TypeScript | PASS |
| Server test-config TypeScript | PASS |
| Frontend TypeScript and production build | PASS |
| Backend production build and schema copy | PASS |
| Frontend lint | PASS — 0 errors / 12 pre-existing warnings |
| Backend lint/typecheck | PASS — 0 errors / 80 pre-existing warnings; focused WP-04 files add none |
| Product integrity | PASS |
| High-assurance static audit | PASS |
| Protocol audit | PASS — sealed protocol |
| Registry audit after WP-04 registration | PASS — 6 registries / 279 rows / all references live |
| Dependency isolation | PASS — 284 files / 32 declared packages |
| Source cleanliness | PASS |
| Design-system/direction audit | PASS — 106 files |
| Logging audit | PASS — 112 runtime modules |
| Bundle gate | PASS — 494 KB first paint within 560 KB budget |
| Config-data audit | PASS — no malformed fee configuration or over-ceiling student discount in the clean local database |
| Quick release validation | PASS — 17 passed / 0 failed / 5 intentionally skipped |
| `git diff --check` | PASS |

Adversarial coverage includes unauthenticated and foreign-branch requests;
object-id and parent/child forgery; malformed stored policy; profile/test/rubric
CAS races; global-template mutation; malformed arrays and question/rubric
correlation; MIME and path attacks; forged attempt scope and snapshot rows;
atomic response retry; timeout/expiry; cross-branch speaking media; score aliases,
bounds and duplicate scoring; failed outcomes; correction/override provenance;
retake caps; duplicate billing; policy changes after start; report date/filter
attacks; and all conversion/enrollment bypasses.

## INDEPENDENT REVIEW / CLEAN

A separate artifact-only review re-read the diff, authorities, schema, route list,
transactions, UI consumers and tests. It found and repaired before final gates:

- the weighted score was rounded with a 100× multiplier; the new schema check
  reproduced the defect and the complete focused package was rerun after repair;
- attempt start wrote a removed profile field instead of the derived method;
- stored component fields still accepted type-coercible booleans/numbers despite
  the intended fail-closed boundary;
- retained questions were not checked when only sections changed;
- rubric kind mutation could invalidate linked tests;
- report summary used rounded subgroup averages;
- waived null scores could satisfy conditional score rules;
- override silently ignored malformed visitor placement JSON;
- UI test selection defaulted to hybrid even for auto-only/manual-only content;
- dependent current suites still wrote removed compatibility columns.

Cleanup removed introduced unused imports/variables, debug artifacts and the local
fixture rows created during diagnosis. No generated build output, media, database,
credentials or temporary evidence is tracked. Source cleanliness, lint, schema,
focused tests and the full suite passed after the final repairs.

## CERTIFICATION MATRIX

| Dimension | Status | Evidence | Remaining risk in WP-04 |
|---|---|---|---|
| Architecture / canonical authority | READY | D-79–D-85, architecture suite, registry audit | none material |
| Domain correctness | READY | profile, lifecycle, scoring, billing and gate suites | none material |
| Database / data integrity | READY | canonical preflight, 90 triggers, attack suite | none material |
| Financial-adjacent writes | READY | retake/billing suite; payment-income transaction and idempotency | broader Finance remains excluded |
| RBAC / object scope | READY | test-bank/attack/enrollment suites | none material |
| Security / answer secrecy / media | READY | redaction, MIME, realpath and cross-branch attacks | filesystem administrator remains outside application threat model |
| API / concurrency | READY | CAS, unique indexes, transaction and duplicate-submission tests | none material |
| Frontend / UX | READY for altered placement surfaces | typecheck, build, UI architecture assertions, explicit error/lifecycle controls | no claim over unrelated screens |
| Reporting | READY for placement report | strict date/filter tests and aggregate reconciliation | broader Reporting remains excluded |
| Reliability / timing | READY | wall-clock, pause/resume, timeout and expiry tests | maintenance remains on-demand plus lazy request enforcement |
| Testing / C-2 | READY | 68 focused; 2513 full-suite pass; exact 160 explicit retirement skips | TR-4: independent review performed by the same agent |
| Maintainability / cleanliness | READY | authority registry, protocol/static/dependency/cleanliness gates | none material |
| Operational readiness | OUT OF PACKAGE | build/schema/release-quick gates pass | production deployment is not certified here |

## CERTIFICATION

**WP-04 Placement is READY.** All critical/high dimensions inside the defined
Work Package pass with executable evidence. No critical contradiction, bypass,
data-integrity uncertainty, answer-key exposure, duplicate authority or
unverified financial-adjacent placement write remains in scope.

The certification is deliberately bounded: it does not advance or certify WP-05
Academic Structure, WP-06 Academic Delivery, Finance, Reporting, Audit or final
system release readiness.
