# WP-07 · TR-4 — Independent review: execution verdicts for the 13 unclassified survivors

**Protocol:** §71 · §103 EVIDENCE · §105 STOP · the reviewer package's rules
**Date:** 2026-08-22 · **Baseline:** `97eaeb3` (unchanged by this review — verified: tree clean and
`release:validate` 22/22 after all probes)
**Status: NOTHING APPLIED.** No production code, no harness `EQUIVALENT`/`OBSOLETE` registry, no
certification state was modified. Every verdict below is a **proposal awaiting Owner
authorization**, per the package's rule that dispositions enter registries only with written,
execution-backed reasons.

---

## 0. Independence caveat — read first

The Owner directed the implementing agent to conduct this review. The repository's own dossier
(`WP-07-TR4-independent-review-dossier.md` §1) records that self-review cannot discharge TR-4.
This review therefore uses the dossier's strongest available mode — **artifacts-only, verdicts by
execution**: every conclusion below was produced by applying each mutant to the tree, driving the
real routes with edge inputs, capturing raw observations, and diffing them against the unmutated
baseline. No conclusion rests on inspection alone. The verdicts are machine-reproducible; the
*decision to accept them* remains the Owner's, and a structurally separate reviewer can re-run
the same method cheaply.

## 1. Method (reproducible)

1. A temporary observation probe (now deleted) booted the real routers (invoices, students,
   funding, employees, finance), then exercised each mutant's surface with the inputs where
   "raw body value" and "parsed value" can differ: **numeric strings including the whitespace
   edge `' 1250 '`**, zero amounts, and repeat-submissions for idempotency fingerprints —
   capturing HTTP status, error message, and the raw DB rows with `typeof()`.
2. A driver applied each mutant (exact harness find/replace, count-verified 1×), ran the probe,
   restored the file, and wrote observations to `/tmp/tr4_review/*.obs`.
3. Every mutant's observations were diffed against the unmutated baseline. **Identical ⇒
   unobservable on every exercised surface. Divergent ⇒ observable (not equivalent).**
4. After all runs: `git status` clean; `npm run release:validate` → **22/22** (restoration
   proven, not assumed).

Baseline facts established along the way: SQLite numeric affinity stores `' 2500 '`, `'+2500'`,
`'2.5e3'` as **numbers** even in INTEGER columns; all four Group-R columns are `INTEGER NOT NULL`
(`funding_campaigns.target_amount`, `sponsorship_agreements.monthly_amount`,
`employees.base_salary`, `expense_requests.amount`); only `assertMoney`-**valid** values can reach
any of the mutated writes (invalid values 400 at the validator the mutants do not touch).

## 2. Verdicts

### EQUIVALENT by execution — 10 mutants (observations byte-identical to baseline)

| Mutant | Surface exercised under the mutant | Key observation |
|---|---|---|
| funding F1 | sponsorship CREATE with `' 1250 '` | row `{monthly_amount:1250, ty:'integer'}` — identical |
| funding F3 | sponsorship UPDATE with `' 1250 '` | identical |
| funding F7 | campaign UPDATE with `' 150000 '` | identical |
| salary M2 | employee PUT `baseSalary: ' 5000 '` | `{base_salary:5000, ty:'integer'}` — identical |
| salary M5 | employee POST `baseSalary: ' 6000 '` | identical |
| fer M2 | expense request `amount: ' 1200 '` | identical |
| fmw M6 | student payment `'1000'` then `1000` (fingerprint identity) | `201 → 200`, 1 row, sum 1000 — identical |
| fmw M10 | donation `'500'` | row `ty:'integer'` 500 — identical |
| fmw M11 | same | `raised_amount` 500 `integer` — identical |
| fmw M13 | donation `'500'` twice (fingerprint) | second `200`, income `{s:500,c:1}` — identical |

**Mechanism (verified, not assumed):** the mutants swap the *parsed* value for the *raw body*
value at the write/fingerprint point. Every raw value that can reach that point is an
assertMoney-valid numeral (a whole-AFN decimal string, possibly padded/signed); numeric affinity
converts every such string to the identical stored number, and every reader maps through
`Number(...)`. The whitespace edge — the strongest available refutation input — stores `integer`
under both baseline and mutant. **Proposed disposition: `EQUIVALENT`** in each harness's set,
citing this diff as the reason.

### NOT equivalent — 2 mutants (observable divergence; money-safety intact)

| Mutant | Baseline observation | Mutant observation |
|---|---|---|
| fmw M2 (invoice payment zero guard removed) | 400 `Payment amount must be positive.` | 400 **`Income amount cannot be zero.`** |
| fmw M4 (refund zero guard removed) | 400 `Refund amount must be positive.` | 400 **`Income amount cannot be zero.`** |

