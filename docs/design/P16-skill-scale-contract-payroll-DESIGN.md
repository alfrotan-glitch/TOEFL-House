# P16 DESIGN ARTIFACT — Skill / Scale / Teacher Contract & Payroll
**Phase: DESIGN + CHALLENGE ONLY — NOT IMPLEMENTED. No code, no migration, no schema, no test, no commit.**
Baseline: P02–P15 certified (`4df01f7`); audit report of the HR/Payroll chain accepted as evidence base.
This file is a design artifact. It modifies no certified implementation record.

---

## A. Executive decision

Skill (what is taught) becomes an **Academic-owned** closed catalog; Scale (compensation rank) becomes an **HR-owned** closed catalog — independent of Skill and of academic Level. Contracts gain **immutable versions** with the lifecycle `draft → submitted → approved → active → superseded|expired`, prepared/submitted by the **Finance Manager**, approved by the **General Manager** (preparer ≠ approver ≠ beneficiary, DB-enforced), carrying **normalized compensation rules keyed by (method, skill?, scale?)** with a deterministic precedence ladder. Payroll volume moves from manual `work_bases` to **evidence-derived delivery facts**: one payable unit = one **delivered session attributed to (teacher assignment, skill)** — a session pays at most once, ever, enforced by a database unique index. Every calculation snapshots the full rule set, version, scale, skill breakdown and evidence ids, so later Skill/Scale/contract changes can never rewrite approved payroll. The existing per-kind overlap rule and rate-by-kind resolution are formally retired as a **proven conflict**. Finance (journals) and P13 `payroll_total` remain untouched.

## B. Current architecture (audit-verified)

```
Person → Employment → Contract(draft→active→closed, terms_summary text, signed immutable)
                        └─ CompensationComponent(kind∈{fixed,hourly,class_based,allowance},
                           effective-dated, no same-kind overlap, immutable when active)
teacher_assignments(class, teacher_person, effective-dated)  [no skill dimension]
class_sessions(date, start, end)  [no state, no teacher, no skill]
attendance_facts(session, enrollment, status, corrections)
work_bases(employment, source∈{academic,manual}, unit∈{hours,classes}, quantity MANUAL, evidence_ref)
payroll: contract→components→Σ(fixed+allowance)+Σ(rate×manual quantity); snapshot jsonb; approve/adjust/reverse
finance: journals source_type='payroll_result' (manual posting); opening payables (P15) independent
```
Deficiencies (from audit): no Skill, no Scale, no per-skill rate space (per-kind overlap conflict), volume manual, contract sign without independent approval, contract type unmodeled.

## C. Target architecture

```
Person → Employment → Contract (chain header, one open chain per employment)
                        └─ ContractVersion (immutable approved; lifecycle; type; effective window;
                           FM submitted / GM approved; rules frozen at approval)
                              └─ CompensationRule(method, skill?, scale?, rate/amount, additive lines)
Skill catalog (Academic) ←─ teacher_assignment_skills ← teacher_assignments(Academic)
Scale catalog (HR) ─────────────^ (pinned on the contract version)
class_sessions(+skill_id, Academic) → delivery qualification = attendance evidence
teaching_delivery_facts (Payroll-owned claim rows; unique(session_id)) → payroll_calculation v2
   (rate resolution per skill; snapshot with version/rules/scale/evidence) → PayrollResult → Journal (unchanged)
```

## D. Skill model — owner: **Academic** (DECIDED)
- Boundary contract 43: the **teaching fact belongs to Academic** ("controlled input; hold disagreement; preserve evidence"); Skill classifies the teaching fact. HR/Payroll reference skill ids read-only.
- Table `skills` (Academic-owned): `id, key unique, name, state ∈ {active, retired}`; CHECKs; retired rows immutable + undeletable (trigger); **no delete ever** (historical payroll references).
- Initial catalog: `speaking_listening`, `writing_grammar`, `reading_vocabulary` — seeded as explicit registration commands (evidence, audit), not free text. Catalog is **closed** (registration capability `academic.skill`).
- Independent from academic Level by construction: no FK or column linking skills to levels; levels stay where they are (curriculum/placement).
- A teacher has multiple Skills via `teacher_assignment_skills`; a class has multiple Skills via its sessions/assignments; nothing keys compensation to Level.

