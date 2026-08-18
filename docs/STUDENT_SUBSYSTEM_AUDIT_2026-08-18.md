# Student Subsystem — Full Adversarial Audit

**Date:** 2026-08-18 · **Branch:** `arena/01a0062e-toefl-house` · **HEAD:** `d38b977`
**Mandate:** Audit only. No production code changed. `git status` clean at start and end.
**Environment:** purpose-built DB `/tmp/stu/erp.sqlite`, live API on :4000, 2 branches, 9 real users across every role, 2 163 students, real HTTP requests throughout.

---

## 0. Method

Every finding below was **reproduced against the running API** and **reconciled against DB truth** via direct SQLite reads. Where a suspicion could not be reproduced, it is listed in Section E as REJECTED. Frontend claims use rendered-DOM evidence (real React app booted in jsdom against the live API, same harness as the previous pass).

Test-quality claims are backed by **mutation testing**: the full 1 230-test suite was re-run with guards deliberately deleted.

---

## 1. SURFACE MAP

Route names were not trusted. This is the inventory of **actual writers**.

### Writers to `students` (production, excluding tests)

| # | Location | Operation |
|---|---|---|
| 1 | `routes/students.routes.ts:74` | `INSERT INTO students` — manual registration |
| 2 | `routes/visitors.routes.ts:75` | `INSERT INTO students` — visitor conversion |
| 3 | `routes/students.routes.ts:126,128,130,131` | `UPDATE` card / profile / **status** / installments |
| 4 | `routes/journey.routes.ts:17,18` | **`UPDATE students SET status`** — second status authority |
| 5 | `core/academic/enrollment-service.ts:156` | `UPDATE students SET current_class_id` |
| — | `db/migrations/006_clear_demo_entities.sql` | historical demo purge (not reachable at runtime) |

**There is no `DELETE` route for students** (`grep -c studentsRouter.delete` = 0). Removal is status-only — a sound design choice for a financial subsystem.

### Writers to enrollment tables

`core/academic/enrollment-service.ts` (authoritative lifecycle), `core/journey/journey-engine.ts:149`, `routes/students.routes.ts:65,77`, `routes/visitors.routes.ts:77`, `routes/waitlist.routes.ts:78`, `routes/classes.routes.ts:141,144,212`.

### Enrollment entry points (all traced)

`POST /students/manual` (with `classId`) · `POST /students/:id/enroll-class` · `POST /students/:id/enroll-semester` · `POST /students/:id/journey/enrollments` · `POST /visitors/:id/convert` · `POST /classes/:id/waitlist/:wid/promote` · promotion/auto-drop in `classes.routes.ts` and `sessions.routes.ts`.

**All of them route through `EnrollmentService.enroll()` and share `countActiveStudentsInClass()` from `core/academic/class-capacity.ts`.** This is genuinely a single authority — verified by mixed-path concurrency testing (§E, C-4). No shadow enrollment writer was found.

### Background / automation writers

None. `grep` over automation, event-handler and job code found no student writers. There is no import script and no `scripts/` directory.

---

## A. CRITICAL FINDINGS

### STU-C1 · `journey/events` is an unguarded second status authority that bypasses the documented lifecycle guard
**Severity:** Critical · **Ownership:** Backend · **Roles affected:** owner, manager, registrar

**Root cause.** Two independent writers set `students.status`:
- `routes/students.routes.ts:1110-1116` — validates: `if (!['active','inactive','graduated'].includes(status)) throw 400 'Use the suspend/resume workflow for suspended status.'`
- `routes/journey.routes.ts:127-135` — validates **nothing** beyond membership in a 4-item list, and writes `status` directly. It also handles `GRADUATED` with a hardcoded `UPDATE students SET status='graduated'`.

The journey path is a *"profile status mirror (not source of truth — journey is)"* per its own comment — but it writes the same column the rest of the system reads.

**Reproduction (live):**
```
PATCH /api/students/{id}/status  {"status":"suspended"}
  → 400 "Use the suspend/resume workflow for suspended status."   ← guard works

POST /api/students/{id}/journey/events
     {"eventType":"journey.status_changed","payload":{"status":"suspended"}}
  → 201                                                            ← guard BYPASSED
  DB: students.status = 'suspended'
  DB: active enrollments = 1   ← the real /suspend workflow DEFERS enrollments; this does not
```

