# Legacy Data-State Closure — Configuration / Policy Authority

**Date:** 2026-08-19 · **Branch:** `arena/01a0151e-toefl-house` · **Commit:** `840ae30`
(prior: `c28c3b8`, `abd3d09`, `4aa73a5`, `b42271e`)

Closes the two data-state risks that held the subsystem at CONDITIONAL GO.

---

## 0. Scope limitation — stated first

**No production database exists in this environment.** An exhaustive search found no
`erp.sqlite` outside `/tmp` test scaffolds, `server/data/` contains no database, and no data
file is tracked in git. A *live* inventory of real rows was therefore **impossible**.

Rather than report "cannot run", the audit was built as a **read-only tool** and validated
against a seeded database containing deliberately planted corruption. It must be run against
each real deployment to produce the actual inventory:

```
npm run audit:legacy-config -- --db /path/to/erp.sqlite
```

Exit `0` = clean · `1` = malformed legacy state found · `2` = database unreadable.

## 1. Legacy fee inventory

The tool reports `branch_id → field → raw value → storage type → resolved value → classification`,
reusing the **real** `assertMoney` and `resolveFee` (not a reimplementation that could drift).

Validated against planted corruption — all four detected:

| branch | field | raw | storage | resolved (after fix) | classification |
|---|---|---|---|---|---|
| LA | `placement_test_fee` | `-100` | real | **300** | MALFORMED — negative |
| LA | `registration_fee` | `0.001` | real | **0** | MALFORMED — sub-cent, would round to a different fee |
| LA | `card_fee` | `abc` | **text** | **200** | MALFORMED — non-finite + storage anomaly |
| LA | `diploma_fee` | `1e20` | real | **500** | MALFORMED — beyond monetary precision |

Clean database → **0 findings, exit 0** (no false positives).

### A HIGH-risk unbounded money path was found and fixed

`resolveFee()` only checked `Number.isFinite`, so legacy rows were still returned as
authoritative money:

| stored | resolveFee returned | Finance verdict |
|---|---|---|
| `-100` | `-100` | rejected **late** (HTTP 500) |
| `1e20` | `1e20` | rejected **late** (HTTP 500) |
| **`0.001`** | **`0.001`** | **ACCEPTED — silently, no error** |

The `0.001` case had **no boundary at all**. Reading a fee is the last step before the money
writers, so an unusable stored value now falls back to the documented system default. Failing
to a known default is visible and safe; charging a corrupt amount is neither.

## 2. Legacy discount inventory

Classified A/B/C/D against live authorizations, category maxima, expiry, branch scope and
historical transactions. Validated on seeded data:

| student | stored | authorization | max | history | class | new charge |
|---|---|---|---|---|---|---|
| LG-001 | 100% | none | 20% | none | **B · unauthorized** | **20%** |
| LG-002 | 50% | SECOND_DEGREE_RELATIVE | 50% | none | **A · valid** | **50%** |
| LG-003 | 100% | SECOND_DEGREE_RELATIVE | 50% | none | **C · ambiguous** | **50%** (clamped) |
| LG-004 | 35% | none | 20% | 1 invoice | **D · historical** | **20%** |
| LG-005 | 15% | — | — | — | below ceiling, not reported | 15% |

## 3. Affected records / classifications

Against the validation fixture: **4 malformed fee values** across 1 of 2 branches, and
**4 students** over the ceiling — one per class (A=1, B=1, C=1, D=1). Real counts require
running the tool per deployment.

## 4. Historical-money verification

Historical invoice for LG-004 (`total 10000 / discount 3500 / net 6500`) is **byte-identical**
before and after discount resolution. Reading a malformed configuration row leaves it
**unchanged**. Only future pricing is affected.

## 5. Migration performed? — **NO, deliberately**

No migration was written, because **no deterministic repair rule exists**. Nobody can know
whether `-100` meant `100`, `0`, or a typo; whether `0.001` meant `0.01` or `1`. Inventing one
would fabricate money. Per instruction, malformed rows are **preserved for correction at source**
and reported by the audit tool. The read guard bounds the damage in the meantime.

**No authorization records were auto-created.** A stored discount >20% is never converted into
an authorization merely because the old value existed — eligibility and approval cannot be
inferred from a bare number.

## 6. Remaining business decisions

1. **Correct each malformed fee row** at source (audit output gives branch + field + raw value).
   Until then the affected branch charges the *system default*, which may differ from intent.
2. **Class C students** — decide whether to raise the authorization to the stored figure or
   accept the category maximum. Currently clamped to the category max (safe).
3. **Class B/D students** — decide whether each warrants a real authorization; otherwise they
   correctly settle at 20%.

These are **pricing decisions, not open vulnerabilities**: every path is fail-closed and bounded.

## 7. Gates

| gate | result |
|---|---|
| Focused legacy suite | **7/7** (4 failed before the guard) |
| Full serial suite | **1773/1773** (128 files) |
| `tsc --noEmit` | clean |
| `eslint src scripts` | **0 errors** |
| Fresh-schema preflight | 75 migrations, no drift |
| Financial reconciliation | amount/cash/saving/budget all 0 |
| CFG-1 mutation harness | 14/14 killed |
| CFG-2/3/4 mutation harness | 10/11 killed, 1 proven equivalent |
| **`release-validate.mjs`** | **16 passed · 0 failed** |

One release-validation failure was caught and fixed en route: `npm run lint` covers
`src scripts`, which a bare `eslint .` does not — a lint error in the new audit script blocked
the release until corrected.

## 8. Final certification

| ID | Status |
|---|---|
| CFG-1 | CLOSED |
| CFG-2 | CLOSED |
| CFG-3 | CLOSED |
| CFG-4 | CLOSED |
| Legacy fee data | **BOUNDED** (read guard + audit tool; rows preserved) |
| Legacy discount data | **BOUNDED** (fail-closed; audit tool classifies) |

### CONFIGURATION / POLICY AUTHORITY: **FROZEN**

Both data-state risks are now **explicitly bounded with no unresolved High-risk money path**:

- The one genuinely unbounded path (`0.001 → Finance accepts silently`) was found and closed.
- Every remaining legacy value resolves to a safe, chargeable default.
- Unauthorized legacy discounts fail closed to 20%; authorized ones are preserved at their
  category maximum.
- Historical money is provably immutable.
- Outstanding items are **pricing decisions with a tool to enumerate them**, not vulnerabilities.

**Freeze conditions:** any change to `discount-authority.ts`, `policy-resolver.ts`, the
branch-profile write path, or the category maxima re-opens this certification. Run
`npm run audit:legacy-config` against each deployment before rollout and action its output.
