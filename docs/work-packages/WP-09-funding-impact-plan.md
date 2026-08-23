# WP-09 — Funding & Impact: Scope, Model, Challenge and Decision Plan

**Work Package:** WP-09 Funding & Impact (`funding.routes.ts`, `impact.routes.ts`)

**Protocol:** `docs/MASTER_ENGINEERING_PROTOCOL.md` §§16–18, 22–23, 28,
33–42, 49–54, 58–76, 84, 90–93, 95–101 and §W

**Date:** 2026-08-23

**Risk classification:** **CRITICAL/HIGH** — donations are cash income; aid
allocations settle tuition; donor/campaign reports are external-facing financial
and impact claims; the package handles personally identifiable donor data and
permission-scoped branch data.

**Protocol state:** `SCOPE → DISCOVER → MODEL → CHALLENGE → DECIDE` complete.
A Git checkpoint is required before implementation because the selected design
changes the canonical schema, money-adjacent integrity boundaries, RBAC, API
contracts, deletion of active artifacts and report storage.

> This plan deliberately does not reopen or modify WP-08 Payroll. The only
> cross-package dependency is the already-canonical obligation-allocation
> authority in `server/src/core/finance/obligations.ts`; WP-09 will extend its
> provenance inputs without changing payroll facts, payroll envelopes, payroll
> routes, or WP-08 tests.

---

## 1. SCOPE

### Included

- organization-global donor master data with branch-scoped relation reads;
- branch-scoped campaigns, donations, scholarships, sponsorship agreements and
  their exact money/provenance graph;
- restricted donations with one mandatory, structured target;
- donation income linkage, immutable funding facts, source-aware aid allocation,
  campaign return of unused sponsorship funds, and reconciliation;
- donor-, campaign- and branch-scoped derived Impact report snapshots;
- Funding/Impact permission boundaries and branch authorization;
- Funding and Impact user interfaces, server-state freshness, empty/error states
  and source-selection UX;
- replacement of the WP-09 legacy test authority and relevant cross-domain
  evidence; and
- registry, decision, invariant, metric, legacy-inventory and certification
  updates that describe the resulting system.

### Explicitly excluded

- Payroll, payroll envelopes, salary facts and all WP-08 files/contracts;
- generic Finance/Invoice redesign or recertification of WP-07;
- generic Reporting & Analytics catalog redesign beyond consuming/updating the
  named metric authority where WP-09’s own report facts require it;
- a donor refund/correction policy that has not been requested or defined;
- unstructured manual impact claims, manual metric truth, success-story
  publication, email delivery, or external donor integrations; and
- migration of production data (owner decision A-1 confirms none exists).

### Affected authorities and dependencies

| Concept | Existing authority consumed | WP-09 action |
|---|---|---|
| Whole-AFN money | `server/src/utils/money.ts` | Consume; add database backstops, never add a second parser. |
| Income / cash | `server/src/utils/income.ts`, `financial_transactions`, `finance_accounts` | Keep cash recognition once at donation receipt; link it to the donation and never create a second cash movement for aid or campaign returns. |
| Tuition settlement | `student_obligations` + `obligation_allocations`; `core/finance/obligations.ts` | Extend with explicit funding-source provenance, without creating a second settlement store. |
| Branch scope | `resolveBranchScope` / `canAccessBranchResource` / permission RBAC | Consume for every read and write; selected UI branch is an authorized target, never an identity override. |
| Reporting period | `periodBoundariesForKey` | Consume exactly; no local period resolver. |
| Student attendance | `STUDENT_ATTENDANCE_UNION` | Do not copy it; only consume if a selected impact metric needs it. |
| Document sequence | `nextScopedDocumentNumber` | Retain as the donation receipt-number authority. |
| Audit / events / notifications | `writeAudit`, event outbox, notification handlers | Use one event/notification path per event; remove duplicate direct notification writers. |

---

## 2. DISCOVER — CURRENT-STATE MAP

### Runtime surface

