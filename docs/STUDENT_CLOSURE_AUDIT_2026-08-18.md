# Student Subsystem — Post-Remediation Closure Audit

**Date:** 2026-08-18 · **Branch:** `arena/01a0062e-toefl-house` · **HEAD:** `a6c27c3`
**Scope:** resolve the two residual risks recorded in `docs/STUDENT_REMEDIATION_2026-08-18.md` §12.
**Mandate:** evidence gathering and decision preparation only.

> **No production code, migration or test was changed in this pass.**
> `git status --porcelain` → **0** at the start and end of the audit.
> Every reconciliation query runs against a **readonly** database handle.

---

## 1. Student remediation verification

The sandbox was rebuilt from scratch this pass (dependencies reinstalled, `better-sqlite3` recompiled, database re-seeded from `a6c27c3`). All six findings were re-verified live on a **clean** database, so these results are not carried over from the remediation pass.

| Finding | Probe | Result |
|---|---|---|
| STU-C1 | `POST /journey/events {status:"suspended"}` | **400**, `students.status` stays `active` |
| STU-C2 | `graduated → inactive` | **409** |
| STU-C2 | graduated student → `enroll-class` | **409** |
| STU-C2 | graduated student → `issue-card` (chargeable) | **409** |
| STU-H1 | `PATCH {gender:"martian"}` | **400** |
| STU-H1 | `PATCH {dob:"9999-99-99"}` | **400** |
| STU-H3 | `+93…` duplicate of an existing `07…` | **409** |
| STU-H2 | roster `X-Total-Count` header | **present and authoritative** |

**Gates re-run this pass:** tests **1277/1277 (112 files)** · server ESLint **0 errors** (107 pre-existing warnings) · server `tsc` **0 errors** · frontend `tsc` **0 errors** · fresh-schema preflight **72 migrations, no drift** · `release-validate` **16 passed / 0 failed / 0 skipped**.

Migration `073_student_phone_identity.sql` applied cleanly on the rebuilt database; both `uq_students_phone` and `uq_students_phone_normalized` are present.

**Conclusion: the remediation is intact and reproducible from a clean checkout.**

---

## 2. Historical capacity reconciliation

### 2.1 Surface trace (who can create a stale seat-consuming row)

| Concern | Finding |
|---|---|
| Definition of "consumes a seat" | `core/academic/class-capacity.ts` — `enrollments.status IN ('active','confirmed','pending')`. Single authority; unchanged. |
| Writers of `students.status` | **Exactly one**: `applyStudentStatus()` in `students.routes.ts`. `journey.routes.ts:158` delegates to it. No other production writer exists. |
| Writers that close enrollments on graduation | **Exactly one**: `stmtCompleteEnrollmentsOnGraduation` inside `applyStudentStatus()`. |

**No new shadow writer was found.** Any stale row present today must predate `6bf8570`.

### 2.2 The reconciliation tool (read-only)

`/tmp/stu/reconcile.cjs` opens the database with `{ readonly: true }` and performs **no writes**. It copies the capacity predicate verbatim from `class-capacity.ts` so the report cannot drift from the runtime rule.

For every affected row it reports: student id/code/name, lifecycle status, branch, enrollment id/status/type, class id/name/status/lifecycle-stage/capacity/end-date, enrollment start & end dates, semester status, final score/grade, graduation event count and timestamp, whether the row currently consumes capacity, a category and a recommended action.

### 2.3 Classification rules (derived from existing product semantics, not invented)

| Category | Rule | Rationale |
|---|---|---|
| **A** — genuinely inconsistent | Student `graduated` **or** the class is `completed`/`cancelled`/`archived`, while the enrollment is still `active`/`confirmed`/`pending` | `graduated` is terminal in `student-lifecycle.ts`; the enrollment should have been closed with it. A finished class cannot have a contended seat. |
| **B** — legitimate | *(no rows qualified — see note)* | Reserved for enrollments that are genuinely still academically active. |
| **C** — ambiguous | Student `inactive` with an open enrollment | `inactive → active` is a **legal, reversible** transition. The open enrollment may be an intentionally held seat for a returning student. Not safely automatable. |

