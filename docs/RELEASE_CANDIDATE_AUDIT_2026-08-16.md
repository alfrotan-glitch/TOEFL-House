# Release-candidate audit — pass 4 (final)

Fourth independent pass. The sandbox had been reset, so this pass began from a
**completely fresh environment**: dependencies reinstalled, `better-sqlite3`
rebuilt, a brand-new database created by running all 65 migrations, and the
owner account created through the real production bootstrap. Nothing was
inherited from earlier passes except the committed source.

That turned out to matter — two of the three defects below are only reachable
on a realistic database, and a fresh one made them obvious.

---

## F-9 — a full refund of a fully-paid amount was impossible (HIGH, fixed)

A student pays 200 AFN. `recordIncome()` credits 200 to branch cash, then
immediately sweeps `daily_saving_percent` (5%) into savings, leaving main at
190. Refunding that same 200 then failed:

```
POST /api/students/:id/refund { amount: 200 }
  -> 500 "Insufficient branch operating cash for this reversal/refund."
```

The institute could not return money a customer had actually paid. The funds
were not missing — they were in the savings account, one row away — but the
reversal only ever debited main. **Every payment was silently partially
unrefundable, by exactly the savings percentage, permanently.**

Two defects, one symptom:

1. The reversal ignored the savings half of its own income path. Positive
   income touches two accounts; negative income touched one.
2. It threw a plain `Error`, so a business condition surfaced as HTTP **500**.
   `money.ts` carries a comment about this exact mistake being fixed there
   once before — the same trap, a second time.

**Fix.** A negative `recordIncome()` takes what main can cover and reclaims the
remainder from savings, writing a compensating negative `saving_transfer` row
so the ledger still explains both balances. Genuine shortfalls return **409**
with available/required amounts. Added
`decrementSavingBalanceIfSufficient()` — one conditional UPDATE, mirroring the
existing main-balance primitive.

## F-10 — book-sale refunds created phantom cash (CRITICAL, fixed)

`POST /api/books/sales/:saleId/refund` wrote its contra-revenue row **straight
into `financial_transactions`** with a hand-rolled INSERT. The sale credits
cash through `recordIncome()`; the refund never debited it.

Measured on a clean database — one 500 AFN sale, then its refund:

```
ledger says            -500
finance_accounts says  +500 still held
divergence              500 AFN, per refund, accumulating forever
```

That is money that exists in one source of truth and not the other — precisely
the duplicate business truth this system forbids — and it silently inflated
every cash-position figure the branch reported.

**The asymmetry was the defect:** one direction of a single business
transaction used the shared money path, the other hand-rolled SQL. The INSERT
looks perfectly correct in review, because the bug is in what it *omits*.

**Fix.** The refund now calls `recordIncome()` with a negative amount, exactly
mirroring the sale, and therefore also inherits the F-9 savings reclaim.
Verified clean: sale 500 → main 475 / saving 25; refund → main 0 / saving 0.

## The detection gap behind F-10 (closed)

`GET /finance/reconciliation` compared payment rows against their ledger rows.
Both live in the same table family, so the check was **structurally incapable**
of seeing a path that updates the ledger but not cash. It reported `healthy`
throughout.

Added cash-position reconciliation, per branch:

```
main_balance   = SUM(operating income) - SUM(saving_transfer)
saving_balance = SUM(saving_transfer)
```

surfaced as `cashVariance` / `savingVariance` and folded into `healthy`.

**Self-correction worth recording.** My first formula was
`income - expense - saving` and reported a **false −69,500 AFN variance** on a
healthy branch. It did not match the money model: `capital_injection` credits
the *organization* treasury, `budget_charge` debits it into a budget line, and
`expense` rows are paid *from* budget lines — none touch branch cash. Caught by
running a complete business workflow, not by a unit test. A reconciliation that
cries wolf is worse than none, so the test suite now asserts the negative case
too.

## False-confidence tests removed

