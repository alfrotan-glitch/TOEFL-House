# Remediation Certification — WP-05 Course Offering Compatibility

**Scope:** Academic Configuration Center → Programs & Levels → Course Offerings → Class Generation
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§41–42, 49, 53, 58–74 and §W
**Defect checkpoint:** `07d466d`
**Date:** 2026-08-22
**Status:** READY WITH TRACKED RISK — narrow remediation only

> This document remediates the course-offering compatibility defect discovered
> after the earlier WP-05 certification. It does not re-certify the whole WP-05
> package or the complete product.

## ROOT CAUSE

The failure was not caused by a missing Program, wrong Program ID, branch scope,
or term scope.

A real fresh-database HTTP reproduction established this sequence:

```text
Create Program → Create Version → Publish Version → Create Level → Create Term
→ Create Course Offering
```

Program, version, publication, level and term all succeeded. The newly created
level was stored with `levels.program_version_id = NULL`; its API response also
omitted that field. The Course Offering UI therefore treated the level as
compatible, while the offering route and canonical trigger correctly rejected
it with:

```text
Selected level does not belong to the selected program version.
```

The cause was an order-dependent contract:

- `POST /api/academic/levels` accepted only `programId` and always wrote NULL;
- `AcademicCatalogService.createVersion()` attached unversioned levels only
  when the version was created *after* the levels;
- level reads hid the version identity; and
- `OfferingsPanel` interpreted a missing version as a match for any selected
  version.

A control sequence that created the level before the version worked end to end,
including offering creation, preview, draft and class publish. That isolated the
root cause to level-version lifecycle and frontend/API state, not the strict
Course Offering or generation validation.

## REPAIR

- Added optional explicit `programVersionId` to level creation, with server-side
  program/version/branch ownership validation.
- Added `POST /api/academic/levels/:id/assign-version` for an existing
  unversioned level. It is one-way, validates prerequisite compatibility, and
  refuses a generic or silent move of a versioned level.
- Published `programVersionId` through level API and branch configuration reads.
- Added explicit version selection and existing-level attachment controls to the
  Academic Configuration Center.
- Subscribed the configuration center to the canonical `academic` freshness
  dataset, so a version created in the Versions panel refreshes the level form.
- Changed Course Offerings to show only exact version-matched levels and to
  explain when a selected version has none.
- Preserved every strict `Program → ProgramVersion → Level → Offering` database
  and generation check; no compatibility fallback or bulk data mutation was
  introduced.

## VERIFICATION

`course-offering-version-compatibility.test.ts` failed **4/4** before repair and
passes **5/5** after repair. It covers:

1. real API creation of Program → Version → Level → Offering;
2. real class-generation preview → draft → publish, producing one correlated
   class;
3. refusal of an unversioned level before explicit attachment;
4. successful offering creation after explicit attachment;
5. cross-program rejection without mutation;
6. refusal of generic hidden version assignment; and
7. level API/frontend exact-version/freshness contract checks.

The full WP-05 focused authority passed **18 files / 354 tests / 2
build-dependent layout skips** before the production build. The complete server
suite then passed **178 files / 2868 tests / 162 explicit retired-placement
skips**. Both typechecks, lint, production builds, canonical-schema preflight
and release gate were re-executed. Final release validation passed **22/22**,
including the fresh canonical-install and financial-reconciliation probes.

## REVIEW AND CLEAN

Cold review found that `ProgramVersionsPanel` already invalidated the canonical
`academic` dataset after a version mutation, but `AcademicSetupView` did not
subscribe to it. The repair consumes `useDatasetVersion('academic')`; it does
not add a second cache or a window-event workaround.

No migration, automatic reassignment, generated database, or build residue is
part of the deliverable. Existing unversioned levels remain explicit and may be
attached only by an authorized operator.

## VERDICT

**READY WITH TRACKED RISK** for this narrow defect remediation. The exact valid
Program → Version → Level relationship is now passed, stored, returned, selected
and consumed consistently by Course Offering creation and class generation.
The only general qualification remains repository TR-4: the cold review was
performed by the implementing agent rather than an external reviewer.
