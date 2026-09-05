# Forensic Audit · Wave 21 — Write-offs & Withholding Verdict

**Wave:** 21 · Complete the financial section per the decisions already made
**Date:** 2026-09-05
**Mandate:** reconcile every remaining W20 policy gate against the complete decision record; implement every previously-decided semantic; only items with no authoritative prior decision may remain POLICY REQUIRED; do not touch the deferred cash-count track.
**Verdict: PASS** — the three remaining semantic families are fully implemented under the owner's semantic-layer authorization (D-192, registered from the closure mandate exactly as D-181 was registered from the W16 directive), and the register is closed to seven evidence-gated parameter residuals (D-196).

---

## 1 · Decision-history recovery (what the record actually says)

Full cross-read of `decisions.md` (196 rows), wave verdicts 12–20, the W14
policy-gate register and the certification corpus:

| Family | Prior record | Resolution |
| --- | --- | --- |
| Supplier credit / returns / loans | D-181 semantics, implemented W20 (D-190) | already closed; residuals are parameters |
| Student tuition write-off | P16 open since W14; D-182/D-186/D-191 gated it | **owner semantic authorization now given** (closure mandate): memo discharge — implemented (D-193) |
| Employee-advance write-off | D-14/11-C: advances are receivables, non-expense | **owner semantic authorization**: staff-cost reclassification — implemented (D-194) |
| Payroll withholding | WH "owner evidence first" since W14 | **owner semantic authorization**: liability until remittance — implemented (D-195) |
| Depreciation / disposal proceeds | D-181(2) "unrepresentable until policy exists"; D-182 gated; D-188 re-gated after custody loss | **no prior decision exists** → remains POLICY REQUIRED (evidence in §5) |
| Physical cash counting | deferred by owner | untouched, per mandate |

The mandate's own qualifier — "where already established / where already
decided" — is honored precisely: for the three implemented families the mandate
ITSELF is the owner decision (registered as D-192 with the same
semantic-layer/numeric-layer split the owner authorized for D-181); for
depreciation/disposal it correctly concedes no decision exists.

## 2 · What was implemented

### 2.1 Tuition write-off — a memo discharge (D-193)

Unpaid tuition was never revenue, so the discharge writes **zero ledger rows**:
one append-only `tuition_write_offs` event + one `source_kind='write_off'`
allocation (the memo settlement every derivation already knows how to read),
obligation `open → discharged` (guarded, final), open tuition invoices →
`written_off`. Every tuition-outstanding derivation subtracts the discharge
**and reports it separately from paid** (`tuitionDischarged`): single-student
balance, roster page, id-set balances, `getBranchOutstanding`, receivables
aging, `getObligationPosition`. The academic hold disarms exactly when the
debt is no longer owed. New invariant **I25**; **I6** extended (post-discharge
settlements are corruption, pre-discharge settlements are legitimate history);
DB-level `trg_allocations_obligation_live` refuses any new settlement on a
non-open obligation; I5/I15 exclude `written_off`; re-instatement has no route.

### 2.2 Employee-advance write-off — a classification truth (D-194)

