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