**Business impact.** `POST /students/:id/suspend` runs `EnrollmentService.suspend()`, which sets enrollments to `suspended` and semesters to `deferred`. The journey path sets the status column **only**, producing a student who is `suspended` in every list, badge and report while still holding an active enrollment, an active semester, an active fee obligation and a class seat. The two representations of the same student permanently disagree.

**Existing test coverage:** none. `grep` for `journey/events`, `journey.graduated`, `status_changed` across `server/src/tests/` returns **zero** files.

**Why tests missed it:** the suite tests the documented endpoint and never exercises the alternate writer. This is the same "shadow path" class the Visitor audit was commissioned to find, in a different subsystem.

**Correct fix:** one status authority. `journey.routes.ts` must delegate to the same domain service (`EnrollmentService.suspend/resume` + a single `applyStudentStatus()` transition function) rather than issuing its own `UPDATE`. Do not merely copy the enum check into the journey route — that would create a third copy of the rule.

**Regression test required:** for every status value, assert `PATCH /status` and `POST /journey/events` produce **identical** DB state (students.status *and* enrollments/semesters), plus a test asserting only one module contains `UPDATE students SET status`.

---

### STU-C2 · No lifecycle state machine: any status → any status, and graduated students remain fully mutable
**Severity:** Critical · **Ownership:** Backend

**Root cause.** There is no transition table anywhere. `PATCH /:id/status` accepts any of `active|inactive|graduated` from any current state, and no endpoint consults student status before mutating.

**Reproduction (live, single student):**
```
active → graduated  → 200 OK
graduated → inactive → 200 OK      ← reversal of a terminal state
inactive → active    → 200 OK      ← resurrection
```
And on a student whose status is `graduated`:
```
POST /students/{id}/enroll-class {"classId":"c2"}   → 201 "Successfully enrolled in extra class."
POST /students/{id}/transfer     {"toClassId":"c2"} → 200
POST /students/{id}/issue-card                      → 201 feeCharged 200
POST /students/{id}/payments  (fee, valid semester) → 201 receipt R-00000004
```

**Business impact.** "Graduated" carries no meaning: an alumnus can be enrolled, transferred, charged an ID-card fee and invoiced. Graduation counts, alumni reports and completion metrics are unreliable because the state is freely reversible and no audit distinguishes a correction from an error. Combined with STU-C3, a graduated student also permanently occupies a class seat.

**Note on payment-after-graduation:** I deliberately do **not** classify this as a defect on its own — settling arrears after graduation is legitimate business. The defect is the *absence of any policy*: nothing distinguishes a legitimate arrears payment from enrolling an alumnus in a new class.

**Existing test coverage:** none for transition legality. Mutation test **M1** (below) proves it.

**Correct fix:** an explicit transition map in a single domain module (`core/students/student-lifecycle.ts`), consulted by both status writers, plus status preconditions on `enroll-class`, `enroll-semester`, `transfer` and `issue-card`. Terminal states must require an explicit, audited re-activation action rather than a plain status write.

**Regression test required:** matrix test over all (from, to) pairs asserting allowed/denied; mutation-test the map to prove the tests fail when a transition is silently permitted.

---

## B. HIGH FINDINGS

### STU-H1 · `PATCH /students/:id` performs almost no validation — it accepts data `POST` rejects, and persists it
**Severity:** High · **Ownership:** Backend

**Root cause.** CREATE (`students.routes.ts:451-480`) runs `assertTextLengths(...)`, gender validation, date validation and class validation. **PATCH (`:1041`) runs none of them** — it only checks identity uniqueness and the installment plan, then merges raw body fields straight into the `UPDATE`.

**Reproduction — measured CREATE vs PATCH on identical payloads:**

| Payload | CREATE | PATCH | Persisted by PATCH? |
|---|---|---|---|
| `gender:"martian"` | **400** | **200** | yes — `gender='martian'` |
| `fullName` 5 000 chars | **400** | **200** | yes — `LENGTH(full_name)=5000` |
| `dob:"9999-99-99"` | 201 | 200 | yes |
| `phone:["x"]` (array) | **400** | **200** | yes |
| `classId:"nope"` | **404** | **200** | ignored |
| `discountPercent:500` | 201 (capped 30) | 200 (capped 30) | capped by rules engine |
| `discountPercent:-10` | 400 | 400 | — (symmetric, correct) |