**`suspended` students are deliberately excluded and reported separately.** Suspension intentionally holds the seat so `resume()` can restore the student; this is asserted by an existing test and is **not** a defect.

### 2.4 Measured impact

The production database is not available to this sandbox. To prove the tool classifies correctly, a **disposable copy** (`/tmp/stu/hist.sqlite`) was seeded with rows shaped exactly as the pre-remediation code would have left them (graduation touching only `students.status`).

```
affectedStudents        : 6
affectedEnrollments     : 6
affectedClasses         : 3
byCategory              : { A: 5, C: 1 }
classesCurrentlyFull    : 1
classesBlockedByStaleRows: 1
currentlyBlockedSeats   : 2
```

| Class | Capacity | Seats used | Stale | After reconciliation | Full? | Blocking real applicants? |
|---|---|---|---|---|---|---|
| Autumn Full Class | 3 | 3 | 2 | **1** | yes | **YES** |
| Spring 2025 (finished) | 20 | 2 | 2 | 0 | no | no |
| Winter Open Class | 20 | 3 | 2 | 1 | no | no |

The tool correctly **excluded** a properly-closed graduate (`status='completed'`) and correctly **separated** the suspended student. Cross-checks: `semestersActiveWithoutActiveEnrollment: 0`, `overbookedClasses: []`, `graduatedWithActiveSemesters: 5` (the same category-A population, seen through the semester projection).

**Operators must run this tool against production to obtain the real counts.** The numbers above validate the instrument, not the live estate.

### 2.5 Controlled live verification

A disposable scenario was constructed exactly as the brief requires — graduated student, old enrollment still present, class at capacity:

```
class 'vcap' capacity 2, two students enrolled          -> seats 2/2
simulate PRE-FIX graduation (status only)               -> student=graduated, enrollment=active
seats consumed                                          -> 2/2   (stale row still counted)
new applicant                                           -> 409 "Selected class is full."   [BLOCKED]
```

Then the corrective path:

```
re-apply graduation while already 'graduated'
  -> HTTP 200 {"ok":true,"unchanged":true}   seats still 2/2   << DOES NOT SELF-HEAL
reactivate, then graduate through the remediated path
  -> enrollment becomes 'completed'          seats 1/2
new applicant retry                          -> 201 ADMITTED
```

**Two conclusions, both material:**

1. **The remediation behaves exactly per the intended capacity rule for new transitions.** Graduating through the fixed path releases the seat and admits the previously-blocked applicant.
2. **The system does not self-heal historical rows.** `students.routes.ts:1345` short-circuits with `if (from === status) return res.json({ ok: true, unchanged: true })`. This idempotency guard is correct in itself (re-sending a status must not re-fire side effects), but it means **an operator cannot repair a stale row simply by re-graduating** — they must first move the student back to `active`, which is itself an audited status change and briefly re-opens the enrollment. That is an awkward manual workaround, and it is the strongest argument for a proper reconciliation path.

---

## 3. Exact affected historical records / categories

Per affected row the report emits:

`student_id · student_code · full_name · student_status · branch_id · enrollment_id · enrollment_status · class_id · class_name · class_status · lifecycle_stage · capacity · class_end_date · started_at · ended_at · enrollment_type · semester_name · semester_status · final_score · letter_grade · graduation_events · graduated_at · consumesCapacity · category · reason · recommended action`

**Category A — inconsistent (recommend: close enrollment to `completed`)**
- A1 Graduated student, class still running → the seat is wrongly occupied; this is the revenue-affecting case.
- A2 Graduated student, class finished/archived → pure bookkeeping; no seat contention.

