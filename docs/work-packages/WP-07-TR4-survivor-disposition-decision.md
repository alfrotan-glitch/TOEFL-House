# WP-07 · TR-4 — Survivor & obsolete-anchor disposition: decision checkpoint

**Protocol:** §61 DISCOVER · §63 CHALLENGE · §64 DECIDE · §103 EVIDENCE · §105 STOP · TR-4
**Date:** 2026-08-22 · **Baseline:** `3064c82` (gate: release 22/22 · mutation 9/9/33, 3 documented INVALID)
**Stage:** decision checkpoint only. **Implementation: none. Nothing classified. No EQUIVALENT set
touched. No WP-07 certification.**
**Method:** read-only investigation. Every claim below was verified in the working tree this session;
verdicts quoted are from executed harness runs.

---

## 1. The three obsolete anchors

### M14 (teacher-update) — subject removed by RECORDED decision D-23

`assertMoney` no longer rounds: **D-23** ("Reject, do not round, operator input") split the boundary —
`assertMoney` refuses fractional amounts; `assertComputedMoney` settles system-derived values. M14's
invariant ("assertMoney rounds to two decimals") describes behaviour the Owner explicitly removed.

* **Recommended model — retire via a documented OBSOLETE registry** (per-harness, mirroring the
  EQUIVALENT discipline: written reason + evidence + Owner approval, reported distinctly by the gate).
  Reason for M14: *subject removed by D-23; rounding lives only in `assertComputedMoney` by design.*