## E. Scale model — owner: **HR** (DECIDED)
- Table `scales` (HR-owned): `id, key unique (e.g. 'S1'..'S4'), name, rank_order int unique, state ∈ {active, retired}`; retired immutable; no delete.
- **Scale is pinned on the ContractVersion** (`scale_id NOT NULL` for versions that use scale-dependent rules; nullable for pure fixed contracts). Rationale: compensation rank only exists inside a compensation instrument — this keeps ONE source of truth (no parallel employment-level scale history), makes "one active scale at a time" a consequence of "one active contract version", and makes scale changes explicit governed amendments. (Alternative rejected — see V.)
- A teacher's current scale = scale of the active contract version. Changing S2→S3 = new version effective from a date; approved payroll untouched (snapshot). Rules MAY also be written scale-independently (skill-only) — then the version's scale is recorded in the snapshot for reporting only.
- Actual scale set: **DECIDED** — the approved initial catalog is S1 Junior, S2 Standard, S3 Senior, S4 Expert (independent of Academic Level and Skill); the schema takes any registered set, registered under control through MaintainScale.

## F. Contract lifecycle (target) — DECIDED
```
draft → submitted → approved → active → superseded | expired
```
- `draft`: FM prepares version + rules; rules and identity mutable only in draft (append/replace draft rules).
- `submitted`: frozen for preparation; FM cannot edit (application + DB trigger).
- `approved`: GM approval event — atomic: validity, no other active chain conflict, evidence, digest; **immutable from now on** (application + DB trigger + no delete ever).
- `active`: automatically when `effective_from` is reached (derived; no separate mutable transition required — payroll/assignment checks evaluate the window) — active is a **derived state** from approved+window, recorded on the row for query efficiency but set only by the approval/activation evaluation under lock.
- `superseded`: a newer approved version for the same contract takes over at its effective_from; the old version keeps its window end = new start (enforced at new version approval).
- `expired`: window end passed.
- Cancellation before activation: a submitted (not approved) version may be **withdrawn by the FM** (terminal `withdrawn`); an approved-but-not-yet-effective version can only be superseded by a new approved version (auditable), never silently deleted.
- Contract **type**: enum on version: `full_time | part_time | fixed_term` (**NEEDS BUSINESS DECISION** on the production set; CHECK-constrained, extensible via governed migration).

## G. Contract Version model — DECIDED (separate entity)
- Table `contract_versions`: `id, contract_id FK, version_no (unique per contract), lifecycle_state CHECK, contract_type CHECK, effective_from, effective_to nullable (>from), scale_id nullable FK scales, terms_ref (document evidence), prepared_by, submitted_at, approved_by nullable, approved_at nullable, approval_digest nullable, created/updated`.
- DB invariants: approval-evidence identity CHECK (`(state IN approved..expired..superseded) = (approved_by/at/digest present)`); `approved_by <> prepared_by` CHECK; immutability trigger post-approval (identity+terms+rules frozen; only state advance `approved→active/superseded/expired` permitted); no delete; one non-superseded/expired **active-window** version per contract (partial unique on effective window overlap enforced at approval under lock + a helper exclusion constraint using daterange where feasible).
- It **replaces** (for new contracts) the flat `contracts.terms_summary` + `compensation_components` pair; both legacy tables remain as certified schema history and are retired from the write path (see T/V).

