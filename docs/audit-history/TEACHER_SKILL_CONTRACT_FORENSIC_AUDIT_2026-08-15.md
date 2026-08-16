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

---

# ADDENDUM — General System-Wide Audit (same day)

A second, **system-wide** pass was run across the whole ERP (not just the
Teacher subsystem). Four further defects were found, proven and fixed.

| # | Defect | Severity | Status |
|---|---|---|---|
| S1 | `schema.sql` drifted from the migrated schema — **11 columns** existed only after migrations, so a **fresh install would crash** on payroll/finance/placement queries | **CRITICAL** | FIXED |
| S2 | Payroll used **UTC** for "today" while the rest of the system writes **local** dates — off-by-one every evening in Kabul (UTC+04:30) | **HIGH** | FIXED |
| S3 | `Placement Test Bank` menu item had **no route** — users landed on "under development" although the full UI and API existed | **HIGH** | FIXED |
| S4 | Two **quality gates were themselves broken** (stale hard-coded list; drift-blind preflight), so they could not protect the codebase | MEDIUM | FIXED |

### S1 — schema.sql drift (fresh-install breaker)
**Evidence:** querying a `schema.sql`-only database failed on 4 tables:
```
BROKEN teacher_salary_ledger: no such column: idempotency_key
BROKEN expense_requests:      no such column: requester_user_id
BROKEN placement_assessment_profiles: no such column: components_json
BROKEN placement_rules:       no such column: conditions_json
```
All 11 columns are actively used by route code (10 usages of
`idempotency_key` alone). **Fix:** `schema.sql` synchronised with migrations
044/045/048/038/058, and `verify-fresh-schema.mjs` rewritten to *diff*
schema.sql against the fully-migrated shape — the old gate could never
detect this. Now: `Fresh schema preflight passed (58 migrations, no drift)`.

### S2 — UTC/local date split
**Evidence (time-independent):** at `2026-08-15T21:45Z` → Kabul local
`2026-08-16`, UTC `2026-08-15`. `gregorianToday()` (UTC) disagreed with
`today()` (local), so a class starting "today" was judged not yet
operational and silently dropped from payroll.
**Fix:** `gregorianToday()` now uses the local calendar, matching
`utils/ids.ts today()`. Regression test freezes the clock at 21:45 UTC and
**was verified to fail before the fix** (`expected '2026-08-15' to be '2026-08-16'`).

### S3 — orphaned navigation route
`TestBankAdminView.tsx` (297 lines, complete) was never imported by `App.tsx`.
The backend routers were mounted and working. **Fix:** lazy-imported and
routed. Live check: `/placement/test-bank`, `/placement/rubrics`,
`/placement/media` all return HTTP 200.

### S4 — broken quality gates
`high-assurance-static-audit.mjs` compared imports against a **hand-maintained**
export list that had rotted, so it flagged three *correct* exports
(`denyPermissionless`, `readSessionCookie`) as failures. **Fix:** the list is
now parsed from `middleware/auth.ts` via the TypeScript AST, so it cannot rot.

### Areas audited and found SOUND (no change made)
Authentication/authorisation on every endpoint (34 without an explicit authz
guard were verified — all authenticated, `/login` correctly public, profit
withdrawal owner-only); no SQL injection (all interpolation is on fixed
identifiers/placeholders); no hard-coded secrets; no `password_hash` leakage;
atomic transactions on multi-write operations; all async handlers wrapped in
`ah()`; branch isolation via `resolveBranchScope`; `addDays`/`periodEnd`
date maths (including leap years) verified correct.

### Final verification (addendum)
| Gate | Result |
|---|---|
| Backend tests | **591 passed / 55 files** (+6 new guards) |
| Frontend + backend typecheck | PASS |
| Frontend + backend build | PASS |
| ESLint | PASS |
| `audit:product` | **PASS** (was FAIL) |
| `audit:static` | **PASS** (was FAIL) |
| Fresh-schema preflight | **PASS, no drift** (gate strengthened) |
| Live E2E | Test Bank + payroll endpoints healthy |

New regression file `system-integrity-guards.test.ts` locks in all three
structural invariants; each guard was verified to **fail** when its defect was
temporarily re-introduced.

---

# ADDENDUM 2 — Hijri Shamsi (Afghan Solar) Calendar