**Business impact — this is not cosmetic.** `gender` is load-bearing:
1. **Gender-segregated classes.** `assertClassGenderAllowsStudent()` (`classes.routes.ts:1307`) enforces `gender_policy`. Verified live: a male student was refused entry to a female-only class (400), then `PATCH {"gender":"female"}` succeeded (200), then the same enrollment succeeded (201). In this market that is a serious real-world failure, not a data-quality nit.
2. **Gender-split reporting silently stops reconciling.** `reports/overview` buckets by `gender='male'` / `gender='female'`. Live: `total=26, male=24, female=1` → **one student counted in the total but in neither bucket.** There is **no CHECK constraint on `students.gender`**, so the DB accepts anything.

**Existing test coverage:** none. No test asserts PATCH rejects an invalid gender, an over-length name, or a malformed date.

**Why tests missed it:** tests exercise PATCH with well-formed payloads only; nothing probes CREATE/PATCH asymmetry.

**Correct fix:** exactly the pattern Visitors already uses — `visitors.routes.ts` defines `normalizeVisitorText()` at `:145` and calls it from **both** POST (`:473`) and PATCH (`:548`). Students needs the equivalent shared normalizer/validator invoked from both writers. Add a `CHECK (gender IN ('male','female'))` in a **forward-only** migration (existing rows must be cleaned first).

**Regression test required:** parameterised CREATE/PATCH symmetry test over the table above, asserting identical status codes; mutation-test by removing the shared validator.

---

### STU-H2 · Students list silently truncates at 2 000 and reports the truncated number as the total
**Severity:** High · **Ownership:** Backend (no total) + Frontend (total derived from page)

Independently re-reproduced in this clean Student environment (previously logged as A-4).

```
DB truth (branch 1)                                    : 2 162 students
GET /api/students?branchId=1&limit=2000                : 2 000 rows
GET /api/students?branchId=1&limit=5000                : 2 000 rows
GET /api/students?branchId=1&limit=999999              : 2 000 rows
X-Total-Count header                                   : absent
Rendered UI table rows                                 : 2 000
Rendered UI counter                                    : "2000 of 2000 students"
```

**Root cause.** `students.routes.ts:137-138` sets `DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE = 2000` and returns a **bare array** with no total; `StudentsView.tsx:294` renders `` `${filteredStudents.length} of ${students.length} students` `` where `students.length` *is* the truncation limit.

**Blast radius:** `GET /api/payments/balances` truncates identically (2 000 of 2 162 rows), and the **CSV export** (`StudentsView.tsx:164-170`) is built from the truncated array — a management export with Total Fee / Paid / Debt columns silently omits 162 students.

**The correct pattern already exists in this same file.** `GET /students/search` returns `{rows, total}`: live it returned `rows=25, total=2162` — exactly matching DB truth, and branch-scoped (a branch-1 registrar searching for a branch-2 student got `rows=0`). The roster load simply never adopted it.

**Existing test coverage:** backend tests assert the clamp *works*; none asserts truncation is *detectable* by a client. No frontend test framework exists.

**Correct fix:** per the standing pass-23 rule — **do not raise the limit.** Return `{rows, total}` from the roster endpoint and render the server's total, mirroring `/students/search` and the Visitors view.

---

### STU-H3 · Student phone uniqueness is defeated by trivial formatting differences
**Severity:** High · **Ownership:** Backend

**Root cause.** `students.routes.ts:473-477` compares `String(phone).trim()` against `stmtFindStudentByPhone` — a **raw string equality** check. The codebase already contains a correct normaliser, `phoneMatchKey()` in `core/visitors/duplicate-lookup.ts:58` (strips non-digits, matches on digit suffix), but **students never import it** (`grep phoneMatchKey` in production returns only the visitors module).