## H. Compensation Rule model — DECIDED (v1 scope)
Rules live on a contract version; per-unit rules resolve in one space; additive lines are separate.
- **Per-unit rules** (one resolution space): `method ∈ {session_rate, hourly_rate}`; columns: `skill_id nullable FK, scale_id nullable FK, rate decimal(14,2) > 0`.
- **Additive lines**: `method ∈ {fixed_monthly, allowance}`; `fixed_monthly`: at most one active per version; `allowance`: unique `label` per version, positive amount.
- v1 **supported**: Fixed (A), Skill-based per session (B), Scale-based per session (C via skill-null rules), Skill×Scale (D), Hourly (E, from delivered session duration), Per-session (F), Allowance (H), Hybrid (I = additive + per-unit mix).
- v1 **deferred**: Class-based (G) — "class unit" has no formal business definition (**NEEDS BUSINESS DECISION**; current `class_based` stays legacy-only). Volume-based beyond hours/sessions (student count, class count) — deferred.
- Table `compensation_rules`: `id, contract_version_id FK, method CHECK, skill_id nullable, scale_id nullable, label nullable (allowances), rate decimal CHECK > 0, effective via version window (no own dates — version is the unit of change)`; **overlap uniqueness within the resolution space**: at most one active rule per `(version, method-space, skill, scale)` where per-unit methods share one space (exclusion enforced under lock at approval; DB partial unique on `(version_id, space, COALESCE(skill,sentinel), COALESCE(scale,sentinel))`).
- Rules are **draft-visible only before approval**; at approval they are frozen (immutable trigger like the version) and hashed into `approval_digest`.

## I. Rate-resolution algorithm — DECIDED (deterministic, fail-closed)
For each payable delivered unit with skill S, under version V with scale K:
1. exact: `(skill=S, scale=K)`
2. `(skill=S, scale=∅)`
3. `(skill=∅, scale=K)`
4. `(skill=∅, scale=∅)` — generic per-unit rate
5. **no match → calculation HELD** (`payroll.rule_missing`), never a silent zero or fallback to another skill.
- Ambiguity is structurally impossible: the overlap uniqueness guarantees at most one rule per key; precedence ladder is total. Identical amounts never matter; the resolved rule id is snapshotted.
- Additive lines (fixed_monthly, allowance) are **DECIDED** prorated by calendar days: payable = contract amount × active days / period days, where active days is the inclusive calendar overlap of the version effective window and the payroll period; full-period coverage pays the full amount; partial coverage is computed in exact integer-cent arithmetic, round half up. Per-unit rates are not prorated.
- Conflict cases 22–24 (challenge): skill-only vs skill×scale → **exact wins**; scale-only vs skill×scale → **exact wins**; two overlapping rules of the same key → **cannot exist** (rejected at approval).

## J. Teaching Assignment model — DECIDED
- Keep `teacher_assignments` (class × teacher × effective window) as-is.
- Add `teacher_assignment_skills` (Academic-owned): `id, teacher_assignment_id FK, skill_id FK, unique(assignment_id, skill_id)`; the skill set a teacher delivers **in that class**; no own dates (inherits assignment window).
- Rationale vs skill-on-assignment: avoids duplicating assignments per skill (which would multiply the one-open-per-class-teacher index semantics), keeps "who teaches this class" singular and "which skills" plural — matches the domain sentence.
- A session's delivering teacher = the assignment covering (class, session date) whose skills contain the session's skill — validated at session scheduling and at delivery-fact creation; ambiguity (two teachers same skill same date) → **rejected** (`academic.skill_attribution_ambiguous`).

## K. Teaching Volume model — DECIDED (evidence-derived)
- **Payable unit = one delivered session of one skill by one attributed teacher**, defined as:
  - session exists with `skill_id` set (Academic adds the column; CHECK skill exists & active at schedule time — retired skills not schedulable);
  - session date within the teacher's assignment(+skill) window;
  - **at least one final attendance fact with status present or late** exists for the session (delivered evidence; **DECIDED** — final means the uncorrected tip of the authoritative corrects_id chain, so corrections, not timestamps, resolve qualification; absent and excused never qualify);
  - cancelled/never-held sessions simply carry **no attendance facts** → not payable (no session lifecycle needed in v1);
  - teacher absence = reassignment to another teacher's assignment before/at delivery — the facts follow attribution, not presence heuristics.
- Manual `work_bases` and the per-kind compensation-component architecture: **DECIDED — hard-retired in P16 finalization**. Tables, triggers, models, commands, and the legacy calculation fallback path are removed from the active system; the contract version with its compensation rules is the single compensation path and volume comes exclusively from academic delivery evidence.
- Hours (method `hourly_rate`) = Σ(session duration `ends_at−starts_at`) over qualifying sessions, computed from academic evidence, not manual entry.

