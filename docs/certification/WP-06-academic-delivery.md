# Certification — WP-06 Academic Delivery

**Work Package:** WP-06 Academic Delivery (sessions, attendance, exams, certificates, gradebook)
**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§58–74 and §W
**Date:** 2026-08-21
**Recoverable pre-package baseline:** `e1d91326a5716b225bda03abf88a665c0f57aaf5`
**Checkpoint:** `8d311f5` (`checkpoint WP-06 academic delivery plan (SCOPE-DECIDE)`)
**Status:** READY — scope-limited certification complete

> This artifact certifies only WP-06 Academic Delivery. It does not certify
> Library, Payroll, Reporting redesign, Workflow, Audit, final production
> operations, or the complete product. WP-07 Finance still requires
> re-certification under the Master Protocol.

## SCOPE

Included:

- session scheduling, generation, CRUD, lifecycle and history immutability;
- attendance: session rosters as the single store of session marks, the
  day-level/teacher `attendance` surface, the one union read authority, the
  attended-equivalent rate definition and the auto-drop interaction;
- exams: events, enrollment, fees, score entry, correction, and the
  certificate/diploma issuance + revocation lifecycle;
- class assessment CRUD/makeup, grade entry, grade history and the grade-lock
  workflow (the WP-05-excluded portions of `classes.routes.ts`);
- canonical schema backstops for every above boundary;
- consumer adjustments forced by the new authorities: the two attendance
  metrics, the impact attendance stats, the certificates-issued metric and the
  reports overview certificate count.

Excluded:

- enrollment/transfer/freeze/waitlist semantics (WP-05, certified);
- installment-plan validation (WP-03, re-homed suite);
- teacher payroll computation (WP-08);
- report engine and metric registry design (WP-11); only consumer SQL was
  adjusted;
- any new exam, certificate, grading, attendance or fee policy.

Risk: **HIGH/CRITICAL** — attendance facts, exam results, certificates and
grades are core academic records; attendance feeds reporting; exam scoring
carries money (exam fee, diploma fee).

## DEFECTS FOUND AND REPAIRED

| # | Defect | Repair | Evidence |
|---|---|---|---|
| F-1 | Session marks mirrored into `attendance` with three proven drift paths (single-mark PATCH never mirrored; day-level delete-by-date+target removed session rows; session deletion orphaned rows) | Mirror removed; `attendance.session_id` column removed; one union read authority consumed by every read surface | `wp06/attendance-authority.test.ts` |
| F-2 | Exam creation wrote the identity branch instead of the authorized scope | `resolveBranchScope` on POST /exams; explicit all-branches requests refused | `wp06/exam-scope-and-storage.test.ts` |
| F-3 | Certificate revocation deleted the issuance record | `status`/`revoked_at`/`revoked_by` lifecycle; revocation is a state transition; re-issue creates a new numbered certificate; fee policy unchanged | `wp06/exam-correction-financial-invariant.test.ts`, `wp06/exam-certificate-fee-integrity.test.ts` |
| F-4 | Scored state encoded as `score > 0` (a recorded 0 could be overwritten; UI rendered it as pending) | `status` is the scored marker, CHECKed in schema; gate and UI read status | `wp06/exam-scope-and-storage.test.ts` |
| F-5 | Exam type vocabulary drifted (schema admitted `mock`, API rejected it) | one vocabulary: placement/midterm/final/certification | `wp06/exam-scope-and-storage.test.ts` |
| F-6 | Completed session history mutable (re-date/re-time; delete of a marked scheduled session cascaded marks) | PUT refuses date/time changes on completed; DELETE refuses when marks exist | `wp06/attendance-authority.test.ts` |
| F-7 | Single-roster PATCH lacked the bulk path's transaction, event and completed-session correction guard | PATCH is now the same transactional command | `wp06/attendance-authority.test.ts` |
| F-8 | Grade/assessment bounds enforced only in the route (negative scores passed) | route + schema CHECKs | `wp06/gradebook-bounds.test.ts` |
| F-9 | Session inputs under-validated (NaN weeks → 1, unchecked days, free-form dates/times) | canonical `isoDate.ts` time authority + validated generators | `wp06/session-input-guards.test.ts` |
| F-10 | Teacher attendance polluted the student attendance metrics | union excludes teacher rows; metric definitions re-expressed | `wp06/attendance-authority.test.ts` |

