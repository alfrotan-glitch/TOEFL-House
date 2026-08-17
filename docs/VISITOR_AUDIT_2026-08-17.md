# Visitor Subsystem — Independent Production Audit

**Date:** 2026-08-17 · **Commit audited:** `28e32fa` · **Method:** source trace +
live adversarial execution against a seeded two-branch server + mutation testing
of both the existing and the new test suites.

**Scope:** creation → editing → duplicate detection → branch isolation → program
selection → placement eligibility → attempts/retakes → scoring/outcome →
fees/payments → conversion → student/enrollment creation → cancellation/closure →
reporting/search/listing.

**Production code changed by this audit: none.** The only file added is
`server/src/tests/visitor-subsystem-audit.test.ts`.

---

## 1. Verdict

# NO-GO

One **CRITICAL** defect allows a documented, reproducible bypass of the placement
assessment gate — including for a candidate who **explicitly failed** the
assessment — using only the `Lead.Edit` permission. Four **HIGH** findings cover
absent duplicate detection, an unenforceable serial number, an unvalidated update
path, and a lead-data leak to roles that are denied lead access.

The subsystem must not be considered production-grade while V-1 is open.

This verdict is about the Visitor lifecycle specifically. The **financial core it
feeds is sound**: money reconciled exactly in every probe, conversion is
correctly serialised, and no monetary corruption was found.

---

## 2. Findings

| ID | Sev | Area | Finding |
|---|---|---|---|
| **V-1** | **CRITICAL** | Placement | Placement gate bypassed by clearing `programVersionId` via PATCH |
| **V-2** | **HIGH** | Data quality | No duplicate detection at all — same person, same national ID, unlimited |
| **V-3** | **HIGH** | Integrity | `visitors.serial_no` has no UNIQUE constraint; duplicates provable |
| **V-4** | **HIGH** | Validation | PATCH bypasses the input validation CREATE enforces |
| **V-5** | **HIGH** | Authorization | Global search leaks leads to roles denied `Lead.View` |
| **V-6** | MEDIUM | State machine | A `lost` lead silently resurrects to `enrollment` on conversion |
| **V-7** | MEDIUM | Concurrency | N concurrent `advance-stage` calls walk the funnel N stages |
| **V-8** | MEDIUM | Audit | Visitor edits record no before/after values |
| **V-9** | MEDIUM | Date policy | Visitor UI computes "today" in UTC; OVERDUE is wrong 4.5 h/day |
| **V-10** | LOW | Dead code | Conversion guards on `classes.program_version_id`, a column that does not exist |
| **V-11** | LOW | Error handling | Raw SQLite constraint text returned to clients as HTTP 500 |
| **V-12** | LOW | PII | Visitor list returns 9 PII fields to every `Lead.View` holder |

---

### V-1 — CRITICAL — Placement gate bypass via `programVersionId = null`

**Exploit path** (each step executed against a live server):

```
1. Program pv_a is configured: requirement_mode = 'required', pass score 50.
2. Visitor created; the server auto-attaches pv_a.
3. POST /api/visitors/:id/convert   (classId = cls_a)
   -> 400 "Placement assessment is required for the selected program"   [gate works]
4. PATCH /api/visitors/:id  {"programVersionId": null}
   -> 200                                                                [Lead.Edit only]
5. POST /api/visitors/:id/convert   (classId = cls_a, the SAME class)
   -> 201 { studentCode: "TH-001003" }                                   [BYPASSED]
```

Escalated variant — a candidate who **failed**:

```
attempt #1 completed, outcome = 'failed', percentage 10
POST /convert                       -> 400 "did not meet the placement policy requirements"
PATCH {"programVersionId": null}    -> 200
POST /convert                       -> 201 TH-001005
```

**DB truth after the exploit:**

```
attempts   : [{attempt_number:1, status:'completed', outcome:'failed', percentage:10}]
student    : {student_code:'TH-001005', status:'active'}
enrollment : [{class_id:'cls_a', program_version_id:'pv_a', status:'active'}]
```

The enrollment row is stamped with **`pv_a` — the very program the candidate
failed** — because the enrollment service re-derives the program from the class's
level even though the visitor no longer carries one.

**Root cause — two gates that resolve the program differently, and the stricter
one is switched off:**

- `visitors.routes.ts:385` wraps the entire placement check in
  `if (effectiveProgramVersionId) { … }`, where
  `effectiveProgramVersionId = visitor.program_version_id || body.programVersionId`.
  Detach the program and the gate is not evaluated — it is *skipped*, not failed.
- `enrollment-service.ts:205` resolves the program from `class → level →
  program_version_id`, which would have found `pv_a` and blocked the enrollment.
- But conversion calls `enroll({ … skipPlacementGate: true })`, disabling it.

