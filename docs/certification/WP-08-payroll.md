# Certification — WP-08 Payroll

**Work Package:** WP-08 Payroll — teacher and employee payroll behavior hosted by
`server/src/routes/teachers.routes.ts`
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§42, 49, 53, 58–74,
95–101 and §W
**Pre-repair baseline:** `3e5683dcadbd4f995100e754ef2b70570e8b9053`
**Checkpoints:** `173ba66` (attack evidence), `a72f0ea` (second schema/financial checkpoint)
**Date:** 2026-08-22
**Status:** **READY WITH TRACKED RISK** — bounded WP-08 certification

> This certification covers payroll only. It does not certify teaching-work
> assignment (WP-05), generic configuration authoring (WP-01), the report
> catalog as a whole (WP-11), finance/invoice redesign (WP-07), or the full
> product. The payroll report consumer is included only where it must represent
> the WP-08 facts correctly.

## SCOPE AND AUTHORITIES

Included:

- teacher and employee payment, retry, correction and envelope debit behavior;
- canonical Shamsi payroll periods and rule-evaluation failure behavior;
- employee transfer target scope;
- ledger / financial-transaction linkage, correction lifecycle and immutable
  storage backstops;
- payroll report reconciliation; and
- the teacher payment UI/API contract.

The authority map is registered in `canonical-authority.md`:

```text
Payroll.Edit + authorized person and target branch
  -> canonical payroll period
  -> teacher due calculation or employee validated amount
  -> idempotency candidates for the same business event
  -> guarded payroll-envelope debit
  -> linked expense transaction + posted salary ledger fact
  -> audit / notification

Correction
  -> signed contra transaction + budget restoration
  -> posted → voided ledger transition with actor and reason
```

`budget_lines.payroll_target` identifies the envelope. A teacher salary ledger
and employee salary ledger are the payroll facts; each is linked to the expense
transaction that dates and explains it. The browser is a consumer: it no longer
offers a teacher advance, because a capped teacher advance is a partial payment
of salary already earned. Employee advance remains the owner-approved genuine
advance and is classified as a non-expense cash movement.

## VERIFY

The unmodified baseline was inspected on the required branch and verified with
the project’s actual tooling before attack:

| Gate | Baseline evidence |
|---|---|
| Focused payroll suite | 9 files · **191 passed** |
| Full server suite | **175 files / 2844 passed / 162 explicit skipped** |
| Type checks | frontend and server production + test TypeScript passed |
| Lint | frontend passed with 11 pre-existing warnings and zero errors; server passed with zero errors |
| Canonical schema | **117 tables / 251 indexes / 127 triggers**; standalone, sound and idempotent |
| Product/static/protocol/registry/design/logging/cleanliness/dependency audits | all passed |
| Frontend and server builds | passed; first-paint bundle was **495 KB / 560 KB** budget |

The initial focused run required rebuilding the sandbox’s skipped native
`better-sqlite3` binding after an `--ignore-scripts` install. That was an
execution-environment correction, not a source change; no passing test result
is claimed from the failed binding load.

## ATTACK

The initial dedicated attack suite was intentionally run against the baseline
and failed **9/9**. It established the following defects with executable
counterexamples:

| ID | Attack | Baseline result | Repair |
|---|---|---|---|
| A-1 | Teacher retry crossing the 90-second derived-key boundary | second debit, ledger row and expense | both writers now consume current + prior idempotency candidates |
| A-2 | Employee retry crossing that boundary | second debit, ledger row and expense | same candidate consumption on employee payroll |
| A-3 | Reissue after a teacher void with the same key | 201 false replay; no new payment | posted-only idempotency uniqueness and lookup; correction may post a new live fact |
| A-4 | Object-valued employee payroll period | 201 and a noncanonical ledger period | strict canonical period resolver at every payroll edge |
| A-5 | Invalid `computed-salary` period | silently calculated the current period | supplied invalid periods are 400 |
| A-6 | Malformed active payroll rule | neutral multipliers substituted and money paid | typed rule-configuration failure becomes a 409 with no residue |
| A-7 | Branch-scoped manager transfers employee to foreign branch | 200 cross-branch mutation | target branch uses `canAccessBranchResource` |
| A-8 | Direct negative teacher ledger write | accepted by SQLite | canonical positive whole-AFN ledger trigger |
| A-9 | Duplicate teacher covering index | two identical `(teacher_id, period_key, paid_at)` indexes | C-18 WP-08 duplicate removed |

A final authority probe found A-10: a keyed teacher retry returned
`previouslyPaid = due − paid`, inventing a prior payment. The focused assertion
failed **1/1**. New ledger rows preserve the settlement snapshot used for the
original response; a retry returns that snapshot. Rows without a snapshot derive
a conservative current posted-period position.

## REPAIR AND REVERIFY

The dedicated final WP-08 set passed **12 files / 212 tests**:

- historical payroll, teacher/employee input and compensation suites;
- `payroll-certification.attack.test.ts` — **10/10**;
- `payroll-certification.review.test.ts` — **9/9**.

The complete suite was then run from a fresh temporary `DB_PATH`, not the
accumulated workspace test database:

```text
DB_PATH=<fresh temp>/erp.sqlite NODE_ENV=test npm test
177 files passed · 2863 tests passed · 14 files / 162 explicit skips
```

The skipped cases are the repository’s explicitly retired WP-04 placement
knowledge records; **WP-08 has no skipped authority**.

Final canonical-schema preflight passed with **117 tables / 250 indexes / 136
triggers**, including idempotent reapplication, `integrity_check=ok` and zero
foreign-key violations. The final project release gate passed **22/22**:
static analysis, production builds, bundle budget, complete server suite,
canonical fresh install, non-trivial financial reconciliation, branding and
repository hygiene all passed.

Relevant mutation evidence also passed:

- `teacher-input-contract`: **9/9 killed, 0 survived, 0 invalid**;
- `employee-salary`: **5/5 killed**, with two separately documented equivalent
  storage-affinity mutants; and
- repository mutation gate: **18 harnesses passed, 0 failed, 0 invalid**;
  18 documented survivors and 5 documented obsolete mutants are reported by
  their own harnesses rather than silently ignored.

## INDEPENDENT REVIEW

A structurally separate cold review used a new review suite, read the storage
and report consumer rather than the implementation narrative, and found four
additional defects (**4/4 failing**) plus a linked-transaction delete attack
(**1/1 failing**):

1. employee correction columns existed without an authorized void command;
2. date-only report bounds excluded same-day `paid_at` timestamps;
3. a direct ledger insert could omit its financial transaction;
4. posted ledger facts could be directly changed or deleted; and
5. a linked original financial transaction could be deleted, orphaning payroll.

The repairs add employee voiding, report from the linked transaction’s canonical
accounting date, mandatory matching transaction checks, a narrow immutable
`posted → voided` state transition, and guards for linked original and contra
financial facts. The review suite now passes 9/9, including the frontend
contract check that the teacher modal cannot offer `advance`.

This was a cold review by the implementing agent, not a separate human or
session. That limitation is honestly recorded as repository risk **TR-4**;
executable findings mitigate it but do not erase it.

## CLEAN

- C-18’s WP-08 duplicate index is removed and the conflict registry updated.
- Direct test fixtures now create the matching financial fact rather than
  bypassing the new ledger invariant.
- The legacy inventory distinguishes its historical core from the two current
  WP-08 authority suites.
- No generated database, build output, test output, credential or temporary
  evidence is intended to be tracked.
- Source-cleanliness, dependency isolation, logging, static, registry,
  protocol, design-system and product audits are re-run in the release gate.

## CERTIFICATION MATRIX

| Dimension | Status | Evidence class | Evidence / remaining bounded risk |
|---|---|---|---|
| Architecture / authority | READY | PROVEN | D-163; authority and invariant registries; one envelope relation and linked fact chain |
| Payroll correctness | READY | PROVEN | 212 focused tests; A-1 through A-10; exact replay settlement snapshot |
| Database / data integrity | READY | PROVEN | 136-trigger preflight; direct negative/orphan/rewrite/delete attacks |
| Financial conservation | READY | PROVEN | guarded debit, linked expense, signed contra, budget restoration and report reconciliation |
| Concurrency / idempotency | READY | PROVEN | boundary-crossing retries, explicit-key scope, live-only uniqueness and correction reissue |
| RBAC / security | READY | PROVEN | source + target employee-transfer attack; server `Payroll.Edit` gates |
| API / error contracts | READY | PROVEN | malformed periods 400; malformed active policy 409; no financial residue |
| Reporting reconciliation | READY | PROVEN | same-day teacher/employee report assertions and void exclusion through linked accounting date |
| Frontend / UX | READY | SUPPORTED | Typecheck/build plus structural modal/API contract test; no claim of browser E2E automation |
| Reliability / correction | READY | PROVEN | teacher and employee void routes, atomic transaction, reason and second-void guards |
| Testing | READY | PROVEN | fresh-DB full suite, focused suite, adversarial and review suites, mutation evidence |
| Maintainability / cleanliness | READY | PROVEN | registries, static/dependency/cleanliness gates; no duplicate C-18 index |
| Operational readiness | READY for package | PROVEN | reproducible clean schema and release validation; broader production operations remain out of package |

## CERTIFY

**WP-08 Payroll is READY WITH TRACKED RISK.** No unresolved Critical or High
payroll defect remains in the defined scope: money writes, reversals,
idempotency, period truth, ledger integrity, target scope and report projection
all have direct executable evidence.

The only recorded qualification is TR-4’s same-agent review limitation. It is a
review-independence risk, not a known defect in the certified payroll behavior;
it remains explicitly visible rather than being represented as independent
external review. This certification does not advance any other Work Package or
assert full-product release readiness.
