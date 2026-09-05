# Academic System — Independent Red-Team Architecture Review

**Date:** 2026-09-05 · **Reviewer:** Arena.ai Agent Mode (independent pass; no implementation performed)
**Scope:** the entire Academic surface — domain model, migrations, commands, queries, authorization, audit/history, console UI, print surface, integrations, tests, real-world operability.
**Method:** evidence-first. Every finding below cites repository paths. Counter-checks were run against the code (not the docs), and several first-impression suspicions were **retracted** after the code proved them wrong — those retractions are recorded so nobody re-litigates them.

---

## 1. Verdict: CONDITIONAL GO — do not put this live until 3 items are closed

The architecture is **genuinely production-grade at its core**: lifecycle machines with DB check constraints, row-locked capacity counting, conflicting-payload idempotency, append-only audit with denial logging, and terminal-with-history semantics are all real, tested (761 tests / 6117 assertions), and survived adversarial probing. This is not a rewrite situation.

But there are **two ship-blocking authorization holes and one process-integrity decision** that must be closed first, because they expose cross-branch student PII and allow a legally sensitive workflow (appeals) to terminate with zero effect while reporting success:

| # | Ship-blocker | Sign-off requirement |
|---|--------------|----------------------|
| 1 | `PrintingController` renders **every printable artifact with zero capability checks** (§2.1) | Capability gate on each print action + negative tests (wrong-branch actor, capability-less actor) |
| 2 | Core Academic commands pass **`scope: null`**, and `null` scope **means "allow on any grant"** — so any holder of a capability can act on **any branch's** records (§2.2) | Non-null branch scope propagation (Placement-style) for all Academic verbs + cross-branch negative tests |
| 3 | Appeal `resolve()` sets `resolved` and stops: **no effect on, or linkage to, the contested subject** (§2.3) | Recorded product decision in an ADR — either wire defined effects per subject type or rename to `closeWithoutAction` with UI copy that says so |

Full suite + PHPStan + Pint must be re-run after the fixes. Everything else in this report is fix-in-sprint (§3) or accept-with-record (§4).

---

## 2. Must-fix (ranked by real-world importance)

### 2.1 PRINTING HAS NO AUTHORIZATION — any employee can print anything (HIGH — privacy)

`app/Http/Controllers/PrintingController.php:27-111` — all six actions (`receipt`, `invoice`, `certificate`, `transcript`, `payslip`, `enrollmentRecord`, `idCard`) resolve the record by id and render. There is **no `requireCapability`, no policy, no scope check** anywhere in the controller. `routes/web.php:78-83` exposes them to any authenticated employee session:

```php
Route::get('/print/enrollments/{enrollment}/record', [PrintingController::class, 'enrollmentRecord'])
```

`EnsureEmployeeSession` (`app/Http/Middleware/EnsureEmployeeSession.php:34-55`) guarantees *authentication* (employee session bound to a person + branch) — not authorization. So: a front-desk employee at Branch A can print report cards, transcripts, payroll slips, and student ID cards for **any student, any branch**, by id. Student records include minors' PII; payroll slips are employee-sensitive. Read-only does not make this low-severity — bulk exfiltration needs nothing but enumeration. Note the irony: the console views (§5.4) were carefully stripped of sensitive data while the print surface hands it out.

Fix: gate each action on the owning capability (`academic.results.read` / `academic.enrollments.read` / HR pay capability for slips) **and** branch scope of the underlying record.

### 2.2 BRANCH ISOLATION IS DECORATIVE outside Placement (HIGH — multi-branch integrity)

- `app/Modules/Access/AccessResolution.php:37-40`: `decide($actor, $capability, $scope = null)` — when `$scope` is `null`, **any grant of the capability authorizes, regardless of branch**.
- Core Academic commands call it with `scope: null` (`MaintainAcademicStructure::requireCapability`, `MaintainClass`, `ManageAcademicAppeal`, `ManageAcademicOffering`, …).
- Placement — and only Placement — does it correctly: `app/Modules/Academic/Placement/Domain/PlacementAccess.php:19-43` resolves the actor's branch and enforces it.

Consequences: the schema carries `branch_id` on classes, offerings, availabilities, and employee sessions, and the UI filters by branch — but the domain layer will happily let Branch A's registrar define levels, move classes, resolve appeals, and complete seats for Branch B. The branch column is a **UI filter, not a security boundary**. For a multi-branch school this is the single most structurally dangerous finding: every negative test in the suite tests capability presence, not branch confinement.

