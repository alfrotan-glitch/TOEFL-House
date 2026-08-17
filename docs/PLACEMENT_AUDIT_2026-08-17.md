# Placement Exam Subsystem — Forensic Audit (2026-08-17)

> **STATUS: REMEDIATED in commit `c675f56`.** P-1…P-5 are fixed and verified;
> see §7 (added after remediation) for what changed, how each finding was
> re-tested against a live API, and what remains unverified. The audit body
> below is preserved unedited as the record of the defects as found.

**Scope:** full-stack review of the Placement Exam / Placement Test subsystem.
**Method:** independent discovery across the whole codebase, then a live running system
(seeded DB, real HTTP API, adversarial requests). No code was modified during this audit;
`git status` is clean. Every conclusion below is tagged
**[Confirmed by code]**, **[Inferred]**, or **[Unproven assumption]**.

Evidence was produced against a live server (port 5700, `DB_PATH=/tmp/pl/erp.sqlite`)
driven through the public REST API with real auth tokens — not by direct DB manipulation.

---

## 1. Executive summary

The placement subsystem is **architecturally strong in the areas most systems get wrong**
(financial idempotency, concurrency on completion, server-authoritative scoring, branch
isolation, immutable policy snapshots) and **weak in exactly one place: the completion
gate**. Three confirmed defects all trace to a single root cause — *the attempt lifecycle
validates **presence** of components, never their **policy compliance**, and validates
lifecycle rules **only at creation**, never at completion.*

The practical consequence is that **the placement exam does not actually gate anything**.
A candidate who scores 10% under a policy demanding 60% overall and 50% per component is
completed, recorded, invoiced and enrolled as a student.

| # | Defect | Severity |
|---|---|---|
| P-1 | Component `minScore` / overall `passScore` never enforced — failing candidates enroll | **CRITICAL** |
| P-2 | `allowRetake=false` bypassable via concurrent attempts; retake is also free | **HIGH** |
| P-3 | Optional-placement "skip" writes `waived`, conversion accepts only `completed`/`exempt` — feature is a dead end | **MEDIUM** |
| P-4 | `override` and `correct` perform multi-table writes with no transaction | **MEDIUM** |
| P-5 | False-confidence test asserts the opposite of its own title | **MEDIUM (test integrity)** |

**Verdict: NOT production-ready as an assessment gate.** (Note: the standing GO-LIVE
blockers GL-1 and GL-2 remain open independently of this audit.)

---

## 2. The actual lifecycle (as built, not as documented)

**[Confirmed by code]** — traced end to end and executed live.

```
Visitor (branch_id NOT NULL, program_version_id → published version only)
  └─ POST /api/placement/visitors/:id/placement/attempts
       ├─ resolvePlacementRequirement → not_required | optional | required
       ├─ optional + {skip:true} → placement_status='waived'  ← P-3 dead end
       ├─ retake guard: completed-count > 0 && !allow_retake → 409   ← P-2 hole
       └─ INSERT attempt + immutable snapshot_json (policy + content + ANSWER KEY)
            status='in_progress', UNIQUE(visitor_id, attempt_number)
  └─ PUT .../tests/:key/responses      → auto-scored against server-held answer key
  └─ PUT .../components/:key           → manual score, bounds-checked 0..maxScore
  └─ POST .../complete                 [db.transaction]
       ├─ getRequiredMissing()  ← checks PRESENCE ONLY                ← P-1 root cause
       ├─ evaluateDecision()    ← computes unmetRequirements … DISCARDED
       ├─ stmtCompleteAttempt   ← conditional UPDATE, changes!==1 → 409
       ├─ placement fee, ONLY if this is the first completed attempt  ← P-2 revenue leak
       │    idempotency_key='placement:<attemptId>' + recordIncome (same tx)
       └─ visitors.placement_status='completed', placement_score=<JSON snapshot>
  └─ POST /api/visitors/:id/convert
       └─ gate: requirement.mode==='required' && placement_status!=='completed' → 400
            ← status only. The SCORE is never consulted.               ← P-1 exploit lands
       └─ student + invoice + payment + enrollment
```

