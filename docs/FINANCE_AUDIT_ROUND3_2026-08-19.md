# Finance Subsystem — Round 3 Convergence Audit

**Date:** 2026-08-19
**Branch:** `arena/01a0151e-toefl-house`
**Baseline commit:** `f3ffcf9` (round-2 head)
**Final commit:** `a6a8d44` (pushed; local == remote)
**Verdict:** **FINANCE AUDIT — COMPLETE · FINANCE CODE FREEZE — APPROVED ·
PRODUCTION DATA VERIFICATION — NOT APPLICABLE (PRE-PRODUCTION)** — see §10.

> **Lifecycle status (2026-08-19, post-audit correction).** The system has not
> yet entered real production operation, so no real `erp.sqlite` containing live
> financial data exists. Production-data verification is therefore **NOT
> APPLICABLE** at this stage rather than outstanding, and production corruption
> is **NOT APPLICABLE** because there is no production dataset that could be
> corrupt. This was confirmed by an exhaustive filesystem scan (§3), not
> assumed. Code integrity and behavioural integrity are **VERIFIED** on their
> own evidence. The one future operational action is recorded in §3a; it is a
> go-live checklist item, **not an unresolved defect in this audit**.

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

## 3. Production-data status — **NOT APPLICABLE (pre-production)**

**There is no real production database to verify, because the system has not
yet entered production operation.** This section originally reported the status
as "unknown" on the assumption that a live database existed and had been lost to
a mid-session re-clone. That framing was wrong, and it is corrected here:
nothing has been lost, because no live financial dataset has ever existed.

Established by evidence, not assumption:

- `server/data/erp.sqlite` does not exist; `server/data/` contains only
  `placement-media/`.
- The path is gitignored (`.gitignore:8,22`) and was **never committed** —
  `git log --all -- **/erp.sqlite` returns nothing.
- An exhaustive scan opened **all 122 SQLite-format files** on the filesystem.
  Exactly 27 held any financial rows, and **all 27 are this repository's own
  test fixtures**: `/tmp/f10-*/db.sqlite` from
  `migration-067-f10-repair.test.ts:39` (`mkdtempSync(…'f10-')`, 2–3 rows with
  hardcoded ids `a1`/`tx_f10_1`, zero students, and a truncated schema whose
  `payments` table has no `student_id`), plus `/tmp/deployed-*` and
  `/tmp/sabotage-*` from `deployment-verifier.test.ts` (0 students, 0 payments,
  0 ledger rows) and empty `/tmp/backups/pre-migration-*` files.
- No dump, archive or `.bak` containing financial data exists anywhere.

Consequently:

| Item | Status |
|---|---|
| Production-data verification | **NOT APPLICABLE** — no real production financial data exists yet |
| Production corruption | **NOT APPLICABLE** — no production dataset exists to corrupt |
| Production-data repair migration | **NOT REQUIRED** — nothing to repair |

No synthetic production database was created and no test fixture was substituted
to manufacture a result. A verification that cannot be performed is reported as
not applicable, never as a pass.

## 3a. The one remaining operational action (go-live checklist, not a defect)

When the system first enters real production and begins accumulating real
financial data, run the **existing, unmodified** read-only detector against the
real `erp.sqlite` **before declaring the production-data baseline verified**:

```bash
cd server && node scripts/audit-financial-data.mjs /path/to/erp.sqlite
node scripts/verify-deployment.mjs /path/to/erp.sqlite
```

`audit-financial-data.mjs` only reads — it never writes, migrates or deletes —
and it exits `0` clean, `1` on suspect rows, `2` when the database is missing,
so it cannot silently report a pass against an absent file (verified by
execution). Copy the database read-only rather than pointing the application at
it; booting the app would apply migrations and mutate the very artifact being
audited.

Supplementary reconciliation queries for that first baseline:

