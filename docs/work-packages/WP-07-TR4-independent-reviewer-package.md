# WP-07 · TR-4 — Independent Reviewer Package

**Protocol:** §71 INDEPENDENT REVIEW · §44 · §103 EVIDENCE · §105 STOP · TR-4
**Date:** 2026-08-22 · **Baseline for review:** `0f579bb` (tree clean, remote in sync)
**Status: TR-4 IS NOT DISCHARGED. WP-07 IS NOT CERTIFIED.**
**Purpose:** everything a reviewer who did **not** author this work needs to dispose of the last
13 unclassified mutation survivors and advise on discharge. Prepared by the implementing agent;
**no disposition in this package is final until the reviewer confirms it.**

---

## 0. Rules for the reviewer (from the dossier, unchanged)

1. The reviewer must not be the implementing agent. A second engineer, or a different
   model/agent session given this package **without** this session's reasoning, both qualify.
2. Strongest available mode: **artifacts only** — read code, tests, harnesses, gate output and
   this package; do **not** consult the decision register's justifications (D-101…D-157) until
   your verdicts are written, so the code is judged on its own.
3. Classify a survivor ONLY with a written reason, established **by execution or by
   construction-proof** — never by inspection alone. Mechanisms: the harness's `EQUIVALENT` set
   (unobservable mutant) or `OBSOLETE` registry (target no longer exists). Neither may be edited
   silently; every entry cites its evidence.
4. Anything you cannot prove equivalent is a **real gap**: report it for coverage repair. Do not
   silence it.

## 1. Reproduce the baseline

```bash
npm ci --no-audit --no-fund                 # root
cd server && npm_config_nodedir=/usr/local npm ci --no-audit --no-fund   # better-sqlite3 build env
cd .. && npm run release:validate           # expect 22 passed · 0 failed
cd server && npm test                       # expect 2839 passed · 162 skipped · 0 failed
cd .. && npm run audit:mutation             # expect 13 passed · 5 failed · 23 surviving · 4 obsolete
```

The 23 "surviving" lines include **10 pre-existing registry members** (K4–K9, I3/I15, J6, P5,
F10/F11) and the **13 unclassified** below. Per-harness exit codes are read from the processes,
not from pipes.

## 2. The 13 unclassified survivors

### Group R — raw-vs-parsed writers (6) · PROPOSED: equivalent by storage affinity + read normalization

| Mutant | Harness / suite | What it does | Probe that survives it |
|---|---|---|---|
| F1 | funding-amount / `funding-amount-integrity.test.ts` | sponsorship CREATE inserts the raw body value (the original defect) | `stores a numeric string as a number` — `'750'` sent, DB `typeof = integer`, value 750 |
| F3 | same | sponsorship UPDATE writes raw | `stores a numeric string on update as a number, never as TEXT` |
| F7 | same | campaign UPDATE writes raw | `stores a numeric string target on update as a number, never as TEXT` |
| M2 | employee-salary / `employee-salary-validation.test.ts` | employee PUT writes raw | `stores a numeric-string salary update as a number` (+ `salaryTypeOf`) |
| M5 | same | employee POST inserts raw | `creates an employee from a numeric-string salary as a number` |
| M2 | finance-expense-request / `finance-expense-request-integrity.test.ts` | expense INSERT stores raw | pre-existing `accepts a legitimate amount (numeric string)` + `amountClassOf === 'integer'` |

