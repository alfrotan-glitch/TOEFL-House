# Final Release-Blocker Audit — Pass 32

**Date:** 2026-08-18
**Branch:** `arena/01a0062e-toefl-house` · **HEAD at audit time:** `5b220b5`
**Mandate:** Audit only. No production code was modified. `git status` clean throughout.
**Scope:** N-7 Accessibility · GL-1/GL-2 human-verification prep · UX-14 phone contract · frontend/UX defect-class sweep.

---

## 0. Method and its limits (read this before trusting any finding)

### 0.1 Browser automation is unavailable in this sandbox — and that is now proven, not assumed

| Attempt | Result |
|---|---|
| `npx playwright install chromium` | **FAILS** — `Failed to download Chrome for Testing 151.0.7922.34, code=1` (download blocked) |
| `npx playwright install --with-deps chromium` | **FAILS** — apt exit 100, cannot locate `fonts-tlwg-loma-otf`, `fonts-freefont-ttf` |
| System `chromium` / `google-chrome` | Not installed, not installable |

**Consequence: GL-1 (real-browser visual inspection) cannot be machine-verified here. It remains human-only.** This is stated plainly rather than papered over.

### 0.2 What I *was* able to do: render the real React app and scan the real DOM

The user's instruction was explicit — *"do not merely grep for aria attributes, use rendered/browser evidence wherever possible."* Two earlier harness attempts failed (`ROOT_CHILDREN: 0`). I diagnosed and fixed the actual causes rather than falling back to grep:

1. **jsdom does not execute `<script type="module">`.** `dist/index.html` loads the entry chunk as an ES module, so nothing ever ran. Confirmed by enumerating executed scripts.
2. **Rebundled the app** with esbuild to a classic IIFE (`--format=iife`), which jsdom *will* execute.
3. Still blank. Captured the real runtime error instead of guessing: `Uncaught TypeError: Cannot read properties of undefined (reading 'VITE_API_URL')` — esbuild does not polyfill `import.meta.env`. Fixed with `--define:import.meta.env=...`.

**Result: the genuine React application boots in jsdom, authenticates against the live API server with a real HttpOnly session cookie, fetches real data from the seeded database, and renders.** All 16 authenticated views were rendered and scanned with **axe-core 4.10** (`wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice`). Rendered HTML is archived at `/tmp/a11y/html/*.html`.

```
== dashboard == text=1875 violations=3    == funding    == text=972  violations=1
== visitors  == text=3847 violations=2    == operations == text=1482 violations=2
== students  == text=545  violations=2    == impact     == text=524  violations=1
== classes   == text=646  violations=1    == books      == text=1406 violations=3
== sessions  == text=764  violations=2    == workflows  == text=507  violations=1
== teachers  == text=590  violations=1    == rules      == text=958  violations=1
== exams     == text=851  violations=3    == audit      == text=1513 violations=1
== finance   == text=2259 violations=2    == academic   == text=1354 violations=2
```

**This is rendered-DOM evidence from the running application, not static analysis.** Where I could only obtain source-level evidence, I say so explicitly.

**Honest caveat:** jsdom is not a browser. It has no layout engine, so it cannot measure colour contrast, 200 % zoom reflow, or visual focus rings *as painted*. Findings that depend on layout are marked **human-verification-required** and routed to Section D rather than asserted as defects.

---

## A. RELEASE BLOCKERS

### A-1 · Form controls have no accessible name — 24 of 47 rendered controls are anonymous to a screen reader
**Severity:** Critical (WCAG 2.1 A — 4.1.2 Name, Role, Value; 3.3.2 Labels or Instructions)
**Ownership:** Frontend
**Evidence:** rendered DOM, axe-core + independent DOM analysis across all 16 views

axe reports `select-name` (**19 nodes**, critical) and `label` (**5 nodes**, critical). My own pass over the rendered DOM:

```
Rendered form controls across 16 views: 47
  with programmatic label (aria-label/aria-labelledby/<label for>): 9
  ONLY a placeholder (disappears on input, not a reliable name):   14
  NO accessible name at all:                                       24
```

Source confirmation: `aria-invalid` = 0, `aria-describedby` = 0, `aria-required` = 0, `<label htmlFor=` = **5** across **314 `<input>`** and **134 `<select>`** elements.

**Exact locations (representative, not exhaustive):**
- `src/components/dashboard/DashboardView.tsx:598` — `quickRegVisitorId` select (**quick registration**, a money path)
- `src/components/dashboard/DashboardView.tsx:602` — `quickClassId` select
- `src/components/dashboard/DashboardView.tsx:607,608` — Amount Paid / Discount % (placeholder only)
- `src/components/visitors/VisitorsView.tsx:350,353,360,366` — status/source/placement/interest filters
- `src/components/finance/FinanceView.tsx:199,205` — fiscal year / month selectors
- `src/components/books/BooksModals.tsx` — quantity input, product selects

