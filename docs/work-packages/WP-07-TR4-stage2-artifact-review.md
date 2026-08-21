# WP-07 · TR-4 — Stage 2: artifacts reviewed before rationale

**Protocol:** §44 (dead code) · §65 · §103 EVIDENCE · LAW 1 · TR-4
**Date:** 2026-08-21 · **Baseline:** `ab7fd7e`
**Stage:** 2 of 3. **The decision register was deliberately not read for this stage.** Code, tests, schema, gates and runtime verdicts only.
**Implementation:** none.

---

## 1. Do the WP-07 authorities have tests that can fail?

Four authorities were mutated directly and their own suites run. Every file was
restored; `git status` was clean afterwards.

| Authority mutated | Mutation | Verdict |
|---|---|---|
| Term billing capacity | delete the `assertTuitionInvoiceFits` call | **KILLED** |
| Branch arrears subtract aid | drop the aid term from the subtraction | **KILLED** |
| Revenue attribution | count reversed allocations as revenue | **KILLED** |
| Cash settles via allocations (`getSemesterTuitionPaid`) | delete the `source_kind='payment' AND status='active'` filter | ***SURVIVED*** |

Three of four hold. The fourth is finding **TR4-F6**.

---

## 2. TR4-F6 — SEVERITY MEDIUM · a money authority with no production caller

Investigating the surviving mutant produced a chain of facts:

```
grep -rn "getSemesterTuitionPaid|getSemesterTuitionSettled" src --include=*.ts | grep -v /tests/
  → students.routes.ts:10   import { … getSemesterTuitionSettled }
  → studentBalance.ts       the definitions themselves
  → two comments

grep -n "getSemesterTuitionSettled(" src/routes/students.routes.ts
  → (no matches)
```

* `getSemesterTuitionSettled` is **imported and never called**.
* `getSemesterTuitionPaid` is reachable only through it, and from tests.
* So the semester-**name**-keyed settlement path has **zero production call
  sites**. The payment desk was moved onto obligation-keyed reads, and this
  function was left behind.

That is why the mutant survives: deleting its filter changes nothing any
production path observes. The suites that still call it assert numbers that no
longer feed a decision.

**This is dead code in a money authority (§44)** — and worse than ordinary dead
code, because it looks authoritative, is exported, and is still exercised by
tests, which makes it read as live.

**Not repaired.** Whether to delete it, or re-point it and keep a name-keyed
reader, is a decision for the reviewer and the owner.

---

## 3. TR4-F7 — SEVERITY LOW · the canonical expression is not used by its own module

`TUITION_NET_SQL = 'COALESCE(net_fee_amount, fee_amount)'` is exported so the
rule is written once, and `obligations.ts` imports it. Inside
`studentBalance.ts` the same literal is then inlined **four more times**
(lines 141, 248, 281, 318).

Low risk today — one module, one author, one meaning — but the constant exists
precisely so the expression is not restated, and it is restated four times in
the file that defines it.

## 4. TR4-F8 — SEVERITY LOW · "an active cash allocation" is expressed three times

`source_kind = 'payment' AND status = 'active'` appears in
`studentBalance.ts`, `obligations.ts` and `bos.routes.ts`. The aid predicate was
consolidated into `AID_SOURCE_KINDS_SQL`; the cash predicate was not. The BOS
copy needs a JOIN-based aggregate so it cannot call the function, but the
predicate itself could still be shared.

## 5. TR4-F9 — SEVERITY MEDIUM · the gate cannot see dead imports

```
'@typescript-eslint/no-unused-vars': ['warn', …]
```

It is a **warning**, and the release gate passes with warnings. Running eslint
directly reports the dead `getSemesterTuitionSettled` import — alongside ~100
pre-existing unused values that the config's own comment acknowledges.

So a dead import introduced by WP-07 entered the tree through a green gate and
stayed invisible. The gate proves the code compiles and the tests pass; it does
not prove the code is reachable.

---

## 6. What Stage 2 confirms

* The three authorities behind D-128, D-146 and D-151 have tests that genuinely fail when the authority is broken.
* `obligation_allocations` is the only table any surface consults for aid, and `AID_SOURCE_KINDS_SQL` is genuinely single.
* No second implementation of "tuition due" or "what settles tuition" was found outside the files above.

## 7. What Stage 2 could NOT establish

* Whether the 22 mutation survivors from Stage 1 are equivalent or real gaps — unchanged, still unresolved.
* Cross-surface runtime agreement for a student holding cash + refund + scholarship + sponsorship simultaneously. Not executed this stage.
* Anything about the correctness of the *reasoning* in the decision register — Stage 3, deliberately not begun.

**TR-4 remains OPEN. No WP-07 certification is signed.**

---

## 8. Recommendations — recorded, NOT implemented

| # | Recommendation |
|---|---|
| TR4-R9 | Resolve TR4-F6: delete the dead name-keyed settlement path, or re-point a caller to it. A money authority with no caller must not remain. |
| TR4-R10 | Use `TUITION_NET_SQL` inside its own module (TR4-F7). |
| TR4-R11 | Share the cash-allocation predicate as `CASH_ALLOCATION_SQL` (TR4-F8). |
| TR4-R12 | Raise `no-unused-vars` to `error`, after clearing the ~100 existing warnings — otherwise the gate keeps admitting unreachable code (TR4-F9). |
| TR4-R13 | Add a cross-surface runtime test: one student with cash, a refund, a scholarship and a sponsorship, asserting profile, roster, dashboard and operations report agree. |
