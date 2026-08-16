# Remediation Report — TOEFL House ERP

**Date:** 2026-08-16
**Baseline:** `af1eccb` (state at the adversarial audit)
**Head:** `3414587`
**Scope:** every verified finding in `ADVERSARIAL_AUDIT_2026-08-16.md`, plus one
new defect found while attacking the fixes.

Every claim below is backed by a command that was run. Where a fix could not be
completed, it is stated as a blocker rather than reported as done.

---

## 1. Problems found, root causes, and what changed

### C-1 CRITICAL — concurrent tuition payments fabricated revenue

**Evidence (before):** 12 concurrent identical un-keyed `fee` requests produced
12 payments and 12 income rows — 12,000 AFN from one 1,000 AFN intent, each
with its own receipt number.

**Root cause — not what the comments claimed.** The route persisted
`idempotency_key = NULL` for the "guarded" categories
(`fee/installment/book/card/diploma/placement`):

```ts
stmtInsertPayment.run(..., replayEligible ? (idempotencyKey || null) : null);
```

SQLite treats every NULL as **distinct** in a UNIQUE index, so
`uq_payments_idempotency` — documented in the route as the *"atomic backstop…
only one can win the unique index"* — **could never fire for exactly the
categories it was meant to protect.** The only surviving defence was a
read-then-write balance check that every concurrent request passes at once.

**Fix.** The key is now *always* persisted. Skipping the **pre-check** for
guarded categories is retained deliberately — it preserves precise errors like
*"This semester is already fully paid"* instead of replaying a stale success.
Skipping the **stored key** was the bug. The distinction matters: the pre-check
is a UX affordance, the stored key is the concurrency control.

**Made a database invariant.** Migration `063` rejects NULL/blank keys by
trigger and backfills historical rows with a deterministic legacy key. This is
not belt-and-braces: the constraint immediately surfaced **three further
un-keyed production writers** that code review had missed —
manual registration, `enroll-semester`, and ID-card issuance — plus
visitor conversion, which had no key column at all. All now key on their
natural business identity (`register:<id>`, `enroll-semester:<id>:<name>`,
`card-fee:<id>`, `visitor-convert:<id>`).

**Evidence (after):**
```
category='other' 10 concurrent → 1 payment,  1,000 AFN   PROTECTED
category='fee'   10 concurrent → 1 payment,  1,000 AFN   PROTECTED
```

### C-2 HIGH (found while attacking the fix) — cross-student replay swallowed money

The replay lookup matched on `idempotency_key` alone. A client key is
caller-controlled, so reusing one across two students returned the **first**
student's receipt for the **second** student's genuine payment: HTTP 200,
someone else's receipt number, money never booked.

Pre-existing (identical at `24584f5`) — but the C-1 fix made it reachable on
many more paths, so it is closed here. The lookup is now scoped to
`student_id`; a cross-student collision hits the unique index and returns an
actionable **409** instead of a silent success or a 500.

### H-1 HIGH — three disagreeing sources of financial truth

The same student showed a **20,000 AFN** different debt on the roster versus
the profile. `/payments/balances` summed only `status='active'` semesters;
the profile drawer and the student portal each recomputed tuition **in the
browser** over all semesters from the *paginated* payments array.

An authoritative server module already existed — it was simply bypassed. Now:
`getStudentBalancesPage()` added to `utils/studentBalance.ts`; the roster
endpoint delegates to it; `GET /students/:id` and `/students/me` carry
`balance.lifetime` / `balance.current`; the client-side `computeStudentBalance`
is **deleted**. Verified: 15/15 students consistent across every surface.

### H-2 HIGH — the test suite gave false assurance

`student-financial-idempotency.test.ts` existed to lock in duplicate-payment
protection, and passed — but every concurrency case used `category:'other'` or
`'exam'`, the categories production **exempts**. No test raced `'fee'`. 715
tests passed against a system that double-charged tuition 10×.

Added `guarded-category-concurrency.test.ts` (10 cases) racing the categories
that actually carry money.

### M-1 — login lockout hit whole offices

Keyed on IP alone at 10/15min; a branch shares one NAT IP, so ten wrong
passwords locked out every colleague (observed live: one probe locked out four
accounts). Now keyed **per account+IP**, with a wider whole-IP ceiling still
bounding a username-rotating sweep.

### M-2 — unknown filters silently returned everything

`?status=' OR '1'='1` returned 200 with the unfiltered page. Not injection
(parameters were bound) but callers could not distinguish *no matches* from
*filter discarded*. Now rejected with the permitted values.

### M-3 — forward-only migrations, no backup

61 migrations with no `down` and no backup mechanism anywhere. `runMigrations`
now writes a `VACUUM INTO` snapshot before the first pending migration —
transactionally consistent, unlike a file copy. Verified restorable
(`integrity_check: ok`, 0 FK violations, provably pre-migration content),
retention 10, skipped under `NODE_ENV=test`.

### M-4 — no CI

See **Blocker** below.

### Dead code removed

- `student_id_cards` — zero rows, zero readers, zero referencing keys; card
  state actually lives on `students.card_design`. Dropped via migration `064`
  and removed from `schema.sql`.
- Root `vitest.config.ts` — no vitest installed at root, no script referenced
  it, and it pointed at a `setupFiles` path that does not exist.
- `computeStudentBalance` — the competing client-side balance implementation.

---

## 2. Files and modules affected

**Backend**
`routes/students.routes.ts` · `routes/visitors.routes.ts` ·
`routes/auth.routes.ts` · `utils/studentBalance.ts` · `db/migrate.ts` ·
`db/schema.sql` · migrations `063`, `064`