Three tests in `financial-integrity.test.ts` proved nothing:

```js
expect(true).toBe(true);                                  // "Verified by code review"
// wrote status='cancelled' with UPDATE, then asserted it was 'cancelled'
expect(['issued','partial','overdue'].includes('draft')).toBe(false);
```

The first is a tautology, the second tests that SQLite's `UPDATE` works, the
third asserts a fact about an array literal written inside the test. None touch
the invoice router — every guard they claimed to cover could be deleted and all
three would still pass, while their names appeared in the suite as evidence.

Replaced with four tests issuing real requests through the real router, then
asserting on the database. Mutation-verified: deleting the cancel guards fails
2; allowing payment on any status fails 2. The originals would have caught
neither.

## Backup/restore — proven, and documented

`migrate.ts` wrote `VACUUM INTO` snapshots, but nothing ever restored one and no
procedure existed. An untested backup is a recovery *risk*, not a plan.

`backup-restore.test.ts` performs a real cycle: snapshot → destroy → restore →
verify counts, sums, `integrity_check`, `foreign_key_check`. It also pins that
the snapshot is self-contained (no WAL sibling) and that `VACUUM INTO` **cannot
run inside a transaction** — the property that guarantees a snapshot never
captures a half-finished write.

`docs/OPERATIONS.md` is the new runbook: fresh install, required environment,
migrations, scheduled backups, restore, health verification, known limits.

---

## Verification

| Gate | Result |
|---|---|
| Full test suite | **791 / 792** (1 intentional — missing logo asset) |
| Root typecheck | PASS |
| Root lint (frontend) | PASS |
| Server lint (eslint + tsc) | PASS, **0 errors** |
| Frontend production build | PASS |
| Server production build | PASS |
| Fresh-schema preflight | PASS |
| Static audit | PASS |
| Fresh DB install | 65 migrations, 106 tables, `integrity_check ok`, 0 FK violations |
| Migration convergence | fresh vs migrated: **355 objects, identical DDL, 0 differences** |
| Financial reconciliation | amount 0, **cash 0**, **saving 0**, healthy |
| Backup → destroy → restore | byte-for-byte recovery verified |
| Branch/campus isolation | **0 leaks**; foreign GET/POST 403; foreign reconciliation scope-forced |
| Working tree | clean |

**Adversarial re-audit after remediation** — unauthenticated access to five
sensitive endpoints all 401; `alg=none` forgery rejected; tampered signature
rejected; mass assignment of `id`/`status`/`studentCode`/`branchId`/`date`/
`receiptNumber` all ignored (server-generated); payment amount validation
rejects negative, zero, NaN, string, over-configured-fee; SQL injection shows
no row amplification and tables intact.

**Concurrency** — 8 parallel refunds of a 200 AFN payment: money invariant held
(`refunded <= paid`). 6 parallel visitor conversions: 1 success, 5×409, one
payment and one agreeing ledger row. 6 parallel exam enrollments: 1 success,
5×409, exactly one fee. Three identical `pay-salary` calls: **one** ledger row,
30,000 against a 30,000 salary — idempotent replays, not double payments.

**Mutation testing** (M15–M19), all caught:

| # | Mutation | Result |
|---|---|---|
| M15 | revert reversal to main-only debit | 4 fail |
| M16 | reclaim savings without the compensating ledger row | 2 fail |
| M17 | restore the hand-rolled contra INSERT | 1 fail (structural guard) |
| M18 | delete paid/has-payments cancel guards | 2 fail |
| M19 | allow payment on any invoice status | 2 fail |

---

## Simplification

Measured, not asserted:

- **Unused dependencies: 0** (checked every entry in both `package.json` files
  against real imports).
- **Unreferenced tables: 0** — all 106 tables are used by production code.
- **Dead exports: 0 remaining** (nine were removed in pass 2, including
  `setMainBalance`, which overwrote a finance balance outside the ledger).