**Category C — ambiguous (recommend: human review)**
- C1 `inactive` student with an open enrollment. `inactive → active` is legal, so the held seat may be intentional. **Must not be automated.**

**Excluded by design**
- `suspended` students holding seats (deliberate, test-locked behaviour).
- Graduates whose enrollments are already terminal (`completed`/`transferred`/`dropped`/`withdrawn`).

---

## 4. Is historical mutation recommended?

**Yes for Category A — but it requires explicit owner approval, and none was performed in this pass.**

### Proposed strategy (NOT implemented)

**Step 1 — Measure.** Run `reconcile.cjs` against a production snapshot. If `affectedEnrollments = 0`, no migration is needed and Risk 1 closes on evidence alone.

**Step 2 — Category A2 first (zero risk).** Enrollments on `completed`/`cancelled`/`archived` classes. No seat contention, no academic ambiguity. Set `status='completed'`, `ended_at = COALESCE(ended_at, class.end_date, graduated_at)`.

**Step 3 — Category A1 (revenue-affecting, needs sign-off).** Graduated students on running classes. Same transition; `ended_at` from the graduation journey event where available, else the migration timestamp. Every row must be listed in the migration comment or an exported manifest before it runs.

**Step 4 — Category C: never automate.** Produce an operator worklist. Each case is decided individually.

### Safety requirements for any such migration
- **Forward-only**; never modify a historical migration.
- **Idempotent** (`WHERE status IN ('active','confirmed','pending')`) so a re-run is a no-op.
- **Non-destructive** — status transition only. No row deleted; `enrollment_events`, payments, invoices and audit history untouched.
- `active → completed` is already legal in `ENROLLMENT_TRANSITIONS`, so the data stays valid under the state machine.
- The platform already writes an automatic pre-migration backup (observed: `pre-migration-*.sqlite`).
- Must be preceded by an exported manifest of affected rows.

### Risks
| Risk | Mitigation |
|---|---|
| A student was graduated **in error** and is genuinely still attending | Category A1 requires a manifest reviewed before execution. Correction path: reactivate and re-enroll. |
| `ended_at` is a guess where no graduation event exists | Use the migration timestamp and record in `notes` that it is a reconciliation estimate, not an observed date. |
| Fee obligations attached to the closed semester | Closing an enrollment does **not** cancel money owed — verified: fee payment after graduation still returns **201**. Arrears remain collectable. |
| Reports keyed on `enrollments.status` shift | Expected and desired; that shift is the defect being corrected. Communicate before running. |

> **⚠️ APPROVAL REQUIRED.** No data-changing migration is proposed for merge in this pass. Owner sign-off is needed on (a) whether to reconcile Category A at all, and (b) whether A1 may be automated or must be row-by-row.

---

## 5. UX-14 phone contract — evidence

### 5.1 Contract as it stands (traced end to end)

| Layer | Visitor | Student |
|---|---|---|
| Frontend form | **required** + Afghan format (`AddVisitorForm.tsx:102-103`) | **required** (`AddStudentForm.tsx:100`) |
| API validation | **not required, no format check** (`visitors.routes.ts:475`) | **required** (`student-input.ts:151`) |
| Normalization | `phoneMatchKey()` used for advisory dedup only | `studentPhoneKey()` on create **and** patch |
| DB column | `TEXT`, nullable, **no unique index** | `TEXT`, nullable, `uq_students_phone` + `uq_students_phone_normalized` |
| Conversion | `visitors.routes.ts:766` copies `visitor.phone` **verbatim, with no re-validation** | — |

### 5.2 Q1 — Where is phone operationally required?