**Reproduction — all four are the same physical line:**
```
phone "0700111001"    (existing)
phone "0700111001 "   → 409 rejected  ✅ (trim catches it)
phone " 0700111001"   → 409 rejected  ✅
phone "0700-111-001"  → 201 CREATED   ❌
phone "+93700111001"  → 201 CREATED   ❌

DB truth: 3 distinct student rows on one phone line
  TH-001001 | Base Student | "0700111001"
  TH-001007 | Norm Test    | "0700-111-001"
  TH-001008 | Norm Test    | "+93700111001"
```

**Business impact.** Phone is the front desk's primary identity key (it is *mandatory* for students — `:476` `'Phone is required.'`). Duplicate student records mean split payment histories, split attendance, duplicate fee obligations and double-counted enrolment metrics. Merging them after the fact is manual and error-prone.

**Note:** the same normalisation gap applies to `uq_students_phone`, which indexes the raw string, so the DB cannot backstop it either.

**Existing test coverage:** none for students. Notably `visitor-ux-remediation.test.ts:573` **does** test exactly these four formats — for visitors. The Student subsystem was never given the equivalent.

**Correct fix:** promote `phoneMatchKey()` to a shared module (e.g. `core/identity/phone.ts`) used by visitors *and* students; store a canonical form; index the canonical column. Forward-only migration; existing duplicates must be reported before any unique constraint is added.

---

### STU-H4 · Graduated / suspended students permanently consume class capacity
**Severity:** High · **Ownership:** Backend

**Root cause.** `core/academic/class-capacity.ts` — the (correctly) single authority — counts `enrollments` rows in status `active|confirmed|pending` and **never joins `students.status`**. Nothing closes a student's enrollments when they graduate: `journey.routes.ts:133` sets `status='graduated'` and touches nothing else.

**Reproduction (live, class `c1` capacity 3):**
```
3 students enrolled                       → class full
4th registration                          → 409 "Selected class is full."  (correct)
POST /students/{A}/journey/events {graduated} → 201, students.status='graduated'
4th registration retried                  → 409 "Selected class is full."  ← STILL BLOCKED

DB: c1 seats consumed = 3/3
    of which graduated students = 1
```

**Business impact.** A seat is permanently lost to a student who has left. A paying applicant is turned away from a class that is physically empty. At scale this suppresses revenue and corrupts class-utilisation planning. Registrars would "fix" it by inflating capacity, which then breaks room-capacity rules.

**Existing test coverage:** none — no test combines a student-status change with a capacity check.

**Correct fix:** graduating (and suspending) a student must transition their enrollments through `EnrollmentService`, which already has `complete()` / `suspend()`. The capacity rule itself is correct and should not be changed to filter by student status — that would paper over the real bug (stale enrollment rows).

---

## C. MEDIUM FINDINGS

### STU-M1 · `students.gender` has no database CHECK constraint
`status` is constrained (`CHECK (status IN ('active','inactive','graduated','suspended'))`) but `gender` is a bare `TEXT NOT NULL`. Live DB now contains `['martian','male','female']`. This is the persistence-layer half of STU-H1; listing separately because it needs a forward-only migration and a data-cleanup pass, on a different timeline from the route fix.

### STU-M2 · Student status vocabulary is duplicated in four places with two different value sets
| Location | Values |
|---|---|
| DB CHECK | `active, inactive, graduated, suspended` |
| `students.routes.ts:1113` | `active, inactive, graduated` (suspended deliberately excluded) |
| `journey.routes.ts:129` | `active, inactive, graduated, suspended` |
| `StudentsView.tsx:32`, `StudentProfileDrawer.tsx:35` | `active, inactive, graduated, suspended` |

No shared constant. This is the drift shape that produced the pass-31 finance Critical. Not itself a live defect beyond STU-C1, but it is the reason STU-C1 was possible.

### STU-M3 · `head_of_department` can enroll and suspend students but cannot edit or create them
Measured permission matrix (live, `403`/`2xx` per role):

| Role | LIST | READ | CREATE | EDIT | STATUS | PAY | ENROLL | SUSPEND |
|---|---|---|---|---|---|---|---|---|
| owner | 200 | 200 | 201 | 200 | 200 | 400\* | 409\* | 200 |
| registrar | 200 | 200 | 201 | 200 | 200 | 400\* | 201 | 200 |
| manager | 200 | 200 | 201 | 200 | 200 | 400\* | 201 | 200 |
| **head_of_department** | 200 | 200 | **403** | **403** | **403** | 403 | **201** | **200** |
| finance | 200 | 200 | 403 | 403 | 403 | 400\* | 403 | 403 |
| counselor | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 |
| teacher | 200 | 200 | 403 | 403 | 403 | 403 | 403 | 403 |