**Root cause:** the codebase styles inputs directly and relies on `placeholder` for visible affordance. A placeholder is *not* an accessible name: it vanishes on input, is not reliably announced, and fails contrast.

**Reproduction:** boot the app, focus any Dashboard quick-registration select with a screen reader. It announces "combo box" with no indication of what it selects.

**Business impact:** the Dashboard quick-registration flow (selects a visitor, a class, an amount, a discount → **takes money**) is unusable non-visually. A staff member using assistive technology cannot tell the Amount field from the Discount field. In a fee-collection workflow that is a financial-error risk, not merely an inconvenience.

**Would existing tests detect it?** **No.** There is no frontend test framework in this repo (`package.json` has no frontend `test` script; no `src/**/*.test.*`). Zero a11y assertions exist anywhere.

---

### A-2 · Modals are not dialogs: no focus move, no focus trap, no Escape, background fully reachable
**Severity:** Critical (WCAG 2.1 A — 2.1.2 No Keyboard Trap / 2.4.3 Focus Order; 4.1.2)
**Ownership:** Frontend
**Evidence:** rendered DOM, live interaction — I clicked the real button and inspected the resulting DOM

Driving the real app (`/tmp/a11y/modal.mjs`), clicking **"New visitor"** on the Visitors view:

```
--- MODAL OPENED via button: New visitor on tab visitors ---
overlay found: true
role attr: null
aria-modal: null
aria-labelledby: null
nested role=dialog: false
activeElement BEFORE open: BODY | AFTER open: BODY (BODY = focus NOT moved)
after Escape, modal still open: true
focusable elements inside overlay: 15
focusable elements OUTSIDE overlay still reachable (no inert/aria-hidden): 82
```

Every one of the four dialog obligations fails simultaneously:
1. **No `role="dialog"` / `aria-modal`** — screen readers do not announce a dialog.
2. **Focus is never moved into the modal** — it stays on `<body>`; a keyboard user must tab through 82 background controls to reach the form they just opened.
3. **Escape does not close it** — no keyboard dismissal.
4. **No focus trap and no `inert`/`aria-hidden` on the background** — focus escapes behind the overlay onto controls that are visually obscured.

**Scale:** **27 files** contain `fixed inset-0` overlay modals; only **2** files in the entire codebase use `role="dialog"`/`aria-modal` (`common/GlobalSearch.tsx`, `sidebar/MobileSidebar.tsx`). So ~25 modal surfaces are affected, including visitor creation, fee collection, and book sales.

**Root cause:** modals are hand-rolled `<div className="fixed inset-0">` overlays with no shared Dialog primitive. There is no single component to fix — the pattern is duplicated 27 times. *(This is the same duplicated-logic defect class that produced the pass-31 finance bug, now in the UI layer.)*

**Business impact:** keyboard-only and screen-reader operators cannot reliably complete *any* create/edit workflow. Combined with A-1, the primary data-entry paths are inaccessible.

**Would existing tests detect it?** **No.** No frontend tests exist.

---

### A-3 · Focus indicator is suppressed on the primary navigation and ~20 controls per view
**Severity:** Critical (WCAG 2.1 AA — 2.4.7 Focus Visible)
**Ownership:** Frontend
**Evidence:** rendered DOM + compiled CSS specificity analysis

`src/index.css:74` defines a correct global indicator:
```css
:focus-visible { outline: 2px solid var(--color-brand-500); outline-offset: 2px; }
```
But **22 elements** apply Tailwind's `focus:outline-none` with **no replacement ring** (no `focus:ring`, `focus:border`, `focus:shadow`, or `focus-visible:`). Measured in the rendered DOM:

```
TAB=finance  focusable(enabled)=42 · suppress outline with NO replacement: 20
TAB=visitors focusable(enabled)=81 · suppress outline with NO replacement: 22
```

The suppression **wins on specificity**, verified against the built stylesheet `dist/assets/index-Ckiu3FrN.css`:
```
.focus\:outline-none:focus  → specificity (0,2,0)  [class + pseudo-class]
:focus-visible (global)     → specificity (0,1,0)  [pseudo-class]
→ the utility wins regardless of source order
```

**Worst offender:** `src/components/sidebar/SidebarItem.tsx:23` — **every primary navigation item**. A keyboard user tabbing the main nav sees no indication of position at all. Others: `finance/ExpenseRequestsPanel.tsx:65`, `finance/OperationalExpensesPanel.tsx:137,214`, `finance/FinanceView.tsx:199,205`, `sidebar/SidebarFooter.tsx:23` (Sign Out).

**Root cause:** `focus:outline-none` was applied for aesthetics without adding a `focus-visible:` replacement; the global rule cannot override it.

