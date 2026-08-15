# Teacher/Instructor Subsystem — Forensic Audit & Correction Report

**Date:** 2026-08-15 · Branch `arena/01a003cd-toefl-house` · Commits `759a2bc` (fixes) + discovery doc
**Process:** discovery → reproduce-with-executable-evidence → smallest robust fixes → regression matrix → full suite → live E2E.

---

## 1. Complete Teacher architecture map (FACT)

### Database
| Table | Role | Key columns |
|---|---|---|
| `teachers` | Teacher master | `base_salary, salary_type CHECK (fixed,per_skill,per_session,hybrid,per_level), performance_score, status, branch_id, joined_date, contract_type CHECK (monthly/hourly/per_session — legacy secondary), default_skill_rate, target_skills_per_month (new)` |
| `teacher_compensation_history` | Period-correct compensation snapshot | `effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason` |
| `teacher_level_skill_rates` | Per-level skill rates | `level_code, skill_id, rate_per_skill, branch_id` |
| `class_teacher_skills` | **The Skill record (source of truth)** | `class_id, teacher_id, skill_id, monthly_rate, assignment_type CHECK (primary/assistant/substitute/guest/examiner), start_date, end_date, session_id, UNIQUE(class_id,teacher_id,skill_id,session_id)` |
| `skills` | Skill catalog | `id, name` |
| `sessions` | Teaching activity | `date, teacher_id, skill_id, status, branch_id` |
| `teacher_salary_ledger` | Payroll ledger | `period_key, due_amount, paid_amount, transaction_id, idempotency_key, status` |
| `teacher_branch_history`, `teacher_evaluations`, `classes`, `budget_lines`, `financial_transactions`, `audit_logs` | supporting | — |

### Backend / Frontend
- `routes/teachers.routes.ts` — teacher CRUD, transfer, evaluation, `computed-salary`, compensation history, `pay-salary` (idempotent: budget line + ledger + financial transaction), void, **`skills-report` (new)**.
- `routes/skills.routes.ts` — skill catalog + class-teacher-skill assignment CRUD (manager/HOD, branch-scoped, max-3-skills-per-class, duplicate protection).
- `routes/classes.routes.ts`, `routes/sessions.routes.ts` — class/session generation referencing class skills.
- `core/payroll/class-payroll.ts` — authoritative salary calculator.
- Frontend: `TeachersView`, `TeachersModals`, `TeacherDirectoryPanel`, `ClassesView` (skill assignment), `TeacherProfileDrawer`.

### Skill lifecycle (FACT)
Skill = a `class_teacher_skills` row (teacher → class → skill). Manually assigned by manager/HOD; sessions reference class skills. Multiple skills per teacher/month: yes (payroll counts them). Correction/delete: PUT/DELETE (audited). Duplicate protection: app-level + UNIQUE. Branch isolation: teacher/class/assignment branch checks (403). Audit: create/update/delete + pay-salary write `audit_logs`. Source of truth is `class_teacher_skills` — no second skill system exists.

## 2. The exact five contract types (FACT — `teachers.salary_type` CHECK, migration 029 + schema.sql)

| # | DB value | Business meaning |
|---|---|---|
| 1 | `fixed` | Fixed monthly salary |
| 2 | `per_skill` | Paid per skill assignment |
| 3 | `per_session` | Paid per completed session |
| 4 | `hybrid` | Fixed base + skill component |
| 5 | `per_level` | Paid per level (level-specific rate) |