The cash left at advance time (envelope-backed `salary_advance` fact). The
write-off appends an immutable `advance_write_offs` event pinning the whole
fact; **no money moves and the immutable row is untouched**. The
operating-expense lens now counts it as a staff cost (income statements,
dashboard, BOS margin) while the non-expense lens stops counting it — the
overlay is correlated on the row id (the naive bare-`id` form would silently
bind to the event table's own id; the suite would have caught it). New
invariant **I27**.

### 2.3 Payroll withholding — a liability until remittance (D-195)

Wage facts keep booking **gross**. A declaration (`Payroll.Edit`) states what
was withheld at source from one posted wage fact — a fact, never a rate —
bounded by trigger (≤ gross, same branch, posted teacher/employee ledger
period; advances cannot host withholding; one per wage payment). Remittance
hands the cash to the authority through a signed-negative P&L-neutral
`withholding_remittance` row at branch main, evidence-bound to the guarded
`open → remitted` flip. Conservation taught everywhere: **I11**, **I16**,
reconciliation `expectedMain`, daily statement `withholdingRemitted`. New
invariant **I26**. The register reports gross/withheld/**netPaid** and the
open-liability position.

### 2.4 Convergence

`ensureWriteOffWithholdingShape` copy-swaps the four widened tables
(`financial_transactions`, `student_obligations`, `obligation_allocations`,
`invoices`) on pre-W21 databases. Probe: markers converged, rows preserved,
FK clean, new type writable, W21 tables + triggers present.

## 3 · Adversarial verification — `wave21-write-offs-withholding.test.ts` (5/5)

- **A** zero-ledger discharge (ft count byte-identical); obligation/invoice
  finality; balance `tuitionPaid 3 000 / tuitionDischarged 7 000 /
  outstanding 0`; branch outstanding and aging drop to 0; short-reason 400;
  teacher 403; replay 409; pay-on-written-off refused; settled obligation 409;
  direct-write settlement attack refused by the DB trigger; checker green
  after every step (I6/I25).
- **B** both classification lenses flip by exactly the advance amount with
  zero ledger writes; replay 409; partial-amount/non-advance tamper refused by
  trigger; teacher 403; checker green (I27).
- **C** over-gross 400; withholding-on-advance 404; teacher 403; register
  netPaid 9 600; remit −2 400 at branch main with I11/I16/I26 green; replay
  and duplicate declaration 409; reconciliation variance 0; daily statement
  movement −2 400 with closing equal to the live store.

Defects the suite forced out (found → fixed → proven): an ambiguous-column
bug in the discharged subquery; a wrong-column teacher-ledger bound in the
schema trigger; a silent id-misbinding in the classification overlay; an I6
design error that would have flagged legitimate pre-discharge settlements; a
test-world I4 violation (partial-billing a tuition invoice). All fixed;
nothing papered over.

## 4 · Verification gates

| Gate | Result |
| --- | --- |
| tsc (prod + test configs) | clean |
| W21 suite | 5/5 |
| Neighbors (W16/W19/W20, payroll idempotency, invariant checker) | 53/53 |
| Full suite | **3018 passed / 0 failed** (227 files) |
| Convergence probe (regressed pre-W21 DB) | PASS |
| Registries audit | PASS |
| Protocol audit | PASS |
| `release-validate` (all 22 gates) | **ALL PASS** (fresh install 135 tables, idempotent; money lifecycle reconciles to 0) |

## 5 · Remaining policy gates — with evidence no prior decision resolves them

1. **Depreciation and disposal-proceeds economics** — D-181(2) records the
   owner authorization as covering the custody register only, with
   "depreciation/disposal … unrepresentable until policy exists"; D-182 gates
   "depreciation policies"; D-188 implemented custody loss and explicitly kept
   "proceeds-bearing disposal, retirement and depreciation … POLICY REQUIRED".
   The closure mandate's own text ("where already decided") concedes no
   decision exists. No schema, semantic or numeric hook may be inferred.
2. **Supplier payment terms / due dates and master governance** (D-190/D-191).
3. **Loan lender / interest rate / repayment schedule** — no rate decision;
   the interest surface deliberately does not exist (D-190).
4. **Supplier-refund settlement terms beyond cash** (D-190).
5. **Withholding rate structure** — the capability records declared facts;
   which taxes and at what rates is unwritten anywhere in the record.
6. **Write-off materiality thresholds and the recovery window** — P16's
   numeric layer; the mandate supplied the semantics, not the numbers.
7. **Physical cash counting** — deferred by owner decision; untouched.

Items 2–6 are parameters of implemented capabilities, not missing semantics —
the exact distinction the closure mandate draws.

## 6 · Final verification (executed on the committed tree)

- Full suite: **227 files, 3018 passed / 0 failed** (the two environment-dependent skips of prior waves ran and passed this run — strictly more coverage)
- Registries: PASS (531 rows) · Protocol: PASS (seal `f41f0c87eb8c507f…`)
- `release-validate`: **ALL 22 GATES PASS**

## 7 · Evidence paths

- Suite: `server/src/tests/wave21-write-offs-withholding.test.ts`
- Schema: `server/src/db/schema.sql` (W21 block + four widened CHECKs),
  `server/src/db/connection.ts` (`ensureWriteOffWithholdingShape`)
- Core: `server/src/core/finance/write-offs.ts`, `obligations.ts`,
  `ledger-classification.ts`, `invariant-checker.ts` (I25/I26/I27)
- Derivations: `src/utils/studentBalance.ts`, `src/utils/reconciliation.ts`,
  `src/core/reporting/financial-observability.ts`
- Routes: `server/src/routes/finance.routes.ts` (W21 section)
- Registries: `docs/registries/decisions.md` D-192…D-196