## L. Multi-Skill class model — DECIDED
- One class, three skills: one `teacher_assignment` (same teacher) + three `teacher_assignment_skills` rows; sessions each carry exactly **one** `skill_id` (CHECK NOT NULL for new sessions; one session = one skill keeps attribution and payment unambiguous — mixing skills inside a session would split evidence irreproducibly).
- Attendance stays per (session, enrollment) — skill attribution comes from the session, so attendance evidence maps 1:1 to skill volume.
- Payroll breakdown: volume grouped by `(assignment_skill)` → each group resolves its own rule (precedence I) → per-skill rows in the snapshot. Three skills never collapse into one class count.

## M. Payroll calculation model — DECIDED (v2 of `CalculatePayroll`)
1. Resolve the **active contract version** covering the payroll period (approved, window-overlapping; at most one — enforced).
2. Claim delivery: for each qualifying session in the period attributed to this employment, insert `teaching_delivery_facts(id, payroll_calculation_id, session_id, skill_id, hours, evidence_digest)` — **unique(session_id)** (DB) makes double counting impossible across periods, calcs, and reruns.
3. Group facts by skill → resolve rule (ladder I) → `Σ rate × sessions` (session_rate) or `rate × Σ hours` (hourly_rate).
4. Add `fixed_monthly` + `allowance` lines.
5. Unresolved skill / no in-force version / unattributed delivered session → **HELD** with reason (existing held pattern reused); no legacy fallback exists.
6. Supersede prior prepared/held calculations (existing semantics), store snapshot (N).
Adjustments/reversals/approval: unchanged (P09 certified).

## N. Historical snapshot model — DECIDED
`payroll_calculations.snapshot` (existing jsonb, immutable trigger already certified) extended with:
`contract_id, contract_version_id, version_no, scale_id, rules: [{id, method, skill_id, scale_id, label, rate}], delivery: [{session_id, skill_id, scheduled_on, hours, fact_id}] (fact_id = the qualifying attendance fact evidence), per_skill: [{skill_id, sessions, hours, rule_id, method, rate, amount}], additive: [{rule_id, method, label, contract_amount, active_days, period_days, amount}], proration: {period_from, period_to, period_days, version_effective_from, version_effective_to, active_days}, formula: 'skill-scale-v1'`.
Immutable results + append-only adjustments + frozen versions ⇒ future Skill/Scale/rate/contract changes can never alter approved payroll; reproducibility = snapshot alone.

## O. FM → GM approval model — DECIDED
- Capabilities: `hr.contract.prepare` (Finance Manager), `hr.contract.approve` (General Manager) — separate; legacy `hr.contract` not valid for the new path.
- `submit(FM)`: draft→submitted (`submitted_at`, frozen). `approve(GM)`: atomic — GM capability; state submitted; **GM ≠ preparer** (command + DB CHECK); **approver ≠ beneficiary** (employment person ≠ approver; command + CHECK at result level where expressible); version+rules valid; no competing active window; digest over version+rules; freeze; audit `hr.contract.approve`.
- Post-approval: FM/GM/teacher paths all fail closed (draft rule edits reject: version not draft; submit rejects; approve again rejects); SQL-level: immutability trigger + no-delete trigger on versions and rules; approval-evidence CHECK.
- Denied attempts audited (`hr.contract.*.denied`) per the certified pattern (authorization **before** validation).

## P. Authorization / audit / idempotency model — DECIDED
All new commands (`RegisterSkill`, `RegisterScale`, `PrepareContractVersion`, `SubmitContractVersion`, `ApproveContractVersion`, `WithdrawContractVersion`, plus Academic changes to assignments/sessions) follow: capability check → denial audit → validation → transaction with locks → idempotency envelope (payload-hash) → success audit. `CalculatePayroll` v2 keeps `payroll.calculate`. Delivery facts are created inside the calculation transaction (no separate capability). Replay of the calculation command with the same idempotency key returns the original outcome; a **new** key supersedes (existing semantics) and delivery facts remain claimed — rerun cannot double bill (unique session).