## INDEPENDENT REVIEW

Performed cold from the diff and the recorded evidence, not from memory of
writing it. Same-agent limitation (TR-4) applies.

| # | Check | Result |
|---|---|---|
| R-1 | Every former writer of the attendance mirror is gone | **PASS** — repo-wide search: `INSERT INTO attendance` exists only in the day-level router; `DELETE ... session_id` gone; schema has no `session_id` column |
| R-2 | Every former reader of the mirror consumes the union | **PASS** — report-catalog metrics, impact stats, `/api/attendance` list and summary all reference `attendance-query.ts`; no consumer queries `attendance` for session marks |
| R-3 | Certificate rows are never deleted by any path | **PASS** — only `stmtRevokeCertificate` (UPDATE) remains; `DELETE FROM certificates` absent from routes; schema has no cascade that deletes certificates except student deletion |
| R-4 | The once-per-student diploma fee rule survives revocation retention | **PASS** — `priorCertCount === 0 && !alreadyPaid` unchanged; rebased fee tests green (16 cases) |
| R-5 | Scored-state gate cannot be bypassed | **PASS** — gate reads `status`; schema CHECK restricts status; direct-storage attack attempts rejected |
| R-6 | Exam creation cannot write an unauthorized branch | **PASS** — misaligned identity/assignment case: 403 and no row; explicit authorized scope honored |
| R-7 | Union SQL is the same expression in every consumer | **PASS** — consumers interpolate the exported fragments; no consumer re-declares an attendance predicate (source scan) |
| R-8 | Report reconciliation: issued vs revoked certificates | **PASS** — `academic-delivery` metric drops exactly one issued count after revocation (live engine assertion) |
| R-9 | Schema preflight with the new constraints | **PASS** — 112 tables / 238 indexes / 117 triggers; fresh init idempotent |
| R-10 | Legacy baseline replaced per §104 | **PASS** — inventory heading corrected (C-16); 10 suites rebased, 4 authority suites added; installment suite re-homed to wp03; no WP-06 skips |

## CERTIFICATION MATRIX

| Dimension | Status | Evidence | Remaining risk inside WP-06 |
|---|---|---|---|
| Architecture / canonical authority | READY | D-93–D-100; authority/invariant/metric registries; union authority | none material |
| Attendance correctness | READY | union + policy suites; F-1/F-7/F-10 repairs | SQLite single-writer deployment model remains assumed |
| Exam/certificate correctness | READY | scope, storage, lifecycle and fee suites | none material |
| Database/data integrity | READY | 117 triggers; new CHECKs; preflight; direct-write attacks | none material |
| History immutability | READY | completed-session guards, revocation-as-state, marked-session delete refusal | none material |
| Financial conservation | READY | correction cycle suites: no reversal, no mint, no duplicate charge | diploma-fee refund policy remains an owner decision (documented in the route) |
| RBAC/object scope | READY for altered exam/session surfaces | F-2 case; existing canonical RBAC untouched | no claim over later-package routes |
| API/error contracts | READY | input-guard suites; 400/403/409 semantics asserted | none material |
| Frontend/UX | READY for altered exam surface | typecheck, build, scored-state rendering from status | no claim over unrelated screens |
| Reporting coherence | READY for adjusted consumers | engine assertions for attendance and certificates metrics | broader metric definitions remain WP-11 |
| Testing / legacy replacement | READY | 14 files / 126 tests in wp06; no WP-06 skips; C-16 | 160 skips belong only to explicitly retired WP-04 knowledge |
| Maintainability/cleanliness | READY | registries, lint, static/protocol/dependency gates | independent review performed by the same agent (TR-4) |
| Operational readiness | OUT OF PACKAGE | build, schema and release gates pass | deployment/production operations are not certified here |

## CERTIFICATION

**WP-06 Academic Delivery is READY.** Every critical/high dimension inside the
defined package has executable evidence. No material attendance-authority,
exam-scope, certificate-lifecycle, scored-state, history-immutability,
grade-bound or consumer-reconciliation contradiction remains in scope.

This certification is deliberately bounded. It does not advance or certify
WP-07 Library, WP-08 Payroll, Finance re-certification, Reporting redesign,
Workflow, Audit, production operations or complete-system release readiness.
