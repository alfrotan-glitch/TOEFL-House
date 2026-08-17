# Visitor Subsystem — End-to-End UX Audit

**Date:** 2026-08-17 · **Scope:** Visitor/CRM frontend only · **Mode:** AUDIT ONLY — no production code modified
**Roles evaluated:** Receptionist · Counselor · Manager
**Method:** live environment (Vite :3000 + API :4000), 250 seeded leads, three real role tokens, DB reconciled against on-screen values.

> **Framing:** the pass-26 remediation left the *backend* correct. Almost every finding below is a case where the **UI misrepresents a correct backend** — the most dangerous class of defect, because the data is right and nobody notices the screen is wrong.

---

## Severity summary

| # | Rank | Finding |
|---|---|---|
| UX-1 | **CRITICAL** | Silent 100-lead truncation: headline KPIs wrong by 2.5×, search misses existing leads |
| UX-2 | **HIGH** | Registration form swallows every server error message |
| UX-3 | **HIGH** | Placement block discovered only after the full conversion form + payment details |
| UX-4 | **HIGH** | No permission-aware UI: counselors get a dead "Enroll" button and a generic 403 |
| UX-5 | **HIGH** | Stale date-of-birth placeholder advertises a format the server now rejects |
| UX-6 | **MEDIUM** | "Advance" is fire-and-forget: 409s produce no movement and no message |
| UX-7 | **MEDIUM** | Source filter covers 4 of 9 sources; 101/250 leads mislabeled "Other" |
| UX-8 | **MEDIUM** | Lost leads still counted as open pipeline; conversion rate structurally understated |
| UX-9 | **MEDIUM** | No duplicate-lead warning before submit |
| UX-10 | **MEDIUM** | Placement status effectively invisible outside one button label |
| UX-11 | **MEDIUM** | Kanban forces a 1200px canvas and is the default view |
| UX-12 | **LOW** | Terminology drift: convert / enroll / register / visitor / lead used interchangeably |
| UX-13 | **LOW** | No loading state on the visitors screen |
| UX-14 | **LOW** | Required-field contract differs between client and server |

---

## UX-1 — CRITICAL · Silent 100-lead truncation

**Where:** `src/apiStore.ts:289` — `api.get<Visitor[]>('/visitors', { ...bq, limit: '100' })`
**Live evidence:** as registrar, `GET /api/visitors?limit=100` returned **100 rows** with response header **`X-Total-Count: 250`**. Nothing in the frontend reads that header.

Every number and every interaction on the screen is computed from the truncated array (`VisitorsView.tsx:79-92`, client-side `filteredVisitors` at 84-92):

| On-screen | Shows | Truth | Error |
|---|---|---|---|
| Total leads | 100 | 250 | −60% |
| Enrolled | 27 | 27 | correct by luck |
| Conversion | **27%** | **11%** | **2.5× overstated** |

**User impact.** *Manager:* makes staffing and ad-spend decisions on a conversion rate that is 2.5× too high, and the error is invisible because the tile looks authoritative. *Receptionist:* searches a returning walk-in — I confirmed `Lead Person 249` exists in the DB (phone `0700100249`) but is absent from the loaded page, so the screen renders **"No visitors match this search."** The natural next action is to register the person again, creating the exact duplicate the 409 was built to prevent. *Counselor:* the follow-up queue silently omits 150 leads, so overdue contacts are never worked.

There is no page control, no "showing 100 of 250", no infinite scroll. Nothing tells the user data is missing.

**Simplest production-grade fix.** Push search, filter and counts to the server — consistent with the standing pass-23 rule that the frontend must never re-derive authoritative metrics:
1. Send `search`/`status`/`source` to `GET /api/visitors` and render whatever comes back.
2. Read the existing `X-Total-Count` header for a real paginator and a "showing X of Y" label.
3. Add a `GET /api/visitors/summary` returning server-computed `total`/`pipeline`/`enrolled`/`conversionRate`/`overdue`; the tiles render those numbers only.

Do **not** just raise `limit` — that reproduces the same defect at 1000 leads.

---

## UX-2 — HIGH · The registration form swallows every server error

