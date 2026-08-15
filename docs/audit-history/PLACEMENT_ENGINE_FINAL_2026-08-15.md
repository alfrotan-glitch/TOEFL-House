# Placement Assessment Engine — Final Architecture & Hardening Report

**Date:** 2026-08-15 · Branch `arena/01a003cd-toefl-house` · Commits: `3690bca` (content-driven), `a3474ed` (Placement Engine)
**Process:** discovery → reproduce-with-evidence → minimal fixes → full regression → live E2E. Nothing claimed READY that is not executable.

---

## A. Current Architecture (after implementation)

### Data model (all placement tables, migration 057 + 058)
| Table | Role | Key capabilities |
|---|---|---|
| `placement_assessment_profiles` | **Placement Policy** per program-version + branch | `requirement_mode (required/optional/not_required)`, `first_level_exempt`, `expires_minutes`, `decision_rules_json`, `version` (policy version), `components_json` with per-component `enabled, order, timeLimitSeconds, minScore, scoringMethod (auto/manual/hybrid), retryPolicy, passFail, testId, weight, maxScore` |
| `placement_assessment_attempts` | Attempt | status `in_progress/paused/completed/expired/cancelled`, `expires_at, paused_at, resumed_at, policy_version, decision_rule_id, override_level_id/reason/by/at`, immutable `snapshot_json` (policy + tests + questions + answer keys) |
| `placement_assessment_results` | Per-component outcome | status `pending/in_progress/completed/waived/timed_out`, server timing (`started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag, paused_at`), provenance (`raw_score, percentage, weighted_score, score_version, corrected_at, correction_reason`) |
| `placement_assessment_responses` | Candidate answers | UNIQUE(attempt_id, question_id) replay guard; FK RESTRICT → answered content immutable |
| `placement_rules` | Decision rules | score bands + `conditions_json` (skill thresholds) |
| `placement_tests` | Reusable content | `test_type, difficulty, duration_seconds, version (counter), rubric_id, word_target, content_json, status (draft/active/archived)` |
| `placement_test_questions` | Questions | `qtype (mcq/short_answer/essay/speaking), answer_key, points, difficulty, section_key` |
| `placement_test_sections` **(new)** | Listening tracks / reading passages / speaking blocks | `kind (audio_track/passage/prompt_block/instructions), audio_url, transcript, body, duration_seconds` |
| `placement_rubrics` **(new)** | Writing/speaking rubrics | `criteria_json (key/label/weight/max_score)` |
| `placement_media` **(new)** | Safe file storage | `filename, mime, size_bytes, sha256, storage_path, kind` |
| `visitors` | + `placement_requirement_mode, placement_status_at` | reporting dimensions |

### Backend modules (one file = one responsibility)
- `core/placement/policy-engine.ts` — requirement resolution, first-level exemption, policy/component/decision-rule validation
- `core/placement/timing-engine.ts` — deadlines, timeout enforcement, pause/resume math, lazy expiry, editable guard
- `core/placement/scoring-engine.ts` — deterministic auto-scoring + provenance computation + manual/hybrid merge
- `core/placement/decision-engine.ts` — conditional rules + band fallback + minimum-score + override/correction support
- `core/placement/reporting.ts` — actual-activity placement report
- `core/placement/store.ts` — shared statements + serializers
- `routes/placement-attempt.routes.ts`, `routes/placement-test-bank.routes.ts`, `routes/placement.routes.ts` (aggregator)
- `routes/academic.routes.ts` (policy PUT via policy-engine), `routes/visitors.routes.ts` (policy-gated enrollment)

### API surface (new in bold)
`GET /placement/visitors/:id/placement` (requirement mode + timers) · `POST …/attempts` (mode gate + optional skip + immutable snapshot + expiry) · **`PUT …/tests/:key/start` (server timer)** · `PUT …/tests/:key/responses` (auto-score, timing-enforced) · `PUT …/components/:key` (manual/hybrid, override-guard) · `POST …/complete` (decision engine) · **`POST …/pause` / `…/resume`** · `POST …/cancel` · **`POST …/override` (audited)** · **`POST …/components/:key/correct` (audited)** · `GET …/attempts` · **`GET /placement/report`** · test-bank CRUD + activate/archive + **preview, sections, rubrics, media upload/serve**