```sql
SELECT COUNT(*) FROM payments   WHERE typeof(amount) NOT IN ('real','integer');
SELECT COUNT(*) FROM payments   WHERE ROUND(amount,2) <> amount OR amount = 0;
SELECT COUNT(*) FROM donations  WHERE typeof(amount) NOT IN ('real','integer');
SELECT COUNT(*) FROM financial_transactions WHERE ROUND(amount,2) <> amount;
SELECT COUNT(*) FROM funding_campaigns fc
 WHERE ROUND(fc.raised_amount,2) <>
       ROUND((SELECT COALESCE(SUM(amount),0) FROM donations WHERE campaign_id = fc.id),2);
```

**No repair migration is proposed or required.** Per the standing constraint,
historical data is not repaired unless corruption is empirically found *and* a
repair rule is provable. At this lifecycle stage neither condition can even
arise: there is no production dataset.

One note for whoever runs that first baseline: F-5 and F-6 were closed at
`a6a8d44`, before any production data existed. Any malformed row found later
therefore cannot have been produced by the defects this audit closed. The F-5
writers also failed *visibly* rather than subtly (a 1 AFN payment where 1,000
was intended), so a suspect row should be root-caused against its own timestamp
and code path rather than attributed to a defect that was fixed pre-launch.

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

## 8. Remaining risks — explicitly classified as unverified / non-defect

Stated plainly rather than folded into a PASS. **None of these is an open defect,
and none of them justifies a further audit round.** They are documented so they
are not rediscovered as "new findings" later.

1. **Production-data baseline — NOT APPLICABLE, deferred to go-live**
   (§3, §3a). Not a defect and not an unverified risk in the current state:
   there is no production dataset. The detector and the procedure are ready.
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

# FINANCE AUDIT — COMPLETE
# FINANCE CODE FREEZE — APPROVED
# PRODUCTION DATA VERIFICATION — NOT APPLICABLE (PRE-PRODUCTION)

Finance is frozen at commit **`a6a8d44`**. The audit is complete for the current
pre-production lifecycle stage.

| Dimension | Status | Basis |
|---|---|---|
| Finance code integrity | **VERIFIED** | F-3, F-4, F-5, F-6 closed; 1654/1654 tests; 11/11 mutants killed with 2 proven equivalent; lint, typecheck and build clean; 74 migrations, no drift; release validation 16/16 |
| Finance behavioural integrity | **VERIFIED** | Fresh-DB and real-HTTP adversarial testing: 30 hostile requests, **0 violations**; reconciliation healthy with **zero variances** |
| Production-data verification | **NOT APPLICABLE** | No real production financial data exists yet (§3) |
| Production corruption | **NOT APPLICABLE** | No production dataset exists to corrupt (§3) |
| Production-data repair migration | **NOT REQUIRED** | Nothing to repair |
| Finance audit | **COMPLETE** | For the current pre-production state |

**Defects closed across all three rounds.** F-1 and F-2 (branch misattribution
and amount coercion on `/operational-payments`), F-3 and F-4 (expense-request
coercion, branch misattribution, and a post-commit notification CHECK violation
on the reject path), F-5 (unparsed amounts at four income/refund money writers,
three of them moving real cash), and F-6 (idempotency fingerprints built from
raw input, causing double charges). Every one was reproduced live on a fresh
database before being fixed, and re-verified after.

**Why the freeze is justified now.** Round 2 declined to freeze because the
income and refund writers had never been examined. They have now been mapped,
attacked and closed, and every remaining raw-`Number()` site on the money
surface has been triaged to a cleared or non-material conclusion. The defect
class that produced F-1 through F-6 has no remaining unexamined instance. Two
candidate findings were rejected with evidence rather than reported as defects
(refund/void symmetry; `discount_percent > 100`), and two surviving mutants were
proven equivalent by execution rather than assumed.

**What this freeze does not claim.** It does not claim multi-process concurrency
safety, which is structurally untestable under synchronous `better-sqlite3`. It
does not resolve the open business-policy questions in §8.5, which are decisions
for the business rather than defects to invent answers to. Both are recorded in
§8 as unverified / non-defect risks, not as open findings.

**Scope closure.** No further Finance audit round is warranted. This audit is
closed unless new evidence or a new financial requirement appears. The single
future action — running the existing read-only detector against the real
`erp.sqlite` at go-live (§3a) — is an operational checklist item for the
production-data baseline, **not an unresolved defect in this audit**.
