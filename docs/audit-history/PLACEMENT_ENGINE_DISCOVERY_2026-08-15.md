# Placement Assessment Engine — Forensic Discovery & Gap Analysis

**Date:** 2026-08-15 · Phase 1 (discovery only — no code modified). Base: `4e28298`.

## A. Current Architecture (FACT — verified against live DB + source)

### Data model (8 placement tables)
| Table | Columns (key) | Purpose |
|---|---|---|
| `placement_assessment_profiles` | `program_version_id, branch_id, enabled(0/1), required(0/1), method, sections_json, components_json, scoring_model, allow_retake, max_score, pass_score, instructions, version` | Placement blueprint per program-version + branch. Boolean enabled/required only — **no tri-state, no level applicability, no timing, no per-component scoring config beyond weight/maxScore/durationMinutes** |
| `placement_assessment_attempts` | `visitor_id, program_version_id, profile_id, branch_id, attempt_number, status CHECK(in_progress,completed,cancelled), started_at, completed_at, total_score, max_score, percentage, recommended_level_id, recommendation_text, examiner_user_id, snapshot_json` | Attempt lifecycle — **no paused/expired, no expires_at, no policy_version, no override fields** |
| `placement_assessment_results` | `attempt_id, component_key, component_type CHECK(…,'content_test'), status CHECK(pending,in_progress,completed,waived), score, max_score, weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id, completed_at, updated_at, UNIQUE(attempt_id,component_key)` | Per-component outcome — **no timing columns, no raw_score/percentage/weighted_score/score_version, no correction fields** |
| `placement_assessment_responses` | `attempt_id, test_id, question_id, question_key, response_json, auto_score, max_points, feedback, answered_at, UNIQUE(attempt_id,question_id)` | Candidate answers (replay-safe) |
| `placement_rules` | `program_version_id, name, min_score, max_score, recommended_level_id, recommended_level_code, branch_id, sort_order, is_active, version` | **Score-band-only decision rules — no conditional skill thresholds** |
| `placement_tests` | `title, test_type CHECK(listening,reading,writing,speaking), instructions, audio_url, transcript, passage, status(draft,active,archived), branch_id, created_by` | Test bank — **single audio_url, single passage; no sections/tracks/multi-passage, no difficulty, no duration, no version counter, no rubric link, no word target** |
| `placement_test_questions` | `test_id, question_key, qtype CHECK(mcq,short_answer,essay,speaking), prompt, options_json, answer_key, points, order_index, UNIQUE(test_id,question_key)` | Questions — **no difficulty, no section grouping** |
| *(live counts)* | profiles 6 · attempts 6 · results 12 · responses 15 · rules 10 · tests 6 · questions 18 | — |

### API surface
- `/api/placement`: GET view · POST start · PUT responses · PUT component · POST complete · POST cancel · GET attempts · GET/POST/PUT test-bank · POST test-bank/:id/activate|archive
- `/api/academic/program-versions/:id/placement-profile` GET/PUT
- `/api/catalog/placement-rules` POST (band rules)
- `/api/reports/overview` — placement aggregates (attempts/completed/in_progress/cancelled/avg_score/levelDistribution/convertedToStudent) from `placement_assessment_attempts`
- No media/file endpoints (no multer, no static serving; `express.json` limit 2 MB)

### Frontend
- `PlacementTestModal.tsx` (201 lines): staff proctoring — content rendering (audio/transcript/passage/questions), auto-score feedback, manual score; **no timers, no progress, no requirement-mode awareness, no pause/resume**
- `ProgramVersionsPanel.tsx`: profile config UI — enabled/required checkboxes, components (label/type/weight/maxScore/required/durationMinutes/instructions), band rules; **`componentTypes` list lacks `content_test`; no testId picker; no timing/minScore/scoring-method; no requirement-mode tri-state; no first-level exemption; no decision-rule editor**
- No test-bank admin UI anywhere; content authoring is API-only

### Program/level integration
- Enrollment guard (visitors.routes.ts:355): hard-coded `profile?.required && profile.enabled && visitor.placement_status !== 'completed'` → blocks visitor→student registration. No optional mode, no not_required mode, no first-level exemption, no level-aware resolution.
- Visitors have **no target-level column**; placement decision assigns `placement_score.recommendation` after assessment.
- Visitor `placement_status` values in use: `not_started, in_progress, completed, scheduled` (after cancel) — no `exempt/expired/optional`.

## B. Gap Analysis (defect inventory to reproduce, then fix)

