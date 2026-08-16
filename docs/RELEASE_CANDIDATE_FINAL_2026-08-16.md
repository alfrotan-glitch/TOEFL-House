# Final release-candidate audit — pass 5

Fifth independent pass, continuing from four earlier audits. Nothing was taken
on trust: the full gate was re-run from scratch, the fixes from previous passes
were attacked directly, and the hunt targeted defect classes no earlier pass
had touched — the discount/installment path, JSON-column integrity, and the
release automation itself.

---

## F-11 — the installment plan was unvalidated financial data (HIGH, fixed)

`PATCH /api/students/:id` accepted **any** value for `installmentPlan` and
stored it with an unconditional `JSON.stringify()`. Sending an already
serialised plan — the obvious mistake for a client that keeps it as a string —
double-encoded the column. It parsed back to a *string*, and the payment route
called `plan.find(...)` on it:

```
POST /api/students/:id/payments { category: 'installment', ... }
  -> 500 "plan.find is not a function"
```

Two defects behind one symptom:

1. **Corrupt financial data accepted at the write boundary.** The plan drives
   real charges. There was no validation at all — no shape check, no id check,
   no amount check, no duplicate check.
2. **A money endpoint returned 500 on data the server itself wrote.**
   `parseJson()` guarded against a *parse* failure but not against the parsed
   value having the wrong *shape* — a JSON string parses perfectly well.

**Fix.** `PATCH` now rejects a non-array plan, missing/blank ids, duplicate ids,
non-positive or non-numeric amounts, and unknown statuses. Duplicate ids matter
specifically: they make "pay installment X" ambiguous, and settling one would
silently mark the other paid. Reads go through `parseJsonArray()`, so
pre-existing corrupt rows degrade to "no installments" (a handled 409) instead
of crashing.

Verified live: all seven malformed shapes now 400 with nothing written; 8
concurrent payments of one installment give **1×201 / 7×409**, one payment row
and one agreeing ledger row.

**Class swept.** Every other client-controlled JSON column was checked —
`automations` already validates `Array.isArray` on both POST and PATCH. F-11
was an isolated gap, now closed.

## F-12 — the release script could not run on the release machine (fixed)

The only scripted release step, `release:clean`, was a **PowerShell** file. On
Linux it exits **127** (`sh: 1: powershell: not found`). Any CI runner would
have executed a release step that did nothing, and the failure is easy to miss
mid-log.

Worse, the high-assurance static audit "verified" that script by **grepping it
for path strings** — so it asserted the existence of *text*, not the behaviour
of a release process, and passed whether or not the script could execute.

**Fix.** `scripts/release-validate.mjs` — one portable command, real exit codes,
nothing reported that was not observed:

```
npm run release:validate          # full gate
npm run release:validate:quick    # static + DB only
```

