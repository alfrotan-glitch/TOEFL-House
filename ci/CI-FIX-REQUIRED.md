# One workflow change is required — and it cannot be applied by the agent

The first real CI run exposed three failures. Two are fixed and pushed. The
third is a bug **in the workflow file itself**, and the agent identity is
refused on `.github/workflows/*` (`without workflows permission`), so it must
be applied by a human.

## The bug

`.github/workflows/ci.yml` sets `NODE_ENV: test` **globally**. Under
`NODE_ENV=test` Vite skips production chunking: the React vendor chunk is not
emitted and first-paint weight rises from 482 KB to 701 KB, blowing the 560 KB
budget. The frontend job therefore fails for a reason unrelated to the code,
and `Release validation` fails as a consequence.

Reproduced from a clean clone, both directions:

| build env | first paint | vendor chunk | result |
|---|---|---|---|
| `NODE_ENV=test` | 701 KB | missing | **FAIL** |
| `NODE_ENV=production` | 482 KB | present | **PASS** |

## The fix

Only the backend job needs `NODE_ENV`. Apply the saved patch:

```bash
git apply ci/FIX-node-env.patch
git add .github/workflows/ci.yml
git commit -m "fix(ci): scope NODE_ENV=test to the backend job"
git push
```

Or edit by hand: delete `NODE_ENV: test` from the top-level `env:` block, and
add it under the `backend:` job:

```yaml
  backend:
    name: Backend — typecheck, tests, schema preflight
    runs-on: ubuntu-latest
    env:
      NODE_ENV: test
```

## Expected result

All four jobs green. Backend and Static audit already pass on GitHub's runners
as of run `31961698656`; the same run's frontend and release-validation jobs
fail only on the issue above, and both pass locally once `NODE_ENV` is scoped.