Fix: propagate record branch as `$scope` in every Academic `requireCapability` (or adopt `PlacementAccess`-style resolution centrally). Add cross-branch negative tests per verb.

### 2.3 APPEAL `resolve()` IS TERMINAL THEATER (MEDIUM-HIGH — process/legal integrity)

`app/Modules/Academic/Commands/ManageAcademicAppeal.php:130-154`: `resolve()` locks the appeal, requires `assigned`, flips it to `resolved` with outcome/narrative, audits — and touches **nothing else**. It never verifies the contested subject exists (see §3.1), never marks the result `appealed`, never amends a score, never re-opens a progression decision, never notifies. Meanwhile:

- `DecideProgression::assertCompletionEvidence` demands a `released` result; an upheld appeal has **no defined path** to produce one (the `appealed` result state from §3.2 is unreachable).
- Console copy (`resources/views/academic/index.blade.php:567`) presents "resolve the appeal" as the redress step. A parent told "the appeal was resolved in your favor" will discover the report card unchanged.

An appeal system whose terminal state has no defined downstream effect is worse than no appeal system: it manufactures a false record of redress. This needs a **product decision, not just code**: enumerate per-subject-type effects of each outcome (upheld → amend result / re-run progression; rejected → close), or explicitly scope appeals to advisory-only and say so in the UI. Either is defensible; the current middle is not.

### 2.4 APPEALS CAN BE FILED AGAINST NOTHING, FOR ANYBODY (MEDIUM — data integrity)

`ManageAcademicAppeal::file()` (`:57-90`): only `placement_profile` subjects are existence-checked (`academic.appeal_placement_unknown`). For `assessment_result` / `progression_decision` subjects, the code checks that *a student id was supplied* and that the student exists — **never that the subject row exists, is in an appealable state, or belongs to that student**. You can file an appeal "against result X on behalf of student Y" where X doesn't exist and Y never sat the assessment. The row persists, gets assigned, investigated, and "resolved" — a complete due-process paper trail over a void subject.

Fix: resolve the subject row inside `file()`, assert appealable state (released result / approved decision), and assert subject.student == appeal.student.

### 2.5 CLASS AND PERIOD TERMINAL TRANSITIONS HAVE NO SEAT GUARDS (MEDIUM — operational footgun)

The codebase already knows the correct pattern — `ManageAcademicOffering::transitionOffering` (`:136-144`) refuses `cancelled`/`completed` while `requested/active/frozen` seats reference the offering (`academic.offering_open_seats`). But:

- `MaintainClass::transitionClass` (`:102-130`) checks lifecycle legality + teacher presence only. A class with 30 active seats can be `cancelled`/`completed` in one click; seats dangle (`active` seats in a `cancelled` class refuse attendance via `academic.attendance_class_not_active` yet remain completable — `complete()` never checks class state).
- `MaintainAcademicStructure::transitionPeriod` (`:509` region) checks only lifecycle legality. A period can be closed with live classes, open seats, and in-flight assessments; the period is documented as "authority-owner of academic timing" but closure is consequence-free.

Fix: apply the offering guard pattern at both levels (class: active/frozen seats block cancel/complete; period: non-terminal classes or open seats block close), or require an explicit force-with-reason that gets audited.

---

## 3. Should-fix (fix in sprint; not ship-blocking)

