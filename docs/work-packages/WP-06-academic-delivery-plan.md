# WP-06 Academic Delivery — implementation and verification record

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Pre-package baseline:** `e1d91326a5716b225bda03abf88a665c0f57aaf5` (WP-05 certified; full release gate 22/22 green, verified by `npm run release:validate` on a clean install)
**Lifecycle state:** DECIDE — plan approved by this record; implementation follows

> This record covers only WP-06 Academic Delivery and the direct consumer
> adjustments required to keep its authorities coherent. It does not certify
> Library, Payroll, Reporting redesign, Workflow, Audit or production operations.

## SCOPE

Included route ownership:

- `server/src/routes/sessions.routes.ts` — complete
- `server/src/routes/exams.routes.ts` — complete
- `server/src/routes/classes.routes.ts` — Academic Delivery portions only:
  assessment CRUD/makeup, gradebook, grade-lock workflow, day-level
  `/api/attendance` router (the portions WP-05 explicitly excluded)

Included supporting authority:

- `core/academic/attendance-policy-service.ts` — attendance policy/weights/streak
- `core/academic/gradebook-service.ts` — grade computation authority
- `core/academic/grade-lock-service.ts` — grade-lock lifecycle
- `core/academic/lifecycle-engine.ts` — attendance-status/session-type/grade-lock
  vocabularies and transitions (session/attendance/grade-lock portions)
- `core/academic/academic-policy-service.ts` — make-up policy (as consumed)
- canonical schema for `sessions`, `rosters`, `attendance`, `homework`,
  `quizzes`, `class_assessments`, `student_grades`, `grade_history`, `exams`,
  `exam_results`, `certificates`
- consumer surfaces of the attendance authority: `attendance.present` /
  `attendance.recorded` metric SQL in `core/reporting/report-catalog.ts`,
  `routes/impact.routes.ts` attendance stats, `/api/attendance` list+summary
- frontend `src/components/sessions/SessionsView.tsx` and
  `src/components/exams/ExamsView.tsx` contracts affected by the below

Excluded (consumed, not redesigned):

- enrollment/transfer/freeze/waitlist semantics (WP-05, certified)
- class roster membership authority (WP-05; the sessions roster builder is a
  documented consumer, not a second membership authority)
- teacher payroll computation (WP-08)
- installment-plan validation — hosted in `students.routes.ts` (WP-03); the
  legacy inventory's WP-06 heading for `installment-plan-integrity.test.ts` is
  a stale heading and is corrected, not claimed (see D-93 / C-16)
- report engine and metric registry design (WP-11); only the two attendance
  metric SQL expressions are adjusted to consume the canonical authority
- any new exam, certificate, grading, attendance or fee policy

Risk: **HIGH/CRITICAL** — attendance facts, exam results, certificates/diplomas
and grades are core academic records; attendance feeds reporting; exam scoring
carries money (exam fee, diploma fee).

## DISCOVER / MODEL

### Authority map

| Fact | Canonical owner | Consumers |
|---|---|---|
| Session attendance per (session, student) | `rosters` (status, weight, late_minutes, marked_at) | session analytics, auto-drop, impact report, report metrics, profile drawer |
| Day-level / teacher attendance | `attendance` rows with no session | `/api/attendance`, `/api/attendance/summary` |
| Attendance policy numbers | `attendance-policy-service` over the rule engine | roster writers, analytics |
| Attended-equivalent statuses | `ATTENDED_EQUIVALENT_STATUSES` | analytics, impact, weight computation |
| Auto-drop policy | `checkConsecutiveAbsences` + `EnrollmentService.drop` | roster writers |
| Grade computation | `computeClassGrades` (pure) | gradebook preview, complete-semester |
| Grade lock lifecycle | `grade-lock-service` over `GRADE_LOCK_TRANSITIONS` | grades writer, lock endpoints |
| Exam candidate/result | `exams` / `exam_results` (unique per exam+student/visitor) | Exams UI, reports |
| Certificate/diploma issuance | `certificates` | Exams UI, reports |
| Diploma fee (once per student) | fee resolution + payments/income `category='diploma'` | exam score-entry + correction |

### Defect inventory found in DISCOVER

**F-1 — Attendance is stored in two places (LAW 1).** Session marks are
written to `rosters` AND mirrored into `attendance`. The mirror cannot be
kept coherent by construction:

- `PATCH /sessions/:id/roster/:rosterId` writes only `rosters` — no mirror, no
  event, no auto-drop transaction;
- `POST /api/attendance` deletes `attendance` rows by `(date, target_id)`
  unconditionally — including session-mirrored rows for that student/day;
- `DELETE /sessions/:id` leaves mirrored `attendance` rows orphaned
  (`session_id` FK is `ON DELETE SET NULL`).

Every one of these paths already produces contradictory attendance fact.

**F-2 — Exam creation trusts identity branch, not authorization scope (C-8
class).** `POST /exams` writes `branch_id = req.user?.branchId` while every
read uses `resolveBranchScope` + assignment reach. A principal whose assignment
authorizes branch B but whose identity branch is A creates exams in A.

