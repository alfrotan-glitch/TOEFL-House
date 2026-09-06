# Gate 5 — Formal System Architecture Design Review

**Date:** 2026-08-25
**Result:** `PASS WITH NON-BLOCKING OPEN ITEMS`

## Decision

The approved Foundation translates into a coherent technical architecture without inventing authority, financial truth, lifecycle behavior, scope semantics, privacy rules, or legacy-derived policy. The selected style is a strict modular monolith with owner-bound contexts, server authorization, transactional source facts, append-only audit, rebuildable reporting projections, and anti-corruption integration boundaries.

## Critical findings

0. Financial architecture is coherent: obligations, charges, discounts, scholarships, payments, allocations, refunds, adjustments, reversals, cash, journals, reconciliation, and reporting remain distinct and source-linked. No mutable balance authority exists.

## High findings

0. No high business-boundary ambiguity remains.

## Medium findings / non-blocking open items

- Organization-specific RPO/RTO, retention, and disaster priorities require operational confirmation.
- Detailed report metric catalog and acceptance examples remain to be expanded before implementation.
- Legacy preservation/migration requirement remains a separately governed business decision.

## Adversarial architecture attack

All 20 required attacks were modeled in the review matrix below. Each has an invariant, owner, control, failure/recovery behavior, audit evidence, and future test category.

| # | Scenario | Control and recovery | Evidence/test |
|---:|---|---|---|
| 1 | simultaneous payments | idempotency/source serialization; reconcile ambiguous result | Finance audit/concurrency |
| 2 | refund twice | source refund limit/idempotency; reject second | refund audit/financial |
| 3 | payment allocated twice | allocation uniqueness and amount recheck; reject | allocation audit/concurrency |
| 4 | concurrent two-Owner approvals | compare-and-commit policy; count once | approval audit |
| 5 | Owner conflict | conflict exclusion; deny/record | auth/approval |
| 6 | expired delegation | effective-time deny; escalation if needed | scope audit |
| 7 | cross-branch access | explicit scope evaluation; deny | auth/scope |
| 8 | assignment expires during session | reauthorize operation; hold/deny mutation | scope/history |
| 9 | branch transfer | effective dating; preserve historical attribution | organization/history |
| 10 | historical report after transfer | as-of scope/attribution and period definition | reporting reconciliation |
| 11 | teacher submits during authority change | command-time authorization and assignment snapshot | academic/auth |
| 12 | payroll disagrees with contract | hold for HR/Payroll review; no payment | payroll/contract |
| 13 | payroll during period close | period lock/state recheck; hold or retry | payroll/concurrency |
| 14 | duplicate identity after transactions | identity exception and linked history; no merge overwrite | identity/history |
| 15 | consent revoked after disclosure | block future use; retain disclosure evidence | privacy |
| 16 | dashboard/finance same period | shared Financial Period and metric registry | reporting/reconciliation |
| 17 | configuration changes historically | effective version snapshot; no rewrite | configuration/history |
| 18 | payment timeout | idempotent status inquiry/reconciliation; no duplicate retry | integration/finance |
| 19 | duplicate webhook/event | authenticated dedupe key; safe replay | integration |
| 20 | failure during financial transaction | atomic owner commit/retry idempotently; reconcile | resilience/financial |

## Legacy contamination result

**PASS.** Existing implementation remains untrusted legacy evidence. It determines neither architecture, modules, persistence, authorization, financial behavior, nor workflows. Foundation records win in conflict.

## Exact implementation boundary

No production code, database, schema, migration, API, UI, framework scaffolding, dependency installation, production configuration, or legacy modification was performed. This gate creates architecture documentation only.

## Exact remaining unknowns

RPO/RTO/retention values, detailed report catalog and acceptance examples, and whether/how legacy data must be migrated. These do not block architecture design; they must be resolved before their affected implementation plans are approved.

**GATE 5: PASS WITH NON-BLOCKING OPEN ITEMS.**

**Next authorized gate:** none automatically. Gate 6 requires separate explicit authorization.
