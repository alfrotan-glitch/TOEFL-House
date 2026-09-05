# Forensic Audit — September 2026

Status: **ACTIVE** — commissioned by the owner under the from-first-principles mandate
(no prior audit, green test, doc, commit message, or registry row is evidence; every
conclusion below rests on independently reproduced observation against the live system
at commit `e5fffc0`).

Ledger of findings. Each finding uses the 10-point template: location, actual vs
expected, why wrong, reproduction, impact, test coverage, data-corruption potential,
recurrence, severity class, remediation layer. Verified-sound areas are recorded at
the end with their evidence. The final verdict is written only when the audit closes.

---

## FINDING F-A1 — `enroll-semester` lets the client set the tuition price; the fee-rule authority is bypassed and no invoice is issued

**Severity: CONFIRMED DEFECT — business-logic / data-integrity (price-authority inversion). High.**

1. **Location.**
   - `server/src/routes/students.routes.ts:1448` — `const { tuitionAmount, amountPaidNow } = req.body`; `:1464` — `let resolvedTuition = tuitionAmount;` (client value is the *primary* source; the class fee at `:1466` is only a fallback when the client omits the field).
   - `server/src/core/academic/enrollment-service.ts:599` — the `writeSemester === false` billing branch: "the CALLER owns the term and has already written its own tuition figure onto it", so tuition is *never* catalog-billed on this endpoint; the caller's figure is the only tuition record.
   - Frontend invitation: `src/components/students/StudentsView.tsx:648–655` — free-text "Semester Name", editable "Total Fee" number input (pre-filled from the class fee), editable "Paid Today".
   - Permission gate: `requirePermission('Class.Assign')` (`:1444`) — held by **Receptionist**, Head of Department, General Manager, Owner (verified in the live DB: `role_permissions` ⋈ `permissions.code='Class.Assign'`).

2. **Actual vs expected.**
   - Actual: any nonzero integer the client sends becomes the semester's `fee_amount`/`net_fee_amount` verbatim (after server-side discount resolution). No invoice is issued for it; the student's balance shows fully settled; a receipt is printed for the fake amount.
   - Expected: `docs/registries/canonical-authority.md` row 51 makes `level_branch_fees` / `branch_academic_profiles` the AUTHORITATIVE fee configuration. Class creation pins `classes.fee` to that authority (`classes.routes.ts:518`) and PUT refuses to edit a pinned fee (`:609`). Sibling writers agree: `POST /students/manual` **rejects** `tuitionAmount`/`amountPaidNow` in the body (`students.routes.ts:831-832`); `POST /students/:id/enroll-class` derives price exclusively from the catalog. `enroll-semester` is the only writer that accepts a client price.

3. **Why wrong.** Trust boundary inversion: the HTTP client is treated as the pricing authority for tuition. The service's own comment documents the design assumption ("the CALLER owns the term") — but this route's "caller figure" is the raw request body. The `autoInvoice: resolvedTuition <= 0 && paidNow <= 0` flag is a red herring on this path: in the `writeSemester:false` branch the service bills only non-tuition fees, so tuition is never reconciled against the catalog regardless of the flag.

4. **Reproduction (all steps executed live, sandbox install, 2026-09-04).**
   - Class "Audit Gold Class" (A1 level, branch 1): POST `/api/classes` with `fee: 20000` → stored `fee=6500` (level fee rule override — correct); "Audit C1 Class" `fee: 25000` → stored `8500`.
   - Full legitimate funnel for student `stu_ac50864f…` (visitor → followup → convert → placement attempt, 5 examiner-scored components → A1 recommendation → registration 500 + placement 300 invoices paid).
   - Owner probe: `POST /api/students/:id/enroll-semester` `{"tuitionAmount":100,"amountPaidNow":100}` → **201**, semester `fee_amount=100`, receipt `R-00000005`, **no tuition invoice**, balance zero.
   - Receptionist probe (user `audit_recp`, branch-scoped, post-quarantine): same endpoint, `tuitionAmount:50` → **201**, receipt `R-00000007`, semester 50 AFN against a 6,500 AFN catalog price.
   - Controls: tuition omitted → semester priced 6500 from the pinned class fee (correct); `tuitionAmount:0` → semester 0, still no catalog invoice (the zero path is also unpriced, contradicting the `autoInvoice` intent).
   - Level ceiling verified sound in the same session: A1-placed student → C1 class rejected 409 "above the authorized level".

5. **Impact.** A receptionist (lowest-privilege desk role) can enroll any student at any price — including deliberate underpricing (bribery/cash skimming) — with books that balance: no invoice, no debt, a legitimate-looking receipt, and an audit-log row whose `newValue` quietly records the fake `netTuition` (detectable only by manual cross-reference against the class fee; nothing flags the divergence). 6,450 AFN per enrollment simply vanishes from the receivable base in the probe above; at scale this is direct revenue loss with no system-side trace.

6. **Test coverage.** None for price integrity on this endpoint — worse, the suite blesses the defect as contract: `wp03/students-admissions.attack.test.ts:124/131` happy paths pass `tuitionAmount: 1000`; `:222` seeds an audit fixture with `tuitionAmount: 456789`. The attack tests verify coercion rejection (`true` → 400) and the `paidNow ≤ netTuition` cap, both of which hold — but they pin the *wrong price* as the source of truth. Test-quality sub-finding: green tests encode the hole.

7. **Data-corruption potential.** High for financial reporting: `student_semesters` is the registered authority for tuition balances (canonical-authority row 70); poisoning it with client figures corrupts every downstream consumer — balances, holds, settlement gates, refunds (which re-open "the semester the reversed payment settled"), the obligations/allocations ledger, and any revenue report — while remaining internally consistent, so no constraint or reconciliation will ever fire.

8. **Recurrence.** Every semester enrollment through the StudentsView modal (the only UI path to this endpoint) sends the editable "Total Fee" verbatim (`src/apiStore.ts:991-993` → route). The modal also violates the owner's standing reception-workflow constraints: free-text semester name, manual tuition math, class list filtered only by `active && branch` (not by placement ceiling — the server 409s, but the UI offers invalid choices).

9. **Severity classification.** Confirmed defect — business-logic + data-integrity (price-authority inversion). Not classical security (the actor is authenticated and permission-gated; the permission is simply too much authority for the desk), but financially equivalent to an insider-fraud enabler.

10. **Remediation layer.** Route (`students.routes.ts`): delete `tuitionAmount` from the accepted body — mirror `/manual`'s explicit rejection — and always resolve from the pinned class fee (the `:1466` fallback, made unconditional); keep `amountPaidNow` (already capped at net tuition). Service: none needed — `enrollment-service` already prices correctly when the caller doesn't lie. Frontend: make "Total Fee" read-only (display the resolved price), semester name a structured choice, and pre-filter the class list by placement ceiling/level/gender/capacity. Tests: replace the wp03 `tuitionAmount:1000` happy paths with catalog-price assertions (a client-sent `tuitionAmount` must 400), and add a price-integrity attack case (client price ≠ class fee → rejected, semester priced from catalog).

---

## FINDING F-A2 — Automation/workflow layer is substantially dead wiring: core domains publish no events; 4 of 5 seeded automations reference triggers nothing emits

**Severity: CONFIRMED DEFECT — architectural / business-logic (silently non-functional advertised feature). Medium-High.**

