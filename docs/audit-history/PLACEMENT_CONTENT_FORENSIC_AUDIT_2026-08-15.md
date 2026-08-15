# Placement Assessment — Content-Driven Forensic Audit & Implementation

**Date:** 2026-08-15 · **Branch:** `arena/01a003cd-toefl-house` · **Base:** `d9ccb43` (Reporting/Financial audit, pass 14)
**Scope:** Entire Placement Assessment subsystem and all integrations; minimum content-driven architecture implemented and verified end-to-end.

---

## 1. Architecture Map (current state, after implementation)

### 1.1 Database (all placement tables)

| Table | Role | Key columns / constraints |
|---|---|---|
| `placement_assessment_profiles` | Per program-version + branch placement blueprint | `enabled, required, method, components_json, scoring_model, allow_retake, max_score, pass_score` |
| `placement_assessment_attempts` | Candidate attempt (visitor-scoped) | `visitor_id, program_version_id, profile_id, branch_id, attempt_number, status (in_progress/completed/cancelled), snapshot_json, total_score, percentage, recommended_level_id, examiner_user_id` |
| `placement_assessment_results` | Per-attempt per-component outcome | `component_key, component_type CHECK (…, 'content_test'), status, score, max_score, weight, selected_level_id, payload_json, evaluator_user_id`, `UNIQUE(attempt_id, component_key)` |
| `placement_rules` | Score-band → level mapping | `min_score, max_score, recommended_level_id` (visitor-level priority over program-level) |
| `placement_tests` **(new)** | Reusable test-bank entries | `test_type CHECK (listening/reading/writing/speaking), instructions, audio_url, transcript, passage, status (draft/active/archived), branch_id NULL=global, created_by` |
| `placement_test_questions` **(new)** | Questions per test | `qtype CHECK (mcq/short_answer/essay/speaking), prompt, options_json, answer_key, points, order_index, UNIQUE(test_id, question_key)` |
| `placement_assessment_responses` **(new)** | Candidate answers per attempt | `attempt_id, test_id, question_id, response_json, auto_score, max_points, feedback, answered_at, UNIQUE(attempt_id, question_id)`; `FK RESTRICT` on test/question → answered content cannot be deleted |

### 1.2 API surface (`/api/placement`, mounted in `src/index.ts`)

| Method + path | Authz | Purpose |
|---|---|---|
| `GET /visitors/:visitorId/placement` | owner/registrar/manager/counselor + branch scope | Profile view (components, levels, rules, **contentTests without answer keys**), attempt history, current attempt |
| `POST /visitors/:visitorId/placement/attempts` | same | Start attempt → **immutable snapshot = profile + tests + questions + answer keys** |
| `PUT …/attempts/:attemptId/tests/:componentKey/responses` | same | Submit candidate answers; server auto-scores MCQ/short-answer; state derived from stored rows (replay-safe) |
| `PUT …/attempts/:attemptId/components/:componentKey` | same | Staff scores; for `content_test` merges bounded manual score with immutable auto portion |
| `POST …/attempts/:attemptId/complete` | same | Weighted total → placement rules → recommendation; fee + income + notification; idempotent completion |
| `POST …/attempts/:attemptId/cancel` | same | Cancel in-progress attempt |
| `GET /test-bank` | owner/manager/HOD/registrar/counselor (branch-scoped: global + own branch) | List tests + questions + **answer keys (staff authoring surface)** |
| `POST /test-bank` | owner/manager/HOD | Create test (+ questions); defaults to caller's branch; `branchId: null` = global |
| `PUT /test-bank/:id` | owner/manager/HOD | Edit test; **upsert-by-key** question editing preserves answered question row ids |
| `POST /test-bank/:id/activate` / `…/archive` | owner/manager/HOD | Lifecycle; cannot activate a question-less test |
| `PUT /api/academic/program-versions/:id/placement-profile` | owner/manager | Validates `content_test` + `testId` (exists, active, same-branch) |
| `POST /api/catalog/placement-rules` | AcademicSetup.Edit | Score bands |

### 1.3 Scoring engine (`componentScore` + content endpoints)

