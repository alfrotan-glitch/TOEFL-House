# Certification — WP-07 Finance

**Work Package:** WP-07 Finance (finance category taxonomy, budget model, ledger classification)
**Protocol:** Engineering Protocol v2
**Diff under review:** `0d243e9..4b8ad0e` plus the review follow-up in this pass
**Date:** 2026-08-20

---

## Lifecycle record

| Stage | Outcome |
|---|---|
| SCOPE | Finance category taxonomy, budget lines, ledger classification. Explicitly out: RBAC, Treasury, Calendar, Payments, Invoices, Student finance. |
| DISCOVER | 35 route modules / 12 core domains inventoried; no finance-category entity existed. |
| MODEL | Flat `budget_lines.purpose` copied into `financial_transactions.category`; no hierarchy, no classification. |
| CHALLENGE | REBUILD — earned, on the named ground that the model had no parent, no classification and no create path. Owner-approved exception, recorded in `decisions.md`. |
| DECIDE | Migration 079 + 12 backend / 8 frontend files, classified Architecture Change + Data Migration + Removal. |
| CHECKPOINT | Owner sign-off obtained on six explicit decisions before implementation. |
| IMPLEMENT | Diff matches the plan. |
| VERIFY | Release gate 16/16; full suite green. |
| ATTACK | Cross-branch writes, non-leaf category ids, duplicate names, foreign channels, payroll-envelope retirement, NULL classification, mis-arity — all attempted. |
| REPAIR | Three defects found and fixed (below). |
| REVERIFY | Green. |
| **INDEPENDENT REVIEW** | **Performed this pass, from the diff and artifacts only.** Findings below. |
| CLEAN | Legacy-preservation suites and migration-era docs removed; archaeological comments removed. |
| CERTIFY | See verdict. |

---

## INDEPENDENT REVIEW findings

Reviewed cold from `git diff` and recorded output, not from memory of writing it.

| # | Check | Method | Result |
|---|---|---|---|
| R-1 | Prepared-statement arity across all rewritten ledger writers | Parsed every declaration and `.run()` call site; compared placeholder count to top-level argument count | **PASS** — finance 10/10 ×5, teachers 9/9 ×3, bos 7/7 ×1. (A first, cruder parser reported a mismatch; it was miscounting trailing commas and over-matching the declaration. Recorded because the false positive is the interesting part: an unverified checker is not evidence.) |
| R-2 | Authorization on the two new endpoints | Cold read + `canAccessBranchResource` source | **PASS** — permission-gated, branch-scoped, fails closed (`if (!req.user) return false`), branch must exist and be active |
| R-3 | Can the accounting treatment be changed through the API? | Cold read of `PATCH` handler | **PASS** — treatment derives from the subcategory; the patch body cannot move a line between classifications. Now asserted by test. |
| R-4 | Can a caller mint a payroll envelope? | Cold read of `POST` handler | **PASS** — `payroll_target` is written only by provisioning. Now asserted by test. |
| R-5 | NULL-safety of the negated classification predicate | Read `reconciliation.ts` against `ledger-classification.ts` | **DEFECT, FIXED** — `NOT (fk = 'x')` is NULL when `fk` is NULL, silently dropping uncategorised expenses from budget spend and hiding real drift. Now `IS`, with a regression test. |
| R-6 | Do two labels for one node produce two report lines? | Live probe against the running API | **DEFECT, FIXED** — grouping is now by canonical node. |
| R-7 | Does the expense report resolve its category path? | Live probe | **DEFECT, FIXED** — mapper field rename left `categoryName` null. |
| R-8 | Test coverage of the new endpoints' boundary | Diff read | **GAP, CLOSED** — no test existed for authorization or validation. `finance-budget-line-api.test.ts` added (18 tests). It immediately caught a wrong assumption of mine: the finance desk correctly has **no** treasury-allocation authority. |
| R-9 | Is any classification rule duplicated? | Repo-wide search | **PASS** — one authority; the classifier reads `finance_categories.classification` by join. |
| R-10 | Legacy model runtime dependencies | Repo-wide audit, comments stripped | **PASS** — zero. Remaining textual hits are the English word "purpose", the `*_salary_ledger` tables, migration history, and one documented scaffold column. |

---

## Certification table

| Dimension | Status | Evidence class | Notes |
|---|---|---|---|
| Correctness | PASS | PROVEN | 2340 tests; classification asserted on every surface |
| Architecture | PASS | PROVEN | One authority, FK-based; taxonomy separated from budget |
| Data integrity | PASS | PROVEN | `integrity_check` ok, 0 FK violations, fresh + upgrade paths |
| Finance | PASS | PROVEN | Four surfaces agree to the cent; reconciliation zero variance |
| Security | PASS | PROVEN | Branch scope and permission boundary now test-covered |
| UX | PASS | SUPPORTED | Cascade picker + create flow verified live; no automated UI test |
| UI | PASS | SUPPORTED | Hierarchy grouping unit-tested; rendering verified by hand |
| Performance | PASS | SUPPORTED | Indexes on `finance_category_id`; classification is an indexed lookup |
| Reliability | PASS | PROVEN | Idempotent migration; forward + upgrade both verified |
| Reporting | PASS | PROVEN | P&L, overview, dashboard, expense report agree |
| Maintainability | PASS | PROVEN | Registries enforced by `audit:registries` in the gate |
| Repository cleanliness | PASS | PROVEN | Zero unintended legacy runtime references |
| Operational readiness | PASS | PROVEN | Release gate 16/16 |

## Verdict

**READY WITH TRACKED RISK**

Every Critical/High dimension is PASS with PROVEN or SUPPORTED evidence. Four open items
are Medium/Low and logged in `docs/registries/decisions.md` (TR-1 bidirectional text,
TR-2 display precision, TR-3 no deactivation UI, TR-4 same-agent review).

Not READY outright, because TR-4 is honest: INDEPENDENT REVIEW was performed by the same
agent that wrote the change. Protocol §5 mitigates that by reviewing from artifacts and
converting findings into executable gates — three defects and one coverage gap were found
that way — but it does not eliminate the blind spot, and claiming otherwise would be the
exact failure the protocol was written to stop.
