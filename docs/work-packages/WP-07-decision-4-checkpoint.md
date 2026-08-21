# WP-07 · Decision 4 — CHECKPOINT (§65): BLOCKED

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §64 DECIDE · §65 CHECKPOINT · §105 STOP · LAW 1 · LAW 4 · LAW 6
**Date:** 2026-08-21
**Baseline:** `a416f82` (release gate 22/22)
**Owner approval received:** Decision 4 model (Option 2) and S1–S6 "exactly as recommended"
**Checkpoint outcome (2026-08-21, first pass):** BLOCKED.
**Checkpoint outcome (2026-08-21, second pass): CLEARED — see §6.** Owner answered Q1(a), Q2(no) and Q3(approved); S5/S6 stay blocked by owner instruction.

The owner instructed: *"first validate every rule against the Master Engineering
Protocol, canonical authorities, invariants, and data-integrity constraints. If
anything conflicts, STOP and report it. If the system cannot distinguish funded
scholarship money from an award/pledge, STOP and ask."* This is that validation.

---

## 1. Blocker A — the system cannot distinguish funded money from an unbacked number

**This is the exact STOP condition the owner named.**

| Evidence | Source |
|---|---|
| `scholarships.donor_id` and `scholarships.campaign_id` are **both nullable** | `schema.sql` |
| Scholarship creation requires only `name` + `totalBudget`; the funding source is optional (`donorId \|\| null, campaignId \|\| null`) | `funding.routes.ts` create handler |
| **No donation is ever earmarked to a scholarship fund** — no link exists in either direction | `funding.routes.ts`; no such column or table in `schema.sql` |
| The only donation→something link is `campaign_id`; `funding_campaigns.raised_amount` is incremented by donations and **never consumed** by an award | `stmtUpdateCampaignRaisedAmount` is called only from the donation handler |

### Why this blocks the approved rule

1. **S1 has no computable definition.** "Block an award that would exceed the
   fund's received backing" requires *received backing*. A fund may name a
   donor, a campaign, or neither; donations are never allocated to funds; and a
   campaign may fund several scholarships and non-scholarship purposes. Any
   formula I chose here — donor total, campaign total, or campaign
   `raised_amount` — would be **invented business policy** and would
   double-count the moment two funds share a donor or campaign.

2. **The rule's premise cannot be verified.** The approved rule states *"A
   scholarship fund holds money the institute has already received."* The system
   cannot assert that for any fund, so the settlement's core justification —
   *no income is recognised because the donor's money was already recognised* —
   is unverifiable per fund.

3. **A fund with no donor is a different accounting event.** If the institute
   funds aid from its own money, no donor money was ever recognised, and
   settling tuition against it is **not** income-neutral: it is the institute
   forgoing revenue (a waiver — contra-revenue or expense). Applying the approved
   rule to such a fund would settle a real obligation with money that was never
   received by anyone — a phantom settlement (**LAW 4**).

**I will not choose between these.** The distinction is business policy.

---

## 2. Blocker B — Decision 4 depends on an authority that is not approved

**FACT.** `student_obligations` and `obligation_allocations` do not exist
anywhere in the schema or source.

The approved Decision-4 model is defined as *"settles through the **same**
canonical obligation-allocation authority"*. That authority is **Decision A /
slice E1**, which the owner has **not** approved — the six-question memo
(Decision A and decisions 1, 2, 3, 5, 6) is still open.

Implementing Decision 4 in isolation forces one of two protocol violations:

- **(a)** decide Decision A unilaterally so there is something to allocate to —
  which reinterprets an owner decision that was never made; or
- **(b)** build a scholarship-only allocation table now and merge it into the
  real authority later — a **second allocation authority**, i.e. exactly the
  LAW 1 failure this Work Package has spent four slices eliminating (C-17, C-18,
  D-101, D-113, D-116).

There is also nothing for an allocation to point at: tuition obligations do not
exist, so a scholarship allocation today could only reference
`student_semesters` — hard-coding the row shape and name-based attribution that
E1 exists to replace.

---

## 3. Validation of the rules that are **not** blocked

Performed against the protocol, the canonical authority registry and the
invariant registry. Recorded so the work is not repeated when the blockers clear.

| Rule | Verdict | Notes |
|---|---|---|
| Scholarship settlement writes **no** cash and **no** income | **VALID** | Keeps `computeReconciliation`'s cash formula and payment↔ledger check untouched (§78). Confirmed against `utils/reconciliation.ts` |
| One allocation authority for cash and non-cash, `source_kind` + exactly-one-of CHECK | **VALID** | LAW 1, LAW 3. Mirrors the enforced pattern already proven by `refunds_payment_id` (D-113) |
| `ON DELETE RESTRICT` on allocation → obligation / award / payment | **VALID** | §23, §50; matches D-113's precedent |
| `scholarships.allocated_amount` becomes derived, not mirrored | **VALID** | §13. Note: today it is a maintained mirror with no reconciliation invariant |
| **S2** award per student, then allocate | **VALID** | Requires `scholarship_awards` to gain lifecycle/reversal fields; no conflict found |
| **S3** withdrawal returns money to the fund, never to the student | **VALID, and structurally supported** | D-113 attaches refunds to *payments*; a scholarship allocation is not a payment, so the existing refund path **cannot** pay donor money to a student. One new invariant will be needed: an obligation settled by scholarship may not be cash-refunded beyond what was paid in cash |
| **S4** recognition model decided separately | **VALID** | Orthogonal, as analysed |
| **S5** retire one mechanism *if* the 100% `SPONSORSHIP` discount is the same concept | **NOT ACTIONABLE** | The recommendation was conditional on a yes/no the owner has not given. Also: retiring it would touch the WP-01/WP-03 discount surfaces — outside Decision 4's scope (§106) |
| **S6** sponsorship agreements: financial or narrative | **NOT ACTIONABLE** | The recommendation was *"state which"*; approving it does not state which |