- `skill_scores`: 6 skills × 25 → normalized to `component.maxScore`.
- `written_test` / `interview` / `custom_score`: staff `score`.
- `level_assessment`: level-only or score.
- **`content_test` (new):** per-question `auto_score` computed server-side at submission (MCQ exact option-key match; short-answer trimmed + case-insensitive match). Component completes automatically only when every question is answered **and** none are manual. Essay/speaking: staff supplies `manualScore` bounded by manual question points; the route computes `(autoEarned + manualScore) / rawMax × component.maxScore` from stored rows — the auto portion can never be rewritten by staff.
- Completion: weighted average of completed/waived components → `percentage` → `placement_rules` band → recommended level → visitor `placement_status=completed`, `placement_score` snapshot, stage → `ready_to_enroll` chain, `current_placement_attempt_id` retained for history.

### 1.4 Frontend (`src/components/visitors/PlacementTestModal.tsx`)

Staff workspace: renders each component type; for `content_test` shows audio player, transcript (collapsible), passage, per-question MCQ/input/textarea, auto-feedback, auto-score chip, "Submit & auto-score" (calls the responses endpoint), and a manual-score panel for essay/speaking. No candidate-facing self-service surface exists (staff-proctored), consistent with the rest of the ERP.

### 1.5 Data flows (verified end-to-end)

```
Test Bank (content+keys)
  → profile content_test component (testId, active, same branch)
  → attempt start (snapshot captures tests/questions/answer_keys)
  → candidate responses (auto-score; state from stored rows)
  → component results (auto complete / manual merge)
  → weighted total → placement rule → recommended level
  → visitor completed + placement_score + history
  → reporting: attempt history in GET /placement; audit_logs entries
```

---

## 2. Defects Reproduced (FACT — executable evidence)

Reproduction suite: `server/src/tests/placement-content-gap.test.ts` (4 tests). Before implementation it PASSED proving the gap (console `[EVIDENCE]` output captured below); after implementation it was inverted to a closed-state regression guard.

| # | Gap reproduced | Evidence (pre-fix) |
|---|---|---|
| 1 | **No test-bank tables exist** — `placement_tests`, `placement_test_questions`, `placement_assessment_responses` absent | `[EVIDENCE] content tables found: []` |
| 2 | **Component-type allow-list has no content types** | `[EVIDENCE] results component_type CHECK: 'skill_scores','written_test','interview','level_assessment','custom_score'` |
| 3 | **No candidate-response submission path** — no `/responses`, no `/test-bank` routes | `[EVIDENCE] responses/test route present in placement.routes.ts: false` |
| 4 | **Attempt snapshot stores only the profile** — no test content, no answers | attempt columns carry no test/response/answer columns; `snapshot_json` = profile only |

**Additional defects found during implementation (all reproduced as failing tests before fix):**
- **5 (partial-resubmission clobber):** a response PUT containing only some questions overwrote the completed result row back to `pending`/NULL because the endpoint counted only the answers in the current request instead of stored rows (lifecycle test failed `expected 30 to be 100`, `null to be 100`).
- **6 (test edit breaks answered questions):** PUT test-bank replaced questions via delete-all+insert → 409 `This record is still referenced by other data and cannot be deleted.` (FK RESTRICT fired — good DB behavior, bad edit semantics).
- **7 (answer-key leakage in attempts view):** `mapAttempt` spread the raw snapshot including `answer_key` into the client-facing GET /placement response.

---

## 3. Root Causes

| Defect | Root cause |
|---|---|
| 1–3 | The placement subsystem was **staff-scored by design**: components were config-only (`components_json`), results carried staff-entered scores, and no content model existed. This is an architectural gap, not a regression. |
| 4 | Attempt snapshot was `{profile, capturedAt}` — it preserved *configuration* but not *content*, so a historical attempt had no record of what the candidate actually saw or answered. |
| 5 | Response endpoint used request-scoped state instead of deriving component state from the authoritative stored rows (single source of truth). |
| 6 | PUT used delete-all/re-insert for questions; FK RESTRICT on `placement_assessment_responses.question_id` correctly prevented deleting answered questions. |
| 7 | `mapAttempt` returned `{...attempt, snapshot}` verbatim; snapshot JSON contains answer keys for server-side scoring. |

---

## 4. Required Architecture Changes (implemented)

