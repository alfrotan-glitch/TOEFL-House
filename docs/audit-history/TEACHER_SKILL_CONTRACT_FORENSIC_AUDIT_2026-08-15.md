# Teacher / Contract / SKILL — Complete Forensic Audit & Correction
**Date:** 2026-08-15
**Scope:** Teacher → Contract → Class → Session → Skill → Payroll → Finance → Report
**Branch:** `arena/01a0062e-toefl-house`
**Terminology:** the correct term throughout is **SKILL** (never "Scale").

---

## 0. Executive summary

The audit found and fixed the reported defect **plus three deeper defects that
were its root cause or close relatives**.

| # | Defect | Severity | Status |
|---|---|---|---|
| D1 | Fixed-contract teachers were **rejected** when recording a Skill (HTTP 409) | **CRITICAL** | FIXED |
| D2 | The **frontend hid every fixed teacher** from the Skill-assignment list | **CRITICAL** | FIXED |
| D3 | **Contract vocabulary mismatch**: application used 6 values, the database CHECK allowed a *different* 5 — two contract types were physically unstorable | **CRITICAL** | FIXED |
| D4 | Payroll **silently paid 0** for `hybrid` and never reported Skill workload for fixed/per-session teachers | **HIGH** | FIXED |
| D5 | No concept of a **Skill target / shortfall / excess** existed | MEDIUM (gap) | IMPLEMENTED |
| D6 | Skills could be recorded for an **inactive teacher** | MEDIUM | FIXED |

**Result:** 585 backend tests pass (545 pre-existing + 40 new), frontend and
backend typecheck and build clean, migrations verified idempotent on an
existing database, and live E2E against a running server confirms all five
contract types record Skills with correct pay.

---

## 1. Complete Teacher architecture map

```
WORKLOAD (what the teacher actually teaches)
  teachers
    └── class_teacher_skills   ← THE SKILL RECORD (source of truth)
          ├── class_id  → classes → level / program / offering
          ├── skill_id  → skills  (Reading / Writing / Listening …)
          ├── session_id (NULL = class-scoped; set = one-off e.g. substitute)
          ├── assignment_type: primary | assistant | substitute | guest | examiner
          ├── monthly_rate, start_date, end_date, branch_id
          └── UNIQUE(class_id, teacher_id, skill_id, session_id)
    └── sessions (teacher_id, skill_id, date, status)  ← teaching activity

COMPENSATION (how the teacher is paid) — INDEPENDENT
  teachers.salary_type (the contract type)
    └── teacher_compensation_history  (effective-dated, immutable history)
    └── teacher_level_skill_rates     (per-level / per-skill rates)
    └── core/payroll/class-payroll.ts → computeTeacherDueAmount()
          └── teacher_salary_ledger  → financial_transactions → budget_lines
```

Supporting tables: `teacher_branch_history` (period-correct branch),
`teacher_evaluations` (performance multiplier), `audit_logs`.

**Backend:** `routes/teachers.routes.ts`, `routes/skills.routes.ts`,
`routes/sessions.routes.ts`, `core/payroll/class-payroll.ts`.
**Frontend:** `TeachersView`, `TeachersModals`, `TeacherDirectoryPanel`,
`TeacherProfileDrawer`, `ClassesView` (Skill assignment UI).

---

## 2. The five contract types — **discovered, not assumed**

Discovered by dumping the DDL of the *live migrated* database (not from
`schema.sql`, which had drifted). Authoritative source is the CHECK
constraint created by **migration 029**:

```sql
salary_type TEXT NOT NULL DEFAULT 'fixed' CHECK (salary_type IN (
  'fixed','per_skill','per_session','hybrid','per_level'
))
```

| # | DB value | Business meaning | Salary formula | Skill behaviour |
|---|---|---|---|---|
| 1 | `fixed` | Fixed monthly salary | `base_salary × perfMultiplier` | **Recorded & reported; adds no pay** |
| 2 | `per_skill` | Paid per Skill taught | `Σ(skill rate × enrolMult × perfMult)` | Recorded; **drives pay** |
| 3 | `per_session` | Paid per completed session | `completedSessions × sessionRate × perfMult` | Recorded & reported; pay from sessions |
| 4 | `hybrid` | Fixed base **plus** Skill pay | `base×perfMult + Σ skill rates` | Recorded; **partly drives pay** |
| 5 | `per_level` | Paid per Skill at level-specific rates | `Σ(levelRate(level,skill) × mult)` | Recorded; **drives pay** |