| Function | Requires phone? | Evidence |
|---|---|---|
| Student identity | **No** — identity is `student_code` (`NOT NULL UNIQUE`) | schema |
| Duplicate detection | **Yes, materially** — `uq_students_phone_normalized` + `findStudentByPhoneKey`. Without a phone the only remaining hard key is Tazkira (also nullable); dedup degrades to name matching | `students.routes.ts:81`, migration 073 |
| SMS / WhatsApp | **No sender exists.** Only rule *metadata* (`channel: 'sms' \| 'whatsapp'` in `rule-engine.ts:25`, one seeded template in `automations.routes.ts:403`). No integration, no dispatch code | grep across `server/src` |
| Payment / receipt | **No** — verified live: payment on a phone-less student → **201** | live probe |
| Class management | **No** — enrollment/capacity never read phone | `enrollment-service.ts` |
| Reports | **No** — no report groups or filters by phone | `reports.routes.ts` |
| Portal / account creation | **No** — portal login is `student_code` + `full_name` (`auth.routes.ts:226-232`) | source |
| Search | **Optional** — phone is one of seven searchable fields; name/code still work | `students.routes.ts:431` |

**So phone is load-bearing for exactly one thing today: duplicate prevention.** Everything else degrades gracefully. That is an important input to the decision — the case for mandatory phone rests on data quality and future contactability, not on current runtime breakage.

### 5.3 Q2/Q3 — Data profile

Measured with `/tmp/stu/ux14.cjs` (readonly). This sandbox's dataset is small; **the instrument is what matters — operators must re-run it against production.**

| Metric | Students | Visitors |
|---|---|---|
| Total | 5 | 6 |
| NULL phone | 0 | **3** |
| Empty phone | 0 | 0 |
| Malformed (fails `^(07\|\+937)\d{8}$`) | 0 | **2** |
| Well-formed | 5 | 1 |
| Duplicate normalized groups | **0** (index enforces) | **1** (2 rows) |

`studentsWithoutPhone` → **empty**. `visitorsThatWouldViolate` (unconverted, no phone) → **3**. `visitorsMalformedThatWouldConvert` → **2**. `visitorsCollidingWithStudentPhone` → 0.

### 5.4 Q4 — What conversion actually does (live)

| Visitor phone | Conversion | Resulting `students.phone` |
|---|---|---|
| **A. NULL** | **201** | `null` — **violates the direct-creation contract** |
| **B. Malformed** `"not-a-phone!!"` | **201** | `"not-a-phone!!"` — **violates format validation** |
| **C. Valid** `0766500001` | 201 | `"0766500001"` ✅ |
| **D. Duplicate** `+93766500001` of C | **409** | blocked — **but by the DB index**, surfacing the generic `errorHandler.ts:45` message *"A record with this unique information already exists."*, not a phone-specific 409 |
| **E. Empty string** `"   "` | **201** | `null` |

**Case D is the good news:** migration 073 already protects the conversion path from duplicates, because the index is enforced regardless of entry point. **Cases A, B and E are the gap** — conversion bypasses `normalizeStudentInput()` entirely.

### 5.5 Q5 — Does any legitimate workflow intentionally create phone-less students?

**No.** There are exactly two production `INSERT INTO students` sites:
- `students.routes.ts:722` — validates phone as required.
- `visitors.routes.ts:765` — conversion, no validation.

There is no import script, no automation writer, no seed path that creates operational students. **The phone-less student is a by-product of the unvalidated conversion copy, not a supported workflow.**

### 5.6 Downstream behaviour of a phone-less student (live)

payment **201** · issue ID card **201** · appears in roster **YES** · included in CSV export **1 row** · PATCH edit **200** · **repairable**: `PATCH {"phone":"0788112233"}` → **200**, stored correctly.

**Nothing breaks at runtime, and the record is repairable in place.** This materially lowers the urgency and makes a "validate at conversion + backfill" approach viable.

### 5.7 ⚠️ INSUFFICIENT BUSINESS DECISION — contradictory signals

The codebase contains **directly contradictory** statements of intent for the same field:

