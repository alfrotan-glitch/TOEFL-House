# Certification — WP-09 Funding & Impact

**Work Package:** WP-09 Funding & Impact (`funding`, `impact`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§16–18, 22–23, 28,
33–42, 49–54, 58–76, 84, 90–93 and 95–101

**Checkpoint / recovery baseline:** `e9accab` (`recover: preserve WP-05 and WP-08 worktree`)

**Date:** 2026-08-23

**Status:** **READY WITH TRACKED RISK** — bounded WP-09 certification

> This certificate covers Funding & Impact only. It does not certify WP-07
> Finance as a whole, WP-08 Payroll as a whole, Reporting & Analytics as a
> whole, or the complete product / production release.

## Scope and decisions

The Owner decisions D-165 through D-169 establish the package boundary:

- a restricted donation has one structured, mandatory Campaign, Scholarship or
  Sponsorship target; free text is never an authority;
- donor/campaign reports claim only source-traceable facts, never branch-wide
  pooled impact;
- manual Impact Metrics and Success Stories are retired rather than becoming a
  second reporting truth;
- authorization is permission based: Finance may record donations but has no
  broader Funding or Impact mutation authority; and
- unspent terminal sponsorship balance returns to the linked Campaign as a
  restricted non-cash monetary fact, or terminal transition fails.

No WP-08 logic was altered during the WP-09 model. A separately discovered
blocking salary-status query regression was repaired narrowly under D-172:
`month` and the established `monthName` spelling now resolve through one payroll
period parser. The targeted payroll history authority and the full suite pass.

## Final architecture

```text
Donation cash receipt
  -> one linked income transaction and receipt number
  -> optional structured restriction
       Campaign    -> campaign funding entry
       Scholarship -> scholarship funding
       Sponsorship -> sponsorship receipt
  -> source-aware tuition application
       scholarship award + scholarship funding id
       sponsorship agreement + sponsorship receipt id
  -> exact donor/campaign Impact snapshot
```

`financial_transactions` remains the cash authority. A campaign funding entry
is an immutable, non-cash allocation fact: it identifies a donation or returned
sponsorship receipt, target campaign, amount, actor and reason. It never writes
a second income/expense row, so campaign returns cannot mint or duplicate cash.

`scholarship_fundings` and `sponsorship_receipts` each name exactly one direct
donation or campaign funding entry. Aid allocations in `obligation_allocations`
name the exact received source. This makes capacity enforceable at rest and
makes report attribution demonstrable rather than inferred.

The impact service stores immutable snapshots with a canonical Shamsi period,
resolved date range, branch/donor/campaign scope and derived metrics only:

- donations received;
- scholarship aid applied to tuition;
- sponsorship aid applied to tuition; and
- students with source-traceable aid applied.

## Attack and repair evidence

The new WP-09 authority was first run against the pre-implementation state and
failed on the intended missing properties: no donation transaction link, no
structured target materialization, no source identity on aid allocation, no
campaign-return fact, and pooled Impact report metrics. The completed authority
now passes **10 files / 49 tests**, including:

- selected-branch donation and linked-income branch correlation;
- Finance-only donation recording and Funding/Impact permission separation;
- structured restriction creation, direct-write resistance and immutable facts;
- exact scholarship/sponsorship received source for tuition application;
- donor/campaign report isolation and Shamsi period agreement;
- partial scholarship-close accounting, closed-award reversal refusal and
  concurrent award ceiling;
- terminal sponsorship return to Campaign / unresolved-balance refusal;
- direct schema attacks for cross-branch and source corruption; and
- frontend contracts for server-rendered totals, source controls, scope-aware
  Impact reports and the single event-notification path.

The original mutation gate exposed stale Funding anchors after the reconstruction
and the Finance harness still referenced the moved donation implementation.
Those measurement defects were repaired rather than ignored. The final mutation
gate passes **18 harnesses / 0 failed / 0 invalid**. The funding harness reports
three killed mutants and one execution-proven equivalent raw-write mutant: the
validator runs before that write and SQLite INTEGER affinity stores every
reachable validated numeric string/number identically.

## Verification

Executed after the final repair:

| Gate | Result |
|---|---|
| WP-09 focused authority | `npx vitest run src/tests/work-packages/wp09 --no-file-parallelism` — **10 files / 49 tests passed** |
| Blocking WP-08 dependency | `npx vitest run src/tests/teacher-history-integrity.test.ts` — **5 tests passed** |
| Full server suite | `npm test` — **196 files passed / 2775 tests passed / 14 files and 162 explicit legacy-placement cases skipped** |
| Server typecheck/lint/build | passed |
| Frontend typecheck/lint/build | passed; lint has only eight pre-existing warnings outside WP-09, no errors |
| Canonical schema | `npm run preflight:fresh-schema` — **117 tables / 263 indexes / 175 triggers**, standalone, sound and idempotent |
| Registry / protocol / static / product / design / logging / dependency / cleanliness audits | passed |
| Mutation gate | **18 harnesses passed / 0 failed / 0 invalid** |

## Cold review

A structurally separate review pass read the final data graph, route boundaries,
source-capacity triggers, UI contract and mutation output rather than relying on
implementation intent. It found and repaired:

1. a partially applied closed scholarship award could re-open money already
   applied to tuition;
2. a terminal sponsorship could lock an unspent receipt with no disposition;
3. Funding/Impact mutation policy was role-name based rather than permission
   scoped;
4. a donor/campaign report stored scope identity while showing whole-branch
   figures; and
5. idempotency replay did not compare a structured restriction target.

`funding-impact.review.test.ts` adds final direct-storage and report-snapshot
checks. This is still a same-agent cold review, not an independent external
review; the limitation remains tracked as TR-4.

## Certification matrix

| Dimension | Status | Evidence class | Evidence / bounded risk |
|---|---|---|---|
| Domain correctness | READY | PROVEN | structured target/source model, 51 focused tests and real HTTP flows |
| Data integrity | READY | PROVEN | exact-one checks, FKs, capacity/scope/immutability triggers and direct attacks |
| Financial conservation | READY | PROVEN | one donation income fact; non-cash aid/return facts; source and report reconciliation |
| RBAC / security | READY | PROVEN | `Funding.RecordDonation`, `Funding.Edit`, `Impact.Edit`; branch and direct endpoint tests |
| API / reliability / idempotency | READY | PROVEN | semantic replay checks including restriction identity; terminal guarded transactions |
| Reporting correctness | READY | PROVEN | source graph, Shamsi period and donor/campaign isolation attacks |
| Frontend / UX | READY | SUPPORTED | typed production build and structural contract authority; no browser E2E claim |
| Concurrency | READY | PROVEN | source/fund capacity transaction and concurrent award attacks |
| Repository / test hygiene | READY | PROVEN | WP-09 legacy authority rebased; static, cleanliness and mutation gates pass |
| Review independence | TRACKED RISK | SUPPORTED | same-agent cold review is not independent external review (TR-4) |

## Verdict

**WP-09 Funding & Impact is READY WITH TRACKED RISK.** The bounded Funding and
Impact model is verified for source traceability, money integrity, authorization,
report scope, terminal sponsorship return and server-state behavior. The only
certification qualification is the project-wide TR-4 review-independence risk.
This verdict does not represent the entire TOEFL House product as production
ready.