**Mechanism (verify, don't trust):** every write targets a numeric-affinity column
(`funding_sponsorships.monthly_amount`, `funding_campaigns.target_amount`, `employees.base_salary`,
`expense_requests.amount` — check `src/db/schema.sql`), so an assertMoney-**valid** raw string is
stored byte-identically to the parsed number; every read path re-maps through `Number(...)`
(check the routes' mappers). Only assertMoney-valid values can reach the write (invalid ones 400
first), and every such string losslessly affinity-coerces.
**Refute by:** finding any reader of those columns that reproduces raw storage type verbatim
(JSON/CSV export, report writer) — grep for direct column reads lacking `Number()` normalization.
**If confirmed:** add each to its harness `EQUIVALENT` set with this reason, citing the probe test.

### Group W — finance-money-writer (6: M2, M4, M6, M10, M11, M13) · UNDETERMINED — referred to you

Harness runs `finance-money-writer-parity.test.ts`; 5/11 killed, 2 proven equivalent, these 6
survive. History (dossier TR4-F3): the suite was modified by the author (additive fixtures only,
per diff inspection — verify); the WP-07 hardening (`assertInvoicePurpose`, `assertInvoiceHasLines`,
allocation writes) plausibly made several mutants unobservable **upstream**; the dossier's decisive
differential against `d29554b` is **impossible in this clone** (squashed root `381c400`).
**Candidate method:** for each mutant, apply it (`node scripts/finance-money-writer-mutation-test.mjs --only M…`),
then diff every API surface the suite exercises (response bodies, ledger rows, invoice fields,
allocation rows) against the unmutated tree. Observable delta → real gap (report for coverage
repair). No delta on any surface → EQUIVALENT with the executed comparison recorded.

### Group E — journey J10 (1) · PROPOSED: equivalent by D-140 defence-in-depth

`J10` passes the raw body value to `EnrollmentService.enroll` instead of the validated one.
Hypothesis (dossier TR4-F4): D-140 moved `assertMoney` **into** the service, so the route-level
parse is defence-in-depth and removing it changes nothing observable. **Confirm by execution:**
apply the mutant, drive every `journey-enrollment-discount-authority.test.ts` scenario plus a
direct service call with a string amount, and inspect for any divergence. Confirmed → EQUIVALENT
with the D-140 reason; refuted → real gap.

## 3. Already settled (context — not for re-litigation)

- **4 OBSOLETE** (documented in-harness): rbac M1/M12 (legacy fallback absent; successor
  enforcement KILLED as M2/M3), rbac M7 (subsumption proof + approved production simplification,
  `hasPermission` removed — never classified equivalent), teacher-update M14 (subject removed by
  decision D-23; successor M15 now KILLED).
- **All reject-path survivors killed this cycle:** placement P1/P2/P3/P6; teacher-input
  M2/M7/M11; teacher-update M7/M12/M15. Harness scorecard movement: 9→13 passing.
- Gate message remains red **by design** until Groups R/W/E are disposed.

## 4. Open items beyond survivors (context for the discharge advice)

| Item | Recorded at |
|---|---|
| TR4-R10 `TUITION_NET_SQL` used inside its own module (4 inline copies) | stage-2 review |
| TR4-R11 cash-allocation predicate shared as `CASH_ALLOCATION_SQL` (3 copies) | stage-2 review |
| TR4-R13 cross-surface runtime test (cash + refund + scholarship + sponsorship agreement, §77) | stage-2 review |
| Dead export `getStudentScholarshipSettled` (`core/finance/obligations.ts`) | TR4-R9 follow-up |
| Residuals R-1…R-4 (BOS class-less revenue, `payments.semester` retirement, AR-1 spot-checks, D-139 other-document enrolment) | dossier §5 |
| TR-4 **Stage 3** — decision-rationale review | deliberately not begun |

## 5. Commit map for this TR-4 cycle

`381c400` (squashed root / Stage-2 record) → `04ece70` (TR4-R9+R12) → `1b8ed39` (two structural
findings) → `e0a820b` (F10/F11 checkpoint) → `3064c82` (TR4-R14 measurement integrity) →
`74a1ecc`/`030c1e6` (disposition approvals) → `a457ab5` (Bucket 2) → `8cba3e4` (Bucket 1 + M7
simplification) → `0f579bb` (Bucket 3 Class C+R) → this package.

**Hand-off: the reviewer's verdicts on Groups R, W and E are the last unclassified inputs to TR-4.**