Afghanistan's official calendar is **Hijri Shamsi**. The ERP had **no** support
for it: dates were Gregorian everywhere and payroll periods were Gregorian
months.

## Architecture (agreed with the product owner)

| Decision | Choice |
|---|---|
| Storage | **Gregorian `YYYY-MM-DD` retained**; conversion happens only at the edges |
| Payroll periods | **Shamsi months** (e.g. `1405-05` = اسد ۱۴۰۵) |
| Display | **Shamsi primary, Gregorian shown alongside** during the transition |

**Why keep Gregorian in the database:** 77+ SQL queries depend on `YYYY-MM-DD`
sorting chronologically and on SQLite's own `date()`/`datetime()` functions.
Storing Shamsi would require rewriting all of them, migrating every existing
row, and replacing SQLite's date functions — high risk for zero functional
gain. Converting at the edge is the standard approach and leaves the financial
core untouched.

**Afghan, not Iranian:** Afghanistan uses the same solar calendar as Iran but
**different month names** (حمل/ثور/جوزا/سرطان/اسد/سنبله/میزان/عقرب/قوس/جدی/دلو/حوت).
The month names are therefore explicit in the module rather than delegated to
`Intl`, which would emit Iranian names (مرداد instead of اسد) for `fa-IR`.

## What was built

- **`src/utils/jalali.ts`** (mirrored to `server/src/utils/jalali.ts`) —
  conversion, formatting, Persian/Latin digits, Shamsi period helpers.
  A test asserts the two copies stay byte-identical, so they cannot drift.
- **`ShamsiDate` / `ShamsiDateCompact`** — display components (Shamsi + Gregorian).
- **`ShamsiDateInput`** — day/month/year picker in Shamsi that emits the
  Gregorian ISO string the API expects. Day count respects the real month
  length (Hut = 29 or 30 depending on the leap year).
- **Payroll engine** — periods are Shamsi months resolved to their exact
  Gregorian span via `jalaliMonthToGregorianRange()`.
- **`toPeriodKey()`** — accepts `1405-05`, `اسد ۱۴۰۵`, `Asad 1405` **and**
  legacy `2026-08` / `August 2026`, converting the latter rather than failing.

### A subtle break caught during implementation
The per-session query used `date LIKE 'YYYY-MM%'`. With a Shamsi period key
(`1405-05`) matched against Gregorian `sessions.date`, that prefix can never
match — **every per-session teacher would silently be paid 0**. Replaced with
a `BETWEEN periodStart AND periodEnd` range over the converted span.

## Verification

- Conversion checked against Node's **ICU Persian calendar for all 20,454 days
  from 1990 to 2045 — zero mismatches**, plus a clean round trip.
- Shamsi month spans verified **contiguous with no gaps or overlaps** across a
  full year; leap years cross-checked against real 365/366-day year lengths.
- Nawroz boundary verified: `1 حمل 1405` = `2026-03-21`.
- **608 backend tests pass** (56 files; +17 calendar tests).
- Typecheck, lint, builds, fresh-schema preflight: all PASS.

### Live E2E
```
month=1405-05    -> periodKey=1405-05  label=اسد ۱۴۰۵  due=30000
month=اسد 1405   -> periodKey=1405-05  label=اسد ۱۴۰۵  due=30000
month=Asad 1405  -> periodKey=1405-05  label=اسد ۱۴۰۵  due=30000
month=2026-08    -> periodKey=1405-05  label=اسد ۱۴۰۵  due=30000   (legacy input converted)
month=rubbish    -> HTTP 400 rejected
ledger : {period_key: '1405-05', period_label: 'اسد ۱۴۰۵', paid_amount: 30000}
tx desc: Paid full salary for اسد ۱۴۰۵ to teacher معلم تقویم شمسی
```

## Remaining work (not yet done)

Display conversion was applied to the **payroll/payslip flow** and the student
profile date. Roughly **20 other `toLocaleDateString` call sites** across
dashboards, sessions, workflows and reports still render Gregorian. They are
harmless (correct dates, wrong calendar) and can be migrated incrementally by
swapping in `<ShamsiDate />`. `ShamsiDateInput` is built and tested but not yet
substituted for the remaining `<input type="date">` fields.

---

# ADDENDUM 3 — Student Subsystem & Global Dashboard Forensic Audit

Audited against the **running API and live database**, not prior reports.
Method: discover → map → attack → prove → fix → regression → live-verify.

