# The TOEFL House — CMS Readiness, Security & Recovery Runbook

**Scope:** live `the-toefl-house.pages.dev`, production Cloudflare Pages + D1 CMS.  
**Operating rule:** preserve live data, independent rollback and owner-controlled authentication. This repository is public: **never commit passwords, TOTP seeds, session cookies, invitation tokens, staff details, draft content, complete D1 exports or private backups.**

## Verified and automated

- `public-auth-readonly.mjs` — GET-only checks of protected CMS endpoints, public CMS JSON and admin `noindex`/CSP. Safe for daily monitoring.
- `public-auth-guards.mjs` — one-time negative POST checks using deliberately invalid, unauthenticated payloads; **manual-only**, never schedule a write-related security probe.
- `legacy-dependency.mjs` — verifies the immutable November 5 CMS/auth deployment and November 9 marketing overlay still respond; checks the official site's preserved Dari/Pashto student tools.
- `public-content-snapshot.mjs` — **disabled on this branch before fetch/write** pending an owner-reviewed nested public schema and projection. Its historical top-level checks and sensitive-key denylist cannot establish that unknown nested content is public. A public-content snapshot is not a full D1 backup.
- `public-schema-preflight.mjs` — local, read-only shape diagnostic for the public API envelope, described below. It does not unlock the archive or change the API.
- `proposed-public-projection.mjs` — offline-only explicit projection experiment over the same provisional subset. It rejects unknown fields, unreviewed nonempty media and invalid known shapes instead of silently discarding them, and preserves recognized fixture fields; it is not wired into the Worker or the archive. Synthetic compatibility tests do not prove historical client compatibility, field/value publicity, or safety of source records. Its success result contains content, so do not log or export it from sensitive data. Owner classification, a complete versioned schema, historical consumer review and authorized compatibility tests are still required.
- `toefl-v2-production-quality.yml` includes live checks and an archive job, subject to workflow dependencies and gates. The archive cannot succeed on this branch until its fail-closed prerequisite is resolved; skipped jobs are not passing checks.

## Proposed public schema preflight (not approval)

An authorized operator may feed an already-obtained `/api/content` JSON response through stdin on a trusted system: `node cloudflare/cms-readiness/public-schema-preflight.mjs < /path/to/authorized-response.json`. The tool does not fetch, write files, or print values or unrecognized key names. It emits fixed category counts of encountered unknown fields, some invalid shapes, and unreviewed nonempty media. It accepts at most 3,000,000 input bytes, and errors do not echo the input. Keep the source securely controlled and delete temporary copies according to owner policy; do not place the response in a public repository, artifact, CI log or issue. Counts can still reveal structural information, so share them only if the owner authorizes it.

The recognized fields are a **renderer-derived, provisional subset**, not the historical CMS schema: unknown fields are counted at recognized object boundaries, their contents are not traversed; media is not examined; scalar values are not classified; required fields, program identity/count, URL safety, all shapes and backward compatibility are not fully validated. Zero counts do **not** mean data is public, complete, safe, approved or compatible. A nonzero count is a review prompt, not a decision to delete data. Owner review must classify each field/value and permitted use, document historical API consumers and media, approve a versioned nested projection and compatibility/migration plan, and test it against authorized fixtures before enabling any archive or deployment. Do not use this diagnostic on unapproved production data or as a substitute for those gates.

## Authorized CMS acceptance: essential remaining tests

Run on an isolated preview or supervised owner session. **Do not submit a synthetic production enquiry or publish test content without explicit, documented authorization.**

| Scenario | Minimum acceptance evidence |
| --- | --- |
| Owner login | Valid account + current TOTP, authenticated session, proper expiration and logout |
| Staff separation | Owner grants a distinct limited Editor account via the **actual application**, not raw SQL; verify both allowed and refused actions |
| Draft safety | Save/reload a draft, leave current published revision unchanged, refuse or explicitly resolve a stale base revision |
| Publish | Approve a harmless, reversible content test and confirm new revision on all three public language roots |
| Restore | After independent backup and with owner approval, restore the prior published revision and prove every language/API remains consistent |
| Images | Upload a harmless test image, verify type/size policy, origin protection, published rendering and cleanup |
| Reception | With staffed approval, confirm a single synthetic lead flows to the correct team; remove the QA record; never confuse clicks with real enrollment |

## Important: stale draft

Do not delete, overwrite or publish an existing draft whose `base_revision` is older than the current `content.revision`. First:

1. Have the Owner open the CMS authenticated editor and inspect that draft.
2. Preserve the original draft **and** currently published content using secure, access-restricted backup.
3. Compare changes field by field; do not assume the draft is intended to replace the entire live revision.
4. Merge only approved changes into a newly based draft, or discard the stale copy after explicit staff confirmation.
5. Recheck the revision history and all three live language roots.

The archived stale draft table is evidence and **must not be emptied as a cleanup shortcut**.

## Recovery architecture & risk boundaries

- Live static files and Pages Functions must remain pinned to verified deployment IDs. The original November 5 CMS/auth implementation is not fully present in this repository; deleting that immutable deployment would break protected features.
- Cloudflare D1 Time Travel **bookmarks are recovery pointers within platform retention**, not downloadable encrypted standalone backups. Obtaining a bookmark is read-only; **calling restore on production is destructive** and requires a separate approved recovery action.
- Cloudflare D1 `/export` can temporarily interrupt queries during export; schedule a proper full database export under an approved maintenance window and download it to secure storage, **not a public GitHub artifact**.
- To prove disaster recovery, build a separate D1 test database and isolated Pages Preview that never shares production staff sessions. Import an encrypted, authorized backup and test owner/editor roles, draft history, publish, restore, media and tools against **synthetic** records. Promote nothing until this passes.
- The marketing `toefl-house-conversions` database is separate from the CMS; count website clicks as click intent only. The admissions team supplies aggregate real leads/placements/enrollments to calculate actual conversion.

## Read-only Cloudflare D1 SQL checks

Use the supplied `read-only-integrity.sql` in an authorized D1 console. It yields **counts and validity flags**, never passwords, identity rows, TOTP, token hashes or draft bodies. **Do not place resulting sensitive operational details in public issue comments.**

## Release signoff

1. Exact tested source revision and previous deployment are recorded.
2. 39 canonical URLs and CMS `/api/content` pass.
3. Editor/Owner session checks pass on a nonproduction environment.
4. No stale draft is auto-published; revision lineage is intact.
5. Full private backup is verified in a separate environment.
6. Rollback procedure is tested without destroying production.
7. Only then remove the historical pinned Worker dependency.

**Current signoff boundary:** Historical checks and earlier observations do not establish acceptance of the current candidate. The nested public schema, archive, exact historical asset parity and isolated candidate preview remain blocked; an **independent full authenticated CMS role test and private full D1 recovery drill** have not been completed. Do not label them accepted without current evidence and authorization.