1. **Test bank** — reusable content (listening: audio_url + transcript + questions; reading: passage + questions; writing/speaking: prompt), branch-scoped with explicit global support, draft/active/archived lifecycle, `created_by`/timestamps.
2. **Content component type** — `content_test` + `testId` in the component config; validator requires an existing, **active**, same-branch test.
3. **Immutable attempt snapshot** — at start, snapshot the full test + questions + answer keys per content component, so later test-bank edits never alter past attempts or their scoring.
4. **Candidate responses + auto-scoring** — server-authoritative scoring (MCQ exact / short-answer trimmed case-insensitive); essay/speaking manual with bounded manual score merged to the immutable auto portion; pure-auto components cannot be overridden by staff PUTs.
5. **Replay/concurrency safety** — `UNIQUE(attempt_id, question_id)` + upsert; state derived from stored rows so partial, duplicate, and parallel submissions are atomic and idempotent.
6. **Read-view key secrecy** — profile `contentTests` and attempt snapshots strip `answer_key`; keys exist only in the staff test-bank surface and the server-side snapshot.
7. **Frontend** — content rendering in the staff placement modal (audio/transcript/passage, per-question inputs, auto feedback, manual score panel).

No redesign of the existing weighted-average/placement-rules/fee/completion machinery was needed; content components plug into it.

---

## 5. Exact Files / Database Changes

| File | Change |
|---|---|
| `server/src/db/migrations/057_placement_content_test_bank.sql` **(new)** | 3 tables + rebuilt results CHECK (temp-table copy preserves data), indexes, FKs; applied on upgrade and on fresh install |
| `server/src/db/schema.sql` | Mirrors migration (fresh install == upgraded install) |
| `server/src/routes/placement.routes.ts` | `content_test` type + `testId`; test-bank CRUD + activate/archive; snapshot capture; responses endpoint with auto-scoring; PUT component manual merge + override guard; `mapAttempt` key-strip; `mapProfile` content view; branch-scoped test-bank |
| `server/src/routes/academic.routes.ts` | Profile PUT accepts `content_test`; validates test exists/active/same-branch |
| `src/components/visitors/PlacementTestModal.tsx` | Content component rendering + response submission + manual score |
| `server/src/tests/placement-content-lifecycle.test.ts` **(new)** | 23 integration tests (full lifecycle + security) |
| `server/src/tests/placement-content-gap.test.ts` | Inverted to closed-state regression guard (4 tests) |

---

## 6. Test Evidence

| Suite | Result |
|---|---|
| Server full regression (`npm test`) | **49 files / 515 tests PASS** (baseline 47/488; +2 files/+27 tests) |
| `placement-content-lifecycle.test.ts` | 23/23 PASS |
| `placement-content-gap.test.ts` (closed-state) | 4/4 PASS |
| Existing placement suites (workspace/hardening/deep-audit) | all PASS (no regressions) |
| Typecheck (server + frontend) | PASS |
| ESLint (frontend + server) | PASS |
| `vite build` | PASS |
| `preflight:fresh-schema` | PASS (fresh install == schema.sql) |
| Migration 057 on live upgraded DB | PASS (applied at boot; integrity + FK checks) |
| **Live E2E against running server** | **29/29 PASS** — login → program/levels/version → rules → test-bank create/activate → profile → visitor → attempt → responses (auto 30/30) → duplicate replay → override rejected (409) → interview → complete (97% → B1) → history |

Lifecycle coverage: content → version → attempt → responses → auto_score → weighted total → placement decision → history; retake with edited test; duplicate-submission replay-safe; concurrent-submission atomic; RBAC (registrar read-only, HOD/manager/owner write); branch isolation (tests + responses + profile references); cross-student 404; answer-key secrecy (profile + attempts views); score-manipulation guards; historical immutability (test edit does not change completed attempts); audit trail.

---

## 7. PASS / FAIL / UNVERIFIED Matrix