The comment at `enrollment-service.ts:41` states the flag is safe because
conversion "evaluates the identical placement rule … immediately before". That
premise is false: the two do **not** evaluate identical rules, because they
derive the program from different sources.

**Business impact.** The placement assessment is the academic admission control.
Any `Lead.Edit` holder — including a **counselor, who is deliberately denied
`Lead.Convert`** — can neutralise it with one request, defeating the separation
of duties. Students land in classes they are not qualified for; the enrollment
record asserts a program requirement that was never satisfied. Combined with V-8
(no before/after audit values) the tampering step leaves no forensic trace.

**Note:** creation is *not* a bypass — a visitor created with
`programVersionId: null` is auto-assigned the branch's default published
program, and the gate then fires correctly. The bypass requires the PATCH.

---

### V-2 — HIGH — No duplicate detection

Five POSTs with identical `fullName`, `phone` **and `tazkiraNo`** (national ID)
produced five separate leads:

```
V-1001 V-1002 V-1003 V-1004 V-1005   ->  Dup Person / 0700000001 / TZK-DUP-1  x5
```

**Root cause.** There is no duplicate check in the create handler and no
uniqueness anywhere in the schema — `visitors` has indexes on branch, status,
stage, campaign and source, but **no unique index on any identity column**.

**Impact.** Conversion-rate and pipeline metrics are inflated by construction;
multiple counselors work the same lead; a person can be converted twice as two
different "visitors" (each passing the per-visitor `lead_id` guard), producing
two student records and two fee bills for one human.

---

### V-3 — HIGH — `serial_no` uniqueness is unenforceable

`serial_no` is the human-facing lead identifier, allocated as `MAX(serial)+1`
inside a transaction. Within one process this holds — 25 concurrent creates
produced 25 distinct serials. Across **two connections** (any multi-worker
deployment) it does not:

```
connection A computed: V-1031
connection B computed: V-1031
IDENTICAL SERIAL: true
BOTH INSERTS ACCEPTED -> duplicate serial persisted
```

**Root cause.** Read-then-write allocation with no `UNIQUE` constraint to catch
the lost update. The database will accept whatever the race produces.

**Impact.** Two leads share a printed reference number. This is silent and
permanent; nothing in the application ever notices.

---

### V-4 — HIGH — PATCH does not apply CREATE's validation

| Payload | POST /api/visitors | PATCH /api/visitors/:id |
|---|---|---|
| `fullName` 100,000 chars | **400 rejected** | **200 stored in full** |
| all 12 text fields × 20,000 | 400 | **200, every field stored** |
| `phone: ["injected"]` | — | **200**, stored as `"array"` |
| `nextContactDate: "9999-99-99"` | — | **200**, stored verbatim |
| `dob: "not-a-date"` | — | **200**, stored verbatim |
| `fullName: null` | — | **500** raw SQLite error |

**Root cause.** `assertTextLengths([...])` appears once, at line 212 in the
create handler. The PATCH handler validates enums (`gender`, `source`,
`followUpStatus` all correctly 400) but never length, type or date format.

**Impact.** Unbounded storage growth and UI breakage from a single authenticated
request; dates that no comparison can evaluate correctly.

---

### V-5 — HIGH — Global search leaks leads past `Lead.View`

```
teacher_A  GET /api/visitors        -> 403          (correctly denied)
teacher_A  GET /api/search?q=Dup    -> 5 visitor records: name, serial, stage
teacher_A  GET /api/search?q=0700000001 -> 5 records   (phone is a search key)
finance_A  GET /api/search?q=Dup    -> 5 visitor records
```

**Root cause.** `search.routes.ts:16` guards with
`requirePermission('Student.View','Lead.View','Teacher.View','Class.View', …)`,
which is **OR** semantics: any one permission grants the whole multi-entity
result set, and the visitor branch of the query is not re-checked against
`Lead.View`.

**Impact.** Roles explicitly denied lead access read lead identities, and can
confirm whether a given phone number is in the CRM — an enumeration oracle. The
branch scope *is* applied, so this is a permission-model flaw, not a tenancy one.

---

### V-6 — MEDIUM — Closure is not respected by conversion

`lost → inquiry` is correctly refused by the state machine. But converting a
`lost` lead succeeds and rewrites its stage:

```
stage before convert: lost
convert -> TH-001006
stage after convert : enrollment   status: registered
```

**Root cause.** `stmtUpdateVisitorConverted` sets `status='registered',
stage='enrollment'` unconditionally; conversion never consults the stage. Either
"lost" is a terminal state or it is not — currently it is terminal for the
workflow endpoint and meaningless for the conversion endpoint.

---

### V-7 — MEDIUM — Concurrent `advance-stage` walks the funnel

