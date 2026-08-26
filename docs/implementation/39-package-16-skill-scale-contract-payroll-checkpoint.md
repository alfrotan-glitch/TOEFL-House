# Package 16 Checkpoint — Skill, Scale, Contract & Payroll Finalization

**Package:** 16 — Finalize Skill, Scale, Contract & Payroll (user directive 2026-08-26; finalize the teacher compensation architecture on the verified P16 v1 base — no redesign, work inside the existing authoritative modules)
**Status:** CERTIFIED — PASS
**Date:** 2026-08-26
**Branch:** `arena/01a03d22-toefl-house`
**Quality standard:** `21-implementation-quality-directive.md` (D-F-101), ADR-013 stack
**Baseline:** verified P16 v1 state at commit `1c233dfe` (branch `arena/01a0381a-toefl-house`)

## Discover

- P16 v1 already present and verified at the baseline: migrations `000090–000095` (skills/scales catalogs with guard triggers, contract versions with lifecycle guard, compensation rules with dimension/overlap uniqueness, session skill attribution, teacher assignment skills, teaching delivery facts with the per-session claim trigger), models, `MaintainScale`, `MaintainContractVersion` (draft/submit/approve/withdraw/amend-supersede with FM→GM separation of duties and digest evidence), `RecordAttendance` (facts + append-only `corrects_id` corrections), `CalculatePayroll` (skill-scale-v1 ladder with fail-closed HELD policy), and the Skill/Scale/Contract/Payroll feature suites plus the P16 design record.
- The gap to the final directive: (A) fixed/allowance lines were not prorated; (B) session payability required any attendance fact regardless of final status and ignored the correction chain; (C) the approved initial scale catalog S1–S4 was not registered; (D) the competing legacy compensation-component architecture (models, commands, capability constants, tests, and the `computeLegacy` fallback) still lived inside the active system with a `volume_conflict` branch; (E) the delivery snapshot lacked attendance evidence references and proration windows.
- Confirmed by code inspection before any edit: `ContractVersionLifecycle` states and `IN_FORCE_STATES` (approved/active); approval supersedes the prior in-force version by closing its window the day before the new effective start; rule freeze once a version leaves draft; scale-keyed rules must match the version pin; `teaching_delivery_facts` unique per session with a claim trigger migrating only from same-period/employment superseded calculations; payroll lifecycle (prepared/held → resulted/superseded; periods open → calculating → closed); snapshot immutability for resulted/superseded calculations.

## Decide (final business rules, per directive)

1. **Calendar-day proration (fixed_monthly + allowance only):** payable = contract amount × active days / period days, where the active window is the inclusive overlap of the version effective window and the period; full-period coverage pays in full; partial coverage computed in exact integer-cent arithmetic (¢ numerator ÷ period days, round half up), never floats. Per-unit rates are not prorated.
2. **Attendance qualification:** a session is payable iff it has at least one attendance fact whose status is `present` or `late` **and** which is the uncorrected tip of its authoritative `corrects_id` chain (no other fact corrects it). Corrections — not timestamps — resolve qualification; `absent`/`excused` never qualify; cancelled or never-held sessions carry no qualifying attendance and are not payable. The earliest qualifying tip is carried as the delivery evidence reference (`fact_id`) in the claims and snapshot, with no schema change to `teaching_delivery_facts`.
3. **Approved initial scale catalog:** S1 Junior, S2 Standard, S3 Senior, S4 Expert — registered under control through `MaintainScale`, independent of Academic Level and Skill; test fixtures aligned to the approved names.
4. **Single compensation path:** Contract Version + Compensation Rule only. The competing per-kind compensation-component architecture and the manual/academic work-basis evidence path are **hard-retired**: models/commands deleted, `MaintainContract` reduced to the contract chain (draft/sign/close), capability constants removed, `computeLegacy` and the `volume_conflict`/`volume_unaddressed` branches deleted from `CalculatePayroll`, migrations `000096`/`000097` drop `compensation_components` and `work_bases` (triggers and functions included, with full down-migrations), legacy tests removed, and a period with no in-force version is HELD `contract-silent` — never a fallback.
5. **Snapshot completeness:** additive rows gain `contract_amount`/`active_days`/`period_days`; top-level `proration` block (period window, version window, active days); delivery rows gain the qualifying `fact_id`; `formula: 'skill-scale-v1'` retained. Previously approved payroll reproduces exactly after later contract, scale, skill, attendance-correction, or rate changes.