### Frontend
- `PlacementTestModal`: server-synced countdowns (deadline is server truth), per-component progress, timeout state, pause/resume, optional skip/exemption, content rendering (sections/audio/transcript/passage)
- `ProgramVersionsPanel`: requirement mode, first-level exemption, attempt expiry, content_test + testId picker, per-component time limit (s)/min score/scoring method, conditional decision-rule editor
- **`TestBankAdminView` (new tab)**: content authoring — tests, sections, questions, answer keys, rubrics, media upload, publish/archive, preview

---

## B. Gap Analysis (11 gaps, reproduced with evidence before fixing)

| ID | Gap | Evidence (pre-fix, `placement-engine-gap.test.ts`) |
|---|---|---|
| D1 | No Policy mode / first-level exemption / level applicability | profile columns lacked `requirement_mode/first_level_exempt`; enrollment guard hard-coded `profile?.required && profile.enabled` |
| D2 | No server-enforced timing | results/attempts lacked `started_at/deadline_at/submitted_at/elapsed_seconds/timeout_flag/expires_at`; status CHECK lacked `paused/expired/timed_out` |
| D3 | Content partial | no `placement_test_sections/rubrics/media`; tests lacked `difficulty/version/rubric_id/word_target`; questions lacked `difficulty/section_key` |
| D4 | Attempt model limited | no `paused_at/resumed_at/policy_version/override_*` |
| D5 | No scoring provenance | results lacked `raw_score/percentage/weighted_score/score_version/correction_*` |
| D6 | Decision rules band-only | `placement_rules` lacked `conditions_json` |
| D7 | No policy-resolution service | `core/placement/` absent; routes inline `required&&enabled` |
| D8 | Frontend gaps | `componentTypes` lacked `content_test`; no timers; no test-bank UI |
| D9 | Security surface for new features untested | covered by new regression tests (below) |
| D10 | Reporting can't distinguish statuses/dimensions | no `/placement/report`; overview aggregates only |
| D11 | Monolithic router | `placement.routes.ts` 690 lines; logic inline |

## C. Defects Reproduced (executable, pre-fix)
1. Profile method CHECK rejected single-component `content_test` policies (SQLITE_CONSTRAINT_CHECK → 400 `Invalid data provided`) — found while writing the single-skill test.
2. `validateDecisionRules` rejected an already-parsed array (JSON.parse of a string) — reproduced by the decision-rules test.
3. Timer start used a non-existent `evaluatorUserId: 'system'` → FK 409 — reproduced by the single-skill test.
4. Partial/resubmit clobber (from pass-2 audit, still guarded) — regression suite keeps it red before fix.
5. Migration 058 initially lost its attempts/results sections during an edit — caught by fresh-DB test run (results missing `raw_score`); restored (54→58 statements).

## D. Root Causes
- Policy/level/timing/decision concepts simply did not exist in the data model (feature gap, not a regression).
- Hard-coded boolean `required && enabled` in the enrollment path bypassed any configurable tri-state.
- Time was a display hint (`durationMinutes`) with no server state — nothing to enforce.
- Content was a single blob (`audio_url`/`passage`) — no structural model for tracks/passages/rubrics.
- Scoring wrote only the normalized score — provenance and correction trail were absent.
- Monolithic router accumulated ~690 lines because concerns (policy/scoring/timing/decision/content) were not separated.

## E. Final Architecture
See §A. Key design decisions (all reuse existing structures; no parallel models):
1. `placement_assessment_profiles` **is** the Placement Policy (additive migration 058).
2. Timing is enforced server-side; the client only displays the server deadline.
3. The attempt snapshot is the single immutable record of what the candidate saw (policy version + tests + questions + keys at start).
4. Every score carries provenance; corrections are explicit, authorized, audited, and re-run the decision engine.
5. Decision rules are data (bands + conditions); no thresholds in controllers.
6. First-level exemption is policy configuration, not code.

## F. Database / Migration Changes
- `058_placement_engine.sql` (58 statements): profiles (+policy fields, method CHECK + `content_test`, table rebuild), attempts (+expiry/pause/resume/policy_version/override, CHECK + `paused/expired`, rebuild), results (+timing + provenance, CHECK + `timed_out`, rebuild), rules (+`conditions_json`), tests/questions (+difficulty/duration/version/rubric/word_target/section_key), visitors (+`placement_requirement_mode/placement_status_at`), new tables `placement_test_sections`, `placement_rubrics`, `placement_media`; data preserved via temp-table copies; FKs/unique/indexes maintained.
- `schema.sql` mirrored (fresh install == upgraded install; verified by `preflight:fresh-schema` and by applying 058 to the live DB at boot).
- No duplicate/parallel placement models; 057 content tables reused.