(Found also: a stale `contract_type` field `monthly/hourly/per_session` — legacy secondary; a stale draft's `hybrid_skill`/`hybrid_level` values existed in the API/UI/payroll but were never storable in the DB CHECK — corrected to `hybrid`.)

## 3. Exact compensation rule for each (FACT — `computeTeacherDueAmount`)

| Type | Rule | Fixed component | Skill component |
|---|---|---|---|
| `fixed` | `base_salary × perfMultiplier` | base | **0 — skills are workload only** |
| `per_skill` | `Σ(class monthly_rate × enrollMult × perfMult)` | 0 | all |
| `per_session` | `completedSessions × rate × perfMult` (rate = default_skill_rate or base/20) | 0 | sessions |
| `hybrid` | `base_salary × perfMult + Σ(rate × enrollMult × perfMult)` | base | skills |
| `per_level` | level rate from `teacher_level_skill_rates` (or rule engine) × assignments | 0 | all |

## 4. Exact Skill lifecycle (FACT)
Assignment (manager/HOD) → optional session-scoped override → payroll aggregation (period-filtered by assignment `start_date/end_date` and class dates) → workload report. Skills are **never** created or hidden by contract type. Fixed teachers' skills feed workload/reporting only.

## 5. Defects discovered (FACT — reproduced before fixing)
| ID | Defect | Evidence (pre-fix) |
|---|---|---|
| D1 | **Fixed teacher cannot be assigned a skill** — 409 "Change salary model to per_skill, hybrid, or per_level" | `[EVIDENCE-D1] fixed teacher skill assignment status: 409 …` |
| D2 | UI hides fixed teachers from skill assignment (`salaryType !== 'fixed'`) + message "can't take skill rates" | `ClassesView.tsx:275,1106` |
| D3 | **Hybrid unreachable**: API accepted `hybrid_skill/hybrid_level` (6 values) which the DB CHECK rejects; DB's `hybrid` was rejected as "Invalid salary type" | `[EVIDENCE-D3] hybrid create status: 400 {"error":"Invalid salary type."}` |
| D4 | **Hybrid payroll = 0** (engine only matched hybrid_skill/hybrid_level) | `[EVIDENCE-D4] hybrid due: {"model":"hybrid","due":0,"base":0,"skillsTotal":0,...baseRate:0}` |
| D5 | Frontend salary-type dropdowns offered unstoreable `hybrid_skill`/`hybrid_level`, omitted `hybrid` | `TeachersView:322`, `TeachersModals`, `TeacherDirectoryPanel` |
| D6 | Fixed teacher `skillCount` always 0 (consequence of D1) | `[EVIDENCE-D6] fixed due: … skillCount:15` after direct insert |
| D7 | No configurable workload target; no skills workload report | grep: no report endpoint |
| D8 | Rate required for primary/assistant even for fixed (whose pay ignores it); PUT validated rate with no teacher lookup | `skills.routes.ts:184,244` |
| D9 | **Schema parity bug**: `schema.sql` (fresh install) had a 6-value CHECK (`hybrid_skill/hybrid_level`) while migration 029/live DB has the 5-value CHECK — fresh-install ≠ upgraded-install | schema.sql vs live PRAGMA |

## 6. Reproduction evidence
`server/src/tests/teacher-skill-gap.test.ts` — 4 tests asserted the CORRECT behavior and failed on current code with `[EVIDENCE-*]` output (captured above). All 4 pass after the fix (converted to closed-state regression).

## 7. Root causes
- The original design conflated "compensation model" with "teaching eligibility": the assignment route explicitly gated primary/assistant skills on `salary_type !== 'fixed'`, and the UI mirrored it.
- A draft that split `hybrid` into `hybrid_skill`/`hybrid_level` drifted into the API/UI/payroll but never into the DB CHECK — leaving `hybrid` uncreatable AND unpayable.
- schema.sql (fresh path) kept the stale 6-value CHECK while migration 029 (upgrade path) rebuilt to 5 — a parity defect.

## 8. Exact fixes
1. `skills.routes.ts`: removed the fixed gate; rate required only for pay models; PUT looks up the teacher for the same rule.
2. `teachers.routes.ts`: `ALLOWED_SALARY_TYPES = [fixed, per_skill, per_session, hybrid, per_level]`; legacy `hybrid_skill`/`hybrid_level` → normalized to `hybrid`.
3. `class-payroll.ts`: `hybrid` model implemented (base + skill component); legacy aliases normalized; `TeacherSalaryModel` union corrected.
4. `schema.sql`: teachers CHECK corrected to the 5-value authoritative set (fresh-install parity).
5. `target_skills_per_month` (migration 059) + API + computed-salary + `GET /api/teachers/skills-report?month=YYYY-MM`.
6. Frontend: removed the fixed filter in `ClassesView`; dropdowns use the five DB values; target input in create/edit forms; types updated.

## 9. Database / migration changes
- Migration `059_teacher_target_skills.sql`: `ALTER TABLE teachers ADD COLUMN target_skills_per_month INTEGER` (configurable workload target; never changes salary).
- `schema.sql`: teachers CHECK → `('fixed','per_skill','per_session','hybrid','per_level')` + `target_skills_per_month` column. Fresh-schema preflight PASS; migration applied live at boot.

## 10. Backend changes
See §8. New endpoint: `GET /api/teachers/skills-report?month=YYYY-MM` (Payroll.View/Teacher.View, branch-scoped): per-teacher contractType, fixedSalary, skillRate, targetSkills, actualSkills (period-active primary/assistant assignments), shortfall, excess, skillEarnings, fixedComponent, totalPayroll. `computed-salary` now also returns contractType/fixedSalary/skillRate/target/actual/shortfall/excess.

## 11. Frontend changes
`ClassesView` (fixed teachers eligible for skills; message corrected), `TeachersView`/`TeachersModals`/`TeacherDirectoryPanel` (five salary types + Hybrid label; target-skills input), `types.ts`/`apiStore.ts`/`App.tsx` signatures.

## 12. Payroll / finance impact
- Fixed: 30,000 stays 30,000 with 0/1/15/20 skills — **no double-count, no skill multiplication** (verified F/G tests + live).
- per_skill: due = skills × rate (0/1/15/20 verified).
- hybrid: due = base + skills × rate (0/1/15/20 verified; was 0 before the fix).
- pay-salary unchanged but now exercised for fixed+skills: full pay = 30,000; duplicate pay rejected (idempotency + ledger); budget line + financial transaction single per period.

## 13. Reporting impact
New skills workload report separates Fixed Salary / Target Skills / Actual Skills / Skill Rate / Skill Earnings / Shortfall / Excess / Total Payroll per teacher, with branch/program/level/month via the report row + class linkage. Fixed teachers' skills are visible (never hidden).

## 14. Security / RBAC matrix
| Surface | Result |
|---|---|
| Skill creation/modification/deletion | manager/HOD only (403 for registrar) — PASS |
| Cross-branch skill assignment | 403 — PASS |
| Cross-teacher manipulation | assignment bound to teacher + branch — PASS |
| Teacher self-access | teachers routes require Teacher.*/Payroll.* permissions — PASS |
| Skill mutations audited | create/update/delete/pay write audit_logs — PASS |
| Payroll idempotency | idempotency-key + ledger + status guard — PASS |

## 15. Regression test matrix (server/src/tests/teacher-skill-contract.test.ts — 13 tests)
| Contract | Skill Creation | Skill Reporting | Payroll | Fixed Component | Skill Component |
|---|---|---|---|---|---|
| fixed | TEST ✓ | TEST ✓ (report + computed-salary) | TEST ✓ (0/1/15/20 → 30,000) | TEST ✓ | TEST ✓ (=0) |
| per_skill | TEST ✓ | TEST ✓ | TEST ✓ (0/1/15/20 → n×1500) | — | TEST ✓ |
| per_session | TEST ✓ | TEST ✓ | TEST ✓ (2 sessions × 1000) | — | TEST ✓ |
| hybrid | TEST ✓ | TEST ✓ | TEST ✓ (0/1/15/20 → 20000+n×1500) | TEST ✓ | TEST ✓ |
| per_level | TEST ✓ | TEST ✓ | TEST ✓ (level rate 2500 wins) | — | TEST ✓ |

Plus: legacy alias normalization, duplicate rejection, branch isolation + RBAC, pay idempotency, period correctness (2024-01 vs 2025-07), skills-report fields, five-value schema assertion.

## 16. Full test results
- **Full server suite: 55 files / 562 tests PASS** (baseline 53/545; +2 files/+17 tests).
- Typecheck (server + frontend) PASS · ESLint (both) PASS · `vite build` PASS · `preflight:fresh-schema` PASS · migration 059 applied live at boot PASS.

## 17. Live E2E results
- **Teacher E2E: 21/21 PASS** — all five contract types created via API with target; fixed teacher assigned 15 skills (previously 409) → due=30,000, skills=15, target=15, shortfall=0, skillEarnings=0; hybrid → base 30,000 + skills 4,500 = 34,500; per_skill → 1,500; skills-report row for fixed correct; pay full 30,000 then duplicate rejected; legacy hybrid_skill → hybrid.
- Placement E2E (29/29) and Placement-Engine E2E (31/31) unchanged — no regressions.

## 18. Financial reconciliation
Fixed teacher: ledger due=30,000, paid=30,000, 1 ledger row, 1 financial transaction, budget decremented by 30,000 — skills never added. per_skill/hybrid earnings derive exclusively from `class_teacher_skills` (authoritative source) at the configured rates; pay-salary rejects anything beyond remaining due; duplicate pay blocked by ledger + status guard.

## 19. FACT / INFERENCE / UNVERIFIED classification
- FACT: five contract types; per-type payroll formulas; fixed gate (D1) + UI filter (D2) + hybrid uncreatable/unpayable (D3/D4/D5) + schema parity (D9) — all reproduced with executable evidence; fixed salary independent of skills; period-correct skill counting; idempotent pay.
- INFERENCE: "fixed teacher with 30,000 ≈ 15 skills/month" is a business expectation — implemented as configurable `target_skills_per_month` (no hard-coded 30,000→15 mapping); hybrid semantics (base + per-skill at class/default rate) inferred from migration 024's comment and the engine's hybrid_skill math.
- UNVERIFIED: browser-level visual E2E of the new UI fields; rubric/reporting beyond the new endpoint; a scheduled monthly payroll closer.

## 20. Remaining risks
1. **Target skills is a current-value column**, not period-versioned: changing it later doesn't rewrite past skills (skills stay period-correct), but historical *targets* are not snapshotted. A `teacher_workload_targets` history table is the future increment.
2. **per_session skill assignments are workload-only** (rate optional); if the business later wants per-session skill rates to count, the engine needs a dedicated branch (currently sessions × rate, not session-skills × rate).
3. **Frontend visual E2E** of the new dropdowns/target inputs is not headless-browser tested (API-level coverage only).
4. **Contract-type change history** is preserved via `teacher_compensation_history`; changing contract later does not rewrite past skills or past payroll (verified by the period test), but a dedicated "contract change does not mutate historical skills" test on the API path is recommended next.
5. Legacy `contract_type` (monthly/hourly/per_session) remains as a secondary field — kept for compatibility; only `salary_type` drives payroll.
