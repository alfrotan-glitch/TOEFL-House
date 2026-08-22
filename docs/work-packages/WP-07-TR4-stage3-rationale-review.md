# WP-07 · TR-4 — Stage 3: decision-rationale review (read-only)

**Protocol:** §71 · §103 EVIDENCE · §105 STOP · TR-4 Stage 3 of 3
**Date:** 2026-08-22 · **Baseline:** `717cebc` (release 22/22 · mutation gate 18/0 fully green ·
suite 2842/162/0)
**Implementation: none. Register edits: none. Certification: unchanged (NOT signed).**

**Independence caveat (unchanged from the dossier and the Stage-3 review that preceded it):** this
review was executed by the implementing agent at the Owner's direction, in artifacts-plus-machine
mode — every claim below is a grep, a file check, or a standing gate result, not an opinion. A
structurally separate reviewer can reproduce it from this document.

---

## 1. Method

1. **Full machine sweep of the register's 71 WP-07 rows** (D-era 2026-08-20/21): every cited
   `src/…` path and every backticked code identifier was checked against today's tree
   (production sources, then `schema.sql` for schema-resident names).
2. **Dossier-directed deep samples** (§4's "sample the PROVEN claims"): D-128, D-146, D-151
   (Stage-2 mutation-killed authorities), D-22/D-23 (canonical money model), D-32/D-61/D-130/D-145
   (rows whose dead-looking names are their own superseded "from" sides), D-131 (schema trigger),
   D-154/D-156/D-157 (self-referential machine-fact rows).
3. **Standing gates as mass re-proof:** the fully green mutation gate (18/0, every survivor a
   documented registry member) and the 22/22 release gate re-prove the surviving "PROVEN (N
   tests)" claims en masse at the time of review.

## 2. Verified sound

| Sample | Result |
|---|---|
| D-128 `assertTuitionInvoiceFits` | live, exported, consumed by `invoices.routes.ts` |
| D-146 `getBranchOutstanding` | live, consumed by `bos.routes.ts` |
| D-151 `invoicePaymentAttribution` | live, consumed by the invoice payment path |
| D-22/D-23 money model | `roundMoney` single implementation; `assertMoney`/`assertComputedMoney` split intact |
| D-32, D-61, D-130, D-145 | the "dead" names they cite are exactly what those decisions removed or renamed — correct history |
| D-131 `trg_sponsorship_receipts_donor_insert` | present in the canonical schema |
| D-154/D-156/D-157 machine claims | consistent with the audit trail; `docs/certification/WP-07-finance.md` is a properly-marked historical v2 artifact requiring Master-Protocol re-certification |
| Sweep | **zero** cited paths/identifiers are dead except the supersession cluster below |

## 3. Findings

### S3-F1 — SEVERITY MEDIUM-HIGH · the decision register stops at D-157: this engagement's
entire post-D-157 disposition is unrecorded in the register

The register's last WP-07 row is D-157 (2026-08-21). Since then — all Owner-approved, all recorded
in work-package documents and commits `04ece70…717cebc` — the following **material changes** have
no register rows:

- **TR4-R9**: removal of `getSemesterTuitionPaid` / `getSemesterScholarshipSettled` /
  `getSemesterTuitionSettled` — the authorities described by **D-116, D-133, D-141** no longer
  exist, and no register row records the supersession. (The *living* registry
  `canonical-authority.md` was re-pointed; the *rationale* record was not.)
