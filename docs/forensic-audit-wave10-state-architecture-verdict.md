# Wave 10 — Economic-State Architecture Verdict (2026-09-05)

Read-only architecture audit of the memo/economic-state layer. No production
code changed. Every claim below is source-read, DB-probed, or marked as
derived reasoning. Live world = the rebuilt drill database (seeded owner +
waves 5–9 drill data).

---

## Executive verdict

**CONDITIONAL PASS.**

The architecture's core pattern — **entity (identity) + immutable amount
authority + append-only settlement events + derived position + guarded,
event-style reversal** — is sound, and it is what the big state families
actually implement. Amounts on memos are insert-only everywhere; positions
are derived; reversals never delete. This is NOT a hidden second ledger, and
it can carry the Wave-9 policy capabilities **after five named conditions**
(§Confirmed defects / §Gate). Two genuine defects were found (one
code-proven, one temporal), one reconciliation asymmetry, and one
policy-adjacent ontology gap. None requires redesigning the memo concept;
all are extensions or repairs inside it.

## Economic-state ontology discovered (by behavior, not by name)

| # | Economic state | Identity | Amount authority | Settlement/discharge | Reversal | Verdict |
|---|---|---|---|---|---|---|
| 1 | Student tuition receivable | `student_obligations` (INSERT-only; unique per semester, DB-enforced) | `student_semesters.fee/net_fee` (no writer ever updates) | `obligation_allocations` append-only; outstanding = derived | guarded status-flip + reason + timestamp | **sound** |
| 2 | Non-tuition receivable | `invoices` (document-as-state, status machine) | `invoices.net_amount` | linked payments | cancel guarded (paid→400) | sound; **second mechanism** (see §Findings) |
| 3 | Installment plan | `student_installments` (unique obligation+sequence) | plan rows | **one-way flag flip** `pending→paid` | **none exists** | **DEFECT W10-1** |
| 4 | Staff advance receivable | salary-ledger row, `payment_type='advance'` | `paid_amount` | recovery via period-scoped due-cap (implicit, unattributed) | void (correct) | **ontology gap W10-4** |
| 5 | Donor commitment / restricted fund | donations+restrictions+fundings+awards | insert-only amounts | guarded allocations | event-style closures (closed_at/by/reason; reversed_at/by/reason) | **soundest family** |
| 6 | Supplier promise | `'separate'` string on receipts | — | — | — | not a state (W8; policy-blocked) |
| 7 | Cash stores / envelopes | finance_accounts / budget_lines | stored balances | — | — | reconciled to events at runtime (I11–I13, I16) ✓ |

## Complete lifecycle findings