## Q. Defects reproduced (before any code change)

| # | Defect | Severity | Evidence |
|---|---|---|---|
| S1 | **Un-keyed payment requests duplicate money.** 10 concurrent `POST /students/:id/payments` → **10 payments, 10 income rows, 10,000 AFN** from a single 1,000 AFN intent | **CRITICAL** | `codes={201:10}`, `payments rows=10 sum=10000` |
| S2 | **Refunds duplicate.** 5 concurrent refunds → 5 rows, **−5,000 AFN** | **CRITICAL** | `refund rows=5 sum=-5000` |
| S3 | **Dashboard JOIN multiplication.** One 9,999 AFN payment reported as **19,998** when the student held 2 active semesters | **HIGH** | `Dup Class A 9999 + Dup Class B 9999` |
| S4 | **Outstanding ignores discounts.** Net fee 7,000, paid 4,000 → reported **6,000** instead of 3,000 (used gross `fee_amount`); also ignored `installment` payments | **HIGH** | `reported=6000 expected=3000` |

### Root causes
- **S1/S2:** `Idempotency-Key` was **opt-in**. Only ONE frontend call site sent one; `apiStore.recordFeePayment` sent none. `disabled={loading}` cannot survive refresh, retry, a second tab, or a direct API client.
- **S3:** `payments JOIN student_semesters ON student_id AND status='active'` fanned each payment across every active semester.
- **S4:** aggregate used `SUM(fee_amount)` (gross) and counted only `category='fee'`.

## Attacks that PASSED before any change (no false alarms raised)
Fixed-fee guards (`card`/`diploma`/`placement`), the two-writer card case (`issue-card` + manual), concurrent `issue-card` ×6, concurrent `enroll-semester` ×6, concurrent `enroll-class` ×5, and book-sale stock consistency were **already correct**. Only the genuinely broken paths were changed.

## S. Exact fixes

**`server/src/utils/idempotency.ts` (new).** Idempotency is now **always applied**. An explicit client key wins; otherwise a fingerprint is derived from the business intent (`route + student + category + amount + refs + method + actor`) within a **90-second window**, with the previous window also checked so a boundary-straddling retry still matches.

Two concepts kept deliberately separate:
- **Request idempotency** — collapses retries.
- **Business-event uniqueness** — "this fee is charged once", enforced by domain guards.

**Race safety:** the pre-check is only a fast path. The authoritative guarantee is the DB unique index `uq_payments_idempotency`; on `UNIQUE` violation the loser **replays the winner's receipt** instead of 500-ing or double-charging.

**Critical ordering correction found during regression:** a derived key must NOT short-circuit categories that own a business guard (`fee/installment/book/card/diploma/placement`) — replaying a stale success would mask actionable errors ("already fully paid", "diploma fee already recorded") and tell the operator a charge succeeded when it did not. Those categories rely on their guards + the unique index; derived keys are not persisted for them so a later legitimate charge cannot collide.

**Actor is part of the intent:** two different cashiers each recording the same amount are two real events, not a retry. Found because it broke `final-hardening`'s finance-then-manager refund test — a legitimate case my first design would have wrongly blocked.

**Dashboard (`bos.routes.ts`):** each payment is attributed to **exactly one** semester/class via a correlated subquery (matched on `payments.semester`); outstanding now uses `COALESCE(net_fee_amount, fee_amount)` and counts `('fee','installment')` with `status='completed'`.

**Frontend:** `apiStore.recordFeePayment` now sends a per-submission `Idempotency-Key`.

## T. Regression evidence — after fix

| Attack | Before | After |
|---|---|---|
| 10 concurrent un-keyed payments | 10 rows / 10,000 AFN | **1 row / 1,000 AFN** (`{201:1, 200:9}`) |
| **100** concurrent payments | (would be 100) | **1 row / 250 AFN** (`{201:1, 200:99}`) |
| 5 concurrent refunds | 5 rows / −5,000 | **1 row / −1,000** |
| Sequential double-click | 2 charges | 1 charge, same receipt |
| Dashboard revenue-by-class | 19,998 | **9,999 (= truth)** |
| Outstanding with discount | 6,000 | **3,000** |
| Audit rows for 5 clicks | 5 | **1** |

**Counter-invariants verified (no over-blocking):** two explicitly keyed identical payments both succeed; different amount/category are separate events; the derived key changes after the window; diploma double-charge still returns an actionable **409**.

