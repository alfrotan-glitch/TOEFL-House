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
