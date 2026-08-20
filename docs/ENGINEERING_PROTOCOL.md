# TOEFL House — Engineering Protocol v2

**Status:** active. This document governs how changes are made to this repository.
**Supersedes:** Protocol v1 (the 58-phase single-pass protocol).
**Adopted:** 2026-08-20.

---

## 0. The one-paragraph version

Work is done one **Work Package** at a time, never "the whole ERP". Each pass runs a
14-stage lifecycle. Irreversible actions (deletion, schema migration, finance/RBAC
changes) stop at a **CHECKPOINT** before executing. Every PASS carries a **verbatim
artifact** — a command and its real output — not a description of one. A structurally
separate **INDEPENDENT REVIEW** cold-reads the diff and the evidence. Certification is
per Work Package, with three outcomes, and the weakest Critical/High dimension decides.

---

## 1. Extend or rebuild? — the standing default, and the recorded exception

Protocol v2 asks this to be answered explicitly rather than assumed. It is:

**The standing default is EXTEND.** `CHALLENGE` returns KEEP or REFACTOR unless a
subsystem fails on a specific named ground. REBUILD is something a Work Package earns,
not a starting posture.

**One scoped exception is on record.** For the Finance Category / Budget model
(Work Package **WP-07 Finance**), the owner directed a clean-slate rebuild on
2026-08-20, on the stated ground that the system is pre-operational and holds no
production financial data. That exception:

* is **scoped to WP-07's category and budget-line model only**;
* does **not** extend to Payroll, Treasury, RBAC, Calendar, Payments or Invoices, all of
  which were explicitly fenced off and remained extend-only during that work;
* is **spent**. It does not carry forward. The next Finance change starts at EXTEND
  again unless a new exception is recorded in the Decision Log.

Anything that is not written in the Decision Log is not an exception.

---

## 2. What this repository actually is (DISCOVER findings, evidence-backed)

Protocol v2 correctly flags several things as unknowns rather than assuming them. They
are answered here from the code, once, so no future pass has to re-derive them.

| Question v2 raises | Answer | Evidence |
|---|---|---|
| Which currency? | **AFN only.** No second currency anywhere. | `src/utils/format.ts` — `formatAFN` is the only currency formatter |
| Rounding / precision | **Stored to 2 decimal places, displayed with 0.** `assertMoney` rounds to 2dp and database triggers reject a third (`trg_payments_money_scale_*`, `trg_fin_tx_money_scale_*`). The UI formatter uses `maximumFractionDigits: 0`. | `server/src/utils/money.ts`, `server/src/db/schema.sql`, `src/utils/format.ts` |
| Cash-settled? | Predominantly. `payment_method ∈ (cash, card, bank_transfer)`, cash is the default everywhere. | `schema.sql` payments/expense_requests |
| Calendar | **Solar Hijri (Jalali) is first-class, and storage is single-form.** Dates are stored as ISO-8601 Gregorian strings; *period* arithmetic (month/quarter boundaries, payroll periods) is Jalali and lives behind one server authority. | `server/src/core/calendar/periods.ts` (authority), `src/utils/jalali.ts` (display), `server/src/tests/jalali-calendar.test.ts` |
| Multiple stored date forms? | **No.** One canonical stored form, locale-specific display. This is the shape that avoids the "same period means different things in different modules" bug. | `today()` returns ISO; `periodBoundaries()` converts |
| RTL / bilingual UI | **v2's assumption is only half right, and the correction matters.** The chrome is deliberately and consistently **LTR/English** (`<html lang="en">`, `dir="ltr"` on every view root). Persian/Dari appears as *data* inside that shell — Jalali month names (`اسد ۱۴۰۵`), Persian digits, branding. | `index.html`, `src/App.tsx`, 10 frontend + 8 backend files contain Arabic-script literals |
| ⇒ so what is the real requirement? | Not "RTL layout correctness". It is **bidirectional text embedding**: Persian labels and Persian-Indic digits rendered inside LTR containers, where punctuation and digit ordering can invert. That is narrower, concrete and testable. | see Known Gaps, §9 |
| Backup precondition for migrations | **Already automatic.** The migration runner takes a `VACUUM INTO` snapshot before the first pending migration and keeps 10. | `server/src/db/migrate.ts` — `backupBeforeMigrations()` |
| Migration reversibility | **Forward-only. There are no `down` scripts.** The snapshot above is the only rollback. This is why CHECKPOINT exists. | `server/src/db/migrations/` |