**Tests genuinely catch the bugs** — reverting the fix produced `expected [ …(10) ] to have a length of 1 but got 10`.

## Full gate results

| Gate | Result |
|---|---|
| Backend tests | **622 passed / 57 files** (+14 new) |
| Frontend typecheck / lint / build | PASS |
| Backend typecheck / build | PASS |
| `audit:product` / `audit:static` | PASS |
| Fresh-schema preflight | PASS (58 migrations, no drift) |

**Financial reconciliation (live DB):** every category matches exactly between `payments` and `financial_transactions` (card 800, chapter 1500, diploma 500, exam 4750, fee 5000, other 29800); **0 payments without a ledger row**.

## U. PASS / FAIL / UNVERIFIED

**PASS:** duplicate-click protection; concurrent-request invariants; legitimate repeats preserved; business-event uniqueness; dashboard reconciliation for the two proven defects; audit trail (1 event per business action); payments↔ledger reconciliation; fresh-schema/migration agreement.

**UNVERIFIED (stated honestly):** exhaustive per-metric reconciliation of *every* dashboard tile (executive dashboard, marketing funnel, student analytics) — only the two proven-defective aggregates plus the finance dashboard's ledger-backed totals were mathematically verified; dashboard performance under production-scale data (no load test run); date/period boundary matrix beyond the Shamsi month spans already covered; multi-branch dashboard isolation (single-branch dataset in this environment).

## V. Remaining risks

1. **90-second window is a heuristic.** Two genuinely distinct, identical, un-keyed payments by the *same* operator for the *same* student within 90s collapse into one. Mitigation: the UI sends explicit keys, which always create distinct events. Tune `IDEMPOTENCY_WINDOW_SECONDS` if a real workflow needs faster repeats.
2. **Other money writers** (`books/:id/sell`, exam enrolment, teacher/employee payroll) were attacked and behaved correctly, but do **not** yet use the shared derived-key helper; they rely on their own guards. Extending the helper to them would make protection uniform.
3. Book sales write to `book_sales`, not `payments` — any reconciliation query must union both.

---
---

# ADDENDUM 4 — Student Subsystem & Global Dashboard: Final Forensic Closure

**Date:** 2026-08-15 · **Commits:** `d5b107c`, `6da49fe`, `61a5de6`
**Method:** discover → map → attack → reproduce → prove → fix → regression-test → mutation-test → live-verify.
No previous audit, PASS claim or test count was trusted; every verdict below rests on evidence produced against the live repository, database and running API in this session.

## A. Scope closed in this addendum

Addendum 3 left seven items UNVERIFIED. All seven are now resolved: invoice-pay duplicate behaviour, the invoice-create 500, donation duplication, visitor-convert's weak PASS, multi-branch dashboard isolation, the Shamsi date-input backlog, and uniform idempotency coverage across money writers.

## B. Defects reproduced and fixed in this pass

Each was reproduced by executable attack **before** any code changed.

### S6 — `POST /funding/donations` fabricated money · CRITICAL

| | |
|---|---|
| **Attack** | 8 concurrent un-keyed requests, one 5,000 AFN intent |
| **Before** | `{201: 8}` → **8 donations, 40,000 AFN, 8 income rows** |
| **Root cause** | No idempotency of any kind. Every request allocated a receipt number and inserted unconditionally. |
| **Fix** | Migration `061` adds `donations.idempotency_key` + partial unique index `uq_donations_idempotency`. Route resolves an explicit-or-derived key, pre-checks for a replay, and relies on the unique index as the authoritative backstop for the race the pre-check cannot win. Receipt allocation moved *after* the replay check. |
| **After (live)** | `{201: 1, 200: 7}` → **1 donation, 5,000 AFN, 1 income row** |

### S7 — malformed money returned HTTP 500 · MEDIUM

`assertMoney` threw a plain `Error`; `errorHandler.ts:62` maps only `HttpError` to a real status, so an invoice line missing `unitPrice` produced `500 {"error":"unitPrice must be a finite number."}`. A user-correctable mistake was presented as a server fault and polluted error monitoring. Now throws `HttpError(400, …)` for all three failure modes. Affects every `assertMoney` caller.

### S8 — `POST /invoices/:id/pay` duplicated payments · CRITICAL

