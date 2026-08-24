# Placement V1 — Reference Configuration (Saved & Verified)

Date: 2026-08-24
Branch: `arena/01a03298-toefl-house`
Scope: One complete, usable Placement Test V1 configuration created and saved in
the live system through the canonical Admin/Owner surfaces, then exercised
end-to-end in both delivery modes.

## Where the configuration lives

Everything below is **stored in the running ERP database** through the
canonical Placement V1 architecture (no hard-coded test-specific assumptions;
all values are configuration data):

| Object | Stored id | Surface used |
|---|---|---|
| Program | `prog_8bc6c970-890b-47e2-a9cf-86583f4eb6ac` (General English, GENENG) | Academic Control Center → Programs & Levels |
| Levels A1–C1 | `lvl_8869b78d…` (A1 Foundation) → `lvl_90e1d3ba…` (C1 Advanced) | Academic Control Center → Programs & Levels |
| Program version | `pv_9ae65bf4-b0c9-4700-bef1-b45178723b81` (V1 2026, published) | Academic Control Center → Program Versions |
| Placement profile (blueprint + CEFR ladder + fees/retake policy) | `placement_assessment_profiles` row for (version, branch 1), policy **version 2** | Academic Control Center → Program Versions → Placement Test V1 panel |
| Writing rubric | `prub_ca478d96-5680-4394-b536-b6bf355ebcfb` | Test Bank → Rubrics |
| Speaking rubric | `prub_58449f97-3908-4dad-bf32-40499ce017b6` | Test Bank → Rubrics |
| Grammar bank (40 items, active) | `ptst_b9ed3edd-f516-4db8-92f0-d6e6eb2858b6` | Test Bank |
| Reading bank (5 passages, 25 items, active) | `ptst_39e84f44-95ff-4bd7-9053-f0f7650afb9e` | Test Bank |
| Listening bank (5 audio tracks, 25 items, active) | `ptst_51ee305d-2343-467b-846b-b8c613ce9eeb` | Test Bank |
| Writing bank (essay prompt + rubric, word target 250) | `ptst_ac0a4c7a-ce3f-4993-a6ea-cf6d3d553153` | Test Bank |
| Speaking bank (interview Part 1 + long turn + rubric) | `ptst_5fe3d0e7-afd3-4e0e-9d42-e823095d82c9` | Test Bank |
| Listening audio media | `pmd_c765b03c-e37e-437a-a3db-fc2034087387` | Test Bank → Audio upload |
| Placement fee 300 AFN (branch) | `fee_740d7301…` + registration 500 / card 100 / diploma 200 | Academic Control Center → Fee Policies |
| Employee account (receptionist) | `usr_1d71260a-0375-49b1-b691-8a60e27b1e95` (Zahra Rahimi) | System Administration → Users |

## Policy values (profile version 2)

- requirementMode: `required`; firstLevelExempt: no; attempt expiry: 240 min
- passScore: 60 / 120; scoringModel: `canonical`; delivery modes: `DIGITAL` + `PHYSICAL`
- Retakes: allowed, max 3 attempts; first attempt billable; retakes billable at 300 AFN
  (branch placement fee applies when no retake override is set)

### Canonical components and blueprint (fixed maxima/weights from V1)

| Component | maxScore | weight | Timer | Blueprint buckets (count × CEFR/difficulty/qtypes) |
|---|---|---|---|---|
| grammar | 30 | 25% | 30 min | 6×A1/easy, 6×A2/easy, 6×B1/medium, 6×B2/hard, 6×C1/hard (mcq, fill_blank, sentence_completion, error_identification, short_answer) |
| reading | 20 | 16.67% | 25 min | 4×A1/easy, 4×A2/easy, 4×B1/medium, 4×B2/hard, 4×C1/hard (mcq, short_answer) |
| listening | 20 | 16.67% | 25 min | 4×A1/easy, 4×A2/easy, 4×B1/medium, 4×B2/hard, 4×C1/hard (mcq, short_answer) |
| writing | 25 | 20.83% | 30 min | 1×ANY/ANY essay, human-scored via 4-criterion analytic rubric (Task Achievement 30, Coherence & Cohesion 25, Lexical Range 20, Grammatical Range 25; 0–5 each) |
| speaking | 25 | 20.83% | 15 min | 1×ANY/ANY speaking, human-scored via 4-criterion analytic rubric (Fluency & Coherence 30, Interactive Communication 20, Pronunciation 20, Grammatical & Lexical Range 30; 0–5 each) |

Every bank question carries CEFR (A1–C1) and difficulty (easy/medium/hard)
metadata plus topic/subskill tags; objective items are 1 point each (enforced
by the blueprint engine); all bank questions used by the blueprint are
lifecycle `active`.

### CEFR decision ladder (placement recommendation rules)

| CEFR | Recommended level | Grammar | Reading | Listening | Writing | Speaking |
|---|---|---|---|---|---|---|
| A1 | A1 Foundation | 6 | 4 | 4 | 9 | 9 |
| A2 | A2 Elementary | 13 | 8 | 8 | 12 | 12 |
| B1 | B1 Intermediate | 19 | 12 | 12 | 15 | 15 |
| B2 | B2 Upper-Intermediate | 24 | 16 | 16 | 19 | 19 |
| C1 | C1 Advanced | 28 | 18 | 18 | 22 | 22 |

Overall placement = highest CEFR rule whose five-component thresholds are all
met; component CEFR evidence uses the same ladder. Outcome is `passed` only
when all five required components are complete and a CEFR rule matched.