1. The visitor **UI** requires phone with Afghan-format validation; the visitor **API** requires nothing. Whichever is correct, one of them is wrong today.
2. The Student API mandates phone while the Visitor→Student path — which creates Students — does not.
3. `duplicate-lookup.ts:11` documents a **deliberate** decision that phone is *not* unique for visitors ("household and office lines are legitimately shared"), while migration 073 makes it **strictly unique** for students. Both may be intentional, but the boundary has never been stated.

**Per the brief, this is marked INSUFFICIENT BUSINESS DECISION.** The technical facts are now fully established; the rule is not derivable from the code because the code disagrees with itself.

---

## 6. A / B / C decision matrix

*(Record counts are from this sandbox; operators must substitute production figures from `ux14.cjs`.)*

| Dimension | **A — Mandatory at Visitor registration** | **B — Optional everywhere** | **C — Optional for Visitor, mandatory at conversion** |
|---|---|---|---|
| **Affected existing records** | 3 visitors with NULL + 2 malformed must be fixed **before** any constraint | 0 immediately; relax the Student rule + reconsider index 073 | 3 NULL-phone visitors only blocked **at conversion**; 0 students affected |
| **Affected workflows** | Walk-in registration; any API client; visitor import | Student create/patch; dedup guarantees weaken | Conversion endpoint only |
| **Implementation scope** | Add validation to `POST/PATCH /visitors`; align UI; backfill; optional visitor unique index | Remove requirement from `student-input.ts`; decide whether to drop 073's index | Call `normalizeStudentInput`-style phone validation in the conversion path; add a UI prompt to capture phone during conversion |
| **Migration / cleanup** | **Required** — backfill or release NULL/malformed visitor phones before any constraint | **Possibly destructive** — dropping `uq_students_phone_normalized` re-opens STU-H3 | **None** — enforcement lives in the conversion path; no historical rewrite |
| **Operational risk** | **High** — a walk-in who won't share a number cannot be recorded; staff will type `0700000000`, which poisons dedup worse than NULL | **Medium** — reintroduces the audited defect class: paying students with no contact method | **Low** — front desk never blocked; a dead end at the payment step is possible if the UI doesn't prompt for a phone |
| **User-facing impact** | Front-desk friction on every lead | None visible; silent data-quality decay | Friction only at conversion, where money is already being collected |
| **Effect on STU-H3 guarantees** | Strengthens (extends normalization to visitors) | **Weakens or removes** | Preserves exactly as remediated |
| **Consistency with `duplicate-lookup.ts:11`** | **Contradicts** the documented "phone is deliberately not unique for visitors" note | Consistent | Consistent |

**Not chosen here.** All three are technically implementable from the current codebase.

---

## 7. Exact business decision required from the owner

Three questions. Only the first is blocking.

**DECISION 1 (blocking — UX-14).**
> Must a Visitor have a phone number to become a Student? Choose **A**, **B** or **C**.
> If **C**: should the format rule be the strict `^(07|\+937)\d{8}$`, or a lenient normalise-then-validate that accepts `+93`, spaces and dashes and stores a canonical form? *(Evidence favours lenient: the strict pattern rejects landlines and foreign numbers, and `phoneMatchKey` already normalises for comparison.)*

**DECISION 2 (blocking for Risk 1 — historical reconciliation).**
> (a) Reconcile Category A stale enrollments at all?
> (b) May Category A1 (graduated on a **running** class — the seat-blocking case) be closed automatically, or must each row be reviewed?
> (c) Confirm Category C (`inactive`) is **excluded** from automation.

**DECISION 3 (non-blocking, resolve the contradiction).**
> Should the visitor UI's phone requirement be relaxed to match the API (visitor phone genuinely optional), or should the API be tightened to match the UI? Today they disagree, and `duplicate-lookup.ts:11` documents a third position.

---