## Q. Finance integration — DECIDED (reuse, no P10 change)
- Payroll becomes financially authoritative at **result approval** (unchanged). Journal: manual `PostJournal(source_type='payroll_result')` stays the certified posting input; a future auto-post is out of scope. Corrections = adjustments/reversal (existing, immutable); opening payables (P15) are untouched — no fake payroll results, no reinterpretation; their settlement remains journal-based (`source_type='other'`).

## R. Reporting impact — DEFERRED as governed change
- `payroll_total` (P13) reads approved results + adjustments — **unchanged** by this design.
- Skill-level / scale-level / contract-version payroll metrics and dashboard slices would be **new catalog entries** → separate governed change (P13 catalog is code-owned; adding metrics = new package decision), explicitly out of P16 scope.

## S. Database entities and invariants (design only)
| Table | Owner | Why / invariant | Replaces/extends | Solves |
|---|---|---|---|---|
| `skills` | Academic | closed catalog; unique key; active/retired; retired immutable, no delete | — (new concept) | Skill as first-class id, never free text |
| `scales` | HR | closed catalog; unique key + rank_order; retired immutable, no delete | — (new concept) | compensation rank independent of Skill/Level |
| `contract_versions` | HR | lifecycle CHECK; approval-evidence CHECK; approver≠preparer CHECK; post-approval immutability trigger; no delete; one active window per contract | extends `contracts` (header stays) | immutable approved terms; FM→GM evidence |
| `compensation_rules` | HR | method CHECK; positive rate; overlap-free resolution space per version (partial unique with sentinels); frozen with version | **replaces write-path of `compensation_components`** | per-skill/scale rate space (fixes the proven conflict) |
| `teacher_assignment_skills` | Academic | unique(assignment, skill); FK active skill | extends `teacher_assignments` | multi-skill classes/teachers without duplicated assignments |
| `class_sessions.skill_id` (+FK) | Academic | NOT NULL for new sessions; skill active at scheduling | extends `class_sessions` | unambiguous skill attribution of delivery |
| `teaching_delivery_facts` | Payroll | **unique(session_id)**; FK calc+session+skill; append-only (no update/delete trigger) | supersedes per-unit use of `work_bases` | double-count defense; evidence-linked volume |
| `payroll_calculations.snapshot` (content) | Payroll | richer immutable snapshot (schema unchanged) | extends snapshot | historical reproducibility incl. skill/scale |

## T. Migration strategy — DECIDED (technical, not business-data)
- **No historical business data migration** (none exists). New schema lands as **normal new migrations** (append-only schema history, ~7–8 migrations).
- Legacy tables (`compensation_components`, `work_bases`): **DECIDED — hard-retired in P16 finalization**: migrations 000096/000097 drop the tables with their triggers and functions (with full down-migrations for reversibility), the legacy models and commands are deleted, and the legacy tests are removed; no historical business data exists (P02–P15 certified baseline, no production data), so no data migration is required and no fallback path remains.
- Squash/dump strategy: **deferred** — revisit after architecture stabilizes; it is a deployment-baseline decision, not required for P16.

