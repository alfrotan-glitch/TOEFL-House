# WP-05 Course Offering Compatibility — Defect Investigation and Repair Plan

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§41–42, 49, 53, 58–74 and §W
**Work package:** WP-05 Academic Structure — curriculum / offering / generation ownership graph
**Date:** 2026-08-22
**Pre-remediation baseline:** `31836ffe5c9b1d6594c17db7e8b58305a0bd4682`

> This is a narrowly scoped remediation of a newly reproduced WP-05 defect. It
> does not reopen enrollment, waitlist, finance, payroll, reporting or generic
> curriculum-policy work.

## SCOPE

Included:

- the `Program → ProgramVersion → Level → CourseOffering` contract;
- course-offering creation and class-generation consumption of that contract;
- the level API response/write contract and the two Academic Configuration
  Center surfaces that select or create a level;
- existing unversioned levels that must be explicitly attached to a compatible
  program version before they can be used in a course offering.

Excluded:

- changing the canonical requirement that an offering names a versioned level;
- relaxing database offering/generation correlation triggers;
- branch policy, term policy, fee policy, capacity policy or class lifecycle;
- any unscoped backfill of user data.

Risk: **High**. A course offering is the canonical delivery identity consumed by
class generation; accepting a mismatched graph would create invalid academic
records, while refusing a valid operator workflow blocks normal operation.

## DISCOVER

The relevant current authorities are:

| Layer | Actual authority / behavior |
|---|---|
| Storage | `levels.program_id`, nullable `levels.program_version_id`; `course_offerings` requires `program_id`, `program_version_id`, `level_id`, `branch_id`, `academic_term_id` |
| Database integrity | `trg_offerings_scope_insert/update` requires the level's `program_version_id` to equal the offering version; this is correct and must remain strict |
| Level writer | `POST /api/academic/levels` accepts only `programId`; it always writes `program_version_id = NULL` |
| Catalog service | creating a fresh version attaches *already existing* unversioned levels; it cannot attach levels created after that version exists |
| Level reader | `mapLevel()` omits `programVersionId` from `/api/academic/levels` responses |
| Offering UI | `OfferingsPanel` treats a missing `programVersionId` as compatible with every selected version |
| Offering API | `POST /api/offerings` correctly rejects a level whose stored version is NULL or another version |
| Generation | `ClassGenerationEngine` correctly resolves the selected offering and requires every generated level to belong to that exact version |

## REPRODUCED EVIDENCE

A fresh-database, real HTTP reproduction used this operator-valid sequence:

```text
Create Program → Create Version → Publish Version → Create Level → Create Term
→ Create Course Offering
```

Observed results:

- Program, version, publication, level and term each returned success;
- the created level was stored with `program_version_id = NULL`;
- `/api/academic/levels` omitted any `programVersionId` field, so the offering
  UI cannot distinguish it from a versioned level;
- `POST /api/offerings` returned **400**:
  `Selected level does not belong to the selected program version.`

The same branch, program id, program version id and term id were used throughout.
A control sequence that creates the level *before* the version succeeds because
`AcademicCatalogService.createVersion()` then attaches the unversioned level;
Course Offering creation, preview, draft and publish all completed with one
created class. Therefore branch scope, term scope, offering validation and the
generation engine are not the root cause.

## ROOT CAUSE

**Root cause: an order-dependent level-version lifecycle plus a contradictory
frontend/API contract.**

`POST /api/academic/levels` has no `programVersionId` input and always creates
an unversioned level. The catalog service only binds unversioned levels during
creation of a later fresh version. When an operator creates a level after a
version exists — an available and natural Academic Configuration Center
workflow — the level remains unversioned indefinitely. The level response hides
that state, and `OfferingsPanel` explicitly admits a missing version as a match.
The offering route and schema then correctly reject the invalid graph.

This is not a missing Program, an invalid Program ID, a branch-scoping failure,
a term failure, or a reason to weaken the offering trigger.

## CHALLENGE

