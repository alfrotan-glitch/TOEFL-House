# Engineering and release governance

Start with [the repository map and governance baseline](docs/REPOSITORY_GOVERNANCE_20261128.md) and [website release operations](cloudflare/site-v2/OPERATIONS.md). This repository contains both a Laravel management application and a separately deployed Cloudflare website; neither is a replacement deployment for the other.

## Changes and coordination

- Use a focused branch and pull request. Where a managed environment assigns a branch name, keep that name; otherwise use `<type>/<short-description>` (types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`). Never rewrite shared history or force-push without an explicitly approved recovery procedure.
- Use informative imperative commit subjects, preferably `<type>(<scope>): <summary>`; describe risk and migration implications in the body when needed. Existing commits and names do not need rewriting.
- Check open PRs, branch dependencies, workflow runs and release activity before overlapping changes. A closed PR, old timestamp or merged PR alone does not prove its source branch or commits are disposable. Preserve unfinished work and get explicit approval for named branches before deletion; recheck their tips, dependent PRs and automation immediately before any deletion.
- Every PR should describe scope, tests, deployment impact, rollback and known gaps. A green test against production or a fixed historical preview does not validate the current candidate.

## Sources of truth and boundaries

- Public website renderer and locale content: `cloudflare/site-v2/`; edge compatibility and routing: `cloudflare/pages-edge/`; website release instructions: `cloudflare/site-v2/OPERATIONS.md`. Published CMS data can override some content; verify institutional facts with authorized staff instead of assuming that code or an old report is current.
- Laravel management application: `app/`, `routes/`, `database/`, `config/`, `tests/`; local setup: `SETUP.md`. Its configuration and business rules are separate from the public Pages website.
- `docs/` includes contracts and historical evidence as well as current operational notes. Dated reports are snapshots, not current deployment status. Record ownership, evidence and scope before consolidating conflicting documents or code.
- Do not remove legacy tools, bindings (`CMS_DB`, `LEGACY_CMS`), deployed assets, routes, workflows or historical evidence merely because a static search does not find a reference. Audit runtime and external dependencies first.

## Validation

For website changes, compile `node cloudflare/site-v2/build.mjs`, check syntax and run `node --test cloudflare/site-v2/tests/*.test.mjs cloudflare/pages-edge/tests/*.test.mjs cloudflare/analytics/tests/*.test.mjs`. Some tests contact live systems and need network access; report failures or exclusions explicitly. For Laravel changes, follow `SETUP.md` and the relevant PHPUnit/static-analysis checks. Keep generated `cloudflare/site-v2/dist/` and `lighthouse-results/` out of Git; retain the tested release artifact and its checksum separately.

A production release requires a unique read-only preview of the exact artifact, route and language checks, no-write admissions testing, accessibility and performance verification, preservation of the existing asset manifest and bindings, an authorized operator, and post-release verification. Never test by submitting real applications or mutating production data. See the operations document for details.
