# WP-07 · TR-4 — Mutation-gate measurement integrity: discovery & decision checkpoint

**Protocol:** §61 DISCOVER · §63 CHALLENGE · §64 DECIDE · §65 CHECKPOINT · §103 EVIDENCE · §105 STOP · TR-4
**Date:** 2026-08-22 · **Baseline:** `1b8ed39` (tree clean, remote in sync; gates: release 22/22, mutation 9/9/32)
**Stage:** follow-up to the TR-4 artifact review, using existing evidence. **Implementation: none.**
**Method:** read-only discovery. Two single-harness runs (`finance-expense-request`, `teacher-update`) were
executed to capture per-mutant INVALID identifiers; both restore every file they touch.

---

## 1. What this stage investigated

The Owner directed: identify the highest-value unresolved finding from the existing TR-4 evidence,
present an evidence-based decision with a recommended model, and stop for approval before implementation.
No mutation survivor was classified, no EQUIVALENT set was touched, no historical rationale was altered,
and WP-07 was not certified.

---

## 2. TR4-F10 — SEVERITY HIGH · 13 mutation anchors are stale: the gate silently measures less than it reports

Four harnesses report `INVALID (anchor matched 0x)` — their find-patterns no longer match the code
they were written to mutate. Each harness already prints "pattern drifted — fix the harness";
the gate summary does not aggregate these, so 13 intended measurements silently vanish from the
Owner-facing tally.

| Harness | INVALID (runtime-confirmed) | What drifted |
|---|---|---|
| placement-retake-fee | **P1, P2, P3** | `academic.routes.ts:759` now reads `const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');` — the anchors expect the pre-refactor inline `assertMoney` conditional. **P1 is "restore the original weak guard — the defect"**: the harness can no longer even re-introduce the defect it exists to catch. |
| rbac-authorization | **M1, M2, M3, M5, M6, M11, M12** (TR4-F5) | Static anchor audit: 7 of 12 find-patterns match 0× in `rbac-service.ts` / `abac.ts`. The mutated invariants still exist in current form (expiry predicate now at 3 sites — lines 108/117/135; scope checks rewritten as `return scopeId === branchId`, line 397), so the anchors are re-basable. The harness's "4/12 killed" is measured against a fictional denominator. |
| finance-expense-request | **M7** | `NotificationType` CHECK anchor matches 0× in `src/db/schema.sql`. |
| teacher-update | **M4, M14** | `assertMoney` anchors (safe-integer-cents ceiling; two-decimal rounding) match 0× in current `utils/money.ts`. |

**Consequence.** The mutation gate is the Owner's designated instrument for every pending TR-4
disposition ("classify it in the harness EQUIVALENT set … or repair the coverage"). An instrument
that silently drops 13 of its measurements cannot ground those decisions.

## 3. TR4-F11 — SEVERITY HIGH · placement-retake-fee measures against a retired suite — 4 vacuous "survivors"

The harness runs `src/tests/placement-retake-fee-integrity.test.ts`. That file has exactly **2
describes and both are `describe.skip`** (lines 143, 196). It is one of the **13 legacy placement
suites deliberately retired as "explicit skipped knowledge records" by D-85 / conflict C-14**
(WP-04 rebuilt its contract; the registry records "exactly 160 retired placement cases skipped").
vitest therefore exits 0 with every test skipped, and the harness's logic
(`execSync` success ⇒ `*** SURVIVED ***`) records each applicable mutant as a survivor —
**vacuously**.

* The gate's `0/7 killed, 3 survivors` arithmetic decodes as: P1–P3 INVALID (§2), P4–P7 SURVIVED
  (vacuous), of which P5 sits in the harness EQUIVALENT set — leaving 3 counted "survivors" that
  are measurement artifacts, not coverage verdicts.
* **The live replacement exists and is pointed at the exact mutated code**: WP-04's
  `work-packages/wp04/retake-billing.integration.test.ts` asserts `feeCharged === 55`,
  `payment.amount === 55` against a snapshotted configured retake fee (the exact logic P4/P6/P7
  mutate) and `feeCharged: 100` for the first sitting; `profile-policy.integration.test.ts` rejects
  `retakeFeeAmount: -1`; both drive the mutated route
  (`PUT /api/academic/program-versions/:id/placement-profile`) via `putProfile`.