> `teachers.contract_type` (`monthly`/`hourly`/`per_session`) is a **separate,
> pre-existing HR/engagement field**, not the compensation model. It was left
> untouched.

### D3 — the vocabulary mismatch (root cause of much confusion)

`schema.sql` and all application code used
`fixed | per_skill | per_session | hybrid_skill | hybrid_level | per_level`,
but migration 029 (which runs *after* schema.sql and rebuilds the table) allows
`… | hybrid | …`. **Proven** by direct insertion:

```
STORED OK : fixed / per_skill / per_session / hybrid / per_level
REJECTED  : hybrid_skill  -> CHECK constraint failed
REJECTED  : hybrid_level  -> CHECK constraint failed
```

Consequence: the UI offered "Hybrid Skill"/"Hybrid Level", which could never be
saved, while the *storable* `hybrid` was unknown to the payroll engine and
**fell through every branch to pay 0**:

```
hybrid  model=hybrid  due=0  base=0  skillsTotal=0     ← before fix
```

---

## 3. Skill lifecycle (as it actually is)

1. **Creation** — manual, via `POST /api/class-teacher-skills`
   (manager / head_of_department only). Not auto-generated from attendance.
2. **Association** — class → level/program; skill; optional session; branch;
   optional `start_date`/`end_date` (this is the period anchor).
3. **Correction** — `PUT /api/class-teacher-skills/:id`; deletion via `DELETE`.
4. **Aggregation** — per period by `computeTeacherDueAmount()`.
5. **Payroll/report** — only where the contract rule says so.

Answers to the audit's explicit questions: multiple Skills per month **yes**;
associated with course/program/level **via class**; duplicate protection
**yes** (unique index + app-level check); branch isolation **yes**; audit
logging **yes**; single source of truth **`class_teacher_skills`** — no second
Skill system was created.

---

## 4. Defects, evidence, root causes, fixes

### D1 — Fixed contract blocked Skill creation (CRITICAL)
**Evidence (before):**
```
POST /api/class-teacher-skills  {salaryType: fixed}
HTTP 409 "This teacher has a fixed monthly contract. Change salary model to
          per_skill, hybrid, or per_level to assign ongoing skill rates."
```
**Root cause:** `skills.routes.ts:170` treated the contract type as a Skill
*eligibility* rule.
**Fix:** removed the contract-type gate entirely. A rate is now required only
when the contract actually pays per Skill (`contractPaysPerSkill()`), so a
fixed teacher legitimately records a Skill at rate 0.

### D2 — Frontend hid fixed teachers (CRITICAL)
**Root cause:** `ClassesView.tsx:275` — `teachers.filter(t => t.salaryType !== 'fixed')`.
**Fix:** eligibility is now `t.status === 'active'`, matching the backend rule.

### D3 — Contract vocabulary mismatch (CRITICAL)
**Fix:** single source of truth `CONTRACT_TYPES` exported from the payroll
engine and consumed by routes; `schema.sql` corrected to the five values;
frontend `TEACHER_CONTRACT_TYPES` mirrors it; migration **059** normalises any
legacy rows (`hybrid_skill → hybrid`, `hybrid_level → per_level`) and
`normalizeContractType()` keeps legacy data computing instead of paying 0.

### D4 — Payroll ignored `hybrid`; workload invisible (HIGH)
**Fix:** `hybrid` handled explicitly (fixed component **and** Skill component
separately visible); every model now returns `skillCount`, so Skills are never
hidden by contract type.

### D5 — No Skill target (gap)
**Fix:** configurable `teachers.target_skills_per_month` (**not** a hard-coded
"30,000 → 15"), surfaced as `targetSkills / shortfall / excess`. It never
changes pay.

### D6 — Inactive teachers could receive Skills
**Fix:** explicit employment-status check (400), which is a status rule, not a
contract rule.

---

## 5. Changes made

**Database** — `059_teacher_skill_contract_separation.sql` (new): normalises
legacy contract values, adds `target_skills_per_month` to `teachers` and
`teacher_compensation_history`, adds two workload indexes. `schema.sql`:
CHECK corrected to the five types + target column. *Data-preserving and
idempotent (verified).*

**Backend** — `core/payroll/class-payroll.ts`: `CONTRACT_TYPES`,
`normalizeContractType()`, `contractPaysPerSkill()`, `contractHasFixedComponent()`,
contract-independent workload counting, `hybrid` fixed, richer return type.
`routes/skills.routes.ts`: contract gate removed, status check added,
rate rule made contract-aware (POST **and** PUT). `routes/teachers.routes.ts`:
allowlist bound to `CONTRACT_TYPES`, target field wired through create/update,
`computed-salary` and `salary-status` now expose
`base / skillsTotal / skillCount / targetSkills / shortfall / excess`.

