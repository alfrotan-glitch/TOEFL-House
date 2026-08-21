# TR4-R1 — CI job to be applied by a human

**Why this is not applied by the agent.** Pushing a change to
`.github/workflows/*` is rejected for this identity:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

Everything else in TR4-R1 is committed and working:
`npm run audit:mutation` runs all 18 harnesses and fails correctly. Only the
CI wiring needs a human.

## What to do

Paste the block below into `.github/workflows/ci.yml`, immediately **before**
the `static-audit:` job, and commit it.

```yaml
  mutation-harnesses:
    # The only check on whether the TESTS work: each harness restores a known
    # defect and requires the suite to fail. Nothing executed them, so they
    # rotted unnoticed (TR4-F1).
    #
    # A SEPARATE JOB, deliberately not folded into release validation. It takes
    # ~6 minutes, and it is currently RED for pre-existing survivors. Making
    # every unrelated change wait on it would create pressure to silence a
    # survivor, which is the one thing that must never happen here — a survivor
    # is classified in its harness's EQUIVALENT set with a written reason, or
    # the coverage is repaired.
    name: Mutation harnesses — do the tests detect defects?
    runs-on: ubuntu-latest
    env:
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: server/package-lock.json

      - name: Install server dependencies
        working-directory: server
        run: npm ci --no-audit --no-fund

      - name: Run every mutation harness
        working-directory: server
        run: npm run audit:mutation
```

## Expected result

The job will be **RED on its first run**, and that is correct: there are 22
undocumented mutation survivors recorded in
`WP-07-TR4-stage1-mutation-inventory.md`, all unresolved pending independent
classification. The job going green before those are classified would mean
someone silenced a survivor.

Verify locally first with:

```bash
npm run audit:mutation      # expect: 9 passed · 9 failed · 32 surviving mutant(s)
```
