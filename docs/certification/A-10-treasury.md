# Remediation Record — A-10 Treasury Policy

**Scope:** Owner profit-distribution tiers, reserve invariant, warning thresholds, and publish/enforce authority  
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md`  
**Date:** 2026-08-21  
**Diff under review:** changes after checkpoint `74a9ad726974201e3c6003fa8a454dcc579924bd`

> This is an independent remediation checkpoint for A-10. It does **not** re-certify all
> of WP-07 and does not claim full-system certification. A-11 and other uncertified Work
> Packages retain their own readiness burden.

## Owner checkpoint

The owner supplied every business value that could not be derived from code:

- margin below 10% permits 0% distribution;
- 10–19.99% permits 5%;
- 20–29.99% permits 10%;
- 30% or more permits 15%;
- post-withdrawal `main_balance + saving_balance` must cover six months of fixed costs;
- main cash below three months of fixed costs warns;
- teacher performance below 80% warns; and
- no additional financial policy is introduced.

These decisions are recorded as D-61 and close A-10.

## Lifecycle record

| Stage | Outcome |
|---|---|
| SCOPE | Treasury policy declaration, current-month withdrawal calculation/enforcement, atomic cash mutation, warning boundaries, BOS presentation, tests and registries. |
| DISCOVER | The route carried the prior tier values, checked savings alone as the reserve, warned at two months, allowed the read endpoint to publish non-month ceilings, and retained a disconnected editable reserve rule. |
| MODEL | One executable ceiling is `MIN(remaining period allowance, main cash, total-liquidity headroom)`, where headroom is `MAX(0, main + savings − six-month target)`. |
| CHALLENGE | REPAIR, not rebuild. The ledger, finance-account storage, Shamsi period authority and whole-AFN authority remain valid; the defect was treasury policy and duplicated/divergent decision logic. |
| DECIDE | Apply the exact owner values in `TREASURY_DEFAULTS`; centralize arithmetic in `computeProfitDistribution`; share one current-month input loader; enforce in an IMMEDIATE transaction. |
| CHECKPOINT | Owner answers obtained before implementation; no threshold or retention value was inferred. |
| IMPLEMENT | Policy catalog, finance authority, BOS routes, UI/API consumer, tests and executable registries updated. The disconnected rule-engine reserve guard was removed under D-18 rather than retained as a second authority. |
| VERIFY | Frontend and backend typechecks pass. Focused A-10 suite: 53/53. Focused suite including the repaired generic rule-engine test: 57/57. Registry audit passes. |
| ATTACK | Exact tier boundaries, loss, exact reserve, below reserve, reserve headroom, main-cash cap, cumulative drawings, exact ceiling, one AFN over, rejected-request no mutation, concurrent requests, non-month publish attempts, and warning boundaries were exercised. |
| REPAIR | Four review findings were corrected: non-month publishing, the duplicate editable reserve rule, a deferred rather than immediate write transaction, and post-commit notification insertion. The stale reserve-rule test was converted to a self-contained generic block-action test. |
| REVERIFY | `npm run release:validate`: **22 passed · 0 failed · 0 skipped**; canonical fresh install remains 111 tables with integrity and all financial reconciliation variances at zero. |
| INDEPENDENT REVIEW | Performed artifact-first from the diff, source searches, transaction boundaries and failing/green test evidence; findings below. Same-agent limitation remains TR-4. |
| CLEAN | Superseded tier/warning literals and savings-only reserve authority removed; metrics, assumptions, decisions, invariants and canonical-authority registries aligned. |
| CERTIFY | A-10 verdict below. |

## Independent review findings

| # | Question | Evidence | Result |
|---|---|---|---|
| A10-R1 | Can the API publish a ceiling for a different period than withdrawal enforces? | Cold read found the dashboard passed `today`/`year` to calculate while withdraw always used month. | **DEFECT, FIXED** — the withdrawal card always reads the current accounting month; non-month calculation requests return 400; UI labels the period explicitly. |
| A10-R2 | Is any second reserve policy still active or editable? | Repository search found `rule_default_reserve_guard` in the generic rule catalog although withdrawal did not consume it. | **DEFECT, FIXED** — removed. The rule-engine block behavior remains tested with a test-owned generic rule, not a treasury opinion. |
| A10-R3 | Are calculation, balance debit and post-condition protected by the same write lock? | The transaction wrapper used its default deferred mode. | **HARDENING, FIXED** — withdrawal invokes the transaction in IMMEDIATE mode before loading authority inputs. |
| A10-R4 | Can an operation commit and then return failure because its notification insert fails? | Notification insertion occurred after transaction commit. | **DEFECT, FIXED** — the notification is now inserted within the withdrawal transaction, so failure rolls back cash and ledger together. |
| A10-R5 | Does the published ceiling exceed executable cash or post-withdrawal liquidity headroom? | Direct authority tests and route-level exact-boundary tests. | **PASS** — ceiling is the minimum of all three limits, and the post-debit reserve is asserted again. |
| A10-R6 | Can two concurrent requests both spend one displayed ceiling? | Parallel route requests against one published ceiling. | **PASS** — exactly one returns 201 and one 409; one ledger row and one debit remain. |
| A10-R7 | Do rejected requests mutate cash or drawing totals? | Invalid, unauthorized, over-ceiling, reserve, margin and cash failures. | **PASS** — cash and drawing totals remain unchanged. |
| A10-R8 | Are all policy numbers owner-approved rather than inferred? | A-10 checkpoint compared with `TREASURY_DEFAULTS` and threshold tests. | **PASS** — exact 0/5/10/15 tiers, 6-month reserve, 3-month cash warning and 80% teacher warning; no additional financial policy. |

## Verdict

**A-10: READY WITH TRACKED RISK**

The treasury behavior is owner-resolved, has one published/enforced authority, preserves
post-withdrawal total liquidity atomically, and passes project release validation. The
tracked qualification is TR-4: the artifact-first independent review was performed by the
same agent. This verdict applies only to A-10; it does not certify all of WP-07, A-11, or
the full system.