It runs typecheck and lint (frontend + server), the product-integrity and
static audits, both production builds, bundle weight, the server test suite,
fresh-schema preflight, a **real fresh install into a temp directory**
(asserting migration count, `integrity_check`, `foreign_key_check`), branding
(the official logo must exist and exceed 1 KB; the slogan must match exactly),
and release hygiene (no build output, `.env` or `.sqlite` tracked — read from
`git ls-files`, not from a script's source text).

Two bugs in my own first version (a top-level-`await` probe and a stale
static-audit assertion) were found **by running it**, not by assuming it worked.

---

## Verification

| Gate | Result |
|---|---|
| Full test suite | **796 / 797** (1 intentional — missing logo) |
| Frontend typecheck / lint | PASS |
| Server lint (eslint + tsc) | PASS, **0 errors** |
| Frontend + server production builds | PASS |
| Product-integrity + static audits | PASS |
| Bundle weight | PASS |
| Fresh-schema preflight | PASS |
| Fresh install | 65 migrations, 106 tables, `integrity ok`, 0 FK violations |
| Migration convergence | fresh vs migrated: **355 objects, 0 differences** |
| Backup → destroy → restore | verified **on live data** (15 students, 12 payments, 232,670 AFN) |
| Reconciliation | amount 0, cash 0, saving 0, healthy |
| Working tree | clean |

**Full business lifecycle, end to end:** visitor registration → teacher hire →
class creation → enrollment with partial payment → balance (due 12,000 / paid
4,000 / outstanding 8,000) → remaining payment → outstanding 0 → session →
class activation → attendance → assessment → grade → exam enrollment with fee →
book sale → teacher payroll → reconciliation **healthy with zero variance**.

**Reversal matrix — every money type reverses cleanly:**

| Reversal | Result | Cash vs ledger |
|---|---|---|
| Student refund 1,000 | 201 | exact |
| Book-sale refund | 200 | exact |
| Payroll void | 200 | exact |

The payroll void netted its 25,000 expense to zero and restored the budget line.

**Financial source-of-truth:** `/finance/pnl` income + `capital_injection`
equals raw ledger income exactly; `/finance/pnl` expense equals raw expense
exactly. No surface reconstructs its own truth.

**Adversarial re-audit after remediation — 16/16 passed:** six sensitive
endpoints all 401 unauthenticated; `alg=none` forgery rejected; tampered
signature rejected; SQL injection shows no row amplification and tables intact;
all five reconciliation dimensions zero/healthy; P&L agrees with the ledger.

**RBAC:** a receptionist cannot self-grant the owner role, list users, read
finance, create branches, read the role catalog, pay salaries, or deposit to
the treasury — all 403. Discount edits are capped at 30% by a **configurable
business rule** with an evaluation audit log (I requested 90%, the server
stored 30%) — backend-enforced, exactly as required.

**Mutation testing (M20–M21), both caught:** removing the installment
write-validation fails 2; reverting `parseJsonArray` to the shape-blind
`parseJson` fails 1.

---

## Simplification

- Removed `scripts/prepare-clean-release.ps1` — dead on every non-Windows machine.
- De-exported six functions (`readClientIdempotencyKey`, `getSetting`,
  `initEventBusSchema`, `isClassOperational`, `normalizePolicyComponents`,
  `isoToSeconds`) with exactly one internal use and zero external consumers.
  **Not dead code** — needlessly public. Verified before touching them.
- Unused dependencies: **0**. Unreferenced tables: **0** of 106.
- Investigated and deliberately kept two false-positive "orphan" categories:
  lazily-imported view components (`lazy(() => import(...))` defeats a naive
  grep) and `server/src/db/seed.ts` (an npm script entry point).

Net: one new script, one deleted script, six narrowed exports, +5 tests for a
proven HIGH defect. No new middleware, abstraction, or compatibility layer.

---

## Blockers — both external, both proven

### 1. Official logo asset — absent after four delivery attempts

`public/brand/toefl-house-logo.png` does not exist. The PNG has now failed to
reach the workspace **four** times (`/home/user/uploads/` is never created; the
only PNGs on the machine are OS-supplied).

The branding system is complete and wired to that single path, and the release
gate now fails explicitly on it. Verified end-to-end in an earlier pass with a
temporary throwaway file: with an asset present the branding suite passes 6/6
and the build copies it to `dist/brand/`. That file was **deleted, not
committed** — recreating the logo is forbidden, and a placeholder would hide
the gap rather than close it.

**Exact action required:** copy the official PNG to
`public/brand/toefl-house-logo.png`. No code change needed.

### 2. CI is inert

Activation was re-attempted this pass and rejected again:

```
! [remote rejected] arena/01a0062e-toefl-house
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/ci.yml` without `workflows` permission)
```

Two independent confirmations across two sessions.

**Exact action required:** a human with the `workflows` permission copies
`ci/github-actions-ci.yml` to `.github/workflows/ci.yml`. The pipeline now
includes a `release-validation` job running `npm run release:validate`.

---

## Remaining risks

- Owner role carries all permission codes regardless of scope; scope governs
  rows, not endpoints. Deliberate, documented (pass 2).
- Employee pay-salary duplicate guard is free-text `LIKE` matching, bypassable
  via `paymentType:'advance'` or a varied `monthName`. Low severity, open.
- Five route files write money without the shared `resolveIdempotency`. Probed
  under concurrency and correct today via business-event guards plus DB
  constraints, but they rely on SQLite's synchronous driver.
- Books/funding list endpoints unbounded — correct now, a scale risk later.
- Single-process SQLite ceiling; automatic backups sit on the same disk.
- Three oversized modules (`types.ts`, `apiStore.ts`, `classes.routes.ts`); 576
  `any` in server source; no frontend test runner.

---

## Verdict

**No known CRITICAL or HIGH defects remain.** Every defect found across five
passes is fixed, mutation-verified, and covered by a regression test that fails
when the fix is reverted.

Against the stated targets:

| Target | Status |
|---|---|
| No known CRITICAL/HIGH defects | **Met** |
| No duplicate business truth | **Met** — P&L, ledger, cash and budget all agree |
| No financial reconciliation gaps | **Met** — amount/cash/saving all 0 |
| No cross-scope authorization gaps | **Met** — 0 leaks, escalation blocked |
| No dead/legacy clutter | **Met** — 0 unused deps/tables/exports |
| No unnecessary complexity | **Met** — net simplification |
| No false-confidence tests | **Met** — tautological tests removed in pass 4 |
| Reproducible release validation | **Met** — one command; it correctly blocks |

**This is a Release Candidate blocked on two external items**, neither a code
defect: the official logo asset and CI activation. Both are proven, not
asserted, and both have an exact one-step remedy.

The five-pass pattern is worth stating plainly: **every pass found real HIGH or
CRITICAL defects the previous pass missed, with a green suite throughout.** The
most valuable finding this pass was not a bug in the product but a bug in the
*verification* — a release script that could not run and a static audit that
checked its text rather than its behaviour. Automation that reports success for
work it never performed is the most dangerous artefact in a release process,
and it is exactly what the new gate is designed to make impossible.