**Where:** `src/components/visitors/AddVisitorForm.tsx:76` reads `err?.response?.data?.error` (an Axios shape). `src/api/client.ts` is **fetch**-based and throws `ApiError` with `.status`/`.message` — there is no `.response` property anywhere in the codebase.

**Evidence:** simulating `ApiError(409, 'A visitor with this Tazkira/ID number already exists.')` through the component's own expression yields `undefined`, so the UI falls back to **"Could not save visitor."**

Duplicate Tazkira, invalid date, over-long name, branch violation — all collapse into one unactionable sentence on the receptionist's most-used screen. The user cannot tell which field to fix and will retry the same input. The sibling modals already do this correctly (`ConvertToStudentModal.tsx:137`, all of `PlacementTestModal.tsx`), so the fix is a one-line alignment:

```ts
const msg = err?.message || err?.response?.data?.error || 'Could not save visitor.';
```

---

## UX-3 — HIGH · Placement block revealed only at the end

**Live evidence:** with `pv1` set to `requirementMode: 'required'`, a receptionist opens Convert on unassessed lead `v_ux_1`, sees the complete form — class picker, fee, discount, payment amount, payment method — fills it, clicks Confirm, and only then receives:

> `Placement assessment is required for the selected program before enrollment.`

The backend is right to refuse. The UI is wrong to ask for money first. `ConvertToStudentModal` never reads `visitor.placementStatus`, and `VisitorsView.tsx:305-306` renders the Enroll/Advance affordance regardless.

**Impact.** The receptionist has often already *collected cash* by the time the screen refuses, in front of the student. Recovery means sending the applicant to placement and re-entering everything.

**Fix.** When the selected program requires placement and `placementStatus !== 'completed'`, replace the modal body with a short explanation and a single **"Book placement test"** button that opens `PlacementTestModal`. Cost: one conditional at the top of the modal.

---

## UX-4 — HIGH · No permission-aware UI

**Evidence:** `grep -ci 'activeRole|permission|role'` returns **0** for `VisitorsView.tsx`, `VisitorDeskPanel.tsx` and `ConvertToStudentModal.tsx`. Live, the counselor token gets `403 You do not have permission to perform this operation.` on `POST /visitors/:id/convert` — *after* filling in class, fee, discount and payment.

Every role sees an identical screen. A counselor is invited to do work the system will refuse, and the refusal names no permission, no owner, and no next step.

**Fix.** Gate the action on the permission the backend already enforces (`Lead.Convert`): hide the button, or disable it with the tooltip "Only the registrar can enroll a lead." Surface `err.message` on the 403 as well.

---

## UX-5 — HIGH · Date-of-birth placeholder contradicts the server

**Where:** `AddVisitorForm.tsx:171` — placeholder `"e.g. 2002-07-15 or 24"`. `visitors.routes.ts:338` now calls `assertOptionalIsoDate`.
**Live:** `dob:"24"` → `400 Date of birth must be a valid date in YYYY-MM-DD format.`; `dob:"2002-07-15"` → created `V-1001`.

The form actively instructs a format the API rejects. Combined with UX-2 the user sees only "Could not save visitor." with no clue that the age field is at fault. **This is a regression introduced by the pass-26 hardening** — the validator was tightened, the copy was not.

**Fix.** Correct the placeholder to `YYYY-MM-DD` and use `<input type="date">`; if age-in-years entry is genuinely wanted, add a separate Age field and convert client-side.

---

## UX-6 — MEDIUM · "Advance" gives no feedback

`VisitorsView.tsx:306` calls `advanceVisitorStage(v.id)` with no `await`, no `try/catch`, no toast, no confirmation. `apiStore.ts:686-698` deliberately sends `fromStage` as a concurrency token (the V-7 fix).

**Live:** first advance → `{"ok":true,"from":"lead","to":"inquiry"}`; an immediate second click → `{"error":"Visitor stage changed concurrently; reload and retry."}`. The rejected promise is unhandled, so **the card does not move and no message appears**. The user concludes the button is broken and clicks repeatedly. There is also no confirmation on success and no undo — a misclick silently advances a real lead.

