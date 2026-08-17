# Visitor UX — Second Audit Pass (UX-6 … UX-14)

**Date:** 2026-08-17 · **Base commit:** `85c4586` · **Mode:** AUDIT ONLY — no production code modified
**Method:** every finding re-verified independently against current source and a live environment (API :4000, Vite :3000, 250 seeded leads, three real role tokens: registrar / counselor / manager).

> **Regression check first:** UX-1…UX-5 all hold at `85c4586`. Summary returns `total 250 · rate 11% · pipeline 223 · overdue 32`; search for "Lead Person 249" returns 1 row; the conversion preview returns `placement_required`; the counselor is 403 on the preview endpoint. **No regressions found in UX-1…UX-5** — but two *new* defects were found in code paths my own remediation touched, recorded below as N-1 and N-2.

---

## Reclassification table

| # | Original finding | Verdict | Evidence |
|---|---|---|---|
| **UX-6** | Advance is fire-and-forget; 409s silent | **Confirmed** | `VisitorsView.tsx:429` still `onClick={() => advanceVisitorStage(v.id)}` — no `await`, no `catch`, no toast. Live: 2nd click → `{"error":"Visitor stage changed concurrently; reload and retry."}` |
| **UX-7** | Source filter 4 of 9; 101/250 mislabelled | **Already Fixed** | `src/config/visitorSources.ts` shared by form + filter + badges. Live: all 9 sources filterable. *Residual:* no test locks UI list to server enum (see N-4). |
| **UX-8** | Lost leads counted as open pipeline | **Partially Fixed** | Metrics correct (`pipeline 222 · lost 1`). **But** `leadPipelineStatus()` at `:126` still ignores `stage`, so a lost lead's row badge reads **"In follow-up"** and still offers **"Enroll now"**. |
| **UX-9** | No duplicate warning before submit | **Confirmed — worse than documented** | Zero warning strings. Live: re-posting name `Lead Person 100` + phone `0700100100` **created V-1001**; two rows now share that phone. No server 409 for name+phone (only Tazkira is unique). |
| **UX-10** | Placement status nearly invisible | **Confirmed — now half-wired** | Still only the button label at `VisitorDeskPanel.tsx:186`. The **server filter I added in UX-1 works** (`?placement=needs_assessment` → 251) but **no UI control exposes it**. |
| **UX-11** | Kanban forces 1200px; is the default | **Confirmed** | `:67` default `'kanban'`; `:382` `grid-cols-5 min-w-[1200px]`. Unchanged. |
| **UX-12** | Terminology drift | **Confirmed** | One action is "Enroll now" / "Enroll" / "Finalize enrollment" / "Convert … to student"; headers "CRM & lead pipeline" vs "Applicant status & lead bank" vs "New visitor". |
| **UX-13** | No loading state | **Mostly Fixed** | List view has `isFetching` + three distinct empty states (`:310`, `:351`). **Gap:** the kanban branch has neither (see N-1). |
| **UX-14** | Client/server required-field mismatch | **Confirmed + server message is wrong** | Live: `{fullName, gender, source}` with **no phone → created V-1002**. Omitting gender returns *"Full name, gender, and source are required."* — but `:401` only checks gender/source, so it **names a field that was supplied**. |

### New findings

| # | Finding | Severity |
|---|---|---|
| **N-1** | Kanban column counts are computed from the 25-row page — the **default view** contradicts the correct KPI tiles above it | **Critical** |
| **N-2** | Counselors cannot see *why* a lead is blocked — the placement banner is gated on `Lead.Convert`, which they lack, yet they are authorized to run placement | **High** |
| **N-3** | `Lead.Assign` / `assignedTo` has no UI at all — lead ownership is invisible and unassignable | **Medium** |
| **N-4** | No test locks the UI source vocabulary to the server enum (UX-7 can silently regress) | **Medium** |
| **N-5** | Visitor tab double-fetches: store prefetch + view effect = 4 requests where 2 suffice | **Low** |
| **N-6** | Toast auto-dismisses in 4s with no manual close; the 167-char placement message is unreadable in time | **Medium** |
| **N-7** | Zero accessibility affordances across all five visitor components | **High** |

---