| Layer | Actual current files / surfaces | Finding |
|---|---|---|
| Schema | `server/src/db/schema.sql`: `donors`, `funding_campaigns`, `donations`, `scholarships`, `scholarship_fundings`, `scholarship_awards`, `sponsorship_agreements`, `sponsorship_receipts`, `impact_metrics`, `impact_reports`, `success_stories` | `raised_amount` and `allocated_amount` are stored mirrors. Donation/aid source provenance is incomplete. Most cross-scope and lifecycle facts lack update-side database guards. |
| Funding API | `server/src/routes/funding.routes.ts` | 25 endpoints mix authorization, route SQL, money mutation and report-like calculations. Donations can be recorded against an accessible foreign-branch campaign but stored in the operator home branch. |
| Settlement service | `server/src/core/finance/obligations.ts` | Exact obligation identity is authoritative, but scholarship/sponsorship applications identify only the aggregate award/agreement—not the received donation lot. Exact donor/campaign attribution is therefore impossible. |
| Impact API | `server/src/routes/impact.routes.ts` | It accepts `donorId` / `campaignId`, stores them, then computes whole-branch metrics. It mixes period facts, point-in-time counts and pledge/award amounts under donor-facing labels. |
| Frontend | `src/components/funding/FundingView.tsx`, `src/components/impact/ImpactView.tsx`, `src/apiStore.ts`, `src/App.tsx`, `src/types.ts` | Funding computes treasury figures in the browser and issues N+1 position reads. Impact renders placeholder `0` values and has no donor/campaign scope, report snapshot or meaningful metric surface. Mutations do not consistently carry the selected branch. |
| RBAC | `permission-catalog.ts`, `auth.ts` | Routes use role-name guards despite `Funding.View` / `Funding.Edit` and `Impact.View` catalog entries. Finance is allowed to create donations by role but has no purpose-specific permission. |
| Tests | three legacy WP-09 suites at `server/src/tests/`; `impact-period-authority.test.ts`; WP-07 funding/obligation suites | Existing focused baseline: **4 files / 70 tests passed** on 2026-08-23. Those tests prove selected input/lifecycle properties but not structured restriction enforcement, exact provenance reports, source limits, RBAC policy or database attack resistance. |

### Proven baseline defects / contradictions

1. `funding_campaigns.raised_amount` and `scholarships.allocated_amount` are
   mutable copies of figures derivable from authoritative rows. The route and
   the Funding UI both consume the copies, violating LAW 1.
2. `FundingView` calculates capital, campaign and scholarship totals in the
   browser from loaded lists, violating LAW 2 and producing incomplete totals
   under pagination/scope/stale state.
3. An accessible campaign in branch B can be supplied to donation creation by
   an operator whose home branch is A; the donation and income are written to
   A while the campaign mirror is incremented in B. No schema trigger blocks
   the mismatch.
4. A restricted donation has only a Boolean and free text. The money can be
   allocated to any scholarship or sponsorship, so the word “restricted” has no
   enforceable meaning.
5. A scholarship or sponsorship application does not name the received donation
   lot that backs it. Aggregates can settle tuition correctly but cannot prove
   which donor/campaign funded a particular beneficiary outcome.
6. `closeAward()` currently removes the whole award from the fund’s committed
   sum while its applied allocations remain active; a partially applied closed
   award can therefore reopen already-spent money for a new award.
7. A sponsorship can be terminal while holding received, unapplied money. The
   current model blocks future application but gives the money no explicit
   destination.
8. Impact reports store donor/campaign identifiers but use whole-branch SQL.
   A report can therefore make a donor/campaign attribution it cannot prove.
9. `impact_metrics` and `success_stories` are ungoverned manual stores with no
   complete UI workflow or canonical metric authority, contradicting the
   derived-report requirement.
10. Funding/Impact routes duplicate event-handler notifications for donations,
    scholarship awards and impact reports in a full application startup.

---

## 3. MODEL — TARGET DOMAIN

### 3.1 Entity and ownership model

```text
Donor (organization-global identity)
  └─ Donation (immutable cash-income fact, one branch, one linked income transaction)
       ├─ unrestricted: may be explicitly allocated to an eligible aid source
       └─ restricted: exactly one structured target
            ├─ Campaign → immutable Campaign Funding Entry
            ├─ Scholarship → immutable Scholarship Funding
            └─ Sponsorship → immutable Sponsorship Receipt

Campaign Funding Entry (non-cash, restricted monetary allocation fact)
  ├─ source: a donation, or a returned sponsorship receipt
  ├─ target: exactly one campaign
  └─ may explicitly fund a Scholarship Funding or Sponsorship Receipt

Scholarship Funding / Sponsorship Receipt
  └─ exact funding source for an aid application
       └─ Obligation Allocation
            ├─ scholarship: award + scholarship funding source
            └─ sponsorship: agreement + sponsorship receipt source

Impact Report (immutable derived snapshot)
  ├─ branch scope, or exactly one donor/campaign scope
  ├─ canonical Shamsi period + resolved ISO boundaries
  └─ only facts traceable through the graph above
```

