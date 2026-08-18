# Student Subsystem — Remediation Report

**Date:** 2026-08-18 · **Branch:** `arena/01a0062e-toefl-house`
**Audit remediated:** `f67a8d9` (docs/STUDENT_SUBSYSTEM_AUDIT_2026-08-18.md)
**Commits:** `6bf8570` (backend authorities) · `83c4417` (frontend contract consumption)

---

## 1. Root cause of each finding

| ID | Root cause |
|---|---|
| **STU-C1** | `students.status` had **two** writers. `journey.routes.ts` held its own `stmtUpdateStudentStatus` / `stmtGraduateStudent` pair and wrote the column with no transition validation, accepting `suspended` — which the status endpoint explicitly refuses because suspension must also defer enrollments. The two paths could therefore produce different database states for the same logical action. |
| **STU-C2** | No transition matrix existed anywhere for the student profile. `PATCH /:id/status` accepted any of three values from **any** current state, so `graduated` carried no meaning and could be reversed. Separately, no route consulted student status before mutating, so a graduated student could still be enrolled, transferred and charged. |
| **STU-H1** | Validation lived **inline in the CREATE handler only**. `PATCH /:id` merged raw `req.body` fields straight into the `UPDATE`. `gender` is load-bearing (`assertClassGenderAllowsStudent`, gender-split reports), so this was a business defect, not a data-hygiene one. |
| **STU-H3** | Both the application check and `uq_students_phone` (migration 029) compared the **raw** phone string. The correct normalizer (`phoneMatchKey`, digits-only, last 9) already existed but was used only by the Visitor subsystem. |
| **STU-H4** | Graduation wrote only the profile column. `countActiveStudentsInClass()` counts `enrollments` in `active|confirmed|pending`, so a graduate's enrollment row kept occupying a seat forever. The capacity predicate itself was correct. |
| **STU-H2** | The roster returned a **bare array** capped at `MAX_PAGE_SIZE` with no total, and the UI derived its denominator from that same truncated array (`filteredStudents.length of students.length`). CSV export serialised the loaded page. |

A single theme runs through all six: **a business rule with more than one implementation, or no implementation at the layer that needed it.**

---

## 2. Exact files/modules changed

**New domain authorities**
- `server/src/core/students/student-lifecycle.ts` — `STUDENT_TRANSITIONS`, `assertStudentTransition()`, `assertStudentOperable()`, `STUDENT_STATUSES`. Reuses the existing `assertTransition()` primitive from `core/academic/lifecycle-engine.ts` (the same one Class and Enrollment engines use) rather than inventing a second guard shape.
- `server/src/core/students/student-input.ts` — `normalizeStudentInput()` (modes `create`/`patch`), `assertStudentGender()`, `assertOptionalIsoDate()`, `studentPhoneKey()` delegating to the existing `phoneMatchKey()`.

**Modified**
- `server/src/routes/students.routes.ts` — CREATE and PATCH both call `normalizeStudentInput`; normalized phone lookup; `applyStudentStatus()` becomes the single status writer; `assertStudentOperable` on enroll-class / enroll-semester / transfer / issue-card; roster total headers; shared `buildStudentListWhere()`; new `GET /students/summary` and `GET /students/export`; removed the local `STUDENT_STATUSES` copy (audit STU-M2).
- `server/src/routes/journey.routes.ts` — both shadow prepared statements **deleted**; delegates to `applyStudentStatus()`.
- `src/apiStore.ts`, `src/types.ts`, `src/App.tsx` — `StudentSummary` type, summary fetched alongside the roster, prop wired.
- `src/components/students/StudentsView.tsx` — authoritative caption, server-side CSV export with busy state and real error messages.
- `src/components/students/StudentProfileDrawer.tsx` — lifecycle-aware status buttons, one `changeStatus()` helper surfacing the server's message.

