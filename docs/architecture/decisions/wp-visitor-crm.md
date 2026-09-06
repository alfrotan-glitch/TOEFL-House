# AD-2026-09-04 / WP — Visitor / Lead / CRM Domain

Status: **recorded before implementation** (WP-1 rule 6); user directive `./goal` explicitly authorizes the Visitor build.

## Decision

Build a first-class **Visitor/Lead/CRM domain** as the **CRM bounded
context**. CRM is the canonical authority for `visitor_sources`,
`visitor_campaigns`, `visitor`, `visitor_interaction`, `visitor_followup`,
`visitor_conversion`, and `visitor_automation_rule`.

The CRM module owns the acquisition and lead-conversion pipeline **only**. It
never creates a Person, Applicant, Student, Message, Document, or Money
movement itself. Those entities remain owned by their authoritative modules;
CRM observes and traces them.

## Why

- The Legacy/New acquisition paths existed as separate reception notes and
  spreadsheet leads with duplicated contacts and no audit/identity trace.
- The frozen pipeline is `Visitor → Placement → Recommendation → Registration
  → Payment → Enrollment`. CRM is the entry point of that pipeline and must
  carry provenance, attribution, ownership, follow-up, and conversion evidence
  so every downstream step can be audited back to its source.
- Leads are often anonymous before identity verification. The system must
  support anonymous records without fabricating an identity, and must
  cross-link them only on evidence (Applicant/Student creation).

## Scope

In scope (this domain):

- `visitor_sources` and `visitor_campaigns` — acquisition metadata only.
- `visitors` — the lead record: contact/identity linkage, source/campaign,
  provenance branch, status, rating, interest, assignment.
- `visitor_interactions` — immutable evidence/timeline.
- `visitor_followups` — scheduled next actions, manual or automated.
- `visitor_conversions` — one immutable terminal trace per lead to an
  applicant/student created by the authoritative Admissions/Students workflow;
  `visitor_conversion_handoffs` preserves a later Applicant-to-Student
  authority event without rewriting the original conversion.
- `visitor_automation_rules` — deterministic follow-up scheduling on
  interaction outcome.
- CRM commands, API endpoints, reporting metrics, and tests.

Not in scope: defining or executing Admissions/Student/Finance/Communication
commands. CRM calls their authoritative command paths and consumes results.

## Boundaries and invariants

1. **CRM never creates People/Applicants/Students.** `RegisterApplicant` and
   the admission conversion orchestrator create the downstream participation
   through their owning boundaries (`StudentAdmissionRegistrar` owns Student
   and initial status inserts); CRM records the trace afterwards.
2. **Anonymous leads are first-class.** `person_id` is nullable. No synthetic
   Person is created for a walk-in.
3. **One open lead per verified/linked identity** and **one open lead per
   normalized primary contact** (email, else phone). Partial unique indexes
   enforce this.
4. **Branch provenance is immutable once set** (`origin_branch_id`). The guard
   follows the same semantic as the WP2-DEC-01 operational anchors. NULL is
   never a branch wildcard: directory reads require concrete authorized
   branches unless an organization-scoped unassigned read is explicitly
   requested, and the API advertises that unassigned capture affordance from
   server authorization rather than frontend inference.
5. **Interactions are append-only** — corrections are new facts.
6. **The lead conversion is terminal and one per lead.** After conversion
   the lead is read-only pipeline-wise; a later Applicant-to-Student handoff
   is a separate immutable CRM trace, not a rewrite or second lead conversion.
   Re-opening is a deliberate, audited revival from `lost`, never from
   `converted/archived`.
7. **Automation is deterministic and in-transaction.** An `interaction_outcome`
   rule creates the same follow-up type an operator would schedule manually.
8. **Authorization** uses the single `AccessDecision` authority plus CRM
   capabilities (`crm.catalog`, `crm.visitor`, `crm.followup`,
   `crm.automation`). A record with branch provenance is checked against that
   branch's structure scope (ancestor grants cover descendants). Conversion
   evidence is written only by the authoritative Admissions/Students workflow
   and binds to that workflow's immutable audit event; downstream interaction
   traces use the same authority-event binding.
9. **Audit + idempotency** mirror every other domain command: `AuditRecorder`,
   `AttemptedOperation`, `IdempotentExecution` in every mutating command.
10. **Calendar correctness** — effective dates in CRM use the application
    date; any Shamsi conversion must go through the Calendar Authority, never
    an ad-hoc conversion.
11. **Reporting** registers CRM metrics in the canonical
    `MetricCatalog` with the authoritative academic period; no manual metric
    values exist.
12. **Documents/Search/Communication integration** — a visitor interaction may
    reference a `messages.id` or `documents.id`; the list/search read model
    includes visitor sources/campaigns/status. Document search and
    Communication consent are never bypassed by CRM.

## Authority matrix

| Operation | Capability | Scope |
|---|---|---|
| Define/retire source/campaign | `crm.catalog` | global |
| Capture/update/transition visitor | `crm.visitor` | record provenance branch |
| Record interaction / schedule follow-up | `crm.followup` / `crm.visitor` | record provenance branch |
| Define automation | `crm.automation` | global |
| Record conversion evidence | Admissions/Students authority | same downstream branch/person provenance |
| CRM conversion UI/API | not exposed | CRM cannot create or assert downstream entities |

## Integration points

- **Identity:** a Visitor may remain anonymous until evidence supports a
  verified Person link; an unverified Person cannot be supplied as the lead
  identity and is never enough to become an Applicant.
- **Admissions:** `RegisterApplicant` records the applicant conversion on the
  lead as a side effect of the same Admissions authority — the CRM trace
  cannot be split from the Admissions transaction.
- **Students:** `EnrollAdmittedApplicant` records either the direct student
  conversion or, when the visitor already has an immutable applicant
  conversion, an immutable Applicant-to-Student handoff trace in the same
  Admissions/Student-authority transaction. CRM has no direct student
  conversion path. The visitor/person and originating-branch lineage is
  revalidated before a trace is appended.
- **Communication:** interactions can link `message_id`; consent purposes
  remain owned by Communication.
- **Documents:** interactions can link `document_id`.
- **Academic/Placement and Finance:** assessment, placement, and payment
  traces require the authoritative record, verified person lineage, compatible
  originating branch, and the matching immutable authority audit event.
- **Reporting:** `visitor_capture_count`, `visitor_conversion_count`,
  `visitor_conversion_rate` are registered in `MetricCatalog` grouped by
  academic period, scoped global/branch. Global results include unassigned
  provenance without inventing a branch; branch results exclude it and expose
  the exclusion in metric metadata.
- **Automation:** deterministic follow-up scheduling only. Branchless
  follow-ups may be assigned under explicit organization authority, but they
  never emit fabricated branch notifications; the workspace exposes them only
  to the assigned actor with that same organization-scoped authority.
- **Authorization/Audit:** every command is capability-checked, idempotent,
  and audited; material denials are also recorded.

## Weaknesses intentionally fixed

- Legacy duplicated leads → partial unique active indexes on person/contact.
- No provenance → immutable `origin_branch_id` guard.
- No evidence → append-only interactions with `correlation_id`.
- No owner/due-date discipline → follow-up lifecycle with assignment and
  complete/cancel evidence.
- No automation accountability → rule registry with deterministic action and
  active-state guard.
- No reporting lineage → metrics registered in canonical `MetricCatalog`.
- No CRM↔Admissions traceability → conversion recorder within same
  transaction.