A `Campaign Funding Entry` is a non-cash monetary allocation fact. It does not
write `financial_transactions`, because cash was recognized exactly once when
the donation arrived. It records source, destination, amount, actor, reason
where required and date; its reconciliation proves it neither creates nor
removes cash.

### 3.2 Lifecycle

| Entity | Valid lifecycle |
|---|---|
| Donation | Create once with an income fact and receipt number → read / allocate through immutable child facts. No mutable amount, donor, branch, date, restriction or deletion path. |
| Restricted donation | At creation, exactly one target is selected. The system creates the corresponding first allocation fact in the same transaction. Free text cannot substitute for target identity. |
| Campaign funding entry | Create from a campaign-targeted donation or a sponsorship return → allocate explicitly to an eligible campaign child. Immutable. |
| Scholarship funding | Create from one direct donation or one campaign funding entry → source-aware application to an award. Immutable. |
| Scholarship award | Active reserves its amount; application consumes a named funding source; close releases only the unapplied remainder. Closed awards retain applied history and reject reversals. |
| Sponsorship receipt | Create from one direct donation or one campaign funding entry → source-aware application. Immutable. |
| Sponsorship agreement | Active → completed/terminated. A terminal transition with a positive available balance creates immutable return entries to its linked, valid campaign, with reason/actor/audit; no linked campaign means 409 and no state change. |
| Impact report | Generate immutable derived snapshot. No manual metric, story or narrative writer is retained. |

### 3.3 Invariants

1. One donation has exactly one linked income transaction with the same branch,
   amount and accounting date; neither can be rewritten/deleted after linkage.
2. A restricted donation has exactly one structured target and is atomically
   placed in that target’s allowed funding path.
3. A campaign/scholarship/sponsorship target belongs to the donation branch;
   sponsorship targets also name the donation’s signing donor.
4. A campaign funding entry, scholarship funding and sponsorship receipt can
   never consume more than their source has available.
5. Every scholarship/sponsorship obligation allocation names exactly one
   received source. Source, award/agreement, obligation student, campaign and
   branch must agree.
6. A fund’s available amount excludes active award commitments **and** applied
   money retained by closed awards.
7. A terminal sponsorship has no unassigned balance: any available receipt
   money is returned as an immutable campaign funding entry, or terminal
   transition is refused if its campaign is invalid/missing.
8. Aid allocation moves no cash and writes no second income/expense ledger row.
9. Donor/campaign impact reports include only direct donations and aid
   applications whose source graph reaches the selected donor/campaign. Missing
   provenance yields no attribution.
10. A manual Impact Metric or Success Story cannot become a second operational
    or reporting truth because those active stores/routes/UI consumers are
    removed.
11. Funding and Impact authorization is permission- and branch-scope-based;
    Finance may record donations but cannot mutate donor, campaign, aid or
    impact resources.

### 3.4 Authority map

| Concept | Storage | Rules | API | UI |
|---|---|---|---|---|
| Donation cash fact | `donations` + linked `financial_transactions` | Funding service + money authority | `POST /api/funding/donations` | Funding donation desk |
| Restriction target | `donation_restrictions` with exact-one FK | Funding service + schema triggers | donation command | structured target selector |
| Campaign-restricted balance | `campaign_funding_entries` | Funding service | campaign source endpoints | Funding source selector |
| Scholarship/sponsorship source position | source rows + source-aware `obligation_allocations` | `core/finance/obligations.ts` | source/position endpoints | aid application dialogs |
| Fund position | derived from funding entries, awards and active applications | Funding service | `GET /api/funding/.../position` and summary | Funding view, never a browser reducer |
| Impact snapshot | `impact_reports` | `core/impact/impact-reporting-service.ts` | generate/list report endpoints | Impact view |
| Funding/Impact permission | RBAC catalog / role grants | `requirePermission`, branch resolver | every Funding/Impact endpoint | server-resolved permission affordances only |