- Four near-identical `class_teacher_skills` listing statements collapsed to one
  scope-aware query (pass 3).
- Three false-confidence tests deleted; four real ones added. Net +1 test, but a
  real increase in proven invariants — not test-count growth.

Production LOC grew by roughly the size of the two money fixes and the cash
reconciliation. No new middleware, abstraction layer, or compatibility shim was
introduced in this pass; each fix routes through an existing choke point
(`recordIncome`, `computeReconciliation`).

**Not simplified, deliberately:** `src/types.ts` (1,431 lines),
`src/apiStore.ts` (1,383), `classes.routes.ts` (1,316). Splitting them under
audit pressure would be churn without a defect to justify it. Recorded as a
maintainability risk.

---

## Blockers

### 1. Official logo asset — still absent

`public/brand/toefl-house-logo.png` does not exist. The PNG has now failed to
reach the workspace on **three** separate attempts (`/home/user/uploads/` is
never created; the only PNGs on the machine are OS-supplied).

The branding system is complete and wired to that single path. Verified
end-to-end during this audit with a temporary throwaway file: with an asset
present the branding suite passes **6/6** and the build copies it into
`dist/brand/`. The throwaway was **deleted, not committed** — recreating or
approximating the logo is forbidden, and a placeholder that merely turns the
suite green would hide the gap rather than close it.

**One step remains:** copy the official PNG to
`public/brand/toefl-house-logo.png`. No code change is required.

### 2. CI is inert

Activation was attempted, not assumed:

```
! [remote rejected] arena/01a0062e-toefl-house
  (refusing to allow a GitHub App to create or update workflow
   `.github/workflows/ci.yml` without `workflows` permission)
```

A human with the `workflows` permission must copy `ci/github-actions-ci.yml` to
`.github/workflows/ci.yml`. **Every gate result in this document was produced by
running the commands manually.**

---

## Remaining risks

- Owner role carries all permission codes regardless of scope; scope governs
  rows, not endpoints. Deliberate, documented (pass 2).
- Employee pay-salary duplicate guard is free-text `LIKE` matching, bypassable
  via `paymentType:'advance'` or a varied `monthName`. Low severity, open.
- `bos`, `exams`, `finance`, `placement-attempt`, `visitors` write money without
  the shared `resolveIdempotency`. Probed under concurrency and correct today
  via business-event guards plus DB constraints, but they rely on SQLite's
  synchronous driver rather than a shared mechanism.
- Books/funding list endpoints are unbounded — correct now, a scale risk later.
- Single-process SQLite ceiling; no horizontal scaling story.
- Automatic backups sit on the same disk as the database.
- Three oversized modules; 576 `any` in server source; no frontend test runner.

---

## Verdict

**No known CRITICAL or HIGH defects remain.** Every defect found across four
passes is fixed, mutation-verified, and covered by a regression test that fails
when the fix is reverted.

**Production readiness is blocked on two items, neither of which is a code
defect:** the official logo asset, and CI activation.

The honest four-pass summary: **each pass found real HIGH or CRITICAL issues the
previous one missed, and the test suite was green throughout every one of
them.** Pass 2 found a scoped owner acting globally and a teacher rewriting
colleagues' grades. Pass 3 found authorization keyed to the wrong branch field
and a financial total summed from one page. Pass 4 found refunds that could not
return a customer's own money and book refunds minting phantom cash.

Two things in this pass are worth carrying forward more than the fixes:

- The reconciliation that reported `healthy` while 500 AFN of phantom cash
  accumulated. A health check that cannot see a whole class of failure is worse
  than no health check, because it is trusted.
- My own first cash formula, which cried wolf at −69,500 AFN, and my own test
  that broke the lint gate after I had already run it. Both were caught by
  re-running the gates rather than trusting the earlier green — which is the
  only reason this report can claim what it claims.

Treat any unaudited surface as unproven rather than safe.