**Frontend** — shared `TeacherContractType`; five-type dropdowns/labels;
eligibility filter fixed; new **Skill Workload** panel in the salary modal
showing actual vs target with an explicit note for fixed contracts.

---

## 6. Test results

| Suite | Result |
|---|---|
| Backend regression (`npm test`) | **585 passed / 54 files** (was 545/53) |
| New forensic suite | **40 passed** |
| Frontend typecheck / build | PASS |
| Backend typecheck / build | PASS |
| ESLint | PASS |
| Fresh-schema preflight | PASS |
| Migration idempotency on existing DB | PASS (data preserved) |

### Regression matrix (all five contract types)

| Contract | Skill creation | Skill reporting | Payroll | Fixed component | Skill component |
|---|---|---|---|---|---|
| fixed | PASS | PASS | PASS (30,000 flat) | 30,000 | 0 |
| per_skill | PASS | PASS | PASS (Σ rates) | 0 | n × rate |
| per_session | PASS | PASS | PASS (sessions × rate) | 0 | session-derived |
| hybrid | PASS | PASS | PASS (base + Σ) | 30,000 | n × rate |
| per_level | PASS | PASS | PASS (level rate) | 0 | level-derived |

Also covered: fixed/per_skill/hybrid at **0, 1, 15 and 20 Skills**;
period correctness (August ≠ July); contract change does not delete or rewrite
history; duplicate/double-click protection; RBAC; branch isolation; audit logs.

### Live E2E (running server, real HTTP)
```
E2E-2 FIXED teacher records a SKILL ............ HTTP 201  ← was 409
E2E-3 duplicate ................................ HTTP 409 (correctly blocked)
E2E-4 model=fixed due=30000 base=30000
      skillsTotal=0 skillCount=1 targetSkills=15 shortfall=14
E2E-5 fixed/per_skill/per_session/hybrid/per_level → SKILL=201 for all five
```

### Financial reconciliation
Fixed teacher, 30,000 AFG, **1 Skill recorded**: due 30,000 → paid 30,000 →
remaining 0; ledger `paid_amount` 30,000 == transaction amount 30,000
(`type=expense, category=salary`); second full payment correctly rejected
(409). **No Skill multiplication, no double-pay, no orphan transaction.**

---

## 7. Security / RBAC matrix

| Action | manager / HoD | registrar | other | Cross-branch |
|---|---|---|---|---|
| Create Skill | ALLOW | **403** | 403 | **403** |
| Update / delete Skill | ALLOW | 403 | 403 | **403** |
| View payroll | `Payroll.View` | — | — | scoped |
| Pay salary | `Payroll.Edit` | — | — | scoped |

Every Skill mutation writes an audit log (verified by test). Inactive teachers
cannot receive Skills. Budget guard blocks payroll without funds.

---

## 8. FACT / INFERENCE / UNVERIFIED

**FACT (proven by execution):** the five contract types and their CHECK
constraint; the 409 on fixed contracts; `hybrid_skill`/`hybrid_level` being
unstorable; `hybrid` paying 0 before the fix; all test/build/E2E results and
the financial reconciliation above; migration idempotency.

**INFERENCE (reasoned from code, business-confirmed by the brief):** that
`fixed` should record Skills without increasing pay, and that `hybrid` means
base + Skill component. Implemented exactly as the existing rules expressed
them — no formula was invented.

**UNVERIFIED / out of scope:** the intended semantics of the separate
`contract_type` (`monthly`/`hourly`/`per_session`) HR field; whether
`per_session` should also pay for Skills (left as-is — sessions are its
authoritative basis); two **pre-existing** audit-script failures
(`test-bank` navigation route and the static audit's auth-import heuristic),
both confirmed present before my changes and unrelated to this subsystem.

---

## 9. Remaining risks

1. **Rate 0 on fixed contracts is now permitted** — intended (workload without
   pay), but an operator could leave a rate at 0 for a *Skill-paid* contract by
   switching contract type afterwards; payroll then uses `default_skill_rate`.
   Mitigation: rate is still mandatory at creation for Skill-paid contracts.
2. **Target Skills is not yet effective-dated per period** — the column exists
   on compensation history for future use, but reporting reads the current
   teacher value.
3. Legacy databases containing `hybrid_skill`/`hybrid_level` are normalised by
   migration 059; any external integration writing those raw strings must be
   updated to the five-value vocabulary.