| ID | Defect | Directive requirement |
|---|---|---|
| D1 | No **Placement Policy** entity/mode: only boolean enabled/required; no required/optional/not_required; no level/course applicability; no first-level exemption config | Configurable policy attachable to program/version/level/course/branch |
| D2 | **No server-enforced timing**: `durationMinutes` display-only; no component `started_at/deadline/submitted_at/elapsed/timeout`; no attempt `expires_at`; no paused/expired statuses; no timeout/refresh/reconnect behavior | Independent per-component timers, backend-enforced, defined timeout/refresh/duplicate/concurrent/abandon/resume behavior |
| D3 | Content system partial: listening single audio (no tracks), reading single passage (no multi-passage), writing no rubric/criteria/word-target, speaking no ordered bank; no difficulty; no content version counter; no file upload/storage/validation | Full reusable content system per skill with versioning + safe media storage |
| D4 | Attempt model lacks `paused/expired`, `expires_at`, component timing, policy version, override fields | Full attempt model + statuses + immutable responses with authorized correction |
| D5 | Scoring lacks provenance: no raw_score/percentage/weighted_score/score_version/correction trail per result | Every score preserves raw/max/percent/weight/weighted/scorer/scored_at/feedback/version; server authoritative |
| D6 | Decision rules are score-band only; no conditional skill thresholds (`IF reading>=X AND listening>=Y THEN L3`); no minimum-skill requirements; no required-component-failure handling; no audited manual override | Configurable placement decision engine |
| D7 | No `resolvePlacementRequirement` service; enrollment guard hard-coded | Program/level integration: NOT_REQUIRED→no test; OPTIONAL→choose; REQUIRED→must complete; first-level exemption as config |
| D8 | Frontend: no timers/progress/timeout UI; policy config can't author content_test; no test-bank admin UI; no media upload | Dynamic policy rendering + admin content authoring UI |
| D9 | Security surface untested for new features (timer manipulation, deadline bypass, post-completion score change, result change without audit) | Full attack surface with executable regression tests |
| D10 | Reporting: overview aggregates only; no required/optional/exempt/expired/cancelled distinction; no per-skill/test/test-version/program/gender/branch breakdown; no placement activity report endpoint | Reportable placement activity with statuses + dimensions, actual-activity-only rows |
| D11 | `placement.routes.ts` = 690 lines; policy/scoring/timing/decision inline; visitors.routes has inline guard | Modular files: policy engine / test bank / content / attempts / responses / scoring / timing / decision / file handling / audit / reporting |

## C. Design (minimum architecture; reuses existing structures — no parallel models)

1. **Evolve `placement_assessment_profiles` → the Placement Policy** (additive migration 058): `requirement_mode CHECK(required,optional,not_required)` (authoritative), `first_level_exempt`, `expires_minutes`, `decision_rules_json` (conditional rules), component fields extended in `components_json` (`enabled, order, timeLimitSeconds, minScore, scoringMethod(auto|manual|hybrid), retryPolicy, passFail, testId`). Policy version = `version` column (bumped on save; snapshotted into attempts).
2. **Timing** (results columns): `started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag, paused_at`; attempt columns: `expires_at, paused_at, resumed_at, policy_version, decision_rule_id, override_level_id, override_reason, override_by, override_at`. Status CHECKs expanded: attempts `+paused, expired`; results `+timed_out`. Lazy expiry on access; server rejects submissions after deadline (timeout), records elapsed; pause/resume extends deadlines by pause span.
3. **Content**: `placement_tests` += `difficulty, duration_seconds, version, rubric_id, word_target, content_json`; new `placement_test_sections` (listening tracks / reading passages / speaking blocks: `section_key, title, kind, audio_url, transcript, body, duration_seconds, order_index`); questions += `difficulty, section_key`; new `placement_rubrics` (`criteria_json` with key/label/weight/max_score); new `placement_media` (filename, mime, size, sha256, storage_path, kind) + upload/serve endpoints with validation (mime whitelist, size cap, auth, branch scope). Content edits bump `version`; attempts snapshot exact content → immutable history; archive (never delete referenced content).
4. **Scoring**: results += `raw_score, percentage, weighted_score, score_version, corrected_at, correction_reason`; `score_version` bumps on authorized corrections (owner/manager, reason required, audit before/after). Auto-scoring unchanged (server-authoritative), now with provenance.
5. **Decision engine**: `placement_rules` += `conditions_json` (per-component ops gte/lte/eq/between on score/percentage; all conditions must match; band fallback). Component requirement satisfied only when completed/waived; conditional rules evaluated against completed results. Override: `POST /attempts/:id/override` (owner/manager, reason, audit).
6. **Policy resolution** (`core/placement/policy-engine.ts`): `resolvePlacementRequirement(programVersionId, branchId, targetLevelId|null)` → `{mode, profile, reason}`; first-level exemption when target level = version's lowest level and `first_level_exempt`; enrollment guard + start route + GET view all use it. Optional mode: start allowed, or skip (records `exempt` with reason `optional_skip`, audited).
7. **Modular backend**: `core/placement/{policy-engine,decision-engine,scoring-engine,timing-engine,reporting}.ts`; routes split: `placement.routes.ts` (aggregator, keeps export) → `placement-attempt.routes.ts` + `placement-test-bank.routes.ts` (+ media).
8. **Frontend**: PlacementTestModal → server-synced countdowns, progress (answered/total per component), component statuses, timeout state, requirement mode + optional skip; ProgramVersionsPanel → requirement_mode, first-level exempt, content_test + testId picker, per-component timeLimitSeconds/minScore/scoringMethod, decision-rule editor; new TestBankAdminView (tests, sections, questions, rubrics, media upload, publish/archive/preview).
9. **Reporting**: `GET /api/placement/report` — activity rows by status (required/optional/exempt/completed/expired/cancelled) + breakdown by program/level/gender/branch/skill/test/test-version; actual-activity-only.