**F-3 — Certificate revocation destroys history (D-17).** Correction-down
`DELETE FROM certificates` erases an issued academic output instead of
recording revocation. `certificates` has no status column.

**F-4 — Scored state is encoded as `score > 0`.** `exam_results.score`
defaults to 0 (an impossible-but-legal TOEFL score) and the score-entry gate
uses `score > 0`, so a genuinely recorded 0 can be silently overwritten and the
UI renders it as "Pending Score". `status` ('pending'/'pass'/'fail') is the
real state marker and is unconstrained by the database.

**F-5 — Exam type vocabulary drifts.** Schema CHECK and default admit `'mock'`;
the API rejects it; the frontend type union admits it. An existing row of any
other type can be edited, but the vocabulary disagreement makes contract
surfaces lie about what is legal.

**F-6 — Completed session history is mutable.** `PUT /sessions/:id` can change
date/start/end of a completed session (moving history between analytics
periods); `DELETE` refuses only `status='completed'`, so a scheduled session
that already carries attendance marks can be deleted and the marks cascade
away with it.

**F-7 — Single-roster PATCH lacks the bulk path's guards.** It has no
completed-session correction guard (a teacher can silently correct a completed
session of their own), no transaction boundary around the auto-drop, no
`attendance.marked` event.

**F-8 — Grade and assessment bounds live in the route only.** Negative scores
pass the `score > max_score` check; `maxScore`/`weight` have no database
backstop; `student_grades.score` and `class_assessments.weight/max_score` are
unconstrained REALs.

**F-9 — Session timetable input is under-validated.** `weeks=NaN → 1`
silently, `daysOfWeek` values are not range-checked, and `date`/`startTime`/
`endTime` are free-form strings compared lexically.

**F-10 — Student-attendance metrics include teacher rows.** `attendance.present`
and `attendance.recorded` count every row in `attendance`, so teacher
attendance pollutes a student attendance report.

## CHALLENGE

| Subsystem | Verdict | Reason |
|---|---|---|
| `rosters` / session marks | KEEP | correct canonical shape; weight + marked_at live here |
| `attendance` session mirror | **REMOVE** | F-1 — duplicate authority with proven drift paths |
| `attendance` day-level/teacher rows | KEEP | the only home for session-less marks; contract preserved |
| Attendance readers (metrics/impact/summary/list) | **REFACTOR** | consume one canonical union over the single authorities |
| Exams CRUD/enroll | KEEP + repair | F-2, F-5, date validation |
| exam_results scoring gate | **REPAIR** | F-4 — `status` is the scored marker; DB CHECKs |
| Certificates | **REBUILD (lifecycle)** | F-3 — issuance/revocation states, immutable facts (D-17) |
| Sessions CRUD | KEEP + repair | F-6, F-7, F-9 |
| Gradebook/grade-lock services | KEEP | pure engine + tested transition graph |
| Assessment bounds | **REPAIR** | F-8 — API + DB backstops |
| Legacy WP-06 test baseline | **REBASE** | D-92 precedent: replace with package authority |

## DECIDE

Decisions D-93–D-100 (recorded in `docs/registries/decisions.md` in full).
Summary of the implementation plan:

1. **Schema (`server/src/db/schema.sql`):**
   - `attendance`: remove `session_id` column (no writer, no reader).
   - `exam_results`: `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
     ('pending','pass','fail'))`; `score REAL CHECK (score IS NULL OR (score >=
     0 AND score <= 120))`; keep INSERT explicit-score contract by writing NULL
     until scored? — no: keep writing 0 for unscored (frontend contract), the
     CHECK covers the range, `status` is the scored marker.
   - `exams.type`: drop `'mock'` from the CHECK; remove the `'mock'` default
     (the route always supplies type; no other writer exists).
   - `certificates`: add `status TEXT NOT NULL DEFAULT 'issued' CHECK (status
     IN ('issued','revoked'))`, `revoked_at TEXT`, `revoked_by TEXT`.
   - `student_grades.score`: `CHECK (score IS NULL OR score >= 0)`.
   - `class_assessments`: `CHECK (weight >= 0 AND max_score > 0)`.
   - `exams.date`, `sessions.date`: keep TEXT (ISO by contract) — validation is
     a boundary concern; no storage change.
2. **Attendance authority consolidation:**
   - `sessions.routes.ts`: stop mirroring (`stmtDeleteLegacyAttendance` /
     `stmtInsertLegacyAttendance` deleted); `PATCH /:id/roster/:rosterId`
     becomes the same transactional command as the bulk path (status write +
     auto-drop + `attendance.marked` event in one transaction; completed-
     session correction restricted to managers; `'not_marked'` stays the
     single-mark reset).
   - New canonical read authority `server/src/core/academic/attendance-query.ts`
     exporting the one expression set for student attendance facts:
     session marks (rosters JOIN sessions) UNION day-level marks (attendance
     where `target_type='student'`), each row carrying source, status, date,
     branch, class, session. Consumers: report-catalog metrics
     (`attendance.present`, `attendance.recorded`), `impact.routes.ts` stats,
     `/api/attendance` list and `/summary`.
   - Teacher attendance remains `attendance`-only and is excluded from
     student-attendance metrics (F-10), recorded in the metric registry.