**Fix.** `await` inside a `try/catch`; toast `err.message` on failure and reload; disable the button while in flight. Label it with the destination — "Advance → Inquiry" — so the click is predictable.

---

## UX-7 — MEDIUM · Source filter and badges cover 4 of 9 sources

Backend allows `ads, friend, social, other, referral, event, organic, walk_in, facebook` (`visitors.routes.ts:81`). The filter (`VisitorsView.tsx:218`) and `AddVisitorForm.tsx:112` offer only `social, ads, friend, other`. `SOURCE_BADGES` (97-102) has the same four keys with an `|| SOURCE_BADGES.other` fallback at line 237.

**Live count on 250 leads:** `walk_in` 51 + `referral` 50 = **101 leads that cannot be isolated by source and are displayed as "Other"**. Worse, `friend` is *labeled* "Referral", so the genuine `referral` rows are mislabeled while a different source occupies their name. A manager reviewing channel performance sees ~40% of leads bucketed into "Other" and would conclude walk-ins and referrals produce nothing.

**Fix.** Derive both the dropdown and the badge map from one shared source-of-truth list matching the server enum, and rename `friend` → "Friend / word of mouth".

---

## UX-8 — MEDIUM · Lost leads count as open pipeline

`leadPipelineStatus` (`VisitorsView.tsx:70`) reads `status`, falling back to `stage`. But `status` and `stage` are independent: advancing a lead to `stage='lost'` leaves `status='visited'`.

**Live:** advanced `v_ux_25` to `lost` → `{"ok":true,"from":"lead","to":"lost"}`; the API then returns `status: visited, stage: lost`, and `leadPipelineStatus` resolves to `visited`, i.e. **counted in "In pipeline"**. The kanban shows it under "Lifecycle"/Closed while the tile counts it as open. Dead leads also stay in the conversion denominator, permanently understating the rate — the opposite bias to UX-1, so the two errors mask each other.

Related: the "Lifecycle" kanban column merges `enrollment, active, graduated, alumni` **and `lost`** — won and lost outcomes in one pile.

**Fix.** Treat `stage === 'lost'` as terminal in `isPendingLead`/`isConvertedLead`, exclude it from the conversion denominator, and give "Lost" its own column. Best computed server-side per UX-1.

---

## UX-9 — MEDIUM · No duplicate warning before submit

`grep` across `src/components/visitors/` returns **zero** matches for duplicate / already exists / similar / possible match. The only defense is the server 409 — whose message UX-2 discards. Returning walk-ins are therefore re-registered silently.

**Fix.** Debounced lookup on phone/Tazkira blur showing "Possible existing lead: Ahmad Zia · 0700…123 · last visit 12 Aug" with an **Open instead** link.

---

## UX-10 — MEDIUM · Placement status is invisible

`placementStatus` reaches the UI in exactly one place: `VisitorDeskPanel.tsx:164`, as a button label flipping between "Assessment Workspace" and "Re-assess". It is absent from the list, the kanban cards, and the detail header. A counselor cannot answer "who still needs assessment?" without opening leads one at a time — and per UX-3 that state also gates enrollment.

**Fix.** Add a placement chip (Not assessed / Booked / Completed · score) to the list row and kanban card, plus a "Needs assessment" filter.

---

## UX-11 — MEDIUM · Kanban is unusable below ~1300px and is the default

`VisitorsView.tsx:54` defaults `crmViewMode` to `'kanban'`; line 259 sets `grid-cols-5 min-w-[1200px]`. The five columns never collapse, so on a laptop at 1280px and on any tablet the board is a horizontal-scroll maze, with the stat grid above already reflowing to 2 columns. The first thing a user sees on a small screen is a clipped board.

**Fix.** Default to list on narrow viewports (or make list the default outright) and let the board scroll one column at a time with snap points.

*(Note: GL-1 — real browser inspection at 1920×1080 and a smaller viewport — remains a human step and is **not** claimed as verified here. This finding is from the layout constraints in source, not from viewing pixels.)*

---

## UX-12 — LOW · Terminology drift