| Area | Status | Evidence |
|---|---|---|
| Test-bank CRUD + lifecycle (draft/active/archived) | **PASS** | lifecycle tests 1–9; live E2E |
| Content profile validation (active + same-branch + weights) | **PASS** | lifecycle test 10 |
| Attempt snapshot immutability (content + keys) | **PASS** | lifecycle tests 12, 20 |
| Auto-scoring (MCQ/short-answer) | **PASS** | lifecycle tests 14–15; live E2E |
| Manual scoring (essay) bounded + merged | **PASS** | lifecycle test 18 |
| Score-manipulation guard (pure-auto override) | **PASS** | lifecycle test 17; live E2E 409 |
| Duplicate submission replay-safe | **PASS** | lifecycle test 15; live E2E |
| Concurrent submissions atomic | **PASS** | lifecycle test 16 |
| RBAC on test-bank write | **PASS** | lifecycle test 2 |
| Branch isolation (test visibility, profile refs, responses) | **PASS** | lifecycle tests 6, 10, 17 |
| Cross-student exposure | **PASS** | lifecycle test 17 (404) |
| Answer-key secrecy (read views) | **PASS** | lifecycle tests 11, 12 |
| Retake + history | **PASS** | lifecycle tests 21–23 |
| Historical immutability after test edit | **PASS** | lifecycle tests 20–21 |
| Audit trail (create/update/activate/responses) | **PASS** | lifecycle test 22 |
| Weighted total + placement rules + decision | **PASS** | lifecycle test 19; live E2E 97%→B1 |
| Fresh install == upgraded install | **PASS** | fresh-schema preflight; migration at boot |
| Full regression, build, lint | **PASS** | 515 tests; builds; lints |
| **Speaking content delivery end-to-end** | **UNVERIFIED** | Speaking test type + manual scoring implemented and unit-tested via the same code path as essay (question type `speaking`); no real audio-recording capture/upload flow exists in the ERP (no microphone/recording infra). Speaker audio playback (`audio_url`) is verified. |
| **Candidate-facing self-service portal** | **UNVERIFIED** | The ERP has no candidate-login placement surface; placement is staff-proctored. If a candidate portal is ever added, the responses endpoint must be re-audited for authz (currently staff-only). |
| **Test-bank management UI screen** | **UNVERIFIED** | Authoring is fully supported via API (tested) and content *rendering* exists in the placement modal; a dedicated standalone test-bank admin screen was intentionally not built (minimum scope; API is the contract). |

---

## 8. Remaining Risks

1. **Speaking assessment** — a speaking *prompt* + manual score works, but there is no recorded-audio upload/playback pipeline in the ERP; a full speaking test requires a media upload (file handling) feature. Treated as future work, not a defect of the content model.
2. **Essay manual scoring is human-dependent** — no rubric engine; feedback is stored free-text in the response/result payload. Acceptable for a placement system (TOEFL-style human raters), but a rubric checklist UI would harden consistency.
3. **Owner is org-wide by design** (`canAccessBranch` returns true for `owner`) — owners can cross branches for attempts; the test-bank *listing* is still branch-filtered for everyone. This matches the ERP's existing RBAC model; any future tightening should be global policy.
4. **`GET /test-bank` exposes answer keys to registrar/counselor** — deliberate (staff proctoring needs review), but it is the only surface where keys leave the server; keep it staff-role-gated.
5. **No candidate-side API** — if a self-service candidate flow is added later, the responses endpoint needs a candidate authz path (currently owner/registrar/manager/counselor only) and anti-proctoring considerations.
6. **Manual score field** uses `manualScore` (not `score`) for content components — a client sending `score` to a content component gets 409 for pure-auto or 400 (unbounded) for manual; documented contract, but a client regression could confuse operators. Frontend uses the correct field.

---

## 9. Final Verdict

**READY** (content-driven placement lifecycle).

The complete Placement lifecycle now executes from real test content — author a test (listening with audio+transcript+MCQ/short-answer, reading passage, writing essay, speaking prompt), configure a `content_test` profile, start an attempt (immutable snapshot), submit candidate answers (server auto-scoring for MCQ/short-answer, bounded manual scoring for essay/speaking), complete the attempt (weighted total → placement rule → recommended level → visitor completed + history), with replay/concurrency safety, branch isolation, answer-key secrecy, score-manipulation guards, historical immutability, and a full audit trail. Everything is verified by 515 server tests (49 files), fresh-schema parity, and a 29/29 live E2E against the running server, and the implementation is committed (`3690bca`) and pushed.

Caveats that keep this from "production perfect": speaking audio capture/upload, a rubric-driven essay UI, and a standalone test-bank management screen are future enhancements (see §8).

---

## 10. Continuation

- **Phase 2 (recommended):** candidate self-service surface (secure, rate-limited response submission tied to a one-time attempt token), plus audio-upload handling for speaking.
- **Phase 3 (recommended):** rubric-based essay grading UI with per-criterion scores stored in `payload_json`/feedback; score history chart in the reporting module.
- **Hardening:** load-test concurrent response submissions at scale (SQLite `busy_timeout` behavior under parallel upserts is covered by the atomicity test but not by a high-concurrency benchmark).
- **Keep the pattern:** any future placement change must re-run `placement-content-lifecycle.test.ts` and the live E2E script (`/tmp/live_placement_e2e.mjs` pattern; port it into the repo's scripts/ when a permanent harness is wanted).