3. **Sessions repairs:** DELETE refuses when any mark exists; PUT refuses
   date/time mutation of completed sessions; timetable generator validates
   `weeks` (finite integer 1–12), `daysOfWeek` (0–6, deduplicated) and
   `HH:MM` times; POST / and PUT / validate ISO dates and HH:MM times.
4. **Exams repairs:** POST / resolves branch via `resolveBranchScope`;
   type vocabulary unified (no `mock`); ISO date validation; score-entry gate
   keyed on `status !== 'pending'`; correction preserves fee rule; certificate
   revocation becomes a state transition (F-3) with re-issue creating a new
   numbered certificate (preserving today's new-number behavior).
5. **Assessment/grade repairs:** negative score rejection at the route, DB
   CHECK backstops; `maxScore > 0`; `weight >= 0`.
6. **Frontend:** `ExamsView` renders scored state from `status`; `src/types.ts`
   exam type union drops `'mock'`; `SessionsView` unchanged otherwise.
7. **Tests (D-100):** the 10 inventoried WP-06 legacy files (94 declared cases)
   are rebased under `server/src/tests/work-packages/wp06/` as requirement
   authority; `installment-plan-integrity.test.ts` re-homes to `wp03`
   (students-route behavior, WP-03 authority); new `wp06/attack.test.ts` +
   `wp06/attendance-authority.test.ts` + `wp06/exam-certificate-lifecycle.test.ts`
   pin the new invariants; legacy inventory and registries updated.

## CHECKPOINT

- Recoverable pre-package baseline: `e1d91326a5716b225bda03abf88a665c0f57aaf5`
  (working tree clean, gate 22/22 verified on clean install).
- Schema changes, an RBAC correction and attendance/certificate authority
  changes are in scope; no production data exists; Git is the recovery
  mechanism. Precedent: WP-04/WP-05 checkpoints (D-85, D-92) recorded the
  baseline in-plan and proceeded with decisions registered in the Decision Log.

## IMPLEMENT / VERIFY / ATTACK record

**IMPLEMENT** — decisions D-93–D-100 executed:

- Schema: `attendance.session_id` removed; `exam_results.status`/`score`
  CHECKs; `exams.type` vocabulary unified (no `mock`, no default); `certificates`
  lifecycle columns (`status`/`revoked_at`/`revoked_by`); `student_grades.score`
  and `class_assessments` weight/max_score CHECKs. Preflight: 112 tables /
  238 indexes / 117 triggers, stands alone.
- Attendance authority: mirror writes removed from the roster commands;
  `core/academic/attendance-query.ts` exports the single union; report metrics,
  impact stats, `/api/attendance` list and summary all consume it; summary rate
  uses the attended-equivalent authority; teacher rows excluded from student
  surfaces.
- Sessions: mark-guarded DELETE, completed-session date/time immutability,
  transactional single-roster PATCH with the bulk path's guards, canonical
  date/time validation everywhere (`utils/isoDate.ts`), timetable generator
  input hardening; dead declarations removed.
- Exams: `resolveBranchScope` creation branch, one type vocabulary, ISO date
  validation, status-gated score entry, revocation-as-state with unchanged fee
  policy; stale comments rewritten as current intent.
- Gradebook: score/status bounds at route + schema.
- Frontend: `ExamsView` renders scored state from `status`; `types.ts` exam
  union and attendance comment updated.

**VERIFY** — full suite 163 files / 2564 tests passing with only the 160
explicit WP-04 retirements skipped; `audit:registries` 335 rows all live;
server and frontend typechecks clean.

**ATTACK** — the new authority suites include the adversarial cases:

- attendance: stray mirror rows after bulk and single marks (0), day-level +
  session same-day double facts, teacher-row pollution of summary and metrics,
  `not_marked` placeholder leakage, marked-session deletion, completed-session
  date moves and teacher corrections, attended-equivalent rate credit;
- exams: identity-branch creation (403, no row), explicit cross-branch scope
  honored, `branchId=all` refused, `mock` rejected on create and edit,
  malformed dates rejected, scored-0 re-entry blocked, direct-storage CHECK
  violations (status/score/type/certificate status/attendance session column);
- sessions: malformed dates/times, reversed spans, garbage generation windows,
  bogus roster statuses and duplicate ids, homework due dates, early
  completion;
- gradebook: negative scores, above-max scores, unknown statuses, direct-storage
  bound violations.

**REPAIR/REVERIFY** — two defects found during the attack pass:

1. an `isAll` exam-creation request reached an unhelpful 403; it is now an
   explicit 400 with a clear message, covered by the `branchId=all` case;
2. the unfiltered (org-wide, no targetId) `/api/attendance/summary` call
   rendered an empty WHERE clause and would have failed; the WHERE is now
   conditional and an unfiltered org-wide case pins it.

Re-verified: wp06 14 files / 126 tests green; full suite 163 files / 2562
tests with only the 160 explicit WP-04 retirements; full release gate green.