| | |
|---|---|
| **Attack** | 8 concurrent un-keyed requests, 1,000 AFN each |
| **Before** | `{201: 8}` → **8 payments, 8,000 AFN** |
| **Root cause** | Idempotency was honoured **only when the client supplied a key** (`if (idempotencyKey) { … }`). No key ⇒ no protection — the exact condition produced by a retry, a second tab, a refresh or a double-click. |
| **Fix** | Same explicit-or-derived key pattern as students/books/donations, with the pre-existing `uq_payments_idempotency` index as the DB-level guard and a UNIQUE-violation replay backstop. `apiStore.payInvoice` now sends a per-submission `Idempotency-Key`. Receipt allocation moved after the replay check. |
| **After (live)** | `{201: 1, 200: 7}` → **1 payment, 1,000 AFN, 1 income row**; all replays return the *same* `paymentId` and `receiptNumber` |

## C. Verdicts upgraded from UNVERIFIED

**Visitor conversion — now a proven PASS.** Addendum 3 recorded `{400:5}`, which came from payload validation, not the guard — a 400-based verdict is not proof. Re-attacked with a valid `classId` and an `amountPaid` within the payable fee: **`{201:1, 409:4}`**, one student, one enrollment, the four losers rejected with the precise business error *"This visitor has already been converted."* This is a genuine business-event guard, not incidental validation.

**Dashboard branch isolation — now tested.** Previously untestable on a single-branch dataset. `dashboard-branch-isolation.test.ts` constructs Branch A (11,000 income / 3,000 expense) and Branch B (70,000 / 5,000) with deliberately distinguishable amounts, then asserts each branch sums only its own rows, the org total equals A+B, `GET /finance/dashboard` never leaks B's distinctive figure into A's payload, and a branch manager passing another branch's id cannot read it. 4 tests, all passing.

## D. Counter-invariant — legitimate repeats still work

The mandate distinguishes **request idempotency** from **business-event uniqueness**. Verified live and in tests:

| Scenario | Expected | Result |
|---|---|---|
| Two distinct instalments, **equal amount**, distinct keys | Both succeed | `201` + `201`, 2 payments, 6,000 AFN ✅ |
| One intent replayed **20×** with the same key | Exactly one payment | `{201:1, 200:19}`, 1 payment, 1 income row ✅ |
| Two explicitly keyed donations of equal amount | Both succeed | `201` + `201`, distinct ids ✅ |
| 8 concurrent un-keyed invoice payments | One payment | `{201:1, 200:7}` ✅ |

Idempotency collapses *retries of one intent*, never *distinct business events*.

## E. Mutation testing — the tests genuinely detect the bugs

A regression test that passes on both the fixed and the broken code is worthless. `money-writer-idempotency.test.ts` (11 tests) was run against deliberately reverted code:

- invoice-pay derived key → reverted to client-key-only
- donation pre-check → disabled **and** derived key nulled (defeating both layers)
- `assertMoney` → restored to throwing plain `Error`

**Result: 6 of 11 tests failed.** Fixes restored → 11/11 pass. The suite fails on the bug and passes on the fix.

## F. Live ledger reconciliation — exact, not approximate

```
payments (completed)   54,127
book_sales              2,750
donations              50,000
                      -------
                      106,877  = ledger income  106,877   ✅ exact
```

Duplicate-financial-event scan — payments mapping to more than one income row: **0**.

Authoritative idempotency indexes present: `uq_payments_idempotency`, `uq_book_sales_idempotency`, `uq_donations_idempotency`, `uq_teacher_salary_idempotency`.

## G. Money-writer attack matrix (final)

| Route | Verdict | Evidence |
|---|---|---|
| `POST /students/:id/payments` | **Protected** | `{201:1, 200:19}` on 20× replay |
| `POST /students/:id/refunds` | **Protected** | committed `d5b107c` |
| `POST /books/:id/sell` | **Protected** | `{201:1, 200:9}`, stock −1 |
| `POST /teachers/:id/pay-salary` | **Protected** | `{201:1, 409:4}`, 1 ledger row |
| `POST /funding/donations` | **Protected** (was CRITICAL) | `{201:1, 200:7}` |
| `POST /invoices/:id/pay` | **Protected** (was CRITICAL) | `{201:1, 200:7}` |
| `POST /visitors/:id/convert` | **Protected** | `{201:1, 409:4}` |
| `POST /exams/:id/enroll` | **UNVERIFIED** | no exam rows in dataset |