One action carries four names: button **"Enroll"** (`VisitorDeskPanel.tsx:165`) opens **ConvertToStudentModal**, whose result the tile calls **"Enrolled"** and the filter calls **"Registered"**, over a backend field `status='registered'` and stages `registration`/`enrollment`. Meanwhile the header says "CRM & lead pipeline" while every row says "visitor", and the status filter maps "Pending"→`visited`.

Staff cannot map spoken words to screen words to backend states; handover instructions ("mark him registered") are ambiguous. **Fix:** pick one verb per concept — *Lead* → *Enroll* → *Student* — and apply it across labels, filters and headings.

---

## UX-13 — LOW · No loading state

No `isLoading`/skeleton/spinner in `VisitorsView.tsx`. During the initial fetch the screen renders zero leads with "No visitors match this search." (line 235) — an empty result and a pending request are visually identical, so a slow network looks like an empty branch. **Fix:** skeleton rows while pending; reserve the empty copy for a genuinely empty response, and distinguish "no leads yet" from "no matches for this filter" with a Clear filters action.

---

## UX-14 — LOW · Client and server disagree on required fields

`AddVisitorForm.tsx:60` blocks submit without `fullName` **and `phone`**, labeling both required (96-101). `visitors.routes.ts:326` requires only gender and source. Phone is thus enforced by UI convention only: leads created by any other path can lack one, and the list/follow-up UI must tolerate blank phones (`filteredVisitors` calls `v.phone.includes(...)` unguarded — safe only while every row happens to have one). **Fix:** decide the contract and enforce it server-side.

---

## Verified good — not findings

- `todayIso` uses `toLocaleDateString('en-CA')` (`VisitorsView.tsx:66-69`): the V-9 fix holds, OVERDUE is correct in Asia/Kabul.
- `ConvertToStudentModal` fee math (110-118) correctly nets discount before payment and guards overpayment at 121-140.
- `PlacementTestModal` surfaces real server messages throughout.
- `apiStore.advanceVisitorStage` correctly sends `fromStage` — the concurrency token works; only its error handling is missing (UX-6).

## Recommended sequence

1. **UX-1** — server-side search/filter/pagination + summary endpoint. Fixes the wrong KPIs and the duplicate-creating search in one change; UX-8 folds into it.
2. **UX-2 + UX-5** — two-line fixes removing the worst daily friction on the busiest screen.
3. **UX-3 + UX-4** — stop inviting users into actions that will be refused.
4. **UX-6, UX-7, UX-9, UX-10** — feedback and visibility.
5. **UX-11 → UX-14** — polish.

Items 1-4 are what separate "the backend is correct" from "the staff can trust the screen".

---

*Audit only; no production code was modified. GL-1 (browser visual inspection) and GL-2 (printed fee bill) remain open human verification steps and are not claimed as verified.*

---

# REMEDIATION RECORD — UX-1 … UX-5

**Date:** 2026-08-17 · **Scope:** UX-1…UX-5 only. UX-6+ deliberately untouched.
**Rule applied:** fix the root cause at the correct server/domain layer, never with a frontend workaround.

## What changed

| # | Root cause | Fix (layer) |
|---|---|---|
| **UX-1** | The client fetched a fixed 100-row page, then searched, filtered and counted inside that array. | **Server.** New `core/visitors/visitor-query.ts`: SQL search/filter/pagination + `buildVisitorSummary` (aggregates over the whole scoped table). New `GET /visitors/summary`. `GET /visitors` now filters in SQL and returns `X-Total-Count` (matches) and `X-Unfiltered-Count` (population). The view renders server figures and derives none. |
| **UX-2** | `AddVisitorForm` read the Axios shape `err.response.data.error`; the fetch client throws `ApiError` with `.message`. | **Client, one line.** Reads `err.message` first, matching the sibling modals. |
| **UX-3** | Placement was enforced only at write time, after the fee/payment form. | **Server.** New `core/visitors/conversion-eligibility.ts` + `GET /visitors/:id/conversion-eligibility`. It owns **no policy** — it calls into `resolveGoverningProgramVersionId` → `resolvePlacementRequirement` → `evaluateEnrollmentEligibility`, the same three functions the write path uses, so it can never green-light what Confirm would refuse. The modal checks on open and on class change, and fails **closed** if the check errors. |
| **UX-4** | Zero permission awareness in the visitor UI. | **Client + server.** UI gates on the exact codes the routes require (`Lead.Create`/`Lead.Edit`/`Lead.Convert`) via the existing `hasPermission`. The new preview endpoint is guarded by `Lead.Convert` and `requireVisitor`, so it cannot be used to probe placement policy. |
| **UX-5** | Placeholder advertised `"2002-07-15 or 24"`; the server had been hardened to `assertOptionalIsoDate`. | **Client.** `<input type="date" max={today}>`; label and helper text state YYYY-MM-DD. `maxLength` on every text field now mirrors the server's `TEXT_LIMITS`. |