* The harness was simply never re-pointed after D-85 retired its target.
* The gate cannot distinguish "suite passed ⇒ mutant survived" from "suite skipped everything ⇒
  measurement void". A suite that cannot fail cannot kill.

**Provenance note for the reviewer (not a classification):** P5's EQUIVALENT entry cites route-drive
execution evidence; if P4–P7 are re-measured against the live WP-04 suites, any *still-surviving*
mutant remains an unclassified survivor and goes to the Owner. The EQUIVALENT set itself is not
touched by this finding.

## 4. Environmental constraint discovered — TR4-R3's decisive method is impossible in this clone

`381c400` is the **squashed root commit** (516 files, 144,881 insertions — the entire tree imported
at once). The upstream baselines the dossier relies on (`d29554b`, `ab7fd7e`, `0ba9fbe`) are not
ancestors of any commit here. The dossier's recommended differential run for TR4-F3
("run that harness against `d29554b`") **cannot be executed in this repository**. Resolving
TR4-F3 needs either an Owner-supplied baseline checkout or a different method. (Also: an early
probe suggested the Stage-2 commit introduced the suite skips and the `validateMoney` rewrite;
that was wrong — everything predates the squash — and is withdrawn here.)

## 5. Value ranking of unresolved findings (evidence-based)

| # | Finding | Value | Blockers |
|---|---|---|---|
| A | **TR4-F10 + F11 — gate measurement integrity** (13 stale anchors; 1 retired target suite; no void-detection) | **Highest** — every pending TR-4 decision consumes this gate's output; repair needs no survivor classification and no EQUIVALENT change | none — awaiting Owner approval |
| B | TR4-F3 — 6 finance-money-writer survivors (dossier: "highest-value item") | High | **Blocked**: differential baseline unreachable (§4); resolution requires survivor classification (forbidden at this stage) |
| C | M7 rbac survivor (`hasPermission` → `return true` undetected) | High | It is a survivor — classification/repair needs Owner + reviewer |
| D | TR4-R13 — cross-surface runtime agreement test (§77) | Medium | none — additive test only |
| E | TR4-R10 / R11 — predicate consolidation | Low | none |
| F | Dead export `getStudentScholarshipSettled` (`obligations.ts:188`) | Low | none — hygiene |

## 6. Recommended model (M-1) — "measure, and say what you measured"

1. **Anchor currency.** Re-base the 13 stale find/replace anchors onto the current code,
   preserving each mutant's documented semantics verbatim (e.g. P1 must still restore *the original
   weak guard*, expressed against the `validateMoney` form; M2/M3 must still drop the expiry
   predicate from the query that now carries it). No new mutants, no removed mutants.
2. **Live target suites.** Re-point the placement-retake-fee harness's TEST target from the
   D-85-retired legacy suite to the live WP-04 replacements (`retake-billing.integration.test.ts`,
   `profile-policy.integration.test.ts`) — D-85's own replacement contract.
3. **Void-measurement detection.** A run whose target suite executes zero tests (all skipped)
   reports **SUITE-SKIPPED — measurement void** and fails the harness; it is never recorded as
   SURVIVED. A suite that cannot fail cannot kill.
4. **Verdicts by execution only.** After repair, whatever the harnesses measure stands as
   measured. Still-surviving mutants (e.g. M7) remain unclassified survivors reported to the
   Owner. EQUIVALENT sets are untouched.
5. *(Optional, same class)* Surface per-harness INVALID counts in the gate's summary line, so
   anchor drift is visible to the Owner without reading per-mutant logs.

### CHALLENGE — alternatives considered and rejected

* **KEEP as-is and treat P4–P7 as artifacts** — rejected: that is silent survivor classification
  (forbidden), and it leaves the gate reporting fiction.
* **Re-point the suite only, leave anchors stale** — rejected: P1 (the defect) stays unmeasurable;
  TR4-F5 stays open; half a repair.
* **Rewrite the harnesses wholesale** — rejected: §66 (no unrelated changes); minimal re-basing
  preserves the audit trail and each mutant's documented intent.
* **Wait for Stage 3** — rejected: measurement integrity is the precondition for every pending
  TR-4 decision, including Stage 3's (TR4-F1's own rationale: unwatched harnesses "rot silently").

### DECIDE — implementation plan (NOT implemented; awaiting Owner approval)