**Business impact:** keyboard navigation is effectively blind. This is the single cheapest blocker to fix (delete the utility, or add `focus-visible:ring-2`) and has the highest ratio of impact to effort.

**Would existing tests detect it?** **No.**

---

### A-4 · Students list silently truncates at 2 000 and reports the truncated number as the total
**Severity:** High → **Blocker for any branch approaching 2 000 students** (data integrity of a displayed figure)
**Ownership:** Backend (no total returned) + Frontend (derives total from page data)
**Evidence:** live reproduction against the running API and a seeded database

I seeded **2 101** students and loaded the Students view:

| Source | Value |
|---|---|
| Database truth | **2 101** students |
| `GET /api/students?branchId=1&limit=2000` | returns **2 000** |
| `GET /api/students?branchId=1&limit=5000` | returns **2 000** (clamped by `MAX_PAGE_SIZE`) |
| Rendered table rows | **2 000** |
| **UI counter text** | **"2000 of 2000 students"** |

**101 students vanish with no error, no warning, and a counter that actively asserts completeness.**

**Root cause — two independent faults:**
1. `server/src/routes/students.routes.ts:137-138` — `DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE = 2000`; the endpoint returns a **bare array** with no `total` and no `X-Total-Count` header (verified: no total header present). The caller cannot know it was truncated.
2. `src/components/students/StudentsView.tsx:294` — `` `${filteredStudents.length} of ${students.length} students` ``. `students.length` is the **length of the truncated page**, so the denominator is the truncation limit. This is exactly the *"summary metrics computed from page data"* defect class flagged in the mandate — and precisely the architectural error the pass-23 directive forbade ("the frontend must only display server-computed results").

**Blast radius — CSV export inherits it.** `StudentsView.tsx:164-170` builds the export from `filteredStudents`, i.e. the truncated array. **A management CSV export of a 2 101-student branch silently produces 2 000 rows**, with financial columns (Total Fee, Paid, Debt). Offline financial records would be quietly incomplete.

**Note on the fix (not applied — audit only):** per the standing pass-23 rule, *do not simply raise the limit*. The correct fix is server-side pagination with an authoritative `total`, mirroring the Visitors view — which **already does this correctly** (`/api/visitors?limit=25&offset=0` + a separate `/api/visitors/summary`, rendering "Showing 25 of 254 leads · 1 / 11"). Visitors is the reference implementation; Students never adopted it.

**Would existing tests detect it?** **No.** Backend tests reference `2000`/`MAX_PAGE_SIZE` but assert the clamp *works*, not that the client can detect truncation. The UI counter is untested (no frontend tests).

---

## B. HIGH / MEDIUM FINDINGS

### B-1 · A failed Dashboard summary renders as legitimate zeros, with no error state (High)
**Ownership:** Frontend · **Evidence:** live fault injection

I intercepted `/api/dashboard/summary` and returned HTTP 500, leaving everything else healthy:

| | Active Students tile | Error/retry UI shown? |
|---|---|---|
| Healthy | **1** | no |
| `/dashboard/summary` → 500 | **0** | **no** |

**Root cause:** `src/apiStore.ts:441` — `.catch(() => setDashboardSummary(null))`, then `DashboardView.tsx:147-153` — `pop?.activeStudents ?? 0`, `conversionRate ?? 0`, `pendingLeads ?? 0`. A **fetch failure is indistinguishable from a genuine zero.**

**Business impact:** the owner opens the Dashboard during a backend fault and sees 0 active students, 0 % conversion, 0 pending leads — presented with the same confidence as real data. There is no indication anything is wrong. Decisions get made on phantom numbers. Same pattern at `apiStore.ts:404` (invoices → `[]`), `:408` (finance config → `null`), `:445` (finance dashboard → `null`).

**This is the "missing error state" + "stale/partial backend truth" defect class, confirmed live.** The `?? 0` is defensible as a *render guard*; using it as an *error handler* is not. The fix is a tri-state (`loading` / `error` / `data`), not a different default.

**Would existing tests detect it?** **No** — `dashboard-summary.test.ts` covers the server's happy path; the client's failure path is untested.

---

### B-2 · No page has an `<h1>`; heading hierarchy is broken (Medium)
**Ownership:** Frontend · **WCAG 1.3.1 / 2.4.6** · **Evidence:** rendered DOM, all 16 views

```
academic-setup  h1=YES     seq=[1,3,3,3,2]  jump 1→3
dashboard       h1=YES     seq=[2,3,1,3,3]  jump 1→3 (h1 appears third, after an h2 and h3)
audit           h1=MISSING seq=[2]
books           h1=MISSING seq=[2,3,3,3,3]
classes         h1=MISSING · exams h1=MISSING · finance h1=MISSING · funding h1=MISSING
operations-report h1=MISSING · sessions h1=MISSING · students h1=MISSING
teachers        h1=MISSING · visitors h1=MISSING seq=[2,3,4,3]
```

