# WP-07 · TR-4 — Mutation inventory (Stage 1 of the staged independent review)

**Protocol:** §65 · §103 EVIDENCE · LAW 6 · TR-4
**Date:** 2026-08-21 · **Baseline:** `00d98de` + TR4-R1
**Stage:** 1 of 3. Artifacts and machine verdicts only. **The decision register has deliberately not been consulted for this stage.**
**Classification status:** **every survivor below is UNRESOLVED.** None has been classified by the implementing agent.

---

## 1. TR4-R1 — delivered

| Item | State |
|---|---|
| `server/scripts/run-mutation-harnesses.mjs` | new runner; executes all 18 harnesses, reads the **process** exit code, prints survivors, exits 1 if any harness fails |
| `npm run audit:mutation` | added to `server/package.json` and proxied from the root |
| CI job `mutation-harnesses` | **NOT APPLIED — blocked.** Pushing `.github/workflows/*` is rejected for this identity without `workflows` permission. The job definition is handed to a human in `WP-07-TR4-ci-mutation-job.md`. This is the same constraint the deleted `ci/` directory once documented; the deletion was still correct, because those files described a *resolved* fix, but the permission limit itself is live |
| Harness assertions | **untouched** |
| `EQUIVALENT` sets | **untouched** — no survivor was classified to make the gate green |

**Why a separate CI job rather than a step inside `release:validate`:** the run
takes ~6 minutes and is currently RED for pre-existing survivors. Folding it in
would block every unrelated change behind it and create pressure to silence a
survivor — the one outcome that must never happen. The release gate remains
22/22 and the mutation gate fails visibly on its own.

**A method defect this runner fixes.** Piping a harness into `tail` returns
`tail`'s exit status. Earlier in this session that made three failing harnesses
look green. The runner reads `spawnSync().status`.

---

## 2. Authoritative run

```
npm run audit:mutation      →  9 passed · 9 failed · 32 surviving mutant(s)
```

Run on a verified-healthy tree (`npx vitest run` green, release gate 22/22
immediately before). **An earlier run in this session was invalid** — the
sandbox had pruned `node_modules`, so 8 harnesses aborted with
*"suite does not pass on unmutated code"* and reported nothing. Those numbers
were discarded, not reported.

| Harness | exit | survivors | documented equivalent |
|---|---:|---|---|
| book-sale-quantity | 0 | K4,K5,K6,K9 | K4,K5,K6,K9 |
| bos-profit-withdrawal | 0 | — | B6 |
| branch-profile-fee | 0 | — | F11 |
| class | 0 | — | — |
| discount-authorization | 0 | — | — |
| **employee-salary** | **1** | **M2, M5** | — |
| exam-certificate-fee | 0 | — | E3,E8 |
| **finance-expense-request** | **1** | **M2** | — |
| **finance-money-writer** | **1** | **M2, M4, M6, M10, M11, M13** | — |
| finance-operational-payment | 0 | — | — |
| **funding-amount** | **1** | **F1, F3, F7** (+F10,F11 documented) | F10,F11 |
| invoice-integrity | 0 | I3,I15 | I3,I15 |
| **journey-discount-authority** | **1** | **J10** (+J6 documented) | J6 |
| **placement-retake-fee** | **1** | **P4, P6, P7** (+P5 documented) | P5 |
| **rbac-authorization** | **1** | **M7** · also **7 INVALID mutants** | — |
| security-grant-escalation | 0 | — | S9 |
| **teacher-input-contract** | **1** | **M2, M7, M11** | — |
| **teacher-update** | **1** | **M7, M12** | — |

### **22 undocumented survivors across 9 harnesses — all UNRESOLVED**

```
employee-salary             M2, M5
finance-expense-request     M2
finance-money-writer        M2, M4, M6, M10, M11, M13
funding-amount              F1, F3, F7
journey-discount-authority  J10
placement-retake-fee        P4, P6, P7
rbac-authorization          M7
teacher-input-contract      M2, M7, M11
teacher-update              M7, M12
```

**Additional finding — TR4-F5:** `rbac-authorization` reports **7 INVALID**
mutants. An invalid mutant is one whose source pattern no longer matches, so it
was never applied. Seven of twelve RBAC mutants therefore test nothing, and the
harness silently reports a killed-ratio computed over the rest. Harness rot, not
coverage — but it means RBAC mutation coverage is substantially lower than the
tally suggests.

---

## 3. Causation — facts only, no classification

Objective `git diff` against the WP-06 baseline `d29554b`. This says whether
WP-07 touched the code or the suite; it does **not** say whether a survivor is
equivalent. That judgment is the reviewer's.

| Harness | Suite changed by WP-07? | Target source changed by WP-07? |
|---|---|---|
| funding-amount | **no** | **no** (sponsorship CREATE handler unchanged) |
| finance-money-writer | yes — additive fixtures only (`purpose`, `invoice_items`, refund attribution helper); no assertion removed | yes (invoices/students/funding routes) |
| journey-discount-authority | yes — a registration fee added so the D-138 ceiling basis is discriminated | yes (journey route, enrolment service) |
| employee-salary, teacher-*, rbac, placement-retake-fee, finance-expense-request | out of WP-07's scope | out of WP-07's scope |

**Reading of the table that is safe to state:** `funding-amount`'s three
survivors cannot have been caused by WP-07, because neither side changed. Every
other row is undetermined and is referred to the reviewer.

---

## 4. What Stage 1 did NOT cover

This stage is machine verdicts only. Still outstanding for TR-4:

* **Stage 2** — read the code, tests, schema and gate definitions **without** the decision register: are the money authorities genuinely single; does each authority have a test that can fail; does any surface still disagree about money.
* **Stage 3** — only then read the decision rationale and check each "PROVEN" claim against what Stage 2 found.
* Independent classification of all 22 survivors.

**TR-4 remains OPEN. No WP-07 certification is signed.**

---

## 5. Recommendations — recorded, NOT implemented

| # | Recommendation |
|---|---|
| TR4-R6 | Classify all 22 survivors: each becomes an `EQUIVALENT` entry with a written reason, or a coverage repair. None may be silenced in the runner. |
| TR4-R7 | Repair `rbac-authorization`'s 7 INVALID mutants — their patterns have drifted from the source. |
| TR4-R8 | Make an INVALID mutant fail its harness, not just be counted. A pattern that no longer matches is a test that silently stopped testing. |
