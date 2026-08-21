# WP-07 · TR-4 — Independent review: status, machine findings, and reviewer dossier

**Protocol:** §65 · §103 EVIDENCE · §105 STOP · LAW 6 · TR-4
**Date:** 2026-08-21 · **Baseline:** `0ba9fbe` (release gate 22/22)
**Status:** **TR-4 IS NOT DISCHARGED.** Nothing in this document is an independent review.
**Implementation:** none. No source, schema or test was changed to produce this.

---

## 1. The honest answer first

The owner asked for *"a genuinely independent review… the reviewer must not be
the implementing agent."*

**I am the implementing agent. I cannot satisfy that requirement, and I will not
produce a document that pretends otherwise.** Every WP-07 slice A–L, every
decision D-101…D-153, every test and every certification record in this work
package was written by me. A review I author is self-review — which is precisely
what TR-4 records as an *unmitigated, structural* risk.

This session has already produced direct evidence that self-review fails here:

* the **F-18b analysis I wrote was materially wrong** (D-152) — its probe subtracted aid in its own arithmetic and reported a figure production never produced. I found it only because implementing forced me to read the query;
* the **first money-boundary guard I wrote in C-2 was useless** — `\bfee\b` never matches inside `surchargeFee`. It passed 27/27 and caught nothing until a mutation exposed it.

Two self-authored artifacts, both green, both wrong. That is the argument for
TR-4, made by this work package against itself.

**What I can do, and have done:** replace opinion with machine verdicts wherever
possible, and prepare a dossier so a real reviewer can work cheaply. §3 contains
findings produced by harnesses **I did not write**, whose verdicts do not depend
on my judgment.

---

## 2. What would discharge TR-4

A reviewer who did not author the work, with repository read access, executing
§4's dossier and producing findings against §5's scope. Any of:

1. a second engineer;
2. a different model/agent session, given the dossier and explicitly forbidden from consulting this session's reasoning;
3. a staged review where the reviewer sees only the artifacts (code, tests, gate output) and not the decision register's justifications, so the code is judged on its own.

Option 3 is the strongest available without a second human, because the failure
mode above was self-consistent reasoning, not missing information.

---

## 3. MACHINE FINDINGS — judgment-free, reproducible

The repository contains **18 mutation harnesses** under `server/scripts/*-mutation-test.mjs`,
written before this work package. Each restores a known defect and requires the
suite to fail. Their verdicts are objective. I ran the five that cover WP-07's
surface.

```
finance-money-writer               exit=1   5/11 killed · 2 equivalent · 6 SURVIVED
invoice-integrity                  exit=0   8/15 killed · 2 equivalent · 0 survivors
funding-amount                     exit=1   6/11 killed · 2 equivalent · 3 SURVIVED
discount-authorization             exit=0  14/14 killed · 0 survivors
journey-discount-authority         exit=1   4/10 killed · 1 equivalent · 1 SURVIVED
```

### TR4-F1 — SEVERITY HIGH · no gate runs any mutation harness

**FACT.** `grep -rn "mutation" scripts/release-validate.mjs .github/workflows/ci.yml package.json server/package.json`
returns **nothing**. The 22-check release gate does not execute a single one of
the 18 harnesses, and neither does CI.

They are the only artifacts in this repository that test whether the *tests*
work. Nothing executes them, so they rot silently — and §3 shows three of five
already have.

### TR4-F2 — SEVERITY HIGH · `funding-amount` has 3 live survivors, PRE-EXISTING

Survivors: **F1** *(insert the raw body value instead of the validated one — the
original defect)*, **F3**, **F7**.

**Causation determined — not mine.** Both the suite the harness runs
(`funding-amount-integrity.test.ts`) and the sponsorship CREATE handler are
**unchanged since the WP-06 baseline** `d29554b`:

```
git diff --stat d29554b..HEAD -- server/src/tests/funding-amount-integrity.test.ts   → empty
git diff       d29554b..HEAD -- server/src/routes/funding.routes.ts | grep validatedMonthly → empty
```

So the funding-amount safety net has been broken since at least WP-06 and no
gate noticed. This is a finding **about the repository**, inherited by WP-07,
not caused by it.

### TR4-F3 — SEVERITY MEDIUM · `finance-money-writer` has 6 survivors, CAUSATION UNDETERMINED

Survivors: M2, M4, M6, M10, M11, M13.

The suite it runs (`finance-money-writer-parity.test.ts`) **was** modified by me
(slice F added `purpose` and a line item to `mkInvoice`; a refund-attribution
helper was added). Inspection of that diff shows the changes are **additive
fixtures — no assertion was removed**.