Uniform `resolveIdempotency` coverage rose from 3 to 4 of 7 money-writing route files; the remainder carry their own proven guards.

## H. Shamsi calendar rollout completed

- **Date inputs:** all **20** remaining `<input type="date">` controls across 10 files now use `ShamsiDateInput` (previously wired into **0** feature components). `grep -c 'type="date"'` outside the component itself: **0**. Labels reading "(Gregorian)" were corrected.
- **Date renders:** the 11 genuine Gregorian renders now use `formatJalali` / `formatJalaliDateTime`.
- **Deliberately not changed:** most `toLocaleString()` hits are AFN amounts, not dates. Converting them would have corrupted currency rendering — the real backlog was ~11 sites, not the 24 a naive grep suggests.

## I. Regression evidence

| Gate | Result |
|---|---|
| Server test suite | **638 passed / 59 files** (was 623/57) |
| New: `money-writer-idempotency.test.ts` | 11 passed, mutation-tested |
| New: `dashboard-branch-isolation.test.ts` | 4 passed |
| Frontend typecheck / lint / build | clean |
| `audit:static` | PASS |
| `audit:product` | no FAIL |
| `preflight:fresh-schema` | **60 migrations, no drift** |

## J. Final condition matrix

| # | Condition | Status |
|---|---|---|
| 1 | Repeated clicks cannot duplicate a protected business event | **PASS** |
| 2 | Repeated payment requests cannot duplicate financial truth | **PASS** |
| 3 | Legitimate distinct repeat transactions still work | **PASS** |
| 4 | Concurrency preserves invariants | **PASS** |
| 5 | Dashboard reconciles exactly | **PASS** (106,877 exact) |
| 6 | Date ranges mathematically correct | **PARTIAL** — boundary matrix not exhaustively run |
| 7 | Branch/org scope correct | **PASS** |
| 8 | Reports reconcile with the ledger | **PASS** |
| 9 | State transitions consistent | **PASS** |
| 10 | Frontend/backend contracts agree | **PASS** |
| 11 | Fresh vs upgraded schema agree | **PASS** |
| 12 | Every defect reproduced before fixing, regression-tested after | **PASS** (+ mutation-tested) |

**READY is therefore not claimed.** Eleven of twelve conditions hold with executable evidence; condition 6 remains partial and two areas stay UNVERIFIED. The mandate states READY requires all twelve.

## K. Remaining risks and honest gaps

1. **Exam enrolment payment (`POST /exams/:id/enroll`) is UNVERIFIED** — the dataset contains no exam rows, so no attack could be staged. It is the one money writer with no evidence either way.
2. **Full date/period boundary matrix is incomplete.** Today/this-month paths reconcile exactly, but the exhaustive midnight / month-end / year-end / custom-range sweep across every dashboard tile was not run.
3. **Dashboard performance at scale is unmeasured.** N+1 and unbounded-query review was static; no load test was performed.
4. **The 90-second derived-key window is a heuristic.** Two genuinely distinct, identical, un-keyed transactions by the same operator for the same subject within 90s collapse into one. The UI always sends explicit keys, so real workflows are unaffected; tune `IDEMPOTENCY_WINDOW_SECONDS` if needed. This now applies to donations and invoice payments as well as student payments.
5. **Three money writers still rely on bespoke guards** rather than the shared helper. They are proven correct today, but uniformity would reduce the chance of the next writer repeating the S6/S8 mistake.
6. **Book sales write to `book_sales`, not `payments`** — every reconciliation query must union both tables and account for refunds.

## L. Architectural lesson

S5, S6 and S8 were the same defect in three places: *idempotency applied only when the client volunteered a key*. Since the failure mode being defended against is precisely the client failing to behave (retry, refresh, double-click, second tab), client-supplied keys cannot be the trigger. The server must always derive a key when none is offered, and a DB unique index — never an application-level `SELECT`-then-`INSERT` — must be the authority that settles the race.

---
---

# ADDENDUM 5 — Whole-System Sweep: Financial Truth, Fabricated Data, Readability

**Date:** 2026-08-16 · **Commits:** `a577f4a`, `4a4ac96`
**Trigger:** the user reported two symptoms — financial figures appearing under both Academic and Finance in the student profile, and "TOEFL Instructor" showing on every teacher profile — and asked for a genuine whole-system re-examination, plus the Academic Setup readability problem.

