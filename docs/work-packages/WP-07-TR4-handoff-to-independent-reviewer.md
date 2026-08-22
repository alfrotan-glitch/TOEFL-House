# WP-07 · TR-4 — Handoff to the independent reviewer (execution-backed verdict required)

**Protocol:** §59 (INDEPENDENT REVIEW stage) · §71 INDEPENDENT REVIEW · §73 CERTIFICATION ·
§103 EVIDENCE · §105 STOP · TR-4
**Date:** 2026-08-22 · **Handoff baseline:** branch `arena/01a0299b-toefl-house`, commit
`102074c` (tree clean; remote branch pushed)
**Status: HANDED OFF — AWAITING THE INDEPENDENT REVIEWER'S EXECUTION-BACKED VERDICT.**
**The implementing agent is stopped on this item. It will not author, co-author, extend or
pre-empt that verdict.**

---

## 0. The Owner ruling this handoff executes (2026-08-22, verbatim)

> Proceed with the Master Protocol's TR-4 independence requirement. Do not self-review or
> grant a §R exception. Hand off `docs/work-packages/WP-07-TR4-independent-reviewer-package.md`
> to a genuinely independent agent/session and wait for its execution-backed verdict.

Consequences, recorded so they cannot drift:

1. **No self-review.** Nothing written by the implementing agent discharges TR-4. That
   includes the verdicts already on record — see §2.
2. **No §R exception.** The protocol's §R AUTHORIZED REVISIONS table receives no entry
   excusing §71's structural-separation requirement, and none was requested.
3. **The review must be execution-backed.** Verdicts by execution or construction-proof,
   never by inspection alone (reviewer package §0, rule 3).

## 1. What TR-4 requires, and why this handoff exists

TR-4 (risk register, `docs/registries/decisions.md`): INDEPENDENT REVIEW performed by the
same agent is mitigated, **not eliminated**; severity High; structural; needs a second
reviewer. D-154 records the implementing agent's formal decline to self-certify, with the
evidenced failure mode: two self-authored artifacts in one session were green and wrong
(the F-18b analysis, D-152; the first C-2 money-boundary guard).

Qualifying reviewers (dossier §2 — unchanged):

1. a second engineer; or
2. a **different model/agent session** given this package and the reviewer package,
   **without** this session's reasoning.

Strongest available mode: **artifacts only** — read code, tests, harnesses, gate output;
do **not** consult the decision register's justifications (D-101…D-161) until your verdicts
are written, so the code is judged on its own.

## 2. What the reviewer must NOT trust — the state of play since the package was written

The reviewer package (`WP-07-TR4-independent-reviewer-package.md`) was written when 13
survivors were unclassified. **Every disposition applied since then was applied by the
implementing agent**, under owner directions to "continue". They are recorded in
`docs/work-packages/WP-07-TR4-independent-review-verdicts.md` §5–§8:

- 10 EQUIVALENT entries (funding F1/F3/F7 · employee-salary M2/M5 · fer M2 · fmw
  M6/M10/M11/M13), one J10 EQUIVALENT entry, with written in-harness reasons;
- fmw M2/M4 and bos B5 killed by added error-contract pins (test-only changes);
- 44 stale anchors re-based under TR4-R14 across six harnesses; two stale EQUIVALENT
  entries corrected (branch-profile F11, security S9); security S10 retired OBSOLETE;
- the mutation gate reports 18 passed · 0 failed · 0 INVALID, and the implementing agent
  also implemented residual R-1 (no-class revenue bucket + ledger reconciliation test)
  in the handoff commit itself.

Under the Owner ruling, **all of the above is the implementing agent's claim, not an
independent finding**. The verdicts file's own §0 concedes the point: the decision to
accept them was never a structurally separate one. Your task is to treat every one of
those dispositions as a hypothesis and verify or refute it with **your own executions**.
Where you confirm, enter the disposition as yours with your own evidence; where you
refute, report a real gap for coverage repair — do not silence it (package §0, rule 4).

## 3. Handoff baseline (measured on this tree, 2026-08-22, by the implementing agent)