**Authoritative layer [Confirmed by code]:** the server, correctly. Answer keys never
leave the backend; the client submits responses only. The frontend
(`PlacementTestModal.tsx`) renders `passScore`/`minScore` as *labels* and does not
recompute scores, decisions, or fees. **The frontend is not incorrectly trusted.**

**Sources of truth [Confirmed by code]:**
- Policy → `placement_assessment_attempts.snapshot_json` (immutable per attempt) — excellent.
- Score → `placement_assessment_results` (per component, versioned via `score_version`).
- Decision → `placement_assessment_attempts.recommended_level_id` / `percentage`.
- **Duplicated:** `visitors.placement_score` is a denormalized JSON copy of the decision,
  and it is what conversion copies onto `students.placement_score`. Two writers keep it in
  sync (`complete`, `correct`, `override`); a third path (`override`) updates it
  non-transactionally (P-4).

---

## 3. Confirmed strengths (verified, not assumed)

**[Confirmed by code + live test]** These are genuinely well built and should not be touched:

1. **Financial idempotency is correct.** 8 parallel `complete` calls → **1 success, 7
   refused, exactly 1 payment row, exactly 1 ledger row.** Deterministic key
   `placement:<attemptId>` backed by the global partial unique index
   `uq_payments_idempotency`; fee + `recordIncome` share one `db.transaction`.
2. **Double-completion is impossible.** `stmtCompleteAttempt` is a conditional UPDATE
   (`WHERE id=? AND status IN ('in_progress','paused')`) with `changes !== 1 → 409`.
   Verified: replay returns *"This placement attempt is already completed."*
3. **Scoring is server-authoritative and tamper-resistant.** Bounds enforced on every
   surface — `-50`, `999`, `"abc"`, `1e309` all rejected with
   *"Score must be between 0 and 100."* on both the scoring and the owner-only
   correction endpoint.
4. **State machine is enforced.** A cancelled attempt cannot be scored or completed.
   Expiry/timeout is enforced server-side (`assertAttemptEditable`, `expireAttemptIfNeeded`)
   on every mutating path — the clock is not client-trusted.
5. **Branch isolation and RBAC hold.** Branch-2 `registrar`/`counselor`/`manager` hitting a
   branch-1 visitor: **403 on view, create, override, and correct.** Same-branch
   `registrar`/`counselor`: **403 on override, score-correct, and maintenance/expire.**
   No IDOR, no privilege escalation found on these paths.
6. **Immutable policy snapshot.** Editing the profile mid-flight cannot retroactively change
   a live attempt — a genuinely mature design choice.
7. **Input validation upstream is sound.** Unknown component types rejected; unpublished
   program versions rejected; invalid score thresholds rejected.

---

## 4. Confirmed defects

### P-1 — CRITICAL — Placement scores are computed, recorded, and then ignored

**Location:**
- `server/src/routes/placement-attempt.routes.ts:295-352` (`/complete`)
- `server/src/core/placement/store.ts` → `getRequiredMissing`
- `server/src/core/placement/decision-engine.ts:63-75` (`unmetRequirements`)
- `server/src/routes/visitors.routes.ts:388-395` (conversion gate)

**Evidence [Confirmed by code + live exploit].** Policy: `passScore=60`,
component `grammar.minScore=50`. Scored **10**.

```
PUT  .../components/grammar   {"score":10}        → 200
POST .../complete                                  → 200 {"ok":true,"feeCharged":300,
                                                          "decision":{"percentage":10}}
POST /api/visitors/:id/convert                     → 200 {"studentId":"stu_76664144…",
                                                          "studentCode":"TH-001001",
                                                          "invoiceNumber":"INV-2026-00001"}
```

Re-running the engine over the persisted attempt proves the system *knew*:

```
policy passScore        : 60 | component minScore: [ 50 ]
engine percentage       : 10
engine unmetRequirements: ["grammar (below minimum score 50)"]
--> STUDENT CREATED     : TH-001001 active | carried %: 10
```

`evaluateDecision` correctly computes the violation. **`grep` across `routes/` and `core/`
returns zero consumers of `unmetRequirements` outside the engine that produces it.** The
completion gate calls `getRequiredMissing`, which tests only whether each required component
*exists and is completed* — never its value. Conversion then gates on
`placement_status === 'completed'`, a status string, never on the score.