1. **Dead `appealed` result state (LOW-MED).** `assessment_results` check constraint (`2026_08_31_000109…:16`) and `ResultLifecycle::released → [corrected, appealed]` advertise a transition **no code path performs** — `ManageAssessmentResult` has no mark-appealed verb, and appeal `file()` doesn't set it. Either wire it (file → mark appealed, mirroring the deliberate manual marking on progression decisions) or remove it from the machine. Dead states are traps for the next developer.
2. **Classes have no human-readable code (MED).** `2026_08_26_000034_create_classes_table.php:13-20` — identity is UUID-only; the console's own empty-state admits "Classes are opening soon." Registrars cannot operate, search, or reconcile UUID-only classes (timetables, room sheets, payroll all need codes like `BEG-AM-2511-A`). Add `class_code` (unique per period) before real operation.
3. **Sections exist but enrollments can't carry one (MED-LOW).** `class_sections` has capacity, yet `Enrollment::$fillable` has no section field and no consumer reads section capacity — section capacity is unenforceable decoration. Either attach enrollments to sections (and enforce) or drop the column before it misleads capacity planning.
4. **`assign()` accepts nonexistent reviewers (LOW).** `ManageAcademicAppeal::assign` checks independence from the original decision-maker (good) but never that the reviewer person exists or holds review capability. A typo parks the appeal in `assigned` forever — fail-stuck. Validate at assign time.
5. **Score upper bounds are half-enforced (LOW).** Negatives rejected (`assess()`/`correct()` floor at 0), but no per-component maximum: `coverage_pct` gets an implicit cap only via recombination (`min(100, …)`), and essays have none. Decide: max-score-per-item with validation, or record that 0–100 convention is enforced upstream.
6. **`updateSchedule`/`addRoom` bypass capacity sanity (LOW).** Both mutate class operating facts without re-validating `max_seats` vs room capacity. Minor while rooms carry no capacity field — becomes real the day they do.
7. **Enrollment snapshots can go stale (LOW — record the decision).** `request()` snapshots `seat_level_id`/program version at request time; nothing refreshes them at approve/activate. If staleness is intended (price-lock semantics), say so in an ADR; if not, re-snapshot at activation.
8. **Waitlist races fail ugly but safe (LOW — accept).** Position allocation is read-then-insert under no serial guard; the partial unique index (`2026_09_04_000131…:216`) converts a collision into a 500 rather than a clean rejection. Integrity holds (fail-closed); consider a retry-on-conflict for polish.
9. **Numeric corrections bypass reviewer independence (LOW — record the decision).** `correct()` on numeric results needs only the capability — no independent reviewer — while coverage recombination *does* (`academic.result_not_independent`). If numeric trust is intentional (teacher owns scores), document it; the asymmetry currently looks accidental.

---

## 4. Accept / redesign-later / out-of-scope

- **Regrade reuses `record()`; metric grammar is intentionally narrow** (`RecordAttendance`, `ScorePlacement::scoreSection` word/level/enum/count bounds verified sound). The 1.77-word/utterance figure is a metric-definition artifact (total words ÷ all 5,639 turns incl. assessor prompts), not a data-integrity signal — recomputation over rateable utterances gives ~2.9–4.1, matching the reported bands. No action.
- **Repeated `completed → completed` is denied by design** (terminal states, denial logged to audit). Accept; the denial *is* the audit trail.
- **Per-request random idempotency keys + `Idempotency-Key` header support + per-render form tokens** (`Controller::idempotencyKey`, `IdempotentExecution` records outcome only after success, conflicting payloads rejected): sound. The "spent key" and "double-submit" suspicions were checked and retracted.
- **Finance integration (partial verification):** Finance owns its own `EnrollmentInstallmentPlan` keyed by schedule ref; no direct read of academic enrollment state was found from the Academic side in this pass. Treat "Finance packages completed seats" as **unverified end-to-end** until a joint Finance/Academic test proves the join. (Also: `branch_id` on finance obligations should fall under the §2.2 scope fix.)
- **Deferred by ratified scope, unchanged:** D-F-059/070, push fan-out, 90-day attendance window, Friday-prayer blackout, Kankor-band model. None challenged by this review.

---

## 5. What survived attack (soundness register — do not regress)

- **Capacity control is race-safe:** `MaintainEnrollment::assertCapacity` / `assertOfferingCapacity` (`:632-650`) count under `lockForUpdate`; class + offering caps enforced at request, approve, activate, and unfreeze.
- **Graduation is terminal-with-history:** `DecideGraduation::assertNoOpenSeats` blocks graduation with open seats; transferred seats are terminal; program-version snapshots freeze history.
- **Idempotency conflicts are rejected, not merged:** `IdempotentExecution::execute` (`app/Support/Idempotency/IdempotentExecution.php:23-46`).
- **Independence rules exist where they matter most:** appeal assign excludes the original decision-maker; coverage recombination requires an independent reviewer; progression `markAppealed` is a conscious act.
- **Offerings are lifecycle-guarded** (open-seat guard, reopen context checks).
- **Regression net is real:** 761 tests / 6117 assertions, PHPStan clean, Pint clean at last full run.

---

## Appendix — retracted suspicions (checked, found sound)

Unfreeze *does* re-check class-active + capacity + gate (`MaintainEnrollment` unfreeze path, `:61-68`). `define()`/structure verbs *do* require the registrar capability. `date_of_birth` validation is correct (past-or-today rejected properly — the "allows today" reading was a misparse). `ScorePlacement` bounds are enforced. The `academic.index` 300-row cap is a documented governor, not a silent filter. These are listed so future reviewers don't burn time re-proving them.