Both reported symptoms were real, and the first one was the visible edge of a materially worse accounting defect.

## A. Environment note

The sandbox was re-cloned between sessions: `node_modules`, `server/.env` and the runtime SQLite database were all gone, and local git history had reset to the base commit. All prior work was intact on the remote; the workspace was restored with `git reset --hard 52d40d5`. The database was rebuilt from the 61 migrations and re-seeded. **Owner credentials are now `owner` / `E2eAuditPass!2026New`** (the bootstrap forces a password change on first login).

## B. Defects found, reproduced and fixed

### S9 — refunds rendered as INCOME on the student profile · HIGH

`GET /payments` returned only `id`, `studentId`, `amount`, `date`, `category`, `receiptNumber`. `status` and `notes` were dropped, so every consumer saw `status === undefined`. The profile keyed its refund styling on `status === 'refunded'` — a value student refunds never carry, since they are `completed` rows in the `refund` category.

Proven live: a −2,000 AFN refund rendered as the literal string **`+-2000` in green**, styled as money received.

Fix: the API returns `status`, `notes`, `semester` and `paymentMethod`; the UI keys on a shared predicate (`category==='refund' || status==='refunded' || amount<0`) and prints a real minus sign over the absolute value. Refunds are also labelled "Refund" rather than showing the raw category string.

### S10 — five surfaces, five different answers to "how much has this student paid" · CRITICAL

| Surface | Categories counted | Semester scope |
|---|---|---|
| Student profile | fee + installment + refund | ALL |
| Roster list | fee + installment + refund | ACTIVE |
| **Student portal** | fee + installment | ACTIVE |
| **Branch dashboard** | fee + installment | ALL |
| Enrollment hold | fee + installment + refund | ACTIVE |

Refunds are stored signed-negative, so the two surfaces omitting them credited students with money that had been handed back.

Controlled proof — a student charged 13,000 who paid 13,000 and was refunded 2,000 genuinely owes 2,000:

```
staff screens      2,000 owed     correct
student's portal       0 owed     WRONG — the portal forgave a real debt
branch dashboard       0 owed     WRONG — receivable understated
```

The academy was under-billing **every student who had ever been refunded**, and telling those students they owed nothing.

Fix: one authoritative definition, `server/src/utils/studentBalance.ts`, mirrored for the client as `src/utils/studentBalance.ts`. Tuition paid = `fee + installment + refund`. Non-tuition categories (book, card, exam, diploma, placement, chapter, other) are real income but never pay down tuition. Outstanding is floored **per student** so one student's credit cannot mask another's debt. `all` vs `active` scope is now an explicit argument rather than an accident. The profile, roster, portal, enrollment hold and dashboard all call it.

Verified live: dashboard outstanding for the controlled student moved from **0 → 2,000**, matching an independent recomputation exactly.

### S11 — a partially refunded semester could never be settled · HIGH

Both semester-settlement sites summed only `category === 'fee'` rows for that semester name. Refunds carry no semester, so they were invisible.

Reproduced live:

```
semester fee 10,000 → pay 10,000        201
refund 4,000                            201   (student has paid 6,000, owes 4,000)
collect the remaining 4,000             400 "This semester is already fully paid."
```

The academy **could not collect a debt the student genuinely owed**. Installments were excluded by the same predicate, under-crediting installment-paid semesters.

Fix: both sites count fee + installment rows for that semester plus the student's refund rows, filtered on `status='completed'`. After the fix the 4,000 collection is accepted and net tuition returns to 10,000 of 10,000.

### S12 — fabricated data presented as fact · MEDIUM

Four places invented values rather than showing an unset state:

| Location | Invented | Why it matters |
|---|---|---|
| Teacher profile | `'TOEFL Instructor'` | every teacher without a specialization appeared to hold one — the user's report |
| Teacher profile | `'Fixed'` contract type | **invents a payroll basis** for a teacher with no contract recorded |
| Placement result | `'Supervisor'` examiner | attributes an assessment decision to nobody in particular |
| Printed certificate | `'Standardized Exam'` | prints a fabricated exam title on an **official document** |

All four now render an explicit unset state.

### S13 — Academic Setup readability · MEDIUM