**Failure scenario:** any candidate, scoring anything (including 0), completes placement and
enrolls. No API manipulation is required — this is the normal happy path.

**Business impact:** the placement exam provides **no academic gating whatsoever**. Students
land in wrong levels; the `passScore`/`minScore` configuration UI is decorative; academic
integrity and the level-placement product promise are void. Institutions relying on this to
stream students will mis-stream every one of them.

**Root cause:** the decision engine returns a rich verdict, but the caller destructures only
`percentage`, `recommendedLevelId`, `recommendationText`, `decisionRuleId`. The pass/fail
half of the engine's output was never wired into a gate — *computation without enforcement*.

**Production-grade correction (not applied — audit-only pass):** in `/complete`, inside the
existing transaction, treat `unmetRequirements` as authoritative: block completion (409) when
non-empty, **or** persist an explicit `outcome` (`passed`/`failed`) on the attempt and require
`outcome='passed'` in the conversion gate. Prefer the second — it preserves the audit record
of a failed sitting (and its fee) instead of leaving the attempt open. Enforce in **one**
place; do not add a parallel validator.

**Required regression test:** required component scored below `minScore` → `/complete`
refuses (or marks `failed`) **and** `POST /convert` returns 400. Second case: overall
weighted score below `passScore` → same. Must assert the *student row does not exist*.

---

### P-2 — HIGH — `allowRetake=false` is bypassable, and the bypass is free

**Location:** `server/src/routes/placement-attempt.routes.ts:99-102` (guard),
`:323-325` (fee).

**Evidence [Confirmed by code + live exploit].** Policy `allowRetake=false`:

```
POST .../attempts  → attempt X (in_progress)
POST .../attempts  → attempt Y (in_progress)     ← guard did not fire
X: score 20 → complete → percentage 20, feeCharged 300
Y: score 95 → complete → percentage 95, feeCharged 0      ← free retake
DB: completed attempts for visitor = 2 ; visitor final score % = 95
```

Additionally, **8 parallel creations produced 8 open attempts** (`attempt_number` 1-8, all
`in_progress`). `UNIQUE(visitor_id, attempt_number)` did not fire because each request read a
distinct max before writing; the unique index protects the *numbering*, not the *invariant*.

**Failure scenario:** open N attempts before completing any; the retake guard counts only
*completed* attempts, so it never fires. Complete them serially and keep the best score — the
last write to `visitors.placement_score` wins.

**Business impact:** (a) academic — unlimited retakes under a no-retake policy, with
score-shopping; (b) financial — only the first completed attempt is billed, so every
subsequent sitting is unpaid revenue leakage while still consuming staff time.

**Root cause:** same class as P-1 — a lifecycle rule enforced **only at creation time**,
against a *completed* count, with no invariant on concurrently open attempts.

**Correction (not applied):** enforce "at most one open attempt per visitor" at the database
level — a partial unique index on `(visitor_id)` where `status IN ('in_progress','paused')` —
so concurrency cannot defeat it, and re-check the retake policy at completion. Fee logic
should key off "is this attempt billable" rather than "is this the first completion".

**Required regression test:** with `allowRetake=false`, two sequential creations → second is
409; N parallel creations → exactly 1 succeeds; completing a second attempt → refused.

---

### P-3 — MEDIUM — Optional-placement skip writes a status the conversion gate rejects

**Location:** `server/src/routes/placement-attempt.routes.ts:82-89` (writes `'waived'`)
vs `server/src/routes/visitors.routes.ts:393` (accepts `['completed','exempt']`).

**Evidence [Confirmed by code + live test]:**

```
POST .../attempts {"skip":true}  → 200 {"skipped":true,"mode":"optional"}
DB: visitors.placement_status = 'waived'
POST /api/visitors/:id/convert   → 400 "Placement is optional for this program:
                                        complete it or record an exemption before enrollment."
```

Vocabulary analysis: schema `CHECK` allows
`not_started|scheduled|in_progress|completed|waived`. Code *writes*
`completed|in_progress|not_started|scheduled|waived`. Code *compares against*
`completed|exempt|in_progress|not_started|waived`. **`'exempt'` is never written by anything
and is not even a legal column value** — the conversion gate's escape hatch is unreachable.