**14 of 16 views have no `<h1>`.** axe additionally flags `heading-order` (moderate, 2 nodes). Screen-reader users navigating by heading (a primary strategy) cannot identify the current page.

### B-3 · Toast notifications are not announced (Medium)
**Ownership:** Frontend · **WCAG 4.1.3 Status Messages**
`src/App.tsx:481-488` renders toasts in a plain `<div>` with **no `role="status"`, no `aria-live`**. `src/components/common/Toast.tsx` likewise has zero ARIA attributes. Only **2** `aria-live` regions exist in the whole app (`App.tsx:397`, `:465`).

**Impact:** toasts are the app's primary success/failure channel — including *"Visitor full name and phone are required"* and payment confirmations. A non-visual user receives **no feedback at all** on whether a fee payment succeeded. Compounds A-2: after submitting a modal, nothing is announced.

### B-4 · Data grids lack table semantics; no landmarks or skip link (Medium)
**Ownership:** Frontend
Rendered Visitors view: `<table>` = **0**, `role="grid"/"table"` = **0**, `aria-sort` = **0**, `aria-live` = **0**. The list is a CSS grid of `<div>`s (`VisitorsView.tsx:454`). Landmarks are structurally present (`<main>`, `<nav>`, `<header>`, `<aside>` × 1 each) but there is **no skip link**, so keyboard users traverse the full sidebar on every view. Where real `<table>`s exist (`StudentsView`, `table[0] rows=2000 th=6`), **`scope` attributes = 0** and there is no `<caption>`.

### B-5 · Kanban board forces 1 320 px horizontal scroll (Medium — mobile/tablet)
**Ownership:** Frontend · `src/components/visitors/VisitorsView.tsx:454` — `min-w-[1320px]`.
On a tablet (768 px) or phone, the Visitors Kanban — a critical admissions workflow — requires horizontal scrolling. WCAG 1.4.10 (Reflow) requires content to reflow at 320 px equivalent. **jsdom cannot measure layout, so severity is asserted from the fixed pixel constraint in source, not from a rendered measurement.** Routed to Section D for human confirmation.

### B-6 · Lead-lifecycle vocabulary is duplicated frontend/backend (Medium — latent drift risk, NOT a live defect)
`src/config/leadLifecycle.ts:42-62` and `server/src/core/visitors/lead-lifecycle.ts:86-110` implement `leadLifecycleBucket` **twice**. I diffed them: **the logic is currently identical** (`status === 'registered'` → converted; `stage ?? 'lead' === 'lost'` → closed; else open).

**I am explicitly not calling this a defect** — there is no observable wrong behaviour today. But this is the *exact* shape of the pass-31 Critical finding (a fourth private copy of the finance classification rule that silently drifted). Two copies of a business vocabulary with no shared source and no cross-consistency test will drift. Recommend a consistency test that asserts the two agree across the full status×stage matrix.

---

## C. FALSE POSITIVES / REJECTED HYPOTHESES

Explicitly dismissed after investigation. **None of these are defects.**

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| C-1 | Permission-hidden actions are still reachable via direct API | **REJECTED** | Created a real `teacher` user and attacked six privileged endpoints. **All six returned 403:** `POST /visitors`, `POST /users`, `POST /finance/expenses`, `GET /audit-logs`, `GET /finance/overview`, `DELETE /visitors/:id`. Server-side authorization is authoritative; the UI hides what the API also refuses. |
| C-2 | Visitors list truncates like Students | **REJECTED** | Visitors is the **correct** implementation: `?limit=25&offset=0` plus a separate authoritative `/api/visitors/summary`. Rendered UI reads *"Showing 25 of 254 leads · Previous 1 / 11 Next"* — accurate against 254 DB rows. |
| C-3 | Dashboard re-derives KPIs client-side | **REJECTED** | `DashboardView.tsx:147-170` reads `dashboardSummary.population.*` and `.cashFlow` straight from `/api/dashboard/summary`. The pass-23/24 architecture held. The only client-side derivation is `pendingLeadsList` (a picker over the loaded page), which is explicitly labelled as such and correctly reuses `isLeadOpen`. |
| C-4 | `?? 0` fallbacks are themselves the bug | **REJECTED as stated** | The defect is the **`.catch()` that discards the error** (B-1), not the render guard. Removing `?? 0` would produce `NaN`/crashes without fixing anything. Recorded so the fix targets the right layer. |
| C-5 | Login rate-limiting is broken (repeated 429s during testing) | **REJECTED — control working correctly** | `auth.routes.ts:41` `ATTEMPT_WINDOW_MS = 15 min`. My harness re-authenticated on every run and tripped it. This is a **security control functioning as designed**; it obstructed my tooling, not the product. |
| C-6 | jsdom console errors indicate app faults | **REJECTED — harness artifact** | The only recurring runtime error across all 16 views is `Not implemented: HTMLCanvasElement.prototype.getContext`, emitted by jsdom because charts render to canvas. Not an application defect. Google Fonts `ECONNRESET`/"Could not parse CSS stylesheet" is likewise sandbox network isolation. |
| C-7 | Silent mutation failures in write paths | **REJECTED (for writes)** | The four error-swallowing `.catch()` handlers in `apiStore.ts` (404, 408, 441, 445) are all **read/reload** paths. Mutation paths surface errors via `triggerToast`. The read paths are still a real problem — filed as B-1 — but the mandate's "silent failed mutations" class is **not** present. |