---

## 4. The decisions required to unblock (no option is invented here)

**Q1 — How does a scholarship fund receive its money?**
(a) Donations are explicitly allocated into the fund — a `scholarship_funding`
link mirroring the allocation pattern; backing = what was allocated in.
(b) Backing is derived from the fund's campaign (`raised_amount`), and a campaign
may fund at most one scholarship.
(c) The owner declares an opening fund balance, and S1 checks against that
declaration rather than against donations.

**Q2 — May a scholarship fund be institution-funded (no donor)?**
If **no**: `donor_id`/`campaign_id` become mandatory and S1 is enforceable as
written. If **yes**: institution-funded aid needs its own accounting treatment
(waiver/contra-revenue or an expense), because the "already recognised donor
money" premise does not hold — and that treatment is a separate owner decision.

**Q3 — Decision A / slice E1.** Do you approve the obligation + allocation
authority so Decision 4 has something to settle against? Decision 4 cannot be
built without it.

**Q4 — S5:** is the 100% `SPONSORSHIP` discount category the same business
concept as scholarships/sponsorship agreements — yes or no?

**Q5 — S6:** are `sponsorship_agreements` financial (they generate awards or
allocations) or narrative (a record only)?

---

## 5. Status

- **CHECKPOINT verdict: BLOCKED.** IMPLEMENT is not entered.
- Nothing changed: no source file, schema object, test or registry.
- Release gate re-run at this baseline: **22 passed · 0 failed**.
- WP-07 remains NOT CERTIFIED; WP07-F16 and WP07-F17 remain open.

---

## 6. CHECKPOINT CLEARED — owner answers and revalidation

**Owner answers (2026-08-21).**

1. **Q1 → (a).** A scholarship fund receives money **only** through donations
   explicitly allocated to that fund.
2. **Q2 → no.** Institution-funded scholarship funds are **not allowed** under
   this model; future institute-funded aid is a separate waiver/discount
   mechanism.
3. **Q3 → approved.** `student_obligations` + `obligation_allocations` is **the**
   canonical allocation authority. Decision 4 must use it; no parallel authority.
4. **S5, S6 remain blocked** by explicit owner instruction — no assumption.

**Revalidation against the protocol — no conflict found.**

| Rule | Check | Verdict |
|---|---|---|
| Funds backed only by allocated donations | Makes "received backing" computable as `SUM(scholarship_fundings.amount)`; the premise of the settlement rule becomes verifiable per fund | **VALID** — closes Blocker A (LAW 4) |
| No institution-funded funds | Enforced *by construction*: backing can only come from donations, so a fund with no donation allocations can award nothing. No new policy invented, no column made mandatory (a fund may legitimately receive from several donors) | **VALID** (LAW 6) |
| One canonical allocation authority | Closes Blocker B | **VALID** (LAW 1) |
| Donation may not be over-allocated | `SUM(fundings per donation) ≤ donation.amount` — new invariant | **VALID** (LAW 4) |
| Settlement writes no cash and no income | Unchanged from the approved rule; `computeReconciliation` untouched | **VALID** (§78) |

**Two interpretations recorded rather than assumed** (§90), both flagged for
owner confirmation and neither silently chosen:

- **I-1 — where a reversed allocation goes.** The approved rule says reversal
  "returns the amount to the fund". Returning it to the *fund* while the award
  remains active would let the sum of active award commitments exceed the fund's
  received backing — an over-commitment the S1 invariant forbids. The
  implementation therefore returns a reversed allocation to **its award** (still
  committed to that student, immediately re-allocatable), and adds an explicit
  **close-award** command that returns the unallocated remainder to the **fund**.
  Both destinations are reachable by an operator act; neither is automatic. The
  owner's substantive rule — the money never reaches the student — holds in both.
- **I-2 — `scholarships.total_budget` is no longer a money authority.** With
  backing defined by allocated donations, `total_budget` is kept as the fund's
  declared **target** and no longer bounds awards. It is not removed, because
  removing it would change a UI contract the owner has not asked to change.

## 7. Scope of the approved slice (E1-core + Decision 4)

**In scope**

- `student_obligations` — tuition only, one per `student_semesters` row, **amount
  derived** from the existing tuition authority (no second amount store, §13).
- `obligation_allocations` — the canonical allocation table, `source_kind`
  `payment | scholarship` with exactly-one-of enforced by CHECK. `payment` is
  declared now and populated when E1b migrates the payment desk.
- `scholarship_fundings` — donations allocated into funds.
- `scholarship_awards` — award lifecycle (active/closed) for S2/S3.
- One settlement authority: tuition settled = cash (existing `getSemesterTuitionPaid`)
  **+** active scholarship allocations. Consumed by the payment desk and the
  student balance, so a scholarship-settled term cannot be collected again.

**Out of scope (unchanged, and stated so it is not mistaken for done)**

- Migrating cash payments into `obligation_allocations` (**E1b**).
- Invoices (Decision 2 / WP07-F17), installments (WP07-F16), fixed fees
  (Decision 5), free-text semesters (Decision 6) — none approved.
- S5 (`SPONSORSHIP` discount duplication) and S6 (sponsorship agreements).