## G. Backend Changes
- New engines (policy/timing/scoring/decision/reporting/store) + two new routers + aggregator (see §A).
- New endpoints: timer start, pause, resume, override, correct, report, media upload/serve, rubrics CRUD, preview, sections management; test-bank PUT now upserts questions by key and bumps the content version.
- Enrollment guard (visitors.routes) + academic policy PUT now use the policy engine.

## H. Frontend Changes
- `PlacementTestModal` — timers, progress, timeout, pause/resume, optional skip, sections/audio rendering.
- `ProgramVersionsPanel` — policy authoring (mode, exemption, expiry, per-component timing/minScore/scoring, testId, decision rules).
- `TestBankAdminView` + `test-bank` navigation tab — full content authoring incl. media upload and preview.
- No business rules duplicated client-side: the backend is authoritative for scores and time.

## I. Security / RBAC Results
| Attack surface | Result |
|---|---|
| Answer-key leakage (profile + attempt views) | PASS — keys stripped in `mapProfile`/`mapAttempt`; staff preview is the only key surface (authoring) |
| Score manipulation | PASS — auto components reject overrides (409); manual bounded to manual points; server computes from stored rows |
| Post-completion score change | PASS — blocked; only audited `correct` (owner/manager + reason + before/after) |
| Placement-result change without audit | PASS — complete/override/correct all write audit entries with before/after |
| Timer manipulation / client deadline bypass | PASS — deadline computed + enforced server-side; late submission → `timed_out` 409; attempt expiry lazy |
| Cross-student attempt access | PASS — attempt id bound to visitor + branch scope (404/403) |
| Cross-branch access (tests/rubrics/media/responses) | PASS — branch-scoped queries + `assertVisitorBranchAccess`; owner org-wide by existing RBAC design |
| Unauthorized policy/content changes | PASS — owner/manager/HOD only; registrar read-only (403 on write) |
| Duplicate responses / submissions | PASS — UNIQUE(attempt_id, question_id) upsert, state from stored rows |
| Concurrent submissions | PASS — parallel PUTs atomic, no duplicates/500s |
| Replay attacks | PASS — idempotent upserts + attempt-status guards |
| Changing content after attempt start | PASS — snapshot immutability + FK RESTRICT + content version counter |

## J. Timing / Concurrency Results
- Per-component `timeLimitSeconds` (or `durationMinutes`×60) → `started_at` + `deadline_at` set by `PUT …/start` (idempotent).
- Early submission: accepted, `elapsed_seconds` + `submitted_at` recorded.
- Timeout: submissions past deadline rejected 409; result → `timed_out` + `timeout_flag`; required timed-out blocks completion (management can waive).
- Refresh/reconnect: GET view re-syncs from server deadlines; submissions upsert (replay-safe).
- Pause: status `paused`, timers frozen; resume extends all deadlines + attempt expiry by the pause span (tested with a simulated 60 s pause → ≥58 s extension).
- Abandoned attempt: stays `in_progress` until `expires_at` → lazy transition to `expired` on next access.
- Concurrency: parallel response PUTs tested — no duplication, consistent final state.

## K. Scoring Verification
- Auto: MCQ exact key; short-answer trimmed + case-insensitive. Normalized to component max score. Provenance (`raw_score/percentage/weighted_score/score_version`) stored per result.
- Manual/hybrid: staff score bounded; content components merge immutable auto portion with bounded manual portion; pure-auto components cannot be overridden.
- Corrections: `POST …/correct` (owner/manager, reason required) bumps `score_version`, records `corrected_at/correction_reason`, recomputes the weighted total and recommendation (tested 94% → 100% after correction).
- No client-supplied score is trusted anywhere.

## L. Program / Level Policy Verification
- NOT_REQUIRED → start blocked, enrollment allowed (tested).
- OPTIONAL → start allowed or audited skip/exemption (`placement_status='waived'`, mode `optional`) (tested).
- REQUIRED → must complete before enrollment (guard now policy-driven) (tested).
- First-level exemption: config `first_level_exempt` + target level = version's first level → NOT_REQUIRED (tested live: A1 → not_required, B1 → required).
- Single-skill policy yields a valid decision (tested: one listening component → 100% → B1).
- Any combination: hybrid multi-component tested (content + content, content + written).

