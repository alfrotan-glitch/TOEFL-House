# Adversarial System Audit — TOEFL House ERP

**Date:** 2026-08-16
**Commit audited:** `af1eccb`
**Method:** live black-box attack against the running API (port 4000) + direct DB
inspection + source review. Two branches, eight users across four roles were
provisioned through the real API so isolation could actually be exercised.
All audit data was purged afterwards; `integrity_check = ok`, `foreign_key_check = 0`.

**Nothing in this document is taken from prior audit reports, test counts, or
code comments.** Every finding below was reproduced with an executable probe.
Where I initially misread the code, the empirical result is what is recorded.

---

## Verdict

**Not production-ready as a multi-tenant financial system of record.**
One CRITICAL defect fabricates revenue on the primary tuition path. The
surrounding engineering is genuinely strong — the failure is concentrated and
specific, not systemic rot.

| Dimension | Assessment |
|---|---|
| Authn / session handling | **Strong** |
| RBAC / privilege escalation | **Strong** |
| Branch isolation | **Strong** (API + DB triggers) |
| SQL injection | **Not exploitable** |
| DB-level integrity | **Strong** (46 triggers, FKs on, WAL) |
| **Financial correctness under concurrency** | **BROKEN — C-1** |
| Single source of financial truth | **Violated — H-1** |
| Test suite trustworthiness | **Weak where it matters most** |
| Scalability | **Bounded by design** (single-process SQLite) |
| Operational readiness | **Absent** (no CI, no backup, no container) |

---

## C-1 — CRITICAL: concurrent tuition payments fabricate revenue

**Fact — reproduced side by side, same attack, same run:**

```
category='other'  10 identical concurrent 1000 AFN requests, no key
  HTTP {201: 1, 200: 9}   payments: 1   ledger: 1 x 1000 AFN   PROTECTED

category='fee'    10 identical concurrent 1000 AFN requests, no key
  HTTP {201: 10}          payments: 10  ledger: 10 x 1000 AFN  DUPLICATED 10x
```

A 12-thread run produced **12 payments and 12 income rows (12,000 AFN) from a
single 1,000 AFN intent**, each with its own receipt number (`R-00000026`…`37`).

**Root cause** — `server/src/routes/students.routes.ts`:

```ts
const GUARDED_CATEGORIES = ['fee','installment','book','card','diploma','placement'];
const replayEligible = clientSuppliedKey || !GUARDED_CATEGORIES.includes(category);
...
stmtInsertPayment.run(..., replayEligible ? (idempotencyKey || null) : null);
```

For `fee` without an explicit client key, `replayEligible` is false, so the
idempotency column is written as **NULL**. SQLite treats every NULL as distinct,
so `uq_payments_idempotency` never fires. Verified directly: 12 rows, all
`idempotency_key = NULL`, in a table carrying a UNIQUE index on that column.

