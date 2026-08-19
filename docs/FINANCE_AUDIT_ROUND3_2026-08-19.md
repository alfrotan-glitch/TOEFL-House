# Finance Subsystem — Round 3 Convergence Audit

**Date:** 2026-08-19
**Branch:** `arena/01a0151e-toefl-house`
**Baseline commit:** `f3ffcf9` (round-2 head)
**Final commit:** `a6a8d44` (pushed; local == remote)
**Verdict:** **FREEZE** — see §10 for the exact scope and the caveats attached to it.

---

## 1. Mandate and posture

Round 3 was asked to treat the round-1 and round-2 reports as *evidence, not
truth*, and to explicitly challenge the assumption that round 2's coverage was
sufficient. That challenge was warranted: **round 2 was not sufficient.**

Rounds 1 and 2 fixed a `Number()`-coercion defect class on the two *expense*
writers (`/finance/operational-payments`, `/finance/expense-requests`). Neither
round asked whether the *income and refund* writers shared it. They did — at
four more sites, three of them moving real cash on every hostile input.

The audit baseline was established before any code was modified: `1602/1602`
tests, 0 lint errors, 74 migrations with no drift.

---

## 2. Findings

### CRITICAL — F-5: unparsed amounts at four income/refund money writers · **PROVEN · CLOSED**

`Number()` is a coercion, not a parse. Every site below accepted values that
are not amounts and turned them into real, plausible-looking money.