---

## D. HUMAN ACCEPTANCE TESTS — GL-1 / GL-2

**These are NOT verified. They cannot be verified by code in this environment (§0.1) and I make no claim that they are.**

Machine-verifiable portions have been separated out and are marked as such.

### GL-1 — Real-browser visual inspection

| ID | Test | PASS criteria | FAIL criteria | Status |
|---|---|---|---|---|
| GL-1.1 | Load all 16 views @ **1920×1080**, Chrome | No clipped text, no overlap, no horizontal scrollbar, sidebar + content aligned | Any overlap, clipping, or unintended horizontal scroll | **HUMAN ONLY** |
| GL-1.2 | Repeat @ **1366×768** (common laptop) | As above | As above | **HUMAN ONLY** |
| GL-1.3 | Repeat @ **768×1024** (tablet) | Layout reflows; no horizontal scroll on Dashboard, Visitors, Students, Finance | Horizontal scroll on a critical workflow | **HUMAN ONLY** — expect **FAIL** on Visitors Kanban per B-5 (`min-w-[1320px]`) |
| GL-1.4 | Repeat @ **375×667** (phone) | Sidebar collapses; forms usable one-handed | Controls unreachable or overlapping | **HUMAN ONLY** |
| GL-1.5 | Browser zoom **200 %** @1280×1024 | All content reachable, no loss of function (WCAG 1.4.4) | Content clipped or unreachable | **HUMAN ONLY** — jsdom has no layout engine |
| GL-1.6 | Colour contrast of body text, badges, disabled states | All ≥ 4.5:1 (≥ 3:1 large text) | Any text below threshold | **HUMAN ONLY** — needs a rendering engine; use axe DevTools in Chrome |
| GL-1.7 | Status conveyed by colour alone (badges, RAG indicators) | Every colour-coded state also carries text or an icon | Colour is the only differentiator | **HUMAN ONLY** — `config/badges.ts` `BADGE_TONE_CLASS` needs visual review |
| GL-1.8 | Keyboard-only pass: Tab through Dashboard → Visitors → create a visitor | Focus always visible and logically ordered | Focus invisible or lost | **PRE-FAILED by A-3** — fix first, then verify |
| GL-1.9 | Screen reader (NVDA/JAWS/VoiceOver) on the fee-collection flow | Every control announced with a meaningful name; success announced | Unnamed controls; silent outcome | **PRE-FAILED by A-1/A-2/B-3** — fix first, then verify |

**Machine-verified already (do not re-do by hand):** all 16 views mount and render against live data with no application JS errors; axe-core violation inventory (§A); modal focus behaviour (A-2); focus-suppression counts (A-3); heading structure (B-2); accessible-name counts (A-1).

### GL-2 — One actual printed fee bill

**Must be physically printed to paper (or Print-to-PDF at minimum), then inspected.** Never claim verified without this.

| ID | Test | PASS criteria | FAIL criteria | Status |
|---|---|---|---|---|
| GL-2.1 | Convert a visitor → collect a fee → print the receipt | Paper shows issuer, receipt no., student, class, gross, discount, net, method, date, signature line | Any field missing or truncated | **HUMAN ONLY** |
| GL-2.2 | **Print scoping** | Only the receipt prints | **Sidebar/header/nav appear on the printout** | **HUMAN ONLY — HIGH RISK OF FAIL, see below** |
| GL-2.3 | **Page size/orientation** | Receipt prints A4 **portrait** | Prints landscape or spills to page 2 | **HUMAN ONLY — HIGH RISK OF FAIL, see below** |
| GL-2.4 | Amounts and currency | AFN figures correct vs DB, correctly formatted, not clipped | Any mismatch | **HUMAN ONLY** |
| GL-2.5 | Dates | Jalali/Shamsi rendering correct on paper | Wrong calendar or unreadable | **HUMAN ONLY** |
| GL-2.6 | Repeat for: book sale receipt, ledger statement, P&L, operations report, certificate, payslip | Each scoped and paginated correctly | Chrome bleed or bad pagination | **HUMAN ONLY** |