| Option | Decision | Reason |
|---|---|---|
| Relax offering/generation checks to accept NULL level versions | **REJECT** | It would contradict D-86 and let one level ambiguously belong to every version. |
| Silently attach a new level to a current/default version | **REJECT** | It hides a material curriculum decision and violates LAW 6 when multiple versions exist. |
| Require operators to delete/recreate levels in a specific order | **REJECT** | The UI permits the failing order and offers no truthful remediation for an existing level. |
| Expose and command explicit version attachment | **SELECT** | Preserves the strict graph while making the normal workflow and existing configured data operable. |

## DECIDE

1. Extend the level creation contract with optional `programVersionId`.
   When supplied, validate that the version belongs to the named program and
   persist it atomically. When omitted, preserve the existing explicit
   unversioned/staging behavior.
2. Add a narrow one-way assignment command for an existing unversioned level:
   `POST /api/academic/levels/:id/assign-version`. It validates the owning
   program/version/branch graph and refuses to move a level already attached to
   a different version.
3. Return `programVersionId` from the level API and branch snapshot.
4. Add explicit version selection to the Academic Configuration Center level
   form and an explicit attachment action for an unversioned existing level.
5. Make `OfferingsPanel` show only levels whose returned version exactly equals
   the selected version. It must never treat missing version data as compatible.
6. Preserve all strict offering and generation checks. Add actionable UI text
   when no versioned level is available.
7. Add automated tests for the failing sequence, explicit attachment,
   mismatched version/branch refusal, and the real Create → Preview → Draft →
   Publish generation path.

## CHECKPOINT

Classification: core curriculum/API/UI contract repair; current certified WP-05
surface; high-integrity ownership graph. The defect checkpoint is `07d466d`,
based on pre-remediation state `31836ffe5c9b1d6594c17db7e8b58305a0bd4682`.
It contains this plan and the deliberately failing four-case reproduction suite
before implementation. No schema migration or bulk data mutation is authorized;
existing levels are repaired only through the explicit operator command.

## IMPLEMENT

- `POST /api/academic/levels` now accepts an explicit optional
  `programVersionId`, validates version → program → branch ownership, and
  persists that link with the level.
- `POST /api/academic/levels/:id/assign-version` is the explicit one-way
  repair command for an existing unversioned level. It validates ownership,
  prerequisite compatibility and optimistic assignment state; generic level
  `PUT` refuses a hidden version assignment.
- `mapLevel()` now publishes `programVersionId` across level reads and branch
  configuration snapshots.
- Academic Setup subscribes to the canonical `academic` freshness version, so
  a just-created version reappears in the level form without a manual page
  refresh. Its level form can select a version, and existing unversioned levels
  expose an explicit attachment control.
- Course Offerings now filters levels by exact version equality and tells the
  operator why no eligible level is available. The strict offering and
  generation backstops remain unchanged.

## VERIFY → ATTACK → REPAIR → REVERIFY

The new authority suite first failed **4/4** at checkpoint:

1. normal `Program → Version → Level → Offering` creation omitted the level
   version and was refused;
2. an existing unversioned level had no attach command;
3. the missing command returned 404 even for a cross-program probe; and
4. the API/frontend did not expose or filter `programVersionId`.

After repair it passes **5/5**, including:

- real HTTP creation of program, version, level, term, room, slot and offering;
- real generation preview, draft and publish with one created correlated class;
- refusal of an unversioned level before attachment, then successful offering
  creation after explicit attachment;
- cross-program refusal with no level mutation; and
- generic update refusal plus frontend freshness/version-filter source guards.

The full WP-05 authority passes **18 files / 354 tests / 2 build-dependent
layout skips** before the production build. The complete server suite then
passes **178 files / 2868 tests / 162 explicit retired-placement skips**; the
release gate reruns it after the production build.

## INDEPENDENT REVIEW

A cold review of the graph found one additional consumer defect beyond the
initial API mismatch: `ProgramVersionsPanel` invalidated `academic` after
version creation, but `AcademicSetupView` did not subscribe to that dataset and
could retain a stale empty version list. The remediation uses the existing
`useDatasetVersion('academic')` authority rather than introducing a window event
or a second cache.

## CLEAN / STATUS

No migration, silent backfill, compatibility alias or raw data mutation is
introduced. Existing unversioned levels remain visible and may be attached only
through the explicit command. The historical WP-05 certification remains a
record of its original pass; the accompanying remediation certification records
the current course-offering result.