---

## 3. Work Packages

Protocol v2's suggested list was drawn from a domain description, not from this
repository. Mapped against the real route and core surface (35 route modules, 12 core
domains), it omits roughly a third of the system. This is the corrected map — every
route module appears exactly once.

| # | Work Package | Route modules | Core modules |
|---|---|---|---|
| WP-01 | Org & Configuration | `branches`, `settings`, `rules`, `catalog` | `configuration` |
| WP-02 | Identity & Access | `auth`, `users`, `security` | `rbac` |
| WP-03 | Students & Admissions | `students`, `visitors`, `journey` | `students`, `visitors`, `journey` |
| WP-04 | Placement | `placement`, `placement-attempt`, `placement-test-bank` | `placement` |
| WP-05 | Academic Structure | `academic`, `classes`, `offerings`, `enrollment`, `waitlist`, `skills`, `teachers` | `academic` |
| WP-06 | Academic Delivery | `sessions`, `exams` | `academic` (gradebook, attendance) |
| WP-07 | **Finance** | `finance`, `invoices`, `discount-authorizations` | `finance`, `calendar` |
| WP-08 | **Payroll** | `teachers` (payroll routes) | `payroll` |
| WP-09 | Funding & Impact | `funding`, `impact` | — |
| WP-10 | Books | `books` | — |
| WP-11 | Reporting & Analytics | `reports`, `dashboard`, `bos`, `search` | `dashboard` |
| WP-12 | Workflow & Automation | `workflows`, `automations`, `events` | `events` |
| WP-13 | Audit | `audit` | — |

**WP-07 and WP-08 always carry the strictest evidence and sign-off burden**, whichever
package is nominally under audit, because every other package consumes them.

`teachers.routes.ts` deliberately spans WP-05 and WP-08 — it holds both teacher records
and payroll. A pass touching its payroll half inherits WP-08's rules.

---

## 4. The 14-stage lifecycle

Applied once per Work Package.

| Stage | Purpose | Exit criteria | Hard rule |
|---|---|---|---|
| **SCOPE** | Name the Work Package and its boundary. | Written boundary: in / explicitly out. | Nothing past this touches anything outside the boundary without re-scoping. |
| **DISCOVER** | Inventory what exists. | A literal inventory — file, table, endpoint lists. Not a summary. | Read-only. |
| **MODEL** | Reconstruct entities, states, flows from the **code**. | A domain model cross-checked against DISCOVER. | Doc/code disagreements are logged, not silently resolved either way. |
| **CHALLENGE** | Is this architecture the best one, on the evidence? | KEEP / REFACTOR / REBUILD per subsystem, one-line reason each. | Default KEEP or REFACTOR. REBUILD needs a named failure, not "could be cleaner" (§1). |
| **DECIDE** | Turn verdicts into a plan. | Exact files/tables/endpoints to add, change, remove + a Change Classification each. | Nothing executes. |
| **CHECKPOINT** | Gate for irreversible/high-risk work. | Statement of what will be deleted / migrated / changed financially, and why — **before** execution. | Mandatory for Deletion, Data Migration, Finance and RBAC changes. Skippable only for Bug Fix / UX Change with no schema or finance impact. |
| **IMPLEMENT** | Execute. | Diff matches the DECIDE plan, or deviations logged with reason. | No scope creep. |
| **VERIFY** | Run the real commands (§7). | Verbatim command + output. | "It passes" without output is not evidence. |
| **ATTACK** | Try to break it: retries, concurrency, malformed input, direct API calls bypassing the UI. | List of attempts and outcomes, **including successful breaks**. | Successful attacks go to REPAIR before anything proceeds. |
| **REPAIR** | Fix what ATTACK found. | Fix applied; re-scoped as a new IMPLEMENT if it outgrows the DECIDE plan. | — |
| **REVERIFY** | Re-run VERIFY. | Same bar as VERIFY. | — |
| **INDEPENDENT REVIEW** | Cold-read **only** the diff and the evidence artifacts. | PASS/FAIL per dimension (§8). | Not the same activity as ATTACK: ATTACK breaks the running system, REVIEW reads the change. See §5 for how this is made real rather than aspirational. |
| **CLEAN** | Remove residue from *this* pass. | Repo scan shows nothing left over. | Does not reach into other Work Packages. |
| **CERTIFY** | Issue a status. | READY / READY WITH TRACKED RISK / NOT READY. | — |

