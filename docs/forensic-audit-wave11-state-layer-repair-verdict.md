# Forensic Audit — Wave 11: State-Layer Repair & Adversarial Verification (Verdict)

**Date:** 2026-09-05 · **Scope:** W10-1/W10-2/W10-3 repair + independent adversarial
verification + P16 policy determination · **Method:** reproduce → repair at the
strongest layer → attack the repair through production surfaces → probe live history.
**Preceded by:** Wave 10 verdict (CONDITIONAL PASS), `656b9c6`.

---

## 1. Independent reproduction (Phase A)

All three W10 defects re-confirmed against current source before any repair; one prior
self-suspicion re-refuted:

| Defect | Reproduction result |
|---|---|
| **W10-1** installment one-way flip | CONFIRMED. `refundPaymentAllocation` reverses allocations and writes the negative payment but never touches `student_installments`; the paid flag survives its own settlement's reversal. Re-confirmed `setInstallmentPlan` has a paid-guard 409 BEFORE delete/reinsert — it does NOT destroy paid rows (suspicion stays refuted). |
| **W10-2** merge rewrites attribution silently | CONFIRMED. mergeTx = semester re-point + roster delete/insert + enrollments update + cancel + link; zero `enrollment_events` writes. Live vocabulary has no 'merged' event_type (CHECK constraint would reject one) — correct repair vehicle is `transferred`. |
| **W10-3** no active-pair uniqueness, no runtime state invariants | CONFIRMED. `obligation_allocations` had FKs RESTRICT + shape/status CHECKs but no uniqueness on active (obligation, payment); invariant checker stopped at I16. |
| **W11-A (NEW)** idempotent replay swallows re-payment after refund | FOUND during adversarial verification. A fully-refunded payment's derived idempotency key collides with its honest re-payment (same student/category/amount/installment/method/actor); the unique-index backstop replays the OLD receipt: desk sees "success", no new payment, allocation, or cash movement is recorded. Latent until W10-1's repair made repay-after-refund reachable (previously blocked by 'already paid'). |

## 2. Repairs (Phase B) — smallest architecture-consistent changes

### W10-1 — symmetric installment lifecycle (`server/src/core/finance/obligations.ts`)
Appended to the end of `refundPaymentAllocation`, runs only when a reversal actually
happened (`firstReversed`): re-open `student_installments` rows
(`status='pending'`, `paid_payment_id=NULL`) **iff** their `paid_payment_id` has **zero
remaining ACTIVE allocations**.

Semantics decided before the fix: the installment flag is a *cache of "this
installment is currently settled by a live payment"*. A partial refund re-allocates the
retained amount, so the flag stays `paid`; a full refund leaves the payment settling
nothing, so the flag re-opens. No timestamps fabricated; the flag's history lives in
the payment/allocation/event chain, as before.

Attack matrix verified through production surfaces (13/13, `state-layer-repair.test.ts`):
normal pay · full refund (reopens; outstanding restored) · repayment after refund
(succeeds, new receipt) · partial refund (stays paid; 1 active allocation remains) ·
remainder refund (reopens; cycle idempotent) · duplicate/over refund (refused, no state
change) · concurrent refunds of one payment (exactly one wins; I17/I18/I19 clean) ·
duplicate-pay-while-settling (fee guard refuses, not recorded) · repayment of a
re-funded FEE payment (new receipt, not a replay — category-generic proof).

### W11-A — idempotency key generation (`server/src/routes/students.routes.ts`)
A DERIVED key whose holder payment has been **fully refunded** no longer replays: the
route advances the key one generation at a time (`<key>.r2`, `.r3`, …) until it lands
on an unused key, and the free-category pre-check skips fully-refunded candidates.
True retries of a still-settling payment keep identical keys and replay exactly as
before; concurrent re-payments derive the same generation key and the unique index
arbitrates them like any other race (loser correctly replays the winner — the NEW
payment). Refunded-ness = Σ(−refund rows) ≥ original amount, the same arithmetic the
refundable-payments surface uses. Client-supplied keys are untouched (explicit intent
always replays).

### W10-2 — merge attribution events (`server/src/routes/classes.routes.ts`)
`mergeTx` now writes one `enrollment_events` row per moved enrollment:
`event_type='transferred'` (existing vocabulary — no schema change), `from_class_id`
= source, `to_class_id` = target, `notes='Class merged: <src> into <dst>'`,
`actor_user_id` from context, `created_at` defaults to now — the event records **when
the merge happened**, which is the truth; no historical date is invented. Attribution
is reconstructible: current class_id + the transferred event = the full story.

### W10-3 — strongest-layer invariants
- **DB:** partial unique index `uq_allocations_active_payment_obligation ON
  obligation_allocations(obligation_id, payment_id) WHERE status='active'`
  (schema.sql). Converged onto the live DB without error — proof by construction that
  **zero live duplicate active pairs exist**.
- **Runtime checker (second layer, drift-proof):**
  - **I17** — no obligation actively settled beyond its billed term amount; no payment
    actively allocated beyond itself.
  - **I18** — a `paid` installment names a completed payment that still actively
    settles something.
  - **I19** — every posted teacher/employee salary-ledger row has its ledger
    transaction with an equal amount.
  - Findings now carry `entityId` (the offending obligation/payment/installment row),
    so probes and the audit API name the entity, not just the invariant.
