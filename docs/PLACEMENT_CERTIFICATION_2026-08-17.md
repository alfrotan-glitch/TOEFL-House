# Placement Exam Subsystem — Independent Certification Audit (2026-08-17)

**Subject:** Placement Exam subsystem at commit `246ed42` (remediation `c675f56`).
**Posture:** the prior remediation was treated as **untrusted**. Every claim was
re-derived from source and re-proven against a live server; no production code
was modified (`git status` clean throughout).

**Method:** live API on a fresh seeded DB (~180 adversarial requests), 9 fresh
mutants, forced mid-transaction aborts via injected SQLite triggers, full-suite
re-run, and independent source reconstruction of the whole lifecycle.

---

## VERDICT: ❌ NOT CERTIFIED FOR PRODUCTION

> **«Can a malicious, careless, concurrent, or technically sophisticated client
> cause Placement Exam to produce an academically invalid, financially
> incorrect, unauthorized, inconsistent, or conversion-eligible result through
> any reachable system path?»**
>
> **YES — through three reachable paths (C-1, C-3, C-4).**

The remediated placement *engine* is genuinely sound: every claim made by the
previous phase was independently reproduced and held. **The defects found here
are not regressions in that work — they are paths that route *around* it.** C-1
in particular shows the enforcement was installed on one door while a second
door was left open.

| ID | Defect | Severity | Class |
|---|---|---|---|
| **C-1** | `POST /api/students/manual` enrols a student with **no placement check** | **CRITICAL — BLOCKER** | Business-logic bypass |
| **C-3** | `POST /api/placement/maintenance/expire` is **global, not branch-scoped** | **HIGH — BLOCKER** | Cross-branch isolation failure |
| **C-4** | Raw `snapshot_json` in API responses **leaks every answer key** | **HIGH — BLOCKER** | Exam-integrity / data exposure |
| C-2 | 15 "gap" tests are source-greps that kill **0** mutants | MEDIUM | False confidence |
| C-5 | `cancel` uses an unguarded read-then-write UPDATE | LOW | Latent race (not reproducible today) |
| C-6 | Duplicated level-recommendation logic in `catalog-service.ts` | LOW | Maintainability |

---

## 1. Confirmed defects

### C-1 — CRITICAL — Placement can be bypassed entirely via manual student creation
**Classification: Confirmed.**

**Location:** `server/src/routes/students.routes.ts:~/manual` handler (student
INSERT at line 73). Contrast `visitors.routes.ts:388-396`, which *does* gate.

**Evidence (live, fresh DB, placement `required`, `passScore=60`):**
```
Control — visitor route, failed placement:
  POST /api/visitors/:id/convert            → 400 "did not meet the placement policy"

Bypass — same institution, same class:
  POST /api/students/manual {classId: <placement-required class>}
    → 201 {"id":"stu_b461e8d9…","studentCode":"TH-001001","receiptNumber":"R-00000002"}

DB: students.status=active · placement_score=NULL · lead_id=NULL
    enrollments=[{class_id:"c_1496e5cb…", status:"active"}]
```
**Reachable by:** `registrar` (201) — the routine front-desk role. Not just owner.

**Failure scenario:** any registrar registers a walk-in directly instead of via
the visitor pipeline. No placement, no exam fee, no level decision — the student
is active and enrolled in a placement-required class. This needs no malice: it
is the *faster* path through the UI's own workflow.

**Business impact:** the entire P-1 remediation is optional in practice.
Students land in arbitrary levels; the placement fee is never charged; academic
gating is advisory. This is the original CRITICAL finding with a different URL.

**Root cause:** the invariant was enforced at the *conversion boundary* rather
than at the *enrolment boundary*. Two independent paths create
`students` + `enrollments` rows; only one consults placement policy. The domain
module `placement-policy.ts` exists and is correct — this caller simply never
asks it.

**Recommended fix:** call `evaluateConversionEligibility(...)` in
`/students/manual` whenever `classId` resolves to a class whose program version
has a placement policy. Do not duplicate the rule — reuse the module. Consider
whether direct manual creation into a placement-required class should be
permitted at all, or require an explicit audited waiver.

---

### C-3 — HIGH — Expiry sweep crosses every branch boundary
**Classification: Confirmed.**

**Location:** `server/src/routes/placement-attempt.routes.ts` — `/maintenance/expire`.
The query is `WHERE status IN ('in_progress','paused') AND expires_at < ?` with
**no branch predicate**, guarded only by `authorize('owner','manager')`.

**Evidence:** a branch-2 manager expired a branch-1 candidate's live attempt:
```
branch-1 attempt pat_ab265d6b… (branch_id=1, in_progress)
POST /maintenance/expire  as branch-2 manager → {"ok":true,"expired":1}
branch-1 attempt after sweep: status=expired, branch=1     ← CROSS-BRANCH MUTATION
```
Every other placement route correctly returned 403 for this same user.

**Failure scenario:** any manager at any branch destroys in-progress exams
institution-wide — candidates mid-exam lose their sitting. Also a silent
integrity risk: routine cron-style use by one branch mutates all others.