1. **Location.** `server/src/core/events/event-bus.ts` header claims "Every state transition in any Bounded Context publishes a Domain Event here… the central nervous system of the entire architecture". Actual runtime emitters (grep over non-test source): `sessions.routes.ts` (session.scheduled, attendance.marked, session.completed, makeup), `funding.routes.ts` (donor.created, campaign.created, donation.received), `impact.routes.ts` (impact.report_generated). That is all. Students, payments, invoices, exams, books, expenses, classes publish **nothing** to the bus.

2. **Actual vs expected.**
   - Actual: `seedDefaultAutomations()` (`automations.routes.ts:383+`) seeds 5 active automations. Triggers with a runtime emitter: `attendance.marked` (1). Triggers emitted by **no code path**: `payment.received`, `student.registered`, `exam.result_recorded`, `book.sold` (4 of 5).
   - Same for workflows: the only auto-start definition trigger is `expense.requested` (workflow-auto-start handler, `handlers.ts:196`), and `expense.requested` is emitted at runtime by nobody (only `workflowSeeds.ts` seed-time references). Live DB: `workflow_definitions=6`, `workflow_instances=0`.
   - Notification handlers subscribed to never-emitted events: `student.registered` (handlers.ts:60), `payment.received`, `scholarship.awarded`, `expense.requested` notification handlers — dead code.
   - `pipeline_metrics`: written only by the bus analytics handler (`handlers.ts:229`), read by **nothing** (grep: writer is the only reference). Live DB: 0 rows despite 15 journey events, 4 payments, 3 invoices — the analytics subsystem is vestigial even for the domains that do emit.

3. **Why wrong.** Two coordination mechanisms coexist: the domain event bus (funding/impact/sessions) and direct `addNotification` calls in students/admission/placement/payment routes. The bus was never extended to the core academic/finance domains, but the automation/workflow/notification layer on top of it was built and seeded as if it had been. Live proof: my real student registrations and invoice payments produced direct notifications ("Student Admission Created", "Invoice payment recorded") while the seeded "New Student Welcome Notification" (active, trigger `student.registered`) sat silent — `student.registered` has no emitter.

4. **Reproduction.** (a) Live DB `notifications` table shows 4 direct-call rows from today's real funnel; `domain_events` 0 rows; `workflow_instances` 0; `pipeline_metrics` 0. (b) `grep -rln "'payment.received'" server/src` → only `automations.routes.ts` (seed definition) and `handlers.ts` (subscriber); no `emit` call exists.

5. **Impact.** Operators see "Automations (5)" with green active toggles in `WorkflowsView.tsx:325-341` and can create/toggle automations — 4 of the 5 advertised behaviors can never occur, and a custom automation on any core-domain trigger (payment, student, exam, book) is dead on arrival. Business rules an owner believes are enforced (e.g. "Outstanding Balance Reminder") silently do not exist. No error, no log, nothing fires.

6. **Test coverage.** No test asserts an end-to-end "register student → automation fires" chain; bus tests exercise emit/dispatch mechanics in isolation (which work), and automation tests evaluate conditions against synthetic events. The gap — nobody publishes the event — is invisible to every test because each layer is tested against hand-fed events.

7. **Data-corruption potential.** None directly. Indirect: decisions made on the belief that alerts/workflows fire (outstanding-balance reminders, stock alerts, exam follow-ups) are not made; `pipeline_metrics`-based analytics would under-report to zero.

8. **Recurrence.** Every registration, payment, exam result, and book sale, forever, fires none of the seeded automations. Session attendance automations do fire (sessions.routes:918 emits).

9. **Severity classification.** Confirmed defect — architectural (incomplete integration of a cross-cutting subsystem) + business-logic (advertised feature silently absent). Not security. The bus mechanics themselves (outbox, isolation, idempotent dispatch) are sound as far as they go.

10. **Remediation layer.** Either (a) emit the registered events from the core writers (students registration, invoice payment, exam result, book sale — one `eventBus.emit` + dispatch each, inside the existing transactions), or (b) remove the dead seeds, dead handlers, and the automations UI's unreachable trigger options until the emitters exist, and correct the event-bus header's "central nervous system" claim to the domains actually wired. A trigger picker that lists only emitted event types would make the remaining surface honest. Decide per domain; do not leave the current state where the UI sells behavior that cannot happen.

---

## MINOR FINDINGS

**F-M1 — Stale doc comment contradicts the money authority.** `server/src/utils/money.ts` seat-count comment claims "money allows two decimal places" while `assertMoney` accepts whole-AFN integers only (verified: parse rejects decimals; storage is INTEGER AFN). Docs-only defect; misleads maintainers. Fix: correct the comment. Severity: docs.

**F-M2 — Reception enroll modal violates the owner's standing workflow constraints.** `StudentsView.tsx:648-655`: free-text semester name, editable "Total Fee"/"Paid Today" (manual tuition math), class list filtered only by `active && branch` — placement ceiling, gender policy, capacity and level not reflected in the offered options (server correctly 409s each; the UI nonetheless offers invalid choices and free-text fees). Compounds F-A1. Severity: UX/business-rule conformance. Fix with F-A1's FE layer.