Environment reproduction (exact): `npm ci --no-audit --no-fund` at root; in `server`,
`npm_config_nodedir=/usr/local npm ci --no-audit --no-fund` (better-sqlite3 build env;
a plain `npm ci` fails on this host class). Node v22.22.3, npm 10.9.8.

| Gate | Command | Result measured at handoff |
|---|---|---|
| Release gate | `npm run release:validate` | **22 passed · 0 failed · 0 skipped** (exit 0) |
| Server suite | `cd server && npm test` | **2844 passed · 162 skipped · 0 failed** (exit 0) |
| Mutation gate | `npm run audit:mutation` | **18 passed · 0 failed · 18 surviving (all documented registry members) · 5 obsolete · 0 INVALID — MUTATION GATE PASSED** (exit 0) |

These numbers are the implementing agent's measurement of the tree you receive —
**reproduce them yourself before any deeper review** (package §1). Read harness exit
codes from the process, never through a pipe (D-155 records the failure mode that rule
prevents).

## 4. The remit

**A. Verify every registry classification on the current tree, by execution.** For each
harness (`server/scripts/*-mutation-test.mjs`): re-run it; for every member of its
`EQUIVALENT` set and `OBSOLETE` registry, re-establish the written reason by your own
execution or construction-proof. The package's Group R/W/E method sections (storage
affinity + read normalization; per-mutant API-surface diffs; the J10 probe) describe the
techniques; use them or better ones.

**B. Verify the kills added since the package** (fmw M2/M4 error-contract pins, bos B5
reserve-guard pin, the re-based anchors of invoice-integrity, branch-profile-fee,
bos-profit-withdrawal, security-grant-escalation, journey-discount-authority,
exam-certificate-fee): each anchor must apply exactly once and each kill must be a
genuine suite failure under the mutant, not a vacuous pass.

**C. Cold review per §71** of the WP-07 finance surface and its consumers: diff,
architecture, tests, evidence, invariants, security, finance, repository cleanliness —
looking specifically for defects the author's reviews missed. The dossier's highest-value
questions (`WP-07-TR4-independent-review-dossier.md` §4) still apply, minus the items
settled since.

**D. Advise on discharge and certification.** Open items for your advice: TR-4 Stage 3
(decision-rationale review — deliberately not begun); TR4-R10/TR4-R11 (predicate
consolidation); TR4-R13 (cross-surface §77 runtime agreement test); the dead export
`getStudentScholarshipSettled` check (`docs/work-packages/WP-07-TR4-independent-reviewer-package.md`
§4 lists these); residuals R-2 (`payments.semester` retirement) and R-3 (AR-1
spot-checks). Then: does WP-07 certify per §73/§74 — READY, READY WITH TRACKED RISK, or
NOT READY — and is TR-4 discharged?

## 5. Rules of disposition (unchanged from the package §0)

1. Classify a survivor ONLY with a written reason, established **by execution or by
   construction-proof** — never by inspection alone. Harness `EQUIVALENT` sets and
   `OBSOLETE` registries may be edited only with such a reason citing your evidence.
2. Anything you cannot prove equivalent is a **real gap**: report it for coverage repair.
   Do not silence it.
3. Keep the repo recoverable at every step: every probe restores its file; `git status`
   clean and the release gate green when you finish, exactly as the verdicts file §1/§4
   method requires.

## 6. Deliverable

Write your verdicts to `docs/work-packages/WP-07-TR4-independent-review-verdict-INDEPENDENT.md`
(or a name you prefer under `docs/work-packages/`), containing: per-mutant dispositions
with your executed evidence; findings beyond the mutation surface; your advice on TR-4
discharge and WP-07 certification; and an explicit statement of what you did and did not
consult. Update the TR-4 risk row in `docs/registries/decisions.md` with the outcome.

## 7. Implementing agent's position

Stopped at this handoff, per §105 and the Owner ruling. It will answer factual questions
about where artifacts live, but it will not propose dispositions for this review, and it
records no §R exception. **TR-4 remains OPEN until your execution-backed verdict lands.**