**Frontend**
`types.ts` · `utils/studentBalance.ts` (reduced to a display helper) ·
`StudentsView.tsx` · `StudentProfileDrawer.tsx` · `StudentPortalView.tsx`

**Removed:** `vitest.config.ts`  **Added:** `ci/github-actions-ci.yml`, `ci/README.md`

---

## 3. Tests added and corrected

| File | Cases | Proves |
|---|---|---|
| `guarded-category-concurrency.test.ts` | 10 | guarded categories collapse duplicates; DB rejects NULL keys; debt ceiling holds; cross-student key refused; legitimate repeats still charge; precise errors preserved |
| `balance-single-source-of-truth.test.ts` | 7 | roster and profile agree after semester completion and after refunds; HTTP surfaces carry the figures; arithmetic invariants |
| `login-rate-limit-isolation.test.ts` | 3 | abused account locks; **colleague on the same IP still signs in**; lockout not bypassable with the correct password |

**17 fixtures corrected.** Test files inserted payments via raw SQL with no
idempotency key — they had been *relying on the hole*. They now satisfy the
same invariant production does.

**All fixes are mutation-verified** — reverting each one fails its test:

| Mutation | Result |
|---|---|
| restore `NULL` key write | 2 tests fail |
| reintroduce active/all scope divergence | 2 tests fail |
| drop `balance` from `GET /students/:id` | 2 tests fail |
| revert limiter to IP-only keying | colleague-lockout test fails |
| unscope the replay lookup | cross-student test fails |

**735 tests / 70 files** (was 715/67).

---

## 4. Verification results

| Check | Result |
|---|---|
| Full test suite | **735 passed / 70 files**, exit 0 |
| Frontend typecheck / lint / build | PASS |
| Backend typecheck / build | PASS |
| Static audit | PASS |
| Bundle budget | PASS — 482 KB first paint |
| Fresh-schema preflight | PASS — 63 migrations, no drift |
| DB integrity | `integrity_check: ok`, **0** FK violations |
| NULL idempotency keys | **0** |
| Ledger reconciliation | payments 700 == ledger 700 |
| Compiled `dist/` boot on clean DB | healthy; 63 migrations, 2 triggers, table absent |

**Concurrency battery** (10–12 threads each, live API):

| Operation | Result |
|---|---|
| enroll-semester ×10 | 1×201, 9×409 → 1 semester, 1 payment |
| fee payment ×12 | 1×201, 11×200 replay → 1 payment |
| refund ×10 | 1 refund |
| issue-card ×10 | 1 card fee |
| visitor convert ×10 | 1×201, 9×409 → 1 student |

**Security re-verification (no regressions):** cross-branch list leakage none;
IDOR across 8 mutating endpoints all 403 for registrar/finance/manager;
create-into-foreign-branch forgery 403; 12 privilege-escalation vectors blocked;
JWT `alg=none` / payload swap / branch swap / weak-secret forgery all rejected;
SQL injection across 5 payload families × 6 parameters — DB intact.

---

## 5. Blocker (not fixed — stated, not hidden)

**CI cannot be activated by this automation.** Pushing
`.github/workflows/ci.yml` is rejected:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/ci.yml` without `workflows` permission
```

The complete, YAML-validated pipeline is committed at
`ci/github-actions-ci.yml`. **A human must run one command:**

```bash
git mv ci/github-actions-ci.yml .github/workflows/ci.yml && git commit && git push
```

Until then the gate is manual — the exact condition that let a green suite
coexist with duplicate tuition charges.

---

## 6. Remaining risks

1. **CI inactive** until the manual move above. *Highest residual risk.*
2. **Single-process SQLite.** Fine for one institute (reads p50 7.4 ms @1 →
   58 ms @50 concurrent; writes 4.2 → 29 ms @30, zero errors) but a hard
   ceiling with no horizontal scaling story. Correctness does **not** depend on
   this — the guarantees are enforced by DB constraints, which hold under any
   concurrency the engine permits.
3. **69 of 106 tables remain empty.** Whole feature areas (placement bank,
   funding, impact, workflows, automations) have never run against real data.
   Not defects, but genuinely unexercised code.
4. **`authorize()` bypasses every role check for `owner`.** Intentional and
   documented, but no route can ever be withheld from the owner — so
   segregation-of-duties controls (maker/checker on refunds) are not currently
   expressible.
5. **576 `any` escapes** in server source, concentrated where request bodies
   enter. Not exploited in testing; a latent class of runtime surprise.
6. **No frontend test runner.** Frontend "tests" are string assertions executed
   from the server suite. The financial contract is now server-enforced, which
   reduces but does not eliminate the exposure.
7. **Backups are local.** `VACUUM INTO` writes beside the database, so it
   protects against a bad migration, **not** against disk loss. Off-host copying
   is still required.

---

## 7. Verdict

**The critical financial defect is closed, and the system is production-ready
for a single-institute deployment — conditional on activating CI.**

What changed materially: money can no longer be duplicated by a double-click,
a refresh, a retry, or two tabs, and that guarantee is enforced by the
**database**, not by application convention. The proof is that the new
constraint immediately caught three more un-keyed writers that code review had
missed — which is exactly the argument for putting invariants at the integrity
boundary rather than in a handler.

Financial truth now has **one** definition. Before, three implementations
disagreed by 20,000 AFN on an ordinary lifecycle event.

I would not have called the previous state production-ready, and I want to be
precise about why the new state is different: it is not that the tests pass —
they passed before, at 715 green, while tuition was being double-charged. It is
that the tests now **fail when the fixes are reverted**, each one verified by
deliberate mutation, and that the guarantees are enforced one layer below the
code that could regress them.

The honest caveat: item 1 is a real gap, not a formality. Until a human moves
the workflow file, nothing mechanically prevents this class of regression from
returning.