Files (all under `server/scripts/`): `placement-retake-fee-mutation-test.mjs`,
`rbac-authorization-mutation-test.mjs`, `finance-expense-request-mutation-test.mjs`,
`teacher-update-mutation-test.mjs`, optionally `run-mutation-harnesses.mjs` (summary line only).
Then the full lifecycle: CHECKPOINT → IMPLEMENT → VERIFY (lint, typecheck, `release:validate`) →
ATTACK (`audit:mutation`, expecting INVALID → 0 and real verdicts for the 13 restored mutants) →
REPAIR → REVERIFY → CLEAN → CERTIFY (round record only; **WP-07 remains NOT certified**).

**Explicitly out of scope:** classifying any survivor (incl. M7, finance-expense M2, journey J10,
P5's note), altering any EQUIVALENT set, Stage 3 rationale review, TR4-R10/R11/R13, and the dead
export F.

---

## 7. Recommendation recorded — TR4-R14

> **TR4-R14:** Repair mutation-gate measurement integrity: re-base the 13 stale anchors (TR4-F10),
> re-point the placement-retake-fee harness to the live WP-04 suites (TR4-F11), add void-measurement
> detection, and surface INVALID counts in the gate summary. Verdicts change only by execution;
> classification and EQUIVALENT sets remain with the Owner and reviewer.

---

## 8. OUTCOME — TR4-R14 approved by the Owner and implemented (2026-08-22)

Owner approved full scope. Lifecycle executed: CHECKPOINT (`e0a820b`) → IMPLEMENT → VERIFY →
ATTACK → REPAIR → REVERIFY → CLEAN. Five files changed, +139/−37, all under `server/scripts/`.

**§66 plan falsification, handled by STOP-not-drift:** of the 13 stale anchors, **10 were
re-basable** and **3 are obsolete in their documented form** — rbac M1/M12 (the legacy-role
fallback guarded by `hasAnyAssignment` no longer exists anywhere) and teacher-update M14
(`assertMoney` no longer rounds; it rejects fractional input as "a whole number of AFN").
Re-basing those would invent new mutants. They remain in place, reporting INVALID loudly, with
in-harness OBSOLETE notes; their retirement or redefinition is **deferred to the Owner**. No
EQUIVALENT set was touched (placement remains exactly `P5`); the decision register is 0-diff.

**Measured result (`npm run audit:mutation`, full 18-harness gate):**

| Harness | Before (checkpoint `1b8ed39`) | After | Reading |
|---|---|---|---|
| placement-retake-fee | 0/7 killed · 3 survivors · 3 hidden INVALID (vacuous) | **2/7 killed · 4 survivors · 0 hidden** | P4, P7 KILLED by the live WP-04 suites. **P1 (the original defect), P2, P3, P6 SURVIVE for real** — genuine coverage gaps in the live replacement suites, unclassified, for the Owner. P5 remains EQUIVALENT as set. |
| rbac-authorization | 4/12 killed · 7 hidden INVALID · M7 | **9/12 killed · 2 INVALID (documented-obsolete) · M7** | all five re-based anchors (M2/M3/M5/M6/M11) KILLED — the suite genuinely detects them. M7 (grant-all permissions) survives as a real, unclassified survivor. |
| teacher-update | 9/13 · 2 hidden INVALID · M7,M12 | **10/13 · 1 INVALID (documented-obsolete) · M7,M12** | M4 (precision ceiling) re-based and KILLED. |
| finance-expense-request | 7/8 · 1 hidden INVALID · M2 | **7/8 · 0 INVALID · M2** | M7's paired schema anchor fixed (trailing-whitespace drift). |
| all 14 others | unchanged | **byte-identical** | — |

Gate total: **9 passed · 9 failed · 33 surviving · 3 INVALID anchors surfaced** (was 32 surviving
with 13 INVALID invisible). The INVALID and VOID counts are now printed in the gate summary.
Net measurement effect: **13 silent losses → 3 visible, Owner-deferred; 10 restored mutants →
7 KILLED, 3 revealed as real survivors (P1, P2, P3) + P6.**

**Release gate:** `npm run release:validate` — **22 passed · 0 failed · 0 skipped** (server suite,
builds, reconcile, audits all green; 517 files tracked). `npm run lint` (root + server) green.

**WP-07 remains NOT certified. TR-4 remains OPEN.** New unclassified survivors awaiting Owner
disposition: placement P1, P2, P3, P6; rbac M7 (plus all pre-existing survivors, unchanged).
Open Owner decisions: the three obsolete anchors (M1, M12, M14 — retire or redefine).