**Two specific print risks found by source inspection — flag these to the tester so they know what to look for:**

1. **Print scoping is almost certainly broken outside Exams.** `src/index.css:177` defines `.no-print { display: none !important; }`, but `.no-print` is used in **only 5 places, all in `ExamsView.tsx`**. `FinanceModals.tsx:292` ("Print statement"), `BooksModals.tsx:388,691`, and `LedgerPanel.tsx:107` call `window.print()` with **zero `no-print` markers**, and **neither `App.tsx` nor any sidebar component marks app chrome as `no-print`** (grep count: 0). Expect the sidebar, header and navigation to print on the fee bill. **GL-2.2 is the most likely failure.**
2. **The default `@page` is A4 *landscape*.** `src/index.css:232-235` declares an **unscoped** `@page { size: A4 landscape; margin: 0; }` for certificates. A named `@page standard-doc { size: A4 portrait; margin: 15mm; }` exists (`:194`) — but `.print-document`, the class that applies it, is used **0 times in the codebase**. So every non-certificate document, including the fee bill, likely inherits **landscape with zero margin**. **GL-2.3 is at high risk.**

Both are source-derived inferences about rendering. They are **not** confirmed defects — a print engine is required. I have deliberately not filed them in Section A.

---

## E. UX-14 — PHONE REQUIREMENT: BUSINESS DECISION REQUIRED

**I am not deciding this rule.** Below is the complete traced contract, the reproduced inconsistency, and the consequences of each option.

### E.1 The contract today — inconsistent at every layer

| Layer | Location | Behaviour |
|---|---|---|
| **Frontend — required** | `AddVisitorForm.tsx:102` | `if (!fullName.trim() \|\| !phone.trim()) return triggerToast('Visitor full name and phone are required.')` |
| **Frontend — format** | `AddVisitorForm.tsx:103` → `utils/erpHelpers.ts:8-11` | `/^(07\|\+937)\d{8}$/` — Afghan mobile only |
| **Frontend — HTML** | `AddVisitorForm.tsx:181` | `<input type="tel" required maxLength={60}>` |
| **API — optional, unvalidated** | `visitors.routes.ts:475` | `const { phone = null, ... } = text` — **defaults to null; no format check** |
| **API — sanitisation only** | `visitors.routes.ts:107` | `['phone','Phone', TEXT_LIMITS.short]` — type/trim/length only |
| **Database** | `visitors.phone`, `students.phone` | `TEXT`, `notnull=0`, no default, **no CHECK, no UNIQUE** |
| **Deduplication** | `core/visitors/duplicate-lookup.ts:117-128` | Phone is the **middle-confidence** signal (Tazkira > phone > name); `phoneMatchKey` normalises to a digit suffix |
| **Server-side validator** | — | **Does not exist.** No `07\d`/`+937` regex anywhere in `server/src` outside a comment |
| **Tests** | 48 test files mention `phone` | **None asserts requiredness or format.** They only pass valid phones as fixture data |

### E.2 Reproduced live (running API, real owner token)

```
POST /api/visitors {"fullName":"UX14 NoPhone","source":"walk_in","gender":"male"}                       → HTTP 201
POST /api/visitors {"fullName":"UX14 Junk",   ...,"phone":"not-a-phone-!!!"}                            → HTTP 201
POST /api/visitors {"fullName":"UX14 Empty",  ...,"phone":"   "}                                        → HTTP 201
POST /api/visitors {"fullName":"UX14 Script", ...,"phone":"<script>alert(1)</script>"}                  → HTTP 201
```

Database truth afterwards:
```
UX14 NoPhone    | phone = null
UX14 Junk       | phone = "not-a-phone-!!!"
UX14 Empty      | phone = null            (whitespace normalised to null)
UX14 Script     | phone = "<script>alert(1)</script>"
```

**And it propagates to a paying student.** I converted the phone-less visitor:
```
POST /api/visitors/v_103fb98f.../convert {"classId":"c1","amountPaid":6000,"paymentMethod":"cash"}
→ HTTP 201  studentCode TH-001001 · receipt R-00000001 · invoice INV-2026-00001 · netAmount 6000 · paid

DB: students.TH-001001 "UX14 NoPhone" | phone = NULL
```

`visitors.routes.ts:766` copies `visitor.phone` verbatim into the student row with **no re-validation at conversion**. **A student who has paid 6 000 AFN exists with no contact number.**

**Severity of the gap itself: High.** The frontend rule is cosmetic — any API client, integration, import, or a user with DevTools bypasses it entirely. Note the stored `<script>` value: it is *stored* unescaped (React escapes on render, so this is not a live XSS), but it demonstrates the field accepts arbitrary text.