---

## 5. Making INDEPENDENT REVIEW real

Protocol v2 is right that self-certification is a structural blind spot, and right that
"try harder at self-doubt" does not fix it. But a separate *stage* performed by the same
agent in the same session is still self-review. Two things make it bite:

1. **Review from artifacts, not memory.** The reviewer works from `git diff <base>..HEAD`
   and the recorded command output — not from recollection of having written it. If a
   claim cannot be re-derived from the diff, it is not PASS.
2. **Findings become executable wherever possible.** A review finding that stays prose
   decays on the next pass. A review finding converted into a test, a static-audit rule,
   or a registry row cannot. This repository already works this way —
   `scripts/high-assurance-static-audit.mjs`, `scripts/verify-product-integrity.mjs`,
   `scripts/verify-registries.mjs` and the negative assertions in the test suite are all
   review findings that were made permanent. **Prefer that form.**

A review that produces only prose is a weak review, whatever its verdict.

---

## 6. Registries, Deletion Protocol, Change Classification

### Registries

Four artifacts live in `docs/registries/` and are **mechanically validated** by
`npm run audit:registries`, which is part of the release gate. They are not claims in a
report; a stale registry fails the build.

* `canonical-authority.md` — one row per critical concept: where it is stored, which
  module owns its rules, which endpoint serves it, who consumes it, which test guards it.
* `invariants.md` — one row per critical rule: owner layer, enforcement point, test,
  failure behaviour.
* `metrics.md` — one row per reportable number: formula, source, period, filters,
  aggregation, unit, precision, consumers, test.
* `decisions.md` — final architectural decisions, alternatives, evidence class,
  reversibility, approver. This is history and stays **out of source comments**.

### Deletion Protocol

All nine must hold before anything is deleted: no active import; no dynamic usage; no
runtime usage (feature-flagged and admin-only routes included); no build-time usage; no
test dependency; no migration dependency; no script dependency; no configuration
dependency; no legitimate operational dependency (fiscal-year-end-only reports and the
like).

Three hard rules:

* **Delete from the working tree, never from history.** Git is the archive. This is what
  makes "no renaming, no commenting out, no just-in-case" safe to follow.
* **Financial and audit data ROWS are categorically excluded.** They are never eligible
  for DEAD / UNUSED / OBSOLETE. Retention is governed separately. Code artifacts and
  data rows are different categories and are never handled by the same rule.
* **Migrations are append-only.** A shipped migration file is never edited or deleted —
  the release gate replays every one of them against a blank database. Obsolete *runtime*
  structures are removed by a **new** migration, never by rewriting an old one.

Any deletion touching Finance, RBAC or Auth requires CHECKPOINT regardless of how many
of the nine proofs pass.

### Change Classification

| Classification | CHECKPOINT | Backup precondition | INDEPENDENT REVIEW | Owner sign-off |
|---|---|---|---|---|
| Bug Fix | No | No | No | No |
| Refactor (no behaviour change) | No | No | If Finance/RBAC | No |
| Architecture Change | Yes | If schema | Yes | If Finance/RBAC |
| Behaviour Change | Yes | No | Yes | If Finance |
| Data Migration | Yes | **Always** (automatic, §2) | Yes | **Always** |
| Security Change | Yes | No | Yes | **Always** |
| Performance Change | No | No | If Finance | No |
| UX Change | No | No | No | No |
| Removal | Yes | If deleting data | Yes | If Finance/RBAC/Auth |
| Replacement | Yes | Yes | Yes | **Always** |