---

## 4. CHALLENGE

| Subsystem | Decision | Reason |
|---|---|---|
| Stored campaign raised / scholarship allocated totals | **REMOVE** | They duplicate derived financial facts and already drift across lifecycle transitions. |
| Boolean + text restriction | **REBUILD** | It cannot constrain money. Replace with typed FK-backed target identity. |
| Aggregate-only aid source model | **REBUILD** | It cannot prove donor/campaign impact, nor preserve per-source availability after an application. |
| Sponsorship terminal lifecycle | **REFACTOR** | Preserve agreement history but make an explicit, immutable campaign return for every unspent receipt balance. |
| Impact metric/story stores | **REMOVE** | Owner selected derived reports only; neither has an approved operational workflow or canonical authority. |
| Bespoke Impact SQL | **REBUILD** | One service owns exact traceable scope metrics and consumes established calendar/settlement authorities. |
| Role-name route guards | **REPLACE** | Permission catalog is the RBAC authority; add missing action permissions and retain the owner-approved separation. |
| Funding frontend reducer/N+1 positions | **REFACTOR** | Server must publish financial positions and summary; UI must render them and send selected branch/source identity. |
| Donation cash posting | **KEEP + STRENGTHEN** | `recordIncome` is the cash authority; link and protect its result rather than adding a second money writer. |

---

## 5. DECISIONS RECORDED FROM OWNER

1. A restricted donation has one **mandatory structured target**: Campaign,
   Scholarship or Sponsorship. A note never substitutes for target identity;
   allocation must enforce the target.
2. A donor/campaign report claims only effects with exact source provenance. No
   branch-wide pooling, inferred attribution or untraceable impact is allowed.
3. Impact is derived from canonical operational facts and authoritative reports.
   Manual Impact Metrics and Success Stories are retired as operational sources.
4. RBAC is permission based: Global Owner is unrestricted; Donor Manager and
   General Manager manage donors, campaigns, aid/funding allocations and Impact;
   Finance Manager may only register Donations and has no `Funding.Edit` or
   Impact mutation authority.
5. On terminal sponsorship transition, unspent money returns to its linked
   Campaign as a restricted, linked monetary allocation fact with actor, reason,
   audit and reconciliation. If no valid campaign exists, termination is
   blocked until an explicit resolution exists.

---

## 6. IMPLEMENTATION PLAN

### Canonical schema

1. Remove `funding_campaigns.raised_amount`, `scholarships.allocated_amount`,
   `impact_metrics`, `success_stories` and their indexes/triggers after the
   deletion checklist proves no active reference remains.
2. Add immutable donation-to-income linkage and whole-AFN/positive/check/
   branch/date triggers for money-bearing funding facts, on INSERT and UPDATE.
3. Add `donation_restrictions` with a one-to-one donation FK and exactly one of
   campaign/scholarship/sponsorship target FKs.
4. Add `campaign_funding_entries` with direct-donation / sponsorship-return
   origin, source donation, optional source receipt, campaign target, amount,
   actor, reason and immutable lifecycle.
5. Make `scholarship_fundings` and `sponsorship_receipts` source-aware: exactly
   one of direct donation or campaign funding entry.
6. Add exact scholarship-funding / sponsorship-receipt source FKs to
   `obligation_allocations`; update its exact-one instrument check and add
   cross-entity, source-capacity, closed-award and branch triggers.
7. Add `campaign_id` to sponsorship agreements with branch-correlation
   constraints. It is optional at creation but mandatory for terminal release of
   a positive balance.
8. Rebuild `impact_reports` as immutable derived snapshot storage: scope kind,
   one optional donor/campaign scope FK, canonical period key + resolved bounds,
   JSON metrics snapshot, derived narrative, generator identity and replay key.
9. Add targeted indexes for report scope/period and all source-to-consumer
   lookups; eliminate superseded indexes/columns in the same canonical edit.

### Backend/domain

1. Add `server/src/core/funding/funding-service.ts` for donation registration,
   restrictions, campaign source entries, positions, source availability and
   sponsorship terminal returns.