- **Already at the strongest layer (documented, not duplicated):** installment
  paid⇒payment pairing is a schema CHECK (paid-with-NULL is unrepresentable);
  allocation facts are append-only (active→reversed with full attribution only);
  payroll ledger facts and their linked transactions are immutable + fact-triggered at
  insert (an I19 mismatch is UNREACHABLE by mutation today — I19 is the second layer
  against schema drift and future write paths, exactly like I9 for receipt forks).

## 3. Adversarial verification (Phase C) — `src/tests/state-layer-repair.test.ts`, 13/13

Everything through production route surfaces (class create, catalog fee-rule, manual
admission, invoice settlement, enroll-semester, plan PUT/GET, payments, refunds,
merge). Assertions derive state **independently** from underlying records (payments,
allocations, installments, events) — never from API response claims; outstanding is
computed from ACTIVE allocations only (the I17 math), not from app output.

1. World-build sanity (fee-rule gate, registration-invoice gate, phone requirement).
2–6. W10-1 lifecycle matrix (above).
7. W11-A fee-category re-payment generation (new receipt ≠ replay; third attempt
   refused by the fee guard; I16–I19 clean).
8. W10-2 merge events: 2 moved enrollments → 2 `transferred` events with correct
   from/to/actor; all enrollments point at target.
9. Duplicate ACTIVE (obligation, payment) allocation refused by the UNIQUE index
   (schema-honest insert so nothing else fires first).
10. I17 tamper probe: shrink term below active settlement → I17 fires naming the
    obligation; restore → clean.
11. I18 tamper probe: point a paid installment at a completed payment that allocates
    nothing (a refund row) → I18 fires; restore → clean. (paid+NULL is DB-impossible.)
12. I19 guards-lifted probe: the mismatch state is DB-unreachable today; the probe
    lifts the three guard triggers, proves the DETECTOR fires naming the ledger row,
    then fully removes the probe rows and restores the guards exactly as the schema
    defines them (trigger-existence asserted).
13. Full checker (I1–I19) green on the repaired world after all probes.

## 4. Historical impact (live DB, read-only probes)

**CLEAN — no repair of history required, none performed.**

| Probe | Result |
|---|---|
| refunds ever | 0 |
| installments paid | 0 (W10-1 defect never materialized) |
| paid installments whose payment no longer actively settles | 0 |
| duplicate ACTIVE (obligation, payment) pairs | 0 (also proven by index convergence) |
| orphan allocations | 0 (6 active, all linked) |
| merges ever / transferred events | 0 / 0 (W10-2 gap never materialized) |
| full invariant checker I1–I19 on live DB | **zero findings** |

## 5. P16 — staff-advance recovery window (owner policy)

**Status: POLICY REQUIRED. No implementation.**

Searched: OPERATIONS.md (backup/restore only), MASTER_ENGINEERING_PROTOCOL.md,
work-package and certification docs (WP-07/WP-08), registries, and the payroll code
paths. The only "OWNER POLICY" on record (WP-07 Decision 3) concerns lump-sum
pre-enrolment payment — a different question. No authoritative source states whether a
staff advance must be recovered within the same period, across periods, or by whom.

What the architecture **can** represent today (code-verified, teachers.routes.ts /
employee payroll): per-period recovery, implicit — a period's remaining due = base −
everything posted for that period, advances included. What it **cannot** represent:
recovery of a *later* period's salary against an *earlier* advance, and any explicit
link from a salary row to the advance row it recovers (attribution is derivable only
by period arithmetic, not by reference). Deciding to change either is a business
decision; when the owner states it, it changes the model (a recovery-schedule entity
or an allocation-style link), and that work is deliberately not pre-built here.

## 6. Limitations

- The concurrent-refund probe exercises better-sqlite3's serialized write path;
  true multi-process races rely on the DB transaction boundary, as before (W10
  finding unchanged: single-process deployment).
- I19's detector-proof required lifting three guard triggers inside one test; the
  guards are restored and asserted by name. This is the only test in the suite that
  touches guard DDL, and it documents why.
- The generation key (`.r2`, …) is internal; receipt numbers remain the operator-
  visible truth.
- W10-2 events record merge-time truth; historical merges before this repair would
  have no events — live DB has none (0 merges), so nothing to backfill.

## 7. Suite results

- `npx tsc --noEmit` — clean.
- Full vitest suite: **2913 passed, 2 skipped, 0 failed** (216 files). The one test
  that initially failed (`financial-invariant-checker.test.ts` I1) fabricated a
  duplicate ACTIVE pair — the exact state the new partial unique index now forbids —
  and was updated to over-allocate the payment the still-representable way (two
  obligations), keeping the I1 detector proven under the new constraint.

## 8. Verdict

**PASS.** W10-1, W10-2 and W10-3 are repaired at the strongest appropriate layers and
independently verified through production surfaces, including concurrency and
tamper probes; the verification itself surfaced and closed a fourth defect (W11-A)
that the W10-1 repair had made reachable. Historical data is clean and untouched.
P16 is recorded as POLICY REQUIRED with the representable/unrepresentable boundary
proven from code.

## 9. Wave-12 gate (W9 authorized trio — unchanged from W10)

1. **Income taxonomy** — the billing-vocabulary `category` label vs
   `finance_category_id` authority split (W9): close any surface that still classifies
   by label.
2. **Restricted exposure report** — donation restrictions vs fundings/allocations:
   a derived report proving restricted money is never spent on unrestricted purposes.
3. **Employee-bonus payroll composition** — bonus as payroll line: due authority,
   classification, and its interaction with the advance due-cap.

Entry criteria: this verdict's suite green on the target commit; no schema migration
in Wave 12 without a named invariant it enforces.