## Map (implemented scope)

- **`CalculatePayroll` (rewritten to the final rules):** single in-force version resolution (multiple → `payroll.version_overlap` HELD; none → `contract-silent` HELD); per-unit ladder unchanged (exact skill×scale > skill-only > scale-only > generic, no-match → `payroll.rule_missing` HELD); additive lines prorated per decision 1; attendance qualification per decision 2 applied to both attributed and unattributed sessions (unattributed with qualifying attendance → `payroll.skill_attribution_missing` HELD); delivery claims now carry the qualifying `fact_id`; snapshot per decision 5. No legacy imports, no fallback path.
- **Legacy retirement:** deleted `Hr/Models/CompensationComponent.php`, `Hr/Models/WorkBasis.php`, `Hr/Commands/RecordWorkBasis.php`; `MaintainContract` stripped of `proposeCompensation`/`activateCompensation`/`overlaps` and the `hr.compensation`/`hr.compensation_approve` capability constants (docblock re-anchored to the versioned model).
- **Migrations:** `2026_08_26_000096_drop_compensation_components_table` (drops the append-only trigger + function + table; `down()` recreates the full legacy definition), `2026_08_26_000097_drop_work_bases_table` (same pattern, including the CHECK set and both recorded partial unique indexes). DB at **97 migrations**.
- **Tests:** `SkillScalePayrollFeatureTest` — proration overlap test (3100.00 + 310.00 at 16/31 + 100.00 → 1860.00), exact-cent rounding tests (516.13 non-tie up, 966.67 non-tie up, 500.01 exact-tie half-up), final-status qualification test (absent/excused unpaid; late/present paid), correction-chain test (present→absent retires; absent→present pays; present→absent→late pays on the late tip; append-only history asserted; 7 facts); obsolete manual-volume-conflict test removed; S3/S4 fixtures on approved names; snapshot proration/evidence asserts added. `ScaleContractVersionFeatureTest` — approved catalog S1–S4 registered and asserted in the catalog test; S4 fixture renamed to the approved name. `HrFeatureTest` — legacy compensation and work-basis tests removed; `hr.compensation` grants removed. `PayrollFeatureTest` — rewritten on the versioned fixture (fixed 40000 + allowance 2000, window 2026-09): full-period 42000.00 with snapshot asserts, contract-silent October HELD (blocks period closure and approval), recalculation supersession with history, plus the retained approval-SoD / immutable-result / closed-period / settlement / denial tests. `SchemaInvariantFeatureTest` — new absence gate: `compensation_components` and `work_bases` are not in `pg_tables`.
- **Documentation:** `architecture/11-hr-payroll-architecture.md` and `implementation/09-hr-payroll-implementation-contract.md` rewritten to describe the final system as the current architecture (not a temporary change); `design/P16-…DESIGN.md` decision lines closed to DECIDED (scale set, proration, attendance threshold, legacy disposition); this checkpoint created; `00-implementation-state.md` advanced.

## Verification baseline (gate matrix)

