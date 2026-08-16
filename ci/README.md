# CI pipeline — one manual step required

`github-actions-ci.yml` is the release gate for this repository. It is stored
here rather than at `.github/workflows/ci.yml` because the GitHub App used by
the automation that authored it lacks the `workflows` permission, so pushing a
file under `.github/workflows/` is rejected by the server:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

## Activating it

A human with write access needs to move the file once:

```bash
mkdir -p .github/workflows
git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "ci: activate the release gate"
git push
```

Nothing else changes — the file is complete and its YAML is valid.

## What it runs

Every job is a command that already exists in `package.json`, so the pipeline
matches what a developer runs locally. All of them were verified passing at the
time the file was written.

| Job | Commands |
|---|---|
| `frontend` | `npm run typecheck`, `npm run lint`, `npm run build`, `npm run audit:bundle` |
| `backend` | `npm run typecheck`, `npm test`, `npm run preflight:fresh-schema` (in `server/`) |
| `static-audit` | `npm run audit:static` |

## Why it matters

Until this runs automatically, the gate is manual. That is precisely how the
2026-08-16 audit's critical finding survived: a green 715-test suite coexisted
with duplicate tuition charges, because nothing mechanically required the
concurrency tests to cover the guarded payment categories. A gate that depends
on someone remembering to run it is not a gate.

## Verified blocked (2026-08-16)

This is not a theoretical limitation. Activation was attempted during the audit
by copying this file to `.github/workflows/ci.yml` and pushing:

```
! [remote rejected] arena/01a0062e-toefl-house -> arena/01a0062e-toefl-house
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/ci.yml` without `workflows` permission)
```

**Until a human with `workflows` permission copies this file to
`.github/workflows/ci.yml`, NONE of the quality gates below run automatically.**
Every "gate passed" statement in the audit reports was produced by running the
commands manually. Treat this as an open release blocker, not a formality.