Two defects found *while* fixing were also corrected, both inside UX-1's blast radius:
- **UX-8 (lost leads):** `stage='lost'` leaves `status='visited'`, so dead leads counted as open pipeline. All buckets now treat `COALESCE(stage,'lead')='lost'` as terminal.
- **UX-7 (source vocabulary):** new `src/config/visitorSources.ts` is the single list mirroring the server's nine-value enum; the summary returns a real `bySource` GROUP BY. `friend` is no longer mislabelled "Referral".

## Live verification (250-lead dataset)

| Metric | Before | After | Truth |
|---|---|---|---|
| Total leads | 100 | **251** | 251 |
| Conversion | 27% | **11%** | 11% |
| Search "Lead Person 249" | *No visitors match this search* | **1 row found** | exists |
| Convert refusal | after fee + payment entry | **before the form** | — |
| Counselor preview / convert | button shown, 403 at submit | **403 at both; button hidden** | — |
| `dob:"24"` | rejected, message swallowed | rejected, **date input prevents entry** | — |
| Duplicate Tazkira | "Could not save visitor." | **"A visitor with this Tazkira/ID number already exists."** | — |

Adversarial probes: `' OR 1=1--`, `'; DROP TABLE visitors;--`, bare `%` and `_` all return 0 rows with the table intact (parameters bound, LIKE metacharacters escaped). `?branchId=<other>` and `?branchId=all` are re-scoped to the caller's own branch for a registrar; only the owner gets organization scope.

## Test quality

31 new tests in `server/src/tests/visitor-ux-remediation.test.ts`. **Mutation-tested: 12 mutants, 12 killed.**

M7 — *preview resolves the program from the visitor row instead of the class level* — **initially SURVIVED**. Every existing case had the visitor carrying the governed program, so a preview with the V-1 defect shape still gave the right answer by accident. A test was added for a class-governed/visitor-detached lead; M7 is now killed. This is recorded because it is exactly the false-confidence gap mutation testing exists to find.

Killed mutants: filters ignored · conversion rate over a page · lost counted as pipeline · NULL stage dropped · LIKE metacharacters unescaped · preview always eligible · preview ignores class level · lifecycle blockers skipped · preview loses `Lead.Convert` · preview loses branch isolation · summary ignores branch scope · `X-Total-Count` = page length.

## Gates

1173/1173 tests (was 1142) · server lint **0 errors** (104 warnings, pre-existing) · frontend lint **0 errors** (6 warnings; baseline 5, +1 inherent async-fetch pattern) · both builds ✓ · `preflight:fresh-schema` SUCCESS (71 migrations, no drift) · `release-validate.mjs` **16/16 PASSED**.

No migration was added or modified. RBAC, branch isolation, financial and placement invariants are unchanged — the placement rule in particular gained a read-only caller, not a second implementation.

## Still open

UX-6, UX-9 … UX-14 are untouched by request. **UX-14** (client requires phone, server does not) intersects UX-2's "labels must match backend validation" but is a *contract* decision, not a copy fix — it needs a server-side ruling on whether phone is mandatory, so it stays open rather than being resolved by weakening the form.

**GL-1** (browser visual inspection at 1920×1080 and a smaller viewport) and **GL-2** (one actual printed fee bill) remain human-only steps and are **not** claimed as verified.