**F-M3 — `jalaliToGregorian` silently folds impossible Jalali dates** (e.g. Esfand 30 of a non-leap year → next day's Gregorian) instead of rejecting. No unguarded caller exists today (the Shamsi input bounds the day dropdown by actual month length; the API accepts validated Gregorian ISO only), so this is API-robustness hardening, not a live defect. Severity: cosmetic/robustness.

**F-M4 — No `busy_timeout` on the SQLite connection.** Harmless in the designed single-instance deployment (better-sqlite3 serializes on one connection; boot actively refuses a second instance on the same port), but a second process sharing the DB file (manual scale-out) would surface immediate SQLITE_BUSY 500s rather than waiting. Severity: operational note.

---

## VERIFIED SOUND (independently reproduced, this audit)

| Area | Evidence |
|---|---|
| Auth core, login race, cookies, quarantine, bearer policy | Entry-45 ledger; re-confirmed against source (secret fail-closed, session_version revocation, DUMMY_HASH timing, conditional last_login UPDATE, HttpOnly/SameSite=Strict cookie, prod bearer block) |
| Route-guard perimeter | Router-level + per-object guards present on every audited router; invoices router gate re-verified |
| SQL injection surface | All `${}` interpolations constant; funding `${table}` 3-way allowlist |
| Money authority | Integer-AFN parse-only assertMoney; assertComputedMoney round-half-away; 271 schema CHECKs incl. `gross=quantity*unit_price` (F-M1 doc nit aside) |
| Placement / settlement / level gates | **Live-proven this session**: placement-required blocks manual enrollment (400); outstanding placement fee blocks enrollment (409); A1-placed student blocked from C1 class (409) |
| Class-fee pinning | **Live-proven**: POST /classes with levelId discards client fee for the level fee rule (20000→6500, 25000→8500); PUT refuses to edit a pinned fee |
| Document numbering | Single sequence authority, atomic UPSERT + UNIQUE at rest (`uq_payments_receipt_number`, `uq_invoices_branch_invoice_number`) |
| Idempotency layer | DB-enforced; dual time-bucket boundary handling; invoice replay scoped to invoice+student (client-key collision defended); guarded categories always persist the key |
| WAL/concurrency | WAL + FK ON; single-writer serialization via better-sqlite3; schema init guarded by integrity + FK checks at boot |
| Backup & restore drill | **Live-proven**: external daily backup copied → integrity_check ok, 0 FK violations → second API instance booted on it (bootstrap complete, 11 handlers) → owner login 200 with the exact credential state at backup time → graceful SIGTERM shutdown |
| Schema authority | schema.sql applied 1× vs 3× to fresh DBs: object-for-object identical (119 tables/272 indexes/191 triggers/1 view); repo preflight passes; **live runtime DB has zero drift** vs schema.sql (object set + definitions) |
| Calendar authority | Jalali↔Gregorian round-trips exact on every probed real date 2025–2045 incl. all fiscal new-year boundaries; Shamsi reporting periods for today verified exact (month/quarter/year/week); Shamsi input bounds day by actual month length |
| Audit-log coverage | Every business router with mutations writes audit rows (students 15 refs vs 12 mutations etc.); the only un-audited mutations are self-service notification read-receipts (actor recorded in read_receipts) |
| FE→backend reachability | All 84 distinct FE API call sites resolve to real server routes (incl. helper-registered lifecycle transitions) |
| Test honesty spot-check | wp07 cash-allocation suite drives the real router via supertest against the real DB — integration-real, not mock-theater |

---

## VERDICT — what I would still refuse to trust in production

**Trust (evidence-based, this audit):** the identity/permission perimeter, SQL safety, money parsing/rounding, schema constraints and their zero drift, the restore path (booted and logged in from a backup), document numbering, the idempotency layer, placement/settlement/level gates, class-fee pinning, and the calendar/period authority. These were not taken on faith; each was re-derived from source or reproduced against the running system, several adversarially.

**Refuse to trust until remediated:**

1. **Tuition pricing on `POST /students/:id/enroll-semester` (F-A1).** A receptionist can sell a 6,500-AFN term for 50 AFN with a receipt and a clean balance — proven live, twice. No report, constraint, or reconciliation will ever surface it. Until the client price override is removed and the endpoint prices from the pinned class fee, every figure derived from `student_semesters` (balances, outstanding, revenue, refund bases) is desk-user-controllable fiction in any deployment where more than one person enrolls students.
2. **The automation/workflow product surface (F-A2).** 4 of 5 seeded automations reference triggers no code emits; workflows never auto-start; pipeline analytics are written by nobody and read by nobody. Until emitters exist or the surface is trimmed to what fires, an operator looking at "Automations (5) — active" is being told a falsehood about controls that do not exist.
3. **Anything depending on the event bus covering "every state transition"** — the bus's own header claims it; the core academic/finance domains publish nothing to it. Treat that claim as marketing until the emitters land.

**Conditional trust:** scheduled (24h GFS) backup cadence — the startup pair was verified end-to-end, but the recurring schedule was not observed over time in this audit; single-instance concurrency assumptions hold only while deployment stays single-process (F-M4).

Nothing else audited rose to distrust. The system's bones — schema, authority separation, gates, recovery — are genuinely sound; the two findings are both of the same species: a boundary where a value or promise crosses from the client/marketing layer into the authoritative layer unverified.

---

## REMEDIATION RECORD — 2026-09-04 (same day, owner-directed production hardening)

**F-A1 — FIXED at the route/architecture layer.** `enroll-semester` now refuses `tuitionAmount` outright (400, mirroring `/manual`), REQUIRES a `classId` (a term without a class has no price authority), and prices the term exclusively from the class row's pinned fee with the server-resolved authorized discount. The receipt number is allocated inside the transaction and only when a receipt is written — the previously burned numbers (observed as the missing R-00000006) are pinned by a new gap-free-series test. The invoice-pay route, the payment desk, the refund route, and both Book commerce writers had the same pre-transaction allocation — every one now allocates inside the transaction that writes its receipt, so no rejection, race, or replay can burn a number. Frontend: the "Total Fee" is a read-only display of the class fee, the semester name is a structured choice (branch academic terms, deterministic seasonal fallback — never free text), and the class list only offers seats the server would accept (free seats, gender policy, placement ceiling via the new `placementCeiling` on `GET /students/:id`). Tests: two PRICE INTEGRITY attack cases added (client price → 400 + catalog-priced term under the receptionist role; no receipt burn on rejected/cash-free enrollment); every suite that previously *pinned the client price* was rebased onto the catalog contract. New registry rows: canonical-authority ("Tuition price of an enrolled term") and three invariants (price authority, receipt allocation, automation liveness).

**F-A2 — FIXED by wiring the real emitters and deleting the dead layer.** `student.registered` (manual registration + visitor conversion), `payment.received` (payment desk, invoice pay, enrollment cash leg — carrying `remainingBalance` computed inside the transaction), `exam.result_recorded` (score recording, carrying `score`), `book.sold` (book sales core, carrying `remainingStock` from `book_inventory_positions`), `expense.requested` (expense requests → the Budget Expense Approval workflow now auto-starts), `scholarship.awarded`, and `attendanceRate` added to both `attendance.marked` emitters (the Low Attendance condition previously compared `undefined < 85` — never true, so even the one "wired" automation was dead). All events are emitted inside the business transaction (outbox atomicity) and dispatched after commit. The write-only `pipeline_metrics` materialization (second authority for a fact `/api/events/stats` derives from `domain_events`) was removed from schema and code. The invoice-pay direct notification was folded into the event handler (one notification per payment, one channel). The event-bus header no longer claims to be "the central nervous system… every state transition"; it now names the wired domains and points at the registry. New `automation-liveness.test.ts` pins the FULL chain (route → event → handler/automation effect) for the seeded triggers so a removed emitter fails CI.

**F-M1 — FIXED.** money.ts seat-count comment now states the actual rule (whole-AFN unbounded vs small whole counts).

**F-M2 — FIXED** with F-A1's frontend work (structured term names, read-only price, filtered class list, placement-ceiling hint).

**F-M3 — FIXED.** `jalaliToIso` now refuses impossible Jalali dates (RangeError) instead of folding them onto the next day; `isValidJalaliDate` exported; FE/server mirrors regenerated identically. All existing callers construct valid dates, so behavior is unchanged for legitimate input.

**F-M4 — FIXED.** `busy_timeout = 5000` on the canonical connection.

**Also:** the mutation-gate summary line no longer reports documented equivalents as surviving mutants ("10 surviving reported" → "0 surviving reported" + an explicit proven-equivalent count); the three harnesses that named their equivalents without the canonical marker were normalized.

**Verification:** server suite 2861/2861 (209 files, +3 liveness tests); FE lint/typecheck/build green; server lint/typecheck green; mutation gate 18/18 PASSED with 0 surviving, 0 invalid, 10 obsolete (documented); schema preflight passes (119 tables — pipeline_metrics removed); live drills below.

---

## OWNERSHIP-MANDATE CONTINUATION FINDINGS

Findings surfaced by the continuing ownership pass, recorded under the same
10-point discipline.

## FINDING F-A3 — Trigger-configuration surfaces accept reserved event vocabulary: an owner can create an automation or workflow on an event nobody emits, and the system confirms it "is now active"

**Severity: CONFIRMED DEFECT — API honesty / business-logic (user-configurable controls that silently cannot run). Medium.**

1. **Location.** `server/src/core/events/event-registry.ts` (`DOMAIN_EVENT_CATALOG`, 58 types, header claiming "configuration cannot drift from emitted events"); `server/src/routes/automations.routes.ts` POST `/:trigger` validated with `isDomainEventType` only; `server/src/routes/workflows.routes.ts` `normalizeWorkflowTrigger` (`isWorkflowTrigger` = `manual` || any catalog type); `server/src/routes/events.routes.ts` `GET /api/events/types` served the raw catalog with no emission truth.

2. **Actual vs expected.** Actual: 20 of the 58 catalog types have runtime emitters; the other 38 are reserved vocabulary with no writer. Both creation APIs accepted all 58 (+ manual for workflows) — `POST /api/automations {trigger:'invoice.paid'}` returned 201 with the notification "…is now active and listening for 'invoice.paid' events", a promise the system cannot keep (no emitter exists, so the rule can never fire). Expected: a triggerable surface offers and accepts only event types that are actually emitted.

3. **Why wrong.** The registry conflated vocabulary with reality and nothing enforced its own header's claim. This is the user-configurable half of F-A2: F-A2's seeded automations were born dead; this let any owner manufacture new dead rules with a success confirmation. Same species — a promise crossing from the configuration layer into the authoritative layer unverified.

4. **Reproduction.** Pre-fix: `POST /api/automations` with `trigger:'invoice.paid'` → 201 + "now active and listening" notification; `grep` proves no `.emit(` call site names `invoice.paid`; the rule fires never, errors never. Workflow definitions: same via `POST /api/workflows/definitions` with any reserved type.

5. **Impact.** An owner who wires, say, an "invoice.paid → notify finance" automation believes a control exists that does not. Silent forever — no error, no log, no execution. Erodes trust in every automation that *is* configured, since nothing distinguishes live rules from dead ones.

6. **Test coverage.** wp12 covered unknown-type rejection (`payment.never_happened` → 400) and emitted-type creation — the reserved-vocabulary middle ground was unpinned. New `event-registry-honesty.test.ts` (9 tests) now pins it: creation APIs reject reserved triggers with explicit "would never fire / would never start" messages; the emitted list is mechanically proven against the source tree.

7. **Data-corruption potential.** None directly. Indirect: business decisions premised on alerts/approvals that silently never run.

8. **Recurrence.** Every automation/workflow-definition created on reserved vocabulary. The seeds themselves were already live (all 5 automation triggers and the one event-triggered workflow definition are emitted types — now asserted by test).

9. **Severity classification.** Confirmed defect — API honesty + business logic; not security (owner-only permission gates held). Medium: requires an owner to configure, but then lies to them.

10. **Remediation layer — FIXED at the architectural level.** Emission truth is now governed where the vocabulary lives: `EMITTED_EVENT_TYPES` + `DYNAMIC_EMIT_SITES` in `event-registry.ts`, with `isEmittedEventType()` exported. Automation creation and workflow-definition creation reject reserved triggers with honest 400s naming the problem and pointing at `GET /api/events/types`; that endpoint now serves each catalog entry with an `emitted` flag so any future picker is honest by construction. `event-registry-honesty.test.ts` scans the real source tree and fails on drift in **both** directions (a type claimed emitted must have a literal `.emit(` call site, or be registered as dynamic with its owning file verified; every literal emit type must be claimed; reserved types must appear nowhere else in non-test source — no hidden emitters, no dead consumers) and asserts every seeded automation/workflow trigger is triggerable. Registry rows updated (canonical-authority: which events actually fire; invariants: trigger-surface honesty).

**Verification (full):** server suite 2870 tests / 210 files — 2868 passed, 2 skipped (pre-existing), 0 failed; server lint/typecheck green; mutation gate 18/18, 0 surviving; schema preflight 118 tables; cleanliness PASS; live drills in the session record.

---

## FINANCIAL-SUBSYSTEM FORENSIC CONTINUATION — 2026-09-05

An adversarial pass over the entire financial subsystem (obligations, invoices,
payments, refunds, payroll, profit distribution, budget envelopes, discounts,
holds, diploma/exam cash) under the standing rule: nothing is trusted — not
tests, not prior audits, not green suites — until it earns evidence.

### Defects found and fixed (each with a pinning test)

**F-B1 · Drop + re-enrol duplicated the term's charge.** A drop defers the
term; re-enrolment in that same term INSERTED a fresh `student_semesters` row
priced 0 (pre-F4) or full price (post-F4) beside the deferred one — either
hiding the live term's debt from every status='active' balance or doubling the
receivable. Re-enrolment now REACTIVATES the deferred/completed term (one row,
same fee, same payments, no second invoice). Unmasked by wp05 C-1 once the
zero-priced insert was removed; pinned there and by FS-8's resume exception.

**F-B2 · Retake pricing lost the retake charge.** The class-fee authority fix
replaced the WHOLE tuition component, so a retake term (class fee + retake fee
rule) was invoiced at the class fee alone. The override now replaces only the
seat component; tuition-type fees alongside it survive (wp07, live drill:
retake term = class 6,500 + retake 2,000 = 8,500).

**F-B3 · BOS withdrawal ceiling replenished geometrically.**
`computeProfitDistribution` added `distributed` back to profit while the
taxonomy (post-F6) already excluded owner drawings from operating expense —
every withdrawal grew the tier basis and refunded 15% of itself to the
allowance (proven live: a 24,000 ceiling paid 28,234 and was still open;
Σ geometric with r=0.15 → ceiling/0.85). The add-back is removed; the
allowance still subtracts distributions. All five wp11 withdrawal tests plus a
live drain drill (Σ 5,549 ≤ 5,550) hold.

**F-B4 · Employee payroll: full-payment conflict classification and the
decided partial cap.** A second full payment against a settled month escaped
with the generic unique-violation message; the route now classifies it
deterministically (the index remains the concurrency backstop). The previously
open question — whether repeated partials are capped — is DECIDED: salary
payments (partials included) are bounded by the period's remaining due, base
minus everything posted, advances included; advances remain uncapped (they are
receivables against future pay, not wage cost). Test rebased to the decided
contract.

**F-B5 · The academic hold was scope-blind and surface-blind.** The hold
summed only ACTIVE-scope debt, so dropping/completing an unpaid term erased it
from the gate (its own doc comment says "previous semesters"); and the journey
enrolment surface never called the hold at all — a blocked student enrolled
through the journey. The gate now lives in `core/academic/academic-hold.ts`,
reads the FULL lifetime balance, is applied by all three enrolment surfaces,
carries a resume exception (re-entering a term the student already holds adds
no new seat/receivable), and keeps the owner/GM/finance override. FS-8 pins
all four properties.

**F-B6 · registrations carried financial lookalikes.** `amount_paid`,
`receipt_number`, `discount_applied` were written 0/NULL/0 by every producer
while the dashboard summed `discount_applied` as "registration discounts
granted" — a permanently understated figure next to the real one. Columns
dropped from the canonical schema and converged on existing databases;
discounts granted are read from the single document authority (invoices).

**F-B7 · Split payments refunded against an arbitrary obligation.**
`refundPaymentAllocation` read ONE allocation row (`.get()`, no ORDER BY) for a
payment the allocation engine explicitly permits to split across obligations,
and bounded the refund against that single row. Reversal now walks ALL active
allocations LIFO, re-allocating retained settlement against the same
obligation it came from (FS-9: 4,000+2,000 split, refund 2,500 → 2,000 off the
later term + 500 off the earlier).

**F-B8 · Journey enrolments ignored standing discount authorizations.** With
no explicit `discountAmount`, a student with an approved sponsorship/family
grant paid full price on the journey surface while the desk surfaces applied
the same grant — two prices for one student decided by which screen enrolled
them. The explicit-amount ceiling was also derived from catalog tuition while
the charge is the class fee. The route now resolves a ceiling probe AND the
standing discount through the CFG-1 authority against the basis the service
will actually charge (FS-10: grant 20% → term 6,500/5,200, invoice
6,500/1,300/5,200, cap 5,200).

**F-B9 · Diploma cash had no payment, no receipt, no refund path.**
Certificate issuance booked diploma income with no `payments` row — invisible
to payment history, outside the gap-free receipt series, impossible to refund
(the refund route works by paymentId). Now a payment row with receipt, keyed
`diploma-fee:{certNo}`, income linked via `payment_id` (erp-forensic rebased;
the once-per-student and desk-first ordering guarantees still hold).

**F-B10 · Two clocks and offset-dependent date math.** Writers dated money
with `today()` (server-local) while three reader defaults used UTC
`toISOString()` — authorization windows and policy as-of dates could flip a
day early/late depending on the surface. Date+N arithmetic mixed a UTC parse
with a local add and a UTC render, making due dates, freeze windows and report
comparison windows depend on the server's timezone offset. Clock defaults now
use the one business clock; all date arithmetic is UTC-pure (`addDaysISO`).

**F-B11 · wp06 fixture flake (not a product defect).** A session fixture
starting 00:45 made the single-mark test fail whenever the suite ran in the
first 45 minutes of the day (marking is gated on session start). Fixture now
starts 00:00.

### The invariant checker (independent verification instrument)

`core/finance/invariant-checker.ts` re-derives ten financial invariants
(I1 allocation ≤ payment, I2 settlement ≤ due, I3 obligation↔term pricing
integrity, I4 invoice↔term net parity, I5 invoice status vs. collected cash,
I6 no settlement of cancelled obligations, I7 payroll ≤ base per period,
I8 ledger↔payment sign agreement, I9 receipt series never forks,
I10 envelopes never negative) directly from the raw tables WITHOUT reusing
the report/balance code it audits, and exposes them at
`GET /api/finance/invariants`. A check that cannot RUN is a finding, not a pass.

First run against the LIVE database found I2 violated exactly once — the
pre-remediation over-collection artifact from the original drill (8,000
settled on a 6,000 term, written by the pre-fix server). Repaired through the
system's own refund instrument (LIFO reversal returned the term to 6,000/6,000
and the cash to the student). Re-run: **PASS — no violations.** The checker's
own test proves detection (seeded I1 violation caught; the receipt-fork probe
documents the schema-level UNIQUE index as the first layer).