---

## 7. Verification commands

Generic CI verbs are not verifiable. These are the real scripts.

| Purpose | Command | Location |
|---|---|---|
| Frontend typecheck | `npm run typecheck` | repo root |
| Frontend lint | `npm run lint` | repo root |
| Server lint + both typechecks | `npm run lint` | `server/` |
| Server test suite | `npm test` | `server/` |
| Frontend production build | `npm run build` | repo root |
| Server production build | `npm run build` | `server/` |
| Fresh-schema / migration drift | `npm run preflight:fresh-schema` | `server/` |
| Registry validation | `npm run audit:registries` | repo root |
| Product integrity audit | `npm run audit:product` | repo root |
| High-assurance static audit | `npm run audit:static` | repo root |
| **Everything, in order** | `npm run release:validate` | repo root |

`release:validate` is the gate. It fails on the first problem and never averages.

---

## 8. Evidence, risk, certification

### Evidence classes

| Class | Bar |
|---|---|
| **PROVEN** | Command output **+** a test that specifically asserts the claim **+** confirmed at INDEPENDENT REVIEW. |
| **SUPPORTED** | Command output exists and is consistent with the claim, but no test asserts it directly, or review has not happened yet. |
| **PLAUSIBLE** | Reasoning only. No executed artifact. |
| **UNCERTAIN** | Conflicting signals with no resolution. |
| **CONTRADICTED** | Evidence disproves the claim. |

### Severity

**Critical** — can cause incorrect money, unauthorized access, or data loss.
**High** — can cause incorrect business state without direct financial/security exposure.
**Medium** — degrades correctness or usability without corrupting state.
**Low** — cosmetic. **Informational** — tracked, not actionable.

### Decision rule

Critical or High severity combined with **UNCERTAIN, CONTRADICTED or PLAUSIBLE** evidence
anywhere in Finance, Security, Data Integrity or RBAC/Auth → **automatic block**. No
override.

> v2 listed only UNCERTAIN and CONTRADICTED here. PLAUSIBLE is added deliberately:
> "reasoning only, no executed artifact" is exactly the state v2's central critique is
> aimed at, and leaving it unblocked reopens the hole.

Medium/Low findings may ship as READY WITH TRACKED RISK when logged in `decisions.md`
with an owner and a target date.

### Certification statuses

* **READY** — every Critical/High dimension PASS with PROVEN or SUPPORTED evidence.
* **READY WITH TRACKED RISK** — Critical/High PASS; all open items Medium/Low and logged.
* **NOT READY** — any Critical/High dimension FAIL, UNCERTAIN or CONTRADICTED.

### Gate

No averaging. The weakest Critical/High dimension controls the result. One Critical FAIL
or UNVERIFIED → NOT READY regardless of the rest of the table.

### Owner sign-off, always

Any Finance-logic change · any RBAC/permission change · any schema migration touching
existing data · any bulk deletion.

---

## 9. Where this protocol still has gaps

Recorded rather than hidden, because an unstated gap is the thing v2 exists to prevent.

1. **INDEPENDENT REVIEW is performed by the same agent.** Mitigated by §5, not solved.
   The strongest available substitute is converting findings into executable gates.
2. **No ABORT stage.** The lifecycle has CHECKPOINT before an irreversible action but no
   defined procedure for a half-applied IMPLEMENT. Migrations are forward-only; the
   recovery path is the pre-migration snapshot plus `git revert`. This should become a
   real stage the first time it is needed.
3. **Bidirectional text embedding is unverified** (§2). Persian labels inside LTR
   containers are rendered but not asserted. No test covers digit/punctuation ordering.
   Severity: Low. Tracked.
4. **Display precision differs from storage precision** (§2): money is stored to 2dp and
   displayed with 0. Deliberate for AFN, but it means a displayed total can differ from
   the sum of displayed parts by up to a unit. Severity: Low. Tracked in `metrics.md`.