## N-1 — CRITICAL · The default view still counts a page

`VisitorsView.tsx:382-391`. The board buckets `filteredVisitors` — which after UX-1 is **one 25-row page** — into five columns and prints `colVisitors.length` as each column badge.

**Live, 250 leads:**

| | Kanban badge | DB truth |
|---|---|---|
| New | **21** | 223 (`lead` 222 + `inquiry` 1) |
| Lifecycle | **4** | 28 (`enrollment` 27 + `lost` 1) |

Kanban is the **default view** (`:67`). So the first screen a manager sees shows "Total leads 250" in the tile strip and "New: 21" on the board directly beneath — two contradictory numbers, one screen. This is the *same defect class* as UX-1; my fix corrected the tiles and the list but left the board deriving its own counts.

There is also no paginator in the kanban branch, so columns silently show only page 1 with no way to reach the rest.

**Fix:** extend the summary with a per-stage `byStage` GROUP BY (the module already does `bySource`) and render column badges from it; either page the board per column or state "showing 25 of 223".

---

## N-2 — HIGH · The role who can unblock the lead is the one kept uninformed

`VisitorDeskPanel.tsx:204` — `{canConvertLead && eligibility && !eligibility.eligible && …}`.

Verified role matrix (`/auth/me`):

| Role | Lead.View | Lead.Create | Lead.Edit | Lead.Convert | Lead.Assign |
|---|---|---|---|---|---|
| registrar | ✓ | ✓ | ✓ | ✓ | — |
| **counselor** | ✓ | ✓ | ✓ | **—** | ✓ |
| manager | ✓ | ✓ | ✓ | ✓ | ✓ |

Live: counselor `GET /api/placement/visitors/v_ux_1/placement` → **200**, `POST …/placement/attempts` → **400** (validation, not 403). **The counselor is authorized to run placement assessments** — but because they lack `Lead.Convert`, my UX-4 gate hides the banner that says *"Placement assessment is required…"*. The person whose job is to unblock the lead cannot see that it is blocked.

**Fix:** gate the *Enroll button* on `Lead.Convert`, but show the eligibility banner to anyone with `Lead.View`. Blockers are information, not actions.

---

## N-7 — HIGH · No accessibility affordances at all

Counts across `VisitorsView`, `AddVisitorForm`, `ConvertToStudentModal`, `VisitorDeskPanel`, `PlacementTestModal`:

```
aria-*: 0   htmlFor: 0   role=: 0   onKeyDown: 0   Escape handler: 0   autoFocus: 0
```

Concrete consequences:
- **17 labels, 16 inputs, zero `htmlFor`/`id` pairs** in the registration form — a screen reader announces every field unnamed.
- Table rows (`:360`) and kanban cards (`:410`) are clickable `<tr>`/`<div>` with no `tabIndex`, `role="button"` or key handler — **the visitor workspace is unreachable by keyboard**.
- Icon-only close buttons (`AddVisitorForm:100`, `ConvertToStudentModal:228/280`, `PlacementTestModal:237/260`) have no accessible name — announced as "button".
- Four modals with no `role="dialog"`, no focus trap, no Escape-to-close.

This is a **hard blocker for public-sector or donor procurement**, which typically requires WCAG 2.1 AA.

---

## UX-8 residual — the row still contradicts the metrics

Live: `v_ux_25` advanced to `stage='lost'` → summary correctly reports `lost 1`, `pipeline 222`. But the API returns `status='visited', stage='lost'`, and `leadPipelineStatus()` reads only `status`, so:

- row badge → **"In follow-up"** (for a dead lead)
- `isPendingLead()` → true → row renders **"Enroll now"**

Clicking it is *not* harmful — my UX-3 preview catches it (`code: lead_lost`, "This lead is closed (lost). Reopen it before converting.") and the modal refuses to show the form. So this is **misleading, not dangerous**: wasted clicks and a false sense that a dead lead is live. Also, the kanban "Lifecycle" column still merges `enrollment, active, graduated, alumni` **and `lost`** — won and lost in one bucket.

---

## UX-9 residual — duplicate creation is trivially reproducible