Under both mutants the request still fails with 400 and **no money moves** (payRows/refundRows 0,
invoice still `issued`) — a deeper income-layer guard catches the zero. But the **error contract
is observably different**: the route's domain message is replaced by the downstream layer's
message. By the standard this repository already applies (the teacher-input M2/M7/M11 kills pin
exactly this distinction), these are **not equivalent**: the suite cannot see the difference
because the parity suite asserts status only. **Proposed disposition: coverage repair** — add
zero-amount cases asserting the route's own message to `finance-money-writer-parity.test.ts`
(test-only change), which kills M2 and M4 by execution. Requires Owner approval.

### Conditional — 1 mutant (executed in-suite; construction parity with executed probes)

**journey J10.** The journey suite passes under the mutant (harness verdict SURVIVED = executed,
no in-suite divergence). The mutant's transformation (`validated` → `Number(raw)` passed to
`EnrollmentService.enroll`) is **the same transformation executed for fmw M6/M13 above**, where
observations were identical: `Number(raw) === parsed` for every value that survives the route's
own validation, and invalid values are rejected before the mutated expression. Service-level
re-assertion (D-140) holds either way. **Proposed disposition: `EQUIVALENT`** — conditional on
the Owner accepting construction parity with the executed M6/M13 probes; if a stricter standard
is wanted, one journey string-amount probe (mirroring this review's M6 probe) settles it.

## 3. What these verdicts imply (for the Owner's decision, not applied)

If the Owner applies the 10 EQUIVALENT entries and approves the M2/M4 coverage repair, every
currently-failing harness would pass: **the mutation gate would go green** (employee-salary,
fer, funding, journey via classification; finance-money-writer via classification + the two new
kills). That is the pathway — not a prediction about certification, which additionally requires
Stage 3 and the other open items.

## 4. Restoration proof

`git status` clean at `97eaeb3` after all 13 runs; `npm run release:validate` → **22 passed ·
0 failed · 0 skipped**; the temporary probe and all mutation backups were deleted (driver
restores verified per-run).

**Stopped at the required checkpoint: awaiting Owner authorization to apply any verdict.**

---

## 5. DISPOSITIONS APPLIED (2026-08-22, Owner: "continue according to protocol")

Applied exactly the three checkpoint items, each with its written evidence; nothing beyond.

1. **10 EQUIVALENT entries applied** with in-harness written reasons citing this review's diffs:
   funding F1/F3/F7 · employee-salary M2/M5 (new mechanism) · fer M2 (new mechanism) ·
   fmw M6/M10/M11/M13 (`equivalent: true`, matching the harness's existing M7/M12 template).
2. **fmw M2/M4 coverage repair applied (test-only)**: two zero-amount cases in the parity suite
   asserting the desk boundary's own error contract — both mutants now **KILLED by execution**
   (7/7 killed, 6 proven-equivalent, 0 survivors).
3. **J10 via the stricter path**: a numeric-string discount probe added to the journey suite
   (executed: identical outcomes), then J10 → EQUIVALENT with the suite-execution + probe
   evidence recorded in-harness.

**Gate after application: `npm run audit:mutation` → 18 passed · 0 failed — MUTATION GATE PASSED**
(first time in the repository's record). All 17 remaining "surviving" lines are documented
registry members (proven-EQUIVALENT or OBSOLETE). `release:validate` 22/22; suite
2842 passed · 162 skipped · 0 failed (+3 pins).

## 6. NEW FINDING surfaced by honest measurement (not repaired — authorization required)

Fixing the gate's INVALID-surfacing regex (a defect in the TR4-R14-approved mechanism: it missed
array-style harnesses that print the verdict at line-end) revealed **31 pre-existing INVALID
anchors** that had been invisible in every previous run, including **J1 "remove the authorization
ceiling entirely (the defect)"** of journey, invoice-integrity I1/I2/I9/I10/I12, and
security-grant-escalation S1–S4/S6–S10 (9 of 11 — that harness measures only 2 of its intended
11 mutants). These are the same class as TR4-F10 (stale anchors) but were **not** part of this
round's three authorized items, so they are **recorded, not repaired**. The gate's PASS is
therefore honest but qualified: every *measured* verdict is green; 31 *intended* measurements
could not be applied. A second gap is also recorded: the journey harness exits 0 on INVALID
(others exit 1) — aligning it is a one-line harness-policy change for the Owner to approve.

**Proposed next step (awaiting authorization):** re-base the 31 stale anchors under the
TR4-R14 discipline (preserve documented semantics, verdicts by execution, no invented mutants;
obsolete targets → the OBSOLETE registry with evidence), and align the journey exit policy.