## U. Adversarial challenge results (27 cases)
| # | Case | Expected | Invariant / fail-closed | Audit | Historical impact |
|---|---|---|---|---|---|
| 1 | 1 teacher/1 skill/1 scale | pays skill×scale rate | resolution ladder | success | snapshot |
| 2 | 3 skills same scale | 3 per-skill rows | group-by skill | success | snapshot |
| 3 | 3 skills different rates | exact rules each | overlap-free keys | success | snapshot |
| 4 | 2 teachers same skill diff scales | each their version rule | versions independent | success | none |
| 5 | scale change mid-year | new version; old payroll untouched | version immutability | amendment | **preserved** |
| 6 | skill rate change mid-month | new version effective from date; old periods keep old rate | window split at approval | amendment | preserved |
| 7 | contract amendment | old version superseded, window closed at new start | supersede lock | approval | preserved |
| 8 | cancel before activation | submitted→withdrawn (FM); approved-not-effective → only supersede | no delete | withdrawal | none |
| 9 | FM self-approval | denied | GM capability + ≠preparer (CHECK) | denied audit | none |
| 10 | GM edits approved | rejected | post-approval trigger | denied/rejected | preserved |
| 11 | teacher edits compensation | denied | capability | denied audit | preserved |
| 12 | duplicate teaching evidence | second claim rejected | **unique(session_id)** | rejected | none |
| 13 | session on two skills | impossible | single skill_id per session + attribution check | schedule-time rejection | none |
| 14 | cancelled session | not payable | no attendance facts → no qualifying unit | none | none |
| 15 | teacher absent | not payable to them; only via reassignment | attribution by assignment | reassignment audit | none |
| 16 | partial delivery | threshold rule (business decision) | ≥N facts configurable | calculation meta | snapshot records rule |
| 17 | manual work_basis + academic volume | **held** `payroll.volume_conflict` | both-present check | held reason | none |
| 18 | payroll rerun | supersede + facts stay claimed | unique(session) + state machine | recalculation | preserved |
| 19 | retry/replay | idempotent original outcome | idempotency envelope | original correlation | preserved |
| 20 | payroll after amendment | old periods resolve old version | window resolution + snapshot | — | **preserved** |
| 21 | opening payable under new system | independent; journal settlement only | P15 untouched | P15 audit | preserved |
| 22 | skill-only vs skill×scale | exact (skill×scale) wins | ladder + no overlap | resolved rule snapshotted | deterministic |
| 23 | scale-only vs skill×scale | exact wins | ladder | snapshot | deterministic |
| 24 | overlapping rules same key | impossible | approval-time overlap rejection + DB unique | rejection | none |
| 25 | no matching rule | HELD | fail-closed ladder end | held reason | none |
| 26 | skill retired with history | old payroll fine; not schedulable | retired immutable + snapshot | retirement audit | preserved |
| 27 | scale retired with history | same | same | same | preserved |

## V. Rejected alternatives
1. **Skill-on-teacher (HR)** — Skill describes delivered teaching (Academic fact, contract 43); HR would own a teaching classification = boundary violation. REJECTED.
2. **Shared "catalog" module** — creates parallel infrastructure; the boundary map has no such owner. REJECTED.
3. **Employment-level effective-dated scale history** — second source of compensation truth vs contract versions; retroactivity risk. REJECTED (scale pinned on version).
4. **Skill column on `compensation_components` (extend legacy)** — keeps per-kind resolution & terms-as-text; deeper conflict; legacy path lacks approval/versioning. REJECTED in favor of clean version+rule model; legacy retired.
5. **Multiple skills per session** — ambiguous evidence split. REJECTED (one session = one skill).
6. **Session lifecycle/cancelled state in v1** — unnecessary: evidence-based qualification covers it. DEFERRED.
7. **Session-payable to multiple teachers** — unique(session_id) forbids; co-teaching modeled by reassignment or session split. REJECTED for v1.

## W. Exact implementation sequence (for the next phase)
1. Migrations + models + commands: `skills` (Academic, `academic.skill` capability) with catalog tests.
2. `scales` (HR, `hr.scale`) + tests.
3. `contract_versions` + `compensation_rules` + FM/GM lifecycle commands (prepare/submit/approve/withdraw) + DB invariants + SoD/adversarial tests.
4. Academic: `teacher_assignment_skills`, `class_sessions.skill_id`, scheduling validation + tests.
5. Payroll: `teaching_delivery_facts` + `CalculatePayroll` v2 (resolution ladder, volume conflict, snapshot) + tests (cases 1–27 subset).
6. Legacy retirement guards + `SchemaInvariantFeatureTest` extension + full regression.
7. Gates: phpunit / phpstan L6 / pint / fresh-DB migrations / P02 `--verify`; checkpoint; certification. (Reporting metrics change = separate governed change.)