**Deliberately NOT changed:** `class-capacity.ts` (the predicate was correct — the bug was stale enrollment rows), payment/refund/idempotency logic, RBAC, branch isolation, historical migrations.

---

## 3. Database changes

**One forward-only migration: `073_student_phone_identity.sql`.**

- Adds `uq_students_phone_normalized`, a **UNIQUE EXPRESSION INDEX** mirroring `phoneMatchKey()` exactly (strip ` -()+`, take last 9, require ≥7 digits). This is the race-safe final authority; the application check only produces the clean 409.
- **Dirty data handled first, nothing deleted.** Following the precedent of migration 072 (visitors), each duplicate beyond the earliest holder has its phone released to `NULL` with the original value preserved verbatim in `notes`. A student row owns payments, invoices, enrollments and audit history — deleting one destroys financial history.
- **Not added to `schema.sql`**, by design: `schema.sql` runs before migrations, so a dirty production database would abort at `CREATE UNIQUE INDEX` before the cleanup could run.

Verified on a copy of the live 2 163-row database: `students before: 2163, after: 2163 (no rows deleted)`, 2 duplicates released with notes written, index created. Verified on a **fresh** database: both `uq_students_phone` and `uq_students_phone_normalized` present after bootstrap.

---

## 4. Before / after exploit results

Single script, same subject creation, run against the live API.

| Exploit | Before | After |
|---|---|---|
| `journey/events` sets `suspended` (status endpoint refuses it) | **201**, `status=suspended`, enrollment left `active` | **400**, `status=active` |
| `active → graduated` | 200 | 200 (legal) |
| `graduated → inactive` | **200** | **409** |
| `inactive → active` (laundering back) | **200** | **409** |
| graduated student → enroll | **201** | **409** |
| graduated student → transfer | 400 | **409** |
| graduated student → issue ID card (charges money) | **201** | **409** |
| `PATCH {gender:"martian"}` | **200**, persisted | **400**, `gender` unchanged |
| `PATCH {dob:"9999-99-99"}` | **200**, persisted | **400** |
| `PATCH` 5 000-char name | **200**, `LENGTH=5000` | **400**, `LENGTH=15` |
| phone `0700-111-001` vs existing `0700111001` | **201** duplicate | **409** |
| phone `+93700111001` vs same | **201** duplicate | **409** |
| graduate frees a class seat | seat held forever; applicant refused | seat released; **applicant admitted 201** |
| roster caption vs DB truth | **"2000 of 2000"** (true 2 162) | **"Showing 2000 of 2196 students"** |
| CSV export rows | 2 000 (silently truncated) | **2 196 = DB truth**; `status=graduated` filter → exactly 6 |

**On the two "unchanged-looking" lines in the final run — reported honestly:**
- `c1 seats=3 of which graduated=1` is **stale pre-fix data** (that student was graduated before the fix, when nothing closed enrollments). Re-applying graduation through the fixed path dropped the class from 3 seats to 2 with **0 graduates holding a seat**. New graduations are correct; this migration does not retro-close historical enrollments, which is noted as a residual risk in §12.
- `API(limit=5000) = 2000 rows` is **intended**. The brief forbids simply raising the limit. The page stays bounded; what changed is that the client can now *tell* — `X-Total-Count: 2198` is authoritative, the UI says "Showing 2000 of 2198", search reaches offset 2100 fine, and CSV covers all 2 198.

---

## 5. Tests added

**`server/src/tests/student-subsystem-remediation.test.ts` — 47 tests**, HTTP-driven through real routers with real permissions (the audit flagged raw-`INSERT` fixtures as false-confidence coverage).