**Business impact:** the documented "skip optional placement" workflow is a dead end. Staff
perform an audited skip, then cannot enroll the candidate, with an error message instructing
them to do the thing they just did. Likely worked around in the field by forcing a sham
attempt — corrupting placement data.

**Root cause:** duplicated, drifted status vocabulary across two modules with no shared
constant and no schema-level agreement.

**Correction (not applied):** one authoritative status vocabulary. Have the gate accept
`'waived'` (the value the schema and the writer actually use) and delete `'exempt'`, which is
dead and misleading. Do not add a mapping layer.

**Required regression test:** optional policy → skip → convert succeeds. Plus an assertion
that every string compared against `placement_status` is a legal `CHECK` value.

---

### P-4 — MEDIUM — `override` and `correct` are non-transactional multi-table writes

**Location:** `placement-attempt.routes.ts:391-418` (`/override`), `:420-463` (`/correct`).

**Evidence [Confirmed by code].** 14 handlers, 4 use `db.transaction` (create, complete,
cancel, maintenance/expire). `/override` performs 2 writes (attempt row, then
`visitors.placement_score`) plus an audit write; `/correct` performs 4 (result upsert,
correction metadata, attempt decision, `visitors.placement_score`) plus audit — all unwrapped.

**Failure scenario [Inferred — not reproduced]:** a crash, constraint error, or a
`placement_score` JSON parse failure between writes leaves the attempt row overridden while
the visitor's denormalized copy (the value conversion copies onto the student) still shows the
old recommendation. Note `/override` explicitly swallows a JSON parse failure
(`catch { /* leave untouched */ }`) — a silent, permanent divergence between the two stores of
the same truth. I did not reproduce a crash mid-handler; the divergence path is proven by
inspection, its likelihood is not quantified.

**Business impact:** a student enrolled at a level contradicting the audited override
decision, with no error surfaced.

**Root cause:** denormalized second copy of the decision (`visitors.placement_score`) written
outside a transaction; the sibling handlers already establish the correct pattern.

**Correction (not applied):** wrap both handlers in `db.transaction`, matching the existing
pattern in the same file. Do not introduce a new abstraction. Longer term the duplicated
`visitors.placement_score` copy is the real hazard and is a candidate for removal in favour of
reading the attempt row.

**Required regression test:** force a failure on the second write and assert neither write
persists.

---

### P-5 — MEDIUM (test integrity) — A test asserts the opposite of its own title

**Location:** `server/src/tests/placement-engine-lifecycle.test.ts:362-376`.

**Evidence [Confirmed by code].** Titled *"minimum-score enforcement: a completed component
below minScore blocks the decision"*. It configures `minScore: 80`, then submits **correct**
answers, and its own comment concedes the setup:

```js
// 20/20 = 100 ≥ 80 → completes; craft a below-min result instead by direct score
// manipulation on a manual component.
const done = await …/complete…;
expect(done.status).toBe(200);
expect(done.body.attempt.percentage).toBe(100);
```

It scores 100, asserts success, and **never tests the below-minimum case** the title
advertises. The follow-up the comment promises was never written.

**Business impact:** this is precisely why P-1 survived to production readiness review. The
suite reports minScore enforcement as covered; a reviewer grepping for `minScore` finds a
green test with a reassuring name. **975 passing tests did not catch a total failure of the
core gating rule.**

**Root cause:** a test written around observed behaviour instead of the required invariant.