Ten parallel no-body calls advanced one lead **ten stages**, `lead` →
`enrollment`, straight through `placement_booking`, `placement_fee` and
`placement_completed`:

```
successful advances: 10      final stage: enrollment
```

Each request is individually correct (CAS on the current stage), so the guard is
not broken — but N requests perform N business transitions from one user action.

**Assessed impact is reporting, not security.** `placement_status` remained
`not_started` and no attempt was fabricated, so the placement gate is unaffected;
`stage` drives the pipeline funnel and conversion-rate reporting.

---

### V-8 — MEDIUM — Audit records no before/after values

Audit **coverage** is complete — create, update, stage change and conversion all
write entries. But every update row is `old_value = NULL, new_value = NULL`:

```
[Counselor A] Updated visitor details: Exploit Chain   old=null new=null
```

That line is the V-1 tampering step. The audit log cannot show that a placement
requirement was removed, by whom, or from what value.

---

### V-9 — MEDIUM — Visitor UI derives "today" in UTC

`VisitorsView.tsx:65` — `new Date().toISOString().split('T')[0]` — drives the
`isOverdueContact` predicate and the OVERDUE badge, while the server writes dates
with local `today()`. In Asia/Kabul (UTC+4:30) the UI computes **yesterday**
between 00:00 and 04:29 local, so follow-ups due today are shown OVERDUE for the
first 4.5 hours of the working day. Same defect class as dashboard finding D-4,
which was fixed; this instance was not in that scope.

---

### V-10 — LOW — Dead guard on a non-existent column

`visitors.routes.ts:400` reads `classItem.program_version_id`. The `classes`
table has no such column (verified via `PRAGMA table_info`), so the value is
always `undefined` and the check *"Selected class belongs to a different program
version"* can never fire.

**Not exploitable today**: the enrollment service performs the equivalent check
and correctly rejected a cross-program conversion with *"Class and enrollment
program version must match."* This is a silent loss of defence-in-depth.

---

### V-11 — LOW — Internal errors leak to clients

`{"fullName": null}` → HTTP 500 `"NOT NULL constraint failed: visitors.full_name"`;
`{"fullName": {...}}` → 500 `"Too few parameter values were provided"`. Database
schema details should not reach an API client, and neither case is a server fault.

### V-12 — LOW — PII breadth in the list payload

`GET /api/visitors` returns 30 fields including `phone`, `email`, `fatherName`,
`addressRegion`, `tazkiraNo`, `whatsapp`, `dob`, `emergencyContactName`,
`emergencyContactPhone`. Role- and branch-gated, so not a leak — but every
`Lead.View` holder receives full national-ID and next-of-kin data for every lead
in the branch, where the list UI needs a fraction of it.

---

## 3. False positives — explicitly dismissed

| Suspicion | Why it is NOT a defect |
|---|---|
| Direct student creation bypasses placement | `evaluateEnrollmentEligibility` refuses a student with no `lead_id` when placement is required. Already closed. |
| `discountPercent: 150` grants a 150% discount | Rule engine capped it to 30%: invoice `6000 − 1800 = 4200`, `discount_percent` stored as 30. |
| Class capacity is TOCTOU-racy | 8 concurrent conversions into a 3-seat class → exactly 3 succeeded, final count 3. |
| Concurrent conversion duplicates students/payments | 10 parallel conversions → 1 student, 1 payment, 9 × 409. |
| Client-forged `id`/`serialNo`/`status`/`placementStatus`/`visitDate` on create | All ignored; server assigned its own values. |
| `amountPaid: 0.0001` creates sub-unit money | Nothing fractional persisted in `payments` or the ledger. |
| Conversion `dueDate` uses `toISOString()` (UTC) | `new Date('YYYY-MM-DD')` is UTC midnight and `toISOString()` reads it back — identical in every zone tested. |
| `skipPlacementGate` is client-controllable | Not bindable from any request body; server-side call signature only. |
| Placement attempt endpoints lack branch isolation | Cross-branch GET and POST both 403. |
| Cross-program conversion is possible (V-10) | Blocked one layer deeper by the enrollment service. |
| Frontend computes fees | Display only; the server recomputes and enforces the ceiling. |
| Pagination abuse (`limit=-1`, `99999`, `abc`, `1e9`) | All clamped to 50/100 via the shared hardened parser. |

---

## 4. Test-quality gaps

The existing suite has **110 visitor tests that all pass**. Mutation testing shows
what that number is worth:

| Mutant applied to `visitors.routes.ts` | Existing suite |
|---|---|
| Branch isolation removed from `requireVisitor` | KILLED |
| **Placement gate deleted on convert** | **SURVIVED** |
| Already-converted guard removed | KILLED |
| `lead_id` duplicate-student guard removed | SURVIVED *(equivalent — see below)* |
| Overpayment guard removed | KILLED |
| **Stage CAS check removed** | **SURVIVED** |