2. Extend `core/finance/obligations.ts` so aid applications require the exact
   scholarship funding or sponsorship receipt and preserve source capacity,
   closed-award accounting and immutable reversal rules.
3. Add `server/src/core/impact/impact-reporting-service.ts` as the one owner of
   branch/donor/campaign derived snapshots. It will use source graph joins,
   `periodBoundariesForKey`, canonical branch scope and no manually entered
   metric data.
4. Rebuild `funding.routes.ts` and `impact.routes.ts` into thin authenticated,
   validated, permission-scoped API adapters. Replace role guards with
   `requirePermission`; validate selected branch and all target ownership.
5. Keep `recordIncome` as the only cash writer. Extend its typed contract only
   as necessary to make the donation transaction linkage exact; campaign and
   aid allocation facts write no cash ledger row.
6. Emit events inside their state transactions. Remove duplicate direct
   notification writers for events already handled by the event bus.

### RBAC/API/frontend

1. Add `Funding.RecordDonation` and `Impact.Edit`; grant the exact owner-approved
   role matrix. Migrate every WP-09 route to permission middleware.
2. Replace stale/ambiguous contracts with typed command/response shapes:
   `branchId`, `restriction`, `sourceKind/sourceId`, report `scopeKind/scopeId`
   and source-position data.
3. Pass selected branch through every Funding/Impact mutation and clear stale
   branch-local UI state on switch.
4. Replace browser treasury calculations with server `FundingSummary` and list
   responses containing server-derived positions. Remove N+1 position loading.
5. Rebuild the donation form around explicit restriction target selection,
   recipient compatibility and clear failure/recovery guidance.
6. Require source selection when applying scholarship/sponsorship money;
   render only source entries with server-published remaining amount.
7. Replace the placeholder Impact screen with branch/donor/campaign scope
   selection, derived immutable snapshots, metrics and explicit no-data/error
   states. No manual metric/story controls remain.

### Tests, review and documentation

1. Rebase the three inventoried WP-09 legacy suites into
   `server/src/tests/work-packages/wp09/`; re-home the Impact period authority
   with the owning route; retain only behavior that survives the model.
2. Add normal, adversarial, authorization, report-reconciliation, direct-schema
   and frontend-contract authorities. Every source-level claim receives a test
   that fails if provenance, restriction, branch scope, capacity or report
   filter is removed.
3. Run package tests before/after repair; test fresh schema, full server suite,
   frontend/server typechecks, lints, registry/protocol/static/product/design/
   cleanliness gates and release validation.
4. Attack malformed input, direct DB writes, wrong branch/target/source,
   repeated requests, terminal sponsorship balances, award close/reversal,
   missing provenance, crafted report scope, stale UI state and permission
   escalation.
5. Conduct a separate cold review, clean generated artifacts and active-source
   residue, then update certifications only to the evidence actually obtained.

---

## 7. ACCEPTANCE CRITERIA

- A valid restricted donation creates exactly one allowed initial funding fact;
  an incompatible allocation is 400/409 and writes nothing.
- An unrestricted donation is recognized exactly once as cash income; a
  restricted campaign/scholarship/sponsorship allocation changes no cash total.
- A scholarship/sponsorship application names an exact source, cannot exceed
  that source, and appears in exactly the matching donor/campaign report.
- A donor/campaign report excludes an unrelated donor/campaign and all
  unproven branch metrics; branch reports use only branch-scoped facts.
- A partial scholarship award close cannot re-award already applied money; a
  closed award cannot reverse an application into nowhere.
- A sponsorship terminal transition returns every unused source lot to its
  valid linked campaign with reason/actor/audit/reconciliation—or fails without
  changing the agreement.
- Finance Manager can submit a valid donation and cannot mutate donor, campaign,
  scholarship, sponsorship or Impact resources; permission-equivalent custom
  assignments behave consistently.
- Browser totals are server-published; branch changes and successful mutations
  refresh the relevant consumers without a hard reload.
- `impact_metrics` and `success_stories` have no active schema/runtime/API/UI
  authority after the deletion proof.

---

## 8. CHECKPOINT REQUIREMENT

Implementation is blocked until this plan and the corresponding decision-log
entries are committed as a recoverable Git checkpoint. No WP-08 asset is in the
checkpoint or planned file set.