The only uniqueness rule is on Tazkira (`visitors.routes.ts:170`). Tazkira is in the collapsed "advanced" section and is optional, so the common walk-in path has **no duplicate protection at all**. Live proof: identical `fullName` + `phone` created a second row (`V-2100` and `V-1001` both `0700100100`).

The search that would let a receptionist *find* the existing lead now works (UX-1), but nothing prompts them to look.

**Fix:** debounced `GET /visitors?search=<phone>` on phone blur → inline "Possible existing lead: Lead Person 100 · V-2100 · last visit 2026-01-01 — Open instead".

---

## UX-14 residual — and a wrong error message

Two separate problems:
1. **Contract mismatch:** the form requires phone; the server does not. A phoneless lead is creatable via the API and renders as an empty cell (`:362`). *Note:* the old crash risk is gone — UX-1 moved search server-side, so the unguarded `v.phone.includes()` no longer exists. Verified: searching "No Phone Lead" returns the row with `phone: None` without error.
2. **Misleading message:** `:401` throws *"Full name, gender, and source are required."* while only testing gender and source. Live: a request **with** a full name but no gender returns that sentence — it accuses a field the user filled in. This directly undercuts the UX-2 fix, which was about making server messages actionable.

---

## Prioritized remediation list

| Rank | Item | Why this order | Simplest production-grade fix |
|---|---|---|---|
| **1** | **N-1** kanban counts from a page | Same defect class as UX-1, on the **default view**; manager sees two contradictory totals at once | Add `byStage` to `buildVisitorSummary` (mirrors existing `bySource`); render badges from it; page or label the columns |
| **2** | **N-2** counselor can't see the blocker | Regression from my UX-4 fix; blocks the role that resolves it | Gate the banner on `Lead.View`, keep the button on `Lead.Convert` |
| **3** | **UX-6** Advance has no feedback | Silent failure trains users to double-click, which is what triggers the 409 | `await` in `try/catch`; toast `err.message`; disable while in flight; label "Advance → Inquiry" |
| **4** | **UX-9** no duplicate warning | Live-proved duplicate creation on the busiest path | Debounced phone lookup + "Open instead" link |
| **5** | **N-7** accessibility | Procurement blocker; large but mechanical | `htmlFor`/`id` pairs, `role="dialog"` + Escape, `aria-label` on icon buttons, make rows/cards real buttons |
| **6** | **UX-8** residual row semantics | Misleading, not dangerous (UX-3 preview catches it) | Teach `leadPipelineStatus()` about `stage='lost'`; give Lost its own kanban column |
| **7** | **UX-10** placement invisible | Server filter already exists — only the UI control is missing | Placement chip on row/card + wire the `placement` filter select |
| **8** | **UX-14** contract + wrong message | Needs a policy decision, then a one-line message fix | Decide if phone is mandatory, enforce server-side; correct `:401` to name only the fields it checks |
| **9** | **N-6** toast too brief | Undercuts the UX-2 fix for long messages | Manual dismiss + longer duration for `type='error'` |
| **10** | **UX-12** terminology | Pervasive but low-harm; cheap once decided | One verb per concept: *Lead → Enroll → Student* |
| **11** | **UX-11** responsive kanban | Real, but list view is a workable escape hatch | Default to list on narrow viewports; snap-scroll columns |
| **12** | **N-3** `Lead.Assign` has no UI | Whole permission is dead weight | Assignee column + "Assign to me"; or drop the permission |
| **13** | **N-4** no enum-parity test | Prevents UX-7 silently regressing | One test asserting UI list === server `VISITOR_SOURCES` |
| **14** | **N-5** double-fetch | Wasteful, not user-visible | Let the view own the query; drop `reloadVisitors()` from the tab prefetch |

**Recommended first slice:** items 1-4. N-1 closes the last instance of the count-from-a-page defect class, N-2 repairs a regression I introduced, and UX-6 + UX-9 remove the two loudest sources of daily friction and bad data.

---

*Audit only; no production code was modified this pass. UX-1…UX-5 re-verified and holding. GL-1 (real browser inspection at 1920×1080 and a smaller viewport) and GL-2 (one actual printed fee bill) remain open human-only steps and are **not** claimed as verified — in particular, UX-11 and N-7 are assessed from source, not from rendered pixels or a screen-reader session.*