### E.3 Consequences of each option

**Option A — Mandatory everywhere (visitor + student, format-enforced)**
- ✅ Guarantees every lead and student is contactable; makes phone a dependable dedup key; matches current frontend intent.
- ❌ **Breaks the front desk.** A walk-in who will not share a number cannot be recorded at all — staff will enter `0700000000`, which is *worse* than null (poisons dedup by clustering unrelated people on one key).
- ❌ **Migration burden:** requires backfill for existing null-phone rows before any `NOT NULL` constraint. Currently 0 nulls in this fixture DB, but production is unknown — **must be counted before choosing**.
- ❌ The `/^(07|\+937)\d{8}$/` regex rejects landlines, foreign numbers, and corporate-sponsor contacts. Funding/donor workflows may legitimately need those.

**Option B — Optional everywhere (relax the frontend to match the API)**
- ✅ Zero migration risk; smallest change; front desk never blocked.
- ❌ **Accepts the currently-reproduced failure as policy**: paying students with no contact number. Fee reminders, class-cancellation notices and results delivery become impossible for those records.
- ❌ **Degrades deduplication.** Without phone, `duplicate-lookup.ts` falls back to exact `LOWER(TRIM(full_name))` — and only when nothing stronger matched. In a market with high name collision this produces duplicate leads, which is the precise problem the module's own header comment says it exists to prevent.
- ❌ Junk like `"not-a-phone-!!!"` remains storable — a data-quality problem independent of requiredness.