### Verified sound (adversarially probed, no defect)

- **Invoice-cancel semantics** (live-probed): paid → 400; unpaid → 200; fully
  refunded (net 0) → 200; partially refunded (net > 0) → 400. The guard sums
  completed payments NET of refunds.
- **Savings-sweep reversal** — negative income takes main first and reclaims
  the remainder from savings with a contra ledger row; refunds never sweep
  (pinned by `refund-reclaims-savings.test.ts`).
- **DB-ledger defenses observed while testing**: allocation facts are
  append-only and immutable-except-reversal by trigger; `payments.receipt_number`
  is UNIQUE (a fork cannot be written).

### Design note — CORRECTED 2026-09-05 (wave 5)

The wave-4 note below ("no production API funds a budget envelope from
zero") was **wrong** and is superseded. The funding surface exists and is
guarded:

- `POST /api/finance/treasury/deposit` funds the organization treasury
  (capital injection), and `POST /api/finance/budget-lines/:id/charge`
  moves funds from treasury into any envelope (guarded decrement:
  `current_amount >= ?`). Both were exercised live in wave 5
  (`docs/forensic-audit-2026-09.md`, "Wave 5" section below): deposit →
  charge → payroll → month-end return preserved every identity
  (cashVariance 0 / budgetVariance 0, invariants PASS).

*(Historical, incorrect — kept for the record:)* No production API funds a
budget envelope from zero — envelopes are only movable between each other
(month-end return/transfer). A greenfield branch's payroll envelopes start
at 0/0, so a branch cannot run payroll until someone either inserts funds
directly or receives a transfer.

### Verification

- Server suite **2,885 / 2,885** (212 files), typecheck/lint green.
- Forensic suite FS-1..FS-10 **10/10**.
- Live drill (running server, fresh world): 15/15 — class-fee pricing on both
  enrolment surfaces, over-collect caps (desk + cross-surface), drop+re-enrol
  reactivation with single invoice, retake composition, payroll partial
  cap/advance freedom, BOS ceiling drain.
- Invariant checker on the live database: **PASS**.

---

## Wave 5 — 2026-09-05: ledger-identity engine, live rebuild, reconciliation hypothesis refuted

Standing directive: distrust all prior results, including earlier waves of
this same document. Everything below was re-derived from source and re-proven
on a running server.

### Hypothesis 154 (budget reconciliation blind spot) — REFUTED

Claim under test: payroll written as `type='salary_advance'` etc. would
escape `OPERATING_EXPENSE_SQL` and break budget-spent reconciliation.

Source truth: ALL payroll spend — salary, partial, advance, and their voids
(`teachers.routes.ts:103`, `stmtInsertFinTx`) — and ALL `payFromBudgetLine`
spend (`finance.routes.ts:229`) is written `type='expense'` with category
label + `finance_category_id` taken together from the budget line. Empirical
probe through the real routes (treasury deposit → charge → advance) showed
`cashVariance 0 / budgetVariance 0` BEFORE and AFTER. The hypothesis is
refuted; reconciliation sees every envelope spend.

Reporting coherence re-verified: every totals endpoint
(`finance.routes.ts:72–75, 101, 132–135`) uses `OPERATING_INCOME_SQL` /
`OPERATING_EXPENSE_SQL` / `OWNER_DRAWING_SQL`; no raw `type='expense'` sums
remain anywhere in the server.

### New invariant engine — I11–I15

`src/core/finance/invariant-checker.ts` extended from I1–I10 to I15:

- **I11** branch cash identity: branch main balance ≡ operating income −
  saving transfers − owner drawings; branch saving ≡ Σ saving transfers.
- **I12** envelope identity: per budget line Σ allocated ≡ Σ budget
  movements; Σ current ≡ movements − expense (non-owner-drawing).
- **I13** organizational treasury identity: org main ≡ Σ capital
  injections − Σ budget movements; org saving must be 0.
- **I14** payment↔ledger completeness, both directions (UNION ALL):
  every payment row has its ledger rows and vice versa.
- **I15** invoice-items sum: `invoice.total` ≡ Σ invoice items for every
  invoice not in (draft, cancelled).

Pinned by `src/tests/ledger-identity-invariants.test.ts` (6/6): a world
built **only through production surfaces** (treasury deposit → charge →
student fee → salary partial + advance → BOS withdraw correctly refused at
the 6-month liquidity floor → month-end return) passes; each identity,
corrupted the way a tamper would write it, is detected; restoring the data
returns the checker to clean.

### Books refund path — verified sound

`books-service.ts` refund (~:630–700): idempotency candidates + unique
`sale_id`, single transaction, negative payment + `recordIncome` refund.
Stock is the `book_inventory_positions` VIEW (`schema.sql:2136–2143`):
`sold_quantity` excludes refunded sales via `NOT EXISTS`, so stock restores
automatically on refund. Invoice-create totals re-verified (`assertMoney`
on computed total; discount ≤ total at 400; net computed). All student
payment writers pair payments with `recordIncome`.

### Operational finding — backup bootstrap requires external dir

Server bootstrap hard-fails until `BACKUP_EXTERNAL_DIR` is set to a
non-empty, non-placeholder path whose `pathKey` differs from the local
`./data/backups` (`database-backup.ts:244,262`). Not a defect (it forces an
off-host copy at startup) but it blocks any zero-config start; deployment
docs should state it. The startup backup ran and verified (sha256 recorded)
once configured.

### Live rebuild + drills (fresh seeded world, running server :4000)

- Fresh seed (owner only, no demo data); owner bootstrapped; server live.
- **Three-store battery 9/9**: invariants + reconciliation healthy before;
  treasury deposit 60,000 → envelope charge 20,000 → salary partial 1,500 +
  advance 700 → month-end return; invariants + reconciliation healthy
  after (cashVar 0 / budgetVar 0).
- **Live drill FS3 14/14** on the same world: class-fee pricing on both
  enrolment surfaces; over-collect caps (desk 400; cross-surface
  invoice-pay attack 400); drop+re-enrol reactivates the ONE term at the
  class fee with a single live tuition invoice; retake = 6,500 + 2,000;
  payroll partials capped (900 + 1,100 then third refused 409 — the 409
  initially observed was the *correctly emptied* envelope, recharging it
  confirmed the cap logic); invariants + reconciliation PASS after the
  drill.
- Suite: **213 files, 2,889 passed, 2 skipped** with the new identity tests.

### Wave-5 verdict

No new material weakness found. Wave-4's "no funding API" design note was
factually wrong and is corrected above. Remaining surfaces still to
re-attack: treasury deposit/withdraw concurrency, month-end races,
migration/historical data.

### Wave-5 addendum — concurrency races, boundary fuzz, migration/history

All on the running rebuilt server (fresh seeded world, live HTTP):

- **Treasury charge race (6/6)**: org treasury drained to exactly 0, funded
  with exactly 500, then 8 concurrent `POST /budget-lines/:id/charge` of
  500. Exactly **1 won (201), 7 refused (409)**; treasury ended at 0 and
  was never negative; invariants + reconciliation clean. The guarded
  `decrementMainBalanceIfSufficient` holds under genuine concurrency.
- **Month-end race (8 concurrent `decision:'return'` on the same funded
  envelope)**: exactly 1 moved money, 7 got 400 (envelope already zero) —
  `stmtDebit` is guarded (`current_amount >= ? AND allocated_amount >= ?`,
  budget-movements.ts:94–96), so two concurrent returns cannot both
  succeed.
- **Structural note (why the races are safe at all)**: better-sqlite3 is
  fully synchronous and every money handler keeps the
  read-validate-write stretch inside one synchronous block (no `await`
  between balance read and `db.transaction`), so the event loop cannot
  interleave them; the guarded UPDATEs are the second line of defense for
  a hypothetical multi-process deployment.
- **Money-in boundary fuzz (28/28 refused)**: `0, -5, '0x10', true,
  [500], null, undefined, 1e15, 0.001, '50a', {}, 'NaN', Infinity, -0.5`
  against both `/treasury/deposit` and `/budget-lines/:id/charge` — no
  acceptance, org treasury delta 0, invariants pass, reconciliation
  healthy. (`assertMoney` at the boundary.)
- **Migration / historical data reviewed** (`src/db/connection.ts`):
  (1) `registrations` financial lookalike columns (`amount_paid`,
  `receipt_number`, `discount_applied`) dropped — they were always
  0/NULL/0 fiction; payments/invoices remain the authorities. (2) legacy
  invoices get `charge_kind = NULL` via `ALTER TABLE`;
  `normalizeInvoiceChargeKind` (invoicing.ts:252) falls back to
  `purpose` and finally `'other'`, and over-collect caps are
  kind-independent (paid vs total), so historical invoices pay and cap
  correctly. (3) `reconcileCanonicalFeeAuthority` skips non-canonical
  legacy fee amounts so a live charge blocks rather than guessing a fee.
  No migration path can write history that violates I1–I15.

**Wave 5 closed.** Every planned surface (reconciliation semantics,
refund/reversal fidelity, ledger identities, concurrency, month-end
races, migration/history, boundary fuzz) has been attacked and either
held or produced a fix in an earlier wave. No open material weakness.
The rebuilt live world remains running (`server/` on :4000, owner
account `owner` — password rotated during the live drills, see
`docs/forensic-audit-2026-09.md` wave-5 section).

---

## Wave 6 — 2026-09-05: the classification itself, conservation from first principles, books inventory economics, business timezone

Standing directive unchanged: distrust everything, including wave 5. Wave 6
attacked the weakest point of my own prior work — **the I11–I15 identities
reuse `OPERATING_INCOME_SQL`/`OPERATING_EXPENSE_SQL`, the same classification
the reports use. A misclassified category would satisfy every invariant while
every report lies.** A reconciliation that compares the ledger to itself reads
0/0 forever.

### Category-semantics audit (income rule is residual)

`OPERATING_INCOME = type='income' AND category <> 'capital_injection'` — a
*residual* definition: any new cash-in surface becomes revenue unless its
category string is exactly `capital_injection`. Full writer inventory drawn
from source AND from the live ledger:

| category | writers | verdict |
|---|---|---|
| fee, book, exam, placement, diploma, card | students/invoices/exams/books | genuine revenue |
| other | extra class fee, registration invoice pay | genuine revenue (coarse label) |
| donation | funding-service (with donation_id pair) | revenue for the school; acceptable |
| refund | **negative** income (contra-revenue) | correct treatment; savings reclaim verified |
| capital_injection | treasury deposit only | excluded from revenue ✓ |
| salary / salary_advance | payroll + voids | advance lands on `sub_salary_advances` = non-expense (receivable) ✓ verified live |
| book_purchase | NEW (wave 6) | `sub_books_educational` operating expense |
| owner_drawing | BOS withdraw | `sub_owner_drawings`, equity, excluded from P&L ✓ |

No non-revenue cash-in category leaks into operating income. The payroll
advance (receivable) vs salary (cost) split is written correctly by every
writer, confirmed in the live ledger rows.

### W6-1 (MATERIAL, fixed): book inventory acquisition was financially invisible

`receiveBookStock` — and, found by self-attack, `createBookCatalogItem`'s
initial receipt too — recorded quantity + `unit_cost` with **no financial leg
at all**: no expense row, no cash movement, nothing. The sale booked
full-price income. `unit_cost` was write-only data (no COGS, no inventory
valuation, no consumer anywhere; no supplier-payment surface in the Books
module; no reconciliation tying receipts to book-purchase expenses).

Economic consequence: **the P&L permanently reported a 100% book margin.**
Cash paid to suppliers vanished from the books only if nobody manually
recorded an operational payment; nothing enforced or reconciled it. No
invariant could see the gap — conservation compares the ledger to itself, and
the purchase was never in the ledger. This is precisely the "balanced ledger,
wrong economic reality" class the audit exists to find.

**Fix (the boundary, not a heuristic):** a receipt that carries acquisition
value must now DECLARE how it is paid —
`purchase.paidFromBudgetLineId` (paid NOW, atomically with the receipt:
guarded envelope debit + `book_purchase` expense row on
`sub_books_educational`, all one transaction) or
`purchase.declaration: 'separate'` (expense workflow) or `'not-applicable'`
(donation/transfer). Silence is a 400. Both entry paths (restock + catalog
create) share one implementation so the semantics cannot drift. Schema:
`book_stock_receipts.purchase_declaration`, `.purchase_transaction_id`
(+ startup migration for existing databases; legacy rows keep NULL and are
pre-declaration history, not rewritten). Idempotency intent includes the
purchase block. Client: both dialogs gained a mandatory "How is this purchase
paid?" selector with live budget-line balances.

Live-verified on the rebuilt server: silent costly receipt → 400 with zero
trace; paid receipt → envelope 5000+4000→**−3000 atomic**; classified
`book_purchase` row written; sale → income; conservation exact
(118,200 = 118,200) through the whole chain.

*Honest limit:* under the system's cash basis, cost lands at purchase and
revenue at sale (period mismatch for unsold stock is inherent to cash basis —
same treatment as salary and supplies). Follow-up recorded: surface
inventory-at-cost as a visible metric in the Books workspace.

### W6-2 (fixed): business dates were server-timezone dates

`today()` returned the **server-local** date; no timezone is configured
anywhere, and the server runs UTC while the business is Kabul (UTC+4:30, no
DST). Every Kabul date from 00:00–04:29 was booked to the previous business
day — at a month boundary, to the previous month (a fee paid 00:15 Kabul on
Sep 1 landed in August's P&L). Same defect in payroll's private
`gregorianToday()`. **Fix:** both pinned to `timeZone: 'Asia/Kabul'`
explicitly — deployment-independent. The calendar authority
(`core/calendar/periods.ts`) already routes through `today()` and is covered.

### W6-3: new invariant I16 — conservation of money, no shared SQL

I16 re-derives total money from RAW external flows only (Σ income − Σ
expense, signed by type, zero category knowledge) and compares with every
store (account mains + savings + envelope currents; budget/saving movements
are internal by construction). It catches store/ledger divergence **even
along paths whose categories every report agrees about** — including direct
balance tampering: +500 to a branch account with perfectly classified books
is detected and named. Pinned in `books-acquisition-accounting.test.ts`,
including the proof that I16 flags a direct-balance INSERT as unexplained
money (it caught the audit's own first test fixture doing exactly that).

Scope honesty: I16 sees internal divergence; it cannot see an economic event
that was never recorded — that is why W6-1 is a **boundary requirement** on
the receipt API, not an invariant.

### Also verified this wave

- Payroll void paths: `BEGIN IMMEDIATE` + fresh re-read + `status='posted'`
  recheck inside the transaction → double-void serializes to 409; the
  unguarded-looking `stmtUpdateBudgetAmount` is only reachable with negative
  (credit) values from the void reversals — no overdraft path exists.
- Books refund: negative income (contra-revenue) + savings reclaim + stock
  restored via the `book_inventory_positions` view.
- Bootstrap FK gate caught and forced repair of 3 orphan rows the audit's
  own debug cleanup had left (budget_lines ×2, user_roles ×1) — the gate
  works, and the incident is recorded rather than hidden.
- Suite: **214 files, 2,894 passed, 2 skipped** (new: acquisition accounting
  5/5; everything green under the Kabul-pinned clock).
- Live: invariants I1–I16 pass, reconciliation 0/0 after the full books
  economics chain on the running server.

### Wave-6 verdict

Two real defects found and fixed (W6-1 books acquisition economics — a
genuine accounting-model hole; W6-2 business-calendar timezone). One new
first-principles invariant (I16) that does not share SQL with the reports.
The income-classification residual rule was audited and currently holds.
Next surfaces to attack: receivables independent derivation vs reports,
SoD (self-approval above threshold), donation restriction economics.

### Wave-6 continued — receivables four-way reconciliation, SoD, donation restrictions

**Receivables (report vs independent derivation).** Re-derived branch
arrears from raw events (active terms − completed payments − active aid
allocations, per-student floored) and compared with every representation:

- `GET /reports/overview` `financial.outstanding.tuition` = **25,000** —
  matches the independent tuition-only derivation **exactly** (Desk
  6,500−2,500=4,000 ×2; Journey 15,000−6,500=8,500 ×2). The report and the
  BOS arrears share the terms−payments authority (`getBranchOutstanding`),
  which F18b made aid-aware; the invoice-basis figure is NOT used for
  arrears. (An initial 21,000-vs-25,000 "mismatch" was the audit probe's own
  category-scope error — registration payments subtracted from tuition due.
  Decomposition before declaration, always.)
- The invoice-based derivation (22,000) disagrees per-student in BOTH
  directions for structural reasons: desk-path semester payments carry no
  `invoice_id`, and desk-path terms have no invoice at all. It is used only
  for `nonTuition`, which is explicitly document-borne and per-invoice
  floored, with its basis stated in the response.
- **Control note (recorded, not a defect):** a desk payment with category
  `other` never settles a non-tuition invoice; staff bypassing invoice-pay
  leave documented debt overstated. Non-tuition collections should route
  through invoice-pay; a reconciliation line for unlinked `other` payments
  is a candidate follow-up.

**Segregation of duties.** `/expense-requests/:id/decide` refuses
requester==approver (403) unless the approver is the owner (the capital
authority; deliberate). Threshold auto-pay on `/operational-payments` is
the documented design (threshold-gated, notified, audited).

**Donation restriction economics.** Restrictions are a real subledger, not
metadata: donations flow into scholarship funds / sponsorship receipts /
restricted campaign entries (`getDonationUnallocated` caps one destination);
allocations are triple-guarded (fund available, award remaining, obligation
outstanding), transactional; reversal returns money to the AWARD (donor
money stays committed) with release-to-fund as a separate explicit act. No
double income: the allocation moves no cash; the donation was the income.

**Payroll void re-check.** `BEGIN IMMEDIATE` + fresh re-read +
`status='posted'` recheck inside the transaction: a double void serializes
to 409 and cannot double-credit the envelope. The unguarded
`stmtUpdateBudgetAmount` is reachable only with negative (credit) values.

**Wave 6 closed.** Two material findings fixed (W6-1 books acquisition
accounting, W6-2 business timezone), one new first-principles invariant
(I16), receivables reconciled independently and exactly, SoD and donation
restrictions verified sound, three control notes recorded. Remaining
follow-ups: inventory-at-cost visibility in the Books workspace, unlinked
`other`-payment reconciliation line, legacy pre-declaration receipts
surfacing.

---

## Wave 7 — economic completeness (full matrix in docs/forensic-audit-wave7-economic-matrix.md)

Wave 7 began from real-world economic events, not the ledger. The complete
event matrix (31 event classes → operational record → financial consequence →
cash effect → trace → reversal → reporting) is delivered as
`docs/forensic-audit-wave7-economic-matrix.md`. Headlines:

- **W7-1 (fixed): stock loss/found was economically unrepresentable.** The
  only quantity-decreasing event was a sale, which books revenue — so a
  physical loss could only be recorded by fabricating income. New
  `book_stock_adjustments` surface: quantity-only (no financial leg — cost
  was expensed at purchase under cash basis), kind loss/found/correction,
  reason ≥8 chars, idempotent, immutable by trigger, availability floor in
  the trigger, sale/loan guards + inventory view include adjustments, schema
  convergence handled (DROP+CREATE for changed triggers). 6/6 tests, 7/7 live.
- **W7-2 (gap recorded): no debt write-off surface.** Dropped students'
  debt is owed forever; only payment settles. Forgiveness is policy — needs
  an explicit owner decision (§61), not an invented feature.
- **W7-3/W7-4 (notes):** future payroll periods accepted (cash-basis
  defensible); books dates back/future-dateable by authorized users (reports
  consistent with stored dates; control consideration).
- **Re-verified this wave:** transfer preserves the obligation (0-fee
  destination term, no double bill) with the receivable authority
  lifecycle-INCLUSIVE (no status filter — debt cannot vanish in a status
  change); fee/net_fee immutable after creation (no writer updates them);
  employee advances recovered through the due-cap that counts advances;
  sponsorship returns are internal re-routes; drop keeps debt payable
  (settlement keys on obligation, not term status).
- **Independent report battery 9/9** (my SQL, not the app's): revenue,
  payroll, cash, envelopes, receivables, settlement completeness, donations,
  inventory, advances — all exact.
- **I16's external-flow definition formally defended** (§2 of the matrix):
  exactly-once pairing proven by complete writer inventory + DB CHECK
  vocabulary; no internal/external ambiguity; honest limit stated — cash
  stores only, and unrecorded events are invisible to every
  self-consistency check, which is why W6-1/W7-1 are boundary requirements.
- Suite 215 files / 2,900 passed / 2 skipped; live invariants I1–I16 + 0/0
  reconciliation after the adjustment drill.

---

## Wave 8 — economic reality coverage (full matrix in docs/forensic-audit-wave8-coverage-matrix.md)

Wave 8 stepped OUTSIDE the ERP: one real accounting period of a Kabul ESL
institute was reconstructed from the outside (hawala sponsors, publisher
credit, Eid bonuses, prepaid rent, capex, an owner's friend lending money),
then every event was tested against the software with absence-of-surface
claims proven from source. Deliverable:
`docs/forensic-audit-wave8-coverage-matrix.md` — ~60 independently
discovered events classified A–G, semantic collisions, the cash-basis
legitimacy line, historical impact, and the ten-point judgment.

Headlines:

- **Material capability gaps (F, forward-looking — zero rows damaged
  today, verified):** supplier payables (the `separate` declaration is an
  unreconciled promise — inventory without liability); the write-off family
  (uncollectible student debt, uncollectible staff advances on termination,
  permanent employee deductions); restricted-fund segregation (restrictions
  are tracking-only — no expense path consults them, cash pools freely);
  external debt representable only as equity (loan via capital_injection:
  solvency invisible).
- **Taxonomy finding (C, core-level):** the income side is a residual rule
  — bank interest, asset-disposal proceeds and supplier rebates all become
  OPERATING revenue through `other`. The expense side already has explicit
  classes; the income side needs the same redesign. This is the one
  structural fix that needs no owner policy decision.
- **Workaround findings (D):** employee bonus (due-cap = base only; detached
  Staff-Benefits expense severs the compensation record); overpayment credit
  and mid-term earned waivers (only via fabrication); supplier rebates
  (forced fake revenue).
- **Verified-clean surprises:** teacher performance bonuses ARE computed
  into dues by the rule engine; inter-branch value transfer works through
  the treasury hub BY DESIGN (return + charge, both proven primitives) —
  not a workaround; hawala fees and prepaid rent are representable within
  the declared basis.
- **Honest bypass conclusion:** unrecorded physical cash is beyond any
  software; the ERP makes it detectable (sequential receipts, conservation
  over everything recorded) but lacks a cash-count surface to anchor the
  daily procedure (recorded F-lite).
- Cash-basis legitimacy line drawn precisely (§11 of the matrix): timing
  simplifications legitimate; lost obligations are not.

No code was changed this wave by design: every remaining gap requires an
owner policy decision (supplier terms, write-off authority, loan terms,
fund segregation) or the income-taxonomy redesign, which is specified but
deliberately not smuggled into an audit commit.

---

## Wave 9 — financial operating model (full document: docs/forensic-audit-wave9-financial-operating-model.md)

Design wave; no code changed. The declared basis was deduced from writer
behavior and named precisely: **cash-recognition accounting with
economic-state memos**, whose coherence law is "every memo must be
lifecycle-complete." Wave 8's gaps are exactly the lifecycle-incomplete or
missing memos. Deliverables:

- **Per-area policy question tables** (supplier payables P1–P4, write-offs
  P5–P10, restricted funds P11, loans P12–P15) — each with the economic
  stake, dependents, and the consequence of remaining undefined. Nothing
  answered without source; all open questions marked UNKNOWN per LAW 10.
- **Semantics derived, not invented:** student-debt write-off = memo
  discharge with NO P&L effect (unpaid tuition was never revenue under cash
  recognition — a bad-debt expense would be incoherent); staff-advance
  write-off = expense recognition at renunciation (the advance WAS cash
  out); credit purchase = payable memo at goods receipt + single expense at
  the settlement cash event (double-count impossible by construction);
  restricted-fund exposure derivable from the existing subledger without
  new stores.
- **Equity distortion of capital_injection-as-debt proven** mechanically;
  production attestation flagged (loan-vs-equity is unknowable from data).
- **Income taxonomy redesigned as semantics** (§5): explicit classes,
  funding income separated, `loan_proceeds`, contra-refund, and
  `non_operating_other` as the CONSERVATIVE DEFAULT replacing the residual —
  unknown inflows can no longer become operating revenue by accident
  (mirroring how uncategorized expenses never vanish). Interest/finance
  income excluded pending P13 (Islamic-finance observation recorded, not
  decided).
- **Ledger role resolved:** typed economic-event journal; balances are
  derived views; lifecycle belongs to memo entities, classification to
  categories — no more string-category lifecycles.
- **Authorized now (no policy dependency):** income taxonomy implementation,
  restricted-fund exposure report, employee bonus via payroll
  due-composition (symmetric completion of the existing teacher design).
- **Blocked at policy:** supplier payables, write-offs, loans, fund
  enforcement — each with the named decision list.
- **Falsification log** (10 constructed attacks on the proposed model) and
  the final A–F verdict table.

Wave 9 closes with the model independently coherent, policy boundaries
explicit, and implementation authorized only where no financial meaning
would be invented during coding.

---

## Wave 10 — economic-state architecture verdict (full: docs/forensic-audit-wave10-state-architecture-verdict.md)

Read-only falsification wave on the memo layer itself. **Verdict: CONDITIONAL
PASS.** The entity + immutable amount + append-only settlement + derived
position + guarded event-style reversal pattern is sound and consistently
implemented for tuition receivables, funding commitments, payroll facts and
inventory; it is not a hidden second ledger. Conditions before Wave-9
capabilities may be built on it:

- **W10-1 (defect, code-proven):** `student_installments` flag flip is
  one-way — a refunded installment payment leaves the installment 'paid'
  while the obligation re-opens, and re-payment via the installment path
  409s. Zero live rows today; fix = event-style reversal symmetric with
  allocations.
- **W10-2 (temporal defect):** class merge rewrites `student_semesters.
  class_id` with no enrollment events and no effective dating — attribution
  history survives only in audit text. Also: the table has no `created_at`;
  PIT reconstruction works at date granularity only (live probe verified:
  receivable-as-of = 25,000 = current).
- **W10-3 (reconciliation asymmetry):** cash has runtime invariants; the
  memo layer has none — obligation↔allocation↔payment and
  installment↔allocation coherence exist only in tests. Add runtime memo
  invariants + composite unique (obligation_id, payment_id) on allocations.
- **W10-4 / P16 (policy):** staff-advance recovery is period-locked and
  unattributed — an independent outstanding-advances figure is underivable;
  cross-period recovery is unrepresentable. Owner decision required.

Confirmed sound: obligation identity DB-unique per term; refund reversal
chain guarded/idempotent/reason-preserving; resurrection impossible;
scholarship/sponsorship closures exemplary; PIT receivable derivable at
date granularity; no orphan/duplicate/contradictory state reachable in the
request lifecycle. Historical production impact: none (0 installments,
0 refunds, 0 merges live). Wave-11 gate: fix W10-1/2/3, decide P16, then
the three Wave-9 authorized items, then policy-gated items.
