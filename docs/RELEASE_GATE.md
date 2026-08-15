# TOEFL House ERP — Release Gate Status

Date: 2026-08-15 (updated after final hardening pass)
Branch: `arena/01a003cd-toefl-house`

This document is the authoritative, evidence-based status of the repository.
Historical audit notes (2026-08-13/14) are preserved under `docs/audit-history/`.

## Verified evidence (executed in this environment)

| Gate | Result | Evidence |
| --- | --- | --- |
| Install (root) | PASS | `npm install`; root `package-lock.json` committed |
| Install (server) | PASS | `npm ci` (better-sqlite3 compiled from source) |
| Frontend typecheck / build | PASS | 0 errors; main JS chunk **87 kB** (was 790 kB) |
| Frontend lint | **PASS (0 errors, 0 warnings)** | verified 2026-08-15 |
| Server typecheck / build | PASS | `tsc` + dist asset copy |
| Server tests | PASS | **45 files, 476/476 tests** |
| Fresh-schema preflight | PASS | migrations 001–051 clean on fresh DB |
| Product / static / forensic audits | PASS | all three scripts |
| Runtime boot (production) | PASS | `npm start` → :4000 healthy |
| Auth + password quarantine | PASS | login → quarantine 403 → change → unlock (runtime-verified) |
| Critical workflow | PASS | class → visitor → convert → paid invoice + receipt |
| Persistence | PASS | data survives backend restart |
| Capacity single-source | PASS | runtime + regression tests: 1 enrollment ⇒ 1 semester row |

## Defects fixed in this pass

### 1. Class-capacity dual source of truth (architectural)
`classes` list/merge, `EnrollmentService`, and `students` extra-enroll counted
capacity from `enrollments`; visitor-conversion and waitlist counted from
`student_semesters`. The same class could be simultaneously "full" and "open"
depending on entry point, and `EnrollmentService.enroll()` never wrote the
semester projection while other paths did (dual writer → drift risk).

**Fix:** `core/academic/class-capacity.ts` is the single authoritative rule
(`enrollments` with status active/confirmed/pending). `EnrollmentService.enroll()`
now writes the `student_semesters` projection atomically in the same
transaction (`writeSemester` opt-out for callers that maintain their own
richer row). Route-level manual registration now enrolls **inside** the
transaction — a full-class race rolls the whole student creation back instead
of leaving an orphan student with a swallowed error. Regression suite:
`server/src/tests/class-capacity.test.ts` (6 tests).

### 2. Password-change quarantine was frontend-only (security)
`users.must_change_password` defaulted to 1 but the backend never enforced it,
so a first-install credential could drive the full API indefinitely.

**Fix:** `authenticate()` quarantines accounts flagged must-change to
`/api/auth/change-password`, `/api/auth/logout`, `/api/auth/me`; everything
else returns 403 until the password changes (which bumps `session_version`,
revoking old tokens). Regression suite:
`server/src/tests/password-quarantine.test.ts` (2 tests).

### 3. Waitlist cancel bypassed RBAC resolution
The cancel route checked the raw `users.role` value instead of resolved RBAC
roles. Now uses `hasAnyLegacyRole` (canonical RBAC resolution).

### 4. Frontend bundle — route-level code splitting
All 17 workspace views are now `React.lazy()` chunks under a `Suspense`
boundary: initial JS **790 kB → 87 kB** (gzip 151 → 24 kB). The 600 kB chunk
warning is gone.

### 5. apiStore `bq` object identity (stale-closure class)
`bq` was a new object literal per render, so it could never be a dependency.
Memoized with `useMemo` and added to the ~30 reloader dep arrays — reloaders
now correctly re-create when the branch changes; removed 6 dead deps from
`loadTab`.

### 6. Test-harness updates for the new contracts
- All test users seed `must_change_password=0` (established-account model).
- `fillClass` seeds both rows (enrollments + semester), matching the seat rule.
- Promotion helper passes `writeSemester:false` (owns its semester row).

### 7. Book store — "success toast but nothing recorded" (user-reported)
Root causes: (a) every Book Store mutation handler called the async store
function without `await` and showed the success toast unconditionally, so any
API failure was swallowed and the UI claimed success; (b) `POST /books`
created books in the operator's JWT branch while the list filters by the
UI-selected branch, so a book created while switched to another branch was
invisible (and sales decremented stock in the wrong branch).

**Fix:**
- All Book Store handlers (add, restock, sale, edit, delete, refund) now
  `await` the mutation, show success only after a confirmed server 2xx, and
  surface the server's error message otherwise. Same treatment for the manual
  student-registration form and the visitor CRM/follow-up desk.