Reproduced live on a fresh database before fixing, with a fresh fixture row per
case, asserting **the stored row and the cash position** — not just the HTTP
status (round 2's lesson: a 4xx does not mean nothing was written).

| input | `POST /invoices/:id/pay` | `POST /students/:id/payments` | `POST /students/:id/refund` |
|---|---|---|---|
| `true` | 201, stores **1**, cash +0.95 | 201, stores **1**, cash +0.95 | 201, stores **−1**, cash −1.00 |
| `[500]` | 201, stores **500**, +475.00 | 201, stores **500**, +475.00 | 201, stores **−500**, −500.00 |
| `'0x10'` | 201, stores **16**, +15.20 | 201, stores **16**, +15.20 | 201, stores **−16**, −16.00 |
| `[[7]]` | 201, stores **7**, +6.65 | 201, stores **7**, +6.65 | 201, stores **−7**, −7.00 |
| `0.001` | 500, leaks the two-decimal DB trigger | same leak | same leak |
| `1e15`, `'abc'`, `''`, `{}`, `-100` | 400, 0 rows | 400, 0 rows | 400, 0 rows |

All values persisted with storage class `real` — indistinguishable from a
legitimate charge on inspection. The refund row is the most severe: money moves
**out** of the branch on a malformed request.

A fourth site, `POST /funding/donations`, had the same root cause with a
materially different outcome:

| input | result |
|---|---|
| `true`, `[[7]]` | 500 `SQLite3 can only bind numbers, strings, bigints, buffers, and null` |
| `{a:1}` | 500 `Too few parameter values were provided` |
| `0.001` | 500 leaking the raw trigger text |

Here the downstream authorities (`recordIncome` → `assertMoney`, and the
database triggers) caught everything: **no cash moved, and the transaction
rolled back cleanly** — donations, `funding_campaigns.raised_amount` and
`financial_transactions` all verified still at 0. This one is a **contract
defect, not a cash defect**: client mistakes were reported as server faults with
driver internals leaked to the caller. It is recorded at its true severity
rather than inflated to match the other three.

**Fix.** All four now parse with `assertMoney`, the boundary the rest of the
money surface already uses — no new mechanism, no shadow writer. Each endpoint
keeps its own error message and its own range rule, applied to the *parsed*
value. Any amount ≥ 0.01 behaves exactly as before, and `null` still means
"amount not supplied" where callers rely on the endpoint to derive the charge.

### HIGH — F-6: idempotency fingerprints built from raw input · **PROVEN · CLOSED**

Surfaced while fixing F-5, and initially missed by my own regression suite —
mutation testing is what exposed it.

`/students/:id/payments` parsed the amount **twice**, with independent
`Number()` calls: once for the idempotency fingerprint, once for validation.
Those two parses could disagree, so the fingerprint could describe a charge that
was never stored.

The consequence is a **double charge**, proven by mutation: `100.005` and
`100.01` both persist as `100.01` — the identical charge — but a fingerprint
built from the raw value sees two different requests and accepts the retry.
Restoring the raw fingerprint produces **two rows of 100.01**; the parsed
fingerprint produces one row plus a replay. The same shape existed on the
donation desk.

**Fix.** Parse once, early, before the fingerprint is derived; the fingerprint,
the validation and the stored amount now all read the same variable.

### FALSE POSITIVE — refund/void asymmetry · **REJECTED (verified)**

Pay 1000 then refund 1000 leaves branch cash at exactly `55000.00 → 56000.00 →
55000.00`. Only the main/saving split shifts (−50/+50), which is `recordIncome`'s
documented savings-reclaim. Total conserved to the cent. *A split is not a loss —
check the total before calling it asymmetry.*

### FALSE POSITIVE — `discount_percent > 100` · **REJECTED (verified)**

`POST /students/manual` accepts and stores discounts of 150, 500, even 1e9 (the
guard is `< 0` only). This looks alarming but **cannot invert a fee**: both
consumers clamp with `Math.max(0, …)`, so `netTuition` floors at 0. Probed at
500 / 100 / 25 percent against a 10,000 tuition: enrolment succeeded, ledger
delta 0.00, and **zero negative ledger rows**. Financially identical to a 100%
discount. Whether an operator *should* be able to type 500% is a data-hygiene
and business-policy question, not a technical money defect — and inventing that
policy is out of scope.

### Sites triaged and cleared

`students.routes.ts:675` (discount, above), `visitors.routes.ts:732/740`
(clamped `Math.max(0, Math.min(100, …))`, and the tuition itself already goes
through `assertMoney`), `finance.routes.ts` and `exams.routes.ts` (raw
`Number()` occurrences are in comments, not code), `books.routes.ts` (6×
`assertMoney`, 0 raw), `bos.routes.ts` (0 raw).

---

## 3. Production-data corruption status

**Cannot be re-verified in this workspace — reported as unknown rather than
clean.** The round-2 check ran against `server/data/erp.sqlite`; that file is
gitignored and was lost when the sandbox was re-cloned mid-session. It is not
present now.

What is known: round 2's scan of that database found **0 corruption** across all
detectors. Round 3 found no *new* defect that writes silently — the F-5 writers
produce rows that are visibly wrong (a 1 AFN payment where 1000 was intended),
not subtly wrong.

**Recommended before deploy** (read-only, no migration proposed):

```sql
SELECT COUNT(*) FROM payments   WHERE typeof(amount) NOT IN ('real','integer');
SELECT COUNT(*) FROM payments   WHERE ROUND(amount,2) <> amount OR amount = 0;
SELECT COUNT(*) FROM donations  WHERE typeof(amount) NOT IN ('real','integer');
SELECT COUNT(*) FROM financial_transactions WHERE ROUND(amount,2) <> amount;
SELECT COUNT(*) FROM funding_campaigns fc
 WHERE ROUND(fc.raised_amount,2) <>
       ROUND((SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = fc.id),2);
```

**No repair migration is proposed.** Per the standing constraint, historical data
is not repaired unless corruption is empirically found *and* a repair rule is
provable. Neither condition is currently met.

---

## 4. Tests

`server/src/tests/finance-money-writer-parity.test.ts` — **52 tests**, all green.

Coercion sweeps at all four writers; legitimate-flow controls (`2500`,
`'3000.50'`, `1000` still succeed); fingerprint/stored-amount agreement;
zero-value charge rejection; the derive-own-fee contract; the refundable-balance
cap; cash conservation across pay/refund; and payment↔ledger reconciliation.

No existing test was weakened.

---

## 5. Mutation testing

`server/scripts/finance-money-writer-mutation-test.mjs` — **11/11 KILLED, 2
PROVEN EQUIVALENT, 0 SURVIVORS.**

The first run killed only 5/8. Rather than accept that, each survivor was
diagnosed empirically:

- **M6, M8** were real coverage gaps. My tests were asserting the right
  behaviour through the wrong door (`issue-card` is a different endpoint; a
  same-value retry cannot discriminate a fingerprint). Replaced with the actual
  discriminating cases — this is how the F-6 double-charge was proven.
- **M7** is genuinely equivalent: deleting the early `> 0` guard leaves
  behaviour byte-identical because `resolvedAmount <= 0` at
  `students.routes.ts:1034` rejects the same requests downstream. Verified by
  live probe (`0`, `'0'`, `0.001` → same 400, same message, 0 rows).
- **M12** is genuinely equivalent: `recordIncome` re-parses its own input
  through the same `assertMoney` (`utils/income.ts:54`), so the ledger lands on
  the identical rounded value either way. Verified across `100.005`, `0.005`,
  `'3000.50'`, `2500` — donation row and ledger row agreed on every input.

Both equivalences were **proven by execution, not asserted from inspection**.
No guard was removed and no test was weakened to make a mutant die.

---

## 6. Gates (all at `a6a8d44`)

| Gate | Result |
|---|---|
| Server test suite | **1654 / 1654** passed (1602 baseline + 52 new; 121 files) |
| Mutation (this round) | **11/11 killed**, 2 proven equivalent |
| Mutation (rounds 1–2, unchanged) | 15/15 killed |
| Server lint | **0 errors** (108 warnings, pre-existing) |
| Server typecheck | clean |
| Frontend build | clean |
| Fresh-schema drift | **74 migrations, no drift** |
| Release validation | **16 passed · 0 failed** |

---

## 7. Fresh-DB real-HTTP adversarial reconciliation

Live server, disposable database, real HTTP, real login — not in-process.

30 hostile requests (10 payloads × student-payment / refund / donation):
**0 violations** — no 5xx, no driver or trigger text leaked, no cash movement.
Legitimate control flows still succeed (payment 201, donation 201).

`GET /finance/reconciliation`:

```json
{"paymentBackedTotal":1200,"ledgerBackedTotal":1200,"amountVariance":0,
 "unmatchedPayments":0,"orphanLedgerRows":0,"mismatchedPayments":[],
 "cashVariance":0,"savingVariance":0,"budgetVariance":0,"healthy":true}
```

---

## 8. Remaining unverified risks

Stated plainly rather than folded into a PASS:

1. **Production-data status is unknown in this workspace** (§3). The queries are
   provided; they should be run against the real database before deploy.
2. **Concurrency remains structurally untestable here.** `better-sqlite3` is
   synchronous, so HTTP-level parallelism cannot interleave inside a handler.
   Multi-process contention is therefore unproven — not proven safe.
3. **Overpayment beyond an invoice balance is still untested.** The idempotency
   layer collapses the identical retry, so the probe never reached the balance
   rule. This is a coverage gap, not a known defect.
4. **Reporting endpoints were not exhaustively re-derived** against authoritative
   state this round; rounds 1–2 covered the dashboard and period totals.
5. **Business-policy questions remain open and were deliberately not invented**:
   global-owner cross-branch spending, operational-payment idempotency semantics
   (3 sequential + 5 parallel identical = 2250 debited), the salary cap, and
   whether a >100% discount should be typeable at all.

---

## 9. On the audit method itself

Two near-misses are worth recording, because both would have produced a
confident and wrong "clean" verdict:

- A uniform wall of 400s is usually the **wrong payload, not a working guard.**
  My first student-endpoint probe sent `reason` where the handler reads `notes`,
  producing a clean-looking 10/10 rejection sweep. I nearly recorded "the
  student endpoints are safe." They were fully exploitable. Every probe now
  carries a valid-input control case in the same run.
- **Mutation testing caught what my own regression suite missed.** The F-6
  double-charge was not in my suite; three surviving mutants forced me to look
  again. A green suite is not evidence of coverage.

---

## 10. Verdict

# FREEZE

Finance is recommended for freeze at commit **`a6a8d44`**, with the scope stated
honestly:

**What is proven.** The money-writer surface — the endpoints that create,
modify, refund or report cash — now parses every amount at a single authority.
Four proven defects across two findings are closed, each reproduced live before
the fix and re-verified after. 1654 tests, 26 finance mutants killed across
three rounds with every survivor either killed or *proven* equivalent by
execution, and a fresh-DB real-HTTP adversarial run that reconciles with zero
variance.

**Why freeze is now justified where round 2 said no.** Round 2 declined to
freeze because the income and refund writers had never been examined. They have
now been mapped, attacked and closed, and the remaining raw-`Number()` sites
have each been triaged to a cleared or non-material conclusion. The defect class
that produced F-1 through F-6 has no remaining unexamined instance on the money
surface.

**What this freeze does not claim.** It does not claim the production database
is clean — that check could not be run here (§3) and should be run before
deploy. It does not claim concurrency safety under multi-process contention,
which is not testable in this environment. It does not resolve the open business
questions in §8.5, which are decisions for the business, not defects for me to
invent answers to.

If the §3 queries return anything non-zero, the freeze should be reopened.