\* `400`/`409` are validation/business outcomes, i.e. authorization passed.

Cause: `enroll-class` uses `requirePermission('Class.Assign','Student.Edit')` (OR semantics) while `transfer`/`suspend`/`resume` use `authorize('registrar','manager','head_of_department','owner')` — two different authorization mechanisms on adjacent endpoints. Flagged for **business confirmation**, not asserted as a defect: HODs holding academic-placement authority without demographic-edit authority may well be intended.

### STU-M4 · All roles including `teacher` and `counselor` can read the full student roster and every individual record
`LIST` and `READ` return 200 for every role tested. Whether a teacher should see students outside their own classes (including phone, Tazkira, father's name, emergency contacts) is a **privacy policy question for the owner**, not a code defect. Recorded because the data is sensitive and the surface is broad.

---

## D. LOW FINDINGS

- **STU-L1** — `POST /students/:id/payments` returns `400 "Invalid category."` before checking anything else, so an omitted `category` yields a message that does not name the missing field. Minor UX/debuggability issue.
- **STU-L2** — `dob:"9999-99-99"` is accepted by **both** CREATE and PATCH (symmetric, so not part of STU-H1). Impossible dates enter the DB; low impact today because `dob` drives no logic, but it will corrupt any future age-based reporting.
- **STU-L3** — Journey event names are unvalidated free-form strings at the API edge; a typo (`"status_changed"` vs `"journey.status_changed"`) returns a generic `400 "Unsupported or missing eventType for manual append."` without listing valid values.

---

## E. FALSE POSITIVES / REJECTED HYPOTHESES

Investigated and **explicitly dismissed**. None of these is a defect.

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| C-1 | Cross-branch student access is possible | **REJECTED** | Branch-1 registrar attacked branch-2 student on 5 endpoints: `GET`, `PATCH`, `PATCH /status`, `POST /payments`, `POST /suspend` → **all 403**. |
| C-2 | `branchId` forgery works | **REJECTED** | Body forgery (`{"branchId":"b2"}` on create) → **403 "Target branch is outside your authorized scope."** Query forgery (`?branchId=b2`) → 200 but correctly returns **only the caller's own branch** (4 branch-1 rows, zero branch-2 rows). |
| C-3 | Search enumerates across branches | **REJECTED** | Branch-1 registrar searching for `"B2 Student"` → `rows=0, total=0`. |
| C-4 | Concurrent enrollment overbooks a class | **REJECTED** | 10 parallel enrollments into capacity-2 class → **2×201, 8×409, seats=2/2**. Mixed-path race (5× `journey/enrollments` + 5× `enroll-class`) → **2×201, 8×409, seats=2/2**. The single capacity authority genuinely holds across all entry points. |
| C-5 | Concurrent duplicate student creation succeeds | **REJECTED** | 8 parallel identical-phone creates → **1×201, 7×409**, DB rows = 1. The check-then-insert is backstopped by `uq_students_phone`. |
| C-6 | Payment idempotency is broken | **REJECTED** | 6 parallel identical fee payments → **1×201, 5×200 (replay)**, exactly **1** payment row totalling 1 000. |
| C-7 | Overpayment / negative payment accepted | **REJECTED** | 999 999 against a 6 000 fee → `400 "Payment exceeds the remaining balance... Outstanding: 5000 AFN."` Negative → `400 "Amount must be greater than 0."` |
| C-8 | Refund integrity is broken | **REJECTED** | Over-refund → `400 "Refund exceeds the refundable balance of 1000 AFN."` Negative → `400 "Refund amount must be positive."` Valid refund → stored **signed-negative** (`-500`, category `refund`). Correct. |
| C-9 | Student balances are computed client-side | **REJECTED** | `/api/payments/balances` returns server-aggregated `{tuitionDue:6000, tuitionPaid:1000, outstanding:5000, creditBalance:0, paidPercentage:17}`, reconciling exactly with DB truth. |
| C-10 | Duplicate active enrollment is possible | **REJECTED** | Second enroll into same class → `409 "Already enrolled in this class."`; DB shows exactly 1 active row. |
| C-11 | Cross-branch enrollment is possible | **REJECTED** | Branch-1 student into branch-2 class → `400 "Class belongs to another branch."` |
| C-12 | **Dashboard vs reports student-count drift** | **REJECTED — different business definitions** | `dashboard.activeStudents=2159` vs `reports.operational.activeStudents=9` looked like drift. Reconciled exactly: `reports/overview` is **period-scoped** (`registration_date` within the report window — 12 registered today, 9 of them active), `dashboard` is a **population snapshot** (2 159 active of 2 162). Both internally correct. Per the mandate, the business definition was established before judging. |
| C-13 | Enrollment without fee obligation / fee without enrollment | **REJECTED** | Across all 10 active enrollments: **0** with no semester row and no invoice; **0** orphan active semester rows without a matching active enrollment. |
| C-14 | Frontend sends `suspended` to an endpoint that rejects it | **REJECTED** | `apiStore.ts:812-818` correctly routes `suspended` → `POST /suspend` and `suspended→active` → `POST /resume`. The frontend already respects the split. |
| C-15 | Shadow SQL writers bypass the domain | **REJECTED for enrollments** | Full repo grep: every production enrollment writer goes through `EnrollmentService`; no import scripts, no `scripts/` dir, no automation/event-handler student writers. The *only* shadow writer found is the status path in STU-C1. |
| C-16 | Mutation M2 destroys the identity invariant | **REJECTED / corrected mid-audit** | Removing the app-level phone guard first *appeared* to let a duplicate through; on re-testing with a genuinely existing phone the DB returned `SQLITE_CONSTRAINT_UNIQUE`. The unique index **does** backstop the guard — M2's real impact is a 500 instead of a clean 409, not data corruption. Severity downgraded accordingly. |

---

## F. TEST-QUALITY WEAKNESSES

**Baseline: 111 files / 1 230 tests, all passing — while every finding above is live.**

### Mutation results

| Mutant | Change | Suite result | Verdict |
|---|---|---|---|
| **M1** | Delete the entire `/status` enum guard (`students.routes.ts:1113`) | **111 files / 1 230 tests PASS** | **SURVIVED** |
| **M2** | Delete the phone-uniqueness guard (`students.routes.ts:477`) | **111 files / 1 230 tests PASS** | **SURVIVED** |

Both mutants were reverted; `git status` is clean (verified).

M1 is the serious one: the *only* validation on the primary student-status endpoint can be deleted with **zero** test failures. M2 is less severe than it first appeared (see C-16) but still means the difference between a clean 409 and a 500 is untested.

### Coverage gaps

1. **Zero tests for the journey status/graduation path** (STU-C1) — the entire alternate writer is untested.
2. **Zero tests for status-transition legality** (STU-C2) — proven by M1.
3. **Zero tests for CREATE/PATCH validation symmetry** (STU-H1).
4. **Zero tests for student phone normalisation** (STU-H3) — while `visitor-ux-remediation.test.ts:573` tests exactly these four formats for visitors. The gap is Student-specific.
5. **Zero tests combining student status with capacity** (STU-H4).
6. **No test detects list truncation from a client's perspective** (STU-H2); backend tests assert the clamp works, which is the wrong assertion.
7. **No frontend test framework exists**, so no Student UI behaviour is covered at all.
8. **Fixture-style tests write students with raw `INSERT`** (e.g. `financial-*.test.ts`, `student-list-filters.test.ts`), bypassing route validation. They are fine as fixtures but must not be mistaken for coverage of the write path.

---

## G. CROSS-SURFACE INCONSISTENCIES

1. **Two student-status writers, one validated, one not** (STU-C1) — the root inconsistency.
2. **Status vocabulary duplicated ×4 with two different value sets** (STU-M2).
3. **CREATE validates, PATCH does not** (STU-H1) — Visitors solved this with a shared normalizer; Students did not.
4. **Phone normalisation exists for Visitors, absent for Students** (STU-H3) — same repo, same concept, one implementation.
5. **Pagination contract differs within one router**: `/students/search` returns `{rows,total}`; `/students` returns a bare truncated array (STU-H2).
6. **Two authorization mechanisms on adjacent endpoints**: `requirePermission(...)` on `enroll-class`, `authorize(role,...)` on `transfer`/`suspend`/`resume` (STU-M3).
7. **Phone is mandatory for Students (`:476`) but optional for Visitors** — the open UX-14 decision. Conversion copies `visitor.phone` straight into `students.phone` (`visitors.routes.ts:766`) **without re-validation**, so the visitor path can still create a phone-less student even though the direct Student path forbids it. *This is the concrete Student-side dependency of UX-14 and strengthens the case for Option C (mandatory at conversion).*

---

## H. RECOMMENDED REMEDIATION ORDER

1. **STU-C1** — collapse to one status authority (`journey.routes.ts` must delegate). Unblocks C2/M2/H4.
2. **STU-C2** — add the transition state machine + status preconditions on enroll/transfer/issue-card.
3. **STU-H4** — close enrollments on graduate/suspend via `EnrollmentService` (depends on 1 & 2).
4. **STU-H1 + STU-M1** — shared Student text/enum validator used by CREATE *and* PATCH; forward-only `gender` CHECK after cleaning existing rows.
5. **STU-H3** — shared `phoneMatchKey` identity module; canonical storage; duplicate report before any constraint.
6. **STU-H2** — `{rows,total}` on the roster endpoint; UI and CSV consume the server total.
7. **STU-M2** — single shared status-vocabulary constant.
8. **STU-M3 / STU-M4** — owner decisions on HOD authority and teacher roster visibility.
9. **STU-L1–L3** — error-message quality and date validation.

Every fix must land with a mutation-proven regression test. **M1 must be killed** by the work in items 1–2.

---

## I. STUDENT SUBSYSTEM GO / NO-GO

### 🔴 NO-GO

**Two Critical and four High findings are open, all reproduced live against the API and reconciled against DB truth.**

The subsystem is **strong exactly where previous audits forced it to be strong**, and that deserves saying plainly: branch isolation, object-level authorization, `branchId` forgery resistance, search scoping, payment idempotency, overpayment/refund bounds, server-side balance computation, enrollment↔fee-obligation integrity, and **capacity under concurrent load across mixed entry points** all held under direct adversarial attack. Fifteen hypotheses were tested and rejected with evidence. The enrollment subsystem in particular has a genuine single authority that survived a mixed-path race.

**But the Student *lifecycle* has effectively no integrity.** Status is writable by two authorities, only one of which validates; there is no transition machine, so terminal states are reversible and meaningless; graduated students remain fully mutable and permanently consume paid class capacity; and `PATCH` accepts identity data that `POST` rejects — including a `gender` value that breaks gender-segregated class enforcement and silently unbalances gender-split reports.

**The most important finding is not any single defect — it is that all of them are invisible to the test suite.** 1 230 tests pass while every issue above is live, and deleting the *entire* validation guard on the primary status endpoint (M1) breaks **nothing**. The green suite is not evidence that the Student subsystem is trustworthy.

**Answering the objective directly: the Student subsystem is not currently trustworthy under adversarial conditions.** Its perimeter (authz, branch, money) is trustworthy; its internal state machine is not.

Per standing instruction, the terms *"defect-free"* and *"production-ready"* are not used.

---

### Appendix — reproduction environment

| Item | Value |
|---|---|
| DB | `/tmp/stu/erp.sqlite` (purpose-built; 2 163 students, 2 branches, 5 classes incl. capacity-2 and female-only) |
| API | `localhost:4000`, `DB_PATH=/tmp/stu/erp.sqlite` |
| Users | `owner`, `u_registrar`, `u_manager`, `u_head_of_department`, `u_finance`, `u_counselor`, `u_teacher`, `u_reg_b2` (branch 2) |
| Frontend evidence | real React app booted in jsdom against the live API (`/tmp/stu/render.mjs`), rendered DOM at `/tmp/stu/students.html` |
| Query helper | `/tmp/stu/q.cjs` |

**No production code, migration, or test was modified. Both mutants were reverted and `git status` is clean.**