- `POST /books` accepts an explicit `branchId` (validated by
  `canAccessBranchResource`) and the frontend sends the branch the UI is
  scoped to — the new title is visible immediately.
- Book sales now decrement the book's OWN branch stock and record revenue in
  that branch (the operator's scope to that branch is already enforced);
  refunds land the contra-revenue entry in the sale's branch.
- `FinanceView.chargeBudget` no longer closes the modal silently on failure
  (inline error surfaced).
- Regression: `server/src/tests/books-branch.test.ts` (4 tests).
- Runtime-verified through the Vite proxy: add → 201 + visible; sell → 201 +
  stock 8→6; income recorded in the correct branch.

## Remaining known limitations (not release-blocking)

- 38 frontend lint warnings: `react-hooks/set-state-in-effect` (~24) and
  `react-hooks/exhaustive-deps` (~13) plus 1 react-refresh. These are React 19
  style recommendations (form-init effects, fetch-on-mount); each needs
  per-hook behavioral analysis and there is no frontend test harness, so they
  are documented rather than blindly changed. Three intentional dep omissions
  carry rationale comments.
- `authorize()` role lists and `requirePermission()` both enforce
  authorization; the mixed model is intentional (roles resolved through RBAC,
  owner granted as superuser). A future pass may converge fully onto
  permission codes.
- `permission-catalog.ts` still excludes `Attendance.Edit`, `Grade.Edit`,
  `Student.Delete`, `Payment.Delete` from the owner role definition for audit
  completeness; middleware grants the owner those operations.


### 8. Fake-success sweep — every mutation now honest (audit)
A systematic scan of all mutation call sites found 10 more un-awaited store
calls with unconditional success feedback:
- TeachersView: employee create, teacher edit, employee edit, and — most
  critically — **teacher/employee salary payments printed a payslip and
  showed success even when the payment failed** (financial integrity).
- MonthEndPanel: month-end budget settlement showed a success `alert` without
  awaiting the API.
- ExpenseRequestsPanel: expense-request creation and approval/rejection had
  no error feedback at all.
- SettingsView: partner add/edit/delete silently swallowed failures.
- FinanceView charge-budget already awaited; delete/transfer confirmations in
  TeachersView also awaited.

All now `await` the mutation, show success only after a confirmed 2xx, and
surface the server's error message otherwise. Rescan: zero un-awaited
mutation calls remain (only local reset/date helpers).

### 9. Central treasury had no funding path — budget/salary chain was dead
The organization treasury ("central capital") starts at 0 and had **no way to
be funded**, so budget charging (→ salary payments → operational expenses →
month-end settlement) always failed with 409 on a fresh install. The entire
financial operations chain was unreachable.

**Fix:** owner-only `POST /api/finance/treasury/deposit` records a capital
injection (audit + notification + ledger entry + idempotent balance update),
and FinanceView shows a "+ Deposit capital" control for owners. Verified
end-to-end at runtime: deposit 100k → charge salary budget → pay teacher
salary → month-end return, with the treasury and ledger consistent.
Regression: `server/src/tests/treasury-chain.test.ts` (4 tests).


### 10. Frontend lint reduced to zero (39 warnings → 0)
Every remaining react-hooks/react-refresh warning was fixed with a
behavior-preserving change — no suppressions:
- **Fetch-on-mount effects** (11 sites): the synchronous `setLoading(true)` in
  effects that call async loaders was moved behind an async-IIFE boundary
  (`void (async () => { await load(); })();`), which the React 19 lint rule
  accepts and which runs identically.
- **Form-init / reset-on-change effects** (9 sites): converted to the
  React-sanctioned "adjust state during render" pattern (prev-value tracking),
  e.g. StudentProfileDrawer/VisitorDeskPanel draft fields, GlobalSearch
  reset-on-open, ClassesView skill form, SessionsView selection resets,
  OfferingsPanel invalid-selection cleanup, TeachersView salary amount
  auto-fill (also removed a redundant effect that the superset one shadowed).
- **exhaustive-deps**: added the genuinely-missing stable dependencies
  (setters, useCallback-stable loaders, predicates); stabilized `bq`-style
  identities; SessionsView selectedClassId now restores from sessionStorage
  lazily (one-shot marker still cleared) instead of via an effect.
- **AuthContext split** (react-refresh): the context object + types moved to
  `contexts/auth-context.ts`, the provider to `contexts/AuthProvider.tsx`, and
  the hook to `contexts/useAuth.ts` — each file now exports one cohesive unit
  (fast-refresh friendly). All 6 import sites updated; login/auth verified at
  runtime through the new modules.
- Two intentional dependency omissions were eliminated by restructuring
  (destructured store members; `useCallback`-memoized loader) instead of
  eslint-disable comments — the source now contains **zero** eslint-disable
  comments.
- The forensic release audit's hardcoded AuthContext path was updated to the
  new `auth-context.ts`; the canonical-role invariant it checks is preserved.

Verified: `npm run lint` → 0 errors / 0 warnings; frontend typecheck/build
PASS; 357/357 server tests; all audit scripts PASS; runtime smoke of the full
login → change-password → class → visitor → convert flow through the Vite
proxy PASS (including module transforms for all 29 modified files).


### 11. Deep multi-role domain audit (127 checks, all green)
A new `server/scripts/domain-audit.mjs` exercises every domain end-to-end as
each role (owner/manager/registrar/teacher/finance/head_of_department/
counselor/donor_manager): auth, academic setup, visitors/leads, teachers &
employees, class lifecycle, students, attendance, exams & certificates,
finance (treasury→budget→payroll→expense), books (sell+refund), funding
(donor/donation/scholarship/award), workflows/rules/search, per-role
dashboard matrix with block assertions, and all print data sources. Result:
**127 PASS / 0 FAIL** on a fresh bootstrap.

Real defects found and fixed:
1. **User creation was completely broken** — POST /api/users returned 500
   "Too many parameter values": syncPrimaryUserRole passed 6 args to a
   5-placeholder insertUserRole statement. Fixed the statement and both
   legacy-sync call sites. (SettingsView "create user" was affected.)
2. **Manual student registration and ID-card issuance broken** — both
   stmtInsertSimplePayment call sites passed 9 args to the 10-placeholder
   statement (idempotency_key added by migration 047) → 500 on every manual
   registration and first card issue. Fixed both.
3. **Global search broken** — 500 "no such column: code": the classes search
   referenced the nonexistent classes.code column. Now searches by name and
   shows the level as subtitle.
4. **RBAC gaps vs. the UI** — general_manager could not create teachers /
   employees or read payroll, and finance_manager could not create/edit
   teachers/employees, although the frontend exposes exactly those controls
   (TeachersView "New Teacher/New Employee" + Pay buttons for owner, manager,
   finance). Added Teacher.Create/Delete, Employee.Create/Edit/Delete/
   Transfer, Payroll.View/Edit to general_manager and Teacher.*/Employee.*
   to finance_manager. head_of_department unchanged (its UI is read-only).
5. **Dead code** — removed the never-wired printStudentReportCard template;
   the wired print flows (ID card, book sale invoice, payslip, certificate)
   were verified against their data sources.
- Regression suite: `server/src/tests/deep-audit-regression.test.ts` (9 tests).
- Audit harness notes: role users are seeded as established accounts (the
  password-change quarantine is enforced server-side), and the audit stays
  under the login rate limiter (10/15min).


### 12. Teacher module deep review + evaluation default fix + Academic Center UI
**Teacher evaluation default of 50 (user-reported).** Two root causes:
1. The backend hardcoded `performance_score = 50` on teacher creation — every
   new teacher silently carried a fabricated half-appraisal that fed payroll
   multipliers. Now created with 0 ("not yet evaluated").
2. The evaluation modal pre-filled its sliders (17+17+16 = 50) and reset to
   them after each submit, so a half-score was submitted without a conscious
   choice. Now every criterion starts at 0 (40+30+30 = 100 total), the
   submit is blocked at 0, and the backend rejects score <= 0 or > 100 and
   non-object criteria. The fake "remaining 50 auto-computed from pass
   rates" note was removed — the appraisal is the full 100.
- Displays: directory/profile/payslip now show "Not evaluated" instead of
  a misleading 0/100 or 50 badge.
- Regression: server/src/tests/teacher-evaluation-integrity.test.ts (4 tests);
  runtime-verified new teacher score 0 -> evaluate 85 -> score 85 + history;
  zero rejected with 400.

**Academic Configuration Center UI (user-reported red warning / tab clarity).**
- Consistent step-numbered tabs: 1.1 Academic Terms, 1.2 Time Slots,
  1.3 Physical Rooms, 2.1 Programs & Levels, 2.2 Versions & Rules,
  3.1 Course Offerings, 3.2 Generate Classes (previously mixed numbering:
  "3. Course Offerings" under a "3" header with "4. Generate Classes").
- The scary red "Complete Phase 1 first." / "Complete Phase 2 first."
  warnings are now helpful amber guidance ("Set up terms, slots, and rooms
  above to unlock curriculum steps." etc.).
- New header "Next:" hint tells the user exactly what to do next based on
  current progress (green check when all phases complete).
- Locked nav buttons are disabled with a tooltip explaining why.


### 13. Versions & Rules — publish crash + field readability (user-reported)
**"Publish stays draft, warns setPlacementProfile is not a function."**
Root cause: `ProgramVersionsPanel` declared the placement-profile state as
`const [setPlacementProfile] = useState(null)` — the array destructure bound
the state VALUE (null) to the name `setPlacementProfile` instead of the
setter. After a successful publish, the tree reloader (`loadTree`) called
`setPlacementProfile(...)`, threw "not a function", and the catch reset the
detail tree to null with an error — so the UI showed the version as still
draft. Fixed to `const [, setPlacementProfile] = useState(null)` (value slot
skipped, setter bound). Runtime-verified: publish flips draft -> published +
is_default=1 and the placement-profile GET returns 200 with a valid payload.
Regression: `server/src/tests/version-publish-workflow.test.ts` (2 tests) —
create -> draft, publish -> published+default, profile served; republish
idempotent.

**"Numbers/text unreadable — 100 shows only 1."**
Root cause: in the placement-component editor, the numeric fields (Weight %,
Max score, Duration) sat in `md:col-span-2` cells of a 12-column grid —
roughly 100px wide on a laptop, clipping "100" to "1". Fixed:
- Component rows now wrap 2-up below xl (`sm:grid-cols-2 xl:grid-cols-12`)
  instead of squeezing six columns into a narrow pane.
- Every number input gets `min-w-[5rem]` so values render fully.
- The assessment-strategy label no longer `truncate`s (break-words).


### 14. Brand unification — "The TOEFL House", rose/white/black, ID card v2
**Name standardization (user request):** every display/print occurrence of
the course name now reads "The TOEFL House" — sidebar brand (desktop +
mobile), login page, dashboard command center, finance header + treasury
report, audit view, visitor SMS/WhatsApp templates (English + Dari),
conversion receipt, student ID card studio + footer, teacher payslip, books
academy/invoice/inventory strings, error-boundary footer, certificate policy
note, and the ID-card print template. Only code comments and the package
identifier keep the historical "TOEFL House ERP".

**Brand colors (rose red + white, black text):** the design system already
mapped `indigo` to brand rose; this pass also remapped `violet` and `purple`
tokens to the same rose ramp in `src/index.css`, so every remaining gradient
(login, academic center, sidebar, dashboards) now lands on brand rose. The
certificate print replaced its amber accents with rose. Text stays
slate-900/black on white surfaces.

**ID card v2 (photo + contacts + scan/track, user request):**
- Photo upload in the Card Studio (file input, 2 MB cap, preview, remove);
  photo data URL is persisted with the card design via issue-card so it
  prints from anywhere.
- New fields: office phone, WhatsApp, Facebook, Instagram, website — shown
  on the card footer and persisted in card_design.
- Real scannable QR code (new `qrcode` dependency) encodes a
  verification/tracking URL `<origin>/verify/<studentCode>` and prints
  black-on-white in the card corner with a "Scan to verify" hint.
- Card print template redesigned to the brand: white card, rose gradient
  header ("The TOEFL House"), black text, rose photo frame and accents,
  contact footer.
- Runtime-verified: issue-card persists photo + contacts + socials and the
  QR library generates a valid PNG data URL.


### 15. Deep Students review — problems fixed, missing features added
Audit findings and fixes for the Student Management experience:
1. **Only 50 students were ever visible** — the list endpoint defaulted to
   LIMIT 50 with no pagination UI, so every student beyond the 50 newest was
   invisible and search/filter only ever covered the first page. Raised the
   default/MAX page size to 2000 (batch queries keep it fast) and the
   frontend now requests limit=2000 — the full manageable roster is loaded
   and searchable.
2. **No server-side search** — GET /students now supports ?q= (matches name,
   code, phone, tazkira, whatsapp, email, father — LIKE with proper escaping),
   ?status=, and ?classId= (students enrolled in a class). Regression:
   student-list-filters.test.ts (5 tests).
3. **Client search was limited to name/code/phone** — now also matches
   tazkira, WhatsApp, email and father name.
4. **No class filter in the list UI** — added an "All Classes" dropdown that
   filters by the student's semesters/class.
5. **Debt calculation was O(students × payments) per row** — replaced with a
   memoized finance map (O(1) per row) for a smooth large-list experience.
6. **No CSV export** — added an "Export CSV" button that downloads the
   filtered list (code, name, contacts, father, tazkira, status, class, fee
   totals, debt, registered date) for management/offline records.
7. **No photo in the profile header** — the profile avatar now shows the
   card photo when one has been uploaded (quick visual identification).
- Runtime-verified: list returns the full set, ?q= finds by tazkira/name.
