# The TOEFL House — CMS Readiness, Security & Recovery Runbook

**Scope:** live `the-toefl-house.pages.dev`, production Cloudflare Pages + D1 CMS.  
**Operating rule:** preserve live data, independent rollback and owner-controlled authentication. This repository is public: **never commit passwords, TOTP seeds, session cookies, invitation tokens, staff details, draft content, complete D1 exports or private backups.**

## Verified and automated

- `public-auth-readonly.mjs` — GET-only checks of protected CMS endpoints, public CMS JSON and admin `noindex`/CSP. Safe for daily monitoring.
- `public-auth-guards.mjs` — one-time negative POST checks using deliberately invalid, unauthenticated payloads; **manual-only**, never schedule a write-related security probe.
- `legacy-dependency.mjs` — verifies the immutable November 5 CMS/auth deployment and November 9 marketing overlay still respond; checks the official site's preserved Dari/Pashto student tools.
- `public-content-snapshot.mjs` — captures the **already-public** API content only and validates the seven course records in English, Afghan Dari and Pashto. Artifacts contain checksummed JSON and a manifest. This is **not a full D1 backup**.
- `toefl-v2-production-quality.yml` — runs the above GET-only checks with the existing trilingual SEO/site/accessibility gate; stores a public-content recovery artifact on each successful scheduled run.

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

**Current signoff boundary:** Public website, read-only CMS authorization and public-content recovery tests have passed. An **independent full authenticated CMS role test and private full D1 recovery drill** have not yet been completed; do not label them accepted without evidence.