**Business impact:** breaks the multi-branch isolation guarantee the rest of the
subsystem enforces; enables accidental or deliberate denial of service against
other campuses' live exams.

**Root cause:** a maintenance/batch endpoint written as a global sweep, while
the isolation model everywhere else is per-branch resource access.

**Recommended fix:** scope the sweep to the caller's branch (`resolveBranchScope`),
allowing all-branch sweeps only for an explicitly global operator role.

---

### C-4 — HIGH — Every answer key is served to the client
**Classification: Confirmed.**

**Location:** `server/src/core/placement/store.ts:325-343` (`mapAttempt`).

**Evidence:** the sanitizer *works* — and is then undone one line later:
```js
// snapshot.tests[].questions[].answer_key correctly deleted …
return { ...attempt, snapshot, results: … };   // ← ...attempt re-adds snapshot_json
```
Live proof:
```
GET /api/placement/visitors/:id/placement
  keys on attempt object: ['snapshot', 'snapshot_json']
  sanitized snapshot.tests answer_key: [None, None]     ← strip succeeded
  raw snapshot_json answer keys:       ['B', 'Seine']   ← full key set exposed
POST /api/placement/visitors/:id/placement/attempts
  snapshot_json answer keys:           ['B', 'Seine']
```
Exposed to `registrar` and `counselor` (verified), i.e. the staff who invigilate.

**Failure scenario:** the answer key for every question is in the JSON that
loads the exam UI. Any invigilator with browser devtools — or any XSS/log/proxy
capture — reads the correct answers before or during the sitting. The affected
response is the one the exam screen itself fetches.

**Business impact:** the assessment is not trustworthy as an assessment. Scores
can be inflated undetectably by legitimate-looking, correctly-scored answers, so
no downstream integrity control (outcome, conversion, audit) can detect it. This
silently defeats the server-authoritative scoring the audit previously certified.

**Root cause:** object-spread of a `SELECT *` row alongside a sanitized copy of
the same data. The defence was applied to the derived field, not the source
field. Any route calling `mapAttempt` over `SELECT *` inherits the leak
(`stmtAttempt`, `stmtCurrentAttempt`); `stmtAttempts` lists an explicit column
set and is clean — which is why this was easy to miss.

**Recommended fix:** destructure `snapshot_json` out in `mapAttempt`
(`const { snapshot_json: _s, ...rest } = attempt`) and return only the sanitized
`snapshot`. Add a regression test asserting no response body contains a known
answer-key string.

---

### C-2 — MEDIUM — 15 placement tests provide false confidence
**Classification: Confirmed.**

**Location:** `placement-engine-gap.test.ts` (8), `placement-content-gap.test.ts` (4),
`placement-engine-extension-gap.test.ts` (3).

**Evidence:** these assert on `readFileSync(...)` source text and schema shape,
e.g. `expect(src).toMatch(/audioMediaId/)`. Mutation result:
```
MUTANT A (minScore enforcement disabled):
  15 gap tests            → 0 killed
  placement-integrity     → 1 killed
```
They pass whether or not the logic works, and inflate the suite count.

**Impact:** overstates coverage; exactly the pattern that let P-1 survive.
Non-blocking because real coverage exists elsewhere (see §5).

**Recommended fix:** convert to behavioural tests or delete. Keep the schema-shape
assertions, which are legitimate drift detection.

---

### C-5 — LOW — `cancel` uses an unguarded UPDATE
**Classification: Confirmed (code) / Not reproducible (runtime).**

`cancel` does `UPDATE … SET status='cancelled' WHERE id=?` with no
`AND status IN ('in_progress','paused')`, relying on a prior read — unlike
`stmtCompleteAttempt`, which is conditional. **25 complete-vs-cancel races
produced 0 corruptions** (16 completed / 9 cancelled, 0 billed-but-not-completed,
0 cancelled rows carrying an outcome) because better-sqlite3 serialises writes.
Latent under a different driver/deployment. Recommend matching the conditional
pattern for consistency.

### C-6 — LOW — Duplicated recommendation logic
`catalog-service.ts:281 recommendLevel()` re-implements band matching, exposed
via `POST /api/catalog/placement/recommend`. **Advisory only — persists nothing**
and accepts a client score, so it is not a bypass. It is a second source of truth
for level bands and should eventually delegate to the decision engine.

---

## 2. What was verified and HELD (Confirmed)

Independently re-proven, not taken on trust:

| Area | Result |
|---|---|
| **State machine** | **24/24 illegal transitions rejected** (in_progress · paused · completed · cancelled), incl. re-complete, score-after-complete, cancel-after-complete, override/correct before completion, override to a foreign level |
| **Object-level authz** | ID substitution across visitors → 404; nonexistent IDs → 404 |
| **Concurrency** | 12 parallel scores → 1 row · 10 parallel corrections → attempt % == component score · waiver/score race → 1 coherent row · 8 parallel conversions → **1 student, 1 invoice** · pause/resume/cancel/complete storm → coherent terminal state, 0 stray payments |
| **Rollback** | **8/8** forced aborts (triggers at write #2/#3/#4 of `correct`, #2 of `override`, fee INSERT and ledger INSERT of `complete`, results INSERT of `create`) left byte-identical state; **no orphan money, no orphan attempt** |
| **Policy snapshot** | Lowering `passScore` 60→10 and enabling a 999 retake fee **mid-attempt** changed nothing: outcome still `failed`, fee still 300 |
| **Fee matrix** | default 300/0 · `firstAttemptBillable=false` → 0 · `retakeBillable`+fee 0 → 0 · `retakeBillable` no amount → falls back to 300 · failed sitting still billed 300 · invalid/cancelled → **0 payments** |
| **Reconciliation** | After ~180 adversarial ops: payments 27/8100 AFN == ledger 27/8100 AFN; 0 orphans either side; 0 duplicate idempotency keys; **0 payments on non-completed attempts** |
| **Structural invariants** | 0 completed-without-outcome · 0 visitors with >1 open attempt · 0 students from a failed placement · 0 outcomes on non-completed rows |
| **Media / test bank** | Server-generated filenames from a MIME allowlist (no traversal); cross-branch media file → 403; teacher → 403 everywhere; branch-2 content lands in branch 2 |
| **Migrations** | 070 re-run is idempotent (38→38 attempts, outcomes unchanged); 69 migrations, no drift |
| **Manual fee duplication** | Manual `placement` payment after auto-booking → refused |
| **Baseline** | 1005/1005 tests · eslint 0 errors · both typechecks clean · preflight clean |

### Rule-engine integrity (item 3) — single authoritative path confirmed
Pass/fail, component minScore, overall passScore, required components,
completion eligibility, conversion eligibility, retake eligibility, maxAttempts,
billing eligibility, billing amount and waiver semantics each resolve to exactly
one implementation (`decision-engine.ts` + `placement-policy.ts`). The only
duplicate found is C-6 (advisory). **Level recommendation has two
implementations** — the authoritative one and C-6.

---

## 3. Mutation testing (item 9)

Nine fresh mutants against the 9 real placement test files (223 tests):

| Mutant | Killed by |
|---|---|
| A — minScore enforcement disabled | 1 |
| B — overall passScore ignored | 9 |
| C — conversion accepts `failed` | 2 |
| D — maxAttempts disabled | 1 |
| E — allowRetake ignored | 2 |
| F — retakeBillable ignored | 2 |
| G — required-component gate removed | 7 |
| H — outcome never persisted | 6 |
| I — waiver rejected by conversion | 1 |
| J — score bounds removed | 7 |

**9/9 killed.** Coverage of the remediated invariants is real. Four mutants are
killed by only 1–2 tests (thin but non-zero). The 15 gap tests killed **nothing**.

---

## 4. Source-of-truth map

| Fact | Authority | Notes |
|---|---|---|
| Policy for a sitting | `attempts.snapshot_json` | Immutable — verified live |
| Component scores | `placement_assessment_results` | Versioned via `score_version` |
| Pass/fail | `attempts.outcome` | Written only by complete/correct |
| Decision | `attempts.recommended_level_id` / `percentage` | Duplicated into `visitors.placement_score` and `students.placement_score` (kept consistent transactionally) |
| Open-attempt uniqueness | `uq_placement_open_attempt` | DB-enforced |
| Fee | `payments.idempotency_key='placement:<attemptId>'` | Global partial unique index |

---

## 5. Unverified areas (declared, not assumed safe)

- **GL-1** (browser visual sign-off) and **GL-2** (printed fee bill) — unobtainable in this environment.
- Multi-process / multi-worker concurrency: all races tested against a single Node process with better-sqlite3's serialised writer. **C-5's latency to failure under another driver is unknown.**
- `bos.routes.ts`, `events.routes.ts`, `skills.routes.ts`, `exams.routes.ts` reference placement but were surveyed, not adversarially probed.
- Speaking-audio *scoring* path (rubric criteria over uploaded media) exercised only via existing tests, not adversarially.
- No load/soak testing; no long-running expiry behaviour across real clock boundaries.

---

## 6. Production blockers

1. **C-1** — close the `/students/manual` placement bypass. *(CRITICAL)*
2. **C-3** — branch-scope `/maintenance/expire`. *(HIGH)*
3. **C-4** — stop serving raw `snapshot_json`; add an answer-key leak regression test. *(HIGH)*
4. **GL-1 / GL-2** — pre-existing human sign-offs, still open.

**Non-blocking:** C-2 (test quality), C-5 (latent race), C-6 (duplicate logic).

---

## 7. Assessment

The remediation delivered in `c675f56` is **sound and independently confirmed**:
the decision engine is the single authority, the outcome is persisted and
enforced at two boundaries, transactions roll back completely under forced
failure, concurrency invariants are DB-backed, and the money reconciles exactly.
Every one of the previous phase's claims survived independent re-testing.

But certification is about the *system*, not the module. Two of the three
blockers are paths that never consult the hardened engine (C-1, C-3), and the
third (C-4) undermines the assessment's integrity upstream of every control that
was hardened. C-1 alone reduces the entire remediation to opt-in.

The subsystem is **close** — the architecture is right and the invariants are
real. It is not yet certifiable.