The code comments assert an *"Atomic backstop… only one can win the unique
index"*. **That backstop is unreachable for exactly the categories it is
documented to protect.** The design intent (surface a precise "already fully
paid" error rather than replay a stale success) is defensible; the
implementation trades away the only race-proof mechanism to achieve it, leaving
a read-then-write check (`semDebt <= 0`) that every concurrent request passes
simultaneously.

**Consequence:** overstated revenue, duplicate receipts issued to a paying
student, and a corrupted income ledger — on the single most-used money path in
the product. Reachable by a double-click, a refresh, a flaky-network retry, or
two open tabs. No attacker required.

**Blast radius is bounded** (an important qualification): the per-semester debt
cap still clamps the total. 10 concurrent 4,000 AFN payments against a 5,000 AFN
debt produced 2 payments totalling exactly 5,000 — no overpayment. The damage is
**duplicate charges and duplicate receipts within the debt ceiling**, not
unbounded theft.

**Aggravating factor — reconciliation cannot see it.** `/finance/reconciliation`
returned `healthy: true, amountVariance: 0` while all 12 duplicates were live.
It verifies payments↔ledger agreement, not business correctness, so it will
never flag this class of corruption.

---

## H-1 — HIGH: two disagreeing sources of financial truth

**Fact — same student, same moment, 20,000 AFN apart:**

```
SERVER  /payments/balances     tuitionDue = 30000   (WHERE status='active')
CLIENT  computeStudentBalance  tuitionDue = 50000   (scope 'all')
DIVERGENCE: 20000 AFN
```

Trigger: a student with two semesters, one moved to `completed` — an ordinary
lifecycle event, not an edge case.

- `StudentsView.tsx:106` (roster) renders the **server** figure.
- `StudentProfileDrawer.tsx:95` calls `computeStudentBalance(..., 'all')` — the
  **client** figure.

So the list and the profile show different debts for the same student. The
frontend independently reconstructs financial truth despite an authoritative
server endpoint existing. Root cause is an unreconciled scope contract
(`active` vs `all`), not arithmetic.

---

## H-2 — HIGH: the test suite gives false assurance on the defect it targets

`student-financial-idempotency.test.ts` exists specifically to lock in
duplicate-payment protection, and its header claims the fix. Its concurrency
tests use `category: 'other'` and `'exam'` — **the categories the production
code exempts from the guard.** No test anywhere races `category: 'fee'`.

715 tests across 67 files pass against a system that double-charges tuition
10×. This is worse than absent coverage: it produces documented, evidence-shaped
confidence in a protection that does not exist on the real path.

---

## M-1 — MEDIUM: login rate limiter is per-IP, locks out whole offices

`rateLimit({ windowMs: 15min, max: 10 })` keyed by IP. Every staff member at one
branch shares a NAT egress IP. Ten wrong passwords lock out **the entire
branch** for 15 minutes — a trivial internal DoS, and a likely support burden.
Observed live: my own probe locked out four accounts. Per-account or
account+IP keying is the usual shape. (`studentLoginLimiter` already
acknowledges this problem for students with `max: 60`, but staff were not given
the same treatment.)

## M-2 — MEDIUM: unvalidated enum filters silently return everything

`GET /students?status=' OR '1'='1` returns 200 with the full page. Not
injection — parameters are bound — but an unrecognised `status` is silently
ignored rather than rejected. Callers cannot distinguish "no matches" from
"filter discarded".

## M-3 — MEDIUM: no rollback path in 61 forward-only migrations

`schema_migrations` tracks 61 applied migrations; several contain `DROP` /
`ALTER TABLE … DROP`. There is no `down` step and no automated backup before
migration. A bad deploy against a live SQLite file is unrecoverable without an
out-of-band copy — and no backup mechanism exists anywhere in the codebase
(`VACUUM INTO`/backup grep: zero hits).

## M-4 — MEDIUM: operational immaturity

No `Dockerfile`, no CI workflow, no `.github/`. The full gate
(typecheck/lint/build/tests) is manual, so nothing prevents the C-1 class of
regression from reaching `main`. `NODE_ENV` governs several security behaviours
(bearer-token rejection, error masking, cookie `Secure`) with no automated check
that production actually sets it.

---

## Lower-severity / hygiene

- **L-1 Dead table.** `student_id_cards` exists, is referenced nowhere in
  server source, and holds 0 rows; card state lives on `students.card_design`.
  Ten concurrent `issue-card` calls returned 201 each while creating zero rows
  there (the fee itself was correctly charged once).
- **L-2 Unexercised surface.** 70 of 107 tables are empty, including whole
  feature areas (placement bank, funding, impact, workflows, automations,
  offerings). Large amounts of shipped code have never run against real data.
- **L-3 Dead config.** Root `vitest.config.ts` references `./src/tests/setup.ts`,
  which does not exist; vitest is not installed at root. The frontend has **no
  test runner at all** — every frontend "test" is a string-matching assertion
  executed from the server suite.
- **L-4 Type discipline.** 576 `any`/`as any` escapes in server source (tests
  excluded), concentrated in route handlers where request bodies enter — exactly
  where types would earn their keep.
- **L-5** 30 `console.log` calls on production paths; no structured logging, no
  request IDs, no log levels.
- **L-6** `authorize()` unconditionally bypasses every role check for `owner`
  before evaluating the requested roles. Intentional and documented, but it
  means no route can ever be withheld from the owner — including future
  segregation-of-duties controls (e.g. maker/checker on refunds).

---

## What is genuinely strong (verified, not assumed)

These were attacked and held:

- **Branch isolation.** Cross-branch reads, IDOR by object ID (8 mutating
  endpoints), and create-into-foreign-branch forgery were all rejected 403
  across registrar/finance/manager. List endpoints leaked zero foreign rows
  under `?branchId=<other>` and `?branchId=all`.
- **Privilege escalation.** All 12 vectors blocked — self-promotion to owner,
  creating owner accounts, granting own roles, editing role permissions,
  resetting others' passwords, cross-role finance/audit reads.
- **JWT handling.** `alg=none`, payload swap with retained signature, branch
  swap, and four weak-secret forgeries all rejected. Signature validation is
  backed by a DB re-check of user + `session_version`, so even a validly signed
  token for a non-existent user fails closed.
- **Defence in depth at the DB.** 46 triggers. A direct SQL insert of a payment
  into a foreign branch was rejected (`payment branch mismatch`); a fractional
  AFN amount was rejected (`at most two decimal places`). FKs ON, WAL,
  `busy_timeout=5000`.
- **SQL injection.** Five payload families across six parameters: DB intact,
  107 tables, row counts unchanged.
- **Other money paths.** Visitor→student conversion is race-safe (10
  concurrent → 1×201 + 9×409, backed by `uq_students_lead_id`). Refunds are
  race-safe (10 concurrent → 1 refund). Fixed card fee charged exactly once.
  Mass-assignment rejected (attacker-supplied `id`/`studentCode`/`status`
  ignored). Money validation rejects negative, zero, object, and array amounts.
- **Secret hygiene.** `server/.env` gitignored; boot aborts on secrets <32 chars
  or on a known-weak list.

**Performance** is fine for the intended scale: reads p50 7.4 ms @1 → 58 ms @50
concurrent; writes 4.2 ms → 29 ms @30. Linear degradation, zero errors. The
single-process SQLite architecture is a deliberate, coherent choice for one
institute — but it is a hard ceiling, and there is no horizontal scaling story.

---

## Bottom line

This is a **well-built system with one critical hole in the wrong place.**

The security engineering is above average for a product of this size — the
branch-isolation model is enforced twice (API and DB triggers), and it survived
everything I threw at it. That work is real.

But an ERP's core promise is that the money is right, and on the main tuition
path it currently is not. C-1 is not exotic: a double-click on the busiest
button in the product creates a duplicate charge and a duplicate receipt. H-1
means staff can already see two different debts for one student, so the
symptom is probably live in the field today and being attributed to confusion
rather than a defect.

The most concerning finding is not C-1 itself but **H-2** — the codebase has
detailed comments and a dedicated test suite asserting this exact protection
works. Both are wrong on the guarded path. Until the concurrency tests cover
`fee`, a green suite cannot be treated as evidence of financial correctness.

**Do not deploy as a financial system of record until C-1 and H-1 are closed
and the tests are extended to the guarded categories.**