- **TR4-R12**: the lint gate's `no-unused-vars` raised to error (D-157's TR4-F9 remedied).
- **The M7 subsumption simplification**: `hasPermission` deleted from `rbac-service.ts — a
  production security-code change made under Owner Option (b).
- **TR4-R14 + the survivor dispositions**: measurement-integrity repairs, 10 EQUIVALENT entries by
  execution, OBSOLETE retirements (M1/M7/M12/M14/S10), registry corrections (F11, S9: killed, not
  equivalent), 59 anchor re-bases, and coverage kills across five harnesses.

Consequence: a future reader consulting only the register (the protocol's rationale authority)
finds D-116/D-133/D-141 describing live authorities that were removed, with no pointer to where or
why. **Disposition is the Owner's** — per the standing instruction the register was not edited;
the remedy is one or more recording rows (the register is append-only), which I can draft on
approval.

### S3-F2 — SEVERITY LOW (note, consistent) · D-141's recorded follow-on remains open

`payments.semester` is still written for display and refund attribution; its retirement is the
recorded follow-on once no reader remains (already carried as residual R-2). Not a defect; the
register's own forward pointer is accurate.

### S3-F3 — INFO · certification state is coherent

`docs/certification/WP-07-finance.md` is a v2-era artifact explicitly marked as requiring
re-certification; D-154's "no WP-07 certification is signed" holds. No contradiction.

## 4. Stage-3 conclusion

Both halves of TR-4's review are now complete — artifacts (Stages 1–2, the independent-review
round, and the dispositions) and rationale (this stage). The **single blocking finding for TR-4
discharge is S3-F1** (the register gap), plus the previously recorded open recommendations
(TR4-R10/R11/R13, dead export, residuals R-1…R-4) which are remediation items, not review gaps.

**TR-4 remains OPEN pending the Owner's disposition of S3-F1. WP-07 remains NOT certified.**
Stopped at the checkpoint.

---

## 5. DISPOSITION — S3-F1 RESOLVED (2026-08-22, Owner: "Continue")

Append-only rows **D-158…D-161** added to `docs/registries/decisions.md`, recording: the TR4-R9
settlement-authority removal (superseding the subjects of D-116/D-133/D-141, which remain as
history), the TR4-R12 gate hardening, the M7 subsumption simplification (Owner Option b, never
classified EQUIVALENT), and the TR4-R14 survivor/anchor dispositions ending in the fully green
mutation gate. Historical rationale untouched. Verified: `audit:registries` PASS (443 rows, 778
path references, all live); `release:validate` **22 passed · 0 failed**.

**S3-F1 closed. TR-4's review record is now internally consistent end-to-end.** Remaining open
items, in the registered order: TR4-R13 (cross-surface runtime agreement test) → TR4-R10/R11
(predicate consolidation) → dead export `getStudentScholarshipSettled` → residuals R-1…R-4 → the
certification question. **WP-07 remains NOT certified. Stopped at the checkpoint.**

---

## 9. TR4-R13 EXECUTED — AND IT CAUGHT A REAL DEFECT (2026-08-22, Owner: "Continue")

*(Round note: the sandbox was re-cloned again before this round; recovery per §65 was executed —
remote verified, branch restored to `eba381b`, dependencies reinstalled, state re-established.)*

The cross-surface suite (`server/src/tests/work-packages/wp07/cross-surface-money-agreement.test.ts`)
drives ONE student through every instrument — cash 4,000, a 1,000 refund, a 2,000 scholarship and
a 2,000 sponsorship against a 10,000 term — and asserts the five surfaces agree with the
authorities: `getObligationPosition` + `getStudentBalance` (DB), profile `balance` block, the
roster page, the BOS executive dashboard's `outstandingPayments`, and the operations report's
`financial.outstanding.tuition`.

**TR4-R13-F1 — SEVERITY HIGH, found by the suite and repaired under §69:** the two BATCH balance
readers — `getStudentBalancesPage` (roster) and `getStudentBalancesByIds` (roster list/export) —
summed only cash payments and **omitted the aid-settled term** that `getStudentBalance`, the
authority their rows promise to equal, includes (D-120). Every donor-settled student showed a
higher debt on the roster than on the profile, the dashboard and the operations report — a
§77/LAW 1 disagreement in exactly the form the dossier's question 5 anticipated. Repair: both
queries now add the identical aid term (all tuition obligations, active allocations, scholarship
+ sponsorship — mirroring the authority exactly), current-intent comment per §4 (the first
draft's historical narrative was rejected by the cleanliness audit, correctly).

**Gates:** mutation **18 passed · 0 failed** · `release:validate` **22 passed · 0 failed** ·
server suite **2843 passed · 162 skipped · 0 failed** (+1 test). Changed: `studentBalance.ts`
(+23/−2) and the new suite.

**Remaining, in the registered order:** TR4-R10/R11 → dead export → residuals R-1…R-4 → the
certification question. **WP-07 remains NOT certified. Stopped at the checkpoint.**

---

## 10. TR4-R10 + TR4-R11 EXECUTED — predicate consolidation (2026-08-22, Owner: "Continue")

**R10:** the four inline `COALESCE(net_fee_amount, fee_amount)` copies inside `studentBalance.ts`
now use the module's own exported `TUITION_NET_SQL` — the rule is written once in the file that
defines it, as the constant always intended.

**R11:** the active-cash-allocation predicate (`source_kind = 'payment' AND status = 'active'`)
is now `CASH_ALLOCATION_SQL` in `studentBalance.ts`, exported beside the `AID_SOURCE_KINDS_SQL`
it mirrors, and consumed by all three readers — both obligation-position queries (single-table,
now aliased) and the BOS revenue aggregate (multi-join). Verified: **no raw occurrence of the
predicate remains anywhere outside the constant** (grep-clean).

Harness-anchor safety was checked before editing (no harness anchors reference either literal).
Behaviour is provably unchanged: the server suite reports the identical 2843 passed · 162
skipped · 0 failed, and all gates held — mutation **18 passed · 0 failed**, `release:validate`
**22 passed · 0 failed**. Changed: 3 files, +20/−11.

**Remaining, in the registered order:** dead export `getStudentScholarshipSettled` → residuals
R-1…R-4 → the certification question. **WP-07 remains NOT certified. Stopped at the checkpoint.**

---

## 11. DEAD EXPORT REMOVED (2026-08-22, Owner: "Continue")

`getStudentScholarshipSettled` (`core/finance/obligations.ts`) — flagged in the first round of
this engagement as the dead student-keyed twin of the TR4-R9 settlement readers — re-verified
**zero call sites anywhere** (code, tests, scripts, living registries; grep returned only its own
definition) and deleted. The live student-level aid term is `studentBalance.ts`'s internal
`studentScholarshipSettled`, consumed by `getStudentBalance` and — since the TR4-R13 repair — by
both batch readers.

Gates unchanged and green: mutation **18 passed · 0 failed**, `release:validate` **22 passed ·
0 failed**, suite **2843 passed · 162 skipped · 0 failed**. Changed: 1 file, −15 lines.

**Remaining, in the registered order:** residuals R-1…R-4 → the certification question.
**WP-07 remains NOT certified. Stopped at the checkpoint.**

---

## 12. RESIDUALS R-1…R-4 DISPOSED (2026-08-22, Owner: "continue") — 1 closed, 1 refreshed, 2 decision points

**R-3 — CLOSED with evidence.** The dossier's "19 of 26 Class-1 files not deep-read" residual was
already mitigated: the C-2 audit's §6 records the Owner-approved deep read of all six
settlement-touching Class-1 files, with per-file outcomes in §6.1 — including one genuine
reclassification (`balance-single-source-of-truth.test.ts`, `toBeCloseTo` → exact equality after
D-104). Nothing further to do.

**R-2 — OPEN BY DESIGN, evidence refreshed.** `payments.semester` retirement remains future work:
live consumers enumerated — the payment-list surfaces (`students.routes.ts` SELECTs, display
contract) and the refund path (the refund INSERT inherits the reversed payment's semester, the
D-113/D-116 attribution contract). Until those move to allocation-keyed reads, the column is
load-bearing. Recorded; no action available.

**R-1 — DECISION POINT (recommendation attached).** Both BOS revenue reports share
`REVENUE_BY_ALLOCATION_SQL`, whose `JOIN classes` drops tuition revenue for class-less terms,
while `stmtMonthlyRevenue` reads the ledger directly — so the by-class breakdown's sum can be
lower than the branch's true revenue. **Recommended model:** LEFT JOIN + an explicit
"(no class)" attribution bucket so the breakdown reconciles with the ledger-true total (§77),
no silent reallocation to other classes. ~10-line SQL change + reconciliation assertions in the
BOS suite. Awaiting Owner approval (report-visible change).

**R-4 — DECISION POINT (recommendation attached).** Classless enrolments are reachable
(`enrollment-service` writes a term only when `classId && active && writeSemester !== false`;
all three callers pass `writeSemester: false` with their own term rows). D-139's design — bill
the snapshot as one `other` document, no tuition receivable for the nameless term — is PROVEN
and deliberate; the alternative double-bills the callers that own their term.
**Recommended: accept D-139 as final** (residual recorded as designed behaviour, not a defect).
Awaiting Owner decision.

**Standing:** release 22/22 · mutation 18/0 (all survivors documented) · suite 2843/162/0 ·
tree clean. **WP-07 NOT certified. Stopped at the checkpoint.**

---

## 13. R-1 IMPLEMENTED AND PROVEN · R-4 ACCEPTED (2026-08-22, Owner-approved)

**R-1 — executed under the full lifecycle.** `REVENUE_BY_ALLOCATION_SQL` now LEFT-JOINS classes
and branches class-ful rows by the class's branch, class-less rows by the payment's branch (where
the money was actually collected); `revenue-by-class` carries an explicit **`(no class)`** bucket
(`GROUP BY c.id` keeps all class-less terms in exactly one row), and `revenue-by-timeslot`'s
existing `'Unknown'` slot absorbs them by the same rule. Both call sites pass the branch twice.
**Minimum reconciliation coverage added** (a second case in the TR4-R13 cross-surface suite): a
class-ful term (6,000, scheduled 08:00) and a class-less term (4,000) paid through the desk —
asserting `(no class)` appears **exactly once** with 4,000, the class row keeps 6,000, and
**both breakdowns sum to the authoritative ledger income** (10,000). One mid-round fixture error
(the test's own class lacked a schedule time, so its revenue correctly joined 'Unknown') was
diagnosed from the dump and fixed in the fixture — the production change needed nothing.
Gates: mutation **18 passed · 0 failed** · `release:validate` **22 passed · 0 failed** · suite
**2844 passed · 162 skipped · 0 failed**. Changed: `bos.routes.ts` (attribution SQL + 2 call
sites) and the cross-surface suite (+1 case).

**R-4 — accepted as intentional final design, no production change.** Evidence and rationale:
classless enrolments are reachable (`enrollment-service` writes a term only when
`classId && active && writeSemester !== false`; all three callers — manual registration,
student registration, visitor conversion — pass `writeSemester: false` owning their own term).
D-139's behaviour — bill the whole snapshot as one `other` document, create no tuition receivable
for a term that does not exist — is **PROVEN** and deliberate: the alternative bills tuition
twice for the two callers that own their term, or refuses to invoice a real charge. The residual
is hereby recorded as designed behaviour, not a defect. R-2 and R-3 untouched, as directed.

**Standing after the round:** release 22/22 · mutation 18/0 · suite 2844/162/0 · tree clean.
**WP-07 NOT certified — awaiting the Owner's instruction on the §73 certification assessment.**
Stopped at the Decision Checkpoint.
