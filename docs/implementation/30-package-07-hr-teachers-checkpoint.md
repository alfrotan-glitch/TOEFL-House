# Package 08 Checkpoint — HR/Teachers

**Package:** 08 — HR/Teachers (sequence row 7: employment, contracts, work basis, leave)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a0381a-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** Package 07 checkpoint (`29-package-07-academic-decisions-checkpoint.md`) at commit `9b9341b`

## Discover

- Governance inputs consumed: HR/payroll domain model (foundation 36 — Employment "status history retained", Contract "signed terms immutable once used", Compensation "effective-dated", Work/Teaching Basis "source evidence retained", Leave "approval/history retained", Termination "access ends, history retained"), lifecycle registry (32 — Employment/Contract: Candidate, Active, Leave, Suspended, Transferred, Terminated, Settled, Archived under approved transitions; "payroll cannot invent silent terms"), relationship registry (31 — Employee↔Contract 1:N effective contract, prior closed; Contract↔Compensation 1:N, entitlement immutable once used; Employee↔Leave 1:N period required), boundary contracts (43 — Identity→HR requires verified person, reject unverified and audit; Academic→HR/Payroll teaching evidence as controlled input, "hold disagreement; preserve evidence"; HR→Payroll/Access status as decision input), authority registry (33 — payroll/compensation family: forbidden beneficiary self-approval), requirements (08 — REQ-HR-001 compensation changes reviewed then GM-approved; G1-REQ-003 two-Owner rule noted for material cases), HR/payroll architecture (implementation doc 11: HR owns employment/contracts/compensation terms/leave/termination; payroll and settlement are later packages).
- Payroll entities (Payroll Period, Calculation, Result, Adjustment, Clearance, Final Settlement) are **out of scope** — sequence row 8.

## Map (implemented scope)

- **Employment** (`Employment` + append-only `EmploymentStatus`): verified person → `candidate` → `active` (hire requires an active signed contract); `active→on_leave|suspended|terminated`, `on_leave→active`, `suspended→active|terminated`. **One open employment per person** (partial unique index excluding `terminated`). Every transition **appends status history** (DB trigger keeps it append-only); the current status is the latest fact.
- **Termination**: mandatory reason; closes the open active contract (with effective date), cancels pending/approved leave, and **revokes open position assignments through the Access module's own command** (`TransitionPositionAssignment::revoke`) so **access ends with employment** without HR writing Access persistence directly. Employment history is retained.
- **Contract** (`Contract`): draft terms → sign (signed-document evidence reference mandatory) → active; **signed terms immutable once active** (DB trigger blocks term/signature/start-date mutation; a change is a new contract; rows can never be deleted); **one open (draft|active) contract per employment** (partial unique index); closing sets an effective end date after the start.
- **Compensation** (`CompensationComponent`): kind ∈ {fixed, hourly, class_based, allowance} with positive amount; **proposed by HR, activated by a different approver** (`hr.compensation_approve`), and **never the beneficiary** (the employed person); effective-dated within the contract window, **no overlapping active component of the same kind** (domain check under lock); **immutable once active** (DB trigger) — an entitlement change is a new effective-dated component (history retained, ready for payroll snapshots).
- **Work basis** (`WorkBasis`): append-only evidence (DB trigger) of hours/classes; `academic` source references a real teaching assignment of the same person (read-only consumption of Academic evidence); when the evidence disagrees with the employment state it is **held with a note — preserved, never dropped**; `manual` declarations require an open employment and an evidence reference.
- **Leave** (`Leave`): request (category, period, reason) → approve/reject by a **different actor**, cancel; **one pending request per employment** (partial unique index); **approved leaves may not overlap** for the same employment (domain check under lock); leave attaches only to open employments; decisions and history retained.
- Capabilities: `hr.employ`, `hr.contract`, `hr.compensation`, `hr.compensation_approve`, `hr.leave_request`, `hr.leave_approve`, `hr.workbasis`, `hr.terminate` — all separate; termination additionally exercises `access.assign_position` through the Access command.
- Persistence: 6 migrations (`2026_08_26_000045`–`000050`) owned solely by the HR module; CHECK constraints (employment/contract/leave states, compensation kinds/amount/period, work-basis source/unit/state, periods); partial unique indexes (one open employment per person, one open contract per employment, one pending leave per employment); append-only/immutability triggers on `employment_statuses`, `work_bases`, `contracts` (terms + no-delete), `compensation_components` (active).

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | `php vendor/bin/phpstan analyse --memory-limit=1G` — level 6, `[OK] No errors` |
| lint | PASS | `php vendor/bin/pint` — `PASS 226 files` |
| unit tests | PASS | `php vendor/bin/phpunit` — **OK (222 tests, 847 assertions)** |
| integration tests | PASS | employment/contract/compensation/leave/work-basis/termination chains against PostgreSQL atomically (7 feature tests + HR lifecycle unit suite) |
| invariant tests | PASS | one open employment; one open contract; signed-terms immutability (raw SQL vs trigger); active compensation immutability (raw SQL vs trigger); status history append-only; work-basis evidence append-only (raw DELETE vs trigger); no overlapping active compensation or approved leave |
| authorization tests | PASS | unverified person rejected; unprivileged employment denied with audit and no row; compensation proposer≠approver and beneficiary self-approval forbidden (guards fire while holding the capability); leave requester≠decider |
| lifecycle tests | PASS | full employment chain incl. suspension and reinstatement; terminated→active impossible; contract draft→sign→close; leave request→decide→cancel; unit matrix asserts absent edges |
| contract tests (boundary) | PASS | Academic teaching evidence consumed read-only; Access mutated only through its own command; Identity person verified before employment |
| financial tests | NOT APPLICABLE | payroll/finance packages later in the sequence |
| concurrency/idempotency tests | PASS | repeat commands return original outcomes; same key + different payload rejected (inherited harness exercised through every command) |
| migration/schema validation | PASS | `SchemaInvariantFeatureTest` extended (employment/contract/leave indexes; employment-state, contract-state, work-basis-source CHECK vectors; catalog assertions for all five HR triggers); database migrated to all 50 migrations |
| adversarial review | PASS | see below |
| regression verification | PASS | full cumulative suite green after every repair |

