# Configuration / Policy Authority — Final Certification

**Date:** 2026-08-19 · **Branch:** `arena/01a0151e-toefl-house`
**Commits:** `c28c3b8` + `abd3d09` (CFG-1) · **`4aa73a5`** (CFG-2/3/4) · baseline `cdaa20b`

> **Correction to the stated brief.** The task description asserted "CFG-2/3/4: fixed and live-tested".
> That was **not true** at `abd3d09`: no commit touched `catalog.routes.ts`, and no CFG-2/3/4 test or
> mutation harness existed. All three were still open and were reproduced live before any code change.

---

## A–B. CFG-2 root cause and fix

`PUT /api/catalog/branch-profile/:branchId` passed request values straight into the UPSERT:

```ts
b.placementTestFee ?? null,   // no validation of any kind
```

**Live baseline (full payload, owner):** `-100`, `0.001`, `1e15`, `1e20` and TEXT `"abc"` / `"NaN"` /
`"Infinity"` all returned **HTTP 200** and persisted into `REAL NOT NULL` columns. `"abc"` changed the
column's storage class to `text`.

**Fix:** validate with the canonical authority Finance already uses — `assertMoney` — before any write.
No second validator. Sub-cent values are **refused rather than rounded**, because `assertMoney` maps
`0.001 → 0`, which would turn a typo into a free placement test. Pass mark / minimum attendance are
percentages, not money: finite and `0..100`.

## C. Before/after

| | baseline | after |
|---|---|---|
| Focused suite | **21 of 40 FAIL** | **40/40 pass** |
| `-100`, `0.001`, `1e15`, `1e20`, `"abc"`, `"NaN"`, `"Infinity"`, `true`, `false`, `[]`, `[500]`, `{}` | 200, stored | **400, DB unchanged** |
| `0`, `1`, `500`, `500.00`, `"500"`, `"500.00"`, `1e6` | 200 | **200, stored as canonical `real`** |
| Partial payload / first write for a branch | **500** | **200** |

## D. Mutation results

**CFG-2/3/4 harness** (`server/scripts/branch-profile-fee-mutation-test.mjs`): **10/11 KILLED, 0 unexplained survivors.**

`F11` (route scope check removed) is **PROVEN EQUIVALENT BY EXECUTION**, not inspection: with the check
deleted, a live server was attacked on a second branch — **manager 403, registrar 403, owner 200**.
`requirePermission('AcademicSetup.Edit','Settings.Edit')` already denies every non-owner, and an owner
writing another branch is correct. The in-route check is defence-in-depth and is retained.

**CFG-1 harness:** 14/14 KILLED, 0 survivors (re-run, unchanged).

## E. Live HTTP results (fresh DB, real server)

All 20 value categories exercised against HTTP **and** DB state. Every hostile value: `400` + stored
fee unchanged at its prior valid value. Every valid value: `200` + canonical number, `typeof = real`.
No `500` in any case.

## F. CFG-3 disposition — **CLOSED**

| attempted cardFee | PUT | stored | issue-card | payment | ledger |
|---|---|---|---|---|---|
| `-100`, `0.001`, `1e20`, `"abc"` | **400** | 200 (last valid) | 201 | **200** | consistent |
| `200` (valid) | 200 | 200 | 201 | 200 | consistent |

`payments` violating money invariants (negative or non-2dp): **0**.
`financial_transactions` violating 2dp: **0**.
The old late failure — `500 "payment amount must have at most two decimal places"` — is now impossible,
because the value is refused at configuration write.

## G. CFG-4 disposition — **CLOSED (contract investigated, not assumed)**

A `grep` across the whole repository found **no frontend or API-client caller** — only the route and its
compiled `dist` copy. There was therefore no established partial-update contract to preserve.

Root cause proven by execution: **SQLite validates the INSERT tuple's NOT NULL constraints *before*
`ON CONFLICT` resolves**, so a NULL placeholder aborts the statement even though the `COALESCE` in
`DO UPDATE` would have preserved the old value. Seeding a default row first does **not** fix this
(verified — still `NOT NULL constraint failed`). Values are now resolved against the existing row in
code. PUT semantics are unchanged and were **not** silently converted to PATCH.

## H. Database / schema

75 migrations, no drift · fresh install 110 tables, integrity ok · schema.sql unchanged by this fix
(validation is route-level; no migration required).

## I. Historical money integrity

Payment issued at `cardFee=200` → fee changed to `750` → **same payment still 200 (IMMUTABLE)**, next
charge `750`. No retroactive mutation.

## J. Frozen-subsystem results

Full serial suite **1766/1766 pass** (127 files), covering Finance, RBAC, Student, Enrollment,
Placement, Class, Teacher/Employee. CFG-1 re-verified live: manager rule 95% @prio10 → **20**;
authorized sponsorship → **100**; manager granting sponsorship → **403**. Cross-branch matrix identical
to baseline (owner 200; manager/registrar/other-branch manager 403).

## K. Complete gate results

| gate | result |
|---|---|
| Full serial suite | **1766/1766** (127 files) |
| `tsc --noEmit` | clean |
| `eslint` | **0 errors** |
| Fresh-schema preflight | 75 migrations, no drift |
| Fresh install + migrations | 110 tables, integrity ok |
| Financial reconciliation | amount/cash/saving/budget all 0 |
| `release-validate.mjs` | **16 passed · 0 failed** (235s) |
| CFG-1 mutation harness | 14/14 killed |
| CFG-2/3/4 mutation harness | 10/11 killed, 1 proven equivalent |

One transient full-run failure (`schema-index-parity` — a stray gitignored `src/tests/backups/`
artifact) was reproduced, traced to a cross-test ordering artifact of `deployment-verifier`, confirmed
**absent on clean HEAD**, and classified as **PRE-EXISTING TEST INFRASTRUCTURE**, not a functional
failure. The clean re-run passed 1766/1766.

## L. Remaining risks / operational requirements

1. **Existing malformed rows are not migrated.** Any branch profile already holding a negative,
   sub-cent, huge or TEXT fee keeps it — the fix guards the write path only. `resolveFee` still returns
   any finite stored value. A data audit of `branch_academic_profiles` is recommended before rollout;
   no repair rule was invented, per instruction.
2. **CFG-1 operational migration still outstanding** (unchanged): students holding >20% under the old
   unqualified `discount_percent` re-resolve to 20% on their next charge and must be re-authorized
   through `POST /api/discount-authorizations`. Fail-closed by design; needs a business decision.
3. **No UI** for discount authorizations or for the corrected fee validation errors.
4. `class-generation-engine.ts` has a separate private fee resolver, still untested.
5. `resolveFee` itself was left unhardened (defence-in-depth opportunity, not a defect) — deliberately
   out of scope to keep the change minimal.

## M. Final classification

| ID | Status |
|---|---|
| **CFG-1** | **CLOSED** |
| **CFG-2** | **CLOSED** |
| **CFG-3** | **CLOSED** |
| **CFG-4** | **CLOSED** (contract evidence-backed) |

### CONFIGURATION / POLICY AUTHORITY: **CONDITIONAL GO**

Every defect is closed with exploit reproduction → minimal fix → failing-first regression tests →
mutation proof → live HTTP proof → financial-integrity proof → frozen-subsystem regression → full
serial gates.

**Not FROZEN**, because freezing requires more than green tests: risk **K1** (pre-existing malformed
fee rows are not remediated) and **K2** (CFG-1 authorization re-entry) are *data* states this code
change cannot resolve, and both affect money. Freeze is appropriate once a `branch_academic_profiles`
data audit is completed and the exception re-authorization decision is made.