- **Lifecycle (11):** matrix exhaustiveness; every legal transition accepted; **every illegal transition rejected** (full N×N sweep); graduated terminal; `graduated→inactive` over HTTP; unknown status; legitimate `active→inactive→active`; graduated blocked from enroll/transfer/issue-card; **fee collection after graduation still allowed**.
- **Single authority (5):** source-level assertion that **no route module other than `students.routes.ts` writes `students.status`**; journey cannot set `suspended`; journey enforces the same matrix; journey rejects unknown values; **journey graduation and endpoint graduation produce identical DB state**.
- **Validation parity (10):** 6 payloads × (CREATE rejects **and** PATCH rejects **and** nothing persisted); blanking required fields; legitimate gender correction / boundary-length name / valid DOB; 201-char boundary; gender-policy laundering blocked; unit-level mode symmetry.
- **Phone identity (7):** unit key collapsing; all 5 formats refused with clean 409; genuinely different number accepted (no false positive); PATCH cannot steal via reformatting; PATCH may reformat own number; **DB rejects a raw duplicate insert**; **concurrent creation of 5 format variants yields exactly 1 student, no 500s**.
- **Capacity (4):** active consumes seat → graduate frees it → applicant admitted; enrollment moves to `completed` with `ended_at`, not deleted; suspended still holds seat; **concurrent enrollment at capacity does not overbook**.
- **Pagination/export/summary (10):** `X-Total-Count` = DB truth; non-overlapping page boundaries; total reflects filter; search beyond page 1; **CSV covers full filtered dataset**; CSV branch-isolated; CSV escapes commas/quotes; unknown status filter rejected; summary authoritative and reconciling; summary branch-isolated.

No existing test was weakened, skipped, deleted or rewritten.

---

## 6. Mutation-testing results

**10 mutants · 10 KILLED · 0 survivors.** Every mutant was reverted and the tree verified clean.

| # | Mutant | Result |
|---|---|---|
| M1 | `graduated` becomes non-terminal (`['graduated','active','inactive']`) | **KILLED** (3 failed) |
| M2 | `assertStudentOperable()` early-returns (no-op) | **KILLED** (1 failed) |
| M3 | PATCH skips `normalizeStudentInput` | **KILLED** (9 failed) |
| M4 | Phone lookup reverts to raw `String(phone).trim()` | **KILLED** (1 failed) |
| M5 | `journey.routes.ts` writes `students.status` directly again | **KILLED** (3 failed) |
| M6 | Journey re-allows `suspended` | **KILLED** (1 failed) |
| M7 | Graduation no longer closes enrollments | **KILLED** (3 failed) |
| M8 | `X-Total-Count` header removed | **KILLED** (2 failed) |
| M9 | CSV export re-truncated to one page (`LIMIT 25`) | **KILLED** (1 failed) |
| M10 | Migration 073's unique index dropped | **KILLED** (1 failed) |

This directly answers the audit's central finding: **M1 and M2 in the audit (deleting the status guard, deleting the phone guard) survived all 1 230 tests.** The equivalent mutants are now killed.

---

## 7. Full test count

**1 277 passed / 1 277 · 112 files** (baseline 1 230 / 111 → **+47**, none weakened).

## 8. Lint / typecheck / build

| Gate | Result |
|---|---|
| Server ESLint | **0 errors**, 107 warnings (pre-existing) |
| Server `tsc --noEmit` | **0 errors** |
| Frontend ESLint | **0 errors**, 6 warnings (pre-existing) |
| Frontend `tsc --noEmit` | **0 errors** |
| Frontend build | **OK** |
| Server build | **OK** |

## 9. Schema drift

`preflight:fresh-schema` → **PASS — 72 migrations, no drift.** No historical migration was modified.

## 10. Release gate

`scripts/release-validate.mjs` → **16 passed · 0 failed · 0 skipped — RELEASE VALIDATION PASSED**, including fresh install + migrations (72 migrations, 106 tables, integrity ok) and financial invariants reconciling to 0.

## 11. Live adversarial verification

Beyond the exploit table in §4:

- **Concurrency preserved.** Mixed-path race (5 × `enroll-class` + 5 × `journey/enrollments`) into a capacity-2 class → `1×201, 1×201, 8×409`, **seats = 2/2, no overbooking**.
- **Concurrent duplicate phone.** 5 format variants submitted in parallel → exactly **1 × 201, 4 × 409**, one DB row, **no 500s**.
- **Legitimate workflows all still work:** suspend 200 · resume 200 · gender correction 200 · valid DOB 200 · name edit 200 · own phone unchanged 200 · own phone reformatted 200 · `active→inactive` 200 · `inactive→active` 200 · journey graduation 201 · **fee payment after graduation 201** (arrears remain collectable).
- **Summary vs DB truth:** `{filtered: 2196, unfiltered: 2196, active: 2189, graduated: 6, suspended: 1}` — exact match, buckets reconcile to the total.
- **Rendered frontend evidence** (real React app in jsdom against the live API): caption now reads **"Showing 2000 of 2196 students"**.
- **RBAC/branch isolation untouched** — no authorization code was modified; the release gate's fresh-install and financial-invariant checks pass.

---

## 12. Remaining risks

1. **Historical stale enrollments are not retro-closed.** Students graduated *before* this fix still hold `active` enrollment rows and therefore still consume capacity. I deliberately did **not** add a data-fix to migration 073: silently completing historical enrollments would rewrite academic history on a live database, and the correct action (which enrollments genuinely ended, and when) is an operator decision. **Recommended:** a reconciliation report listing `students.status='graduated'` with non-terminal enrollments, for explicit review. Re-applying graduation through the fixed endpoint corrects each case cleanly.
2. **`uq_students_phone` (raw) still exists** alongside the new normalized index. Harmless — it is strictly weaker — but it is now redundant and should be dropped in a later cleanup migration once the normalized index has proven itself in production.
3. **The client-side transition mirror in `StudentProfileDrawer.tsx` is a second copy of the matrix.** It is presentation-only, explicitly documented as such, and the server re-validates every transition — but it can drift. A shared generated constant would be better if the frontend ever gains a build-time link to server types.
4. **`suspended` students still hold their seat.** This is existing, deliberate behaviour (suspension is temporary and `resume()` must be able to put the student back). It is now asserted by a test so a future change cannot silently reinterpret it — but if the business wants suspended students to free capacity, that is a **policy decision**, not a bug.
5. **STU-M3 / STU-M4 from the audit remain open** — HOD can enroll/suspend but not edit, and all roles can read the full roster. Both were flagged as requiring **owner confirmation**, not as defects, and are out of scope here.
6. **UX-14 is untouched.** No Student change forced a decision on it. The audit's observation stands (visitor conversion copies `visitor.phone` without re-validation, so a phone-less visitor can still become a phone-less student even though the direct Student path requires a phone). Per the brief I am **stopping and reporting** rather than guessing: closing that gap requires the owner's ruling on whether phone is mandatory at conversion.

---

## 13. GO / NO-GO

### ✅ GO for the Student subsystem remediation.

All six confirmed findings — **STU-C1, STU-C2, STU-H1, STU-H2, STU-H3, STU-H4** — are closed, live-verified against a running API and reconciled against database truth, with the original exploits re-run and refused.

Supporting evidence: **1 277/1 277 tests** (+47, none weakened) · **10/10 mutants killed, zero survivors** · lint 0 errors both sides · typecheck 0 errors both sides · both builds OK · **72 migrations, no schema drift** · **release-validate 16/16** · concurrency, payment idempotency, RBAC and branch isolation re-verified intact · working tree clean.

The subsystem now has **one** authority for each rule the audit found duplicated or missing: lifecycle transitions, input validation, phone identity, capacity, and roster filtering.

**This GO covers the Student subsystem remediation only.** It is not a product-level release verdict: the previous pass's accessibility blockers (A-1 – A-4), GL-1/GL-2 human verification, and the UX-14 business decision all remain open and unaffected by this work. Per standing instruction, the terms *"defect-free"* and *"production-ready"* are not used.