## 8. Remaining technical risks

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | Historical Category-A enrollments still consume capacity; **no self-heal** (the `unchanged: true` short-circuit) | **Medium** — revenue-affecting only where a class is full | Characterised; awaits DECISION 2 |
| 2 | Conversion bypasses `normalizeStudentInput()` (NULL/malformed phone reach `students`) | **Medium** | Characterised; awaits DECISION 1 |
| 3 | Conversion duplicate-phone returns a **generic** 409 from the DB constraint rather than a phone-specific message | **Low** — correctly blocked, poor operator message | New observation this pass |
| 4 | `uq_students_phone` (raw) is now redundant alongside `uq_students_phone_normalized` | **Low** — strictly weaker, harmless | Deferred cleanup |
| 5 | Client-side transition mirror in `StudentProfileDrawer.tsx` can drift from the server matrix | **Low** — presentation only; server re-validates | Accepted, documented |
| 6 | `suspended` students hold their seat | **None** — deliberate, test-locked | Policy question only |
| 7 | Visitor phone has **no** normalization or uniqueness at any layer | **Low today**, rises under Option A | Awaits DECISION 1 |

**No hidden blocker was found.** No new defect class emerged; item 3 is a message-quality issue on an already-correct refusal.

---

## 9. Can Student be considered FROZEN?

**Conditionally — yes on code, no on policy.**

Frozen (no further work identified):
- All six remediated findings verified live on a rebuilt environment.
- Single authorities confirmed intact: one status writer, one validator, one phone-identity rule, one capacity predicate, one roster filter builder.
- Full gate suite green.
- No shadow writer, no regression, no new defect class.

Not frozen (blocked on the owner, not on engineering):
- **Risk 1** needs DECISION 2 before any historical reconciliation.
- **Risk 2** needs DECISION 1; the conversion contract cannot be written without the business rule.

Both are **fully characterised with reproducible instruments** (`reconcile.cjs`, `ux14.cjs`). Neither needs further investigation — only a ruling.

---

## 10. GO / NO-GO

### ✅ **VERDICT: STUDENT SUBSYSTEM CONDITIONALLY FROZEN**

Per the brief's criteria: both residual issues are fully characterised and no hidden blocker was found — **but both terminate in unresolved business decisions**, so the verdict is *conditionally* frozen rather than frozen.

**GO** for the Student subsystem **codebase** at `a6c27c3`: remediation verified from a clean rebuild, 1277/1277 tests, lint and typecheck clean, 72 migrations with no drift, release gates 16/16, working tree untouched by this audit.

**NO-GO** for declaring Student *closed*: two owner decisions are outstanding (DECISION 1 — UX-14 phone contract, marked **INSUFFICIENT BUSINESS DECISION** because the codebase contradicts itself; DECISION 2 — historical capacity reconciliation approval).

Once both decisions are supplied, the remaining work is small, bounded and already specified: a conversion-path validation call, and one idempotent forward-only reconciliation migration gated on an operator-reviewed manifest.

**This verdict covers the Student subsystem only.** It is not a product-level release statement: the accessibility blockers (A-1 – A-4), GL-1/GL-2 human verification, and the wider UX-14 rollout remain open from earlier passes. Per standing instruction, the terms *"defect-free"* and *"production-ready"* are not used.

---

### Appendix — read-only instruments produced

| Tool | Purpose |
|---|---|
| `/tmp/stu/reconcile.cjs` | Historical capacity reconciliation. Readonly handle; classifies A/B/C; emits per-row operator detail, class-pressure table and consistency probes. |
| `/tmp/stu/ux14.cjs` | Phone-contract data profile for students and visitors: NULL/empty/malformed/well-formed counts, normalized-duplicate groups, conversion-violation projections, schema truth. |
| `/tmp/stu/verify.sh` | Re-verifies all six remediated findings against a running API. |
| `/tmp/stu/seed_hist.cjs` | Builds a **disposable** pre-remediation dataset to validate the reconciler's classification logic. Never run against production. |

These live under `/tmp` and are intentionally **not** committed: they are diagnostic instruments, not product code. Their logic is reproduced in this report so it can be re-created or promoted to `scripts/` if the owner approves a reconciliation.
