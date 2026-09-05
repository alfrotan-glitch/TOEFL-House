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

### Design note (recorded, not a weakness finding)

No production API funds a budget envelope from zero — envelopes are only
movable between each other (month-end return/transfer). A greenfield branch's
payroll envelopes start at 0/0, so a branch cannot run payroll until someone
either inserts funds directly or receives a transfer. Operationally worth a
deliberate funding surface; no money can be created or lost through the gap.

### Verification

- Server suite **2,885 / 2,885** (212 files), typecheck/lint green.
- Forensic suite FS-1..FS-10 **10/10**.
- Live drill (running server, fresh world): 15/15 — class-fee pricing on both
  enrolment surfaces, over-collect caps (desk + cross-surface), drop+re-enrol
  reactivation with single invoice, retake composition, payroll partial
  cap/advance freedom, BOS ceiling drain.
- Invariant checker on the live database: **PASS**.
