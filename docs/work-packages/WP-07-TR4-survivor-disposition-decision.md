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