| Gate | Result | Evidence (2026-08-26) |
|---|---|---|
| typecheck / static analysis | PASS | phpstan level 6 `[OK] No errors` |
| lint | PASS | pint `PASS` |
| unit/integration tests | PASS | phpunit **OK (330 tests, 1472 assertions)** cumulative |
| proration tests | PASS | full period 31/31 pays in full; 16/31 partial; 29/30; exact tie 1000.01 × 15/30 → 500.01 (half-up proven) |
| attendance tests | PASS | absent-only and excused-only sessions unpaid; late and present paid; corrections resolved through the `corrects_id` chain (flips retire the prior fact; two-step chain pays on the final tip); append-only fact history asserted |
| resolution tests | PASS | skill×scale > skill-only > scale-only > generic ladder (retained t2); no-match HELD `payroll.rule_missing` (retained t3); unattributed delivery HELD (retained t5) |
| scale catalog tests | PASS | S1 Junior / S2 Standard / S3 Senior / S4 Expert registered, name+rank asserted, key/rank uniqueness and retirement retained |
| SoD tests | PASS | FM prepares/submits, GM approves; preparer-approval and beneficiary-approval rejected (command + schema CHECKs, retained suite); payroll approver ≠ preparer ≠ beneficiary (retained) |
| immutability tests | PASS | approved versions/rules immutable (trigger-rejected rewrites, retained); snapshot immutable for resulted/superseded calculations; results/adjustments immutable |
| historical reproduction | PASS | August calculation retained as `superseded` with identical snapshot after a September recalculation under a new version (retained t8) |
| double-payment tests | PASS | unique per-session claim trigger; claim migration only from same-period superseded calculation; replay-safe idempotent recalculation (retained t7) |
| legacy-attack paths | PASS | raw SQL insert into `compensation_components`/`work_bases` impossible — tables absent (`pg_tables` gate); no code path references the retired models (grep-verified); `hr.compensation*` capability grants no longer exist |
| held-case tests | PASS | contract-silent HELD blocks period closure (`payroll.period_close_held`) and approval; rule-missing HELD; skill-attribution HELD |
| fresh DB rebuild | PASS | `migrate:fresh` green from 97 migrations (DatabaseMigrations per test + explicit rebuild) |
| concurrency/idempotency | PASS | idempotent replay of the same key returns the original; recalculation supersedes rather than duplicates (retained) |

## Attack (adversarial verification)

- Direct SQL: rewrite/delete of approved contract versions and rules rejected by triggers (retained suite); `UPDATE`/`DELETE` on `compensation_components`/`work_bases` impossible (tables dropped); `INSERT` of duplicate per-unit rule keys rejected by the partial unique index (retained); forged approver identity rejected by schema CHECKs (retained); snapshot/result mutation rejected by immutability triggers (retained).
- Branching correction history: a fact is final iff no fact corrects it — exists-semantics tolerates correction branches without timestamp races, so two parallel corrections of the same fact both retire it.
- No second implementation path: the legacy compute branch, its models, its commands, its capabilities, and its tests are all removed in the same change; a grep for `hr.compensation`/`hr.workbasis` across `app/`, `tests/`, and `docs/implementation` confirms only historical checkpoint text remains (P07/P08 records, intentionally retained as certified history).
- Precision: proration is integer-cent arithmetic — no float multiplication anywhere in the payable path; the exact-tie test (500.005 → 500.01) locks the rounding policy.
- Double payment across reruns: the per-session claim trigger is the enforcement point; the application path additionally locks and re-checks, and claim migration is trigger-restricted to same-period/employment superseded calculations.

## Repair log

1. `ScaleContractVersionFeatureTest` fixture name drift ('Senior instructor'/'Lead instructor') — aligned to the approved catalog names (S3 Senior, S4 Expert) in both the version suite and the payroll suite.
2. `PayrollFeatureTest` legacy fixture (flat `MaintainContract` + `RecordWorkBasis` + manual work-basis volume) — rebuilt on the versioned fixture so the suite exercises the single authoritative path end to end; the October window proves the contract-silent HELD end to end (closure blocked, approval blocked).
3. `SkillScalePayrollFeatureTest` t6 (manual volume conflict) — obsolete with the work-basis retirement; replaced by the proration and attendance final-status tests that encode the final directive.
4. Delivery evidence gap — the snapshot carried no attendance evidence; the qualifying `fact_id` is now part of the claims and snapshot (additive, no `teaching_delivery_facts` schema change).
5. `HrFeatureTest` legacy coverage — removed with the legacy commands; the remaining suite (person rule, contract immutability, leave SoD, termination, denial audit) is unchanged and green.

## Certify

P16 finalization is **CERTIFIED — PASS** on the ADR-013 stack: the final business rules (calendar-day proration with exact monetary precision, final-status attendance qualification through correction chains, the approved S1–S4 scale catalog, single contract-version + compensation-rule resolution with fail-closed HELD, immutable snapshots, per-session claim defense) are implemented inside the existing authoritative modules, the competing compensation-component architecture is completely removed from code, schema, tests, and documentation, and the cumulative suite plus phpstan level 6, pint, fresh 97-migration rebuild, and schema-invariant gates are green. The complete diff against baseline `1c233dfe` contains only the intended P16 finalization changes.