## M. Reporting Integration
- `GET /api/placement/report?from&to[&branchId]` — actual-activity-only: attempts by status (completed/expired/cancelled/in_progress), visitors by placement status + requirement mode, requirement-mode distribution, completed attempts by program/version/level/gender/branch, content results by skill/test/test-version, audited placement events. Range-based (daily/monthly/quarterly/yearly via from/to). No zero-value rows.
- Existing `/api/reports/overview` placement block retained (attempts/completed/avg/levelDistribution/conversion).

## N. Test Evidence
| Suite | Result |
|---|---|
| Full server regression (`npm test`) | **51 files / 539 tests PASS** (baseline 49/515) |
| `placement-engine-lifecycle.test.ts` (16) | PASS — policy modes, exemption, timing, timeout, pause/resume, expiry, decision rules, min-score, override, correction, sections/rubrics/media, reporting, RBAC, branch isolation |
| `placement-engine-gap.test.ts` (8, closed-state) | PASS |
| Existing placement suites (gap/lifecycle/workspace/hardening/deep-audit) | PASS |
| Typecheck (server + frontend) · ESLint · `vite build` | PASS |
| `preflight:fresh-schema` | PASS |
| Migration 058 on live upgraded DB | PASS (applied at boot, integrity + FK checks) |
| **Live E2E #1 (content lifecycle)** | **29/29 PASS** |
| **Live E2E #2 (engine: exemption, timer, decision, override, pause/resume, media, report)** | **20/20 PASS** |

## O. PASS / FAIL / UNVERIFIED Matrix (acceptance criteria)
| # | Criterion | Status |
|---|---|---|
| 1 | A program can require no placement | **PASS** |
| 2 | A program can make placement optional | **PASS** |
| 3 | Only one skill required | **PASS** |
| 4 | Any combination of skills | **PASS** (config-driven, hybrid tested) |
| 5 | Independent server-enforced time limit per skill | **PASS** |
| 6 | Listening supports real audio content | **PASS** (URL + sections + media upload; playback via browser `<audio>`) |
| 7 | Reading supports multiple passages | **PASS** (sections; 2-passage test) |
| 8 | Writing: prompts + rubric + manual scoring | **PASS** |
| 9 | Speaking/interview structured assessment | **PARTIAL** — speaking prompt blocks + ordered questions + manual scoring + rubric work; **recorded-audio capture pipeline is NOT implemented** (no microphone/upload-from-device flow) → **INCOMPLETE** |
| 10 | Historical attempts preserve exact test versions | **PASS** (snapshot + content version counter) |
| 11 | Scores cannot be manipulated from the client | **PASS** |
| 12 | Placement rules configurable | **PASS** (bands + conditions + policy rules) |
| 13 | Placement decisions reproducible | **PASS** (deterministic engine, rule id recorded) |
| 14 | Authorized manual overrides audited | **PASS** |
| 15 | Content authoring through the UI | **PASS** (TestBankAdminView + ProgramVersionsPanel) |
| 16 | Historical content cannot be destructively changed | **PASS** (FK RESTRICT + archive) |
| 17 | Branch/RBAC isolation proven | **PASS** |
| 18 | Placement activities reach the reporting layer | **PASS** |
| 19 | Daily/monthly/quarterly/yearly reporting distinguishes actual activities | **PASS** (range-based report + overview) |
| 20 | Full regression, build, migration, security, concurrency, live E2E | **PASS** |

## P. Remaining Risks
1. **Speaking audio capture (INCOMPLETE, acceptance #9 partial):** speaking *content and manual scoring* are implemented and tested, but there is no device-audio recording/upload pipeline. Adding it requires a recorder UI + secure upload (reuse `placement_media` storage) + playback in the staff view.
2. **Rubric enforcement is advisory:** rubrics are stored and linked, but criterion-level scoring entry in the UI is not wired to a per-criterion input (staff enter one manual score + free-text feedback). A rubric-driven scoring form is the next increment.
3. **Owner is org-wide by design** (existing RBAC): cross-branch attempt access by `owner` is intentional; any future tightening must be global policy.
4. **Preview keys surface:** `/test-bank/:id/preview` and `GET /test-bank` include answer keys — deliberate for authoring, but keep those routes staff-role-gated (they are).
5. **Visual E2E not browser-automated:** the new UI (modal timers, admin panel) is typechecked and built but not exercised by a headless-browser test; behavior is covered at the API level.
6. **Timer drift vs. wall clock:** deadlines are stored in SQLite UTC text; `remaining` uses client clock for display only — enforcement uses server comparisons at submission time (safe).
7. **Lazy expiry only:** attempts are marked `expired` on next access; a periodic sweeper would tidy reporting latency (not a correctness issue).