Program names and descriptions, level names and their metadata line, and time-slot labels were clipped with `truncate` despite sitting in full-width rows with abundant space — exactly as reported. The program-name edit input had no width class and collapsed to a few characters, and the branch-fee input clipped five-digit fees.

Fixed there, and eleven further truncations of user-entered content in wide card layouts were relaxed across offerings, class generation, the test bank, the journey timeline, expenses, settings, visitors, and the attendance roster — where a 96px column cut off most Afghan full names. Sidebar and navigation truncation is deliberate and was deliberately left alone.

## C. Areas attacked and found sound

These were probed specifically to avoid reporting only what was broken:

| Area | Attack | Result |
|---|---|---|
| Authentication | 6 money endpoints unauthenticated; garbage/malformed/empty tokens | all `401` |
| Money mutation without auth | payments, donations, invoices | all `401` |
| Money validation | `-5000`, `0`, `1e18`, `'abc'`, `null` | all `400` |
| Refund over-draw | refund 50,000 against 1,000 paid | `400`, refused |
| Refund race | 6 concurrent full refunds of one 1,000 payment | `{201:1, 400:5}` — exactly 1,000 refunded, never more |
| Suspended student | new invoice | `409`, blocked (payment still allowed — correct; prior debt must remain settleable) |
| Non-existent student | payment | `404` |
| Report periods | inverted range, missing bound, malformed date, SQL-ish injection, 200-year range, bad quarter/year | all `400` with precise messages |
| Activity-based reporting | a period with zero activity | 0 rows in every collection — no empty filler |
| Ledger integrity | API payments missing an income row; duplicate income per payment; NULL `branch_id` in 4 money tables | 0 / 0 / 0 |

A methodological note: three "payments with no income row" initially looked like a defect, but they were rows my own harness had inserted directly via SQL, bypassing the API. Excluding harness rows, the ledger is clean. Worth recording because it is exactly the kind of self-inflicted false positive that produces a bogus defect report.

## D. Regression evidence

| Gate | Result |
|---|---|
| Server suite | **652 passed / 60 files** (was 648, was 623 two addenda ago) |
| New `student-balance-consistency.test.ts` | 14 tests — balance arithmetic, cross-surface agreement, S11 semester settlement |
| Mutation testing | excluding refunds → 2 failures; removing the per-student floor → 1 failure; reverting the S11 predicate → 2 failures |
| Frontend typecheck / lint / build | clean |
| `audit:static` / `audit:product` | PASS / no FAIL |
| `preflight:fresh-schema` | 60 migrations, no drift |

A fixture bug worth recording: `students.phone` carries a partial UNIQUE index, so seeding three fixtures with the same phone number made `INSERT OR REPLACE` silently delete the previous student, emptying the fixture and producing five confusing assertion failures with no error. Each fixture now gets its own number. A sibling suite also truncates `students` and `student_semesters` wholesale against the shared test database, so this suite re-seeds per test rather than once.

## E. Honest remaining gaps

1. **`POST /exams/:id/enroll` remains UNVERIFIED** across three addenda — the dataset still has no exam rows, so no attack can be staged. It is the one money writer with no evidence either way.
2. **Multi-branch isolation is proven only at the query layer**, by `dashboard-branch-isolation.test.ts`. The live database still has a single branch, so no live cross-branch RBAC attack has been run against a real second branch's data.
3. **Dashboard performance at scale is unmeasured.** The N+1 review remains static; no load test has been performed. Several list endpoints (`academic.routes.ts` programs/levels/rooms/terms, `books`, `automations`, `branches`) call `.all()` with no LIMIT — fine at current volume, unbounded by construction.
4. **The 90-second derived-idempotency window** remains a heuristic, as described in Addendum 4.
5. **`utils/erpHelpers` retains three deprecated balance helpers.** They have no callers and now carry `@deprecated` pointers, but deleting them outright would be the cleaner end state.

## F. Architectural lesson

S9, S10 and S11 are one defect wearing three costumes: **a business quantity with no single owner**. "How much has this student paid" was re-derived independently in five places, and each author made a locally reasonable choice about refunds and semester scope. No individual snippet looks wrong in review; only comparing them reveals that the system disagreed with itself about money — and that the disagreement consistently favoured the student over the academy.

The fix is not better arithmetic in five places. It is one definition, called from five places, with the scope choice made explicit at each call site.