## X. Risks and unresolved decisions
- **RESOLVED by user directive in P16 finalization (2026-08-26)**: final Scale set (S1 Junior, S2 Standard, S3 Senior, S4 Expert); attendance qualification (≥1 final present/late fact via the corrects_id chain); fixed-salary proration (calendar days, exact cent arithmetic, round half up); legacy compensation path (hard-retired — single contract version + compensation rule path); manual hourly entry (retired with work_bases).
- **Still open (out of P16 finalization scope)**: contract-type set (enum on versions); class-unit definition (Model G) if ever needed.
- **NEEDS TECHNICAL DECISION**: snapshot `formula_version` governance; schema squash timing (deferred).
- **Risk (HIGH)**: P16 touches two certified modules (Academic sessions/assignments, HR/Payroll) — must follow "extend, don't rewrite" with full cumulative regression; the proven per-kind conflict justifies the retirement.
- **Risk (MEDIUM)**: unique(session_id) makes accidental co-teaching unpayable — operational reassignment discipline required.

## Y. Acceptance criteria (for the implementation phase)
1. All 27 challenge cases pass as specified (feature/adversarial tests). 2. Approved contract versions/rules immutable at SQL level. 3. FM→GM SoD enforced (command + DB), denial audits present. 4. Rate resolution deterministic; no-match → HELD. 5. unique(session_id) double-count defense proven. 6. Historical reproducibility: amend scale/skill rate/contract after approval → approved payroll byte-identical snapshot. 7. P15 opening payables untouched. 8. `payroll_total` metric unchanged. 9. Full cumulative suite + phpstan L6 + pint + fresh migrations + schema invariants green. 10. Checkpoint + certification per protocol.

---

## Decision classification
| Decision | Class |
|---|---|
| Skill catalog owned by Academic; closed, retire-only | **DECIDED** (boundary contract 43) |
| Scale catalog owned by HR; rank_order; retire-only | **DECIDED** |
| Scale pinned on contract version (not employment history) | **DECIDED** |
| Contract version entity; lifecycle draft→submitted→approved→active→superseded/expired; immutability + no-delete triggers | **DECIDED** |
| FM prepares/submits (`hr.contract.prepare`), GM approves (`hr.contract.approve`), ≠preparer, ≠beneficiary (command+DB) | **DECIDED** |
| Compensation rules keyed (method, skill?, scale?); per-unit single resolution space; overlap-free per version | **DECIDED** (fixes proven conflict) |
| Precedence ladder exact > skill-only > scale-only > generic; no-match → HELD | **DECIDED** |
| Fixed/allowance calendar-day proration (amount × active days / period days, exact cents, round half up) | **DECIDED** |
| `teacher_assignment_skills` separate entity; one session = one skill; attribution validated | **DECIDED** |
| Payable unit = delivered session (skill-attributed, ≥1 final present/late attendance fact via the corrects_id chain); hours from session duration | **DECIDED** |
| `teaching_delivery_facts` with unique(session_id); delivery claims carry the qualifying attendance fact as evidence; double payment impossible | **DECIDED** |
| Snapshot extension (version/rules/scale/skill breakdown/evidence) | **DECIDED** |
| Finance unchanged (manual journal posting, adjustments/reversals); P15 untouched | **DECIDED** |
| v1 method set (fixed_monthly, allowance, session_rate, hourly_rate); class_based/volume-based deferred | **DECIDED** (implemented) |
| Legacy compensation_components/work-basis path hard-retired (tables, commands, fallback, tests removed) | **DECIDED** (executed in P16 finalization) |
| Reporting metrics for skill/scale payroll | **NEEDS BUSINESS DECISION** (separate governed change) |
| Final scale set S1–S4 (Junior/Standard/Senior/Expert); calendar-day proration; final present/late attendance qualification; manual hourly entry retired | **DECIDED** (user directive, P16 finalization) |
| Contract types set (enum on versions) | **NEEDS BUSINESS DECISION** (out of P16 finalization scope) |
| Schema squash/dump baseline | **NEEDS TECHNICAL DECISION** (deferred) |

**END OF DESIGN.** P16 v1 was implemented on 2026-08-26 (commit `1c233df`), and the remaining decisions above were resolved by user directive in the P16 finalization, implemented and certified in `docs/implementation/39-package-16-skill-scale-contract-payroll-checkpoint.md` (branch `arena/01a03d22-toefl-house`). This design record is historical; the authoritative description of the final system is `docs/architecture/11-hr-payroll-architecture.md` and `docs/implementation/09-hr-payroll-implementation-contract.md`.