- **Obligations are INSERT-only.** `status='open'` is existential ("this debt
  exists"), never positional ("this much is owed") — owed-ness is derived as
  due − active allocations. No discharge writer exists; none is needed for
  payment-settlement (arithmetic reaches zero). The MISSING discharge is the
  W9 write-off policy item, unchanged.
- **Refund chain (code-verified):** refund → negative payment + guarded
  reversal of allocations up to the still-active total (`WHERE id=? AND
  status='active'`, `changes!=1 → 409`) + contra-income. Reversal is
  idempotent, concurrency-safe, reason-preserving. **Resurrection is
  impossible** — every flip is status-guarded.
- **Transfer** splits one obligation across two term rows preserving Σamounts
  (source completed keeps fee, destination 0-fee); identity trace via
  `enrollment_events`. Sound.
- **Class merge** (classes.routes:180) rewrites `student_semesters.class_id`
  **without writing enrollment events** — attribution history survives only
  in the audit log text. **W10-2 (temporal defect).**
- **Scholarship/sponsorship family:** closures and reversals are fully
  event-style with actor, timestamp, reason. Award reversal returns money to
  the award, never to the student. Exemplary.

## Identity / conservation findings

- One obligation per term is **DB-enforced** (`uq_obligation_tuition_semester`);
  duplicate obligation states cannot exist.
- Duplicate settlements are prevented **indirectly**: allocations carry no
  idempotency key of their own and no unique (obligation, payment) index —
  protection comes from the parent payment's idempotency + the in-transaction
  outstanding guard. Single-process synchronous execution makes this safe
  today; a multi-process deployment would need the composite unique index.
  **Condition W10-3b.**
- Salary ledgers: partial-unique idempotency + full-period unique + void
  re-check inside `BEGIN IMMEDIATE`. Sound.
- No mutation path anywhere merges or splits obligations; no state exists
  without its economic origin (obligation requires a term row; allocation
  requires payment or funding source).

## Temporal / history findings

- **`student_semesters` has no `created_at`** (probed). Point-in-time
  receivable is reconstructible only at **date granularity** via the
  immutable `enroll_date`; allocations/reversals carry full timestamps. The
  mixed granularity makes same-day term-vs-settlement ordering ambiguous.
  Live probe: receivable-as-of-2026-09-05 = 25,000 = current ✓ (date-level
  reconstruction works).
- **Status/class mutations are silent rewrites** (no effective dating, ~8
  writer sites). Drop/transfer/reactivate histories are replayable via
  `enrollment_events` (timestamped); **merge is not** (W10-2). The ACTIVE
  balance scope at a past date is therefore not fully reconstructible.
- Corrections are distinguishable from events in the allocation family
  (reversed_at + reason) but not in the semester-status family.

## Concurrency / idempotency findings

All state flips are guarded (`WHERE status=...`, `changes!==1 → 409`) and run
inside synchronous transactions; retried commands are absorbed by idempotency
keys at the command layer. No duplicate-or-contradictory-state path was
found in the request lifecycle; the one structural weakness is the indirect
allocation protection (W10-3b).

## Independent-reporting findings

- Tuition receivable: **independently re-derivable** from term + payment
  events with my own SQL (Wave 7's 9/9 battery). Not circular.
- Restricted funds: derivable from the subledger events. Not circular.
- Non-tuition receivable: reads `invoices` — the state document itself. A
  second source exists (payments linked to invoices, both directions), so it
  is cross-checkable, but the figure-of-record is document-borne by design.
- **Reconciliation asymmetry (W10-3a):** cash stores have RUNTIME invariants
  (I11–I13, I16); the memo layer has NONE at runtime — obligation↔allocation↔
  payment coherence and installment↔allocation coherence live only in the
  test suite. State-layer drift would be silent in production.

## Real-world scenario results

| Scenario | Result |
|---|---|
| Retry a payment | absorbed (idempotency) ✓ |
| Refund after settlement | allocations reversed event-style; obligation re-opens ✓ |
| Pay after refund | outstanding derived correctly ✓ |
| Installment paid → payment refunded → re-pay | **installment stuck 'paid'; re-pay via installment path 409s; obligation says owed, installment says paid — memo contradiction (W10-1)** |
| Concurrent duplicate obligation | impossible (unique index) ✓ |
| Concurrent double-void / double-reversal | serializes to 409 ✓ |
| Failed multi-step payment | atomic (single transaction) ✓ |
| Merge two classes after a semester | attribution history lost from memos (W10-2) |
| Advance recovered from a LATER month | unrepresentable — recovery is period-scoped (W10-4) |
| Receivable as of past date | ✓ at date granularity; ✗ at timestamp granularity |

## Confirmed defects

- **W10-1 (code-proven; zero live rows — installments table empty):**
  installment flag has no reversal path; refund leaves contradictory state
  and blocks legitimate re-payment. Fix: event-style reversal symmetric with
  allocations (status flip back with reason/actor/timestamp), inside the
  refund transaction. *Implementation belongs to Wave 11 (it touches
  production code; this wave is read-only).*
- **W10-2 (temporal):** class merge rewrites memo attribution without
  effective-dated events. Fix: write `enrollment_events` rows (merge From→To)
  or add effective-dating; minimum = event trail.
- **W10-3 (reconciliation asymmetry):** (a) add runtime memo invariants —
  obligation↔allocation↔payment coherence both directions, installment↔
  allocation coherence, advance-classified-rows↔payroll-ledger coherence —
  to the checker family; (b) composite unique index on
  `(obligation_id, payment_id)` for allocations.
- **W10-4 (ontology, policy-adjacent):** staff-advance recovery is
  period-locked and unattributed; an independent "outstanding advances"
  figure is underivable. Requires the advance-recovery-window policy
  decision (owner) before the receivable can be reported honestly.

## Separation of findings

1. **Architectural defects:** W10-1, W10-2, W10-3.
2. **Missing capabilities:** supplier payables, loans, write-offs (W9 policy
   blocks — unchanged).
3. **Policy decisions:** P1–P15 (W9) **plus** advance recovery window (new
   P16).
4. **Intentional design:** obligation status as existential; document-borne
   non-tuition receivable; derived discharge-arithmetic; period-named
   advances.
5. **Audit limitations:** timestamp-granular PIT reconstruction; production
   loan-vs-equity attestation (W9).
6. **Historical production impact:** **none** — live world has 0 installments,
   0 refunds, 0 merges; all defects are forward-looking.

## Answer to the mission question

**Can the memo architecture represent real economic states correctly,
completely, permanently?** For the states it models (tuition receivable,
funding commitments, payroll facts, inventory quantities): correctly — yes;
completely — except the two defect paths (W10-1/2); permanently — except
merge attribution. It is not a hidden second ledger: amounts are immutable,
positions derived, reversals event-style. The state layer is therefore
**trustworthy enough to carry the Wave-9 capabilities** once the five
conditions below land. It fails no first-principles test that would mandate
redesign; it passes none of its own without conditions.

## Exact gate for Wave 11

1. Fix W10-1 (installment reversal, event-style, transactional).
2. Fix W10-2 (merge writes enrollment events; effective-dated attribution).
3. Close W10-3 (runtime memo invariants I17+; composite unique index).
4. Decide P16 (advance recovery window) — owner.
5. Then implement, in order: the three Wave-9 authorized items (income
   taxonomy, restricted exposure report, employee-bonus payroll
   composition), followed by policy-gated items as P1–P15 decisions land.
