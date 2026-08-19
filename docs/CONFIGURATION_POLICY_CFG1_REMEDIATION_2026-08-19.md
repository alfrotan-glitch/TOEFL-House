# CFG-1 Remediation — Discount Authorization Boundary

**Date:** 2026-08-19 · **Branch:** `arena/01a0151e-toefl-house` · **Commit:** `c28c3b8` (baseline `cdaa20b`)
**Verdict:** **CFG-1 CLOSED.** Subsystem status: **CONDITIONAL GO** (not FROZEN — see §S).

---

## A. The defect

`POST /api/rules` let a branch **manager** (not owner) create an unconditional rule
(`conditions: []`, `set_value discountPercent 95`) and mint an arbitrary discount.

Root cause, `rule-engine.ts:71`:

```sql
ORDER BY priority DESC, created_at ASC
```

The institutional "cap" was **itself just a rule**, at priority 200. Rules below 200 therefore ran
*after* the clamp and were never re-clamped. `rule-engine.ts:195`
(`conditions.length === 0 || conditions.every(...)`) makes an empty condition list match everything.

**Ordering decided policy. The Rule Engine was the authorization boundary.**

| exploit rule priority | stored `discount_percent` (student requested 10%) |
|---|---|
| 1 / 10 / 199 | **95** |
| 201 / 999 / 10000 | **30** |

Every value exceeds the 20% ordinary maximum. On a 10,000 AFN course: **6,500 AFN under-charge per enrolment.**

## B. The fix

`RULE = a calculation. AUTHORIZATION = a decision.` The engine still computes candidates and its
precedence semantics are untouched; a separate boundary decides what may actually be charged.

Deliberately **not** `finalDiscount = Math.min(finalDiscount, 20)` — that closes the hole by
destroying every legitimate exception. The property enforced is:

```
FINAL_DISCOUNT <= MAXIMUM_ALLOWED_BY_VALID_AUTHORIZATION
no valid authorization => ordinary policy => <= 20%
```

| file | role |
|---|---|
| `db/migrations/076_discount_authorization.sql` | `households`, `student_staff_relations`, `student_discount_authorizations` |
| `core/configuration/discount-authority.ts` | `resolveAuthorizedDiscount()` — the boundary |
| `routes/discount-authorizations.routes.ts` | the write path + approval authority |
| `db/schema.sql` | fresh-install parity (75 migrations, no drift) |

Category maxima: ambassador 15 · 2nd-degree 50 · family 50 · 1st-degree 100 · sponsorship 100.
Approval: **owner** for 1st-degree and sponsorship, **manager** for the rest. **No stacking** — the
single highest valid benefit applies (Ambassador 15 + Family 50 = **50**, never 65).

Eligibility is derived from data, never from request input: family size is counted from the
household grouping, relatives from an FK to a real `teachers`/`employees` row. A typed-in
`father_name`, `isAmbassador: true` or `familyMemberCount: 4` establishes nothing.

**Wired into every path that prices money:** student create, student update (`PATCH /:id`),
`enroll-class`, `enroll-semester`, visitor conversion.

## C. Snapshot & retroactivity

Enrolment **re-resolves** authorization at charge time, so a revoked grant cannot fund a *new*
invoice; already issued documents keep the figure they were charged at. Proven: a 100% semester
stayed `fee=10000 net=0` after revocation, while the next semester priced at `net=8000`.

## D. Evidence

| gate | result |
|---|---|
| Tests-first (boundary disabled) | **34 of 40 FAIL** |
| Boundary suite | 40/40 pass |
| Route authority suite | 16/16 pass |
| Boundary mutants (`discount-authorization-mutation-test.mjs`) | **14/14 KILLED, 0 survivors** |
| Route mutants (owner gate / max check / branch guard) | **3/3 KILLED** |
| Live HTTP attack, all six priorities | 95% → **20** at every priority |
| Full serial suite | 126 files / **1726 tests** pass |
| `tsc --noEmit` · `eslint` | clean · **0 errors** |
| Fresh-schema preflight | 75 migrations, no drift |
| `release-validate.mjs` | **16 passed / 0 failed** |

### Financial matrix (class fee 10,000 AFN, invoice rows inspected)

| scenario | discount | invoice |
|---|---|---|
| ordinary 0 / 10 / 20% | 0 / 10 / 20 | net 10,000 / 9,000 / 8,000 |
| ordinary 50 / 95 / 100 / 150 / 1e6 requested | **20** | net 8,000 |
| COURSE_AMBASSADOR (granted 99) | **15** | net 8,500 |
| SECOND_DEGREE_RELATIVE / FAMILY_OF_FOUR_PLUS | 50 | net 5,000 |
| FIRST_DEGREE_RELATIVE / SPONSORSHIP | 100 | net 0 |

### Rejected authorizations (all fall back to ordinary ≤20)

1st-degree without a relation · revoked · expired · not-yet-effective · cross-branch ·
family of 3 · deleted · manager attempting an owner-only category (403) · over-grant above a
category maximum (400) · forged `approvedBy` / `approved_by_user_id` fields (403).

## S. Why CONDITIONAL GO, not FROZEN

CFG-1 is closed with execution evidence. The subsystem is not frozen because:

1. **CFG-2 / CFG-3 / CFG-4 remain open** — `PUT /catalog/branch-profile/:branchId` still stores
   fees unvalidated (`-1`, `1e20`, `"500"`, `[500]`); the canonical `assertMoney` is unused there.
2. **No UI** exists for granting authorizations — the API is the only surface.
3. **Existing grants are not migrated.** Any student currently holding >20% from the old
   unqualified `discount_percent` will re-resolve to 20% on their next charge. No historical
   document is altered, but the operational list of who legitimately holds an exception must be
   re-entered through the new route. This is a deliberate fail-closed choice and needs a business
   decision before rollout.
4. `class-generation-engine.ts` has a separate private fee resolver, still untested.

**Legitimate exceptions remain usable, explicit, attributable, bounded, auditable and snapshot-safe.
No frozen subsystem (Finance, RBAC, Class, Teacher/Employee, Placement, Enrollment, Student)
regressed: 1726/1726 pass.**