**Correction (not applied):** replace with the real invariant (see P-1's regression test).
This test should be *rewritten*, not deleted — the invariant it names is the right one.

---

## 5. Items examined and cleared

**[Confirmed by code]** — checked and found *not* defective:

- **Payment/financial integrity on completion** — idempotent, transactional, race-proof (§3.1).
- **Frontend trust** — no authoritative recomputation client-side; display only.
- **Score tampering** — bounds enforced on all write surfaces including owner correction.
- **IDOR / cross-branch access** — 403 on every mutation path tested.
- **Role separation** — registrar/counselor denied override, correction, and maintenance.
- **Answer-key exposure** — keys stay server-side in `snapshot_json`; client sends responses only.
- **Timer manipulation** — server-authoritative deadlines re-checked per mutation.
- **Cancelled/expired attempt reuse** — refused.
- **Auto-graded override refusal** — auto-scored components reject manual scores (409).
- **Score correction recomputes the decision** and bumps `score_version` — correct.
- **`assertVisitorBranchAccess` null-branch early return** — unreachable
  (`visitors.branch_id` is `NOT NULL`); defensive, **not** a defect.
- **Migration/schema drift** — 68 migrations apply cleanly, no drift (verified in the prior pass).

---

## 6. Placement Exam Architecture & Integrity Assessment

**Actual lifecycle.** Visitor → (optional fee-bearing) attempt with an immutable policy +
content + answer-key snapshot → component scoring (auto against server-held keys, or manual
within bounds) → completion (transactional, idempotent, race-proof, billed once) → decision
persisted to the attempt *and duplicated* onto the visitor → conversion to student → invoice,
payment, enrollment, ledger.

**Rule-enforcement architecture.** Two distinct qualities coexist:
- *Structural rules* (who, where, when, how many times a row may change state) are enforced
  **well** — at the database and transaction level, and they survive concurrency.
- *Academic rules* (did the candidate actually pass?) are **computed but never enforced**.
  The decision engine is a clean, deterministic, pure function whose most important output is
  discarded by every caller.

The subsystem is therefore best described as a **correct assessment recorder and a
non-functional assessment gate**.

**Sources of truth.** Policy: the per-attempt snapshot (excellent). Score: the results table.
Decision: the attempt row — *duplicated* into `visitors.placement_score` and again into
`students.placement_score`. That duplication is the subsystem's main structural weakness and
the direct enabler of P-4.

**Critical invariants — status:**

| Invariant | Status |
|---|---|
| A placement fee is charged at most once per attempt | ✅ Holds (race-tested) |
| An attempt completes at most once | ✅ Holds (race-tested) |
| Scores stay within policy bounds | ✅ Holds |
| Scoring is server-authoritative | ✅ Holds |
| Cross-branch/role access is denied | ✅ Holds |
| **A failing candidate cannot complete/enroll** | ❌ **Broken (P-1)** |
| **At most one open attempt per visitor** | ❌ **Broken (P-2)** |
| **`allowRetake=false` limits sittings to one** | ❌ **Broken (P-2)** |
| **A legitimately waived candidate can enroll** | ❌ **Broken (P-3)** |
| Decision copies stay consistent | ⚠️ Unguarded (P-4) |

**Dominant defect class.** *Rules evaluated at the wrong moment, against the wrong
predicate.* P-1 validates presence instead of compliance; P-2 validates at creation instead of
completion and counts completed instead of open. Both discard an authoritative computed
result. This is one class, and it should be corrected once — not patched per-endpoint.

**Production-readiness verdict.** **NOT production-ready as an assessment gate.** P-1 alone
voids the subsystem's purpose: the exam is administered, scored, billed, and then ignored.
P-2 compounds it academically and financially. Neither requires attacker skill — P-1 is the
default path. The surrounding engineering (idempotency, concurrency, isolation, snapshots) is
of notably high quality, which makes the gap easy to miss and, fortunately, straightforward to
close: the enforcement point is missing, not the logic.

**Explicitly unverified / left open:**
- P-4's divergence is proven by inspection only; no crash was induced mid-handler.
- `placement_media` (speaking-audio upload/retrieval) was **not** exercised.
- `placement-test-bank.routes.ts` mutation surface was enumerated but not adversarially probed.
- The remaining ~10 placement test files were not individually audited for the P-5 pattern;
  given one confirmed instance, **assume others until checked**.
- Standing blockers **GL-1** (browser visual sign-off) and **GL-2** (printed fee bill) remain
  open and are not addressable in this environment.

---

## 7. Remediation record (commit `c675f56`)

### Root cause
All findings reduce to **one defect class**: *placement rules were evaluated at
the wrong moment against the wrong predicate, and the authoritative result was
discarded.* Completion validated component **presence** instead of policy
**compliance** (P-1); the retake guard ran only at creation, counted only
*completed* sittings, and used a read-then-write pattern concurrency defeats
(P-2). P-3 and P-4 are consequences of duplicated state with no single owner —
two status vocabularies, and two copies of one decision written outside a
transaction.

### Enforcement architecture now
```
Academic/Placement Policy  (placement_assessment_profiles, snapshotted per attempt)
        ↓
Decision engine            evaluateDecision → evaluateOutcome   ← THE pass/fail rule
        ↓
Domain policy module       core/placement/placement-policy.ts
                           evaluateStartEligibility · evaluateBilling
                           evaluateConversionEligibility · WAIVED_STATUS
        ↓
Application enforcement    /complete (persists outcome) · /convert (re-reads it)
        ↓
Database invariants        attempts.outcome · uq_placement_open_attempt
```
No route reimplements a placement rule; completion and conversion consult the
same module, so they cannot drift.

### Fix per finding
| # | Fix | Type |
|---|---|---|
| P-1 | `evaluateOutcome()` is the single pass/fail authority; `/complete` persists `outcome`; `/convert` independently re-reads it | Required fix |
| P-2 | Partial unique index `uq_placement_open_attempt` (atomic); eligibility + billing moved into configurable, snapshotted policy | Required fix |
| P-3 | `'waived'` is canonical (the only value the CHECK allows); `'exempt'` accepted defensively on read only | Required fix |
| P-4 | `override`, `correct` and the content-responses handler wrapped in transactions; `correct` re-derives the outcome | Required fix |
| P-5 | False-confidence test replaced; unrealistic conversion fixture corrected | Required fix |
| — | Waived components no longer count as `minScore` failures | Defensive |
| — | Precise 409s for both uniqueness violations instead of a raw constraint error | Defensive |
| — | UI reports a failed sitting as a warning, never a green "completed" | Defensive |

### Business invariants now enforced
1. A sitting missing any required component **cannot complete**.
2. A sitting below a component `minScore` or the overall `passScore` is recorded **`failed`**.
3. A `failed` (or outcome-less) placement **cannot be converted** into a student — checked independently of visitor status.
4. At most **one open attempt per visitor** (database-enforced).
5. `allowRetake=false` / `maxAttempts` hold under sequential **and** concurrent load.
6. Billing follows configured policy; each attempt is billed **at most once** (`placement:<attemptId>`).
7. Fee and ledger are written in one transaction and reconcile exactly.
8. A waived candidate has a **complete, convertible** lifecycle.
9. Override/correction never leave partial state; corrections re-derive the outcome.
10. Client-supplied outcome, score, percentage, level and fee are **ignored**.

### Financial impact
Placement payments reconciled exactly against the ledger on the verification DB
(1950 = 1950; 0 orphans, 0 duplicate idempotency keys). Existing idempotency
behaviour is unchanged. Default policy values reproduce historical billing
exactly, so no institution's fees change on upgrade. Retakes can now optionally
be billed — closing the revenue leak in P-2 — but only when explicitly configured.

### Verification
- **1005/1005 tests pass** (30 new adversarial in `placement-integrity.test.ts`).
- **Mutation-verified** — the new tests are not vacuous:
  outcome forced to `passed` → **8 fail**; unique index removed → **2 fail**;
  status-only conversion gate restored → **5 fail**.
- **11/11 original exploits re-tested against a live API** on a fresh seeded DB.
- Migration 070 applied to a **real corrupted database** (8 duplicate open
  attempts): reduced to 1, outcomes backfilled truthfully (10%/50% → failed,
  80%/95% → passed), no dangling references.
- eslint 0 errors · both typechecks clean · no schema drift (69 migrations) ·
  release gate 16/16 · frontend builds · **CI 4/4 green**.

### Remaining risks / unverified
- **GL-1** (browser visual sign-off) and **GL-2** (printed fee bill) remain open
  and are unobtainable in this environment.
- P-4 rollback is proven for a *validation* failure; a crash induced mid-transaction
  was not simulated.
- `placement_media` (speaking audio) and the test-bank mutation surface remain
  unexercised adversarially.
- The remaining placement test files were not individually re-audited for the
  P-5 pattern beyond the two instances corrected here.