## Verified end-to-end runs (2026-08-24)

### DIGITAL — Ahmad Sadiq Formuli (visitor `v_5cf0d32c…`, student TH-001001)
- Attempt `pat_68b01cfc…` #1, delivery DIGITAL, policy v1 snapshot
- Snapshot assembled from the blueprint: 30/20/20/1/1 items; answer keys not
  exposed to the candidate; rubrics embedded for writing and speaking
- Objective sections answered in-UI and auto-scored: Grammar 20/30, Reading
  12/20, Listening 12/20
- Writing essay (236 words) captured through DIGITAL response capture, then
  human-scored by the Owner/examiner against the rubric: 3/5×4 → 15/25
  (immutable after save; correction workflow required to change)
- Speaking: structured interview, examiner rubric 3/4/3/3 → 16/25
  (timing engine required the component timer before submission)
- Complete & decide: **PASSED, 75/120 = 62.5%, CEFR B1 → B1 Intermediate**,
  every component's CEFR evidence = B1
- Billing: placement fee invoice INV-2026-00003 (300 AFN) issued at attempt
  start to the student financial identity, issued-by the operating employee
- Enrollment: blocked from B2 class ("up to B1 Intermediate"), enrolled
  successfully into GE B1 Morning — Reference after settling invoices

### PHYSICAL — Mariam Qaderi (visitor `v_e4f0d433…`, student TH-001002)
- Attempt `pat_6cc9d5c0…` #1, delivery PHYSICAL, same canonical profile/banks
- Employee (receptionist) started timers and entered paper-booklet scores for
  all five components: Grammar 26/30, Reading 17/20, Listening 17/20;
  Writing rubric 4/5×4 → 20/25; Speaking rubric 4/5×4 → 20/25
- Complete & decide: **PASSED, 100/120 = 83.33%, CEFR B2 → B2 Upper-Intermediate**
- Billing: placement fee invoice INV-2026-00004 (300 AFN)
- Enrollment: enrolled into GE B2 Evening — Reference after settling
  registration + placement invoices

### Governance verified
- Employee (receptionist) receives 403 on placement-profile and test-bank
  writes; runs attempts, timers, responses, PHYSICAL score entry, completion,
  and enrollment — all audited
- Owner edits the saved policy through the same UI save path (v1 → v2) and is
  refused on stale-version writes (409 optimistic concurrency)
- Duplicate open attempts blocked by the database uniqueness constraint
- Enrollment gate closed for a manual student with no placement record
  ("must be registered through the visitor placement workflow")
- Full placement audit trail present (config saves, fee rules, attempt start,
  timers, responses, component scoring, completion)
- `GET /api/placement/report?from=…&to=…`: 2 attempts, 2 completed, 2 passed,
  average 72.91%

## Reproducibility

The configuration itself is live policy data in the operational database
(`server/data/erp.sqlite`, gitignored by design). It is **fully reproducible
from Git** through tracked, machine-readable fixtures and a canonical importer
— no database files are ever committed:

- Fixtures: `server/fixtures/placement-v1/` (manifest, academic tree, fee
  rules, rubrics, 5 banks / 94 questions, placement profile, listening audio
  asset). References are fixture keys (bank keys, rubric keys, level codes,
  audio keys), remapped to real database ids at import time. The fixtures
  contain configuration and assessment content only — no candidates,
  attempts, payments, audit history, credentials, or PII.
- Import: `npm --prefix server run import:placement-reference` with
  `PLACEMENT_IMPORT_USERNAME` / `PLACEMENT_IMPORT_PASSWORD` set to the owner
  account's **current** credentials (PowerShell:
  `$env:PLACEMENT_IMPORT_USERNAME='owner'; $env:PLACEMENT_IMPORT_PASSWORD='<current owner password>'`).
  When unset, the importer falls back to `SEED_OWNER_*` — but that value in
  `server/.env` is the **one-time bootstrap credential**: it is API-quarantined
  until the mandatory first-login password change and permanently rejected
  (HTTP 401) afterwards, so after first login the explicit variables are
  required. The importer mounts the real routers in-process,
  performs a real owner login, and writes every object through the canonical
  Placement V1 HTTP surfaces — the same validators, RBAC permissions
  (`Curriculum.PlacementPolicy`, `Curriculum.TestBank`, `FeeStructure.Edit`),
  persistence, versioning and audit trail the Admin/Owner UI uses. It is
  idempotent and non-destructive: existing objects are matched by natural key
  and reused, and an Owner-edited placement profile is never overwritten.
- Automated proof: `npm --prefix server run verify:placement-reference`
  creates an empty throwaway database, runs the canonical bootstrap, imports
  the fixtures, and asserts the complete configuration (academic tree, fees,
  rubrics, media, 94 questions, blueprint — including bucket-satisfiability
  replay — and the CEFR ladder). It then deletes the placement profile and one
  bank, re-imports, and asserts exact self-repair without duplication, and
  finishes with a functional DIGITAL smoke (candidate → admission → attempt
  snapshot 30/20/20/1/1 with rubrics, no answer-key leakage → cancel).
  86/86 checks pass.

Fresh-install sequence: clone → `bootstrap.bat` (or `npm --prefix server run
bootstrap`) → first owner login (clears credential quarantine) →
`import:placement-reference`. The imported configuration is ordinary policy
data and remains editable through the Academic Control Center and Test Bank
admin UI. All behavior is governed by the canonical Placement V1 engines
(blueprint, timing, scoring, decision, policy, enrollment gate) — nothing in
the reference configuration requires code changes or hard-coded test
assumptions.