**Option C — Optional at Visitor stage, mandatory at conversion/student stage** *(recommended architecture — decision still owner's)*
- ✅ Matches the real business process: a browsing visitor may withhold a number; someone **paying money and enrolling** must be contactable.
- ✅ Fixes the reproduced defect at its true boundary — the conversion endpoint — without blocking the front desk.
- ✅ Preserves advisory (never-blocking) dedup at the visitor stage, consistent with the documented "phone is deliberately NOT unique" decision.
- ✅ **No historical migration needed** — enforcement lives in the conversion path, honouring the standing "never modify historical migrations" rule.
- ⚠️ Requires a clear error at conversion ("A contact phone is required before enrolment") and a UI affordance to add one mid-conversion, or staff hit a dead end at the payment step.
- ⚠️ Format validation should be **normalise-then-validate**, and **lenient** (accept spaces/dashes/`+93`, store canonical) rather than the current strict regex — otherwise Option C reintroduces Option A's rejection problem at the till.

### E.4 Architectural recommendation (implementation deferred pending approval)

1. **One shared phone authority**, mirroring the pass-31 `ledger-classification.ts` remedy: a single `normalizePhone()` + `isValidPhone()` module used by the API, the conversion path, dedup, and (via a shared type or a thin re-export) the frontend. Today the *only* validator lives in the frontend, which is the wrong layer for a rule the API must enforce.
2. **Enforce at the domain boundary**, not the form: validate in `POST /api/visitors`, `PATCH /api/visitors/:id`, and — decisively — `POST /api/visitors/:id/convert`.
3. **Store canonical, match on normalised suffix** (`phoneMatchKey` already does the latter correctly; reuse it).
4. **Forward-only migration** if any DB constraint is wanted; never alter historical migrations.
5. **Regression tests, mutation-proven**: null phone at visitor stage, null phone at conversion, junk format, `+93`/spaced/dashed variants, and a dedup test proving normalised matching survives formatting differences.

> **⚠️ FINAL DECISION REQUIRED FROM THE OWNER.** A, B, or C is a business-policy question about front-desk behaviour and contactability obligations. I have deliberately not implemented any of them. My recommendation is **C**, with lenient normalise-then-validate formatting.

---

## F. TEST COVERAGE GAPS

1. **No frontend test framework exists.** No `src/**/*.test.*`, no frontend `test` script. **Every finding in Sections A and B is therefore undetectable by the current suite** — including two Critical blockers. Standing pass-24 guidance was to avoid adding one *unless a genuine frontend business-logic defect is found*. **A-4 (truncated total presented as authoritative) and B-1 (fetch failure rendered as real zeros) are exactly that** — business-logic defects living in the frontend. That precondition is now met; the decision to introduce a frontend test framework should be revisited.
2. **Zero accessibility assertions** anywhere in the repo. The axe harness built this pass (`/tmp/a11y/audit.mjs`) is reusable and could be adapted into a CI gate once a frontend test runner exists.
3. **No test asserts phone requiredness or format** despite 48 test files using phone fixtures (§E.1). All four malformed payloads in §E.2 would pass CI today.
4. **No test covers client-side API-failure rendering.** `dashboard-summary.test.ts` verifies the server; nothing verifies what the user sees when the server fails.
5. **No cross-layer consistency test for the duplicated lead-lifecycle vocabulary** (B-6). The pass-31 finance bug is direct precedent for why this matters.
6. **No test detects list truncation from the client's perspective** — backend tests confirm the clamp works but not that truncation is *discoverable*.

---

## G. FINAL GO / NO-GO

### 🔴 NO-GO for public release.

**Four release blockers are open, all confirmed with rendered-DOM or live-API evidence, all in the frontend:**

| ID | Blocker | Evidence |
|---|---|---|
| A-1 | 24 of 47 rendered form controls have no accessible name | axe (19 `select-name` + 5 `label`, critical) + DOM analysis |
| A-2 | ~25 modals: no dialog role, no focus move, no Escape, no trap, 82 background controls reachable | live modal interaction |
| A-3 | Focus indicator suppressed on primary nav and ~20 controls/view | rendered DOM + CSS specificity proof |
| A-4 | Students list truncates at 2 000 and reports "2000 of 2000" against a DB truth of 2 101; CSV export inherits it | live reproduction |

**A-1/A-2/A-3 together mean the application is not operable by keyboard or screen reader.** For an institutional ERP this is both an accessibility failure and, in many jurisdictions, a procurement blocker.

**Plus two items that are not code defects and cannot be closed by me:**
- **GL-1 and GL-2 are UNVERIFIED and unverifiable in this environment** (§0.1 — Chromium installation is blocked; no print engine). Section D is the precise checklist. **Two specific print risks (unscoped `window.print()`, unscoped landscape `@page`) make GL-2 a likely FAIL — flagged for the tester, not claimed as defects.**
- **UX-14 awaits an owner ruling** (§E). The gap is real and reproduced end-to-end (a 6 000 AFN paying student with `phone = NULL`); the *rule* is a business decision.

### What is confirmed clean

Per the mandate, I did not re-litigate already-verified areas and found **no new regression** in any of them. Actively re-probed and **passing** this pass:

- **RBAC / object-level authorization** — six privileged endpoints attacked with a real low-privilege `teacher` token, **all 403** (C-1).
- **Dashboard server-authoritative metrics** — the pass-23/24 architecture held; the frontend derives nothing (C-3).
- **Visitors pagination + summary** — correct server-side implementation, accurate counts against 254 rows (C-2). It is the model Students should follow.
- **Login rate limiting** — working as designed (C-5).
- **Mutation error surfacing** — write paths correctly report failures (C-7).

### Answering the mandate's closing instruction directly

> *"If everything remaining is clean except the human/business decisions, say so explicitly."*

**It is not.** I cannot give that answer honestly. Beyond GL-1/GL-2 and UX-14, there are **four reproduced frontend blockers** (A-1 – A-4) and **five high/medium findings** (B-1 – B-5). Three of the four blockers are accessibility defects that no existing test can detect, and one (A-4) silently misreports data volume in a way that also corrupts a financial CSV export.

I did not inflate this count: **seven** hypotheses were investigated and **explicitly rejected** (Section C), and B-6 is recorded as a latent risk rather than promoted to a defect because I could not demonstrate wrong behaviour.

**Recommended sequence:** A-3 (smallest fix, largest keyboard win) → A-1 → A-2 (needs a shared Dialog primitive; touches ~25 files) → A-4 (server pagination with an authoritative total, following the Visitors pattern — **do not merely raise the limit**) → B-1 → B-2/B-3/B-4 → owner ruling on UX-14 → then GL-1/GL-2 by hand in a real browser with a real printer.

Per standing instruction, the terms *"defect-free"* and *"production-ready"* are not used, and are not applicable while these blockers remain open.

---

### Appendix — audit harness (all under `/tmp`, nothing added to the repository)

| File | Purpose |
|---|---|
| `/tmp/a11y/app.iife.js` | The real app rebundled by esbuild as a classic IIFE so jsdom will execute it |
| `/tmp/a11y/serve2.mjs` | Harness server on :4400 — serves the IIFE page, proxies `/api` → :4000 with cookie pass-through |
| `/tmp/a11y/audit.mjs` | Boots all 16 views against live data, runs axe-core, writes `/tmp/a11y/axe-results.json` |
| `/tmp/a11y/modal.mjs` | Clicks a real button, inspects dialog semantics / focus / Escape / trap |
| `/tmp/a11y/focus.mjs` | Injects the built stylesheet, counts controls that suppress focus with no replacement |
| `/tmp/a11y/probe.mjs` | Records the API calls a view makes, table row counts, pagination text |
| `/tmp/a11y/failpath.mjs` | Fault injection — forces a chosen endpoint to 500 and compares rendered output |
| `/tmp/a11y/html/*.html` | Archived rendered DOM for all 16 views plus modal states |

**No production code, migration, or test was modified in this pass. `git status` is clean.**