Three specific weaknesses:

1. **The placement gate is untested.** It can be deleted entirely and all 110
   tests pass. This is the exact control that V-1 defeats.
2. **`'should never produce duplicate serial numbers'`** (line 428) issues 50
   requests with `await` in a **sequential loop**. A sequential loop cannot
   observe a race. The test named after the invariant I broke cannot detect it.
   The `Promise.all` variant (line 1783) is better but still single-process, so
   it also misses the cross-connection race.
3. **`'should handle concurrent stage updates without data corruption'`**
   (line 1808) asserts that **both** concurrent advances succeed and the lead
   ends two stages further on. It encodes V-7 as intended behaviour, which is why
   the CAS mutant survives: the test would fail if the guard *worked* strictly.

**Equivalent mutants** (verified, not excused): removing the
`status === 'registered'` check changes no observable behaviour, because the
`lead_id` lookup and the partial unique index `uq_students_lead_id` both still
return 409. Proved by deleting the guard on a live server: second conversion
returned *"A student record already exists for this visitor."*, one student.

### New suite

`server/src/tests/visitor-subsystem-audit.test.ts` — **27 tests: 10 controls
passing, 17 marked `.fails()`**, each encoding a reproduced defect. They fail
today by design and will flip to "expected to fail but passed" the moment a fix
lands, which is the signal to convert them to plain assertions.

Mutation testing of the **new** suite: 6 of 7 control mutants KILLED (branch
isolation, overpayment, PATCH stage guard, transition validation, forged
`visitDate`, create text bounds); the 7th is the equivalent mutant above.

---

## 5. Recommended architecture

1. **One placement chokepoint, resolved from the class.** Delete
   `skipPlacementGate` and the route-level copy of the rule. `EnrollmentService`
   already derives the program via `class → level → program_version_id`, which is
   the authoritative path and the one the conversion route lacks. Pass the target
   level through so first-level exemption still applies. A control that can be
   skipped by editing an unrelated field is not a control.
2. **Make the program immutable once placement has begun.** Reject
   `programVersionId` changes when a completed attempt exists, rather than
   silently invalidating history.
3. **Identity constraints in the database.** `UNIQUE(serial_no)`; allocate via a
   sequence table or `INSERT … RETURNING` retry, not `MAX+1`. Partial unique
   index on `(branch_id, tazkira_no) WHERE tazkira_no IS NOT NULL`. Application
   checks are advisory; only the database is authoritative under concurrency.
4. **Duplicate detection as a first-class step.** Fuzzy match on
   phone/tazkira/name at create time, returning `409` with the candidate matches
   and an explicit `allowDuplicate` override that is audited.
5. **One validation schema per entity, shared by create and update.** The
   CREATE/PATCH asymmetry exists because validation is written inline per handler.
6. **Per-entity authorization in aggregate endpoints.** `/api/search` must filter
   each result category by that category's own permission, not by an OR across all.
7. **Audit with values.** `writeAudit` already accepts `oldValue`/`newValue`;
   populate them with the changed field set on every mutation.
8. **Server-owned dates.** The visitor UI should consume the server's `today`,
   exactly as the Dashboard now does.
9. **Explicit lifecycle states.** Make `lost` terminal and require an audited
   reopen; conversion should refuse a closed lead rather than silently reviving it.

---

## 6. Evidence index

- Environment: two branches, six role users, two programs/levels/classes, live
  server on `:4000`/`:4100`, database `/tmp/vis/erp.sqlite`.
- Financial integrity after all probes: `audit-financial-data.mjs` → **clean**
  (35 money columns, 129 column-rows); completed payments **12,300** = ledger
  income **12,300**, 0 orphan payments.
- Full backend suite at audit end: **107 files, 1,115 passed + 17 expected-fail**;
  eslint 0 errors; both typechecks clean.
- Production code diff from this audit: **none**.

---

## 7. GO/NO-GO

**NO-GO** for the Visitor subsystem.

V-1 alone is disqualifying: the academic admission control can be removed by any
`Lead.Edit` holder with a single request, it works for a candidate who failed the
assessment, and it leaves no forensic trace. V-2/V-3 mean lead identity cannot be
trusted; V-5 means lead confidentiality does not match the permission model.

The surrounding financial machinery is sound and should not be re-litigated —
money reconciles, conversion is idempotent and correctly serialised, branch
isolation holds on every direct visitor route, and forged client fields are
ignored. The defects are concentrated in **lifecycle enforcement, identity and
input validation**, which is where the remediation should be aimed.

GL-1 (browser visual inspection) and GL-2 (printed fee bill) remain human-only
and were not performed.