A plausible explanation is that WP-07 added stronger upstream guards
(`assertInvoicePurpose`, `assertInvoiceHasLines`, allocation writes), so several
mutants no longer change any observable outcome and have become *equivalent*.
**I have not proven that, and I will not assert it.** Deciding whether these six
are equivalent mutants or genuine coverage loss requires running the harness
against the `d29554b` tree — which is exactly the kind of judgment call that
should not be made by the author.

**→ Referred to the reviewer as the single highest-value item in this dossier.**

### TR4-F4 — SEVERITY LOW · `journey-discount-authority` survivor J10, likely caused by D-140

J10 = *"pass the raw body value to the service instead of the validated one"*.

D-140 moved `assertMoney` **into** `EnrollmentService.enroll`, the point every
caller converges on. If the service now parses the value itself, the route-level
parse is defence-in-depth and removing it changes no observable outcome — which
would make J10 an equivalent mutant *created by a hardening change*.

That reading is plausible and I authored the change, so it needs confirmation by
someone else. If correct, the harness's `EQUIVALENT` set should gain J10 with
the reason recorded; if wrong, it is a real gap.

---

## 4. Reviewer dossier — how to execute this review

**Scope:** WP-07 Finance, slices A–L, decisions D-101…D-153.

**Reproduce the baseline state**
```
npm ci --no-audit --no-fund
cd server && npm ci --no-audit --no-fund
npm run release:validate            # expect 22 passed · 0 failed · 0 skipped
cd server && npx vitest run         # expect 2828 passed · 162 skipped · 0 failed
```

**Re-run the objective harnesses**
```
cd server
for m in scripts/*-mutation-test.mjs; do node "$m"; echo "$m exit=$?"; done
```
Note: capture the **node** exit code. Piping to `tail` masks it — that mistake
made three failing harnesses look green earlier in this session.

**Highest-value questions, in priority order**

1. **TR4-F3** — are the six `finance-money-writer` survivors equivalent, or lost coverage? Decisive method: run that harness against `d29554b` and compare.
2. Does each of D-127, D-128, D-131, D-136, D-141, D-146, D-150, D-151 have a test that **can fail**? Mutate the authority and confirm.
3. Are the money authorities genuinely single? `getSemesterTuitionPaid`, `getBranchOutstanding`, `getObligationCashSettled`, `getObligationAidSettled`, `AID_SOURCE_KINDS_SQL`, `partitionFeeSnapshot`, `TUITION_FEE_TYPES`, `invoicePaymentAttribution` — is any rule expressed twice?
4. Is the C-2 disposition sound? 25 remain / 1 retired / 9 re-expressed, and the count corrected 409 → 580. Spot-check the Class-1 files the audit did **not** deep-read (AR-1).
5. Does any surface still disagree about money? Compare student profile, roster, BOS dashboard and operations report for one student with cash, a refund, a scholarship and a sponsorship.

**Artifacts to read**
* `docs/certification/WP-07-slices-A-B-finance-remediation.md` — slices A–L
* `docs/registries/decisions.md` — D-101…D-153
* `docs/work-packages/WP-07-*.md` — the five analyses, including the F-18b erratum
* `server/src/core/finance/`, `server/src/utils/studentBalance.ts`
* `server/src/tests/work-packages/wp07/` — 10 suites

**Known author bias to probe:** every "PROVEN" claim in the decision register was
written by the person who also wrote the test that proves it. Sample them.

---

## 5. Residuals carried into review (not defects found here)

| # | Item |
|---|---|
| R-1 | Slice-K residual — both BOS revenue reports `INNER JOIN classes`, so tuition for a class-less term appears in neither total |
| R-2 | `payments.semester` still written for display and refund attribution; retirement is the agreed follow-on |
| R-3 | AR-1 — 19 of the 26 C-2 Class-1 files were classified without a line-by-line read |
| R-4 | D-139 residual — an enrolment that creates no term bills its whole snapshot as one `other` document and creates no tuition receivable |

---

## 6. Recommendations — RECORDED, NOT IMPLEMENTED

Per the owner's instruction, nothing below is built until reviewed and approved.

| # | Recommendation | Rationale |
|---|---|---|
| TR4-R1 | Add the mutation harnesses to the release gate, or to a scheduled CI job | They are the only check on whether the tests work, and nothing runs them (TR4-F1) |
| TR4-R2 | Fix `funding-amount` F1/F3/F7 | A pre-existing hole in a money writer's safety net (TR4-F2) |
| TR4-R3 | Resolve TR4-F3 by differential run against `d29554b` | Determines whether WP-07 lost coverage; must not be decided by the author |
| TR4-R4 | If J10 is confirmed equivalent, add it to the harness `EQUIVALENT` set with the D-140 reason | Keeps the harness honest instead of permanently red |
| TR4-R5 | Do not certify WP-07 until TR-4 is discharged and TR4-F3 resolved | A certification signed only by the author is what TR-4 exists to prevent |