## Attack (adversarial verification)

Vectors executed, all failing closed:

1. Employment of an unverified person — rejected (`hr.person_not_verified`), no row.
2. Second open employment for the same person — rejected (domain + partial index).
3. Second open contract while one is open — rejected; raw SQL forgery of signed terms — rejected by the trigger; raw DELETE of a contract — rejected by the trigger.
4. Proposer activating their own compensation component — denied even while holding the approve capability (`hr.compensation_not_independent`).
5. Beneficiary approving their own compensation — denied (`hr.compensation_beneficiary`).
6. Overlapping active component of the same kind — rejected (`hr.compensation_overlap`); raw SQL amount tampering of an active component — rejected by the trigger.
7. Compensation attached to a non-active contract or starting before the contract — rejected.
8. Leave decided by its requester — denied (`hr.leave_not_independent`); overlapping approved leave — rejected (`hr.leave_overlap`), the second request stays pending.
9. Leave requested against a suspended/terminated employment — rejected.
10. Academic evidence for a different teacher's assignment — rejected (`hr.workbasis_person_mismatch`); evidence disagreeing with employment state — **held and preserved**, not dropped; manual evidence without an open employment — rejected; raw DELETE of work-basis evidence — rejected by the trigger.
11. Reinstatement of a terminated employment — rejected (`hr.employment_transition_forbidden`).
12. Termination without access revocation — impossible: the termination chain closes the contract, cancels leave, and revokes assignments in one transaction; `active` position assignments for the person are asserted zero afterwards.
13. Unprivileged employment creation — denied with audit evidence (`hr.employment.employ.denied`) and no row.

## Repair log (defects found by verification, fixed, reverified)

1. HR models missing `$incrementing = false` / string key type — char(36) ids read back as `0` after create (FK failure on status insert) — fixed on all six models.
2. char(36) padding on `person_id` comparisons (beneficiary and teacher-identity checks silently never matched) — comparisons now trim both sides.
3. Leave/compensation negative-path actors lacked the very capability under test (capability denial masked the independence guard) — actors now hold the capability so the *independence* guard fires; the leave approver capability was added to the manager fixture.
4. Beneficiary fixture created the person twice (duplicate PK) — the verified person is now seeded through the authority fixture.
5. phpstan generics on unused Eloquent relation methods — removed (nothing consumes them; consistent with the existing modules' style).

## Decide

- `Settled`/`Archived` employment states and HR/Finance clearance/final settlement arrive with the Payroll package (registry order); `Terminated` is terminal here.
- `Transferred`/`Promoted` are not employment states in this implementation: they are new effective contracts and position assignments (close prior, start new) — employment continuity and full history retained.
- Termination revokes access through the Access module's own command (actor holds both capabilities) rather than HR writing Access tables — persistence ownership stays with Access.
- Held work-basis evidence (academic/employment disagreement) stays `held` until Payroll/HR review consumes it — no silent resolution exists yet by design (foundation: "hold disagreement; preserve evidence").
- REQ-HR-001's HR+Finance review before GM approval is modeled as separate propose/activate capabilities; the Finance-role grants are configuration (the Finance module arrives later in the sequence).

## Certified

Package 08 — HR/Teachers: **CERTIFIED — PASS** (2026-08-26). Gates: phpunit **OK (222 tests, 847 assertions)**, phpstan level 6 clean, pint clean (226 files), database at 50 migrations, environment verification `ENVIRONMENT VALID`. Business rules, architecture, module boundaries, and implementation contracts unchanged; no parallel behavior; Packages 02–07 untouched.
