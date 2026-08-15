# Teacher/Instructor Subsystem — Forensic Discovery (Phase 1–2)

**Date:** 2026-08-15 · Base `1b275cb`. No code modified during discovery.

## A. Complete architecture map (FACT, verified against live DB + source)

### Database (teacher-domain tables)
| Table | Purpose | Key columns |
|---|---|---|
| `teachers` | Teacher master | `base_salary, salary_type CHECK (5 values), performance_score, status (active/inactive/on_leave), branch_id, joined_date, contract_type CHECK (monthly/hourly/per_session — legacy secondary field), default_skill_rate, user_id` |
| `teacher_compensation_history` | Period-correct compensation snapshot | `effective_from, base_salary, salary_type, contract_type, default_skill_rate, reason, operator_user_id` (no CHECK on salary_type) |
| `teacher_level_skill_rates` | Per-level skill rates | `level_id, level_code, skill_id, rate_per_skill, branch_id` |
| `class_teacher_skills` | **The Skill record (source of truth for skills)** | `class_id, teacher_id, skill_id, monthly_rate, branch_id, assignment_type CHECK (primary/assistant/substitute/guest/examiner), start_date, end_date, reason, session_id, UNIQUE(class_id,teacher_id,skill_id,session_id)` |
| `skills` | Skill catalog | `id, name` |
| `sessions` | Teaching activity | `class_id, date, start_time, end_time, status, teacher_id, skill_id, branch_id, session_type` |
| `teacher_salary_ledger` | Payroll ledger | `period_key, period_label, due_amount, paid_amount, payment_type, transaction_id, idempotency_key, status (posted/voided)` |
| `teacher_branch_history` | Branch transfers | `from_branch_id, to_branch_id, effective_date` |
| `teacher_evaluations` | 100-point evaluations | `score, criteria, date` |
| `attendance`, `classes`, `programs`, `levels`, `budget_lines`, `financial_transactions`, `audit_logs` | supporting | — |

### Backend
- `routes/teachers.routes.ts` (557 lines): teacher CRUD, transfer, deactivate, evaluation, `computed-salary`, compensation-history, `salary-status`, `pay-salary` (idempotent, budget+ledger+transaction), void.
- `routes/skills.routes.ts`: skill catalog + `class-teacher-skills` assignment CRUD (manager/HOD only, branch-scoped, max-3-skills-per-class, duplicate protection).
- `routes/classes.routes.ts`, `routes/sessions.routes.ts`: class/session generation referencing class skills.
- `core/payroll/class-payroll.ts`: `computeTeacherDueAmount` — the authoritative salary calculator.
- `routes/reports.routes.ts`: **no teacher skill/payroll report endpoint found** (grep empty).

### Skill lifecycle (Phase 3, FACT)
- A Skill = a `class_teacher_skills` row (teacher → class → skill). Sessions reference class skills via `skill_id` but do NOT create skills.
- Skills are **manually assigned** (manager/HOD) per class; session generation pulls from configured class skills.
- Multiple skills per teacher/month: yes (multiple CTS rows; payroll counts them).
- Associated with class, skill, branch, dates (start/end), optionally session; NOT directly with course/program/level — but classes carry `level`, programs/versions are reachable via class.
- Correction: PUT (rate/type/dates); delete: DELETE (both manager/HOD, audited).
- Duplicate protection: app-level + `UNIQUE(class_id,teacher_id,skill_id,session_id)`.
- Branch isolation: assignment/teacher/class branch checks (403).
- Audit: `writeAudit` on create/update/delete; pay-salary audited.

## B. The FIVE contract types (authoritative — `teachers.salary_type` CHECK, migration 029 + schema.sql; migration 024 comment: "fixed | per_skill | hybrid | per_level")

| # | DB value | Business meaning | Salary formula (class-payroll.ts) | Skill behavior (current) |
|---|---|---|---|---|
| 1 | `fixed` | Fixed monthly salary | `base_salary × performanceMultiplier` | **BLOCKED from primary/assistant skill assignments (409)** + hidden in UI |
| 2 | `per_skill` | Paid per skill | `Σ(class assignment rate × enrollMult × perfMult)`; base 0 | Allowed |
| 3 | `per_session` | Paid per completed session | `completedSessions × (default_skill_rate or base/20) × perfMult` | Allowed (rate required) |
| 4 | `hybrid` | Fixed base + skill component | **NOT HANDLED → due = 0** (engine only matches `hybrid_skill`/`hybrid_level`) | Allowed by the gate (not fixed), but unreachable |
| 5 | `per_level` | Paid per level | level-specific rate (`teacher_level_skill_rates` or rule engine) | Allowed |

## C. Defects found (to reproduce with executable tests before fixing)

| ID | Defect | Location | Violation |
|---|---|---|---|
| D1 | **Fixed teacher cannot be assigned a skill** (primary/assistant) → 409 "Change salary model to per_skill, hybrid, or per_level" | `skills.routes.ts:170` | Contract type controls Skill recording — the exact anti-pattern the directive forbids |
| D2 | UI hides fixed teachers from skill assignment (`t.salaryType !== 'fixed'`) + message "fixed monthly contract can't take skill rates" | `ClassesView.tsx:275,1106` | Frontend/backend both gate Skills on contract |
| D3 | **Hybrid contract unreachable**: API `ALLOWED_SALARY_TYPES = ['fixed','per_skill','per_level','per_session','hybrid_skill','hybrid_level']` (6) vs DB CHECK `[fixed,per_skill,per_session,hybrid,per_level]` (5). Sending `hybrid` → 400 "Invalid salary type"; sending `hybrid_skill` → DB CHECK failure. No hybrid teacher can be created. | `teachers.routes.ts:98` | Type drift; the DB's 4th type cannot be stored |
| D4 | Payroll engine `TeacherSalaryModel` union lacks `hybrid`; `model==='hybrid'` falls through with no matching rate branch → `due = 0` | `class-payroll.ts:23,262+` | Hybrid compensation broken |
| D5 | Frontend salary-type dropdowns offer `hybrid_skill`/`hybrid_level` (unstoreable) and omit `hybrid` | `TeachersView.tsx:322`, `TeachersModals.tsx:163-167`, `TeacherDirectoryPanel.tsx:61-65` | UI cannot create the DB's 4th type |
| D6 | Fixed teacher `skillCount` (computed-salary) = 0 because assignments can't exist | `teachers.routes.ts:283` | Consequence of D1 |
| D7 | No target-skills config; no skills workload report endpoint (Phase 7/10 requirement) | — | Config data + reporting gap |
| D8 | Rate required for primary/assistant even for fixed/per_session teachers whose pay ignores the rate (friction; and PUT re-validates with no teacher lookup) | `skills.routes.ts:184,244` | Minor; to relax for fixed only |

## D. What is CORRECT (no change needed)
- Fixed payroll ignores skills (`model==='fixed'` returns base only; skillsTotal 0) — the core rule "30,000 + 15 skills ≠ 30,000 + 15×rate" is already correct.
- Duplicate protection (app + UNIQUE), max-3-skills-per-class, branch isolation, audit, idempotent pay-salary with budget/ledger/transaction, compensation history period-correctness, per-period session counting.
- Terminology: the system uses **Skill** everywhere (no "Scale" found in the teacher domain).