* **Gap flag:** no current mutant covers the REPLACEMENT boundary ("assertMoney rejects fractional
  input"). A successor mutant (e.g. M15 on the `whole number of AFN` guard) is **new design** —
  offered as an optional Owner decision, not assumed.

### M1, M12 (rbac-authorization) — subject absent; no decision record found

The legacy-role fallback guarded by `hasAnyAssignment` does not exist anywhere
(`grep hasAnyAssignment|getLegacyUser|legacy src/core/rbac src/middleware` → 0 hits). No decision
record for its removal was found (searched the decision register). The successor enforcement — the
expiry predicates — is now execution-proven (M2/M3 re-based and **KILLED**).

* **Recommended model — retire both as OBSOLETE** with the code evidence + the M2/M3 kills cited.
* **Flag to Owner:** the original removal has no decision record; recording one is the Owner's call
  (I do not write decision rationale).

**Rejected alternative for all three:** re-basing onto "nearest" current code — that invents new
mutants (new design), exactly what §66 forbids doing silently. **Keeping them INVALID forever** —
rejected: permanent noise hides future real drift now that INVALID is surfaced.

## 2. The real survivors from TR4-R14's honest measurement

### P1 — the original PLC-1 defect (magnitude is guarded ONLY by the mutated line)

Verified defence layers: the canonical schema CHECK
(`retake_fee_amount >= 0 AND retake_fee_amount = CAST(... AS INTEGER)`) rejects negatives and
fractions — **but passes 1e15 and 1e20** (integer-valued, ≥ 0). The read path (`nullableInteger`,
min 0) bounds nothing above. So the route's `validateMoney` (MAX_MONEY via assertMoney) is the only
magnitude guard, and no test exercises it.
**Recommended model — repair the coverage:** add `{ retakeFeeAmount: 1e15 }` (and 1e20) to the
invalid-payloads case in `wp04/profile-policy.integration.test.ts` (PUT must 400; stored value
unchanged). Kills P1 by execution.

### P2 — the database is the operative boundary; the observable residue is the error SHAPE

Measured: the existing `{ retakeFeeAmount: -1 } → 400` test **passes under P2** because the CHECK
rejects −1 and the errorHandler maps `SQLITE_CONSTRAINT_CHECK` → 400. Residual observable delta:
non-numeric input (`'abc'`) → `Number('abc')` = NaN → better-sqlite3 binding TypeError → **500**,
not 400.
**Recommended model — repair the coverage:** add `{ retakeFeeAmount: 'abc' } }` expecting 400 (the
1e15 case kills P2 as well). Weak alternative (classify equivalent-by-DB-boundary) rejected: the
NaN path is observable, so equivalence would be false.

### P3 — "omitted" never happens through the fixture, and the fallback is untested

`putProfile` always sends `retakeFeeAmount: null` explicitly, so the omitted-field branch is never
exercised; the behavioural delta (omitted → 0 → a billable retake charges **0** instead of falling
back to the base fee) is untested.
**Recommended model — repair the coverage:** behavioural case in `wp04/retake-billing.integration.test.ts`
— profile with no configured retake fee, `retakeBillable: true`, complete a retake → `feeCharged`
must equal the base fee. Kills P3 (it would charge 0).

### P6 — no case combines a billable first attempt with a configured retake fee

The only billable-first-attempt test configures no retake fee (`null ?? baseFee` = baseFee — same
result as the mutant). **Recommended model — repair the coverage:** configure `retakeFeeAmount: 55`
with `firstAttemptBillable: true` → first sitting must charge the base fee (100), not 55.

### RBAC M7 — the kill already exists; the harness just doesn't run it

`hasPermission` has exactly two production call sites (`security.routes.ts` `requirePermissionAtBranch`,
`users.routes.ts` `requireRoleAssignmentAuthority`). `wp02/security-grant-escalation.test.ts` contains
**six POST `/api/security/users/:id/roles` → 403 deny cases straight through that path** — but it is
not among the rbac harness's seven suites.
**Recommended model — repair the measurement:** add that suite to the harness `SUITES` (one line),
then verify M7 dies by execution; fallback if it survives (deny-cause ambiguity): one targeted
deny case (principal without the exact permission code, correct branch). Not a classification —
M7 is plainly observable, hence not equivalent.

## 3. The unresolved pre-existing survivors (18) — class-based disposition model

| Class | Survivors | Evidence-based reading (hypothesis, NOT classification) | Recommended model |
|---|---|---|---|
| **R — raw-vs-parsed** (8) | funding **F1** *(the original defect)*, **F3**, **F7**; employee-salary **M2, M5**; fer **M2** | TR4-F2: funding net broken since WP-06 (suite + handler unchanged then). The raw-vs-parsed delta is observable only for inputs whose string form differs from the parsed number (e.g. `"2500"`, `" 2500 "`) — none of the suites pin typed input. | **Execution-probe first:** apply each mutant, drive the harness suite with a typed-input case, record any delta; observable → pin with a test; unobservable → build the written equivalence case **for the Owner + reviewer** (never author-classified). |
| **W — WP-07 upstream guards** (6) | finance-money-writer **M2, M4, M6, M10, M11, M13** | TR4-F3, the dossier's highest-value item; causation undetermined; WP-07 added upstream guards (`assertInvoicePurpose`, allocation writes) that plausibly made several unobservable. The dossier's decisive method (differential vs `d29554b`) is **unexecutable in this clone** (squashed root). | **Refer to the independent reviewer** (per the dossier's own instruction — "must not be decided by the author") with fresh in-clone probe data the agent prepares on approval. |
| **E — plausibly equivalent by recorded decision** (1) | journey **J10** | TR4-F4: D-140 moved `assertMoney` into `EnrollmentService.enroll`; the route-level parse looks like defence-in-depth. | **Reviewer confirms → EQUIVALENT with the D-140 reason** — exactly the already-recorded TR4-R4 path. |
| **C — reject-path coverage** (5) | teacher-input **M2, M7, M11**; teacher-update **M7, M12** | Invariants are plain observable rejections (zero/negative scores, non-positive salary, negatives, non-decimal strings); the harness suites (`teacher-input-error-contract`, `wp05/teacher-update-validation`) lack the specific reject cases. | **Repair the coverage:** add the named reject cases to the suites the harnesses run; verify kills by execution. |

**Sequence recommended (each batch under its own full lifecycle):** ① Bucket 2 (money + security,
all kills by execution) → ② Bucket 1 retirements (+ optional M15 successor decision) →
③ Bucket 3 Class C and R → ④ Class E and W to the reviewer.

---

## 4. Standing constraints reaffirmed

No classification is silent: every EQUIVALENT/OBSOLETE change above requires this Owner approval
plus a written reason in the harness; the author does not classify Class W; WP-07 stays uncertified
until TR-4 is discharged; the decision register's historical rationale is untouched.

**Stopped at this decision checkpoint — awaiting Owner approval.**

---

## 5. OWNER APPROVALS RECORDED (2026-08-22, same checkpoint)

| Bucket | Owner decision |
|---|---|
| 1 — obsolete anchors | **Approved: retire M1/M12/M14 into the documented OBSOLETE registry AND design the M15 successor mutant** for the fractional-rejection boundary (D-23). |
| 2 — real survivors | **Approved: full coverage-repair model** — placement P1/P2/P3/P6 cases (1e15/1e20, 'abc', omitted-fee fallback, billable-first-attempt) and the rbac M7 measurement fix (add `security-grant-escalation.test.ts` to the harness suites). |
| 3 — pre-existing 18 | **Approved: class-based protocol in the recommended order** — Class C coverage repairs (5) → Class R probes (8), with Class W (6) and J10 packaged for the independent reviewer. |

Per the round's governing instruction ("Proceed to the next Decision Checkpoint only … Do not
implement"), **no implementation has begun**. Each approved batch executes under its own full
lifecycle (CHECKPOINT → … → CERTIFY, no WP-07 certification) when the Owner says proceed.

---

## 6. OUTCOME — Bucket 2 executed (2026-08-22, Owner-directed)

Lifecycle: CHECKPOINT (`030c1e6`) → DISCOVER → IMPLEMENT → VERIFY → ATTACK → REPAIR → REVERIFY →
CLEAN. Three files, +48/−0.

**Placement coverage (P1/P2/P3/P6) — all four KILLED by execution.**
`wp04/profile-policy.integration.test.ts` invalid payloads gained `1e15`, `1e20`, `'abc'`;
`wp04/retake-billing.integration.test.ts` gained the omitted-fee-fallback case (retake must charge
the base fee, never 0) and the billable-first-attempt case (first sitting charges the base fee even
when a retake fee is configured). Harness verdict: **placement-retake-fee FAIL→PASS, 6/7 killed,
0 survivors** (P5 remains the harness's proven-equivalent entry — untouched).

**RBAC M7 — the approved fallback is FALSIFIED by construction; disposition returned to the Owner.**
The measurement fix was applied (`security-grant-escalation.test.ts` added to the harness suites —
kept: genuine deny-path wiring against future guard divergence) but M7 still survives, and code
reading proves why: `requirePermissionAtBranch` (security.routes) and `requireRoleAssignmentAuthority`
(users.routes) both test `!hasPermission(ctx, code) || !canAccessBranchForRequirement(…,
{permissionCodes:[code]})`, and the branch leg resolves from the **same post-deny `ctx.permissions`
set** with strictly stronger conditions (`hasPermissionForBranchWithActionScopes`, rbac-service.ts
:429-442) — so **branch-leg true ⟹ hasPermission true**, making the `hasPermission` leg subsumed at
its only two production call sites. A behavioral kill is impossible; adding a test that cannot fail
under the mutant would make the harness lie. Per §66/§105 this was not decided unilaterally.
**Owner options:** (a) classify M7 EQUIVALENT with the by-construction proof above (reviewer
co-sign), or (b) approve a production simplification — remove the subsumed `hasPermission` leg (and
optionally consolidate `hasPermission`/`hasAnyPermission`, LAW 1) — after which M7's anchor target
disappears and it retires through the Bucket-1 OBSOLETE mechanism with this evidence.

**Gates after the round:** `npm run release:validate` — **22 passed · 0 failed · 0 skipped**
(518 files tracked). Server suite **2830 passed · 162 skipped · 0 failed** (2992 total; +2 tests).
`npm run audit:mutation` — **10 passed · 8 failed · 29 surviving · 3 documented INVALID**
(placement FAIL→PASS; every other harness byte-identical; nothing classified, EQUIVALENT sets
untouched, decision register untouched).

**WP-07: NOT certified** — the mutation gate still fails (8 harnesses), M7's disposition is pending,
and Buckets 1 and 3 remain. **TR-4 OPEN.**

---

## 7. OUTCOME — Bucket 1 + M7 Option (b) executed (2026-08-22, Owner-directed)

Lifecycle: CHECKPOINT (`a457ab5`) → DISCOVER → IMPLEMENT → VERIFY → ATTACK → REVERIFY → CLEAN.
Six files, +86/−19. The decision register (`docs/registries/decisions.md`) is **0-diff**.

**M7 Option (b) — the approved production simplification.** The subsumed
`!hasPermission(ctx, code) ||` leg was removed from `requirePermissionAtBranch`
(security.routes.ts) and `requireRoleAssignmentAuthority` (users.routes.ts), each carrying the
subsumption proof in a comment; the now-unused `hasPermission` function was deleted from
rbac-service.ts (`hasAnyPermission` remains the single set-membership authority — the LAW 1 twin
is gone). Behavior-preservation evidence: **206/206 tests pass** across wp02 (17 files) and the
org-authorization suite, including the Bucket-2 deny-path suite wiring, which is **preserved**
in the rbac harness. M7 was then **retired through the OBSOLETE mechanism** with the subsumption
proof recorded in the harness registry — never classified EQUIVALENT.

**OBSOLETE mechanism (as approved).** Per-harness registries with written evidence, skipped
before anchoring, reported distinctly by the harness and the gate — never silent, never inside
EQUIVALENT sets:
- **M1, M12** (rbac): legacy-role fallback absent (0 grep hits); successor enforcement
  execution-proven (M2/M3 KILLED); no decision record located for the removal (flagged).
- **M14** (teacher-update): subject removed by recorded decision **D-23**.
- **M7** (rbac): subsumption proof + this round's simplification.

**M15 successor mutant (as approved) — verdict by execution: SURVIVED.** The new mutant probing
D-23's replacement boundary ("assertMoney rejects fractional input") applies cleanly and is not
killed by `wp05/teacher-update-validation.test.ts` — an honest new real survivor. It joins the
**Bucket-3 Class C** list (reject-path coverage: teacher-update M7, M12, M15) — not repaired
here; adding that coverage was not in this round's approvals.

**Gates after the round:** `npm run release:validate` — **22 passed · 0 failed · 0 skipped**.
Server suite **2830 passed · 162 skipped · 0 failed** (unchanged counts — the production change is
behavior-preserving). `npm run audit:mutation` — **11 passed · 7 failed · 29 surviving ·
4 documented-obsolete · 0 INVALID** (rbac FAIL→PASS at 9/9 killed; teacher-update 10/13 with
M15's honest survival; every unmodified harness byte-identical).

**WP-07: NOT certified** — the mutation gate still fails (7 harnesses), Bucket 3 remains
(19 real survivors: employee-salary 2, fer 1, fmw 6, funding 3, journey 1, teacher-input 3,
teacher-update 3 incl. M15). **TR-4 OPEN. Stopped at the decision checkpoint.**

---

## 8. OUTCOME — Bucket 3 Class C + Class R executed (2026-08-22, "continue according to protocol")

Lifecycle: CHECKPOINT (`8cba3e4`) → DISCOVER → IMPLEMENT → VERIFY → ATTACK → REVERIFY → CLEAN.
Four test files, +111/−5. No production code changed. Decision register 0-diff.

**Class C — 6/6 KILLED by executed coverage.**
- `teacher-input-error-contract.test.ts`: the out-of-range score matrix now asserts each case's
  **domain error message** (probe fact: with the mutant applied, the DB CHECK rejects the zero and
  the client sees the generic message — the status-only assertion could not distinguish layers);
  the criteria test asserts "criteria must be an object"; employee pay-salary gained explicit
  zero and negative cases (desk-guard message + no residue). **M2, M7, M11 dead — 9/9 killed.**
- `wp05/teacher-update-validation.test.ts`: direct unit kills at the money boundary — negative
  (M7), fractional/whole-AFN (M15), non-decimal numeral strings (M12). **13/13 killed + M14
  obsolete — harness FAIL→PASS.**

**Class R — all 6 probed by execution; every probe SURVIVES: the equivalence cases are now
evidence-backed and go to the Owner + reviewer, unclassified.**
- Probes added: sponsorship-update and campaign-update numeric strings stored as numbers with
  `typeof` asserted (`funding-amount-integrity.test.ts`); employee PUT and POST numeric-string
  salaries with `typeof` asserted (`employee-salary-validation.test.ts`). Existing probes:
  funding CREATE `'750' → integer`, fer `'2400' → integer` (`amountClassOf`).
- Verdicts: **F1, F3, F7, salary M2/M5, fer M2 all SURVIVED with the probes in place.**
  Mechanism (verified in schema + routes): every one of these writers targets a numeric-affinity
  column, so the raw assertMoney-valid string is stored **byte-identically** to the parsed number,
  and every read path re-maps through `Number(...)`. The raw-vs-parsed difference is unobservable
  at storage, API and aggregate layers. **Proposed disposition (for the reviewer to confirm, not
  classified here): EQUIVALENT by column affinity + read-path normalization, one written reason
  per harness.**

**Gates after the round:** `npm run audit:mutation` — **13 passed · 5 failed · 23 surviving ·
4 documented-obsolete · 0 INVALID** (teacher-input and teacher-update FAIL→PASS; the 5 remaining
failing harnesses are exactly the ones holding probed/referred survivors). `npm run
release:validate` — **22/22 PASSED**. Server suite **2839 passed · 162 skipped · 0 failed**
(3001 total; +9 tests).

**Remaining for disposition (all evidence prepared):**
| Item | Count | Evidence |
|---|---|---|
| Class R (F1/F3/F7, salary M2/M5, fer M2) | 6 | probed survivors above — affinity equivalence cases |
| Class W (fmw M2/M4/M6/M10/M11/M13) | 6 | dossier TR4-F3 + fresh gate data; referred to the independent reviewer (dossier's own rule: not the author) |
| Class E (journey J10) | 1 | dossier TR4-F4 / D-140 hypothesis — reviewer confirms or refutes |

**WP-07: NOT certified. TR-4 OPEN. Stopped at the decision checkpoint.**
